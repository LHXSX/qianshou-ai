"""
个人节点后台 my-* API · 全部 user-scoped

设计要点:
  - 所有接口 owner_id=current_account.id 隔离
  - 复用 we_workers, we_worker_models, we_models, we_accounts
  - 聚合返回 Dashboard 数据 (减少前端请求次数)
  - 单一 WS 用户通道 /ws/user/{user_id} (后续接入)
"""
from __future__ import annotations
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.core import Account
from platform_v8.storage.repo import WorkerRepo, WorkloadRepo

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/my", tags=["my"])


_ALLOWED_LANGUAGES = {"简体中文", "繁體中文", "English"}
_PHONE_RE = re.compile(r"^$|^\+?[0-9\-\s]{6,20}$")
_AVATAR_DATA_RE = re.compile(
    r"^data:image/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+=*$",
    re.IGNORECASE,
)
_MAX_AVATAR_CHARS = 200_000


class NotificationPrefsPayload(BaseModel):
    """通知偏好（只落库，本期不接真实发信）。"""
    notify_offline: bool | None = None
    daily_report: bool | None = None
    notify_failed: bool | None = None
    system_notice: bool | None = None


class UpdateMyProfileRequest(BaseModel):
    """更新个人资料（写入 we_accounts.profile JSONB）。用户名/邮箱不在此改。"""
    display_name: str | None = Field(default=None, max_length=64)
    phone: str | None = Field(default=None, max_length=32)
    language: str | None = Field(default=None, max_length=32)
    country: str | None = Field(default=None, max_length=64)
    # 客户端压缩后的 data URL，或空字符串清除；兼容 https 外链
    avatar_url: str | None = Field(default=None, max_length=_MAX_AVATAR_CHARS)
    notification_prefs: NotificationPrefsPayload | None = None


def _normalize_avatar_url(raw: str) -> str:
    """校验并归一化头像：data URL / https / 空（清除）。"""
    value = (raw or "").strip().replace("\n", "").replace("\r", "").replace(" ", "")
    if value == "":
        return ""
    if value.startswith("data:image/"):
        if len(value) > _MAX_AVATAR_CHARS:
            raise HTTPException(status_code=400, detail="头像过大，请换一张更小的图片")
        if not _AVATAR_DATA_RE.match(value):
            raise HTTPException(status_code=400, detail="头像格式不正确")
        return value
    if value.startswith("https://") and len(value) <= 2048:
        return value
    raise HTTPException(status_code=400, detail="不支持的头像地址")


def _worker_model_counts(session: Session, uid: int) -> dict[str, Any]:
    """LAN 库可能没有 we_worker_models：失败则空映射，不把 /my/nodes 打成 500。"""
    try:
        rows = session.execute(text("""
            SELECT
                wm.worker_id,
                COUNT(*) FILTER (WHERE wm.status = 'ready') AS ready,
                COUNT(*) FILTER (WHERE wm.status = 'downloading') AS downloading,
                COUNT(*) AS total
            FROM we_worker_models wm
            JOIN we_workers w ON w.id = wm.worker_id
            WHERE w.owner_id = :uid
            GROUP BY wm.worker_id
        """), {"uid": uid}).mappings().all()
        return {str(r["worker_id"]): r for r in rows}
    except ProgrammingError:
        logger.warning("we_worker_models 不可用 · 节点模型计数降级为空")
        session.rollback()
        return {}


def _model_stats_or_empty(session: Session, uid: int) -> dict[str, Any]:
    try:
        row = session.execute(text("""
            SELECT
                COUNT(DISTINCT wm.model_id) AS total_models,
                COUNT(*) FILTER (WHERE wm.status = 'ready') AS ready_count,
                COUNT(*) FILTER (WHERE wm.status = 'downloading') AS downloading_count
            FROM we_worker_models wm
            JOIN we_workers w ON w.id = wm.worker_id
            WHERE w.owner_id = :uid
        """), {"uid": uid}).mappings().first()
        return dict(row or {})
    except ProgrammingError:
        logger.warning("we_worker_models 不可用 · dashboard 模型 KPI 降级为 0")
        session.rollback()
        return {"total_models": 0, "ready_count": 0, "downloading_count": 0}


# ════════════════════════════════════════════════════════════════════
# ① /my/profile - 当前用户完整信息
# ════════════════════════════════════════════════════════════════════
@router.get("/profile")
def get_my_profile(
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """当前用户完整信息 (id, name, role, balance, level, tier)"""
    rows = session.execute(text("""
        SELECT
            id, username, email, role, status, balance,
            COALESCE(profile, '{}'::jsonb) as profile,
            created_at, last_login_at
        FROM we_accounts WHERE id = :uid
    """), {"uid": current.id}).mappings().first()

    if not rows:
        raise HTTPException(status_code=404, detail="用户不存在")

    profile = rows["profile"] or {}
    balance = float(rows["balance"] or 0)

    # 计算等级 (按累计余额简单分级)
    level, tier, multiplier = _calc_level(balance)

    return {
        "ok": True,
        "user": {
            "id": rows["id"],
            "username": rows["username"],
            "email": rows["email"],
            "role": rows["role"],
            "status": rows["status"],
            "balance": balance,
            "level": level,
            "tier": tier,
            "tier_multiplier": multiplier,
            "registered_at": rows["created_at"].isoformat() if rows["created_at"] else None,
            "last_login_at": rows["last_login_at"].isoformat() if rows["last_login_at"] else None,
            "profile": profile,
        }
    }


@router.put("/profile")
def update_my_profile(
    body: UpdateMyProfileRequest,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """更新个人资料字段到 we_accounts.profile（不改 username / email）。"""
    patch: dict[str, Any] = {}
    if body.display_name is not None:
        name = body.display_name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="显示名称不能为空")
        patch["display_name"] = name
    if body.phone is not None:
        phone = body.phone.strip()
        if not _PHONE_RE.match(phone):
            raise HTTPException(status_code=400, detail="联系电话格式不正确")
        patch["phone"] = phone
    if body.language is not None:
        language = body.language.strip()
        if language not in _ALLOWED_LANGUAGES:
            raise HTTPException(status_code=400, detail="不支持的交流语言")
        patch["language"] = language
    if body.country is not None:
        country = body.country.strip()
        if not country:
            raise HTTPException(status_code=400, detail="国家/地区不能为空")
        patch["country"] = country
    if body.avatar_url is not None:
        avatar = _normalize_avatar_url(body.avatar_url)
        # broker 等读 avatar / avatar_url，两侧同步
        patch["avatar_url"] = avatar
        patch["avatar"] = avatar
    if body.notification_prefs is not None:
        prefs_patch = body.notification_prefs.model_dump(exclude_none=True)
        if prefs_patch:
            # 整对象合并进 profile.notification_prefs（jsonb || 浅合并顶层）
            existing = {}
            row = session.execute(
                text("SELECT profile FROM we_accounts WHERE id = :uid"),
                {"uid": current.id},
            ).mappings().first()
            if row and isinstance(row.get("profile"), dict):
                raw = row["profile"].get("notification_prefs")
                if isinstance(raw, dict):
                    existing = dict(raw)
            existing.update(prefs_patch)
            patch["notification_prefs"] = existing

    if not patch:
        raise HTTPException(status_code=400, detail="未提交任何可更新字段")

    session.execute(
        text(
            "UPDATE we_accounts "
            "SET profile = COALESCE(profile, '{}'::jsonb) || CAST(:patch AS jsonb), "
            "    updated_at = NOW() "
            "WHERE id = :uid"
        ),
        {"patch": json.dumps(patch, ensure_ascii=False), "uid": current.id},
    )
    session.commit()
    logger.info("my.profile.update uid=%s fields=%s", current.id, list(patch.keys()))
    return get_my_profile(current=current, session=session)


# ════════════════════════════════════════════════════════════════════
# ② /my/dashboard-summary - Dashboard 一次性聚合
# ════════════════════════════════════════════════════════════════════
@router.get("/dashboard-summary")
def get_dashboard_summary(
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """一次拿全 Dashboard 数据，减少前端请求次数"""
    uid = current.id

    # ── 节点统计（排除软归档幽灵） ──
    node_stats = session.execute(text("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status IN ('ONLINE', 'BUSY')) AS online,
            COUNT(*) FILTER (WHERE status = 'OFFLINE') AS offline
        FROM we_workers
        WHERE owner_id = :uid
          AND COALESCE(capabilities->>'archived', 'false') NOT IN ('true', '1', 'yes')
    """), {"uid": uid}).mappings().first()

    # ── 模型装备统计（表缺失时降级，不挡驾舱） ──
    model_stats = _model_stats_or_empty(session, uid)

    # ── 收益统计 (we_ledger) + 今日任务 = 账号节点上今日 DONE 分片数 ──
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    earnings = session.execute(text("""
        SELECT
            COALESCE(SUM(CASE WHEN created_at >= :today THEN amount ELSE 0 END), 0) AS today_amount,
            COALESCE(SUM(amount), 0) AS total_amount
        FROM we_ledger
        WHERE account_id = :uid AND amount > 0
    """), {"uid": uid, "today": today_start}).mappings().first()

    tasks_today_row = session.execute(text("""
        SELECT COUNT(*) AS cnt
        FROM we_shards sh
        JOIN we_workers w ON w.id = sh.worker_id
        WHERE w.owner_id = :uid
          AND sh.status = 'DONE'
          AND COALESCE(sh.completed_at, sh.progress_at) >= :today
          AND COALESCE(w.capabilities->>'archived', 'false') NOT IN ('true', '1', 'yes')
    """), {"uid": uid, "today": today_start}).mappings().first()
    tasks_today = int((tasks_today_row or {}).get("cnt") or 0)

    # ── 用户余额 + 等级 ──
    acc = session.execute(text("""
        SELECT balance, username FROM we_accounts WHERE id = :uid
    """), {"uid": uid}).mappings().first()

    balance = float(acc["balance"] or 0)
    level, tier, multiplier = _calc_level(balance)

    # ── 节点摘要 (前 3 个) ──
    nodes_list = session.execute(text("""
        SELECT
            id, name, status, capabilities, load,
            last_seen, capability_score
        FROM we_workers
        WHERE owner_id = :uid
          AND COALESCE(capabilities->>'archived', 'false') NOT IN ('true', '1', 'yes')
        ORDER BY (status = 'ONLINE') DESC, last_seen DESC NULLS LAST
        LIMIT 3
    """), {"uid": uid}).mappings().all()

    nodes_summary = [{
        "id": str(r["id"]),
        "name": r["name"],
        "status": (r["status"] or "OFFLINE").lower(),
        "load_pct": round(float(r["load"] or 0) * 100, 1),
        "specialty": (r["capabilities"] or {}).get("specialty", []) if isinstance(r["capabilities"], dict) else [],
        # 已装应用数（与「我的装备」口径一致）；equipped_count 保留兼容
        "apps_count": len(_normalize_installed_apps(
            (r["capabilities"] or {}).get("installed_apps")
            if isinstance(r["capabilities"], dict) else []
        )),
        "equipped_count": len(_normalize_installed_apps(
            (r["capabilities"] or {}).get("installed_apps")
            if isinstance(r["capabilities"], dict) else []
        )),
        "last_seen": r["last_seen"].isoformat() if r["last_seen"] else None,
    } for r in nodes_list]

    # 跨节点已装应用 KPI（与 /my/equipment 同口径）
    app_slugs: set[str] = set()
    apps_installs = 0
    for r in session.execute(text("""
        SELECT capabilities FROM we_workers
        WHERE owner_id = :uid
          AND COALESCE(capabilities->>'archived', 'false') NOT IN ('true', '1', 'yes')
    """), {"uid": uid}).mappings().all():
        caps = r["capabilities"] or {}
        if isinstance(caps, str):
            try:
                caps = json.loads(caps)
            except Exception:
                caps = {}
        apps = _normalize_installed_apps(caps.get("installed_apps") if isinstance(caps, dict) else [])
        apps_installs += len(apps)
        for a in apps:
            app_slugs.add(a["slug"])

    # ── 7 天收益趋势 (mock + 真实合并) ──
    earnings_trend = _earnings_trend_7d(session, uid)

    # ── 我的专长覆盖 (从节点 capabilities 聚合) ──
    specialty_coverage = _specialty_coverage(session, uid)

    return {
        "ok": True,
        "user": {
            "username": acc["username"],
            "balance": balance,
            "level": level,
            "tier": tier,
        },
        "kpi": {
            "nodes_total": int(node_stats["total"] or 0),
            "nodes_online": int(node_stats["online"] or 0),
            "nodes_offline": int(node_stats["offline"] or 0),
            "apps_total": len(app_slugs),
            "apps_installs": apps_installs,
            "installed_app_slugs": sorted(app_slugs),
            # 旧字段保留兼容（概览页已改用 apps_*）
            "models_total": int(model_stats["total_models"] or 0),
            "models_ready": int(model_stats["ready_count"] or 0),
            "models_downloading": int(model_stats["downloading_count"] or 0),
            "earnings_today": float(earnings["today_amount"] or 0),
            "earnings_total": float(earnings["total_amount"] or 0),
            "tasks_today": tasks_today,
            "level": level,
            "tier": tier,
            "tier_multiplier": multiplier,
        },
        "earnings_trend": earnings_trend,
        "nodes_summary": nodes_summary,
        "specialty_coverage": specialty_coverage,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


# ════════════════════════════════════════════════════════════════════
# ③ /my/nodes - 我的节点列表
# ════════════════════════════════════════════════════════════════════
@router.get("/nodes")
def get_my_nodes(
    status: str | None = Query(None, description="过滤状态: online/offline/busy"),
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """我的节点列表 (含实时资源 + 已装模型数)"""
    # 打开列表时自愈：同名离线幽灵归档（不删行）
    try:
        from platform_v8.services.workers import machine_identity as mid_svc
        n = mid_svc.archive_offline_name_duplicates(session, current.id)
        if n:
            session.commit()
            logger.info("my.nodes.archive_dupes uid=%s count=%s", current.id, n)
    except Exception as exc:
        session.rollback()
        logger.debug("my.nodes.archive_dupes skip: %s", exc)

    workers = WorkerRepo.list_by_owner(session, current.id)
    model_map = _worker_model_counts(session, current.id)

    items = []
    for w in workers:
        if status and (w.status.value.lower() != status.lower() if hasattr(w.status, 'value') else str(w.status).lower() != status.lower()):
            continue
        cap = w.capabilities
        if cap and hasattr(cap, '__dataclass_fields__'):
            from dataclasses import asdict
            cap_dict = asdict(cap)
        elif isinstance(cap, dict):
            cap_dict = cap
        else:
            cap_dict = {}

        models = model_map.get(str(w.id), {})
        mode = str(cap_dict.get("mode") or "active").lower()
        if mode not in {"active", "paused", "throttled"}:
            mode = "active"

        items.append({
            "id": str(w.id),
            "name": w.name,
            "status": str(w.status).lower() if not hasattr(w.status, 'value') else w.status.value.lower(),
            "mode": mode,
            "accepting_work": mode != "paused",
            "hardware": {
                "cpu_cores": cap_dict.get("cpu_cores", 0),
                "ram_gb": cap_dict.get("ram_gb") or cap_dict.get("memory_gb", 0),
                "gpu": cap_dict.get("gpu", ""),
                "os": cap_dict.get("os", ""),
                "tier": cap_dict.get("tier", "basic"),
            },
            "capabilities": {
                "specialty": cap_dict.get("specialty", []) or [],
                "equipped_models": cap_dict.get("equipped_models", []) or [],
                "model_health": cap_dict.get("model_health", {}) or {},
                "installed_apps": cap_dict.get("installed_apps", []) or [],
            },
            "models": {
                "ready": int(models.get("ready", 0)),
                "downloading": int(models.get("downloading", 0)),
                "total": int(models.get("total", 0)),
            },
            "apps": {
                "total": len(_normalize_installed_apps(cap_dict.get("installed_apps"))),
            },
            "load_pct": round(float(w.load) * 100, 1),
            "active_shards": int(getattr(w, "active_shards", 0)),
            "reputation": round(float(getattr(w, "reputation", 0.5)), 3),
            "capability_score": round(float(getattr(w, "capability_score", 0)), 1),
            "last_seen": w.last_seen.isoformat() if w.last_seen else None,
            "registered_at": w.registered_at.isoformat() if w.registered_at else None,
        })

    return {
        "ok": True,
        "count": len(items),
        "nodes": items,
    }


class UpdateMyNodeRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    # True=恢复接单 · False=暂停接单（不影响客户端进程，只影响调度）
    accepting_work: bool | None = None


def _require_my_node(session: Session, node_id: str, uid: int) -> dict:
    row = session.execute(text("""
        SELECT id, name, owner_id, status, capabilities
        FROM we_workers WHERE id = :nid AND owner_id = :uid
    """), {"nid": node_id, "uid": uid}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="节点不存在或不属于你")
    return dict(row)


@router.patch("/nodes/{node_id}", summary="重命名 / 设置是否接单（仅本账户节点）")
def update_my_node(
    node_id: str,
    body: UpdateMyNodeRequest,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """Owner 自管：改显示名、暂停/恢复接单。不能操作他人节点。"""
    _require_my_node(session, node_id, current.id)
    changed: list[str] = []

    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="节点名称不能为空")
        if not WorkerRepo.rename(session, node_id, name):
            raise HTTPException(status_code=500, detail="重命名失败")
        changed.append("name")

    if body.accepting_work is not None:
        mode = "active" if body.accepting_work else "paused"
        if not WorkerRepo.update_capabilities(session, node_id, {"mode": mode}):
            raise HTTPException(status_code=500, detail="更新接单状态失败")
        changed.append("accepting_work")

    if not changed:
        raise HTTPException(status_code=400, detail="未提交任何可更新字段")

    session.commit()
    try:
        from platform_v8.engine import registry as registry_mod
        registry_mod.invalidate_cache(owner_id=current.id)
    except Exception:
        pass
    logger.info(
        "my.node.update uid=%s node=%s fields=%s",
        current.id, node_id, changed,
    )
    # 返回列表中的单节点视图
    nodes = get_my_nodes(current=current, session=session)
    for item in nodes.get("nodes") or []:
        if str(item.get("id")) == str(node_id):
            return {"ok": True, "node": item, "changed": changed}
    return {"ok": True, "changed": changed}


@router.post("/nodes/{node_id}/pause", summary="暂停节点接单")
def pause_my_node(
    node_id: str,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    return update_my_node(
        node_id,
        UpdateMyNodeRequest(accepting_work=False),
        current=current,
        session=session,
    )


@router.post("/nodes/{node_id}/resume", summary="恢复节点接单")
def resume_my_node(
    node_id: str,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    return update_my_node(
        node_id,
        UpdateMyNodeRequest(accepting_work=True),
        current=current,
        session=session,
    )


@router.delete("/nodes/{node_id}", summary="删除设备（摘除注册 · 强制客户端注销）")
async def delete_my_node(
    node_id: str,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """Owner 自管删除：任意在线/离线状态均可。

    流程：写墓碑 → 下发 fatal AUTH_FAILED:node_deleted → 踢 WS → 删 we_workers。
    历史任务/收益流水保留。客户端应清 token 并注销；同 identity 短期内禁止重注册。
    """
    row = _require_my_node(session, node_id, current.id)
    worker_id = str(row["id"])
    worker_name = str(row.get("name") or worker_id)

    from platform_v8.engine import broker as broker_mod
    from platform_v8.engine import gateway as gateway_mod
    from platform_v8.engine import registry as registry_mod
    from platform_v8.protocol import ws_schema as wsp
    from platform_v8.services.workers import tombstone as tombstone_svc

    # 1) 墓碑先落盘，避免踢线后立刻 hello 复活
    tombstone_svc.mark_deleted(worker_id, owner_id=current.id)

    # 2) 通知客户端强制注销（fatal + AUTH_FAILED 前缀）
    force_msg = "AUTH_FAILED:node_deleted 该设备已从账号移除，请重新登录客户端"
    frame = wsp.build_err(2011, force_msg, fatal=True)
    delivered = False
    try:
        delivered = bool(
            await broker_mod.push_to_worker(worker_id, frame, source="my_node_delete")
        )
    except Exception as exc:
        logger.warning("my.node.delete push err fail node=%s: %s", worker_id[:12], exc)
    if not delivered:
        try:
            await gateway_mod.route_push(worker_id, frame, source="my_node_delete")
        except Exception as exc:
            logger.debug("my.node.delete route_push skip: %s", exc)

    # 3) 踢断 WS（本地 + 跨进程）
    disconnected = False
    try:
        disconnected = bool(await broker_mod.kick_worker(worker_id, reason="node_deleted"))
    except Exception as exc:
        logger.warning("my.node.delete kick fail node=%s: %s", worker_id[:12], exc)
    try:
        await gateway_mod.route_kick(worker_id, reason="node_deleted")
    except Exception as exc:
        logger.debug("my.node.delete route_kick skip: %s", exc)

    # 4) 删库（先清 RESTRICT 派发证据，再删 we_workers）
    try:
        ok = WorkerRepo.delete(session, worker_id)
        if not ok:
            raise HTTPException(status_code=500, detail="删除节点失败")
        session.commit()
    except HTTPException:
        raise
    except Exception as exc:
        session.rollback()
        logger.exception("my.node.delete db fail node=%s", worker_id[:12])
        raise HTTPException(status_code=500, detail=f"删除节点失败: {exc}") from exc
    try:
        registry_mod.invalidate_cache(owner_id=current.id)
    except Exception:
        pass

    logger.info(
        "my.node.delete uid=%s node=%s name=%s delivered=%s disconnected=%s",
        current.id, worker_id, worker_name, delivered, disconnected,
    )
    return {
        "ok": True,
        "worker_id": worker_id,
        "name": worker_name,
        "force_logout_delivered": delivered,
        "disconnected": disconnected,
    }


# ════════════════════════════════════════════════════════════════════
# ④ /my/nodes/{id} - 节点详情
# ════════════════════════════════════════════════════════════════════
@router.get("/nodes/{node_id}")
def get_my_node_detail(
    node_id: str,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """节点详情 (含 7 天收益曲线 + 已装应用清单)"""
    # 验证归属
    w = session.execute(text("""
        SELECT * FROM we_workers WHERE id = :nid AND owner_id = :uid
    """), {"nid": node_id, "uid": current.id}).mappings().first()
    if not w:
        raise HTTPException(status_code=404, detail="节点不存在或不属于你")

    cap = w["capabilities"] or {}
    if isinstance(cap, str):
        try:
            cap = json.loads(cap)
        except Exception:
            cap = {}
    mode = str((cap or {}).get("mode") or "active").lower()
    if mode not in {"active", "paused", "throttled"}:
        mode = "active"

    installed_apps = _normalize_installed_apps((cap or {}).get("installed_apps"))

    # 兼容旧前端：仍返回 models（可为空）
    models = session.execute(text("""
        SELECT
            wm.model_id, wm.status, wm.progress_pct, wm.installed_at, wm.error,
            m.name, m.size_mb, m.description
        FROM we_worker_models wm
        LEFT JOIN we_models m ON m.id = wm.model_id
        WHERE wm.worker_id = :nid
        ORDER BY wm.installed_at DESC NULLS LAST
    """), {"nid": node_id}).mappings().all()

    # 7 天收益
    earnings = _node_earnings_trend(session, node_id, days=7)

    return {
        "ok": True,
        "node": {
            "id": str(w["id"]),
            "name": w["name"],
            "status": (w["status"] or "OFFLINE").lower(),
            "mode": mode,
            "accepting_work": mode != "paused",
            "hardware": {
                "cpu_cores": cap.get("cpu_cores", 0),
                "ram_gb": cap.get("ram_gb") or cap.get("memory_gb", 0),
                "gpu": cap.get("gpu", ""),
                "os": cap.get("os", ""),
                "tier": cap.get("tier", "basic"),
            },
            "capabilities": {
                "specialty": cap.get("specialty", []),
                "equipped_models": cap.get("equipped_models", []),
                "model_health": cap.get("model_health", {}),
                "installed_apps": installed_apps,
            },
            "apps": {"total": len(installed_apps)},
            "load_pct": round(float(w["load"] or 0) * 100, 1),
            "reputation": round(float(w["reputation"] or 0.5), 3),
            "capability_score": round(float(w["capability_score"] or 0), 1),
            "last_seen": w["last_seen"].isoformat() if w["last_seen"] else None,
            "registered_at": w["registered_at"].isoformat() if w["registered_at"] else None,
            "client_version": w["client_version"] or "",
        },
        "apps": installed_apps,
        "models": [{
            "model_id": r["model_id"],
            "name": r["name"] or r["model_id"],
            "description": r["description"] or "",
            "size_mb": float(r["size_mb"] or 0),
            "status": r["status"],
            "progress_pct": float(r["progress_pct"] or 0),
            "installed_at": r["installed_at"].isoformat() if r["installed_at"] else None,
            "error": r["error"] or "",
        } for r in models],
        "earnings_trend": earnings,
    }


# ════════════════════════════════════════════════════════════════════
# ⑤ /my/wallet - 钱包
# ════════════════════════════════════════════════════════════════════
@router.get("/wallet")
def get_my_wallet(
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """钱包: 余额 / 待结算 / 累计入账 / 累计提现 / 等级"""
    acc = session.execute(text("""
        SELECT balance FROM we_accounts WHERE id = :uid
    """), {"uid": current.id}).mappings().first()
    balance = float(acc["balance"] or 0) if acc else 0

    ledger = session.execute(text("""
        SELECT
            COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS earned,
            COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS withdrawn,
            COUNT(*) FILTER (WHERE created_at >= NOW() - interval '30 days') AS recent_count
        FROM we_ledger WHERE account_id = :uid
    """), {"uid": current.id}).mappings().first()

    level, tier, multiplier = _calc_level(balance)

    return {
        "ok": True,
        "wallet": {
            "balance": balance,
            "pending": 0,  # 待结算暂固定 0 · 保留字段供前端展示，结算链路未接前不改计算
            "total_earned": float(ledger["earned"] or 0),
            "total_withdrawn": float(ledger["withdrawn"] or 0),
            "recent_transactions_30d": int(ledger["recent_count"] or 0),
        },
        "level": {
            "current": level,
            "tier": tier,
            "tier_multiplier": multiplier,
            "next_threshold": _next_level_threshold(balance),
        },
    }


# ════════════════════════════════════════════════════════════════════
# ⑥ /my/wallet/transactions - 流水
# ════════════════════════════════════════════════════════════════════
@router.get("/wallet/transactions")
def get_my_transactions(
    type: str = Query("all", description="all/income/expense"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """收益流水 (按时间倒序分页)"""
    offset = (page - 1) * size

    where = "account_id = :uid"
    if type == "income":
        where += " AND amount > 0"
    elif type == "expense":
        where += " AND amount < 0"

    total = session.execute(text(f"""
        SELECT COUNT(*) FROM we_ledger WHERE {where}
    """), {"uid": current.id}).scalar() or 0

    rows = session.execute(text(f"""
        SELECT id, account_id, type, amount, currency,
               workload_id, shard_id, note, metadata, created_at
        FROM we_ledger
        WHERE {where}
        ORDER BY created_at DESC
        LIMIT :size OFFSET :offset
    """), {"uid": current.id, "size": size, "offset": offset}).mappings().all()

    return {
        "ok": True,
        "page": page,
        "size": size,
        "total": int(total),
        "items": [{
            "id": str(r["id"]),
            "type": r["type"] or "",
            "workload_id": str(r["workload_id"]) if r["workload_id"] else "",
            "shard_id": str(r["shard_id"]) if r["shard_id"] else "",
            "amount": float(r["amount"]),
            "currency": r["currency"] or "CNY",
            "note": r["note"] or "",
            "metadata": r["metadata"] or {},
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        } for r in rows],
    }


# ════════════════════════════════════════════════════════════════════
# ⑦ /my/tasks - 任务记录 (从 ledger + shards 综合)
# ════════════════════════════════════════════════════════════════════
@router.get("/tasks")
def get_my_tasks(
    status: str = Query("all", description="all/running/done/failed"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """我的任务列表

    数据来源:
      - 主表: we_ledger (我账户的每条入账 = 一次任务)
      - 关联: we_workloads + we_shards + we_workers (补充任务详情)
    """
    uid = current.id
    offset = (page - 1) * size

    rows = session.execute(text("""
        SELECT
            l.id AS ledger_id,
            l.amount AS reward,
            l.metadata AS ledger_meta,
            l.note,
            l.created_at,
            l.workload_id,
            l.shard_id,
            w.name AS workload_name,
            w.status AS workload_status,
            w.spec AS workload_spec,
            w.started_at AS workload_started,
            w.completed_at AS workload_completed,
            s.worker_id,
            s.status AS shard_status,
            s.elapsed_ms,
            s.error,
            worker.name AS worker_name
        FROM we_ledger l
        LEFT JOIN we_workloads w ON w.id = l.workload_id
        LEFT JOIN we_shards s ON s.id = l.shard_id
        LEFT JOIN we_workers worker ON worker.id = s.worker_id
        WHERE l.account_id = :uid AND l.amount > 0
        ORDER BY l.created_at DESC
        LIMIT :size OFFSET :offset
    """), {"uid": uid, "size": size, "offset": offset}).mappings().all()

    items = []
    for r in rows:
        meta = r["ledger_meta"] or {}
        spec = r["workload_spec"] or {}
        items.append({
            "id": str(r["ledger_id"]),
            "skill": meta.get("skill") or r["workload_name"] or spec.get("skill") or "AI 任务",
            "model": meta.get("model") or spec.get("model") or "",
            "node_id": str(r["worker_id"]) if r["worker_id"] else meta.get("worker_id", ""),
            "node_name": r["worker_name"] or meta.get("worker_name") or "—",
            "status": ((r["shard_status"] or r["workload_status"]) or "DONE").lower(),
            "elapsed_ms": int(r["elapsed_ms"] or 0),
            "reward": float(r["reward"]),
            "error": r["error"] or "",
            "started_at": (r["workload_started"] or r["created_at"]).isoformat() if (r["workload_started"] or r["created_at"]) else None,
            "completed_at": (r["workload_completed"] or r["created_at"]).isoformat() if (r["workload_completed"] or r["created_at"]) else None,
            "note": r["note"] or "",
        })

    total = session.execute(text("""
        SELECT COUNT(*) FROM we_ledger WHERE account_id = :uid AND amount > 0
    """), {"uid": uid}).scalar() or 0

    stats = session.execute(text("""
        SELECT
            COUNT(*) FILTER (WHERE created_at >= NOW() - interval '1 day') AS today,
            COUNT(*) FILTER (WHERE created_at >= NOW() - interval '30 days') AS this_month,
            COUNT(*) AS total_all,
            COALESCE(SUM(amount), 0) AS total_reward,
            COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - interval '1 day'), 0) AS today_reward,
            COALESCE(AVG(amount), 0) AS avg_reward
        FROM we_ledger
        WHERE account_id = :uid AND amount > 0
    """), {"uid": uid}).mappings().first()

    # 成功率：本账号节点上已终态分片 DONE / (DONE+FAILED)
    # 不用 ledger（入账几乎全是成功单，会恒≈100%）
    rate_row = session.execute(text("""
        SELECT
            COUNT(*) FILTER (WHERE s.status = 'DONE') AS done_n,
            COUNT(*) FILTER (WHERE s.status = 'FAILED') AS failed_n
        FROM we_shards s
        JOIN we_workers w ON w.id = s.worker_id
        WHERE w.owner_id = :uid
          AND s.status IN ('DONE', 'FAILED')
    """), {"uid": uid}).mappings().first()
    done_n = int((rate_row or {}).get("done_n") or 0)
    failed_n = int((rate_row or {}).get("failed_n") or 0)
    terminal = done_n + failed_n
    success_rate = round(done_n * 100.0 / terminal, 1) if terminal > 0 else 0.0

    return {
        "ok": True,
        "page": page,
        "size": size,
        "total": int(total),
        "tasks": items,
        "stats": {
            "today": int(stats["today"] or 0),
            "this_month": int(stats["this_month"] or 0),
            "total": int(stats["total_all"] or 0),
            "total_reward": float(stats["total_reward"] or 0),
            "today_reward": float(stats["today_reward"] or 0),
            "avg_reward": float(stats["avg_reward"] or 0),
            "success_rate": success_rate,
            "success_done": done_n,
            "success_failed": failed_n,
        },
    }


# ════════════════════════════════════════════════════════════════════
# ⑧ /my/equipment - 装备汇总（跨节点已装应用）
# ════════════════════════════════════════════════════════════════════
def _normalize_installed_apps(raw: Any) -> list[dict[str, str]]:
    """hello/hb 上报的 installed_apps → [{slug,name,version}]。"""
    items: list[dict[str, str]] = []
    if not isinstance(raw, list):
        return items
    seen: set[str] = set()
    for entry in raw:
        slug = ""
        name = ""
        version = ""
        if isinstance(entry, str):
            slug = entry.strip()
            name = slug
        elif isinstance(entry, dict):
            slug = str(entry.get("slug") or entry.get("id") or "").strip()
            name = str(entry.get("name") or slug).strip() or slug
            version = str(entry.get("version") or "").strip()
        if not slug or slug in seen:
            continue
        seen.add(slug)
        items.append({"slug": slug, "name": name, "version": version})
    return items


@router.get("/equipment")
def get_my_equipment(
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """我的装备：按应用聚合「装在几台节点」（只读；安装/卸载去应用市场）。"""
    # 打开列表时顺带自愈同名离线幽灵，避免装备统计掺入归档前脏数据
    try:
        from platform_v8.services.workers import machine_identity as mid_svc
        n = mid_svc.archive_offline_name_duplicates(session, current.id)
        if n:
            session.commit()
    except Exception:
        session.rollback()

    workers = WorkerRepo.list_by_owner(session, current.id)
    # slug → aggregate
    agg: dict[str, dict[str, Any]] = {}
    nodes_with_apps = 0
    for w in workers:
        cap = w.capabilities
        if cap and hasattr(cap, "__dataclass_fields__"):
            from dataclasses import asdict
            cap_dict = asdict(cap)
        elif isinstance(cap, dict):
            cap_dict = cap
        else:
            cap_dict = {}
        apps = _normalize_installed_apps(cap_dict.get("installed_apps"))
        if apps:
            nodes_with_apps += 1
        node_id = str(w.id)
        node_name = str(w.name or node_id)
        node_status = (
            w.status.value.lower()
            if hasattr(w.status, "value")
            else str(w.status).lower()
        )
        for app in apps:
            slug = app["slug"]
            bucket = agg.get(slug)
            if bucket is None:
                bucket = {
                    "slug": slug,
                    "name": app["name"] or slug,
                    "version": app["version"] or "",
                    "versions": set(),
                    "node_count": 0,
                    "nodes": [],
                }
                agg[slug] = bucket
            if app["name"] and (
                not bucket["name"] or bucket["name"] == slug
            ):
                bucket["name"] = app["name"]
            if app["version"]:
                bucket["versions"].add(app["version"])
                if not bucket["version"]:
                    bucket["version"] = app["version"]
            bucket["node_count"] += 1
            bucket["nodes"].append({
                "id": node_id,
                "name": node_name,
                "status": node_status,
                "version": app["version"] or "",
            })

    # 用市场目录补全 category / description / tagline（有则补，无则跳过）
    catalog: dict[str, dict] = {}
    try:
        from platform_v8.services.marketplace import apps as apps_svc
        listed = apps_svc.list_apps(
            session, sort="popular", page=1, page_size=100, status="published",
        )
        for item in listed.get("items") or []:
            if isinstance(item, dict) and item.get("slug"):
                catalog[str(item["slug"])] = item
    except Exception as exc:
        logger.debug("equipment.catalog enrich skip: %s", exc)

    apps_out = []
    for slug, bucket in agg.items():
        meta = catalog.get(slug) or {}
        versions = sorted(bucket["versions"])
        tags = meta.get("capability_tags")
        if not tags and isinstance(meta.get("display_meta"), dict):
            tags = meta["display_meta"].get("capability_tags")
        apps_out.append({
            "slug": slug,
            "name": meta.get("name") or bucket["name"] or slug,
            "description": meta.get("description") or meta.get("tagline") or "",
            "category": meta.get("category") or "",
            "version": bucket["version"] or (versions[-1] if versions else ""),
            "versions": versions,
            "node_count": int(bucket["node_count"]),
            "nodes": bucket["nodes"],
            "coming_soon": bool(meta.get("coming_soon")),
            "capability_tags": list(tags or [])[:8],
        })
    apps_out.sort(key=lambda x: (-int(x["node_count"]), str(x["name"]).lower()))

    return {
        "ok": True,
        "count": len(apps_out),
        "apps": apps_out,
        "nodes_with_apps": nodes_with_apps,
        "total_nodes": len(workers),
        # 旧字段兼容：空数组，避免旧前端崩
        "models": [],
        "skill_packs": [],
    }


# ════════════════════════════════════════════════════════════════════
# 工具函数
# ════════════════════════════════════════════════════════════════════
def _calc_level(balance: float) -> tuple[int, str, float]:
    """根据余额算等级 + tier + multiplier（与结算/调度共用）。"""
    from platform_v8.services.economy.tier import calc_level
    return calc_level(balance)


def _next_level_threshold(balance: float) -> dict:
    """下一级门槛"""
    levels = [(100, 2, "bronze"), (500, 3, "silver"), (2000, 4, "gold"), (10000, 5, "diamond")]
    for threshold, lv, tier in levels:
        if balance < threshold:
            return {"threshold": threshold, "level": lv, "tier": tier, "remaining": threshold - balance}
    return {"threshold": None, "level": 5, "tier": "diamond", "remaining": 0}


def _earnings_trend_7d(session: Session, uid: int) -> list[dict]:
    """7 天收益趋势 (按天聚合 we_ledger)"""
    rows = session.execute(text("""
        SELECT
            DATE(created_at) AS day,
            COALESCE(SUM(amount), 0) AS amount,
            COUNT(*) AS tasks
        FROM we_ledger
        WHERE account_id = :uid
          AND amount > 0
          AND created_at >= NOW() - interval '7 days'
        GROUP BY DATE(created_at)
        ORDER BY day
    """), {"uid": uid}).mappings().all()

    # 补全 7 天 (无数据补 0)
    today = datetime.now(timezone.utc).date()
    by_day = {r["day"]: r for r in rows}
    result = []
    for i in range(6, -1, -1):
        day = today - timedelta(days=i)
        r = by_day.get(day)
        result.append({
            "date": day.isoformat(),
            "amount": float(r["amount"]) if r else 0,
            "tasks": int(r["tasks"]) if r else 0,
        })
    return result


def _node_earnings_trend(session: Session, node_id: str, days: int = 7) -> list[dict]:
    """节点维度的收益曲线 (从 we_ledger metadata->>'worker_id' 取)"""
    rows = session.execute(text("""
        SELECT
            DATE(created_at) AS day,
            COALESCE(SUM(amount), 0) AS amount,
            COUNT(*) AS tasks
        FROM we_ledger
        WHERE metadata->>'worker_id' = :nid
          AND amount > 0
          AND created_at >= NOW() - (:days || ' days')::interval
        GROUP BY DATE(created_at)
        ORDER BY day
    """), {"nid": node_id, "days": days}).mappings().all()

    today = datetime.now(timezone.utc).date()
    by_day = {r["day"]: r for r in rows}
    result = []
    for i in range(days - 1, -1, -1):
        day = today - timedelta(days=i)
        r = by_day.get(day)
        result.append({
            "date": day.isoformat(),
            "amount": float(r["amount"]) if r else 0,
            "tasks": int(r["tasks"]) if r else 0,
        })
    return result


def _specialty_coverage(session: Session, uid: int) -> list[dict]:
    """聚合我的所有节点的 specialty (每种专长有多少节点支持)"""
    try:
        rows = session.execute(text("""
            SELECT
                jsonb_array_elements_text((capabilities::jsonb)->'specialty') AS specialty,
                COUNT(*) AS node_count
            FROM we_workers
            WHERE owner_id = :uid AND (capabilities::jsonb) ? 'specialty'
              AND COALESCE(capabilities->>'archived', 'false') NOT IN ('true', '1', 'yes')
            GROUP BY specialty
            ORDER BY node_count DESC
        """), {"uid": uid}).mappings().all()
    except ProgrammingError:
        logger.warning("specialty 聚合不可用 · dashboard 专长覆盖降级为空")
        session.rollback()
        return []

    total = session.execute(text("""
        SELECT COUNT(*) FROM we_workers
        WHERE owner_id = :uid
          AND COALESCE(capabilities->>'archived', 'false') NOT IN ('true', '1', 'yes')
    """), {"uid": uid}).scalar() or 1

    return [{
        "specialty": r["specialty"],
        "node_count": int(r["node_count"]),
        "coverage_pct": round(int(r["node_count"]) / total * 100, 1),
    } for r in rows]
