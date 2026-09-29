"""Issue short-lived viewer grants for independently verified result files.

Shanghai signs only ownership and result metadata. Guangzhou reads the exact
locked object version and serves its bytes directly to the authenticated PC.
"""
from __future__ import annotations

import base64
import json
import os
import re
import stat
import time
from pathlib import Path
from typing import Any, Iterable

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from platform_v8.protocol.artifact import parse_artifact_ref, validate_artifact_against_context

SCHEMA = "qianshou.media-view-grant.v1"
AUDIENCE = "guangzhou-result-media"
_KEY_ID = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
_DIGEST = re.compile(r"[a-f0-9]{64}\Z")
_MEDIA_TYPES = frozenset({
    "image/png", "image/jpeg", "image/webp", "image/gif",
    "video/mp4", "video/webm", "video/quicktime",
})
MAX_MEDIA_BYTES = 64 * 1024 * 1024


class MediaViewUnavailable(RuntimeError):
    """The signed, verified delivery path is not ready."""


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _signer() -> tuple[str, Ed25519PrivateKey]:
    location = os.environ.get("V8_MEDIA_VIEW_SIGNING_PRIVATE_KEY_FILE", "")
    key_id = os.environ.get("V8_MEDIA_VIEW_SIGNING_KEY_ID", "")
    if not location or not _KEY_ID.fullmatch(key_id):
        raise MediaViewUnavailable("media viewer signer is not configured")
    try:
        path = Path(location)
        info = path.lstat()
        if (not path.is_absolute() or not stat.S_ISREG(info.st_mode)
                or info.st_mode & 0o077 or info.st_size > 16 * 1024):
            raise MediaViewUnavailable("media viewer signing key permissions invalid")
        private = serialization.load_pem_private_key(path.read_bytes(), password=None)
        if not isinstance(private, Ed25519PrivateKey):
            raise MediaViewUnavailable("media viewer signer must be Ed25519")
        return key_id, private
    except (OSError, TypeError, ValueError) as exc:
        raise MediaViewUnavailable("media viewer signer unavailable") from exc


def attested_asset(workload: Any, shards: Iterable[Any], asset_id: str,
                   verification_by_shard: dict[str, dict[str, Any] | None]) -> dict[str, Any] | None:
    """Find one finalized asset backed by a persisted independent verifier receipt."""
    if not _DIGEST.fullmatch(asset_id) or getattr(workload.status, "value", None) != "DONE" \
            or workload.result is None:
        return None
    matches: list[dict[str, Any]] = []
    for shard in shards:
        if getattr(shard.status, "value", None) != "DONE":
            continue
        art = parse_artifact_ref(shard.output_ref)
        if art is None or art.sha256 != asset_id or art.content_type not in _MEDIA_TYPES \
                or not 1 <= art.size_bytes <= MAX_MEDIA_BYTES or not art.object_version_id:
            continue
        try:
            validate_artifact_against_context(
                art, account_id=int(workload.owner_id), workload_id=str(workload.id),
                shard_id=str(shard.id),
            )
        except ValueError:
            continue
        verified = (shard.metadata or {}).get("result_verification")
        receipt = verified.get("external_media_receipt") if isinstance(verified, dict) else None
        observed = receipt.get("observed") if isinstance(receipt, dict) else None
        row = verification_by_shard.get(str(shard.id))
        if (not isinstance(verified, dict) or verified.get("disposition") != "VERIFIED"
                or verified.get("semantic_contract") != "external-media.v1"
                or verified.get("sha256") != asset_id
                or verified.get("object_key") != art.object_key
                or not isinstance(observed, dict)
                or observed.get("sha256") != asset_id
                or observed.get("size_bytes") != art.size_bytes
                or observed.get("content_type") != art.content_type
                or not isinstance(row, dict) or row.get("state") != "SUCCEEDED"
                or row.get("disposition") != "VERIFIED"
                or row.get("content_sha256") != asset_id
                or row.get("worker_id") is None
                or shard.worker_id is None
                or str(row.get("worker_id")) != str(shard.worker_id)
                or row.get("attempt") != shard.attempts
                or row.get("artifact") != art.model_dump(by_alias=True)):
            continue
        matches.append({
            "object_key": art.object_key,
            "object_version_id": art.object_version_id,
            "sha256": art.sha256,
            "size_bytes": art.size_bytes,
            "content_type": art.content_type,
        })
    return matches[0] if len(matches) == 1 else None


def issue(*, account_id: int, task_id: str, asset_id: str, bucket: str,
          asset: dict[str, Any], now: int | None = None) -> str:
    """Return a purpose-pinned Ed25519 envelope accepted by Guangzhou."""
    if (type(account_id) is not int or account_id < 1
            or not isinstance(task_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", task_id)
            or not _DIGEST.fullmatch(asset_id)
            or not isinstance(bucket, str) or not bucket or "/" in bucket
            or asset.get("sha256") != asset_id
            or not isinstance(asset.get("object_key"), str)
            or not asset["object_key"].startswith(f"v8/account-{account_id}/")
            or not isinstance(asset.get("object_version_id"), str)
            or not re.fullmatch(r"[A-Za-z0-9_.~+-]{1,200}", asset["object_version_id"])
            or asset["object_version_id"] == "null"
            or type(asset.get("size_bytes")) is not int
            or not 1 <= asset["size_bytes"] <= MAX_MEDIA_BYTES
            or asset.get("content_type") not in _MEDIA_TYPES):
        raise ValueError("media grant metadata invalid")
    key_id, signer = _signer()
    issued = int(time.time()) if now is None else now
    payload = {
        "schema": SCHEMA, "audience": AUDIENCE,
        "account_id": account_id, "task_id": task_id, "asset_id": asset_id,
        "bucket": bucket, **asset,
        "result_finalized": True, "media_attested": True,
        "issued_at": issued, "expires_at": issued + 60,
    }
    signature = base64.urlsafe_b64encode(signer.sign(_canonical(payload))).rstrip(b"=").decode("ascii")
    envelope = {"key_id": key_id, "payload": payload, "signature": signature}
    return base64.urlsafe_b64encode(_canonical(envelope)).rstrip(b"=").decode("ascii")
