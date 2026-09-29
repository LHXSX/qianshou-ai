"""Consume separately enrolled Guangzhou file-byte receipts; Shanghai never reads bytes."""
from __future__ import annotations

import os
import re
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from platform_v8.protocol.generic_file import (BOUND_FIELDS, FILE_POLICY, HEALTH_SCHEMA,
                                              REQUEST_SCHEMA, RESULT_SCHEMA, file_schema_sha256,
                                              validate_file_request, validate_file_schema)
from platform_v8.services.external_media_verifier import (
    ExternalVerifierUnavailable, _Config, _decode, _post, _signed_payload,
)


class ExternalFileRejected(ValueError):
    """The separately trusted service checked these exact bytes and rejected them."""


def _config() -> _Config | None:
    # Separate trust enrollment is deliberate: a media key is not a file policy key.
    base = os.environ.get("V8_EXTERNAL_FILE_VERIFIER_URL", "").rstrip("/")
    token = os.environ.get("V8_EXTERNAL_FILE_VERIFIER_TOKEN", "")
    key = os.environ.get("V8_EXTERNAL_FILE_VERIFIER_PUBLIC_KEY", "")
    key_id = os.environ.get("V8_EXTERNAL_FILE_VERIFIER_KEY_ID", "")
    try:
        url = urlsplit(base)
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.query or url.fragment or len(base) > 1024
                or not 32 <= len(token) <= 2048 or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", key_id)):
            return None
        return _Config(base, token, key_id, Ed25519PublicKey.from_public_bytes(_decode(key, 32)), None)
    except (TypeError, ValueError):
        return None


def build_request(*, task_type: str, account_id: int, workload_id: str, shard_id: str,
                  worker_id: str, attempt: int, artifact: dict, file_schema: dict,
                  nonce: str | None = None) -> dict:
    schema = validate_file_schema(file_schema)
    request = {"schema": REQUEST_SCHEMA, "kind": "verify", "nonce": nonce or str(uuid4()),
               "policy_id": FILE_POLICY, "task_type": task_type, "account_id": account_id,
               "workload_id": workload_id, "shard_id": shard_id, "worker_id": worker_id, "attempt": attempt,
               "file_schema": schema, "file_schema_sha256": file_schema_sha256(schema),
               **{key: artifact.get(key) for key in ("object_key", "object_version_id", "result_id",
                                                    "filename", "size_bytes", "sha256", "content_type")}}
    validate_file_request(request)
    return request


def validate_receipt(config: _Config, response: dict, request: dict) -> dict:
    """Signature, purpose, age and every immutable task/object binding are required."""
    validate_file_request(request)
    payload = _signed_payload(config, response, schema=RESULT_SCHEMA, nonce=request["nonce"])
    required = BOUND_FIELDS | {"schema", "purpose", "result", "observed", "receipt_id", "issued_at", "expires_at"}
    if (set(payload) != required or payload.get("purpose") != "qianshou:file-bytes-verifier"
            or any(payload.get(key) != request[key] for key in BOUND_FIELDS)
            or not isinstance(payload.get("receipt_id"), str)):
        raise ExternalVerifierUnavailable("independent file receipt binding invalid")
    try:
        if str(UUID(payload["receipt_id"])) != payload["receipt_id"] or payload["expires_at"] <= payload["issued_at"]:
            raise ValueError("noncanonical receipt identity")
    except (TypeError, ValueError):
        raise ExternalVerifierUnavailable("independent file receipt identity invalid") from None
    if payload["result"] == "fail":
        raise ExternalFileRejected("independent file bytes failed verification")
    observed = payload.get("observed")
    if (payload["result"] != "pass" or not isinstance(observed, dict)
            or set(observed) != {"size_bytes", "sha256", "encoding_verified", "machine_semantics_verified", "media_semantics_verified"}
            or type(observed.get("size_bytes")) is not int or observed["size_bytes"] != request["size_bytes"]
            or observed.get("sha256") != request["sha256"]
            or observed.get("encoding_verified") != request["file_schema"]["outputs"][0]["encoding"]
            or observed.get("machine_semantics_verified") is not False
            or observed.get("media_semantics_verified") is not False):
        raise ExternalVerifierUnavailable("independent file observed proof invalid")
    return response


def available() -> bool:
    config = _config()
    if config is None:
        return False
    nonce = str(uuid4())
    try:
        response = _post(config, "/file-health", {"schema": REQUEST_SCHEMA, "kind": "health",
                                                  "nonce": nonce, "policy_id": FILE_POLICY})
        payload = _signed_payload(config, response, schema=HEALTH_SCHEMA, nonce=nonce)
        return (payload.get("purpose") == "qianshou:file-bytes-verifier"
                and payload.get("policy_id") == FILE_POLICY and payload.get("status") == "ready"
                and payload.get("max_bytes") == 16 * 1024 and payload.get("result_contract") == "artifact.v1")
    except (ExternalVerifierUnavailable, TypeError, ValueError):
        return False


def verify(**metadata: Any) -> dict:
    request = build_request(**metadata)
    config = _config()
    if config is None:
        raise ExternalVerifierUnavailable("independent file verifier not enrolled")
    response = _post(config, "/file-verify", request)
    return validate_receipt(config, response, request)
