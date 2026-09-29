"""S3-T2 · 充值订单 API · /api/v8/payment

端点:
  POST   /payment/recharge          用户发起充值 (任意 gateway)
  GET    /payment/orders/{order_no} 查订单状态
  GET    /payment/orders            列我的充值历史
  POST   /admin/payment/confirm     admin 手工标 paid (admin_manual / bank_transfer 用)

本 router 接收公开回调；channel service 验签并校验商户/app，orders service
在同一事务内绑定订单/账户/金额后入账。扫码下单响应本身不能证明已付款。
"""
from __future__ import annotations
import logging
import ipaddress
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import Response, JSONResponse, PlainTextResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session, get_current_account, get_admin_account
from platform_v8.api.rate_limit import rate_limit
from platform_v8.core import Account
from platform_v8.services.payment import orders as orders_svc
from platform_v8.services.payment import withdraws as withdraws_svc
from platform_v8.services.payment import wechat_pay, alipay, config as payment_config
from platform_v8.services.payment.common import (
    PaymentConfigError, PaymentMerchantBindingError, PaymentVerificationError, PaymentRequestUnknown, cny_amount,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/payment", tags=["payment"])
admin_router = APIRouter(prefix="/api/v8/admin/payment", tags=["payment"])


def _client_ip(request: Request) -> str | None:
    """Recorded source address for the order audit trail.

    Our nginx proxy sets X-Real-IP to the true peer and overwrites whatever the
    caller sent. It does NOT set X-Forwarded-For, so honouring that header would
    let any caller forge the address we persist. Verified against the live
    /etc/nginx/sites-enabled/default: /api/ sets Host and X-Real-IP only.
    """
    value = request.headers.get("X-Real-IP") or (request.client.host if request.client else "")
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


# ──────────────────────────────────────────────────────
# 用户端
# ──────────────────────────────────────────────────────

class RechargeRequest(BaseModel):
    amount: Decimal = Field(..., gt=0, le=1_000_000)
    gateway: str = Field(default="admin_manual",
                         description="admin_manual / wechat_pay / alipay / bank_transfer / usdt")
    remark: str = Field(default="", max_length=500)
    idempotency_key: str | None = Field(
        default=None, min_length=1, max_length=128,
        description="可选；同一次线上充值重试时保持不变，换金额、通道或备注须使用新键",
    )


class OrderOut(BaseModel):
    order_no: str
    account_id: int
    amount: str
    currency: str
    gateway: str
    status: str
    gateway_order_id: str | None = None
    gateway_tx_id: str | None = None
    created_at: str
    paid_at: str | None = None
    expired_at: str | None = None
    remark: str = ""


class PaymentInstructions(BaseModel):
    mode: str
    code_url: str | None = None            # wechat_native
    qr_code: str | None = None             # alipay_precreate (signed-product fallback)
    action: str | None = None              # alipay_page: cashier endpoint to POST to
    method: str | None = None              # alipay_page: HTTP method for that POST
    params: dict[str, str] | None = None   # alipay_page: signed parameters (never HTML)


class RechargeOut(OrderOut):
    payment: PaymentInstructions | None = None
    reused_order: bool = False
    recovery: dict[str, str] | None = None


class RefreshedOrderOut(OrderOut):
    provider_state: str | None = None


class AdminOrderOut(OrderOut):
    ledger_id: str | None = None


def _to_out(o) -> OrderOut:
    return OrderOut(
        order_no=o.order_no,
        account_id=o.account_id,
        amount=str(o.amount),
        currency=o.currency,
        gateway=o.gateway,
        status=o.status,
        gateway_order_id=o.gateway_order_id,
        gateway_tx_id=o.gateway_tx_id,
        created_at=o.created_at.isoformat() if o.created_at else "",
        paid_at=o.paid_at.isoformat() if o.paid_at else None,
        expired_at=o.expired_at.isoformat() if o.expired_at else None,
        remark=o.remark,
    )


# gateway → (module, published mode, factory name, audit prefix).
# The factory name is resolved at call time so tests (and future products) can
# swap the channel function without touching this dispatch.
# alipay uses page.pay because 当面付/precreate is not signed on this merchant;
# the precreate factory stays reachable by changing only this table.
_ONLINE_CHANNELS = {
    "wechat_pay": (wechat_pay, "wechat_native", "create_payment", "precreate"),
    "alipay": (alipay, "alipay_page", "create_page_payment", "cashier"),
}


def _channel(gateway: str):
    try:
        module, mode, factory, audit = _ONLINE_CHANNELS[gateway]
    except KeyError:
        raise PaymentConfigError("Unsupported online payment channel") from None
    config = (payment_config.load_wechat_config() if gateway == "wechat_pay"
              else payment_config.load_alipay_config())
    return module, config, mode, factory, audit


def _recharge_idempotency_ready(session: Session) -> bool:
    """Advertise safe replay only after the additive DB migration is present."""
    try:
        return bool(session.execute(text("""
            SELECT EXISTS (
                SELECT 1 FROM pg_attribute
                 WHERE attrelid = to_regclass('we_payment_orders')
                   AND attname = 'client_idempotency_key' AND NOT attisdropped
            ) AND EXISTS (
                SELECT 1 FROM pg_attribute
                 WHERE attrelid = to_regclass('we_payment_orders')
                   AND attname = 'request_fingerprint' AND NOT attisdropped
            ) AND EXISTS (
                SELECT 1 FROM pg_index
                 WHERE indexrelid = to_regclass('we_payment_orders_account_client_key_uq')
                   AND indisunique AND indisvalid
            )
        """)).scalar())
    except SQLAlchemyError:
        logger.warning("payment idempotency schema readiness unavailable")
        session.rollback()
        return False


@router.get("/channels")
def payment_channels(session: Session = Depends(get_session), current: Account = Depends(get_current_account)):
    items = []
    for gateway in ("wechat_pay", "alipay"):
        mode = _ONLINE_CHANNELS[gateway][1]
        try:
            _channel(gateway)
            items.append({"gateway": gateway, "mode": mode, "available": True})
        except PaymentConfigError:
            items.append({"gateway": gateway, "mode": mode, "available": False,
                          "reason": "支付通道尚未配置就绪"})
    return {"items": items, "recharge_idempotency": _recharge_idempotency_ready(session)}


def _payment_result(session: Session, order, channel) -> RechargeOut:
    module, config, _, factory, audit = channel
    # Release the post-create/read transaction before contacting the provider.
    # Its outcome never marks paid. Unknown outcomes keep the same durable order.
    from platform_v8.storage.repo import AuditRepo
    AuditRepo.write(session, action=f"payment.{audit}.requested", actor_account_id=order.account_id,
                    actor_kind="user", target_kind="payment_order", target_id=order.order_no,
                    detail={"gateway": order.gateway})
    session.commit()
    try:
        instruction = getattr(module, factory)(order, config)
    except PaymentMerchantBindingError:
        logger.error("payment merchant binding missing · gateway=%s order=%s", order.gateway, order.order_no)
        raise HTTPException(503, detail={"code": "payment_binding_required", "order_no": order.order_no,
                                         "message": "微信支付尚未完成商户授权，暂时无法扫码付款"}) from None
    except PaymentRequestUnknown:
        logger.warning("payment prepayment outcome unknown · gateway=%s order=%s", order.gateway, order.order_no)
        try:
            AuditRepo.write(session, action=f"payment.{audit}.unknown", actor_kind="system",
                            target_kind="payment_order", target_id=order.order_no,
                            detail={"gateway": order.gateway})
            session.commit()
        except Exception:
            session.rollback()
            logger.error("payment prepayment unknown audit failed · gateway=%s order=%s", order.gateway, order.order_no)
        raise HTTPException(502, detail={"code": "payment_request_unknown", "order_no": order.order_no,
                                        "message": "支付请求结果未确认，请查询或重试原订单，不要重复创建充值单"}) from None
    except PaymentVerificationError:
        # The provider was never reached, so this is NOT a lost outcome; it still
        # must not push the caller into creating a second order for the same money.
        logger.error("payment parameters rejected · gateway=%s order=%s", order.gateway, order.order_no)
        raise HTTPException(502, detail={"code": "payment_parameters_rejected", "order_no": order.order_no,
                                        "message": "无法生成付款参数，请重试原订单，不要重复创建充值单"}) from None
    return RechargeOut(**_to_out(order).model_dump(), payment=PaymentInstructions(**instruction))


def _reused_order_result(order) -> RechargeOut:
    """A replay returns the original order without sending another provider request."""
    base = f"/api/v8/payment/orders/{order.order_no}"
    recovery = {"order_url": base}
    if order.status == "pending" and order.expired_at and order.expired_at > datetime.now(timezone.utc):
        recovery["payment_url"] = base + "/payment"
    if order.gateway == "wechat_pay" and order.status in ("pending", "expired"):
        recovery["refresh_url"] = base + "/refresh"
    return RechargeOut(**_to_out(order).model_dump(), reused_order=True, recovery=recovery)


@router.post("/recharge", response_model=RechargeOut, status_code=201)
def recharge_endpoint(
    body: RechargeRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    """用户发起充值
    
    admin_manual 模式: 创建 pending 订单 + 备注 · admin 后台手工 mark_paid
    wechat_pay: verified API v3 Native code_url (not prepay_id).
    alipay: signed 电脑网站支付 parameters for the browser to submit (mode=alipay_page).
    bank_transfer 模式: 用户填对公转账流水号到 remark · admin 核对后 mark_paid
    """
    if body.idempotency_key is not None:
        try:
            existing = orders_svc.find_idempotent_order(
                session, orders_svc.CreateOrderInput(
                    account_id=current.id, amount=body.amount, gateway=body.gateway,
                    remark=body.remark, idempotency_key=body.idempotency_key,
                ),
            )
        except orders_svc.PaymentIdempotencyConflict as exc:
            raise HTTPException(status_code=409, detail={"code": "idempotency_conflict", "message": str(exc)}) from None
        except orders_svc.PaymentError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        if existing is not None:
            response.status_code = 200
            return _reused_order_result(existing)

    channel = None
    if body.gateway in ("wechat_pay", "alipay"):
        try:
            cny_amount(body.amount)
            channel = _channel(body.gateway)
        except PaymentVerificationError as exc:
            raise HTTPException(400, detail=str(exc)) from exc
        except PaymentConfigError:
            raise HTTPException(503, detail="支付通道尚未配置就绪") from None
    try:
        order = orders_svc.create_order(
            session,
            orders_svc.CreateOrderInput(
                account_id=current.id,
                amount=body.amount,
                gateway=body.gateway,
                remark=body.remark,
                client_ip=_client_ip(request),
                user_agent=request.headers.get("User-Agent", "")[:200],
                notify_url=channel[1].notify_url if channel else None,
                return_url=getattr(channel[1], "return_url", None) if channel else None,
                idempotency_key=body.idempotency_key,
            ),
        )
    except orders_svc.PaymentIdempotencyConflict as exc:
        raise HTTPException(status_code=409, detail={"code": "idempotency_conflict", "message": str(exc)}) from None
    except orders_svc.PaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if order.reused:
        response.status_code = 200
        return _reused_order_result(order)
    return _payment_result(session, order, channel) if channel else RechargeOut(**_to_out(order).model_dump())


@router.post("/orders/{order_no}/payment", response_model=RechargeOut)
def retry_payment_endpoint(order_no: str, session: Session = Depends(get_session),
                           current: Account = Depends(get_current_account)):
    order = orders_svc.get_order(session, order_no)
    if not order:
        raise HTTPException(404, detail="订单不存在")
    if order.account_id != current.id:
        raise HTTPException(403, detail="仅订单本人可以获取付款参数")
    if (order.gateway not in ("wechat_pay", "alipay") or order.status != "pending"
            or not order.expired_at or order.expired_at <= datetime.now(timezone.utc)):
        raise HTTPException(409, detail="订单不可重新获取付款参数，请查询到账状态")
    try:
        channel = _channel(order.gateway)
    except PaymentConfigError:
        raise HTTPException(503, detail="支付通道尚未配置就绪") from None
    return _payment_result(session, order, channel)


@router.get("/orders/{order_no}", response_model=OrderOut)
def get_order_endpoint(
    order_no: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    order = orders_svc.get_order(session, order_no)
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")
    if order.account_id != current.id and not current.is_admin:
        raise HTTPException(status_code=403, detail="无权访问")
    return _to_out(order)


@router.post("/orders/{order_no}/refresh", response_model=RefreshedOrderOut,
             dependencies=[Depends(rate_limit("payment_wechat_query", per_minute=6, key="uid"))])
def refresh_wechat_order_endpoint(
    order_no: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    """Recover a missed WeChat notify using a signed provider query.

    This never creates an order. Only a verified SUCCESS matching the existing
    owner, amount and merchant identities may pass through mark_paid's ledger lock.
    """
    order = orders_svc.get_order(session, order_no)
    if order is None:
        raise HTTPException(404, detail="订单不存在")
    if order.account_id != current.id:
        raise HTTPException(403, detail="仅订单本人可以查询付款状态")
    if order.gateway != "wechat_pay":
        raise HTTPException(409, detail="仅微信支付订单可查询微信交易状态")
    if order.status == "paid":
        return RefreshedOrderOut(**_to_out(order).model_dump(), provider_state="SUCCESS")
    if order.status not in ("pending", "expired"):
        raise HTTPException(409, detail="订单当前状态不可刷新")
    try:
        config = payment_config.load_wechat_config()
    except PaymentConfigError:
        raise HTTPException(503, detail="支付通道尚未配置就绪") from None
    # Release the read transaction during the network call. mark_paid takes a
    # fresh row lock and remains safe if the callback arrives concurrently.
    session.commit()
    try:
        answer = wechat_pay.query_trade(order, config)
    except wechat_pay.PaymentRequestUnknown:
        raise HTTPException(502, detail={"code": "payment_query_unknown", "order_no": order_no,
                                         "message": "暂时无法确认微信支付状态，请稍后查询原订单"}) from None
    except PaymentVerificationError:
        logger.warning("payment.query.rejected gateway=wechat_pay order=%s", order_no)
        raise HTTPException(502, detail={"code": "payment_query_rejected", "order_no": order_no,
                                         "message": "微信支付状态校验未通过，请稍后查询原订单"}) from None
    if answer.paid:
        from platform_v8.services.payment.common import PaymentCallback, account_binding
        verified = PaymentCallback("wechat_pay", order.order_no, answer.transaction_id,
                                   order.amount, order.currency, account_binding(order.account_id))
        try:
            orders_svc.mark_paid(session, order.order_no, answer.transaction_id,
                                 actor="query:wechat_pay", verified=verified)
        except orders_svc.PaymentError:
            raise HTTPException(409, detail="订单已变化，请重新查询原订单") from None
    current_order = orders_svc.get_order(session, order_no)
    return RefreshedOrderOut(**_to_out(current_order).model_dump(), provider_state=answer.state)


@router.get("/orders")
def list_orders_endpoint(
    limit: int = Query(30, ge=1, le=100),
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    orders = orders_svc.list_orders(session, current.id, limit=min(limit, 100))
    return {"ok": True, "items": [_to_out(o).model_dump() for o in orders],
            "total": len(orders)}


async def _callback_body(request: Request) -> bytes:
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > 1024 * 1024:
            raise PaymentVerificationError("Notification too large")
    return bytes(data)


def _apply_callback(gateway: str, headers, body: bytes, session: Session):
    module, config, _, _, _ = _channel(gateway)
    try:
        verified = module.verify_callback(headers, body, config)
    except PaymentVerificationError:
        logger.warning("payment.callback.rejected gateway=%s stage=signature_or_provider_identity", gateway)
        raise
    try:
        orders_svc.mark_paid(session, verified.order_no, verified.gateway_tx_id,
                             actor=f"callback:{gateway}", verified=verified)
    except orders_svc.PaymentError:
        logger.warning("payment.callback.rejected gateway=%s stage=order_binding_or_ledger order=%s",
                       gateway, verified.order_no)
        raise


@router.post("/notify/wechat_pay")
async def wechat_notify(request: Request, session: Session = Depends(get_session)):
    try:
        body = await _callback_body(request)
        await run_in_threadpool(_apply_callback, "wechat_pay", request.headers, body, session)
    except PaymentConfigError:
        return JSONResponse({"code": "FAIL", "message": "Channel unavailable"}, status_code=503)
    except (PaymentVerificationError, orders_svc.PaymentError):
        logger.warning("payment.callback.rejected gateway=wechat_pay stage=http_rejected")
        return JSONResponse({"code": "FAIL", "message": "Payment verification failed"}, status_code=400)
    return Response(status_code=204)


@router.post("/notify/alipay")
async def alipay_notify(request: Request, session: Session = Depends(get_session)):
    try:
        body = await _callback_body(request)
        await run_in_threadpool(_apply_callback, "alipay", request.headers, body, session)
    except PaymentConfigError:
        return PlainTextResponse("failure", status_code=503)
    except (PaymentVerificationError, orders_svc.PaymentError):
        logger.warning("payment.callback.rejected gateway=alipay stage=http_rejected")
        return PlainTextResponse("failure", status_code=400)
    return PlainTextResponse("success")


def _admin_out(order):
    return AdminOrderOut(**_to_out(order).model_dump(), ledger_id=order.ledger_id)


@admin_router.get("/orders")
def admin_list_orders(limit: int = Query(30, ge=1, le=100), offset: int = Query(0, ge=0),
                      account_id: int | None = Query(None, gt=0), status: str | None = None,
                      gateway: str | None = None, session: Session = Depends(get_session),
                      admin: Account = Depends(get_admin_account)):
    try:
        items, total = orders_svc.list_admin_orders(session, limit=limit, offset=offset,
                                                   account_id=account_id, status=status, gateway=gateway)
    except orders_svc.PaymentError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    return {"ok": True, "items": [_admin_out(o).model_dump() for o in items],
            "total": total, "limit": limit, "offset": offset}


@admin_router.get("/orders/{order_no}", response_model=AdminOrderOut)
def admin_get_order(order_no: str, session: Session = Depends(get_session),
                    admin: Account = Depends(get_admin_account)):
    order = orders_svc.get_order(session, order_no)
    if not order:
        raise HTTPException(404, detail="订单不存在")
    return _admin_out(order)


# ──────────────────────────────────────────────────────
# Admin · 手工确认入账
# ──────────────────────────────────────────────────────

class AdminConfirmRequest(BaseModel):
    order_no: str
    gateway_tx_id: str = Field(..., description="对公流水号 / 支付方交易号 / 'MANUAL'")


@admin_router.post("/confirm")
def admin_confirm_endpoint(
    body: AdminConfirmRequest,
    session: Session = Depends(get_session),
    admin: Account = Depends(get_admin_account),
):
    try:
        order = orders_svc.mark_paid(
            session, body.order_no, body.gateway_tx_id,
            actor=f"admin:{admin.id}",
        )
    except orders_svc.PaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # 高危补 audit (S2-T8 风格)
    try:
        from platform_v8.storage.repo import AuditRepo as _AuditRepo
        _AuditRepo.write(
            session,
            action="admin.payment.confirm",
            actor_account_id=admin.id,
            actor_kind="admin",
            target_kind="payment_order",
            target_id=body.order_no,
            detail={
                "account_id": order.account_id,
                "amount": str(order.amount),
                "gateway": order.gateway,
                "tx_id": body.gateway_tx_id,
            },
        )
    except Exception:
        pass

    return {"ok": True, "order": _to_out(order).model_dump()}


# ══════════════════════════════════════════════════════════
# S3-T3 · 提现申请 workflow
# ══════════════════════════════════════════════════════════

class WithdrawCreateRequest(BaseModel):
    amount: Decimal = Field(..., gt=0, le=100_000)
    payee_info: dict = Field(..., description="{kind: alipay/wechat/bank/usdt, account_no, holder_name, bank_name?}")
    remark: str = Field(default="", max_length=500)


class WithdrawOut(BaseModel):
    request_no: str
    amount: str
    currency: str
    payee_info: dict
    status: str
    kyc_status: str
    review_note: str = ""
    paid_tx_id: str | None = None
    created_at: str
    paid_at: str | None = None
    remark: str = ""


def _wd_to_out(w) -> WithdrawOut:
    # 脱敏 payee_info(隐藏 account_no 中间 · holder_name 仅首字)
    pi = dict(w.payee_info or {})
    if pi.get("account_no"):
        a = str(pi["account_no"])
        pi["account_no"] = (a[:4] + "****" + a[-4:]) if len(a) > 8 else "***"
    return WithdrawOut(
        request_no=w.request_no, amount=str(w.amount), currency=w.currency,
        payee_info=pi, status=w.status, kyc_status=w.kyc_status,
        review_note=w.review_note, paid_tx_id=w.paid_tx_id,
        created_at=w.created_at.isoformat() if w.created_at else "",
        paid_at=w.paid_at.isoformat() if w.paid_at else None,
        remark=w.remark,
    )


@router.post("/withdraw", response_model=WithdrawOut, status_code=201)
def withdraw_create_endpoint(
    body: WithdrawCreateRequest,
    request: Request,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    """节点矿工/企业用户发起提现申请 · 进入审批队列(pending) · 不立刻扣 ledger"""
    try:
        wd = withdraws_svc.create_request(
            session,
            withdraws_svc.CreateRequestInput(
                account_id=current.id,
                amount=body.amount,
                payee_info=body.payee_info,
                remark=body.remark,
                client_ip=_client_ip(request),
            ),
        )
    except withdraws_svc.WithdrawError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _wd_to_out(wd)


@router.get("/withdraw")
def withdraw_list_my(
    limit: int = 30,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    items = withdraws_svc.list_my_requests(session, current.id, limit=min(limit, 100))
    return {"ok": True, "items": [_wd_to_out(w).model_dump() for w in items],
            "total": len(items)}


@router.get("/withdraw/{request_no}", response_model=WithdrawOut)
def withdraw_get_endpoint(
    request_no: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    wd = withdraws_svc.get_request(session, request_no)
    if not wd:
        raise HTTPException(status_code=404, detail="申请不存在")
    if wd.account_id != current.id and not current.is_admin:
        raise HTTPException(status_code=403, detail="无权访问")
    return _wd_to_out(wd)


# ── Admin: 审批 / 打款 ─────────────────────────────────────

class AdminWithdrawReview(BaseModel):
    request_no: str
    note: str = ""


class AdminWithdrawPaid(BaseModel):
    request_no: str
    paid_tx_id: str = Field(..., max_length=128, description="银行/支付宝流水号")


@admin_router.get("/withdraw/pending")
def admin_list_pending_withdraws(
    limit: int = 50,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    items = withdraws_svc.list_admin_pending(session, limit=min(limit, 200))
    # admin 看完整 payee_info(不脱敏 · 用于打款核对)
    return {"ok": True, "total": len(items), "items": [
        {**_wd_to_out(w).model_dump(),
         "payee_info_full": w.payee_info,
         "account_id": w.account_id}
        for w in items
    ]}


@admin_router.post("/withdraw/approve")
def admin_approve_withdraw(
    body: AdminWithdrawReview,
    session: Session = Depends(get_session),
    admin: Account = Depends(get_admin_account),
):
    try:
        wd = withdraws_svc.admin_approve(session, body.request_no, admin.id, body.note)
    except withdraws_svc.WithdrawError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # 高危 audit
    try:
        from platform_v8.storage.repo import AuditRepo as _A
        _A.write(session, action="admin.withdraw.approve", actor_account_id=admin.id,
                 actor_kind="admin", target_kind="withdraw_request",
                 target_id=body.request_no, detail={"note": body.note, "amount": str(wd.amount)})
    except Exception:
        pass
    return {"ok": True, "withdraw": _wd_to_out(wd).model_dump()}


@admin_router.post("/withdraw/reject")
def admin_reject_withdraw(
    body: AdminWithdrawReview,
    session: Session = Depends(get_session),
    admin: Account = Depends(get_admin_account),
):
    try:
        wd = withdraws_svc.admin_reject(session, body.request_no, admin.id, body.note or "无原因")
    except withdraws_svc.WithdrawError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        from platform_v8.storage.repo import AuditRepo as _A
        _A.write(session, action="admin.withdraw.reject", actor_account_id=admin.id,
                 actor_kind="admin", target_kind="withdraw_request",
                 target_id=body.request_no, detail={"note": body.note})
    except Exception:
        pass
    return {"ok": True, "withdraw": _wd_to_out(wd).model_dump()}


@admin_router.post("/withdraw/mark_paid")
def admin_mark_paid_withdraw(
    body: AdminWithdrawPaid,
    session: Session = Depends(get_session),
    admin: Account = Depends(get_admin_account),
):
    try:
        wd = withdraws_svc.mark_paid(session, body.request_no, body.paid_tx_id, admin.id)
    except withdraws_svc.WithdrawError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        from platform_v8.storage.repo import AuditRepo as _A
        _A.write(session, action="admin.withdraw.paid", actor_account_id=admin.id,
                 actor_kind="admin", target_kind="withdraw_request",
                 target_id=body.request_no,
                 detail={"tx_id": body.paid_tx_id, "amount": str(wd.amount)})
    except Exception:
        pass
    return {"ok": True, "withdraw": _wd_to_out(wd).model_dump()}
