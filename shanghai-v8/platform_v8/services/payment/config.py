"""Explicit opt-in configuration; secret files remain outside source control."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from .common import PaymentConfigError


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value or any(ord(c) < 32 for c in value):
        raise PaymentConfigError("Payment channel configuration is incomplete")
    return value


def _file(name: str, *, secret: bool = False) -> bytes:
    try:
        path = Path(_required(name))
        if not path.is_absolute() or (secret and path.stat().st_mode & 0o077):
            raise ValueError
        data = path.read_bytes()
        if not data or len(data) > 65536:
            raise ValueError
        return data
    except (OSError, ValueError):
        raise PaymentConfigError("Payment key file is missing, invalid, or has unsafe permissions") from None


def _private(name: str) -> rsa.RSAPrivateKey:
    try:
        key = serialization.load_pem_private_key(_file(name, secret=True), password=None)
        if not isinstance(key, rsa.RSAPrivateKey) or key.key_size < 2048:
            raise ValueError
        return key
    except (ValueError, TypeError):
        raise PaymentConfigError("Payment private key must be RSA 2048 or stronger") from None


def _identifier(name: str) -> str:
    value = _required(name)
    if not re.fullmatch(r"[A-Za-z0-9_]{1,128}", value):
        raise PaymentConfigError("Payment identity configuration is invalid")
    return value


def _optional_identifier(name: str) -> str:
    """Absent is allowed; malformed is not. Used for hardening-only identities."""
    value = os.environ.get(name, "").strip()
    return _identifier(name) if value else ""


# The cashier returns the browser here after payment. `/ea/` is nginx's alias for
# apps/enterprise-agent/dist, so this is the deployed SPA route. Deliberately not
# client-supplied: a caller can never turn the return into an open redirect.
SPA_RETURN_PATH = "/ea/#/wallet"


def _origin() -> str:
    value = _required("V8_PAYMENT_PUBLIC_ORIGIN")
    parts = urlsplit(value)
    if (parts.scheme != "https" or not parts.hostname or parts.username or parts.password
            or parts.query or parts.fragment or parts.path not in ("", "/")):
        raise PaymentConfigError("Payment public origin must be an HTTPS origin")
    return value.rstrip("/")


def _notify(gateway: str) -> str:
    return _origin() + f"/api/v8/payment/notify/{gateway}"


def _return() -> str:
    return _origin() + SPA_RETURN_PATH


@dataclass(frozen=True, repr=False)
class WechatConfig:
    app_id: str
    mch_id: str
    merchant_serial: str
    private_key: rsa.RSAPrivateKey
    api_v3_key: bytes
    platform_serial: str
    platform_key: rsa.RSAPublicKey
    platform_certificate: x509.Certificate | None
    notify_url: str


@dataclass(frozen=True, repr=False)
class AlipayConfig:
    app_id: str
    seller_id: str
    private_key: rsa.RSAPrivateKey
    platform_key: rsa.RSAPublicKey
    notify_url: str
    # Optional so existing constructions (and the pure precreate path) stay valid;
    # an empty value simply omits return_url from the cashier request.
    return_url: str = ""


def load_wechat_config() -> WechatConfig:
    if os.environ.get("V8_WECHAT_PAY_ENABLED") != "1":
        raise PaymentConfigError("WeChat Pay is not enabled")
    try:
        serial = _identifier("V8_WECHAT_PAY_PLATFORM_SERIAL")
        pem = _file("V8_WECHAT_PAY_PLATFORM_KEY_FILE")
        cert = None
        if pem.lstrip().startswith(b"-----BEGIN CERTIFICATE-----"):
            cert = x509.load_pem_x509_certificate(pem)
            if format(cert.serial_number, "X") != serial.upper():
                raise ValueError
            serial = serial.upper()
            if not cert.not_valid_before_utc <= datetime.now(timezone.utc) <= cert.not_valid_after_utc:
                raise ValueError
            key = cert.public_key()
        else:
            if not serial.startswith("PUB_KEY_ID_"):
                raise ValueError
            key = serialization.load_pem_public_key(pem)
        api_key = _file("V8_WECHAT_PAY_API_V3_KEY_FILE", secret=True).rstrip(b"\r\n")
        if not isinstance(key, rsa.RSAPublicKey) or key.key_size < 2048 or len(api_key) != 32:
            raise ValueError
        return WechatConfig(
            _identifier("V8_WECHAT_PAY_APP_ID"), _identifier("V8_WECHAT_PAY_MCH_ID"),
            _identifier("V8_WECHAT_PAY_MERCHANT_SERIAL"), _private("V8_WECHAT_PAY_PRIVATE_KEY_FILE"),
            api_key, serial, key, cert, _notify("wechat_pay"),
        )
    except (ValueError, TypeError):
        raise PaymentConfigError("WeChat Pay verification material is invalid") from None


def load_alipay_config() -> AlipayConfig:
    if os.environ.get("V8_ALIPAY_ENABLED") != "1":
        raise PaymentConfigError("Alipay is not enabled")
    try:
        key = serialization.load_pem_public_key(_file("V8_ALIPAY_PUBLIC_KEY_FILE"))
        if not isinstance(key, rsa.RSAPublicKey) or key.key_size < 2048:
            raise ValueError
        return AlipayConfig(_identifier("V8_ALIPAY_APP_ID"), _optional_identifier("V8_ALIPAY_SELLER_ID"),
                            _private("V8_ALIPAY_PRIVATE_KEY_FILE"), key, _notify("alipay"), _return())
    except (ValueError, TypeError):
        raise PaymentConfigError("Alipay verification material is invalid") from None
