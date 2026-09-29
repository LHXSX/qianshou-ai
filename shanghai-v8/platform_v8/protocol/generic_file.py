"""Bounded, metadata-only file ABI shared with off-Shanghai compute/verifiers.

The only registered policy confirms immutable storage bytes. It grants no
media semantic verdict, preview permission, filesystem path or download URL.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any
from uuid import UUID

FILE_ABI = "qianshou.quickjs-files.v1"
FILE_POLICY = "independent-file-bytes.v1"
REQUEST_SCHEMA = "qianshou.external-file-request.v1"
RESULT_SCHEMA = "qianshou.external-file-result.v1"
HEALTH_SCHEMA = "qianshou.external-file-health.v1"
MAX_FILE_BYTES = 16 * 1024
_SLOT = re.compile(r"[a-z][a-z0-9_]{0,31}\Z")
_FILENAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_MIME = re.compile(r"[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\Z")
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_VERSION = re.compile(r"[A-Za-z0-9_.~+-]{1,200}\Z")


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      sort_keys=True, separators=(",", ":")).encode("utf-8")


def _bounded(value: Any) -> bool:
    return type(value) is int and 1 <= value <= MAX_FILE_BYTES


def _string(value: Any, pattern: re.Pattern) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _uuid(value: Any) -> bool:
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except ValueError:
        return False


def validate_file_schema(value: Any) -> dict:
    if (not isinstance(value, dict)
            or set(value) != {"schema", "inputs", "outputs", "verificationPolicy"}
            or value.get("schema") != FILE_ABI
            or value.get("verificationPolicy") != FILE_POLICY
            or not isinstance(value.get("inputs"), list) or len(value["inputs"]) > 1
            or not isinstance(value.get("outputs"), list) or len(value["outputs"]) != 1
            or len(canonical(value)) > 2048):
        raise ValueError("file declaration invalid")
    for slot in value["inputs"]:
        if (not isinstance(slot, dict) or set(slot) != {"name", "contentTypes", "maxBytes"}
                or not _string(slot.get("name"), _SLOT) or not _bounded(slot.get("maxBytes"))
                or not isinstance(slot.get("contentTypes"), list)
                or not 1 <= len(slot["contentTypes"]) <= 8
                or any(not _string(mime, _MIME) for mime in slot["contentTypes"])
                or len(set(slot["contentTypes"])) != len(slot["contentTypes"])):
            raise ValueError("file input declaration invalid")
    output = value["outputs"][0]
    if (not isinstance(output, dict)
            or set(output) != {"name", "filename", "contentType", "maxBytes", "encoding"}
            or not _string(output.get("name"), _SLOT)
            or not _string(output.get("filename"), _FILENAME) or ".." in output["filename"]
            or not _string(output.get("contentType"), _MIME)
            or not _bounded(output.get("maxBytes"))
            or output.get("encoding") not in {"utf8", "base64"}):
        raise ValueError("file output declaration invalid")
    return json.loads(canonical(value))


def file_schema_sha256(value: Any) -> str:
    return hashlib.sha256(canonical(validate_file_schema(value))).hexdigest()


BOUND_FIELDS = {"nonce", "task_type", "account_id", "workload_id", "shard_id", "worker_id",
                "attempt", "file_schema_sha256", "object_key", "object_version_id", "result_id",
                "filename", "size_bytes", "sha256", "content_type", "policy_id"}


def validate_file_request(body: Any) -> dict:
    """No URLs, bytes, credentials or unbounded arbitrary recipe in this request."""
    if (not isinstance(body, dict) or set(body) != BOUND_FIELDS | {"schema", "kind", "file_schema"}
            or body.get("schema") != REQUEST_SCHEMA or body.get("kind") != "verify"
            or body.get("policy_id") != FILE_POLICY or not _uuid(body.get("nonce"))
            or not _string(body.get("task_type"), re.compile(r"[a-z][a-z0-9_]{2,63}\Z"))
            or type(body.get("account_id")) is not int or body["account_id"] < 1
            or type(body.get("attempt")) is not int or not 1 <= body["attempt"] <= 1_000_000
            or any(not _uuid(body.get(field)) for field in ("workload_id", "shard_id", "worker_id", "result_id"))
            or not _string(body.get("sha256"), _SHA)
            or not _string(body.get("object_version_id"), _VERSION)
            or body["object_version_id"].lower() == "null"):
        raise ValueError("file verification metadata invalid")
    schema = validate_file_schema(body["file_schema"])
    output = schema["outputs"][0]
    expected_key = (f"v8/account-{body['account_id']}/workload-{body['workload_id']}/"
                    f"shard-{body['shard_id']}/result/{body['result_id']}/{output['filename']}")
    if (body["file_schema_sha256"] != file_schema_sha256(schema)
            or body["object_key"] != expected_key
            or body["filename"] != output["filename"] or body["content_type"] != output["contentType"]
            or type(body["size_bytes"]) is not int or not 1 <= body["size_bytes"] <= output["maxBytes"]):
        raise ValueError("file verification declaration mismatch")
    return schema
