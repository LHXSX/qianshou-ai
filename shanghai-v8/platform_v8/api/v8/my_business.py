"""
api/v8/my_business.py · 客户视角 B2B 合约 + 账单 API (W8 · 2026-05-26)

路由前缀 /api/v8/business/me · 任何已登录账户都可调

  GET    /contracts                       · 我的合约列表
  GET    /contracts/{id}                  · 我的合约详情 (含 quota 进度)
  GET    /invoices                        · 我的账单列表
  GET    /invoices/{id}                   · 我的账单详情
  POST   /invoices/{id}/request-payment   · 申请付款 (链下转账后通知 admin · 不动 status)
  GET    /usage?period=2026-05            · 当月跨业务用量摘要

授权: 所有 endpoint 严格 by current.account_id · 跨账户访问 → 404 (不泄露存在性)

设计:
  - 复用 services/business/{contracts,billing}.py
  - 只读为主 · 仅 request-payment 是写 (写 metadata 标记 · 真正 paid 仍需 admin 复核)
"""
from __future__ import annotations

import logging
from datetime import datetime, date
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.core import Account
from platform_v8.services.business import billing as billing_svc
from platform_v8.services.business import contracts as contracts_svc

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/business/me", tags=["my-business"])


# ════════════════════════════════════════════════════════════════
# 合约 (只读)
# ════════════════════════════════════════════════════════════════
@router.get("/contracts")
def my_contracts(
    status: Optional[str] = Query(None, description="filter: draft/active/suspended/expired"),
    business_type: Optional[str] = Query(None, description="filter: ip_proxy/crawl/geo_monitor"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    me: Account = Depends(get_current_account),
    s: Session = Depends(get_session),
) -> dict:
    """我的合约列表 · 自动 by account_id"""
    items = contracts_svc.list_contracts(
        s,
        account_id=me.id,
        status=status,
        business_type=business_type,
        limit=limit,
        offset=offset,
    )
    return {"items": items, "count": len(items)}


@router.get("/contracts/{contract_id}")
def my_contract_detail(
    contract_id: int,
    me: Account = Depends(get_current_account),
    s: Session = Depends(get_session),
) -> dict:
    """我的合约详情 · 含当月配额使用进度

    Returns:
        {
          "contract": {...},
          "quota": {has_contract, quota_bytes, used_bytes, exceeded, remaining_bytes},
          "period_yyyymm": "2026-05"
        }
    """
    contract = contracts_svc.get_contract(s, contract_id)
    if not contract or contract.get("account_id") != me.id:
        raise HTTPException(404, "合约不存在")

    quota = contracts_svc.check_monthly_quota(
        s,
        account_id=me.id,
        business_type=contract.get("business_type", "ip_proxy"),
    )
    period = date.today().strftime("%Y-%m")
    return {"contract": contract, "quota": quota, "period_yyyymm": period}


# ════════════════════════════════════════════════════════════════
# 账单 (只读 + 申请付款)
# ════════════════════════════════════════════════════════════════
@router.get("/invoices")
def my_invoices(
    status: Optional[str] = Query(None, description="filter: draft/issued/paid/cancelled"),
    period_yyyymm: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}$"),
    business_type: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    me: Account = Depends(get_current_account),
    s: Session = Depends(get_session),
) -> dict:
    """我的账单列表 · 自动 by account_id · 客户只看 issued + paid + cancelled (不显示 draft)"""
    items = billing_svc.list_invoices(
        s,
        account_id=me.id,
        status=status,
        period_yyyymm=period_yyyymm,
        business_type=business_type,
        limit=limit,
        offset=offset,
    )
    # 客户视角隐藏 draft (admin 仍在准备 · 不让客户先看到金额)
    if status is None:
        items = [it for it in items if it.get("status") != "draft"]
    return {"items": items, "count": len(items)}


@router.get("/invoices/{invoice_id}")
def my_invoice_detail(
    invoice_id: int,
    me: Account = Depends(get_current_account),
    s: Session = Depends(get_session),
) -> dict:
    """我的账单详情"""
    inv = billing_svc.get_invoice(s, invoice_id)
    if not inv or inv.get("account_id") != me.id:
        raise HTTPException(404, "账单不存在")
    # 客户也不能看 draft 账单
    if inv.get("status") == "draft":
        raise HTTPException(404, "账单不存在")
    return inv


@router.post("/invoices/{invoice_id}/request-payment")
def request_payment(
    invoice_id: int,
    body: dict = Body(default_factory=dict, description="{tx_ref, tx_method, note}"),
    me: Account = Depends(get_current_account),
    s: Session = Depends(get_session),
) -> dict:
    """申请付款 · 客户已链下转账 · 通知 admin 核对

    设计:
      - 不动 status (status=issued 仍是 issued · 等 admin 标 paid)
      - 写 we_business_invoices.notes · 记录 tx_ref + tx_method + 时间
      - 触发 audit 日志
    body:
      - tx_ref: str (转账流水号)
      - tx_method: str (bank_transfer / alipay / wechat / crypto)
      - note: str (附加备注)
    """
    inv = billing_svc.get_invoice(s, invoice_id)
    if not inv or inv.get("account_id") != me.id:
        raise HTTPException(404, "账单不存在")
    if inv.get("status") != "issued":
        raise HTTPException(400, f"仅 issued 账单可申请付款 · 当前 status={inv.get('status')}")

    tx_ref = (body.get("tx_ref") or "").strip()
    tx_method = (body.get("tx_method") or "bank_transfer").strip()
    note = (body.get("note") or "").strip()
    if not tx_ref:
        raise HTTPException(400, "tx_ref 必填")

    # 追加 note (不覆盖原 notes)
    now = datetime.utcnow()
    payment_note = (
        f"[REQ_PAYMENT@{now.isoformat()}] account={me.id} method={tx_method} "
        f"tx_ref={tx_ref} note={note}"
    )
    prev_notes = (inv.get("notes") or "").strip()
    merged = (prev_notes + "\n" + payment_note) if prev_notes else payment_note

    from platform_v8.storage.repo import business_invoices_t
    s.execute(
        business_invoices_t.update()
        .where(business_invoices_t.c.id == invoice_id)
        .values(notes=merged, updated_at=now)
    )
    s.commit()
    logger.info("my_business.request_payment · invoice=%s account=%s tx_ref=%s",
                invoice_id, me.id, tx_ref)
    return {"ok": True, "invoice_id": invoice_id, "tx_ref": tx_ref, "submitted_at": now.isoformat()}


# ════════════════════════════════════════════════════════════════
# 用量摘要
# ════════════════════════════════════════════════════════════════
@router.get("/usage")
def my_usage(
    period: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}$", description="默认本月"),
    me: Account = Depends(get_current_account),
    s: Session = Depends(get_session),
) -> dict:
    """当月用量摘要 · 跨业务汇总

    Returns:
        {
          "period_yyyymm": "2026-05",
          "contracts": [{business_type, contract_id, quota_bytes, used_bytes, exceeded, remaining_bytes}],
          "totals": {total_bytes, total_sessions, estimated_amount_edg}
        }
    """
    period = period or date.today().strftime("%Y-%m")
    # 列我所有 active 合约 (按 business_type 汇总配额)
    my_active = contracts_svc.list_contracts(s, account_id=me.id, status="active")

    contracts_usage = []
    total_bytes = 0
    total_sessions = 0
    estimated_amount = 0.0
    for c in my_active:
        bt = c.get("business_type", "ip_proxy")
        quota = contracts_svc.check_monthly_quota(s, account_id=me.id, business_type=bt)
        contracts_usage.append({
            "business_type": bt,
            "contract_id": c.get("id"),
            "contract_name": c.get("name"),
            "quota_bytes": quota.get("quota_bytes", 0),
            "used_bytes": quota.get("used_bytes", 0),
            "exceeded": quota.get("exceeded", False),
            "remaining_bytes": quota.get("remaining_bytes", -1),
            "price_per_gb_edg": c.get("price_per_gb_edg", 0),
        })
        total_bytes += int(quota.get("used_bytes", 0))
        # 估算金额 = used_GB × price
        if quota.get("used_bytes", 0) > 0:
            used_gb = float(quota["used_bytes"]) / (1024 * 1024 * 1024)
            estimated_amount += used_gb * float(c.get("price_per_gb_edg", 0))

    # session_count from we_proxy_sessions
    year, month = period.split("-")
    period_start = f"{int(year):04d}-{int(month):02d}-01"
    if int(month) == 12:
        period_end = f"{int(year) + 1:04d}-01-01"
    else:
        period_end = f"{int(year):04d}-{int(month) + 1:02d}-01"
    try:
        row = s.execute(text("""
            SELECT COUNT(*) FROM we_proxy_sessions
            WHERE client_id = :cid AND created_at >= :since AND created_at < :until
        """), {"cid": str(me.id), "since": period_start, "until": period_end}).first()
        total_sessions = int(row[0] if row and row[0] else 0)
    except Exception:
        total_sessions = 0

    return {
        "period_yyyymm": period,
        "contracts": contracts_usage,
        "totals": {
            "total_bytes": total_bytes,
            "total_sessions": total_sessions,
            "estimated_amount_edg": round(estimated_amount, 6),
        },
    }
