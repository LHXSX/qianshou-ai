"""Shared v8 access-token and session validation for HTTP and WebSockets."""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
from dataclasses import dataclass

import jwt
from sqlalchemy.orm import Session

from platform_v8.services.auth import revocation
from platform_v8.services.auth import token as token_svc
from platform_v8.storage.repo import AccountRepo, AuthSessionRepo

logger = logging.getLogger(__name__)

LEGACY_TOKEN_SUNSET = dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc)
LEGACY_V8_WS_REFRESH_SUNSET = dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc)


class AuthValidationError(Exception):
    """A token, account, or backing login session is not valid."""


@dataclass(frozen=True)
class ValidatedAccess:
    account: object
    claims: token_svc.TokenClaims


def validate_v8_access(
    s: Session,
    raw_token: str,
    *,
    touch: bool = True,
) -> ValidatedAccess:
    """Validate an access JWT, JTI, active SID, expiry, and active account."""
    try:
        claims = token_svc.verify_token(raw_token, expected_kind="access")
    except token_svc.TokenError as exc:
        raise AuthValidationError(str(exc)) from exc
    if not claims.jti or not claims.sid:
        raise AuthValidationError("旧版 v8 token 缺少会话信息 · 请重新登录")
    if revocation.is_jti_revoked(claims.jti):
        raise AuthValidationError("token 已吊销 · 请重新登录")
    if not AuthSessionRepo.is_active(s, claims.sid, claims.account_id):
        raise AuthValidationError("登录设备会话已退出或过期 · 请重新登录")
    account = AccountRepo.by_id(s, claims.account_id)
    if account is None:
        raise AuthValidationError("账号不存在")
    if not account.is_active:
        raise AuthValidationError(f"账号已 {account.status.value}")
    if touch:
        AuthSessionRepo.touch(s, claims.sid, claims.account_id)
    return ValidatedAccess(account=account, claims=claims)


def validate_legacy_token(
    raw_token: str,
    *,
    allowed_kinds: tuple[str, ...] = ("agent", "user"),
) -> tuple[int | str, str]:
    """Validate explicitly allowed legacy JWT kinds until the sunset date."""
    forced = os.environ.get("V1_TOKEN_SUNSET", "").lower() in {
        "1", "true", "yes",
    }
    if forced or dt.datetime.now(dt.timezone.utc) >= LEGACY_TOKEN_SUNSET:
        raise AuthValidationError(
            "v1 token 已停用 (sunset 2026-09-01) · 请升级客户端到 v8"
        )
    secret = os.environ.get("JWT_SECRET") or os.environ.get("SECRET_KEY", "")
    if not secret:
        raise AuthValidationError("服务器 legacy token 配置缺失")
    try:
        payload = jwt.decode(raw_token, secret, algorithms=["HS256"])
    except jwt.InvalidTokenError as exc:
        raise AuthValidationError(f"legacy token 无效: {exc}") from exc
    kind = str(payload.get("kind") or "")
    if kind not in allowed_kinds:
        raise AuthValidationError("legacy token 类型不允许")
    sub = payload.get("sub")
    if sub is None or str(sub).strip() == "":
        raise AuthValidationError("legacy token 无 sub")
    try:
        return int(sub), kind
    except (TypeError, ValueError):
        return str(sub), kind


def validate_legacy_v8_ws_refresh(
    s: Session,
    raw_token: str,
) -> ValidatedAccess:
    """Temporarily accept the refresh token used as WS auth by desktop 8.3.1."""
    disabled = os.environ.get("V8_WS_REFRESH_COMPAT_DISABLED", "").lower() in {
        "1",
        "true",
        "yes",
    }
    raw_sunset = os.environ.get("V8_WS_REFRESH_COMPAT_UNTIL", "").strip()
    sunset = LEGACY_V8_WS_REFRESH_SUNSET
    if raw_sunset:
        try:
            parsed = dt.datetime.fromisoformat(raw_sunset.replace("Z", "+00:00"))
            sunset = (
                parsed.replace(tzinfo=dt.timezone.utc)
                if parsed.tzinfo is None
                else parsed.astimezone(dt.timezone.utc)
            )
        except ValueError as exc:
            raise AuthValidationError(
                "V8_WS_REFRESH_COMPAT_UNTIL 必须是 ISO-8601 时间"
            ) from exc
    if disabled or dt.datetime.now(dt.timezone.utc) >= sunset:
        raise AuthValidationError(
            f"旧客户端 WS refresh token 已停用 (sunset {sunset.isoformat()})"
        )

    try:
        claims = token_svc.verify_token(raw_token, expected_kind="refresh")
    except token_svc.TokenError as exc:
        raise AuthValidationError(str(exc)) from exc

    account = AccountRepo.by_id(s, claims.account_id)
    if account is None:
        raise AuthValidationError("账号不存在")
    if not account.is_active:
        raise AuthValidationError(f"账号已 {account.status.value}")

    if claims.sid:
        row = AuthSessionRepo.by_id_for_account(s, claims.sid, claims.account_id)
        expected_jti_hash = hashlib.sha256(claims.jti.encode()).hexdigest()
        if (
            row is None
            or row["revoked_at"] is not None
            or row["refresh_jti_hash"] != expected_jti_hash
            or row["refresh_expires_at"] is None
            or row["refresh_expires_at"] <= dt.datetime.utcnow()
        ):
            raise AuthValidationError("旧客户端登录会话已退出、轮换或过期")
        AuthSessionRepo.touch(s, claims.sid, claims.account_id)
    else:
        logger.warning(
            "auth.legacy_v8_ws_refresh_without_sid account_id=%s sunset=%s",
            claims.account_id,
            sunset.isoformat(),
        )
    if claims.jti and revocation.is_jti_revoked(claims.jti):
        raise AuthValidationError("refresh token 已吊销")
    return ValidatedAccess(account=account, claims=claims)
