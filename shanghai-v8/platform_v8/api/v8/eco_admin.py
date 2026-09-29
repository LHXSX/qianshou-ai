"""生态运营台 Admin API · /api/v8/admin/eco/*

对接 apps/eco-admin（千手生态运营后台）。
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session
from platform_v8.core import Account
from platform_v8.services.eco_admin.rbac import matrix_for_ui, normalize_role, require_perm
from platform_v8.services.marketplace import apps as apps_svc
from platform_v8.services.openplatform import admin_ops

router = APIRouter(prefix="/api/v8/admin/eco", tags=["eco-admin"])


@router.get("/home", summary="运营总后台首页工作台")
def eco_home(
    session: Session = Depends(get_session),
    _admin: Account = Depends(require_perm("eco.home")),
) -> dict:
    return admin_ops.home_workbench(session)


@router.get("/roles/matrix", summary="权限矩阵（前端权限中心）")
def eco_roles_matrix(
    admin: Account = Depends(require_perm("eco.home")),
) -> dict:
    return {
        "ok": True,
        "my_role": normalize_role(admin),
        "matrix": matrix_for_ui(),
    }


@router.get("/openapi/dashboard", summary="OpenAPI 运营首页")
def openapi_dashboard(
    day: Optional[date] = Query(None),
    app_id: Optional[int] = Query(None),
    session: Session = Depends(get_session),
    _admin: Account = Depends(require_perm("eco.openapi.read")),
) -> dict:
    return admin_ops.openapi_dashboard(session, day=day, app_id=app_id)


@router.get("/openapi/usage", summary="调用流水（分页）")
def openapi_usage(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    app_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    session: Session = Depends(get_session),
    _admin: Account = Depends(require_perm("eco.openapi.read")),
) -> dict:
    items = admin_ops.list_usage(
        session, limit=limit, offset=offset, app_id=app_id, status=status,
    )
    return {"ok": True, "items": items}


@router.get("/openapi/packs", summary="套餐销售汇总")
def openapi_packs(
    session: Session = Depends(get_session),
    _admin: Account = Depends(require_perm("eco.openapi.read")),
) -> dict:
    return {"ok": True, "items": admin_ops.pack_sales(session)}


@router.get("/openapi/orders", summary="套餐订单流水")
def openapi_orders(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
    _admin: Account = Depends(require_perm("eco.openapi.read")),
) -> dict:
    return {
        "ok": True,
        "items": admin_ops.list_pack_orders(session, limit=limit, offset=offset),
    }


@router.get("/openapi/keys", summary="API Key 列表")
def openapi_keys(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
    _admin: Account = Depends(require_perm("eco.openapi.read")),
) -> dict:
    return {"ok": True, "items": admin_ops.list_keys(session, limit=limit, offset=offset)}


@router.get("/openapi/quotas", summary="OpenAPI 套餐配额（剩余调用次数）")
def openapi_quotas(
    threshold: Optional[int] = Query(
        20, ge=0, le=100000000, description="剩余≤阈值；不传或 -1 表示全部",
    ),
    limit: int = Query(50, ge=1, le=200),
    q: Optional[str] = Query(None, description="账户名模糊搜"),
    app_id: Optional[int] = Query(None),
    all_rows: bool = Query(False, description="true=忽略阈值列全部配额"),
    session: Session = Depends(get_session),
    _admin: Account = Depends(require_perm("eco.openapi.read")),
) -> dict:
    th = None if all_rows or threshold is None or threshold < 0 else threshold
    items = admin_ops.list_quotas(
        session, threshold=th, limit=limit, account_q=q, app_id=app_id,
    )
    return {"ok": True, "items": items, "threshold": th, "kind": "openapi_call_quota"}


@router.post("/openapi/keys/{key_id}/revoke", summary="管理员吊销 API Key")
def openapi_key_revoke(
    key_id: int,
    session: Session = Depends(get_session),
    admin: Account = Depends(require_perm("eco.openapi.revoke_key")),
) -> dict:
    try:
        return admin_ops.admin_revoke_key(session, key_id=key_id, actor_id=admin.id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/openapi/stats", summary="调用量时间序列")
def openapi_stats(
    days: int = Query(14, ge=1, le=90),
    app_id: Optional[int] = Query(None),
    session: Session = Depends(get_session),
    _admin: Account = Depends(require_perm("eco.openapi.read")),
) -> dict:
    return admin_ops.call_stats_series(session, days=days, app_id=app_id)


@router.get("/funds/summary", summary="开放平台资金概览")
def funds_summary(
    session: Session = Depends(get_session),
    _admin: Account = Depends(require_perm("eco.funds.read")),
) -> dict:
    return admin_ops.funds_summary(session)


@router.get("/apps/review", summary="应用审核队列（别名）")
def apps_review(
    limit: int = Query(50, ge=1, le=200),
    session: Session = Depends(get_session),
    _admin: Account = Depends(require_perm("eco.apps.review")),
) -> dict:
    return apps_svc.list_review_queue(session, limit=limit)


@router.get("/audit", summary="运营审计日志")
def eco_audit(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
    _admin: Account = Depends(require_perm("eco.audit.read")),
) -> dict:
    from sqlalchemy import text

    rows = session.execute(
        text("""
            SELECT id, actor_account_id, actor_kind, action,
                   target_kind, target_id, detail, created_at
              FROM we_audit
             ORDER BY created_at DESC
             LIMIT :lim OFFSET :off
        """),
        {"lim": limit, "off": offset},
    ).mappings().all()
    items = []
    for r in rows:
        d = dict(r)
        if d.get("created_at"):
            d["created_at"] = d["created_at"].isoformat()
        # 兼容前端旧字段 target
        tgt_kind = d.get("target_kind") or ""
        tgt_id = d.get("target_id") or ""
        d["target"] = f"{tgt_kind}:{tgt_id}".strip(":") if (tgt_kind or tgt_id) else ""
        if d.get("detail") is not None and not isinstance(d["detail"], (str, dict, list)):
            d["detail"] = str(d["detail"])
        items.append(d)
    return {"ok": True, "items": items}


class AdjustBalanceIn(BaseModel):
    amount: float = Field(..., description="正数充值 · 负数扣款")
    note: str = ""


@router.post("/users/{user_id}/balance/adjust", summary="运营调余额（写 ledger + 审计）")
def eco_adjust_balance(
    user_id: int,
    body: AdjustBalanceIn,
    session: Session = Depends(get_session),
    admin: Account = Depends(require_perm("eco.users.balance_adjust")),
) -> dict:
    from decimal import Decimal
    import uuid as _uuid

    from sqlalchemy import text

    from platform_v8.storage.repo import AuditRepo

    amt = Decimal(str(body.amount)).quantize(Decimal("0.01"))
    if amt == 0:
        raise HTTPException(status_code=400, detail="amount 不能为 0")
    note = (body.note or f"eco-admin 调额 by aid={admin.id}").strip()[:200]
    row = session.execute(
        text("SELECT id, balance FROM we_accounts WHERE id = :uid"),
        {"uid": user_id},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="用户不存在")
    new_bal = Decimal(str(row["balance"] or 0)) + amt
    if new_bal < 0:
        raise HTTPException(status_code=400, detail="调额后余额不能为负")
    session.execute(
        text("UPDATE we_accounts SET balance = balance + :amt WHERE id = :uid"),
        {"amt": amt, "uid": user_id},
    )
    session.execute(
        text("""
            INSERT INTO we_ledger (id, account_id, type, amount, currency,
                                   idempotent_key, note, metadata, created_at)
            VALUES (:id, :uid, 'ADMIN_ADJUST', :amt, 'EDG',
                    :idk, :note, CAST(:meta AS jsonb), NOW())
        """),
        {
            "id": str(_uuid.uuid4()),
            "uid": user_id,
            "amt": amt,
            "idk": f"eco:adjust:{user_id}:{_uuid.uuid4().hex}",
            "note": note,
            "meta": "{}",
        },
    )
    AuditRepo.write(
        session,
        action="eco.balance.adjust",
        actor_account_id=admin.id,
        actor_kind="admin",
        target_kind="account",
        target_id=str(user_id),
        detail={"amount": float(amt), "note": note, "new_balance": float(new_bal)},
    )
    return {
        "ok": True,
        "user_id": user_id,
        "amount": float(amt),
        "new_balance": float(new_bal),
        "note": note,
    }
