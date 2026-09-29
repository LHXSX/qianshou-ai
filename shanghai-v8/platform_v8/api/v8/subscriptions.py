"""Verified JWT owners buy subscriptions with Shanghai CNY, never the legacy SP route."""
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session
from platform_v8.api.deps import get_session, get_current_account
from platform_v8.core import Account
from platform_v8.services.subscriptions import checkout
from platform_v8.services.subscriptions.gateway import configured_gateway, GatewayError

router = APIRouter(prefix='/api/v8/subscriptions', tags=['subscriptions'])

class QuoteRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    tier: Literal['basic', 'plus', 'max']
    months: int = Field(ge=1, le=12)

class PurchaseRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    quoteId: str = Field(pattern=r'^[A-Za-z0-9_-]{1,96}$')
    idempotencyKey: str = Field(pattern=r'^[A-Za-z0-9_-]{16,96}$')

class RetryRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

_MESSAGES = {
    'insufficient_balance': '人民币余额不足，请先充值。',
    'quote_expired': '价格确认已过期，请重新查看价格后确认。',
    'idempotency_conflict': '这次请求与原订单不一致，请查询原订单。',
    'quote_already_paid': '该价格确认已支付，请查看原订单。',
    'order_not_found': '未找到这笔订单。', 'quote_not_found': '未找到这次价格确认。',
    'wallet_reconciliation_required': '余额正在核对，请稍后再试。',
    'wallet_currency_conflict': '余额币种需要核对，请联系客服。',
    'downgrade-not-allowed': '当前订阅期间暂不支持降级。',
    'already-subscribed': '当前账号已拥有该订阅。',
}

def _owner(request: Request, account: Account = Depends(get_current_account)) -> Account:
    if getattr(request.state, 'auth_via', None) != 'jwt':
        raise HTTPException(403, detail={'code': 'jwt_required', 'message': '请使用账号登录后继续。'})
    return account


def _run(s: Session, fn, *, purchase: bool = False):
    try:
        value = fn()
        status = 202 if purchase and value['order']['status'] != 'fulfilled' else 200
        return JSONResponse(value, status_code=status, headers={'Cache-Control': 'no-store'})
    except (checkout.CheckoutError, GatewayError) as exc:
        s.rollback()
        # Transport auth/config problems are not user-token failures.
        status = exc.status if isinstance(exc, checkout.CheckoutError) else (409 if exc.status == 409 else 503)
        raise HTTPException(status, detail={'code': exc.code,
            'message': _MESSAGES.get(exc.code, '订阅服务暂时无法连接，请稍后再试。')}) from None


@router.get('/wallet')
def get_wallet(s: Session = Depends(get_session), account: Account = Depends(_owner)):
    return _run(s, lambda: {'ok': True, 'wallet': checkout.wallet(s, account.id)})


@router.post('/quote')
def quote(body: QuoteRequest, s: Session = Depends(get_session), account: Account = Depends(_owner)):
    return _run(s, lambda: checkout.create_quote(s, configured_gateway(), account.id, body.tier, body.months))


@router.post('/purchase')
def purchase(body: PurchaseRequest, s: Session = Depends(get_session), account: Account = Depends(_owner)):
    return _run(s, lambda: checkout.purchase(s, configured_gateway(), account.id, body.quoteId, body.idempotencyKey), purchase=True)


# Match the literal by-key route before the dynamic order ID route.
@router.get('/orders/by-key/{key}')
def by_key(key: str, s: Session = Depends(get_session), account: Account = Depends(_owner)):
    return _run(s, lambda: checkout.get_order_by_key(s, configured_gateway(), account.id, key))


@router.get('/orders/{order_id}')
def order(order_id: str, s: Session = Depends(get_session), account: Account = Depends(_owner)):
    return _run(s, lambda: checkout.get_order(s, configured_gateway(), account.id, order_id))


@router.post('/orders/{order_id}/retry')
def retry(order_id: str, body: RetryRequest, s: Session = Depends(get_session), account: Account = Depends(_owner)):
    return _run(s, lambda: checkout.reconcile(s, configured_gateway(), account.id, order_id, allow_fulfil=True), purchase=True)
