"""Trusted-device credential generation, lookup, and fixed-duration trust."""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from platform_v8.storage.repo import TrustedDeviceRepo


COOKIE_NAME = "we_trusted_device"
COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60
DURATION_DAYS: dict[str, int | None] = {
    "7d": 7,
    "30d": 30,
    "90d": 90,
    "permanent": None,
}


class TrustedDeviceError(Exception):
    """Trusted-device configuration or request error."""


@dataclass(frozen=True)
class DeviceResolution:
    device: dict
    credential: str
    registered: bool

    @property
    def device_id(self) -> str:
        return str(self.device["id"])


@dataclass(frozen=True)
class DevicePreparation:
    """Existing device, or a not-yet-persisted credential for MFA completion."""

    credential: str
    credential_hash: str
    metadata: dict
    device: dict | None = None
    # 指纹命中旧设备时需轮换凭证；凭 cookie 命中时不可轮换，否则客户端旧 cookie 立刻失效
    rotate_credential: bool = False

    @property
    def device_id(self) -> str | None:
        return str(self.device["id"]) if self.device else None


def _pepper() -> bytes:
    configured = os.environ.get("V8_TRUSTED_DEVICE_PEPPER", "").strip()
    if configured:
        if len(configured.encode("utf-8")) < 32:
            raise TrustedDeviceError(
                "V8_TRUSTED_DEVICE_PEPPER 至少需要 32 字节"
            )
        return configured.encode("utf-8")

    environment = (
        os.environ.get("V8_ENV")
        or os.environ.get("APP_ENV")
        or os.environ.get("ENVIRONMENT")
        or ""
    ).strip().lower()
    if environment in {"prod", "production"}:
        raise TrustedDeviceError(
            "生产环境必须配置 V8_TRUSTED_DEVICE_PEPPER"
        )

    source = (
        os.environ.get("V8_JWT_SECRET")
        or os.environ.get("V8_TOTP_ENCRYPTION_KEY")
        or os.environ.get("SECRET_KEY")
        or ""
    )
    if not source:
        raise TrustedDeviceError(
            "缺少可信设备 pepper，且没有可用于本地派生的现有密钥"
        )
    return hmac.new(
        source.encode("utf-8"),
        b"v8/trusted-device/local-pepper/v1",
        hashlib.sha256,
    ).digest()


def hash_credential(credential: str) -> str:
    """Hash an opaque credential without storing the raw value."""
    value = str(credential or "").strip()
    if not value or len(value) > 1024:
        raise TrustedDeviceError("设备凭证无效")
    return hmac.new(_pepper(), value.encode("utf-8"), hashlib.sha256).hexdigest()


def _new_credential() -> str:
    return secrets.token_urlsafe(32)


def resolve_for_account(
    s: Session,
    *,
    account_id: int,
    credential: str | None,
) -> dict | None:
    """Resolve only when the credential belongs to the authenticated account."""
    if not credential:
        return None
    try:
        row = TrustedDeviceRepo.by_credential_hash(
            s,
            hash_credential(credential),
        )
    except TrustedDeviceError:
        return None
    if row is None or int(row["account_id"]) != int(account_id):
        return None
    return row


def _fingerprint_from_metadata(metadata: dict | None) -> str | None:
    if not isinstance(metadata, dict):
        return None
    value = str(metadata.get("fingerprint") or "").strip()
    if not value or len(value) > 128:
        return None
    if not all(ch.isalnum() or ch in "-_" for ch in value):
        return None
    return value


def _reuse_by_fingerprint(
    s: Session,
    *,
    account_id: int,
    credential: str,
    credential_hash: str,
    metadata: dict,
) -> DeviceResolution | None:
    fingerprint = _fingerprint_from_metadata(metadata)
    if not fingerprint:
        return None
    existing = TrustedDeviceRepo.by_fingerprint_for_account(
        s,
        account_id,
        fingerprint,
    )
    if existing is None:
        return None
    refreshed = TrustedDeviceRepo.rotate_credential(
        s,
        str(existing["id"]),
        account_id,
        credential_hash,
        metadata_value=metadata,
    )
    return DeviceResolution(
        device=refreshed or existing,
        credential=credential,
        registered=False,
    )


def resolve_or_register(
    s: Session,
    *,
    account_id: int,
    credential: str | None,
    metadata: dict,
) -> DeviceResolution:
    """Resolve an account-owned credential or rotate to a new device record."""
    existing = resolve_for_account(
        s,
        account_id=account_id,
        credential=credential,
    )
    if existing is not None:
        TrustedDeviceRepo.touch(
            s,
            str(existing["id"]),
            account_id,
            metadata,
        )
        refreshed = TrustedDeviceRepo.by_id_for_account(
            s,
            str(existing["id"]),
            account_id,
        )
        return DeviceResolution(
            device=refreshed or existing,
            credential=str(credential),
            registered=False,
        )

    raw = _new_credential()
    reused = _reuse_by_fingerprint(
        s,
        account_id=account_id,
        credential=raw,
        credential_hash=hash_credential(raw),
        metadata=metadata,
    )
    if reused is not None:
        return reused

    device = TrustedDeviceRepo.create(
        s,
        device_id=str(uuid.uuid4()),
        credential_hash=hash_credential(raw),
        account_id=account_id,
        metadata_value=metadata,
    )
    return DeviceResolution(device=device, credential=raw, registered=True)


def prepare_for_login(
    s: Session,
    *,
    account_id: int,
    credential: str | None,
    metadata: dict,
) -> DevicePreparation:
    """Resolve an existing credential without persisting a new MFA-pending device."""
    existing = resolve_for_account(
        s,
        account_id=account_id,
        credential=credential,
    )
    if existing is not None:
        TrustedDeviceRepo.touch(
            s,
            str(existing["id"]),
            account_id,
            metadata,
        )
        refreshed = TrustedDeviceRepo.by_id_for_account(
            s,
            str(existing["id"]),
            account_id,
        )
        return DevicePreparation(
            credential=str(credential),
            credential_hash=hash_credential(str(credential)),
            metadata=metadata,
            device=refreshed or existing,
        )

    fingerprint = _fingerprint_from_metadata(metadata)
    if fingerprint:
        known = TrustedDeviceRepo.by_fingerprint_for_account(
            s,
            account_id,
            fingerprint,
        )
        if known is not None:
            # 不在 prepare 阶段绑定 device_id：否则 MFA 挑战会要求 cookie 已指向旧凭证，
            # 而新凭证要到 finalize 才写入。交给 finalize 按 fingerprint 复用并轮换。
            raw = _new_credential()
            return DevicePreparation(
                credential=raw,
                credential_hash=hash_credential(raw),
                metadata=metadata,
            )

    raw = _new_credential()
    return DevicePreparation(
        credential=raw,
        credential_hash=hash_credential(raw),
        metadata=metadata,
    )


def finalize_prepared(
    s: Session,
    *,
    account_id: int,
    preparation: DevicePreparation,
) -> DeviceResolution:
    """Persist a prepared credential only after all authentication checks pass."""
    if preparation.device is not None:
        if preparation.rotate_credential:
            refreshed = TrustedDeviceRepo.rotate_credential(
                s,
                str(preparation.device["id"]),
                account_id,
                preparation.credential_hash,
                metadata_value=preparation.metadata,
            )
        else:
            TrustedDeviceRepo.touch(
                s,
                str(preparation.device["id"]),
                account_id,
                preparation.metadata,
            )
            refreshed = TrustedDeviceRepo.by_id_for_account(
                s,
                str(preparation.device["id"]),
                account_id,
            )
        return DeviceResolution(
            device=refreshed or preparation.device,
            credential=preparation.credential,
            registered=False,
        )

    reused = _reuse_by_fingerprint(
        s,
        account_id=account_id,
        credential=preparation.credential,
        credential_hash=preparation.credential_hash,
        metadata=preparation.metadata,
    )
    if reused is not None:
        return reused

    device = TrustedDeviceRepo.create(
        s,
        device_id=str(uuid.uuid4()),
        credential_hash=preparation.credential_hash,
        account_id=account_id,
        metadata_value=preparation.metadata,
    )
    return DeviceResolution(
        device=device,
        credential=preparation.credential,
        registered=True,
    )


def by_id_for_account(
    s: Session,
    *,
    device_id: str,
    account_id: int,
) -> dict | None:
    return TrustedDeviceRepo.by_id_for_account(s, device_id, account_id)


def activate_trust(
    s: Session,
    *,
    device_id: str,
    account_id: int,
    duration: str,
) -> dict:
    """Activate one of the supported fixed, non-sliding trust durations."""
    if duration not in DURATION_DAYS:
        raise TrustedDeviceError("可信时长仅支持 7d、30d、90d 或 permanent")
    row = TrustedDeviceRepo.activate_trust(
        s,
        device_id,
        account_id,
        duration_days=DURATION_DAYS[duration],
    )
    if row is None:
        raise TrustedDeviceError("登录设备不存在")
    return row


def is_trusted(device: dict | None, *, now: datetime | None = None) -> bool:
    if not device or device.get("trusted_at") is None:
        return False
    if device.get("trust_revoked_at") is not None:
        return False
    if bool(device.get("trust_permanent")):
        return True
    trusted_until = device.get("trusted_until")
    if trusted_until is None:
        return False
    current = now
    if current is None:
        current = (
            datetime.now(tz=trusted_until.tzinfo)
            if getattr(trusted_until, "tzinfo", None)
            else datetime.utcnow()
        )
    return trusted_until > current


def mark_trusted_login(s: Session, *, device_id: str, account_id: int) -> None:
    TrustedDeviceRepo.mark_trusted_login(s, device_id, account_id)


def revoke(s: Session, *, device_id: str, account_id: int) -> bool:
    return TrustedDeviceRepo.revoke(s, device_id, account_id)


def revoke_many(s: Session, *, device_ids: list[str], account_id: int) -> int:
    return TrustedDeviceRepo.revoke_many(s, device_ids, account_id)


def revoke_all(s: Session, *, account_id: int) -> int:
    return TrustedDeviceRepo.revoke_all(s, account_id)


def public_trust_fields(device: dict | None) -> dict:
    """Return trust metadata without credential material."""
    return {
        "is_trusted": is_trusted(device),
        "trusted_at": device.get("trusted_at") if device else None,
        "trusted_until": device.get("trusted_until") if device else None,
        "trust_permanent": bool(device.get("trust_permanent")) if device else False,
    }
