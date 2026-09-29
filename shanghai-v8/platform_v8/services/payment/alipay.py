"""Alipay RSA2 integration: page-jump cashier (live) and precreate QR (fallback).

电脑网站支付 (`alipay.trade.page.pay`) is the only payment product this merchant
has signed, so it is the live channel. `alipay.trade.precreate` (当面付) is kept
for the day that product is signed. Both share the same RSA2 primitives, and
`alipay.trade.query` is the reconciliation path the official docs require.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from urllib.parse import parse_qsl, urlsplit
from zoneinfo import ZoneInfo

import httpx

from .common import (PaymentCallback, PaymentRequestUnknown, PaymentVerificationError,
                     account_binding, cny_amount, json_object, required_text, rsa_sign, rsa_verify)
from .config import AlipayConfig

GATEWAY = "https://openapi.alipay.com/gateway.do"
ENDPOINT = GATEWAY
MAX_BODY = 1024 * 1024
logger = logging.getLogger(__name__)
SUBJECT = "千手账户充值"
# Required by 电脑网站支付; see opendocs.alipay.com/open/028r8t and the official
# SDK model AlipayTradePagePayModel (which also carries passback_params/time_expire).
PAGE_PRODUCT_CODE = "FAST_INSTANT_TRADE_PAY"
PRECREATE_RESPONSE = "alipay_trade_precreate_response"
QUERY_RESPONSE = "alipay_trade_query_response"


def sign_content(params: dict) -> bytes:
    return "&".join(f"{key}={params[key]}" for key in sorted(params) if params[key] != "").encode("utf-8")


def _expire(order) -> str:
    if order.expired_at is None:
        raise PaymentVerificationError("Alipay order has no expiry")
    return order.expired_at.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S")


def _amount(value) -> Decimal | None:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return amount if amount.is_finite() else None


def _public_params(config: AlipayConfig, method: str, *, now: datetime | None,
                   notify: bool = True) -> dict:
    params = {
        "app_id": config.app_id, "method": method, "format": "JSON",
        "charset": "utf-8", "sign_type": "RSA2", "version": "1.0",
        "timestamp": (now or datetime.now(ZoneInfo("Asia/Shanghai"))).strftime("%Y-%m-%d %H:%M:%S"),
    }
    if notify:
        params["notify_url"] = config.notify_url
    return params


def _response_encoding(body: bytes, charset: str) -> str:
    """Pick a codec that can decode the body, preferring the declared charset.

    Measured against the live gateway: it replies with `Content-Type:
    text/html;charset=GBK` and a GBK body even though the request asked for
    utf-8, and the `sign` is computed over the body IN THAT CHARSET (verified:
    the same slice re-encoded as utf-8 does not verify). So the codec must be
    used both to decode the body and to re-encode the signed slice.
    """
    for candidate in (charset, "utf-8", "gbk"):
        if not candidate:
            continue
        try:
            body.decode(candidate)
            return candidate
        except (UnicodeDecodeError, LookupError):
            continue
    raise PaymentVerificationError("Provider response is not decodable text")


def _verified_response(body: bytes, config: AlipayConfig, response_key: str,
                       charset: str = "utf-8") -> dict:
    if len(body) > MAX_BODY:
        raise PaymentVerificationError("Provider response too large")
    encoding = _response_encoding(body, charset)
    # Verify the EXACT nested JSON bytes; reserializing changes the signed material.
    raw = body.decode(encoding)
    envelope = json_object(raw)
    decoder = json.JSONDecoder()
    index = raw.index("{") + 1
    signed = None
    while index < len(raw):
        index += len(raw[index:]) - len(raw[index:].lstrip())
        if raw[index:index + 1] == "}":
            break
        name, end = decoder.raw_decode(raw, index)
        index = end + len(raw[end:]) - len(raw[end:].lstrip())
        if raw[index:index + 1] != ":":
            raise PaymentVerificationError("Invalid response object")
        index += 1
        index += len(raw[index:]) - len(raw[index:].lstrip())
        _, end = decoder.raw_decode(raw, index)
        if name == response_key:
            signed = raw[index:end].encode(encoding)
        index = end + len(raw[end:]) - len(raw[end:].lstrip())
        if raw[index:index + 1] == ",":
            index += 1
    if signed is None:
        raise PaymentVerificationError("Missing signed provider response")
    rsa_verify(config.platform_key, signed, required_text(envelope, "sign", 1024))
    response = envelope.get(response_key)
    if not isinstance(response, dict):
        raise PaymentVerificationError("Invalid provider response")
    return response


def create_payment(order, config: AlipayConfig, *, client=None, now: datetime | None = None) -> dict:
    if order.gateway != "alipay" or order.currency != "CNY" or order.status != "pending":
        raise PaymentVerificationError("Invalid Alipay order")
    amount = cny_amount(order.amount)
    params = _public_params(config, "alipay.trade.precreate", now=now)
    params["biz_content"] = json.dumps({
        "out_trade_no": order.order_no, "seller_id": config.seller_id,
        "total_amount": format(amount, ".2f"), "subject": SUBJECT,
        "passback_params": account_binding(order.account_id),
        "time_expire": _expire(order),
    }, ensure_ascii=False, separators=(",", ":"))
    params["sign"] = rsa_sign(config.private_key, sign_content(params))
    owned = client is None
    client = client or httpx.Client(timeout=10.0, follow_redirects=False)
    try:
        response = client.post(ENDPOINT, data=params)
        result = _verified_response(response.content, config, PRECREATE_RESPONSE,
                                    response.encoding or "utf-8")
        if response.status_code != 200 or result.get("code") != "10000" or result.get("out_trade_no") != order.order_no:
            raise PaymentVerificationError("Provider did not confirm this order")
        qr_code = required_text(result, "qr_code", 2048)
        parts = urlsplit(qr_code)
        if parts.scheme != "https" or parts.hostname != "qr.alipay.com" or parts.username or parts.password:
            raise PaymentVerificationError("Invalid Alipay QR URL")
        return {"mode": "alipay_precreate", "qr_code": qr_code}
    except (httpx.HTTPError, PaymentVerificationError, ValueError, UnicodeError):
        raise PaymentRequestUnknown("Alipay payment request outcome is unknown; retain this order") from None
    finally:
        if owned:
            client.close()


def create_page_payment(order, config: AlipayConfig, *, now: datetime | None = None) -> dict:
    """Build the signed 电脑网站支付 request for the browser to submit.

    Deliberately performs NO outbound request: `alipay.trade.page.pay` is a page
    jump interface, so the signed parameter set is handed to the browser which
    POSTs it to the gateway. That means there is no server-side response to
    verify here — payment truth arrives by async notify or alipay.trade.query.
    """
    if order.gateway != "alipay" or order.currency != "CNY" or order.status != "pending":
        raise PaymentVerificationError("Invalid Alipay order")
    amount = cny_amount(order.amount)
    params = _public_params(config, "alipay.trade.page.pay", now=now)
    if config.return_url:
        params["return_url"] = config.return_url
    params["biz_content"] = json.dumps({
        "out_trade_no": order.order_no, "total_amount": format(amount, ".2f"),
        "subject": SUBJECT, "product_code": PAGE_PRODUCT_CODE,
        "passback_params": account_binding(order.account_id),
        "time_expire": _expire(order),
    }, ensure_ascii=False, separators=(",", ":"))
    params["sign"] = rsa_sign(config.private_key, sign_content(params))
    # The gateway decodes a page request's body using the charset given in the URL
    # QUERY STRING. Without it the body is decoded as GBK and any non-ASCII
    # biz_content fails verification — and our `subject` is Chinese, so this is the
    # normal case, not an edge case. Measured against the live gateway: identical
    # signed params, action without ?charset -> cashier returns `invalid-signature`;
    # with ?charset -> the real cashier page loads for the correct merchant.
    return {"mode": "alipay_page", "action": f"{GATEWAY}?charset={params['charset']}",
            "method": "POST", "params": params}


@dataclass(frozen=True)
class TradeQuery:
    """Normalised `alipay.trade.query` answer used for reconciliation only."""

    code: str
    sub_code: str
    trade_status: str
    trade_no: str
    total_amount: Decimal | None

    @property
    def ok(self) -> bool:
        return self.code == "10000"

    @property
    def paid(self) -> bool:
        return self.ok and self.trade_status in ("TRADE_SUCCESS", "TRADE_FINISHED")


def query_trade(order, config: AlipayConfig, *, client=None, now: datetime | None = None) -> TradeQuery:
    """Ask the provider for the authoritative state of one order.

    Unlike page.pay this is a genuine JSON API, so the signed response is verified
    the same way precreate's is. Business codes are returned rather than raised:
    `ACQ.TRADE_NOT_EXIST` is a legitimate answer meaning the provider never saw
    the order. A bad signature is NOT downgraded to "unknown" — it stays loud.
    """
    if order.gateway != "alipay" or order.currency != "CNY":
        raise PaymentVerificationError("Invalid Alipay order")
    params = _public_params(config, "alipay.trade.query", now=now, notify=False)
    params["biz_content"] = json.dumps({"out_trade_no": order.order_no},
                                       ensure_ascii=False, separators=(",", ":"))
    params["sign"] = rsa_sign(config.private_key, sign_content(params))
    owned = client is None
    client = client or httpx.Client(timeout=10.0, follow_redirects=False)
    try:
        response = client.post(ENDPOINT, data=params)
        result = _verified_response(response.content, config, QUERY_RESPONSE,
                                    response.encoding or "utf-8")
        if response.status_code != 200:
            raise PaymentVerificationError("Provider did not answer the query")
        if result.get("out_trade_no") not in (None, order.order_no):
            raise PaymentVerificationError("Provider returned a different order")
        return TradeQuery(
            code=str(result.get("code") or ""), sub_code=str(result.get("sub_code") or ""),
            trade_status=str(result.get("trade_status") or ""), trade_no=str(result.get("trade_no") or ""),
            total_amount=_amount(result.get("total_amount")),
        )
    except httpx.HTTPError:
        raise PaymentRequestUnknown("Alipay query outcome is unknown; retry later") from None
    finally:
        if owned:
            client.close()


def _reject(reason: str):
    """Log a category only — never the body, the signature or account details."""
    logger.warning("payment.callback.rejected gateway=alipay reason=%s", reason)
    raise ValueError


def verify_callback(headers, body: bytes, config: AlipayConfig) -> PaymentCallback:
    try:
        if len(body) > MAX_BODY or re.search(rb"%(?![0-9a-fA-F]{2})", body):
            raise ValueError
        pairs = parse_qsl(body.decode("utf-8"), keep_blank_values=True, strict_parsing=True,
                          encoding="utf-8", errors="strict", max_num_fields=128)
        params = dict(pairs)
        if len(params) != len(pairs):
            _reject("duplicate_parameter")
        if params.get("sign_type") != "RSA2":
            _reject("sign_type")
        if params.get("charset", "utf-8").lower() != "utf-8":
            # The official flow is "URLDecode the remaining parameters, sort, then verify",
            # so the declared charset decides how the body decodes. We request utf-8, but
            # the gateway is MEASURED to ignore the requested charset on its response path
            # (it answered text/html;charset=GBK), so if a notification ever declares a
            # different charset this line is how we find out — the body is never logged.
            _reject("charset:" + str(params.get("charset"))[:16])
        signature = required_text(params, "sign", 1024)
        rsa_verify(config.platform_key,
                   sign_content({k: v for k, v in params.items() if k not in ("sign", "sign_type")}), signature)
        # Official notify checklist: out_trade_no, total_amount, seller_id (or
        # seller_email) and app_id. seller_id is enforced whenever it is configured.
        if params.get("app_id") != config.app_id:
            _reject("app_id")
        if config.seller_id and params.get("seller_id") != config.seller_id:
            _reject("seller_id")
        if params.get("trade_status") not in ("TRADE_SUCCESS", "TRADE_FINISHED"):
            _reject("trade_status")
        if params.get("notify_type") != "trade_status_sync":
            _reject("notify_type")
        if params.get("currency", "CNY") != "CNY":
            _reject("currency")
        return PaymentCallback("alipay", required_text(params, "out_trade_no", 64),
                               required_text(params, "trade_no"), cny_amount(params.get("total_amount")),
                               "CNY", required_text(params, "passback_params"))
    except (ValueError, TypeError, UnicodeError):
        raise PaymentVerificationError("Invalid Alipay notification") from None
