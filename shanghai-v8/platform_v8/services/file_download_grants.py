"""Owner-only, purpose-isolated download grants; Shanghai reads metadata only."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from uuid import UUID

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from platform_v8.protocol.artifact import parse_artifact_ref, validate_artifact_against_context
from platform_v8.protocol.generic_file import (BOUND_FIELDS, FILE_POLICY, MAX_FILE_BYTES, RESULT_SCHEMA,
                                              canonical, file_schema_sha256, validate_file_schema)
from platform_v8.services.external_file_verifier import build_request
from platform_v8.services.file_assignment_contract import project_file_assignment_contract

SCHEMA = "qianshou.file-download-grant.v1"
AUDIENCE = "guangzhou-result-file"
PURPOSE = "qianshou:file-result-download"
_KEY_ID = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
_HEX = re.compile(r"[a-f0-9]{64}\Z")
_SHA = re.compile(r"sha256:[a-f0-9]{64}\Z")
_RECEIPT_FIELDS = BOUND_FIELDS | {"schema", "purpose", "result", "observed", "receipt_id", "issued_at", "expires_at"}
ASSET_FIELDS = {"workload_id", "shard_id", "result_id", "worker_id", "attempt", "task_type",
                "contract_sha256", "file_schema_sha256", "object_key", "object_version_id", "filename",
                "sha256", "size_bytes", "content_type", "policy_id", "receipt_id", "receipt_sha256"}
PAYLOAD_FIELDS = ASSET_FIELDS | {"schema", "audience", "purpose", "account_id", "task_id", "asset_id", "bucket",
                               "result_finalized", "file_bytes_attested", "issued_at", "expires_at"}


class FileDownloadUnavailable(RuntimeError):
    """Dedicated trust enrollment or storage metadata is unavailable."""


def _decode(value: Any, size: int, *, public_key: bool = False) -> bytes:
    pattern = r"[A-Za-z0-9_-]+={0,2}" if public_key else r"[A-Za-z0-9_-]+"
    if not isinstance(value, str) or len(value) > 128 or not re.fullmatch(pattern, value):
        raise ValueError("noncanonical base64url")
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    encoded = base64.urlsafe_b64encode(raw).decode()
    allowed = {encoded.rstrip("="), encoded} if public_key else {encoded.rstrip("=")}
    if len(raw) != size or value not in allowed:
        raise ValueError("invalid base64url size")
    return raw


def _uuid(value: Any) -> bool:
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (TypeError, ValueError):
        return False


def _roots() -> tuple[str, bytes, bytes, frozenset[bytes]]:
    """Explicit file roots only; ordinary/media/install roots never fill a missing key."""
    try:
        verifier_id = os.environ.get("V8_EXTERNAL_FILE_VERIFIER_KEY_ID", "")
        if not _KEY_ID.fullmatch(verifier_id):
            raise ValueError("missing file verifier key id")
        verifier = _decode(os.environ.get("V8_EXTERNAL_FILE_VERIFIER_PUBLIC_KEY"), 32, public_key=True)
        viewer = _decode(os.environ.get("V8_FILE_DOWNLOAD_SIGNING_PUBLIC_KEY"), 32, public_key=True)
        raw_forbidden = os.environ.get("V8_FILE_DOWNLOAD_FORBIDDEN_PUBLIC_KEYS", "")
        if len(raw_forbidden) > 16 * 1024:
            raise ValueError("too many forbidden roots")
        values = json.loads(raw_forbidden)
        if not isinstance(values, list) or not 1 <= len(values) <= 64:
            raise ValueError("explicit purpose separation roots missing")
        forbidden = frozenset(_decode(value, 32, public_key=True) for value in values)
        if viewer == verifier or viewer in forbidden or verifier in forbidden:
            raise ValueError("file trust roots reuse another purpose")
        return verifier_id, verifier, viewer, forbidden
    except (TypeError, ValueError) as exc:
        raise FileDownloadUnavailable("dedicated file download trust roots unavailable") from exc


def _signer() -> tuple[str, Ed25519PrivateKey]:
    _, _, enrolled, _ = _roots()
    location = os.environ.get("V8_FILE_DOWNLOAD_SIGNING_PRIVATE_KEY_FILE", "")
    key_id = os.environ.get("V8_FILE_DOWNLOAD_SIGNING_KEY_ID", "")
    if not location or not _KEY_ID.fullmatch(key_id):
        raise FileDownloadUnavailable("file download signer is not configured")
    try:
        path = Path(location)
        before = path.lstat()
        if (not path.is_absolute() or not stat.S_ISREG(before.st_mode)
                or before.st_mode & 0o077 or not 1 <= before.st_size <= 16 * 1024):
            raise ValueError("private key permissions invalid")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077
                    or (info.st_dev, info.st_ino) != (before.st_dev, before.st_ino)):
                raise ValueError("private key changed while opening")
            encoded = stream.read(16 * 1024 + 1)
        if len(encoded) > 16 * 1024:
            raise ValueError("private key too large")
        private = serialization.load_pem_private_key(encoded, password=None)
        if not isinstance(private, Ed25519PrivateKey):
            raise ValueError("file signer must be Ed25519")
        actual = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        if actual != enrolled:
            raise ValueError("file signer differs from enrolled download root")
        return key_id, private
    except (OSError, TypeError, ValueError) as exc:
        raise FileDownloadUnavailable("file download signer unavailable") from exc


def bucket() -> str:
    """Only configured locked evidence metadata; do not instantiate an object reader."""
    from platform_v8.services.workers.task_adapter_evidence_sts import BUCKET, REGION
    prefix = "V8_TASK_ADAPTER_EVIDENCE_OSS_"
    if (os.environ.get("V8_TASK_ADAPTER_EVIDENCE_ENABLED") != "1"
            or os.environ.get("V8_TASK_ADAPTER_EVIDENCE_COS_MD5_LOCK_VERIFIED") != "1"
            or os.environ.get(prefix + "PROVIDER") != "cos"
            or os.environ.get(prefix + "BUCKET") != BUCKET
            or os.environ.get(prefix + "REGION") != REGION
            or os.environ.get(prefix + "ENDPOINT") != "https://cos.ap-shanghai.myqcloud.com"):
        raise FileDownloadUnavailable("locked file evidence bucket unavailable")
    return BUCKET


def _consumed_receipt(receipt: Any, *, request: dict, consumed_at: Any, now: int) -> dict:
    """Recheck a historical signature against its durable successful consumption time."""
    verifier_id, verifier, _, _ = _roots()
    if (not isinstance(receipt, dict) or set(receipt) != {"key_id", "payload", "signature"}
            or receipt.get("key_id") != verifier_id or len(canonical(receipt)) > 16 * 1024):
        raise ValueError("file receipt envelope invalid")
    payload = receipt.get("payload")
    if (not isinstance(payload, dict) or set(payload) != _RECEIPT_FIELDS
            or payload.get("schema") != RESULT_SCHEMA or payload.get("purpose") != "qianshou:file-bytes-verifier"
            or payload.get("result") != "pass" or not _uuid(payload.get("receipt_id"))
            or any(payload.get(field) != request[field] for field in BOUND_FIELDS)):
        raise ValueError("file receipt binding invalid")
    Ed25519PublicKey.from_public_bytes(verifier).verify(_decode(receipt["signature"], 64), canonical(payload))
    issued, expires = payload.get("issued_at"), payload.get("expires_at")
    if not isinstance(consumed_at, datetime):
        raise ValueError("durable receipt consumption time missing")
    consumed = consumed_at.replace(tzinfo=timezone.utc) if consumed_at.tzinfo is None else consumed_at
    consumed_seconds = consumed.timestamp()
    if (type(issued) is not int or type(expires) is not int or issued <= 0
            or not 0 < expires - issued <= 60 or not issued <= consumed_seconds < expires
            or consumed_seconds > now + 30):
        raise ValueError("receipt was not consumed while valid")
    observed = payload.get("observed")
    if (not isinstance(observed, dict) or set(observed) != {
            "size_bytes", "sha256", "encoding_verified", "machine_semantics_verified", "media_semantics_verified"}
            or type(observed.get("size_bytes")) is not int or observed["size_bytes"] != request["size_bytes"]
            or observed.get("sha256") != request["sha256"]
            or observed.get("encoding_verified") != request["file_schema"]["outputs"][0]["encoding"]
            or observed.get("machine_semantics_verified") is not False
            or observed.get("media_semantics_verified") is not False):
        raise ValueError("file observed proof invalid")
    return payload


def _reviewed_contract(workload: Any) -> tuple[dict, dict]:
    from platform_v8.engine.task_registry import get_spec
    from platform_v8.services.workers.task_adapter_review_issuer import task_contract_sha256
    bound = (workload.spec.requirements or {}).get("_reviewed_task_contract")
    if (not isinstance(bound, dict) or set(bound) != {"schema", "contract_sha256", "result_strategy", "output_kind",
            "output_schema_sha256", "contract_version", "file_schema_sha256"}
            or bound.get("schema") != "qianshou.reviewed-workload-contract.v1"
            or bound.get("result_strategy") != FILE_POLICY or bound.get("output_kind") != "artifact_ref"
            or bound.get("contract_version") != "v1" or not isinstance(bound.get("contract_sha256"), str)
            or not _SHA.fullmatch(bound["contract_sha256"])
            or workload.spec.verification_policy != "artifact"
            or (workload.spec.params or {}).get("review_sample_only") is True):
        raise ValueError("frozen reviewed file contract unavailable")
    spec = get_spec(workload.spec.task_type)
    schema = validate_file_schema(spec.adapter_file_schema)
    if (spec.task_type != workload.spec.task_type or not spec.requires_verified_adapter or spec.adapter_output_kind != "artifact_ref"
            or spec.adapter_result_strategy != FILE_POLICY or not spec.external_artifact_verifier_required
            or bound["file_schema_sha256"] != file_schema_sha256(schema)
            or bound["output_schema_sha256"] != "sha256:" + hashlib.sha256(canonical(spec.adapter_output_schema)).hexdigest()):
        raise ValueError("current file declaration differs from frozen review")
    submission = {"contract_version": "v1", "capability_id": spec.adapter_capability_id,
                  "input_kinds": list(spec.accepted_input_kinds), "output_kind": spec.adapter_output_kind}
    if task_contract_sha256(submission, spec) != bound["contract_sha256"]:
        raise ValueError("current reviewed contract digest differs from frozen review")
    frozen = project_file_assignment_contract(workload, task_type=workload.spec.task_type)
    if frozen is None or frozen["contract_sha256"] != bound["contract_sha256"]:
        raise ValueError("frozen file attachment bindings unavailable")
    return bound, schema


def attested_asset(workload: Any, shards: Iterable[Any], asset_id: str,
                   verification_by_shard: dict[str, dict[str, Any] | None], *, now: int | None = None) -> dict | None:
    """Select exactly one current, finalized, independently attested owned result."""
    if (not isinstance(asset_id, str) or not _HEX.fullmatch(asset_id)
            or getattr(workload.status, "value", None) != "DONE" or workload.result is None):
        return None
    current_time = int(time.time()) if now is None else now
    try:
        bound, schema = _reviewed_contract(workload)
    except (ValueError, TypeError, AttributeError, KeyError):
        return None
    matches = []
    for shard in shards:
        try:
            if (getattr(shard.status, "value", None) != "DONE"
                    or str(shard.workload_id) != str(workload.id) or shard.worker_id is None):
                continue
            art = parse_artifact_ref(shard.output_ref)
            if art is None or art.sha256 != asset_id or shard.output_ref != art.to_storage_ref():
                continue
            raw = art.model_dump(by_alias=True)
            validate_artifact_against_context(art, account_id=int(workload.owner_id),
                                              workload_id=str(workload.id), shard_id=str(shard.id))
            row = verification_by_shard.get(str(shard.id))
            verified = (shard.metadata or {}).get("result_verification")
            if (not isinstance(row, dict) or row.get("state") != "SUCCEEDED"
                    or row.get("disposition") != "ARTIFACT_VERIFIED" or row.get("requested_policy") != "artifact"
                    or row.get("verifier_key") != f"external-file.{workload.spec.task_type}.v1"
                    or str(row.get("shard_id")) != str(shard.id) or str(row.get("workload_id")) != str(workload.id)
                    or str(row.get("worker_id")) != str(shard.worker_id) or type(row.get("attempt")) is not int
                    or type(shard.attempts) is not int or row["attempt"] != shard.attempts
                    or row.get("artifact") != raw or row.get("content_sha256") != asset_id
                    or not isinstance(verified, dict) or not isinstance(row.get("evidence"), dict)):
                continue
            evidence = row["evidence"]
            expected = {"kind": "artifact.v1", "size_bytes": art.size_bytes, "sha256": asset_id,
                        "object_key": art.object_key, "result_id": art.result_id, "policy": "artifact",
                        "actual_disposition": "artifact", "semantic_contract": "artifact-integrity.v1",
                        "disposition": "ARTIFACT_VERIFIED", "machine_semantics_verified": False,
                        "media_semantics_verified": False, "file_schema_sha256": bound["file_schema_sha256"]}
            if (any(verified.get(key) != value or evidence.get(key) != value for key, value in expected.items())
                    or verified.get("machine_semantics_verified") is not False
                    or verified.get("media_semantics_verified") is not False
                    or evidence.get("machine_semantics_verified") is not False
                    or evidence.get("media_semantics_verified") is not False
                    or evidence.get("output_ref") != art.to_storage_ref()
                    or evidence.get("external_file_receipt") != verified.get("external_file_receipt")):
                continue
            receipt = evidence["external_file_receipt"]
            request = build_request(task_type=workload.spec.task_type, account_id=int(workload.owner_id),
                                    workload_id=str(workload.id), shard_id=str(shard.id), worker_id=str(shard.worker_id),
                                    attempt=shard.attempts, artifact=raw, file_schema=schema,
                                    nonce=receipt["payload"]["nonce"])
            payload = _consumed_receipt(receipt, request=request, consumed_at=row.get("updated_at"), now=current_time)
            matches.append({"workload_id": str(workload.id), "shard_id": str(shard.id), "result_id": art.result_id,
                "worker_id": str(shard.worker_id), "attempt": shard.attempts, "task_type": workload.spec.task_type,
                "contract_sha256": bound["contract_sha256"], "file_schema_sha256": bound["file_schema_sha256"],
                **{field: raw[field] for field in ("object_key", "object_version_id", "filename", "sha256", "size_bytes", "content_type")},
                "policy_id": FILE_POLICY, "receipt_id": payload["receipt_id"],
                "receipt_sha256": "sha256:" + hashlib.sha256(canonical(receipt)).hexdigest()})
        except (ValueError, TypeError, AttributeError, KeyError, InvalidSignature):
            continue
    return matches[0] if len(matches) == 1 else None


def issue(*, account_id: int, task_id: str, asset_id: str, bucket: str, asset: dict,
          now: int | None = None) -> str:
    """Sign one short grant after durable owner/result authorization."""
    from platform_v8.services.workers.task_adapter_evidence_sts import BUCKET
    if (type(account_id) is not int or account_id < 1 or not _uuid(task_id)
            or not isinstance(asset, dict) or set(asset) != ASSET_FIELDS
            or asset.get("workload_id") != task_id or not isinstance(asset_id, str) or not _HEX.fullmatch(asset_id)
            or asset.get("sha256") != asset_id or bucket != BUCKET
            or any(not _uuid(asset.get(field)) for field in ("workload_id", "shard_id", "result_id", "worker_id", "receipt_id"))
            or type(asset.get("attempt")) is not int or not 1 <= asset["attempt"] <= 1_000_000
            or not isinstance(asset.get("contract_sha256"), str) or not _SHA.fullmatch(asset["contract_sha256"])
            or not isinstance(asset.get("file_schema_sha256"), str) or not _HEX.fullmatch(asset["file_schema_sha256"])
            or not isinstance(asset.get("receipt_sha256"), str) or not _SHA.fullmatch(asset["receipt_sha256"])
            or asset.get("policy_id") != FILE_POLICY or type(asset.get("size_bytes")) is not int
            or not 1 <= asset["size_bytes"] <= MAX_FILE_BYTES
            or not isinstance(asset.get("object_version_id"), str)
            or not re.fullmatch(r"[A-Za-z0-9_.~+-]{1,200}", asset["object_version_id"])
            or asset["object_version_id"].lower() == "null"
            or not isinstance(asset.get("filename"), str) or ".." in asset["filename"]
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", asset["filename"])
            or asset.get("object_key") != (f"v8/account-{account_id}/workload-{task_id}/shard-{asset['shard_id']}/"
                                           f"result/{asset['result_id']}/{asset['filename']}")
            or not isinstance(asset.get("task_type"), str) or not re.fullmatch(r"[a-z][a-z0-9_]{2,63}", asset["task_type"])
            or not isinstance(asset.get("content_type"), str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}", asset["content_type"])):
        raise ValueError("file download grant metadata invalid")
    issued = int(time.time()) if now is None else now
    if type(issued) is not int or issued <= 0:
        raise ValueError("file download grant time invalid")
    key_id, signer = _signer()
    payload = {"schema": SCHEMA, "audience": AUDIENCE, "purpose": PURPOSE,
               "account_id": account_id, "task_id": task_id, "asset_id": asset_id, "bucket": bucket, **asset,
               "result_finalized": True, "file_bytes_attested": True, "issued_at": issued, "expires_at": issued + 60}
    signature = base64.urlsafe_b64encode(signer.sign(canonical(payload))).rstrip(b"=").decode()
    envelope = {"key_id": key_id, "payload": payload, "signature": signature}
    return base64.urlsafe_b64encode(canonical(envelope)).rstrip(b"=").decode()
