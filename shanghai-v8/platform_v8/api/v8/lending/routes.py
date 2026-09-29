"""算力出借 HTTP 接口。"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_admin_account, get_current_account, get_session
from platform_v8.core import Account
from platform_v8.services.marketplace import lending as lending_svc

router = APIRouter(prefix="/api/v8/lending", tags=["lending"])
admin_router = APIRouter(prefix="/api/v8/admin/lending", tags=["lending-admin"])


class LendingSettingsIn(BaseModel):
    worker_id: str
    enabled: Optional[bool] = None
    max_cpu_cores: Optional[int] = None
    max_memory_mb: Optional[int] = None
    schedule: Optional[list[dict[str, Any]]] = None
    pricing_mode: Optional[str] = None
    manual_price: Optional[float] = None
    allow_third_party: Optional[bool] = None


@router.get("/status", summary="我的出借状态")
def lending_status(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    return lending_svc.status_for_user(session, current.id)


@router.put("/settings", summary="更新出借设置")
def lending_settings(
    body: LendingSettingsIn,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    try:
        return lending_svc.update_settings(
            session, current.id, body.model_dump(exclude_unset=True)
        )
    except lending_svc.LendingError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/earnings", summary="出借收益记录")
def lending_earnings(
    limit: int = Query(50, ge=1, le=200),
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    return lending_svc.list_earnings(session, current.id, limit=limit)


@router.get("/market", summary="出借市场行情 + 可接单节点")
def lending_market(
    task_type: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    session: Session = Depends(get_session),
) -> dict:
    quote = lending_svc.market_quote()
    nodes = lending_svc.list_market_nodes(session, task_type=task_type, limit=limit)
    return {**quote, **nodes}


@admin_router.post("/settle-daily", summary="出借收益日批补漏（真实 shard）")
def admin_settle_daily(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
) -> dict:
    return lending_svc.settle_daily(session)


@admin_router.post("/settle-shards", summary="按 lookback 扫描出借 shard 结算")
def admin_settle_shards(
    lookback_hours: int = Query(24, ge=1, le=168),
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
) -> dict:
    return lending_svc.settle_recent_shards(session, lookback_hours=lookback_hours)
