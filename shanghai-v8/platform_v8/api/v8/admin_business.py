"""
api/v8/admin_business.py · B2B 客户合约 admin API (W7 · 2026-05-26)

路由前缀 /api/v8/admin/business
  GET    /contracts                  · 合约列表
  POST   /contracts                  · 新建合约
  GET    /contracts/{id}             · 单个合约详情
  PATCH  /contracts/{id}             · 改合约字段
  POST   /contracts/{id}/status      · 改状态 (active/suspended/expired/draft)
  GET    /contracts/{id}/quota       · 月配额 + 已用统计
  GET    /accounts/{account_id}/contracts · 某客户所有合约

用户原话:
  "ip池 的作用是承包给其他大厂 吊用我们的"
  → admin 手工签约 + 配额管理 + SLA 监控
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_admin_account, get_session
from platform_v8.core import Account
from platform_v8.services.business import contracts as contracts_svc
from platform_v8.services.business import billing as billing_svc

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/admin/business", tags=["admin-business"])


# ════════════════════════════════════════════════════════════════
# 合约 CRUD
# ════════════════════════════════════════════════════════════════
@router.get("/contracts")
def list_contracts(
    account_id: Optional[int] = None,
    status: Optional[str] = None,
    business_type: Optional[str] = None,
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """合约列表 · 支持过滤"""
    items = contracts_svc.list_contracts(
        s,
        account_id=account_id,
        status=status,
        business_type=business_type,
        limit=limit,
        offset=offset,
    )
    return {"items": items, "count": len(items)}


@router.post("/contracts")
def create_contract(
    body: dict = Body(...),
    admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """新建合约 · admin 手工签约入口

    body 字段:
      - account_id (必填)
      - name (必填)
      - business_type (默认 ip_proxy)
      - quota_bytes_per_month (默认 0 = 不限)
      - quota_concurrent_sessions (默认 100)
      - price_per_gb_edg (默认 0.01)
      - discount_pct (默认 0)
      - sla_uptime_pct (默认 99)
      - sla_support_tier (默认 standard)
      - status (默认 draft)
      - end_at (ISO datetime · 默认 NULL=长期)
      - notes / metadata
    """
    try:
        contract_id = contracts_svc.create_contract(
            s,
            account_id=int(body["account_id"]),
            name=str(body["name"]),
            business_type=body.get("business_type", "ip_proxy"),
            quota_bytes_per_month=int(body.get("quota_bytes_per_month", 0)),
            quota_concurrent_sessions=int(body.get("quota_concurrent_sessions", 100)),
            price_per_gb_edg=Decimal(str(body.get("price_per_gb_edg", "0.01"))),
            discount_pct=Decimal(str(body.get("discount_pct", "0"))),
            sla_uptime_pct=Decimal(str(body.get("sla_uptime_pct", "99"))),
            sla_support_tier=body.get("sla_support_tier", "standard"),
            status=body.get("status", "draft"),
            notes=body.get("notes", ""),
            metadata=body.get("metadata", {}),
            created_by=admin.id,
        )
        s.commit()
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("create_contract fail")
        raise HTTPException(status_code=500, detail=str(e))

    contract = contracts_svc.get_contract(s, contract_id)
    return {"ok": True, "contract": contract}


@router.get("/contracts/{contract_id}")
def get_contract(
    contract_id: int,
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """单个合约详情"""
    contract = contracts_svc.get_contract(s, contract_id)
    if not contract:
        raise HTTPException(status_code=404, detail="contract not found")
    return contract


@router.patch("/contracts/{contract_id}")
def update_contract(
    contract_id: int,
    body: dict = Body(...),
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """改合约 · 仅 name/quota/price/sla/notes 等可改 · status 走单独 endpoint"""
    # 类型转换
    if "price_per_gb_edg" in body:
        body["price_per_gb_edg"] = Decimal(str(body["price_per_gb_edg"]))
    if "discount_pct" in body:
        body["discount_pct"] = Decimal(str(body["discount_pct"]))
    if "sla_uptime_pct" in body:
        body["sla_uptime_pct"] = Decimal(str(body["sla_uptime_pct"]))

    try:
        ok = contracts_svc.update_contract(s, contract_id, **body)
        s.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not ok:
        raise HTTPException(status_code=404, detail="contract not found or no changes")

    contract = contracts_svc.get_contract(s, contract_id)
    return {"ok": True, "contract": contract}


@router.post("/contracts/{contract_id}/status")
def change_status(
    contract_id: int,
    body: dict = Body(...),
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """状态机入口 · body: {"status": "active"}"""
    new_status = body.get("status")
    if not new_status:
        raise HTTPException(status_code=400, detail="status required")
    try:
        ok = contracts_svc.set_status(s, contract_id, new_status)
        s.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="contract not found")
    return {"ok": True, "status": new_status}


@router.get("/contracts/{contract_id}/quota")
def get_contract_quota(
    contract_id: int,
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """合约配额 + 本月已用 · admin 看客户用量"""
    contract = contracts_svc.get_contract(s, contract_id)
    if not contract:
        raise HTTPException(status_code=404, detail="contract not found")
    quota = contracts_svc.check_monthly_quota(
        s,
        account_id=contract["account_id"],
        business_type=contract["business_type"],
    )
    return {"contract": contract, "quota": quota}


# ════════════════════════════════════════════════════════════════
# 按客户视角 (跟 /contracts?account_id=X 等价 · 但路径更直观)
# ════════════════════════════════════════════════════════════════
@router.get("/accounts/{account_id}/contracts")
def list_account_contracts(
    account_id: int,
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """某客户全部合约"""
    items = contracts_svc.list_contracts(s, account_id=account_id)
    active = next((c for c in items if c["status"] == "active"), None)
    return {
        "account_id": account_id,
        "items": items,
        "count": len(items),
        "active_contract": active,
    }


# ════════════════════════════════════════════════════════════════
# W7-phase2 · 月度账单 (invoices)
# ════════════════════════════════════════════════════════════════
@router.get("/invoices")
def list_invoices(
    account_id: Optional[int] = None,
    status: Optional[str] = None,
    period_yyyymm: Optional[str] = None,
    business_type: Optional[str] = None,
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """月度账单列表 · 支持过滤 account/status/period/business_type"""
    items = billing_svc.list_invoices(
        s, account_id=account_id, status=status,
        period_yyyymm=period_yyyymm, business_type=business_type,
        limit=limit, offset=offset,
    )
    return {"items": items, "count": len(items)}


@router.post("/invoices/generate")
def generate_invoice(
    body: dict = Body(...),
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """admin 触发生成账单 · 自动从 ledger + we_proxy_sessions 聚合

    body:
      - account_id (必填)
      - period_yyyymm (必填 · "2026-05")
      - business_type (默认 ip_proxy)
      - contract_id (可选)
      - auto_issue (默认 false · true 时直接 status=issued + 设 due_at)
      - due_days (默认 14)
    """
    try:
        inv = billing_svc.generate_invoice(
            s,
            account_id=int(body["account_id"]),
            period_yyyymm=str(body["period_yyyymm"]),
            business_type=body.get("business_type", "ip_proxy"),
            contract_id=int(body["contract_id"]) if body.get("contract_id") else None,
            auto_issue=bool(body.get("auto_issue", False)),
            due_days=int(body.get("due_days", 14)),
        )
        s.commit()
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("generate_invoice fail")
        raise HTTPException(status_code=500, detail=str(e))

    return {"ok": True, "invoice": inv}


@router.get("/invoices/{invoice_id}")
def get_invoice(
    invoice_id: int,
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    inv = billing_svc.get_invoice(s, invoice_id)
    if not inv:
        raise HTTPException(status_code=404, detail="invoice not found")
    return inv


@router.post("/invoices/{invoice_id}/issue")
def issue_invoice(
    invoice_id: int,
    body: dict = Body(default={}),
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """draft → issued · 设 due_at"""
    due_days = int(body.get("due_days", 14)) if body else 14
    ok = billing_svc.issue_invoice(s, invoice_id, due_days=due_days)
    s.commit()
    if not ok:
        raise HTTPException(status_code=400, detail="invoice not in draft state or not found")
    inv = billing_svc.get_invoice(s, invoice_id)
    return {"ok": True, "invoice": inv}


@router.post("/invoices/{invoice_id}/pay")
def mark_paid(
    invoice_id: int,
    body: dict = Body(default={}),
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """issued → paid · 链下转账后 admin 手工标"""
    note = body.get("note", "") if body else ""
    ok = billing_svc.mark_paid(s, invoice_id, paid_note=str(note))
    s.commit()
    if not ok:
        raise HTTPException(status_code=400, detail="invoice not in issued state or not found")
    inv = billing_svc.get_invoice(s, invoice_id)
    return {"ok": True, "invoice": inv}


@router.post("/invoices/{invoice_id}/cancel")
def cancel_invoice(
    invoice_id: int,
    body: dict = Body(default={}),
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """作废账单 (paid 不可撤)"""
    reason = body.get("reason", "") if body else ""
    ok = billing_svc.cancel_invoice(s, invoice_id, reason=str(reason))
    s.commit()
    if not ok:
        raise HTTPException(status_code=400, detail="invoice not cancellable (maybe already paid)")
    inv = billing_svc.get_invoice(s, invoice_id)
    return {"ok": True, "invoice": inv}
