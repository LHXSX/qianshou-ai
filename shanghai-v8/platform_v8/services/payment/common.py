"""Shared payment values and cryptography; no database or network side effects."""
from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa


class PaymentConfigError(Exception):
    """The channel must remain unavailable until its configuration is complete."""


class PaymentMerchantBindingError(PaymentConfigError):
    """A signed provider response confirms that this AppID is not bound to the merchant."""


class PaymentVerificationError(Exception):
    """Untrusted or inconsistent provider message; never credit a ledger."""


class PaymentRequestUnknown(Exception):
    """The provider may have accepted the SAME order; never create a replacement."""


@dataclass(frozen=True)
class PaymentCallback:
    gateway: str
    order_no: str
    gateway_tx_id: str
    amount: Decimal
    currency: str
    account_binding: str


def account_binding(account_id: int) -> str:
    return f"account_{account_id}"


def cny_amount(value) -> Decimal:
    try:
        amount = Decimal(str(value))
        if (not amount.is_finite() or amount <= 0
                or amount > 1_000_000 or amount != amount.quantize(Decimal("0.01"))):
            raise ValueError
        return amount
    except (InvalidOperation, ValueError, TypeError):
        raise PaymentVerificationError("CNY amount must be positive yuan with at most two decimal places") from None


def json_object(raw: bytes | str) -> dict:
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    def reject_constant(_):
        raise ValueError("Non-finite JSON number")
    try:
        value = json.loads(raw, object_pairs_hook=unique,
                           parse_constant=reject_constant)
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (ValueError, UnicodeError):
        raise PaymentVerificationError("Invalid provider JSON") from None


def required_text(values: dict, key: str, max_length: int = 128) -> str:
    value = values.get(key)
    if (not isinstance(value, str) or not value or len(value) > max_length
            or any(ord(c) < 32 for c in value)):
        raise PaymentVerificationError(f"Invalid {key}")
    return value


def rsa_sign(key: rsa.RSAPrivateKey, message: bytes) -> str:
    return base64.b64encode(key.sign(message, padding.PKCS1v15(), hashes.SHA256())).decode("ascii")


def rsa_verify(key: rsa.RSAPublicKey, message: bytes, signature: str) -> None:
    try:
        raw = base64.b64decode(signature, validate=True)
        key.verify(raw, message, padding.PKCS1v15(), hashes.SHA256())
    except (InvalidSignature, ValueError, TypeError, binascii.Error):
        raise PaymentVerificationError("Invalid provider signature") from None
