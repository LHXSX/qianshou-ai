"""Authentication configuration validation.

Production must never derive authentication keys from unrelated secrets.  This
module validates configuration without returning or logging secret material.
"""
from __future__ import annotations

import os

from cryptography.fernet import Fernet


def environment_name() -> str:
    return (
        os.environ.get("V8_ENV")
        or os.environ.get("APP_ENV")
        or os.environ.get("ENVIRONMENT")
        or ""
    ).strip().lower()


def is_production() -> bool:
    return environment_name() in {"prod", "production"}


def validate_production_auth_config() -> None:
    """Fail fast when production authentication secrets are missing or weak."""
    if not is_production():
        return

    errors: list[str] = []
    jwt_secret = os.environ.get("V8_JWT_SECRET", "")
    if len(jwt_secret) < 32:
        errors.append("V8_JWT_SECRET 必须至少 32 字符")

    pepper = os.environ.get("V8_TRUSTED_DEVICE_PEPPER", "")
    if len(pepper.encode("utf-8")) < 32:
        errors.append("V8_TRUSTED_DEVICE_PEPPER 必须至少 32 字节")

    totp_key = os.environ.get("V8_TOTP_ENCRYPTION_KEY", "")
    try:
        Fernet(totp_key.encode("ascii"))
    except (ValueError, UnicodeError):
        errors.append("V8_TOTP_ENCRYPTION_KEY 必须是有效的 Fernet 密钥")

    if errors:
        raise RuntimeError("生产认证配置无效: " + "; ".join(errors))


def config_healthcheck() -> dict[str, str]:
    try:
        validate_production_auth_config()
        return {
            "auth_config": "ok",
            "environment": environment_name() or "development",
        }
    except RuntimeError as exc:
        return {"auth_config": "error", "detail": str(exc)}
