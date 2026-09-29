"""S3-T3 · 提现申请 workflow · 2026-06-07

替换 economy.py:139 的 withdraw_endpoint(直接扣 ledger 无审批 · 无打款)。

闭环:
  create_request  - 用户发起提现申请 (校验余额 · pending 状态 · 不扣 ledger)
  admin_approve   - admin 审批通过 (pending → approved · 仍不扣)
  admin_reject    - admin 拒绝 (pending → rejected · 不扣)
  mark_paid       - admin 打款完成回填(approved → paid · 此时扣 ledger WITHDRAW)
  cancel          - 用户撤销 (pending only)

KYC 简化版: kyc_status=pending 由 admin 在 approve 时手工签字升级为 verified。
"""
from __future__ import annotations
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.services.economy import ledger as ledger_svc
from platform_v8.services.economy import balance as balance_svc

logger = logging.getLogger(__name__)


# 收款方式 (payee_info.kind 白名单)
_PAYEE_KIND_WHITELIST = {"alipay", "wechat", "bank", "usdt"}

# 单笔限额(可后续从 we_kv 读)
_MAX_AMOUNT = Decimal("100000")  # 单笔最高 10 万
_MIN_AMOUNT = Decimal("100")     # 单笔最低 100


class WithdrawError(Exception):
    pass


@dataclass
class CreateRequestInput:
    account_id: int
    amount: Decimal
    payee_info: dict   # {kind, account_no, bank_name?, holder_name, ...}
    remark: str = ""
    client_ip: Optional[str] = None


@dataclass
class WithdrawRequest:
    id: int
    request_no: str
    account_id: int
    amount: Decimal
    currency: str
    payee_info: dict
    status: str
    reviewed_by: Optional[int]
    reviewed_at: Optional[datetime]
    review_note: str
    paid_tx_id: Optional[str]
    paid_at: Optional[datetime]
    ledger_id: Optional[str]
    kyc_status: str
    remark: str
    created_at: datetime
    updated_at: datetime


def _row_to_req(row) -> WithdrawRequest:
    pi = row.payee_info if isinstance(row.payee_info, dict) else {}
    return WithdrawRequest(
        id=row.id, request_no=row.request_no, account_id=row.account_id,
        amount=row.amount, currency=row.currency, payee_info=pi,
        status=row.status, reviewed_by=row.reviewed_by, reviewed_at=row.reviewed_at,
        review_note=row.review_note or "", paid_tx_id=row.paid_tx_id,
        paid_at=row.paid_at, ledger_id=str(row.ledger_id) if row.ledger_id else None,
        kyc_status=row.kyc_status, remark=row.remark or "",
        created_at=row.created_at, updated_at=row.updated_at,
    )


def _validate_payee(payee: dict):
    if not isinstance(payee, dict):
        raise WithdrawError("payee_info 必须是 dict")
    kind = (payee.get("kind") or "").lower()
    if kind not in _PAYEE_KIND_WHITELIST:
        raise WithdrawError(f"payee_info.kind 不支持 · 白名单: {sorted(_PAYEE_KIND_WHITELIST)}")
    if not payee.get("account_no"):
        raise WithdrawError("payee_info.account_no 必填")
    if not payee.get("holder_name"):
        raise WithdrawError("payee_info.holder_name 必填(实名校验)")
    if kind == "bank" and not payee.get("bank_name"):
        raise WithdrawError("银行卡提现必须填 bank_name")


def create_request(s: Session, inp: CreateRequestInput) -> WithdrawRequest:
    """用户发起提现申请 · 不扣 ledger · 仅冻结意向"""
    if inp.amount < _MIN_AMOUNT:
        raise WithdrawError(f"单笔最低 ¥{_MIN_AMOUNT}")
    if inp.amount > _MAX_AMOUNT:
        raise WithdrawError(f"单笔最高 ¥{_MAX_AMOUNT}")
    _validate_payee(inp.payee_info)

    # 余额校验(仅意向性 · 真扣 ledger 在 mark_paid)
    balance = balance_svc.get_balance(s, inp.account_id)
    if Decimal(str(balance)) < inp.amount:
        raise WithdrawError(f"余额不足 · 当前 ¥{balance} · 申请 ¥{inp.amount}")

    # 同一账户限制并行 pending+approved 不超过 3 个 (防刷)
    pending_count = s.execute(text("""
        SELECT COUNT(*) FROM we_withdraw_requests
         WHERE account_id = :aid AND status IN ('pending','approved')
    """), {"aid": inp.account_id}).scalar()
    if int(pending_count or 0) >= 3:
        raise WithdrawError("已有 3 个待处理提现 · 请等审批完成")

    now = datetime.now(timezone.utc)
    request_no = f"WD_{int(now.timestamp())}_{uuid.uuid4().hex[:8].upper()}"

    import json as _json
    s.execute(text("""
        INSERT INTO we_withdraw_requests
          (request_no, account_id, amount, currency, payee_info,
           remark, client_ip, created_at, updated_at)
        VALUES (:no, :aid, :amt, 'CNY', CAST(:pi AS jsonb),
                :rm, CAST(:ip AS inet), :now, :now)
    """), {
        "no": request_no, "aid": inp.account_id, "amt": inp.amount,
        "pi": _json.dumps(inp.payee_info), "rm": inp.remark or "",
        "ip": inp.client_ip, "now": now,
    })
    s.commit()

    row = s.execute(text("SELECT * FROM we_withdraw_requests WHERE request_no = :no"),
                    {"no": request_no}).fetchone()
    logger.info("withdraw.create · #%s account=%s amount=%s", request_no, inp.account_id, inp.amount)
    return _row_to_req(row)


def admin_approve(s: Session, request_no: str, admin_id: int, note: str = "") -> WithdrawRequest:
    row = s.execute(text("SELECT * FROM we_withdraw_requests WHERE request_no = :no FOR UPDATE"),
                    {"no": request_no}).fetchone()
    if row is None:
        raise WithdrawError("申请不存在")
    if row.status != "pending":
        raise WithdrawError(f"状态 {row.status} 不可 approve")

    now = datetime.now(timezone.utc)
    s.execute(text("""
        UPDATE we_withdraw_requests
           SET status='approved', kyc_status='verified',
               reviewed_by=:aid, reviewed_at=:now, review_note=:note, updated_at=:now
         WHERE request_no=:no
    """), {"aid": admin_id, "now": now, "note": note[:500], "no": request_no})
    s.commit()
    row2 = s.execute(text("SELECT * FROM we_withdraw_requests WHERE request_no=:no"),
                     {"no": request_no}).fetchone()
    logger.info("withdraw.approve · #%s by admin=%s", request_no, admin_id)
    return _row_to_req(row2)


def admin_reject(s: Session, request_no: str, admin_id: int, note: str) -> WithdrawRequest:
    row = s.execute(text("SELECT * FROM we_withdraw_requests WHERE request_no=:no FOR UPDATE"),
                    {"no": request_no}).fetchone()
    if row is None:
        raise WithdrawError("申请不存在")
    if row.status not in ("pending", "approved"):
        raise WithdrawError(f"状态 {row.status} 不可 reject")
    now = datetime.now(timezone.utc)
    s.execute(text("""
        UPDATE we_withdraw_requests
           SET status='rejected', reviewed_by=:aid, reviewed_at=:now,
               review_note=:note, updated_at=:now
         WHERE request_no=:no
    """), {"aid": admin_id, "now": now, "note": note[:500], "no": request_no})
    s.commit()
    row2 = s.execute(text("SELECT * FROM we_withdraw_requests WHERE request_no=:no"),
                     {"no": request_no}).fetchone()
    return _row_to_req(row2)


def mark_paid(s: Session, request_no: str, paid_tx_id: str, admin_id: int) -> WithdrawRequest:
    """Record an already confirmed payout with one atomic debit.

    This account lock coordinates with payment.mark_paid, but does not reserve
    funds before an external/manual payout. It is not an automated payout rail.
    """
    try:
        if not paid_tx_id or not paid_tx_id.strip() or len(paid_tx_id) > 128:
            raise WithdrawError("打款流水号必填且不能超过 128 字符")
        row = s.execute(text("SELECT * FROM we_withdraw_requests WHERE request_no=:no FOR UPDATE"),
                        {"no": request_no}).fetchone()
        if row is None:
            raise WithdrawError("申请不存在")
        if row.status == "paid":
            if row.paid_tx_id != paid_tx_id:
                raise WithdrawError("已完成提现的打款流水不一致")
            s.commit()
            return _row_to_req(row)
        if row.status != "approved":
            raise WithdrawError(f"状态 {row.status} 不可 mark_paid (必须 approved)")
        # Match the recharge lock order: request/order row, then account row.
        account = s.execute(text("SELECT id FROM we_accounts WHERE id = :id FOR UPDATE"),
                            {"id": row.account_id}).first()
        if not account:
            raise WithdrawError("账户不存在")
        key = f"withdraw:{request_no}"
        existing = s.execute(text("SELECT * FROM we_ledger WHERE idempotent_key = :key"),
                             {"key": key}).first()
        if existing is not None:
            if (existing.account_id != row.account_id or existing.amount != -row.amount
                    or existing.currency != row.currency or existing.type != "WITHDRAW"):
                raise WithdrawError("已有账本记录与提现申请不一致")
            ledger_id = existing.id
        else:
            ledger_svc.withdraw(s, account_id=row.account_id, amount=row.amount,
                                idempotent_key=key, note=f"提现 · tx={paid_tx_id[:32]}")
            ledger_id = s.execute(text("SELECT id FROM we_ledger WHERE idempotent_key = :key"),
                                  {"key": key}).scalar_one()
        now = datetime.now(timezone.utc)
        s.execute(text("""
            UPDATE we_withdraw_requests SET status='paid', paid_tx_id=:tx, paid_at=:now,
                   ledger_id=:lid, updated_at=:now WHERE request_no=:no
        """), {"tx": paid_tx_id, "now": now, "lid": ledger_id, "no": request_no})
        s.commit()
    except WithdrawError:
        s.rollback()
        raise
    except ValueError:
        s.rollback()
        raise WithdrawError("余额不足，未记账；请先核查实际打款与账户余额") from None
    except Exception:
        s.rollback()
        logger.exception("withdraw.mark_paid failed for request %s", request_no)
        raise WithdrawError("提现记账未完成，请核查原申请，不要重复打款") from None
    result = get_request(s, request_no)
    logger.info("withdraw.paid · #%s by admin=%s amount=%s", request_no, admin_id, row.amount)
    return result


def get_request(s: Session, request_no: str) -> Optional[WithdrawRequest]:
    row = s.execute(text("SELECT * FROM we_withdraw_requests WHERE request_no=:no"),
                    {"no": request_no}).fetchone()
    return _row_to_req(row) if row else None


def list_my_requests(s: Session, account_id: int, limit: int = 30) -> list[WithdrawRequest]:
    rows = s.execute(text("""
        SELECT * FROM we_withdraw_requests
         WHERE account_id=:aid ORDER BY created_at DESC LIMIT :lim
    """), {"aid": account_id, "lim": limit}).fetchall()
    return [_row_to_req(r) for r in rows]


def list_admin_pending(s: Session, limit: int = 50) -> list[WithdrawRequest]:
    rows = s.execute(text("""
        SELECT * FROM we_withdraw_requests
         WHERE status IN ('pending','approved')
         ORDER BY created_at ASC LIMIT :lim
    """), {"lim": limit}).fetchall()
    return [_row_to_req(r) for r in rows]
