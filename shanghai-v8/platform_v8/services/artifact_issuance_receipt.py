"""Shanghai control-plane signature for a server-issued result upload grant.

The receipt contains only identifiers and declared hashes. Guangzhou can use
it to authenticate sample order ownership, then independently read the exact
OSS object version and media bytes. A request-supplied key is never trusted.
"""
from __future__ import annotations

import base64
import json
import os
import re
import stat
import time
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

SCHEMA = "qianshou.artifact-upload-issuance.v1"
_KEY_ID = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")
_VERSION = re.compile(r"[A-Za-z0-9_.~+-]{1,200}\Z")


class IssuanceReceiptConfigurationError(RuntimeError):
    pass


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _signer() -> tuple[str, Ed25519PrivateKey] | None:
    path = os.environ.get("V8_ARTIFACT_ISSUANCE_SIGNING_PRIVATE_KEY_FILE", "")
    key_id = os.environ.get("V8_ARTIFACT_ISSUANCE_SIGNING_KEY_ID", "")
    if not path and not key_id:
        return None
    if not path or not _KEY_ID.fullmatch(key_id):
        raise IssuanceReceiptConfigurationError("artifact issuance signer incomplete")
    try:
        candidate = Path(path)
        metadata = candidate.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
            raise IssuanceReceiptConfigurationError("artifact issuance key permissions invalid")
        loaded = serialization.load_pem_private_key(candidate.read_bytes(), password=None)
        if not isinstance(loaded, Ed25519PrivateKey):
            raise IssuanceReceiptConfigurationError("artifact issuance key must be Ed25519")
        return key_id, loaded
    except (OSError, TypeError, ValueError) as exc:
        raise IssuanceReceiptConfigurationError("artifact issuance signer unavailable") from exc


def signer_available() -> bool:
    return _signer() is not None


def issue(
    *, account_id: int, workload_id: str, shard_id: str, worker_id: str,
    attempt: int, result_id: str, object_key: str, sha256: str,
    size_bytes: int, content_type: str, issued_at: int, expires_at: int,
) -> dict[str, Any] | None:
    configured = _signer()
    if configured is None:
        return None
    key_id, signer = configured
    if (type(account_id) is not int or account_id < 1
            or type(attempt) is not int or attempt < 0
            or type(size_bytes) is not int or size_bytes < 1
            or type(issued_at) is not int or type(expires_at) is not int
            or expires_at <= issued_at
            or not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256)
            or not all(isinstance(value, str) and value for value in (
                workload_id, shard_id, worker_id, result_id, object_key, content_type))):
        raise ValueError("artifact issuance metadata invalid")
    payload = {
        "schema": SCHEMA, "issuance_id": str(uuid4()),
        "account_id": account_id, "workload_id": workload_id,
        "shard_id": shard_id, "worker_id": worker_id, "attempt": attempt,
        "result_id": result_id, "object_key": object_key,
        "sha256": sha256, "size_bytes": size_bytes,
        "content_type": content_type, "issued_at": issued_at,
        "expires_at": expires_at,
    }
    signature = signer.sign(_canonical(payload))
    return {"key_id": key_id, "payload": payload,
            "signature": base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")}


def official_image_read_scope(receipt: dict, version_id: str, *,
                              worker_id: str, now: int | None = None) -> str:
    """Verify a signed upload grant before issuing one-object read STS.

    The caller-supplied VersionId is bound into the credential response and
    rechecked on Guangzhou's exact-version HEAD/GET. COS IAM is restricted to
    this one object key; Shanghai never reads its media bytes.
    """
    configured = _signer()
    current = int(time.time()) if now is None else now
    if (configured is None or not isinstance(receipt, dict)
            or set(receipt) != {"key_id", "payload", "signature"}
            or receipt.get("key_id") != configured[0]
            or not isinstance(version_id, str) or not _VERSION.fullmatch(version_id)
            or version_id == "null" or not isinstance(worker_id, str)
            or not _ID.fullmatch(worker_id)):
        raise ValueError("official image read authorization unavailable")
    payload = receipt["payload"]
    signature = receipt["signature"]
    if (not isinstance(payload, dict) or not isinstance(signature, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{86}", signature)):
        raise ValueError("official image upload receipt invalid")
    signed_fields = {"schema", "issuance_id", "account_id", "workload_id",
                     "shard_id", "worker_id", "attempt", "result_id",
                     "object_key", "sha256", "size_bytes", "content_type",
                     "issued_at", "expires_at"}
    account_id = payload.get("account_id")
    if (set(payload) != signed_fields or payload.get("schema") != SCHEMA
            or type(account_id) is not int or account_id < 1
            or type(payload.get("attempt")) is not int or payload["attempt"] < 0
            or type(payload.get("size_bytes")) is not int
            or not 1 <= payload["size_bytes"] <= 16 * 1024 * 1024
            or type(payload.get("issued_at")) is not int
            or type(payload.get("expires_at")) is not int
            or not current - 3900 <= payload["issued_at"] <= current + 60
            or not current + 30 <= payload["expires_at"] <= current + 3900
            or payload.get("worker_id") != worker_id
            or not isinstance(payload.get("issuance_id"), str)
            or not _canonical_uuid(payload["issuance_id"])
            or payload.get("content_type") != "image/png"
            or not isinstance(payload.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", payload["sha256"])
            or any(not isinstance(payload.get(name), str)
                   or not _ID.fullmatch(payload[name])
                   for name in ("workload_id", "shard_id", "result_id"))):
        raise ValueError("official image upload receipt scope invalid")
    key = (f"v8/account-{account_id}/workload-{payload['workload_id']}/"
           f"shard-{payload['shard_id']}/result/{payload['result_id']}/result.png")
    if payload.get("object_key") != key:
        raise ValueError("official image upload receipt object invalid")
    try:
        raw = base64.urlsafe_b64decode(signature + "==")
        if len(raw) != 64 or base64.urlsafe_b64encode(raw).rstrip(b"=").decode() != signature:
            raise ValueError("noncanonical official image upload signature")
        configured[1].public_key().verify(raw, _canonical(payload))
    except (InvalidSignature, ValueError, TypeError) as exc:
        raise ValueError("official image upload receipt signature invalid") from exc
    return key


def _canonical_uuid(value: str) -> bool:
    try:
        return str(UUID(value)) == value
    except ValueError:
        return False
