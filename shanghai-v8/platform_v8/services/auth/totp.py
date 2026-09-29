"""TOTP 身份验证器的生成、加密与验证码校验。"""
from __future__ import annotations

import json
import hashlib
import os
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta

import pyotp
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.orm import Session

from platform_v8.storage.repo import AuthLoginChallengeRepo


SETUP_TTL_SECONDS = 600
LOGIN_CHALLENGE_TTL_SECONDS = 300
ISSUER = os.environ.get("V8_TOTP_ISSUER", "千手算力")


class TotpError(Exception):
    pass


def _unix_time() -> float:
    return time.time()


@dataclass(frozen=True)
class SetupData:
    setup_token: str
    secret: str
    otpauth_uri: str
    expires_in: int = SETUP_TTL_SECONDS


@dataclass(frozen=True)
class LoginChallengeData:
    challenge_id: str
    account_id: int
    device_id: str | None
    pending_credential_hash: str | None
    device_metadata: dict
    remember_me: bool


def _fernet() -> Fernet:
    raw_key = os.environ.get("V8_TOTP_ENCRYPTION_KEY", "").strip()
    if not raw_key:
        raise TotpError("TOTP 加密密钥未配置")
    try:
        return Fernet(raw_key.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as exc:
        raise TotpError("TOTP 加密密钥格式无效") from exc


def _normalize_code(code: str) -> str:
    normalized = "".join(ch for ch in str(code) if ch.isdigit())
    if len(normalized) != 6:
        raise TotpError("请输入 6 位动态验证码")
    return normalized


def create_setup(*, account_id: int, account_name: str) -> SetupData:
    secret = pyotp.random_base32()
    now = int(_unix_time())
    payload = {
        "account_id": int(account_id),
        "secret": secret,
        "exp": now + SETUP_TTL_SECONDS,
        "nonce": secrets.token_urlsafe(16),
    }
    setup_token = _fernet().encrypt(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    uri = pyotp.TOTP(secret).provisioning_uri(name=account_name, issuer_name=ISSUER)
    return SetupData(setup_token=setup_token, secret=secret, otpauth_uri=uri)


def confirm_setup(*, account_id: int, setup_token: str, code: str) -> str:
    try:
        raw = _fernet().decrypt(
            setup_token.encode("ascii"),
            ttl=SETUP_TTL_SECONDS,
        )
        payload = json.loads(raw.decode("utf-8"))
    except (InvalidToken, ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise TotpError("绑定会话已过期，请重新开始") from exc

    if int(payload.get("account_id", 0)) != int(account_id):
        raise TotpError("绑定会话与当前账户不匹配")
    if int(payload.get("exp", 0)) < int(_unix_time()):
        raise TotpError("绑定会话已过期，请重新开始")

    secret = str(payload.get("secret", ""))
    if not secret or not pyotp.TOTP(secret).verify(
        _normalize_code(code),
        valid_window=1,
    ):
        raise TotpError("动态验证码不正确")
    return encrypt_secret(secret)


def encrypt_secret(secret: str) -> str:
    if not secret:
        raise TotpError("TOTP 密钥为空")
    return _fernet().encrypt(secret.encode("ascii")).decode("ascii")


def decrypt_secret(secret_enc: str) -> str:
    try:
        return _fernet().decrypt(secret_enc.encode("ascii")).decode("ascii")
    except (InvalidToken, ValueError, UnicodeError) as exc:
        raise TotpError("无法读取身份验证器配置") from exc


def verify_code(secret_enc: str, code: str) -> bool:
    return counter_for_code(secret_enc, code) is not None


def counter_for_code(
    secret_enc: str,
    code: str,
    *,
    at_time: int | None = None,
) -> int | None:
    """Return the matching TOTP counter so callers can persist replay state."""
    secret = decrypt_secret(secret_enc)
    normalized = _normalize_code(code)
    totp = pyotp.TOTP(secret)
    timestamp = int(_unix_time()) if at_time is None else int(at_time)
    current_counter = timestamp // int(totp.interval)
    for counter in range(current_counter - 1, current_counter + 2):
        if secrets.compare_digest(totp.at(counter * int(totp.interval)), normalized):
            return counter
    return None


def create_login_challenge(
    s: Session,
    *,
    account_id: int,
    device_id: str | None = None,
    pending_credential_hash: str | None = None,
    device_metadata: dict | None = None,
    remember_me: bool = False,
) -> str:
    if device_id and pending_credential_hash:
        raise TotpError("两步验证设备绑定无效")
    raw = secrets.token_urlsafe(32)
    AuthLoginChallengeRepo.create(
        s,
        challenge_id=secrets.token_hex(18),
        token_hash=_challenge_hash(raw),
        account_id=account_id,
        device_id=device_id,
        pending_credential_hash=pending_credential_hash,
        device_metadata=device_metadata or {},
        remember_me=remember_me,
        expires_at=datetime.utcnow() + timedelta(seconds=LOGIN_CHALLENGE_TTL_SECONDS),
    )
    return raw


def _challenge_hash(challenge_token: str) -> str:
    value = str(challenge_token or "").strip()
    if not value or len(value) > 4096:
        raise TotpError("两步验证会话无效")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def resolve_login_challenge_data(
    s: Session,
    challenge_token: str,
) -> LoginChallengeData:
    row = AuthLoginChallengeRepo.active_by_token_hash(
        s,
        _challenge_hash(challenge_token),
    )
    if row is None:
        raise TotpError("两步验证会话已过期或已使用，请重新登录")
    return LoginChallengeData(
        challenge_id=str(row["id"]),
        account_id=int(row["account_id"]),
        device_id=str(row["device_id"]) if row.get("device_id") else None,
        pending_credential_hash=row.get("pending_credential_hash"),
        device_metadata=dict(row.get("device_metadata") or {}),
        remember_me=bool(row.get("remember_me")),
    )


def consume_login_challenge(s: Session, challenge_id: str) -> None:
    """Atomically consume a challenge, rejecting concurrent/replayed completion."""
    if not AuthLoginChallengeRepo.consume(s, challenge_id):
        raise TotpError("两步验证会话已过期或已使用，请重新登录")
