"""WeChat API v3 ordinary-merchant Native QR payments (not JSAPI/APP SDK)."""
from __future__ import annotations

import base64
import binascii
import json
import logging
import re
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from urllib.parse import urlencode

import httpx
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .common import (PaymentCallback, PaymentMerchantBindingError, PaymentRequestUnknown, PaymentVerificationError,
                     account_binding, cny_amount, json_object, required_text, rsa_sign, rsa_verify)
from .config import WechatConfig

ENDPOINT = "https://api.mch.weixin.qq.com/v3/pay/transactions/native"
QUERY_ENDPOINT = "https://api.mch.weixin.qq.com"
MAX_BODY = 1024 * 1024
logger = logging.getLogger(__name__)


def _log_provider_response(action: str, order_no: str, response: httpx.Response) -> None:
    """Keep the provider's diagnostic Request-ID without logging payment bodies or credentials."""
    request_id = response.headers.get("Request-ID", "")
    if re.fullmatch(r"[A-Za-z0-9._-]{1,128}", request_id):
        logger.info("wechat.%s response · order=%s status=%s request_id=%s",
                    action, order_no, response.status_code, request_id)
    else:
        logger.info("wechat.%s response · order=%s status=%s",
                    action, order_no, response.status_code)


def verify_message(headers, body: bytes, config: WechatConfig, *, now: float | None = None) -> None:
    headers = {k.lower(): v for k, v in headers.items()}
    now = time.time() if now is None else now
    try:
        timestamp = required_text(headers, "wechatpay-timestamp", 16)
        nonce = required_text(headers, "wechatpay-nonce", 128)
        signature = required_text(headers, "wechatpay-signature", 1024)
        if (headers.get("wechatpay-serial") != config.platform_serial
                or abs(now - int(timestamp)) > 300 or len(body) > MAX_BODY):
            raise ValueError
        if config.platform_certificate:
            cert = config.platform_certificate
            clock = datetime.fromtimestamp(now, timezone.utc)
            if not (cert.not_valid_before_utc <= clock <= cert.not_valid_after_utc):
                raise ValueError
        rsa_verify(config.platform_key, timestamp.encode() + b"\n" + nonce.encode() + b"\n" + body + b"\n", signature)
    except (ValueError, TypeError):
        raise PaymentVerificationError("Invalid WeChat signature metadata") from None


def create_payment(order, config: WechatConfig, *, client=None, now: float | None = None) -> dict:
    if order.gateway != "wechat_pay" or order.currency != "CNY" or order.status != "pending":
        raise PaymentVerificationError("Invalid WeChat order")
    amount = cny_amount(order.amount)
    body = json.dumps({
        "appid": config.app_id, "mchid": config.mch_id,
        "description": "千手账户充值", "out_trade_no": order.order_no,
        "time_expire": order.expired_at.isoformat(), "attach": account_binding(order.account_id),
        "notify_url": config.notify_url, "amount": {"total": int(amount * 100), "currency": "CNY"},
    }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    timestamp = str(int(time.time() if now is None else now))
    nonce = secrets.token_hex(16)
    message = b"POST\n/v3/pay/transactions/native\n" + timestamp.encode() + b"\n" + nonce.encode() + b"\n" + body + b"\n"
    auth = (f'WECHATPAY2-SHA256-RSA2048 mchid="{config.mch_id}",nonce_str="{nonce}",'
            f'timestamp="{timestamp}",serial_no="{config.merchant_serial}",'
            f'signature="{rsa_sign(config.private_key, message)}"')
    owned = client is None
    client = client or httpx.Client(timeout=10.0, follow_redirects=False)
    try:
        response = client.post(ENDPOINT, content=body, headers={
            "Authorization": auth, "Accept": "application/json", "Content-Type": "application/json",
            "Wechatpay-Serial": config.platform_serial,
        })
        _log_provider_response("native", order.order_no, response)
        verify_message(response.headers, response.content, config, now=now)
        result = json_object(response.content)
        if response.status_code != 200:
            if response.status_code == 400 and result.get("code") == "APPID_MCHID_NOT_MATCH":
                raise PaymentMerchantBindingError("WeChat AppID is not bound to the merchant")
            raise PaymentVerificationError("Provider did not confirm prepayment")
        code_url = required_text(result, "code_url", 2048)
        if not code_url.startswith("weixin://"):
            raise PaymentVerificationError("Invalid WeChat QR URL")
        return {"mode": "wechat_native", "code_url": code_url}
    except (httpx.HTTPError, PaymentVerificationError):
        raise PaymentRequestUnknown("WeChat payment request outcome is unknown; retain this order") from None
    finally:
        if owned:
            client.close()


def verify_callback(headers, body: bytes, config: WechatConfig, *, now: float | None = None) -> PaymentCallback:
    verify_message(headers, body, config, now=now)
    envelope = json_object(body)
    try:
        if envelope.get("event_type") != "TRANSACTION.SUCCESS" or envelope.get("resource_type") != "encrypt-resource":
            raise ValueError
        resource = envelope["resource"]
        if resource["algorithm"] != "AEAD_AES_256_GCM" or resource["original_type"] != "transaction":
            raise ValueError
        clear = AESGCM(config.api_v3_key).decrypt(
            resource["nonce"].encode(), base64.b64decode(resource["ciphertext"], validate=True),
            resource.get("associated_data", "").encode(),
        )
        data = json_object(clear)
        if (data.get("appid") != config.app_id or data.get("mchid") != config.mch_id
                or data.get("trade_state") != "SUCCESS" or data.get("trade_type") != "NATIVE"):
            raise ValueError
        money = data["amount"]
        if type(money["total"]) is not int or money.get("currency") != "CNY":
            raise ValueError
        return PaymentCallback("wechat_pay", required_text(data, "out_trade_no", 32),
                               required_text(data, "transaction_id"),
                               cny_amount(Decimal(money["total"]) / Decimal(100)),
                               "CNY", required_text(data, "attach"))
    except (KeyError, TypeError, ValueError, AttributeError, InvalidTag, binascii.Error):
        raise PaymentVerificationError("Invalid WeChat transaction") from None


@dataclass(frozen=True)
class TradeQuery:
    """A verified answer from WeChat's merchant-order query API."""

    state: str
    transaction_id: str | None = None

    @property
    def paid(self) -> bool:
        return self.state == "SUCCESS"


def query_trade(order, config: WechatConfig, *, client=None, now: float | None = None) -> TradeQuery:
    """Query one existing Native order; the signed response is authoritative.

    An HTTP failure or missing/bad signature is unknown, never proof of nonpayment.
    Provider fields are checked against the local immutable order before returning.
    """
    if (order.gateway != "wechat_pay" or order.currency != "CNY"
            or not re.fullmatch(r"[A-Za-z0-9_*|-]{6,32}", order.order_no)):
        raise PaymentVerificationError("Invalid WeChat order")
    path = f"/v3/pay/transactions/out-trade-no/{order.order_no}?{urlencode({'mchid': config.mch_id})}"
    timestamp = str(int(time.time() if now is None else now))
    nonce = secrets.token_hex(16)
    message = f"GET\n{path}\n{timestamp}\n{nonce}\n\n".encode("utf-8")
    auth = (f'WECHATPAY2-SHA256-RSA2048 mchid="{config.mch_id}",nonce_str="{nonce}",'
            f'timestamp="{timestamp}",serial_no="{config.merchant_serial}",'
            f'signature="{rsa_sign(config.private_key, message)}"')
    owned = client is None
    client = client or httpx.Client(timeout=10.0, follow_redirects=False)
    try:
        response = client.get(QUERY_ENDPOINT + path, headers={
            "Authorization": auth, "Accept": "application/json",
        })
        _log_provider_response("query", order.order_no, response)
        if response.status_code != 200:
            raise PaymentRequestUnknown("WeChat query did not return an order; retry later")
        verify_message(response.headers, response.content, config, now=now)
        data = json_object(response.content)
        if (data.get("appid") != config.app_id or data.get("mchid") != config.mch_id
                or data.get("out_trade_no") != order.order_no):
            raise PaymentVerificationError("WeChat query identity does not match the order")
        state = required_text(data, "trade_state", 32)
        if state not in {"SUCCESS", "NOTPAY", "CLOSED", "REFUND", "REVOKED", "USERPAYING", "PAYERROR"}:
            raise PaymentVerificationError("Unknown WeChat trade state")
        # WeChat documents trade_type, attach and amount as optional query
        # fields. Require all of them for SUCCESS (the only crediting state).
        # An unpaid response may omit them; it is never used to credit an order.
        if state == "SUCCESS":
            if (data.get("trade_type") != "NATIVE"
                    or data.get("attach") != account_binding(order.account_id)):
                raise PaymentVerificationError("WeChat paid query identity does not match the order")
            money = data.get("amount")
            if (not isinstance(money, dict) or type(money.get("total")) is not int
                    or money.get("currency") != "CNY"
                    or cny_amount(Decimal(money["total"]) / Decimal(100)) != cny_amount(order.amount)):
                raise PaymentVerificationError("WeChat query amount does not match the order")
        tx = required_text(data, "transaction_id", 128) if state == "SUCCESS" else None
        return TradeQuery(state, tx)
    except httpx.HTTPError:
        raise PaymentRequestUnknown("WeChat query outcome is unknown; retry later") from None
    finally:
        if owned:
            client.close()
