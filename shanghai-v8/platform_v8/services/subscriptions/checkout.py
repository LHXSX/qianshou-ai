"""CNY subscription payments commit one debit and a recoverable outbox before fulfilment."""
from __future__ import annotations
import base64
import hashlib
import json
import re
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal, ROUND_FLOOR
from sqlalchemy import select, update, func
from sqlalchemy.orm import Session
from platform_v8.core import LedgerEntry, LedgerType
from platform_v8.storage.repo import accounts_t, ledger_t, LedgerRepo, AuditRepo
from .schema import quotes_t, orders_t
from .gateway import Gateway, GatewayError

class CheckoutError(Exception):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code); self.code = code; self.status = status


def _now() -> int:
    return int(time.time() * 1000)


def _iso(value: int) -> str:
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat().replace('+00:00', 'Z')


def _balance(s: Session, account_id: int) -> Decimal:
    value = s.execute(select(func.coalesce(func.sum(ledger_t.c.amount), 0)).where(
        ledger_t.c.account_id == account_id, ledger_t.c.currency == 'CNY')).scalar_one()
    return Decimal(str(value))


def wallet(s: Session, account_id: int, amount_fen: int | None = None) -> dict:
    """Return spendable whole-fen CNY from the ledger; no SP or cached account balance."""
    fen = int((_balance(s, account_id) * 100).to_integral_value(rounding=ROUND_FLOOR))
    result = {'currency': 'CNY', 'balanceFen': fen, 'balanceYuan': f'{Decimal(fen) / 100:.2f}'}
    if amount_fen is not None:
        result.update(shortfallFen=max(0, amount_fen - fen), canPay=fen >= amount_fen)
    return result


def _public_quote(q: dict) -> dict:
    return {k: q[k] for k in ('quoteId', 'accountId', 'tier', 'label', 'months', 'currency', 'amountFen', 'monthlySp')} | {
        'amountYuan': f"{Decimal(q['amountFen']) / 100:.2f}", 'expiresAt': _iso(q['expiresAt'])}


def _valid_quote(result: dict, account_id: int, tier: str, months: int, at: int) -> tuple[dict, str]:
    q, ticket = result.get('quote'), result.get('ticket')
    if not isinstance(q, dict) or not isinstance(ticket, str) or len(ticket) > 8192:
        raise CheckoutError('gateway_response_invalid', 503)
    try:
        payload, _ = ticket.split('.')
        embedded = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        valid = embedded == q and q.get('version') == 1 and re.fullmatch(r'[A-Za-z0-9_-]{1,96}', q['quoteId']) \
            and q['accountId'] == str(account_id) and q['tier'] == tier and q['months'] == months \
            and q['currency'] == 'CNY' and type(q['amountFen']) is int and 0 < q['amountFen'] <= 100_000_000 \
            and type(q['issuedAt']) is int and type(q['expiresAt']) is int \
            and q['issuedAt'] <= at + 30_000 and at < q['expiresAt'] \
            and q['expiresAt'] - q['issuedAt'] == 300_000 \
            and isinstance(q['label'], str) and 0 < len(q['label']) <= 80 \
            and type(q['monthlySp']) in (int, float) and 0 <= q['monthlySp'] < 1e12 \
            and re.fullmatch('[0-9a-f]{64}', q['termsHash'])
    except (KeyError, TypeError, ValueError):
        valid = False
    if not valid: raise CheckoutError('gateway_response_invalid', 503)
    return q, ticket


def create_quote(s: Session, gateway: Gateway, account_id: int, tier: str, months: int) -> dict:
    """Ask the authoritative tier catalog, then persist its signed account-bound quote."""
    if tier not in ('basic', 'plus', 'max') or type(months) is not int or not 1 <= months <= 12:
        raise CheckoutError('invalid_request', 400)
    s.commit()  # Authentication/read transactions must not hold connections during HTTP.
    result = gateway.call('quote', {'accountId': str(account_id), 'tier': tier, 'months': months})
    at = _now(); q, ticket = _valid_quote(result, account_id, tier, months, at)
    try:
        s.execute(quotes_t.insert().values(quote_id=q['quoteId'], account_id=account_id,
            payload=q, ticket=ticket, expires_at=q['expiresAt'], created_at=at))
        AuditRepo.write(s, action='subscription.quote', actor_account_id=account_id,
            target_kind='subscription', target_id=q['quoteId'], detail={'tier': tier,
                'months': months, 'currency': 'CNY', 'amountFen': q['amountFen'], 'termsHash': q['termsHash']})
        s.commit()
    except Exception:
        s.rollback(); raise
    return {'ok': True, 'quote': _public_quote(q), 'wallet': wallet(s, account_id, q['amountFen'])}


def _order(s: Session, account_id: int, order_id: str) -> dict:
    row = s.execute(select(orders_t).where(orders_t.c.account_id == account_id,
        orders_t.c.order_id == order_id)).mappings().one_or_none()
    if row is None: raise CheckoutError('order_not_found', 404)
    return dict(row)


def _public_order(order: dict) -> dict:
    result = {'orderId': order['order_id'], 'quoteId': order['quote_id'], 'accountId': str(order['account_id']),
        'tier': order['tier'], 'months': order['months'], 'currency': 'CNY',
        'amountFen': order['amount_fen'], 'amountYuan': f"{Decimal(order['amount_fen']) / 100:.2f}",
        'status': order['status'], 'paymentStatus': 'paid', 'paidAt': _iso(order['paid_at']),
        'canRetry': order['status'] == 'fulfilling'}
    if order['subscription'] is not None: result['subscription'] = order['subscription']
    return result


def _response(s: Session, account_id: int, order_id: str) -> dict:
    order = _order(s, account_id, order_id)
    return {'ok': True, 'order': _public_order(order), 'wallet': wallet(s, account_id, order['amount_fen'])}


def _receipt(order: dict, quote: dict) -> dict:
    return {'orderId': order['order_id'], 'accountId': str(order['account_id']), 'ticket': quote['ticket'],
        'paidAt': order['paid_at'], 'currency': 'CNY', 'amountFen': order['amount_fen']}


def _subscription(result: dict, order: dict) -> dict:
    sub = result.get('subscription')
    if result.get('ok') is not True or result.get('status') != 'fulfilled' \
        or result.get('orderId') != order['order_id'] or result.get('quoteId') != order['quote_id'] \
        or result.get('accountId') != str(order['account_id']) or result.get('currency') != 'CNY' \
        or result.get('amountFen') != order['amount_fen'] or not isinstance(sub, dict) \
        or sub.get('tier') != order['tier'] or type(sub.get('from')) is not int or type(sub.get('to')) is not int \
        or sub['from'] <= 0 or sub['to'] <= sub['from']:
        raise GatewayError('gateway_response_invalid')
    return {k: sub[k] for k in ('tier', 'from', 'to')}


def reconcile(s: Session, gateway: Gateway, account_id: int, order_id: str, *, allow_fulfil: bool) -> dict:
    """Recover a lost receipt by order identity; retries can never enter the debit transaction."""
    order = _order(s, account_id, order_id)
    if order['status'] == 'fulfilled': return _response(s, account_id, order_id)
    allow_fulfil = allow_fulfil and order['status'] == 'fulfilling'
    quote = dict(s.execute(select(quotes_t).where(quotes_t.c.quote_id == order['quote_id'])).mappings().one())
    s.execute(update(orders_t).where(orders_t.c.order_id == order_id).values(
        attempts=orders_t.c.attempts + 1, updated_at=_now()))
    s.commit()  # Durable paid order/outbox exists before either query or fulfil HTTP.
    sub = None; failure = None
    try:
        try:
            result = gateway.call('query', _receipt(order, quote))
        except GatewayError as exc:
            if exc.code != 'order_not_fulfilled' or exc.status != 404 or not allow_fulfil:
                raise
            result = gateway.call('fulfil', _receipt(order, quote))
        sub = _subscription(result, order)
    except GatewayError as exc:
        failure = exc.code
    try:
        # A late failing request cannot overwrite another request's successful fulfilment.
        current = s.execute(select(orders_t).where(orders_t.c.order_id == order_id)
                            .with_for_update()).mappings().one()
        if current['status'] != 'fulfilled':
            status = 'fulfilled' if sub else ('requires-review' if current['status'] == 'requires-review' or failure in (
                'order_conflict', 'payment_quote_mismatch', 'downgrade-not-allowed', 'already-subscribed',
                'gateway_response_invalid', 'quote_terms_changed') else 'fulfilling')
            s.execute(update(orders_t).where(orders_t.c.order_id == order_id).values(
                status=status, subscription=sub, last_error=failure, updated_at=_now()))
            AuditRepo.write(s, action='subscription.fulfilment', actor_account_id=account_id,
                actor_kind='system', target_kind='subscription', target_id=order_id,
                detail={'status': status, 'code': failure})
        s.commit()
    except Exception:
        s.rollback(); raise
    return _response(s, account_id, order_id)


def purchase(s: Session, gateway: Gateway, account_id: int, quote_id: str, key: str) -> dict:
    """Serialize by account; debit, immutable quote, order and audit commit atomically."""
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', quote_id) or not re.fullmatch(r'[A-Za-z0-9_-]{16,96}', key):
        raise CheckoutError('invalid_request', 400)
    if s.get_bind().dialect.name != 'postgresql':
        raise CheckoutError('checkout_storage_unavailable', 503)
    digest = hashlib.sha256(json.dumps([account_id, quote_id], separators=(',', ':')).encode()).hexdigest()
    try:
        account = s.execute(select(accounts_t).where(accounts_t.c.id == account_id).with_for_update()).mappings().one_or_none()
        if not account or account['status'] != 'active': raise CheckoutError('account_unavailable', 403)
        existing = s.execute(select(orders_t).where(orders_t.c.account_id == account_id,
            orders_t.c.idempotency_key == key)).mappings().one_or_none()
        if existing:
            if existing['request_hash'] != digest: raise CheckoutError('idempotency_conflict')
            order_id = existing['order_id']; s.commit()
        else:
            quote = s.execute(select(quotes_t).where(quotes_t.c.quote_id == quote_id,
                quotes_t.c.account_id == account_id)).mappings().one_or_none()
            if quote is None: raise CheckoutError('quote_not_found', 404)
            if s.execute(select(orders_t.c.order_id).where(orders_t.c.quote_id == quote_id)).first():
                raise CheckoutError('quote_already_paid')
            at = _now()
            if at >= quote['expires_at']: raise CheckoutError('quote_expired')
            q = quote['payload']
            if at < q['issuedAt']: raise CheckoutError('checkout_clock_skew', 503)
            amount = Decimal(q['amountFen']) / 100
            balance = _balance(s, account_id)
            if s.execute(select(ledger_t.c.id).where(ledger_t.c.account_id == account_id,
                    ledger_t.c.currency != 'CNY').limit(1)).first():
                raise CheckoutError('wallet_currency_conflict', 503)
            if Decimal(str(account['balance'])) != balance:
                raise CheckoutError('wallet_reconciliation_required', 503)
            if balance < amount: raise CheckoutError('insufficient_balance', 402)
            order_id = str(uuid.uuid4())
            entry = LedgerEntry(account_id=account_id, type=LedgerType.SUBSCRIPTION_PURCHASE,
                amount=-amount, currency='CNY', idempotent_key='subscription:' + order_id,
                note='CNY subscription purchase', metadata={'orderId': order_id, 'quoteId': quote_id,
                    'tier': q['tier'], 'months': q['months'], 'amountFen': q['amountFen'],
                    'currency': 'CNY', 'termsHash': q['termsHash']})
            LedgerRepo.write(s, entry)
            s.execute(update(accounts_t).where(accounts_t.c.id == account_id).values(balance=balance - amount))
            s.execute(orders_t.insert().values(order_id=order_id, account_id=account_id,
                quote_id=quote_id, idempotency_key=key, request_hash=digest, amount_fen=q['amountFen'],
                currency='CNY', tier=q['tier'], months=q['months'], ledger_id=entry.id, paid_at=at,
                status='fulfilling', attempts=0, updated_at=at))
            AuditRepo.write(s, action='subscription.paid', actor_account_id=account_id,
                target_kind='subscription', target_id=order_id, detail={'quoteId': quote_id,
                    'ledgerId': entry.id, 'currency': 'CNY', 'amountFen': q['amountFen']})
            s.commit()
    except Exception:
        s.rollback(); raise
    return reconcile(s, gateway, account_id, order_id, allow_fulfil=True)


def get_order(s: Session, gateway: Gateway, account_id: int, order_id: str) -> dict:
    return reconcile(s, gateway, account_id, order_id, allow_fulfil=False)


def get_order_by_key(s: Session, gateway: Gateway, account_id: int, key: str) -> dict:
    order_id = s.execute(select(orders_t.c.order_id).where(orders_t.c.account_id == account_id,
        orders_t.c.idempotency_key == key)).scalar_one_or_none()
    if order_id is None: raise CheckoutError('order_not_found', 404)
    return get_order(s, gateway, account_id, order_id)
