"""Control-only contract for an independent buyer-device installation probe.

This module accepts a signed observation from a separate installer service. It
does not sign installation receipts, run downloaded code, or enable purchasing.
The caller must persist and consume each challenge nonce exactly once before
creating the existing ten-minute installation receipt.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Mapping
from uuid import uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
_DEVICE = re.compile(r"[A-Za-z0-9_.:-]{8,128}\Z")
_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+_-]{0,255}\Z")
_KEY = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
_B64 = re.compile(r"[A-Za-z0-9_-]+={0,2}\Z")
_SCHEMA = "qianshou.order-adapter-device-probe.v1"
_CHECKS = frozenset({"archive_verified", "dependency_lock_verified",
                     "buyer_runtime_tree_verified", "samples_executed_on_device",
                     "node_session_binding_verified"})


class DeviceAttestationContractError(ValueError):
    """The independent observation is missing, stale or not bound to this device."""


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _decode(value: Any, length: int) -> bytes:
    if not isinstance(value, str) or len(value) > 128 or not _B64.fullmatch(value):
        raise DeviceAttestationContractError("独立安装证据编码非法")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as exc:
        raise DeviceAttestationContractError("独立安装证据编码非法") from exc
    if len(decoded) != length or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode() != value.rstrip("="):
        raise DeviceAttestationContractError("独立安装证据长度非法")
    return decoded


@dataclass(frozen=True)
class DeviceInstallChallenge:
    """Server-owned identity and immutable package details for one device probe."""

    nonce: str
    product_id: str
    entitlement_id: str
    buyer_id: int
    publication_id: str
    device_id: str
    archive_digest: str
    archive_version_id: str
    artifact_digest: str
    reviewed_seller_runtime_digest: str
    issued_at: int
    expires_at: int


def new_device_install_challenge(*, product_id: str, entitlement_id: str,
                                 buyer_id: int, publication_id: str, device_id: str,
                                 archive_digest: str, archive_version_id: str,
                                 artifact_digest: str,
                                 reviewed_seller_runtime_digest: str,
                                 now: int | None = None) -> DeviceInstallChallenge:
    """Build a short-lived challenge from a persisted entitlement and online node binding."""
    issued = int(time.time()) if now is None else now
    if (any(not isinstance(value, str) or not _UUID.fullmatch(value)
            for value in (product_id, entitlement_id, publication_id))
            or type(buyer_id) is not int or buyer_id < 1
            or not isinstance(device_id, str) or not _DEVICE.fullmatch(device_id)
            or any(not isinstance(value, str) or not _DIGEST.fullmatch(value)
                   for value in (archive_digest, artifact_digest,
                                 reviewed_seller_runtime_digest))
            or not isinstance(archive_version_id, str)
            or not _VERSION.fullmatch(archive_version_id)
            or type(issued) is not int or issued < 1):
        raise DeviceAttestationContractError("设备挑战身份或归档信息非法")
    return DeviceInstallChallenge(
        nonce=str(uuid4()), product_id=product_id, entitlement_id=entitlement_id,
        buyer_id=buyer_id, publication_id=publication_id, device_id=device_id,
        archive_digest=archive_digest, archive_version_id=archive_version_id,
        artifact_digest=artifact_digest,
        reviewed_seller_runtime_digest=reviewed_seller_runtime_digest,
        issued_at=issued, expires_at=issued + 120)


def verify_independent_device_probe(challenge: DeviceInstallChallenge,
                                    envelope: Any, *,
                                    trusted_probe_keys: Mapping[str, bytes],
                                    now: int | None = None) -> dict[str, str]:
    """Check a purpose-pinned attestor signature and every buyer/device observation.

    The attestor must itself fetch the immutable archive, inspect the installed
    tree on the named online device, and challenge-run samples there. A PC
    self-report or a replay of the same sample on the attestor is insufficient.
    """
    checked = int(time.time()) if now is None else now
    fields = {"schema", "result", "challenge_nonce", "product_id",
              "entitlement_id", "buyer_id", "publication_id", "device_id",
              "archive_digest", "archive_version_id", "artifact_digest",
              "reviewed_seller_runtime_digest", "runtime_digest", "checks",
              "sample_count", "issued_at", "expires_at"}
    try:
        if (not isinstance(envelope, dict)
                or set(envelope) != {"key_id", "payload", "signature"}
                or len(_canonical(envelope)) > 8192):
            raise DeviceAttestationContractError("独立设备证据格式非法")
        key_id = envelope["key_id"]
        payload = envelope["payload"]
        if (not isinstance(key_id, str) or not _KEY.fullmatch(key_id)
                or not isinstance(payload, dict) or set(payload) != fields):
            raise DeviceAttestationContractError("独立设备证据字段非法")
        key_bytes = trusted_probe_keys.get(key_id)
        if not isinstance(key_bytes, bytes) or len(key_bytes) != 32:
            raise DeviceAttestationContractError("独立设备探测签发方未获信任")
        Ed25519PublicKey.from_public_bytes(key_bytes).verify(
            _decode(envelope["signature"], 64), _canonical(payload))
        expected = {
            "product_id": challenge.product_id,
            "entitlement_id": challenge.entitlement_id,
            "buyer_id": challenge.buyer_id,
            "publication_id": challenge.publication_id,
            "device_id": challenge.device_id,
            "archive_digest": challenge.archive_digest,
            "archive_version_id": challenge.archive_version_id,
            "artifact_digest": challenge.artifact_digest,
            "reviewed_seller_runtime_digest": challenge.reviewed_seller_runtime_digest,
        }
        if (payload["schema"] != _SCHEMA or payload["result"] != "pass"
                or payload["challenge_nonce"] != challenge.nonce
                or any(payload[key] != value for key, value in expected.items())
                or not isinstance(payload["runtime_digest"], str)
                or not _DIGEST.fullmatch(payload["runtime_digest"])
                or not isinstance(payload["checks"], dict)
                or set(payload["checks"]) != _CHECKS
                or any(value is not True for value in payload["checks"].values())
                or type(payload["sample_count"]) is not int
                or not 1 <= payload["sample_count"] <= 8
                or type(payload["issued_at"]) is not int
                or type(payload["expires_at"]) is not int
                or payload["issued_at"] < challenge.issued_at
                or payload["issued_at"] > checked + 30
                or payload["expires_at"] <= checked
                or payload["expires_at"] > challenge.expires_at
                or payload["expires_at"] - payload["issued_at"] > 120
                or checked >= challenge.expires_at):
            raise DeviceAttestationContractError("独立设备探测结果未绑定本次购买和在线设备")
        return {"runtime_digest": payload["runtime_digest"],
                "probe_key_id": key_id,
                "probe_sha256": hashlib.sha256(_canonical(payload)).hexdigest()}
    except (InvalidSignature, ValueError, TypeError, KeyError) as exc:
        if isinstance(exc, DeviceAttestationContractError):
            raise
        raise DeviceAttestationContractError("独立设备探测签名或字段无效") from exc
