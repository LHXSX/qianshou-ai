"""S3-T2 · 充值订单 service · 2026-06-07

闭环:
  create_order  - 用户发起充值 (任意 gateway · pending 订单 · 15 分钟过期)
  mark_paid     - 真实支付回调 / admin 手工确认 → 入账 DEPOSIT ledger
  expire_pending_orders - 由独立 expire_orders CLI / systemd timer 调用

支付通道:
  - admin_manual: 用户提请求 → admin 后台 mark_paid (零成本起步)
  - wechat_pay/alipay: 通道验签后传 PaymentCallback；本服务核对订单并原子记账
  - bank_transfer: 用户填对公转账流水号 → admin 核对 → mark_paid
"""
from __future__ import annotations
import logging
import hashlib
import json
import re
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.services.economy import ledger as ledger_svc
from .common import PaymentCallback, account_binding, cny_amount, PaymentVerificationError

logger = logging.getLogger(__name__)


# ── 白名单 gateway ──
_GATEWAY_WHITELIST = {"admin_manual", "wechat_pay", "alipay", "bank_transfer", "usdt"}


class PaymentError(Exception):
    pass


class PaymentIdempotencyConflict(PaymentError):
    """The same account reused one checkout key for different order inputs."""


@dataclass
class CreateOrderInput:
    account_id: int
    amount: Decimal
    gateway: str = "admin_manual"
    remark: str = ""
    client_ip: Optional[str] = None
    user_agent: Optional[str] = None
    notify_url: Optional[str] = None
    return_url: Optional[str] = None
    idempotency_key: Optional[str] = None


@dataclass
class PaymentOrder:
    id: int
    order_no: str
    account_id: int
    amount: Decimal
    currency: str
    gateway: str
    status: str
    gateway_order_id: Optional[str]
    gateway_tx_id: Optional[str]
    ledger_id: Optional[str]
    created_at: datetime
    paid_at: Optional[datetime]
    expired_at: Optional[datetime]
    remark: str
    return_url: Optional[str] = None
    reused: bool = False


def _row_to_order(row) -> PaymentOrder:
    return PaymentOrder(
        id=row.id, order_no=row.order_no, account_id=row.account_id,
        amount=row.amount, currency=row.currency, gateway=row.gateway,
        status=row.status, gateway_order_id=row.gateway_order_id,
        gateway_tx_id=row.gateway_tx_id,
        ledger_id=str(row.ledger_id) if row.ledger_id else None,
        created_at=row.created_at, paid_at=row.paid_at,
        expired_at=row.expired_at, remark=row.remark or "",
        return_url=row.return_url,
    )


def _checkout_fingerprint(inp: CreateOrderInput) -> tuple[str | None, str | None]:
    key = inp.idempotency_key
    if key is None:
        return None, None
    if inp.gateway not in ("wechat_pay", "alipay"):
        raise PaymentError("幂等键仅适用于线上充值")
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", key):
        raise PaymentError("无效充值幂等键")
    try:
        amount = cny_amount(inp.amount)
    except PaymentVerificationError as exc:
        raise PaymentError(str(exc)) from exc
    request = {"amount": format(amount, ".2f"),
               "gateway": inp.gateway, "remark": inp.remark or ""}
    fingerprint = hashlib.sha256(json.dumps(
        request, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")).hexdigest()
    return key, fingerprint


def _find_locked_checkout(s: Session, inp: CreateOrderInput,
                          key: str, fingerprint: str) -> PaymentOrder | None:
    # Transaction lock serializes simultaneous account/key requests. The DB
    # unique index is an independent last line of defence.
    lock_id = int.from_bytes(hashlib.sha256(
        f"recharge:{inp.account_id}:{key}".encode("utf-8")
    ).digest()[:8], "big", signed=True)
    s.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_id})
    existing = s.execute(text("""
        SELECT * FROM we_payment_orders
         WHERE account_id = :aid AND client_idempotency_key = :key
    """), {"aid": inp.account_id, "key": key}).fetchone()
    if existing is None:
        return None
    if existing.request_fingerprint != fingerprint:
        s.rollback()
        raise PaymentIdempotencyConflict("该充值请求标识已用于不同金额、通道或备注")
    s.commit()
    return replace(_row_to_order(existing), reused=True)


def find_idempotent_order(s: Session, inp: CreateOrderInput) -> PaymentOrder | None:
    """Recover an existing checkout even if its provider config is now offline."""
    key, fingerprint = _checkout_fingerprint(inp)
    if key is None:
        return None
    found = _find_locked_checkout(s, inp, key, fingerprint)
    if found is None:
        s.commit()  # release the lookup lock before checking channel readiness
    return found


def create_order(s: Session, inp: CreateOrderInput) -> PaymentOrder:
    """创建充值订单 · 返回 pending 订单"""
    if not inp.amount.is_finite() or inp.amount <= 0:
        raise PaymentError("amount 必须 > 0")
    if inp.gateway not in _GATEWAY_WHITELIST:
        raise PaymentError(f"非法 gateway · 白名单: {sorted(_GATEWAY_WHITELIST)}")
    if inp.gateway in ("wechat_pay", "alipay"):
        try:
            cny_amount(inp.amount)
        except PaymentVerificationError as exc:
            raise PaymentError(str(exc)) from exc
    key, fingerprint = _checkout_fingerprint(inp)
    if key is not None:
        found = _find_locked_checkout(s, inp, key, fingerprint)
        if found is not None:
            return found

    now = datetime.now(timezone.utc)
    expired = now + timedelta(minutes=15)
    order_no = f"PAY_{int(now.timestamp())}_{uuid.uuid4().hex[:8].upper()}"

    s.execute(text("""
        INSERT INTO we_payment_orders
          (order_no, account_id, amount, currency, gateway,
           notify_url, return_url, client_ip, user_agent, remark,
           client_idempotency_key, request_fingerprint,
           created_at, expired_at, updated_at)
        VALUES (:no, :aid, :amt, 'CNY', :gw,
                :nu, :ru, CAST(:ip AS inet), :ua, :rm, :ik, :fp,
                :now, :exp, :now)
    """), {
        "no": order_no, "aid": inp.account_id, "amt": inp.amount, "gw": inp.gateway,
        "nu": inp.notify_url, "ru": inp.return_url,
        "ip": inp.client_ip, "ua": inp.user_agent, "rm": inp.remark or "",
        "ik": key, "fp": fingerprint,
        "now": now, "exp": expired,
    })
    s.commit()

    row = s.execute(text("SELECT * FROM we_payment_orders WHERE order_no = :no"),
                    {"no": order_no}).fetchone()
    logger.info("payment.create_order · #%s account=%s amount=%s gw=%s",
                order_no, inp.account_id, inp.amount, inp.gateway)
    return _row_to_order(row)


def mark_paid(s: Session, order_no: str, gateway_tx_id: str,
              actor: str = "system", *, verified: PaymentCallback | None = None) -> PaymentOrder:
    """Atomically credit an order; only verified online callbacks may credit online orders.

    PostgreSQL transaction locks serialize the same transaction across orders and
    the same account across these payment writers. Other ledger writers retain
    their existing concurrency policy; this is not a global ledger repair.
    """
    try:
        if not gateway_tx_id or len(gateway_tx_id) > 128 or any(ord(c) < 32 for c in gateway_tx_id):
            raise PaymentError("无效支付流水")
        if verified:
            if verified.gateway not in ("wechat_pay", "alipay"):
                raise PaymentError("无效线上支付通道")
            lock_id = int.from_bytes(hashlib.sha256(
                f"payment:{verified.gateway}:{gateway_tx_id}".encode()).digest()[:8], "big", signed=True)
            s.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_id})
        row = s.execute(text("SELECT * FROM we_payment_orders WHERE order_no = :no FOR UPDATE"),
                        {"no": order_no}).fetchone()
        if row is None:
            raise PaymentError("订单不存在")
        online = row.gateway in ("wechat_pay", "alipay")
        if online:
            if (verified is None or verified.order_no != row.order_no
                    or verified.gateway != row.gateway or verified.gateway_tx_id != gateway_tx_id
                    or verified.amount != row.amount or verified.currency != row.currency
                    or verified.account_binding != account_binding(row.account_id)):
                raise PaymentError("支付订单、账户、金额、币种或通道不一致")
            used = s.execute(text("""
                SELECT order_no FROM we_payment_orders
                 WHERE gateway = :gw AND gateway_tx_id = :tx AND order_no <> :no LIMIT 1
            """), {"gw": row.gateway, "tx": gateway_tx_id, "no": order_no}).first()
            if used:
                raise PaymentError("支付流水已关联其他订单")
        elif verified is not None:
            raise PaymentError("回调不可确认手工订单")
        if row.status == "paid":
            if row.gateway_tx_id != gateway_tx_id:
                raise PaymentError("已支付订单的流水不一致")
            s.commit()
            return _row_to_order(row)
        # Local timeout is not proof of nonpayment. A verified successful payment
        # can arrive after expiry; never silently lose that confirmed deposit.
        if row.status != "pending" and not (online and row.status == "expired"):
            raise PaymentError(f"订单状态 {row.status} 不允许标记 paid")
        if row.gateway_tx_id and row.gateway_tx_id != gateway_tx_id:
            raise PaymentError("订单已有不同支付流水")
        account = s.execute(text("SELECT id FROM we_accounts WHERE id = :id FOR UPDATE"),
                            {"id": row.account_id}).first()
        if not account:
            raise PaymentError("账户不存在")
        key = f"payment:{order_no}"
        prior = s.execute(text("SELECT * FROM we_ledger WHERE idempotent_key = :key"), {"key": key}).first()
        if prior and (prior.account_id != row.account_id or prior.amount != row.amount
                      or prior.currency != row.currency or prior.type != "DEPOSIT"):
            raise PaymentError("已有账本记录与订单不一致")
        ledger_svc.deposit(s, account_id=row.account_id, amount=row.amount, idempotent_key=key,
                           note=f"充值 · {row.gateway} · tx={gateway_tx_id[:32]}")
        # The existing deposit helper returns a newly allocated dataclass on an
        # idempotency conflict. Read the persisted ID rather than linking a ghost.
        ledger_id = s.execute(text("SELECT id FROM we_ledger WHERE idempotent_key = :key"),
                              {"key": key}).scalar_one()
        now = datetime.now(timezone.utc)
        s.execute(text("""
            UPDATE we_payment_orders SET status = 'paid', gateway_tx_id = :tx,
                   ledger_id = :lid, paid_at = :now, updated_at = :now WHERE order_no = :no
        """), {"no": order_no, "tx": gateway_tx_id, "lid": ledger_id, "now": now})
        if online:
            from platform_v8.storage.repo import AuditRepo
            AuditRepo.write(s, action="payment.callback.paid", actor_kind="system",
                            target_kind="payment_order", target_id=order_no,
                            detail={"gateway": row.gateway, "account_id": row.account_id,
                                    "amount": str(row.amount), "currency": row.currency})
        s.commit()
    except PaymentError:
        s.rollback()
        raise
    except Exception:
        s.rollback()
        logger.exception("payment.mark_paid failed for order %s", order_no)
        raise PaymentError("入账未完成，请重试原订单") from None
    result = get_order(s, order_no)
    logger.info("payment.mark_paid · #%s actor=%s", order_no, actor)
    return result


def list_admin_orders(s: Session, *, limit: int = 30, offset: int = 0,
                      account_id: int | None = None, status: str | None = None,
                      gateway: str | None = None) -> tuple[list[PaymentOrder], int]:
    if not 1 <= limit <= 100 or offset < 0 or (account_id is not None and account_id <= 0):
        raise PaymentError("无效分页或账号")
    if gateway is not None and gateway not in _GATEWAY_WHITELIST:
        raise PaymentError("无效支付通道")
    if status is not None and status not in {"pending", "paid", "failed", "cancelled", "refunded", "expired"}:
        raise PaymentError("无效订单状态")
    filters, params = [], {"lim": limit, "off": offset}
    for name, value in (("account_id", account_id), ("status", status), ("gateway", gateway)):
        if value is not None:
            filters.append(f"{name} = :{name}")
            params[name] = value
    where = " WHERE " + " AND ".join(filters) if filters else ""
    rows = s.execute(text("SELECT * FROM we_payment_orders" + where +
                          " ORDER BY created_at DESC, id DESC LIMIT :lim OFFSET :off"), params).all()
    total = s.execute(text("SELECT COUNT(*) FROM we_payment_orders" + where), params).scalar_one()
    return [_row_to_order(row) for row in rows], int(total)


def get_order(s: Session, order_no: str) -> Optional[PaymentOrder]:
    row = s.execute(text("SELECT * FROM we_payment_orders WHERE order_no = :no"),
                    {"no": order_no}).fetchone()
    return _row_to_order(row) if row else None


def list_orders(s: Session, account_id: int, limit: int = 30) -> list[PaymentOrder]:
    rows = s.execute(text("""
        SELECT * FROM we_payment_orders
         WHERE account_id = :aid
         ORDER BY created_at DESC
         LIMIT :lim
    """), {"aid": account_id, "lim": limit}).fetchall()
    return [_row_to_order(r) for r in rows]


def list_reconcilable_orders(s: Session, gateway: str, *, limit: int = 200) -> list[PaymentOrder]:
    """Recent orders for one online gateway, newest first, for provider reconciliation."""
    if gateway not in ("wechat_pay", "alipay"):
        raise PaymentError("无效线上支付通道")
    if not 1 <= limit <= 1000:
        raise PaymentError("无效分页")
    rows = s.execute(text("""
        SELECT * FROM we_payment_orders
         WHERE gateway = :gw
         ORDER BY created_at DESC, id DESC
         LIMIT :lim
    """), {"gw": gateway, "lim": limit}).fetchall()
    return [_row_to_order(row) for row in rows]


def expire_pending_orders(s: Session) -> int:
    """Mark local timeout; preserve order/idempotency keys for delayed callbacks."""
    now = datetime.now(timezone.utc)
    result = s.execute(text("""
        UPDATE we_payment_orders
           SET status = 'expired', updated_at = :now
         WHERE status = 'pending' AND expired_at < :now
    """), {"now": now})
    s.commit()
    if result.rowcount:
        logger.info("payment.sweeper · 标记 %d 个过期订单", result.rowcount)
    return result.rowcount
