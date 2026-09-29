"""
Admin 自愈手动下发 · /api/v8/admin/heal/*  (2026-06-05)

运维兜底: admin 手动给指定节点下发白名单 control 修复指令 + 查自愈历史。
全 admin 鉴权 (Depends(get_admin_account))。action 严格白名单 (ws_schema.CONTROL_ACTIONS)。
"""
from __future__ import annotations
import logging
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from platform_v8.api.deps import get_admin_account, get_session
from platform_v8.core import Account
from platform_v8.protocol import ws_schema as wsp

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/admin/heal", tags=["admin-heal"])


class HealCommandIn(BaseModel):
    action: str = Field(..., description="白名单: reinstall_tier/fix_venv_cfg/clear_cache/switch_mirror/reprobe/prefetch_tier")
    params: dict = Field(default_factory=dict)
    reason: str = "admin manual"


@router.post("/{worker_id}")
async def dispatch_heal(
    worker_id: str,
    body: HealCommandIn,
    _admin: Account = Depends(get_admin_account),
) -> dict:
    """手动给指定节点下发一条白名单 control 修复指令。"""
    if body.action not in wsp.CONTROL_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"非法 action: {body.action} (白名单: {sorted(wsp.CONTROL_ACTIONS)})",
        )
    control_id = uuid.uuid4().hex
    try:
        frame = wsp.build_control(
            control_id=control_id,
            action=body.action,
            params=body.params or {},
            reason=body.reason or "admin manual",
            expires_at_ms=int((time.time() + 600) * 1000),
        )
    except wsp.ProtocolError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    from platform_v8.engine import broker
    from platform_v8.services.heal import decider
    ok = await broker.push_to_worker(worker_id, frame, source="admin_heal")
    decider._record(
        worker_id, control_id, body.action, ok=None,
        detail=f"admin dispatch reason={body.reason} delivered={ok}",
    )
    logger.warning("admin_heal · admin 下发 control · worker=%s action=%s delivered=%s",
                   str(worker_id)[:8], body.action, ok)
    # S2-T8 · 2026-06-07 · 高危补 audit (control 命令影响节点环境)
    try:
        from platform_v8.storage.repo import AuditRepo as _AuditRepo
        from platform_v8.storage.db import session_scope as _ss
        with _ss() as _s:
            _AuditRepo.write(
                _s,
                action="admin.heal.dispatch",
                actor_account_id=_admin.id,
                actor_kind="admin",
                target_kind="worker",
                target_id=str(worker_id),
                detail={
                    "control_id": control_id,
                    "action": body.action,
                    "params": body.params or {},
                    "reason": body.reason,
                    "delivered": ok,
                },
            )
            _s.commit()
    except Exception:
        pass
    return {
        "ok": True, "control_id": control_id, "action": body.action,
        "delivered": ok, "worker_id": worker_id,
    }


@router.get("/{worker_id}/history")
async def heal_history(
    worker_id: str,
    limit: int = 50,
    _admin: Account = Depends(get_admin_account),
    session=Depends(get_session),
) -> dict:
    """查指定节点的自愈 control 下发/回报历史 (we_node_repairs)。"""
    try:
        rows = session.execute(
            text(
                "SELECT control_id, action, ok, detail, created_at, updated_at "
                "FROM we_node_repairs WHERE worker_id = CAST(:w AS uuid) "
                "ORDER BY created_at DESC LIMIT :lim"
            ),
            {"w": worker_id, "lim": min(limit, 200)},
        ).mappings().all()
    except Exception as exc:
        # 表未建 → 返空 (不报错)
        logger.debug("heal_history skip (表可能未建): %s", exc)
        return {"worker_id": worker_id, "items": []}
    return {"worker_id": worker_id, "items": [dict(r) for r in rows]}
