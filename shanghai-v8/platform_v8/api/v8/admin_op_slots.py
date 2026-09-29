"""
运营位 admin CRUD · /api/v8/admin/op-slots/*

中台 (web-ops) 通过本接口管理运营位 · 复用 admin_v2.require_admin 鉴权。

写入操作 (create/update/delete/toggle) 会自动 broadcast OpSlotsChanged 帧
到所有在线 v8 客户端 · 实现热更新。
"""
from __future__ import annotations
import json
import logging
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session
from platform_v8.api.v8.admin_v2 import require_admin
from platform_v8.core import Account
from platform_v8.engine.broker import broadcast_to_all_workers

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/admin/op-slots", tags=["admin-op-slots"])


# ════════════════════════════════════════════════════════════════════
# Schemas
# ════════════════════════════════════════════════════════════════════
class OpSlotCreateIn(BaseModel):
    slot_key: str = Field(..., description="运营位 key · splash/banner/notice/activity/...")
    title: str = Field("", description="标题")
    subtitle: str = Field("", description="副标题")
    image_url: Optional[str] = None
    video_url: Optional[str] = None
    rich_html: Optional[str] = None
    action_type: str = Field("none", description="none/external/internal/download/qr")
    action_target: Optional[str] = None
    action_label: Optional[str] = None
    priority: int = 0
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    cooldown_hours: int = 0
    show_once: bool = False
    closable: bool = True
    target_audience: dict[str, Any] = Field(default_factory=dict)
    is_active: bool = True


class OpSlotUpdateIn(BaseModel):
    slot_key: Optional[str] = None
    title: Optional[str] = None
    subtitle: Optional[str] = None
    image_url: Optional[str] = None
    video_url: Optional[str] = None
    rich_html: Optional[str] = None
    action_type: Optional[str] = None
    action_target: Optional[str] = None
    action_label: Optional[str] = None
    priority: Optional[int] = None
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    cooldown_hours: Optional[int] = None
    show_once: Optional[bool] = None
    closable: Optional[bool] = None
    target_audience: Optional[dict[str, Any]] = None
    is_active: Optional[bool] = None


VALID_ACTION_TYPES = {"none", "external", "internal", "modal", "embed_url", "download", "qr"}  # 2026-05-25 8.0.9: + modal/embed_url


# ════════════════════════════════════════════════════════════════════
# helpers
# ════════════════════════════════════════════════════════════════════
def _row_to_dict(row) -> dict:
    d = dict(row)
    for k in ("created_at", "updated_at", "start_at", "end_at"):
        if d.get(k):
            d[k] = d[k].isoformat() if hasattr(d[k], "isoformat") else str(d[k])
    audience = d.get("target_audience")
    if isinstance(audience, str):
        try:
            d["target_audience"] = json.loads(audience)
        except Exception:
            d["target_audience"] = {}
    return d


async def _broadcast_changed(affected_keys: list[str], action: str) -> None:
    """运营位变更 · 广播给所有在线 v8 客户端"""
    try:
        sent = await broadcast_to_all_workers(
            "op_slots_changed",
            {
                "affected_keys": affected_keys,
                "action": action,  # 'created'/'updated'/'deleted'/'toggled'
                "ts": datetime.utcnow().isoformat(),
            },
        )
        logger.info(
            "admin_op_slots · broadcast op_slots_changed · keys=%s action=%s 推 %d 节点",
            affected_keys, action, sent,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("admin_op_slots · broadcast 失败 (静默): %s", exc)


# ════════════════════════════════════════════════════════════════════
# GET /admin/op-slots · 全量列表 (含禁用)
# ════════════════════════════════════════════════════════════════════
@router.get("", response_model=dict)
def list_op_slots(
    slot_key: Optional[str] = Query(None, description="按 slot_key 过滤"),
    is_active: Optional[bool] = Query(None, description="按状态过滤"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    _admin: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    conds, params = [], {"limit": limit, "offset": offset}
    if slot_key:
        conds.append("slot_key = :slot_key")
        params["slot_key"] = slot_key
    if is_active is not None:
        conds.append("is_active = :is_active")
        params["is_active"] = is_active
    where = "WHERE " + " AND ".join(conds) if conds else ""
    rows = session.execute(
        text(
            f"SELECT * FROM we_op_slots {where} "
            "ORDER BY slot_key, priority DESC, id DESC "
            "LIMIT :limit OFFSET :offset"
        ),
        params,
    ).mappings().all()
    total = session.execute(
        text(f"SELECT COUNT(*) AS c FROM we_op_slots {where}"),
        {k: v for k, v in params.items() if k not in ("limit", "offset")},
    ).scalar() or 0
    return {
        "ok": True,
        "total": total,
        "count": len(rows),
        "slots": [_row_to_dict(r) for r in rows],
    }


# ════════════════════════════════════════════════════════════════════
# GET /admin/op-slots/{id} · 单条
# ════════════════════════════════════════════════════════════════════
@router.get("/{slot_id}", response_model=dict)
def get_op_slot(
    slot_id: int,
    _admin: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    row = session.execute(
        text("SELECT * FROM we_op_slots WHERE id = :id"),
        {"id": slot_id},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail=f"运营位 {slot_id} 不存在")
    return {"ok": True, "slot": _row_to_dict(row)}


# ════════════════════════════════════════════════════════════════════
# POST /admin/op-slots · 创建
# ════════════════════════════════════════════════════════════════════
@router.post("", response_model=dict)
async def create_op_slot(
    body: OpSlotCreateIn,
    admin: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    if body.action_type not in VALID_ACTION_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"action_type 必须 ∈ {sorted(VALID_ACTION_TYPES)}",
        )
    if not (body.image_url or body.video_url or body.rich_html or body.title):
        raise HTTPException(
            status_code=400,
            detail="image_url / video_url / rich_html / title 至少要有一个",
        )

    res = session.execute(
        text(
            "INSERT INTO we_op_slots "
            "(slot_key, title, subtitle, image_url, video_url, rich_html, "
            " action_type, action_target, action_label, priority, "
            " start_at, end_at, cooldown_hours, show_once, closable, "
            " target_audience, is_active, created_by) "
            "VALUES "
            "(:slot_key, :title, :subtitle, :image_url, :video_url, :rich_html, "
            " :action_type, :action_target, :action_label, :priority, "
            " :start_at, :end_at, :cooldown_hours, :show_once, :closable, "
            " CAST(:target_audience AS jsonb), :is_active, :created_by) "
            "RETURNING id"
        ),
        {
            "slot_key": body.slot_key,
            "title": body.title,
            "subtitle": body.subtitle,
            "image_url": body.image_url,
            "video_url": body.video_url,
            "rich_html": body.rich_html,
            "action_type": body.action_type,
            "action_target": body.action_target,
            "action_label": body.action_label,
            "priority": body.priority,
            "start_at": body.start_at,
            "end_at": body.end_at,
            "cooldown_hours": body.cooldown_hours,
            "show_once": body.show_once,
            "closable": body.closable,
            "target_audience": json.dumps(body.target_audience, ensure_ascii=False),
            "is_active": body.is_active,
            "created_by": admin.id,
        },
    )
    new_id = res.scalar()
    session.commit()
    logger.info(
        "admin_op_slots.create · id=%s key=%s by=%s",
        new_id, body.slot_key, admin.id,
    )
    # 异步广播 (失败不阻塞)
    await _broadcast_changed([body.slot_key], "created")
    return {"ok": True, "id": new_id}


# ════════════════════════════════════════════════════════════════════
# PATCH /admin/op-slots/{id} · 更新
# ════════════════════════════════════════════════════════════════════
@router.patch("/{slot_id}", response_model=dict)
async def update_op_slot(
    slot_id: int,
    body: OpSlotUpdateIn,
    admin: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"ok": True, "updated": []}

    # 校验 action_type
    if "action_type" in updates and updates["action_type"] not in VALID_ACTION_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"action_type 必须 ∈ {sorted(VALID_ACTION_TYPES)}",
        )

    # 先查出原 slot_key (广播时需要 affected_keys)
    orig = session.execute(
        text("SELECT slot_key FROM we_op_slots WHERE id = :id"),
        {"id": slot_id},
    ).mappings().first()
    if not orig:
        raise HTTPException(status_code=404, detail=f"运营位 {slot_id} 不存在")

    sets, params = [], {"id": slot_id}
    for k, v in updates.items():
        if k == "target_audience":
            sets.append(f"{k} = CAST(:{k} AS jsonb)")
            params[k] = json.dumps(v, ensure_ascii=False)
        else:
            sets.append(f"{k} = :{k}")
            params[k] = v
    session.execute(
        text(f"UPDATE we_op_slots SET {', '.join(sets)} WHERE id = :id"),
        params,
    )
    session.commit()
    logger.info(
        "admin_op_slots.update · id=%s fields=%s by=%s",
        slot_id, list(updates.keys()), admin.id,
    )
    # 广播 · 涉及的 key = 原 key + 新 key (如果改了)
    affected = {orig["slot_key"]}
    if "slot_key" in updates:
        affected.add(updates["slot_key"])
    await _broadcast_changed(sorted(affected), "updated")
    return {"ok": True, "updated": list(updates.keys())}


# ════════════════════════════════════════════════════════════════════
# DELETE /admin/op-slots/{id} · 删除
# ════════════════════════════════════════════════════════════════════
@router.delete("/{slot_id}", response_model=dict)
async def delete_op_slot(
    slot_id: int,
    admin: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    orig = session.execute(
        text("SELECT slot_key FROM we_op_slots WHERE id = :id"),
        {"id": slot_id},
    ).mappings().first()
    if not orig:
        raise HTTPException(status_code=404, detail=f"运营位 {slot_id} 不存在")

    session.execute(text("DELETE FROM we_op_slots WHERE id = :id"), {"id": slot_id})
    session.commit()
    logger.info("admin_op_slots.delete · id=%s by=%s", slot_id, admin.id)
    await _broadcast_changed([orig["slot_key"]], "deleted")
    return {"ok": True, "deleted_id": slot_id}


# ════════════════════════════════════════════════════════════════════
# POST /admin/op-slots/{id}/toggle · 快捷开关
# ════════════════════════════════════════════════════════════════════
@router.post("/{slot_id}/toggle", response_model=dict)
async def toggle_op_slot(
    slot_id: int,
    admin: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    row = session.execute(
        text(
            "UPDATE we_op_slots SET is_active = NOT is_active WHERE id = :id "
            "RETURNING slot_key, is_active"
        ),
        {"id": slot_id},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail=f"运营位 {slot_id} 不存在")
    session.commit()
    logger.info(
        "admin_op_slots.toggle · id=%s is_active=%s by=%s",
        slot_id, row["is_active"], admin.id,
    )
    await _broadcast_changed([row["slot_key"]], "toggled")
    return {"ok": True, "id": slot_id, "is_active": row["is_active"]}


# ════════════════════════════════════════════════════════════════════
# GET /admin/op-slots/metrics · 列表总览 (一次拉全部 slot 的总览指标)
# 用于列表页扩列展示 impressions/clicks/CTR
# ════════════════════════════════════════════════════════════════════
@router.get("/metrics/overview", response_model=dict)
def list_slot_metrics(
    _admin: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    rows = session.execute(
        text(
            "SELECT slot_id, slot_key, impressions, clicks, unique_nodes, "
            "       ctr_pct, last_event_at "
            "FROM we_op_slot_metrics_total"
        ),
    ).mappings().all()
    by_id = {}
    for r in rows:
        d = dict(r)
        if d.get("last_event_at"):
            d["last_event_at"] = d["last_event_at"].isoformat()
        by_id[d["slot_id"]] = d
    return {"ok": True, "metrics": by_id}


# ════════════════════════════════════════════════════════════════════
# GET /admin/op-slots/{id}/stats?range=7d · 单 slot 详细统计
# 给广告主出 7/30/90 天 trend · 时段分布 · 跳转分布
# ════════════════════════════════════════════════════════════════════
_RANGE_DAYS = {"24h": 1, "7d": 7, "30d": 30, "90d": 90}


@router.get("/{slot_id}/stats", response_model=dict)
def get_slot_stats(
    slot_id: int,
    range: str = Query("7d", description="24h/7d/30d/90d"),
    _admin: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    days = _RANGE_DAYS.get(range, 7)

    # ── 1. slot 基础 ──
    slot_row = session.execute(
        text("SELECT id, slot_key, title FROM we_op_slots WHERE id = :id"),
        {"id": slot_id},
    ).mappings().first()
    if not slot_row:
        raise HTTPException(status_code=404, detail=f"运营位 {slot_id} 不存在")

    # ── 2. 总计 (range 内) ──
    totals = session.execute(
        text(
            "SELECT "
            "  COUNT(*) FILTER (WHERE event_type='impression') AS impressions, "
            "  COUNT(*) FILTER (WHERE event_type='click')      AS clicks, "
            "  COUNT(*) FILTER (WHERE event_type='dismiss')    AS dismisses, "
            "  COUNT(*) FILTER (WHERE event_type='close')      AS closes, "
            "  COUNT(DISTINCT node_id) FILTER (WHERE event_type='impression') AS unique_nodes_imp, "
            "  COUNT(DISTINCT node_id) FILTER (WHERE event_type='click')      AS unique_nodes_clk "
            "FROM we_op_slot_events "
            "WHERE slot_id = :id AND ts >= NOW() - (:days || ' days')::INTERVAL"
        ),
        {"id": slot_id, "days": days},
    ).mappings().first() or {}
    imp = int(totals.get("impressions") or 0)
    clk = int(totals.get("clicks") or 0)
    ctr = round(clk * 100.0 / imp, 2) if imp > 0 else 0.0

    # ── 3. 按日趋势 ──
    series = session.execute(
        text(
            "SELECT day::TEXT, impressions, clicks, ctr_pct, unique_nodes_imp "
            "FROM we_op_slot_metrics_daily "
            "WHERE slot_id = :id AND day >= (NOW() - (:days || ' days')::INTERVAL)::DATE "
            "ORDER BY day"
        ),
        {"id": slot_id, "days": days},
    ).mappings().all()

    # ── 4. 时段分布 (按 hour-of-day · 0-23 · 仅近 24h 有意义 · 但保留维度) ──
    hourly = session.execute(
        text(
            "SELECT EXTRACT(HOUR FROM ts AT TIME ZONE 'UTC')::INT AS hour, "
            "       COUNT(*) FILTER (WHERE event_type='impression') AS impressions, "
            "       COUNT(*) FILTER (WHERE event_type='click')      AS clicks "
            "FROM we_op_slot_events "
            "WHERE slot_id = :id AND ts >= NOW() - (:days || ' days')::INTERVAL "
            "GROUP BY hour ORDER BY hour"
        ),
        {"id": slot_id, "days": days},
    ).mappings().all()

    # ── 5. OS 分布 (帮广告主看哪些设备最爱点) ──
    by_os = session.execute(
        text(
            "SELECT COALESCE(client_os, 'unknown') AS os, "
            "       COUNT(*) FILTER (WHERE event_type='impression') AS impressions, "
            "       COUNT(*) FILTER (WHERE event_type='click')      AS clicks "
            "FROM we_op_slot_events "
            "WHERE slot_id = :id AND ts >= NOW() - (:days || ' days')::INTERVAL "
            "GROUP BY client_os ORDER BY clicks DESC, impressions DESC LIMIT 10"
        ),
        {"id": slot_id, "days": days},
    ).mappings().all()

    return {
        "ok": True,
        "slot": dict(slot_row),
        "range": range,
        "totals": {
            "impressions": imp,
            "clicks": clk,
            "dismisses": int(totals.get("dismisses") or 0),
            "closes": int(totals.get("closes") or 0),
            "unique_nodes_imp": int(totals.get("unique_nodes_imp") or 0),
            "unique_nodes_clk": int(totals.get("unique_nodes_clk") or 0),
            "ctr_pct": ctr,
        },
        "series": [dict(r) for r in series],
        "hourly": [dict(r) for r in hourly],
        "by_os": [dict(r) for r in by_os],
    }


# ════════════════════════════════════════════════════════════════════
# GET /admin/op-slots/benchmark · 按 slot_key 横向行业基准
# 让广告主看到 "你的 banner CTR vs 平台 banner 平均 CTR"
# ════════════════════════════════════════════════════════════════════
@router.get("/metrics/benchmark", response_model=dict)
def get_benchmark(
    range: str = Query("7d"),
    _admin: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    days = _RANGE_DAYS.get(range, 7)
    # 直接从 events 表算 · benchmark view 已按日聚合不方便横跨多日再聚
    rows = session.execute(
        text(
            "SELECT slot_key, "
            "       COUNT(DISTINCT slot_id)::INT                                      AS slot_count, "
            "       COUNT(*) FILTER (WHERE event_type='impression')::BIGINT           AS total_impressions, "
            "       COUNT(*) FILTER (WHERE event_type='click')::BIGINT                AS total_clicks, "
            "       COUNT(DISTINCT node_id) FILTER (WHERE event_type='impression')::BIGINT AS total_unique_nodes, "
            "       CASE WHEN COUNT(*) FILTER (WHERE event_type='impression') > 0 "
            "            THEN ROUND( "
            "                COUNT(*) FILTER (WHERE event_type='click')::NUMERIC * 100 "
            "                / COUNT(*) FILTER (WHERE event_type='impression')::NUMERIC, 2) "
            "            ELSE 0 END                                                    AS avg_ctr_pct "
            "FROM we_op_slot_events "
            "WHERE ts >= NOW() - (:days || ' days')::INTERVAL "
            "GROUP BY slot_key"
        ),
        {"days": days},
    ).mappings().all()
    return {
        "ok": True,
        "range": range,
        "benchmark": [dict(r) for r in rows],
    }
