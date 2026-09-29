"""
Workers HTTP router · /api/v8/workers/*

设计要点 (考虑全链路):
  - HTTP 注册是兼容入口 (老 client 用 HTTP 一次性注册)
  - 推荐走 WS (/api/v8/ws/worker) · WS 直接注册 + 长连心跳
  - 查询 endpoint 鉴权: owner 只能看自己 worker · admin 看所有
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from sqlalchemy.orm import Session
from sqlalchemy import text

from platform_v8.api.deps import get_session, get_current_account
from platform_v8.core import Account
from platform_v8.engine.privacy_titles import node_safe_workload_title
from platform_v8.protocol.http_schema import WorkerOut
from platform_v8.services.workers import register as register_svc
from platform_v8.storage.repo import WorkerRepo, AuditRepo
from platform_v8.engine import registry as registry_mod

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/workers", tags=["workers"])


def _node_safe_task_name(workload_id: Any, spec: dict) -> str:
    params = spec.get("params") if isinstance(spec, dict) else None
    recipe = params.get("recipe") if isinstance(params, dict) else None
    return node_safe_workload_title(
        str(workload_id or ""),
        task_type=(spec.get("task_type") if isinstance(spec, dict) else None),
        recipe=recipe,
    )


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ── POST /workers/register ──────────────────────────
from pydantic import BaseModel, Field


class RegisterWorkerRequest(BaseModel):
    worker_id: str = Field(..., min_length=6, max_length=64)
    name: str = ""
    client_version: str = ""
    capabilities: dict = Field(default_factory=dict)


@router.post("/register", response_model=WorkerOut,
             summary="HTTP 注册 worker (兼容入口 · 推荐用 WS)")
def register_endpoint(
    body: RegisterWorkerRequest,
    request: Request,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    try:
        worker = register_svc.register_worker(
            session,
            register_svc.RegisterWorkerInput(
                worker_id=body.worker_id,
                owner_id=current.id,
                name=body.name or body.worker_id,
                capabilities=body.capabilities,
                client_version=body.client_version,
                trace_id=getattr(request.state, "trace_id", None),
                ip=_client_ip(request),
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # invalidate cache · 让调度器立即看到新节点
    registry_mod.invalidate_cache(owner_id=current.id)
    return WorkerOut.model_validate(worker)


# ── GET /workers ────────────────────────────────────
@router.get("", summary="列出 worker (?scope=online_pool 仅返回全平台在线状态)")
def list_workers(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
    all: bool = Query(False, description="admin 专用: 列所有 (默认只列自己的)"),
    scope: str | None = Query(None, description="online_pool=全平台在线 (任何登录用户仅可读状态)"),
):
    # This is a cross-owner view. WorkerOut includes the stable device ID,
    # inventory, software, client version, and timestamps; masking name and
    # owner_id does not make it safe for another account to read.
    if scope == "online_pool":
        workers = WorkerRepo.list_online(session, owner_id=None,
                                         online_ttl_seconds=registry_mod.WORKER_ONLINE_TTL_S)
        return [{"status": str(getattr(w.status, "value", w.status))} for w in workers]

    if all and not current.is_admin:
        raise HTTPException(status_code=403, detail="?all=true 需要 admin 权限")

    if all:
        # admin · 列在线 (DB 直查 · 不走 cache)
        workers = WorkerRepo.list_online(session, owner_id=None,
                                         online_ttl_seconds=registry_mod.WORKER_ONLINE_TTL_S)
    else:
        # 普通用户 · 列自己的所有 worker (含 offline)
        workers = WorkerRepo.list_by_owner(session, current.id)

    return [WorkerOut.model_validate(w).model_dump() for w in workers]


# ── GET /workers/{id} ───────────────────────────────
@router.get("/{worker_id}", response_model=WorkerOut, summary="单个 worker 详情")
def get_worker(
    worker_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    worker = WorkerRepo.by_id(session, worker_id)
    if worker is None:
        raise HTTPException(status_code=404, detail="worker 不存在")
    if worker.owner_id != current.id and not current.is_admin:
        raise HTTPException(status_code=403, detail="无权访问他人 worker")
    return WorkerOut.model_validate(worker)


@router.get("/{worker_id}/dashboard", summary="机主接单看板：执行记录与已入账节点收益")
def worker_dashboard(
    worker_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=100_000),
):
    """Only the owner sees this node's bounded, content-free execution history.

    `we_shards.worker_id` records the current assignment, so a reassigned old
    attempt is not reconstructable here. This response says so explicitly.
    Rewards come from the beneficiary ledger row, never from a shard join or
    a floating point conversion. Plugin calls have no execution ledger yet.
    """
    worker = WorkerRepo.by_id(session, worker_id)
    if worker is None:
        raise HTTPException(status_code=404, detail="worker 不存在")
    if worker.owner_id != current.id:
        raise HTTPException(status_code=403, detail="仅机主可查看接单看板")

    counts = session.execute(text("""
        SELECT COUNT(*) AS total,
               COUNT(DISTINCT workload_id) AS workloads,
               COUNT(*) FILTER (WHERE status = 'DONE') AS succeeded,
               COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
               COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
               COUNT(*) FILTER (WHERE status NOT IN ('DONE', 'FAILED', 'CANCELLED')) AS pending_resolution,
               ROUND(AVG(elapsed_ms) FILTER (WHERE status = 'DONE' AND elapsed_ms IS NOT NULL)) AS avg_success_elapsed_ms
        FROM we_shards WHERE worker_id = :wid
    """), {"wid": worker_id}).one()
    rewards = session.execute(text("""
        SELECT COALESCE(SUM(amount), 0) AS amount
        FROM we_ledger
        WHERE account_id = :owner_id AND worker_id = :wid
          AND type = 'REWARD' AND basis = 'node_compute' AND currency = 'CNY'
    """), {"owner_id": current.id, "wid": worker_id}).scalar_one()
    rows = session.execute(text("""
        SELECT s.id, s.workload_id, s.status, s.attempts, s.dispatched_at,
               s.started_at, s.completed_at, s.elapsed_ms,
               COALESCE(w.spec->>'task_type', '') AS task_type,
               COALESCE((
                 SELECT SUM(l.amount) FROM we_ledger l
                 WHERE l.account_id = :owner_id AND l.worker_id = :wid
                   AND l.shard_id = s.id AND l.type = 'REWARD'
                   AND l.basis = 'node_compute' AND l.currency = 'CNY'
               ), 0) AS income_cny
        FROM we_shards s
        JOIN we_workloads w ON w.id = s.workload_id
        WHERE s.worker_id = :wid
        ORDER BY COALESCE(s.completed_at, s.started_at, s.dispatched_at) DESC NULLS LAST, s.id DESC
        LIMIT :limit OFFSET :offset
    """), {"owner_id": current.id, "wid": worker_id, "limit": limit, "offset": offset}).fetchall()

    def iso(value):
        return value.isoformat() if value is not None else None

    def money(value):
        return format(Decimal(value or 0).quantize(Decimal("0.0001")), "f")

    return {
        "schema": "qianshou.node-dashboard.v1",
        "worker_id": worker_id,
        "history_scope": "current_shard_assignment",
        "counts": {
            "executions": int(counts.total),
            "orders": int(counts.workloads),
            "succeeded": int(counts.succeeded),
            "failed": int(counts.failed),
            "cancelled": int(counts.cancelled),
            "pending_resolution": int(counts.pending_resolution),
            "avg_success_elapsed_ms": int(counts.avg_success_elapsed_ms) if counts.avg_success_elapsed_ms is not None else None,
        },
        "earnings": {"currency": "CNY", "settled_node_compute": money(rewards)},
        "plugin_calls": None,
        "plugin_calls_note": "插件执行尚无可核实的订单事件，暂不计次。",
        "total": int(counts.total),
        "limit": limit,
        "offset": offset,
        "items": [{
            "shard_id": str(row.id),
            "workload_id": str(row.workload_id),
            "task_type": str(row.task_type or "")[:128],
            "status": str(row.status or "").lower(),
            "attempts": int(row.attempts or 0),
            "dispatched_at": iso(row.dispatched_at),
            "started_at": iso(row.started_at),
            "completed_at": iso(row.completed_at),
            "elapsed_ms": int(row.elapsed_ms) if row.elapsed_ms is not None else None,
            "settled_node_compute_cny": money(row.income_cny),
        } for row in rows],
    }


# ── GET /workers/me/history · 当前账户名下所有 worker 的任务 ────────────
@router.get("/me/history", summary="当前账户所有 worker 的任务历史 (跨设备)")
def my_workers_history(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
    limit: int = Query(default=100, ge=1, le=500),
    status: str | None = Query(default=None),
    worker_id: str | None = Query(default=None, description="可选 · 只看某台设备"),
):
    """
    返回当前账户名下所有 worker 处理过的 shard (跨设备 · 默认全部)

    用例:
      - 节点 UI HistoryPage 默认: 看 qiye 账户下所有机器跑的任务
      - 加 ?worker_id=xxx 过滤特定设备
      - 加 ?status=DONE 过滤完成的
    """
    from sqlalchemy import text
    sql = """
        SELECT 
            s.id, s.workload_id, s.worker_id, s.status, s.attempts, s.error,
            s.dispatched_at, s.started_at, s.completed_at, s.elapsed_ms,
            LEFT(s.output_ref, 500) as output_preview,
            w.name as workload_name, w.spec,
            wk.name as worker_name
        FROM we_shards s
        LEFT JOIN we_workloads w ON s.workload_id = w.id
        LEFT JOIN we_workers wk ON s.worker_id = wk.id
        WHERE wk.owner_id = :owner_id
    """
    params = {"owner_id": current.id, "limit": limit}
    if worker_id:
        sql += " AND s.worker_id = :wid"
        params["wid"] = worker_id
    if status:
        sql += " AND s.status = :status"
        params["status"] = status.upper()
    sql += " ORDER BY s.dispatched_at DESC NULLS LAST LIMIT :limit"

    rows = session.execute(text(sql), params).fetchall()
    items = []
    for r in rows:
        spec = r.spec if isinstance(r.spec, dict) else {}
        items.append({
            "task_id": str(r.id),
            "workload_id": str(r.workload_id),
            "worker_id": str(r.worker_id) if r.worker_id else "",
            "worker_name": (r.worker_name or "")[:16],  # 短显示
            "task_name": _node_safe_task_name(r.workload_id, spec),
            "task_type": spec.get("task_type", ""),
            "status": r.status.lower() if r.status else "",
            "attempts": r.attempts,
            "error": r.error or "",
            "elapsed_ms": r.elapsed_ms or 0,
            "dispatched_at": r.dispatched_at.isoformat() if r.dispatched_at else None,
            "completed_at": r.completed_at.isoformat() if r.completed_at else None,
            "output_preview": r.output_preview or "",
        })

    return {
        "total": len(items),
        "items": items,
        "owner_id": current.id,
        "filter_worker_id": worker_id,
    }


# ── GET /workers/{id}/history · 单台节点的任务历史 ────────────
@router.get("/{worker_id}/history", summary="单台节点的任务历史 (按 worker_id)")
def worker_history(
    worker_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
    limit: int = Query(default=100, ge=1, le=500),
    status: str | None = Query(default=None, description="过滤状态: DONE / FAILED / DISPATCHED"),
):
    """
    返回该 worker 处理过的所有 shard (任务分片)
    
    用途: 节点端 HistoryPage 显示 "我这台机器跑了什么"
    """
    worker = WorkerRepo.by_id(session, worker_id)
    if worker is None:
        raise HTTPException(status_code=404, detail="worker 不存在")
    if worker.owner_id != current.id and not current.is_admin:
        raise HTTPException(status_code=403, detail="无权访问他人 worker")

    from sqlalchemy import text
    # 2026-05-21 · 给前端 HistoryPage 加 reward 字段 (subquery 求 we_ledger)
    # 每个 shard 可能对应多条 REWARD 流水 (奖励 + 加成) · 求和
    sql = """
        SELECT 
            s.id, s.workload_id, s.status, s.attempts, s.error,
            s.dispatched_at, s.started_at, s.completed_at, s.elapsed_ms,
            LEFT(s.output_ref, 500) as output_preview,
            w.name as workload_name, w.spec,
            COALESCE((
                SELECT SUM(amount) FROM we_ledger
                WHERE shard_id = s.id AND type = 'REWARD'
            ), 0)::float as reward
        FROM we_shards s
        LEFT JOIN we_workloads w ON s.workload_id = w.id
        WHERE s.worker_id = :wid
    """
    params = {"wid": worker_id, "limit": limit}
    if status:
        sql += " AND s.status = :status"
        params["status"] = status.upper()
    sql += " ORDER BY s.dispatched_at DESC NULLS LAST LIMIT :limit"

    rows = session.execute(text(sql), params).fetchall()
    items = []
    for r in rows:
        spec = r.spec if isinstance(r.spec, dict) else {}
        items.append({
            "task_id": str(r.id),
            "workload_id": str(r.workload_id),
            "task_name": _node_safe_task_name(r.workload_id, spec),
            "task_type": spec.get("task_type", ""),
            "status": r.status.lower() if r.status else "",
            "attempts": r.attempts,
            "error": r.error or "",
            "elapsed_ms": r.elapsed_ms or 0,
            "reward": float(r.reward or 0),
            "dispatched_at": r.dispatched_at.isoformat() if r.dispatched_at else None,
            "completed_at": r.completed_at.isoformat() if r.completed_at else None,
            "output_preview": r.output_preview or "",
        })

    return {"total": len(items), "items": items, "worker_id": worker_id}


@router.get("/me/rewards", summary="我的所有节点累计奖励 (按日/总)")
async def my_rewards(
    days: int = 30,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """节点收入: 跨设备汇总 · 按日聚合最近 N 天 · 配合 dashboard 收益图表。"""
    from sqlalchemy import text
    account_id = current.id
    rows = session.execute(text("""
        SELECT date_trunc('day', created_at) AS day,
               SUM(amount)::numeric AS total
        FROM we_ledger
        WHERE account_id = :aid AND type = 'REWARD'
              AND created_at > NOW() - INTERVAL ':days days'::interval
        GROUP BY day ORDER BY day DESC
    """.replace(":days", str(int(days)))), {"aid": account_id}).fetchall()

    daily = [{"date": r[0].date().isoformat(), "amount": float(r[1] or 0)} for r in rows]

    total = session.execute(text("""
        SELECT COALESCE(SUM(amount), 0)::numeric FROM we_ledger
        WHERE account_id = :aid AND type = 'REWARD'
    """), {"aid": account_id}).scalar()

    return {
        "account_id": account_id,
        "days": days,
        "total_all_time": float(total or 0),
        "daily": daily,
    }


@router.get("/{worker_id}/rewards", summary="单台节点的累计奖励 (按日聚合)")
async def worker_rewards(
    worker_id: str,
    days: int = 30,
    limit: int = 30,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """单台节点 worker 收益 · 鉴权: worker 所属 owner / admin 才能看"""
    from sqlalchemy import text
    # 鉴权: 该 worker 必须属于当前账户 (或 admin)
    row = session.execute(text(
        "SELECT owner_id FROM we_workers WHERE id = :wid"
    ), {"wid": worker_id}).fetchone()
    if row is None:
        from fastapi import HTTPException
        raise HTTPException(404, f"worker '{worker_id}' 不存在")
    owner_id = int(row[0])
    is_admin = str(current.role or "").lower() in ("admin", "superadmin")
    if owner_id != int(current.id) and not is_admin:
        from fastapi import HTTPException
        raise HTTPException(403, "无权查看此 worker 收益")

    # 按日聚合 (join we_shards 拿 worker_id 关联)
    days_clamped = max(1, min(int(days), 365))
    rows = session.execute(text(f"""
        SELECT date_trunc('day', l.created_at) AS day,
               SUM(l.amount)::numeric AS total,
               COUNT(*) AS tx_count
        FROM we_ledger l
        JOIN we_shards s ON l.shard_id = s.id
        WHERE s.worker_id = :wid
          AND l.type = 'REWARD'
          AND l.created_at > NOW() - INTERVAL '{days_clamped} days'
        GROUP BY day ORDER BY day DESC
        LIMIT :lim
    """), {"wid": worker_id, "lim": max(1, min(int(limit), 365))}).fetchall()
    daily = [{
        "date": r[0].date().isoformat(),
        "amount": float(r[1] or 0),
        "tx_count": int(r[2] or 0),
    } for r in rows]

    total = session.execute(text("""
        SELECT COALESCE(SUM(l.amount), 0)::numeric, COUNT(*)
        FROM we_ledger l
        JOIN we_shards s ON l.shard_id = s.id
        WHERE s.worker_id = :wid AND l.type = 'REWARD'
    """), {"wid": worker_id}).fetchone()

    return {
        "worker_id": worker_id,
        "owner_id": owner_id,
        "days": days_clamped,
        "total_all_time": float(total[0] or 0) if total else 0,
        "tx_count_all_time": int(total[1] or 0) if total else 0,
        "daily": daily,
    }


# ══════════════════════════════════════════════════════════════════
#   能力广告 + 垂类匹配 (capability-aware routing) — 专利 09 配套
# ══════════════════════════════════════════════════════════════════
class CapabilitiesPatch(BaseModel):
    """节点上报能力 patch · 合并到 we_workers.capabilities JSONB"""
    specialty: list[str] | None = Field(None, description="例: ['photo-edit','ocr']")
    equipped_models: list[str] | None = Field(None, description="例: ['sam-vit-b','lama']")
    model_health: dict[str, str] | None = Field(None, description="例: {'sam-vit-b':'loaded'}")
    ram_gb: float | None = None
    disk_mb: float | None = None
    network: bool | None = None
    extra: dict | None = Field(None, description="任意扩展字段")


@router.patch("/{worker_id}/capabilities", summary="上报节点专项能力 (specialty + equipped_models)")
def patch_capabilities(
    worker_id: str,
    body: CapabilitiesPatch,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    """节点上报垂类专项能力 · 仅 owner 或 admin 可改 · 合并写入 capabilities JSONB
    用于让调度器按 skill.required_models 精准匹配节点
    """
    w = WorkerRepo.by_id(session, worker_id)
    if not w:
        raise HTTPException(status_code=404, detail="worker_not_found")
    is_admin = getattr(current, "role", "") in ("admin", "ADMIN", "channel_admin")
    if w.owner_id != current.id and not is_admin:
        raise HTTPException(status_code=403, detail="forbidden")

    patch = {k: v for k, v in body.model_dump(exclude_none=True).items() if k != "extra"}
    if body.extra:
        if "review_only" in body.extra:
            raise HTTPException(status_code=403, detail="review_only_is_server_owned")
        patch.update(body.extra)
    if not patch:
        raise HTTPException(status_code=400, detail="empty_patch")

    ok = WorkerRepo.update_capabilities(session, worker_id, patch)
    session.commit()
    if not ok:
        raise HTTPException(status_code=500, detail="update_failed")

    registry_mod.invalidate_cache(owner_id=w.owner_id)
    return {"worker_id": worker_id, "patched": list(patch.keys()), "ok": True}


# ══════════════════════════════════════════════════════════════════
#   节点管理 (owner 自管) · pause / resume / delete
#   pause/resume 通过 capabilities.mode 接入 planner._filter_by_throttle
#   (mode=paused 的节点会被调度排除) · 与客户端 hb 上报同一机制 · 即时生效。
#   仅 owner / admin 可操作自己的节点 · 池内他人节点禁止。
# ══════════════════════════════════════════════════════════════════
def _require_owned_worker(session: Session, worker_id: str, current: Account):
    worker = WorkerRepo.by_id(session, worker_id)
    if worker is None:
        raise HTTPException(status_code=404, detail="worker 不存在")
    if worker.owner_id != current.id and not current.is_admin:
        raise HTTPException(status_code=403, detail="无权操作他人节点")
    return worker


class KickWorkerRequest(BaseModel):
    minutes: int = Field(..., ge=1, le=1440)
    reason: str = Field(default="", max_length=255)


@router.post(
    "/{worker_id}/kick",
    summary="强制节点下线并临时禁止重连（仅 admin）",
)
async def kick_worker(
    worker_id: str,
    body: KickWorkerRequest,
    request: Request,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    # 2026-08-09 · 权限隔离：踢任意设备仅管理员；普通用户（含节点 owner）禁止。
    if not current.is_admin:
        raise HTTPException(status_code=403, detail="仅管理员可强制节点下线")
    worker = WorkerRepo.by_id(session, worker_id)
    if worker is None:
        raise HTTPException(status_code=404, detail="worker 不存在")
    disabled_until = datetime.now(timezone.utc) + timedelta(minutes=body.minutes)
    if not WorkerRepo.disable_temporarily(
        session,
        worker_id,
        disabled_until=disabled_until,
        disabled_by=current.id,
        reason=body.reason,
    ):
        raise HTTPException(status_code=404, detail="worker 不存在")
    AuditRepo.write(
        session,
        action="worker.temporary_disable",
        actor_account_id=current.id,
        actor_kind="admin" if current.is_admin else "user",
        target_kind="worker",
        target_id=worker_id,
        trace_id=getattr(request.state, "trace_id", None),
        ip=_client_ip(request),
        detail={
            "minutes": body.minutes,
            "disabled_until": disabled_until.isoformat(),
            "reason": body.reason,
            "owner_id": worker.owner_id,
        },
    )
    # 必须先提交封禁，再关闭 WS；否则客户端可能在事务提交前重连成功。
    session.commit()
    registry_mod.invalidate_cache(owner_id=worker.owner_id)

    from platform_v8.engine import broker as broker_mod
    from platform_v8.engine import gateway as gateway_mod
    from platform_v8.api.v8.events import publish_event_sync

    gateway_mod.set_worker_disabled_until(worker_id, disabled_until.timestamp())
    disconnected = await broker_mod.kick_worker(
        worker_id,
        reason=f"临时禁止上线 {body.minutes} 分钟",
    )
    publish_event_sync(
        "worker.offline",
        {
            "worker_id": worker_id,
            "owner_id": worker.owner_id,
            "reason": "temporary_disable",
            "disabled_until": disabled_until.isoformat(),
        },
        owner_id=worker.owner_id,
    )
    logger.info(
        "worker.kick · %s by account=%s minutes=%s disconnected=%s",
        worker_id, current.id, body.minutes, disconnected,
    )
    return {
        "ok": True,
        "worker_id": worker_id,
        "minutes": body.minutes,
        "disabled_until": disabled_until.isoformat(),
        "disconnected": disconnected,
    }


@router.post("/{worker_id}/pause", summary="暂停节点 (停止派单 · owner 自管)")
def pause_worker(
    worker_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    worker = _require_owned_worker(session, worker_id, current)
    WorkerRepo.update_capabilities(session, worker_id, {"mode": "paused"})
    session.commit()
    registry_mod.invalidate_cache(owner_id=worker.owner_id)
    logger.info("worker.pause · %s by account=%s", worker_id, current.id)
    return {"ok": True, "worker_id": worker_id, "mode": "paused"}


@router.post("/{worker_id}/resume", summary="恢复节点 (重新可派单 · owner 自管)")
def resume_worker(
    worker_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    worker = _require_owned_worker(session, worker_id, current)
    WorkerRepo.update_capabilities(session, worker_id, {"mode": "active"})
    session.commit()
    registry_mod.invalidate_cache(owner_id=worker.owner_id)
    logger.info("worker.resume · %s by account=%s", worker_id, current.id)
    return {"ok": True, "worker_id": worker_id, "mode": "active"}


@router.delete("/{worker_id}", summary="摘除节点 (owner 自管 · 删除注册记录)")
def delete_worker(
    worker_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    worker = _require_owned_worker(session, worker_id, current)
    ok = WorkerRepo.delete(session, worker_id)
    session.commit()
    registry_mod.invalidate_cache(owner_id=worker.owner_id)
    logger.info("worker.delete · %s by account=%s ok=%s", worker_id, current.id, ok)
    return {"ok": ok, "worker_id": worker_id}


@router.post("/match", summary="按 skill manifest 检索能跑该 skill 的节点 (调度器/admin)")
def match_capable_workers(
    body: dict,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
    explain: bool = Query(False, description="返回所有节点的匹配诊断"),
    online_only: bool = Query(True),
) -> dict:
    """
    入参 body = skill manifest (或精简版): {"industry":"photography","required_models":[...]}
    返回能跑该 skill 的 worker_id 列表 (强健康过滤)
    explain=true 时返回每个节点的匹配诊断
    """
    from platform_v8.services.capability_match import filter_capable, explain_all

    is_admin = getattr(current, "role", "") in ("admin", "ADMIN", "channel_admin")
    if online_only:
        workers = WorkerRepo.list_online(session, owner_id=None if is_admin else current.id)
    else:
        workers = WorkerRepo.list_by_owner(session, current.id) if not is_admin else []

    if explain:
        return {
            "skill_industry": body.get("industry"),
            "required_models": body.get("required_models") or [],
            "scanned": len(workers),
            "diagnostics": explain_all(workers, body, strict_health=True),
        }

    capable = filter_capable(workers, body, strict_health=True)
    return {
        "skill_industry": body.get("industry"),
        "required_models": body.get("required_models") or [],
        "scanned": len(workers),
        "matched_count": len(capable),
        "workers": [
            {"worker_id": ad.worker_id, "specialty": sorted(ad.specialty),
             "healthy_models": sorted(ad.healthy_models())}
            for ad, _ in capable
        ],
    }
