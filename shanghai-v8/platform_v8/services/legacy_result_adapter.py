"""Strict, assignment-bound parsing for historical worker result frames.

This module deliberately does not normalize or fetch result data.  It only
accepts known historical ``shard_progress``/``shard_result`` shapes after the
modern protocol parser has rejected them, then binds them to immutable delivery
evidence for the authenticated socket.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy.orm import Session

from platform_v8.core import ShardStatus
from platform_v8.protocol.artifact import (
    ArtifactV1,
    validate_artifact_against_context,
)
from platform_v8.services.storage_refs import (
    StorageReferenceError,
    owned_key_from_presigned_url,
    validate_owned_object_key,
)
from platform_v8.storage.repo import (
    AssignmentDeliveryRepo,
    ShardRepo,
    WorkerRepo,
    WorkloadRepo,
)


ADAPTER_VERSION = "legacy-result.v1"
DEFAULT_MAX_FRAME_BYTES = 1024 * 1024
DEFAULT_MAX_INLINE_BYTES = 256 * 1024
_MAX_FRAME_HARD_LIMIT = 16 * 1024 * 1024
_MAX_INLINE_HARD_LIMIT = 8 * 1024 * 1024
_ACTIVE_STATUSES = {
    ShardStatus.DISPATCHED,
    ShardStatus.LEASED,
    ShardStatus.RUNNING,
}
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_TOKENISH_RE = re.compile(
    r"(?i)(authorization|lease[_-]?token|access[_-]?token|signature)"
    r"\s*[:=]\s*[^\s,;]+"
)
_JWT_RE = re.compile(r"\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b")
_LONG_B64_RE = re.compile(r"\b[A-Za-z0-9+/=_-]{160,}\b")
_BOUND_ENVELOPE_CAPABILITY = object()


class LegacyRejectReason(str, Enum):
    DISABLED = "disabled"
    FRAME_TOO_LARGE = "frame_too_large"
    INVALID_JSON = "invalid_json"
    INVALID_ENVELOPE = "invalid_envelope"
    UNSUPPORTED_TYPE = "unsupported_type"
    NOT_LEGACY = "not_legacy"
    MODERN_INVALID = "modern_invalid"
    INVALID_SHAPE = "invalid_shape"
    INLINE_TOO_LARGE = "inline_too_large"
    INVALID_BASE64 = "invalid_base64"
    EMPTY_SUCCESS = "empty_success"
    INVALID_REFERENCE = "invalid_reference"
    CROSS_TENANT = "cross_tenant"
    UNSAFE_URL = "unsafe_url"
    HASH_MISMATCH = "hash_mismatch"
    SHARD_NOT_FOUND = "shard_not_found"
    INACTIVE_SHARD = "inactive_shard"
    WORKER_MISMATCH = "worker_mismatch"
    ATTEMPT_MISMATCH = "attempt_mismatch"
    INVALID_LEASE_TOKEN = "invalid_lease_token"
    CONNECTION_MISMATCH = "connection_mismatch"
    DELIVERY_MISSING = "delivery_missing"
    DELIVERY_AMBIGUOUS = "delivery_ambiguous"
    WORKLOAD_MISMATCH = "workload_mismatch"


class LegacyAdapterError(ValueError):
    """A fail-closed rejection whose string form never includes frame data."""

    def __init__(
        self,
        reason: LegacyRejectReason,
        *,
        frame_type: str | None = None,
    ) -> None:
        self.reason = reason
        self.frame_type = frame_type if frame_type in {
            "shard_progress", "shard_result",
        } else None
        suffix = f":{self.frame_type}" if self.frame_type else ""
        super().__init__(f"legacy_adapter_rejected:{reason.value}{suffix}")


class LegacyShape(str, Enum):
    PROGRESS_TOKENLESS = "progress_tokenless"
    PROGRESS_ALIASED = "progress_aliased"
    RESULT_INLINE = "result_inline"
    RESULT_INLINE_BASE64 = "result_inline_base64"
    RESULT_OBJECT_KEY = "result_object_key"
    RESULT_OSS_URL = "result_oss_url"
    RESULT_ARTIFACT_INLINE = "result_artifact_inline"
    RESULT_ARTIFACT = "result_artifact"
    RESULT_FAILED = "result_failed"
    RESULT_ALIASED = "result_aliased"


class LegacyContentKind(str, Enum):
    INLINE_TEXT = "inline_text"
    INLINE_BYTES = "inline_bytes"
    OBJECT_KEY = "object_key"
    TRUSTED_OSS_URL = "trusted_oss_url"
    ARTIFACT = "artifact"
    ARTIFACT_INLINE_DUPLICATE = "artifact_inline_duplicate"


class LegacyBindingMethod(str, Enum):
    ASSIGNMENT_DELIVERY = "assignment_delivery"


@dataclass(frozen=True)
class LegacyBinding:
    shard_id: str
    workload_id: str
    worker_id: str
    attempt: int
    connection_id: str
    method: LegacyBindingMethod = LegacyBindingMethod.ASSIGNMENT_DELIVERY
    delivery_mode: str = ""
    client_version: str = ""
    client_build: str = ""
    protocol_capabilities: tuple[str, ...] = ()


@dataclass(frozen=True)
class LegacyResultContent:
    kind: LegacyContentKind
    inline_text: str | None = field(default=None, repr=False)
    inline_bytes: bytes | None = field(default=None, repr=False)
    reference: str | None = field(default=None, repr=False)
    artifact: dict[str, Any] | None = field(default=None, repr=False)

    @property
    def size_bytes(self) -> int | None:
        if self.inline_bytes is not None:
            return len(self.inline_bytes)
        if self.inline_text is not None:
            return len(self.inline_text.encode("utf-8"))
        return None


@dataclass(frozen=True)
class LegacyProgressEnvelope:
    binding: LegacyBinding
    shape: LegacyShape
    pct: float
    message: str = ""
    adapter_version: str = ADAPTER_VERSION
    client_worker_id: str | None = None
    client_attempt: int | None = None
    client_workload_id: str | None = None
    adapter_metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def type(self) -> str:
        return "shard_progress"


@dataclass(frozen=True)
class LegacyResultEnvelope:
    binding: LegacyBinding
    shape: LegacyShape
    ok: bool
    content: LegacyResultContent | None = None
    elapsed_ms: int | None = None
    error: str = field(default="", repr=False)
    stderr_tail: str = field(default="", repr=False)
    exit_code: int | None = None
    python_used: str = ""
    failure_class: str = ""
    missing_dep: str = ""
    adapter_version: str = ADAPTER_VERSION
    client_worker_id: str | None = None
    client_attempt: int | None = None
    client_workload_id: str | None = None
    lease_token_present: bool = False
    adapter_metadata: dict[str, Any] = field(default_factory=dict)
    _binding_capability: object | None = field(
        default=None,
        repr=False,
        compare=False,
    )

    @property
    def type(self) -> str:
        return "shard_result"


LegacyEnvelope = LegacyProgressEnvelope | LegacyResultEnvelope


def is_assignment_bound_result(value: object) -> bool:
    """Return true only for a result emitted by this adapter's binder."""
    return (
        isinstance(value, LegacyResultEnvelope)
        and value._binding_capability is _BOUND_ENVELOPE_CAPABILITY
    )


@dataclass(frozen=True)
class _ParsedLegacy:
    frame_type: str
    shard_id: str
    shape: LegacyShape
    pct: float | None = None
    message: str = ""
    ok: bool | None = None
    content: LegacyResultContent | None = None
    elapsed_ms: int | None = None
    error: str = ""
    stderr_tail: str = ""
    exit_code: int | None = None
    python_used: str = ""
    failure_class: str = ""
    missing_dep: str = ""
    client_worker_id: str | None = None
    client_attempt: int | None = None
    client_workload_id: str | None = None
    lease_token_present: bool = False
    lease_token: str = field(default="", repr=False)


def _bounded_env(name: str, default: int, hard_limit: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        value = default
    return min(max(1024, value), hard_limit)


def frame_limit_bytes() -> int:
    return _bounded_env(
        "V8_LEGACY_RESULT_MAX_FRAME_BYTES",
        DEFAULT_MAX_FRAME_BYTES,
        _MAX_FRAME_HARD_LIMIT,
    )


def inline_limit_bytes() -> int:
    return _bounded_env(
        "V8_LEGACY_RESULT_MAX_INLINE_BYTES",
        DEFAULT_MAX_INLINE_BYTES,
        _MAX_INLINE_HARD_LIMIT,
    )


def ensure_frame_size(raw: str | bytes, *, max_frame_bytes: int | None = None) -> bytes:
    """Reject oversized frames before JSON parsing."""
    if isinstance(raw, bytes):
        encoded = raw
    elif isinstance(raw, str):
        encoded = raw.encode("utf-8")
    else:
        raise LegacyAdapterError(LegacyRejectReason.INVALID_ENVELOPE)
    limit = frame_limit_bytes() if max_frame_bytes is None else min(
        max(1024, int(max_frame_bytes)), _MAX_FRAME_HARD_LIMIT,
    )
    if len(encoded) > limit:
        raise LegacyAdapterError(LegacyRejectReason.FRAME_TOO_LARGE)
    return encoded


def _safe_id(value: object, *, required: bool = False) -> str | None:
    if value is None:
        if required:
            raise LegacyAdapterError(LegacyRejectReason.INVALID_SHAPE)
        return None
    text = str(value).strip()
    if not _SAFE_ID_RE.fullmatch(text):
        raise LegacyAdapterError(LegacyRejectReason.INVALID_SHAPE)
    return text


def _optional_int(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise LegacyAdapterError(LegacyRejectReason.INVALID_SHAPE)
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise LegacyAdapterError(LegacyRejectReason.INVALID_SHAPE) from exc
    if parsed < 0:
        raise LegacyAdapterError(LegacyRejectReason.INVALID_SHAPE)
    return parsed


def _bounded_text(value: object, limit: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise LegacyAdapterError(LegacyRejectReason.INVALID_SHAPE)
    return value[:limit]


def _redact_diagnostic(value: object, limit: int) -> str:
    text = _bounded_text(value, limit)
    text = _TOKENISH_RE.sub(r"\1=[redacted]", text)
    text = _JWT_RE.sub("[redacted-token]", text)
    text = _LONG_B64_RE.sub("[redacted-data]", text)

    def _strip_query(match: re.Match[str]) -> str:
        raw_url = match.group(0)
        try:
            parsed = urlsplit(raw_url)
        except ValueError:
            return "[redacted-url]"
        if not parsed.hostname:
            return "[redacted-url]"
        return f"{parsed.scheme}://{parsed.hostname}{parsed.path}"

    return re.sub(r"https?://[^\s]+", _strip_query, text)


def _inline_text(value: object, *, limit: int) -> str:
    if not isinstance(value, str):
        raise LegacyAdapterError(LegacyRejectReason.INVALID_SHAPE)
    if len(value.encode("utf-8")) > limit:
        raise LegacyAdapterError(LegacyRejectReason.INLINE_TOO_LARGE)
    return value


def _inline_base64(value: object, *, limit: int) -> bytes:
    if not isinstance(value, str) or not value:
        raise LegacyAdapterError(LegacyRejectReason.INVALID_BASE64)
    # A pre-decode bound avoids allocating a decoded object above the limit.
    if len(value) > 4 * ((limit + 2) // 3):
        raise LegacyAdapterError(LegacyRejectReason.INLINE_TOO_LARGE)
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise LegacyAdapterError(LegacyRejectReason.INVALID_BASE64) from exc
    if len(decoded) > limit:
        raise LegacyAdapterError(LegacyRejectReason.INLINE_TOO_LARGE)
    return decoded


def _coalesce_alias(
    payload: dict[str, Any],
    canonical: str,
    aliases: tuple[str, ...],
) -> tuple[Any, bool]:
    values: list[tuple[str, Any]] = []
    if canonical in payload:
        values.append((canonical, payload[canonical]))
    values.extend((alias, payload[alias]) for alias in aliases if alias in payload)
    if not values:
        return None, False
    first = values[0][1]
    if any(value != first for _, value in values[1:]):
        raise LegacyAdapterError(LegacyRejectReason.INVALID_SHAPE)
    return first, any(name != canonical for name, _ in values)


def _parse_progress(payload: dict[str, Any], *, limit: int) -> _ParsedLegacy:
    allowed = {
        "shard_id", "task_id", "pct", "progress", "message", "detail",
        "attempt", "lease_token", "worker_id", "node_id", "workload_id",
    }
    if set(payload) - allowed:
        raise LegacyAdapterError(
            LegacyRejectReason.MODERN_INVALID,
            frame_type="shard_progress",
        )
    shard_raw, shard_alias = _coalesce_alias(payload, "shard_id", ("task_id",))
    pct_raw, pct_alias = _coalesce_alias(payload, "pct", ("progress",))
    message_raw, message_alias = _coalesce_alias(payload, "message", ("detail",))
    worker_raw, worker_alias = _coalesce_alias(payload, "worker_id", ("node_id",))
    shard_id = _safe_id(shard_raw, required=True)
    if isinstance(pct_raw, bool) or not isinstance(pct_raw, (int, float)):
        raise LegacyAdapterError(LegacyRejectReason.INVALID_SHAPE)
    pct = float(pct_raw)
    if not 0.0 <= pct <= 1.0:
        raise LegacyAdapterError(LegacyRejectReason.INVALID_SHAPE)
    attempt = _optional_int(payload.get("attempt"))
    token_present = bool(str(payload.get("lease_token") or "").strip())
    aliases_used = shard_alias or pct_alias or message_alias or worker_alias
    if attempt is not None and token_present and not aliases_used:
        raise LegacyAdapterError(
            LegacyRejectReason.MODERN_INVALID,
            frame_type="shard_progress",
        )
    return _ParsedLegacy(
        frame_type="shard_progress",
        shard_id=str(shard_id),
        shape=(
            LegacyShape.PROGRESS_ALIASED
            if aliases_used else LegacyShape.PROGRESS_TOKENLESS
        ),
        pct=pct,
        message=_bounded_text(message_raw, 500),
        client_worker_id=_safe_id(worker_raw),
        client_attempt=attempt,
        client_workload_id=_safe_id(payload.get("workload_id")),
        lease_token_present=token_present,
        lease_token=str(payload.get("lease_token") or ""),
    )


def _artifact_content(
    artifact_raw: object,
    output_ref: object,
    inline_raw: object,
    *,
    limit: int,
) -> tuple[LegacyShape, LegacyResultContent]:
    if not isinstance(artifact_raw, dict):
        raise LegacyAdapterError(LegacyRejectReason.MODERN_INVALID)
    try:
        artifact = ArtifactV1.model_validate(artifact_raw)
    except Exception as exc:
        raise LegacyAdapterError(LegacyRejectReason.MODERN_INVALID) from exc
    artifact_dict = artifact.model_dump(by_alias=True)
    if output_ref is not None:
        if not isinstance(output_ref, str):
            raise LegacyAdapterError(LegacyRejectReason.MODERN_INVALID)
        try:
            parsed_ref = ArtifactV1.model_validate(json.loads(output_ref))
        except Exception as exc:
            raise LegacyAdapterError(LegacyRejectReason.MODERN_INVALID) from exc
        if parsed_ref.model_dump() != artifact.model_dump():
            raise LegacyAdapterError(LegacyRejectReason.MODERN_INVALID)
    if inline_raw is None:
        return (
            LegacyShape.RESULT_ARTIFACT,
            LegacyResultContent(
                kind=LegacyContentKind.ARTIFACT,
                reference=output_ref if isinstance(output_ref, str) else None,
                artifact=artifact_dict,
            ),
        )
    if isinstance(inline_raw, bytes):
        inline = None
        inline_bytes = inline_raw
        if len(inline_bytes) > limit:
            raise LegacyAdapterError(LegacyRejectReason.INLINE_TOO_LARGE)
    else:
        inline = _inline_text(inline_raw, limit=limit)
        inline_bytes = inline.encode("utf-8")
    if (
        len(inline_bytes) != artifact.size_bytes
        or hashlib.sha256(inline_bytes).hexdigest() != artifact.sha256
    ):
        raise LegacyAdapterError(LegacyRejectReason.HASH_MISMATCH)
    return (
        LegacyShape.RESULT_ARTIFACT_INLINE,
        LegacyResultContent(
            kind=LegacyContentKind.ARTIFACT_INLINE_DUPLICATE,
            inline_text=inline,
            inline_bytes=inline_bytes if inline is None else None,
            reference=output_ref if isinstance(output_ref, str) else None,
            artifact=artifact_dict,
        ),
    )


def _parse_result(payload: dict[str, Any], *, limit: int) -> _ParsedLegacy:
    allowed = {
        "shard_id", "task_id", "ok", "output_ref", "inline_output", "output",
        "inline_output_b64", "output_b64", "elapsed_ms", "error", "stderr_tail",
        "exit_code", "python_used", "failure_class", "missing_dep", "artifact",
        "lease_token", "attempt", "worker_id", "node_id", "workload_id",
    }
    if set(payload) - allowed:
        raise LegacyAdapterError(
            LegacyRejectReason.MODERN_INVALID,
            frame_type="shard_result",
        )
    shard_raw, shard_alias = _coalesce_alias(payload, "shard_id", ("task_id",))
    worker_raw, worker_alias = _coalesce_alias(payload, "worker_id", ("node_id",))
    inline_raw, output_alias = _coalesce_alias(
        payload, "inline_output", ("output",),
    )
    b64_raw, b64_alias = _coalesce_alias(
        payload, "inline_output_b64", ("output_b64",),
    )
    if inline_raw is not None and b64_raw is not None:
        raise LegacyAdapterError(LegacyRejectReason.INVALID_SHAPE)
    shard_id = _safe_id(shard_raw, required=True)
    ok = payload.get("ok")
    if not isinstance(ok, bool):
        raise LegacyAdapterError(LegacyRejectReason.INVALID_SHAPE)
    attempt = _optional_int(payload.get("attempt"))
    token_present = bool(str(payload.get("lease_token") or "").strip())
    elapsed_ms = _optional_int(payload.get("elapsed_ms"))
    aliases_used = shard_alias or worker_alias or output_alias or b64_alias

    if not ok:
        if token_present and not aliases_used:
            raise LegacyAdapterError(
                LegacyRejectReason.MODERN_INVALID,
                frame_type="shard_result",
            )
        content = None
        shape = (
            LegacyShape.RESULT_ALIASED
            if aliases_used else LegacyShape.RESULT_FAILED
        )
    else:
        artifact_raw = payload.get("artifact")
        output_ref = payload.get("output_ref")
        if artifact_raw is not None:
            shape, content = _artifact_content(
                artifact_raw,
                output_ref,
                (
                    _inline_base64(b64_raw, limit=limit)
                    if b64_raw is not None
                    else inline_raw
                ),
                limit=limit,
            )
        elif b64_raw is not None:
            content = LegacyResultContent(
                kind=LegacyContentKind.INLINE_BYTES,
                inline_bytes=_inline_base64(b64_raw, limit=limit),
            )
            shape = LegacyShape.RESULT_INLINE_BASE64
        elif inline_raw is not None and output_ref is None:
            content = LegacyResultContent(
                kind=LegacyContentKind.INLINE_TEXT,
                inline_text=_inline_text(inline_raw, limit=limit),
            )
            shape = (
                LegacyShape.RESULT_ALIASED
                if aliases_used else LegacyShape.RESULT_INLINE
            )
        elif isinstance(output_ref, str) and output_ref.strip() and inline_raw is None:
            reference = output_ref.strip()
            if reference.lower().startswith(("http://", "https://")):
                kind = LegacyContentKind.TRUSTED_OSS_URL
                shape = LegacyShape.RESULT_OSS_URL
            else:
                kind = LegacyContentKind.OBJECT_KEY
                shape = LegacyShape.RESULT_OBJECT_KEY
            content = LegacyResultContent(kind=kind, reference=reference)
        else:
            raise LegacyAdapterError(LegacyRejectReason.EMPTY_SUCCESS)
        if content.size_bytes == 0:
            raise LegacyAdapterError(LegacyRejectReason.EMPTY_SUCCESS)

    return _ParsedLegacy(
        frame_type="shard_result",
        shard_id=str(shard_id),
        shape=shape,
        ok=ok,
        content=content,
        elapsed_ms=elapsed_ms,
        error=_redact_diagnostic(payload.get("error"), 4000),
        stderr_tail=_redact_diagnostic(payload.get("stderr_tail"), 2048),
        exit_code=(
            int(payload["exit_code"])
            if isinstance(payload.get("exit_code"), int)
            and not isinstance(payload.get("exit_code"), bool)
            else None
        ),
        python_used=_bounded_text(payload.get("python_used"), 512),
        failure_class=_bounded_text(payload.get("failure_class"), 64),
        missing_dep=_bounded_text(payload.get("missing_dep"), 256),
        client_worker_id=_safe_id(worker_raw),
        client_attempt=attempt,
        client_workload_id=_safe_id(payload.get("workload_id")),
        lease_token_present=token_present,
        lease_token=str(payload.get("lease_token") or ""),
    )


def parse_legacy_frame(
    raw: str | bytes,
    *,
    max_frame_bytes: int | None = None,
    max_inline_bytes: int | None = None,
) -> _ParsedLegacy:
    """Parse a known historical shape without resolving its assignment."""
    encoded = ensure_frame_size(raw, max_frame_bytes=max_frame_bytes)
    try:
        data = json.loads(encoded)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise LegacyAdapterError(LegacyRejectReason.INVALID_JSON) from exc
    if not isinstance(data, dict) or set(data) - {"type", "v", "payload"}:
        raise LegacyAdapterError(LegacyRejectReason.INVALID_ENVELOPE)
    frame_type = data.get("type")
    if frame_type not in {"shard_progress", "shard_result"}:
        raise LegacyAdapterError(LegacyRejectReason.UNSUPPORTED_TYPE)
    payload = data.get("payload")
    if not isinstance(payload, dict):
        raise LegacyAdapterError(
            LegacyRejectReason.INVALID_ENVELOPE,
            frame_type=frame_type,
        )
    limit = inline_limit_bytes() if max_inline_bytes is None else min(
        max(1024, int(max_inline_bytes)), _MAX_INLINE_HARD_LIMIT,
    )
    if frame_type == "shard_progress":
        return _parse_progress(payload, limit=limit)
    return _parse_result(payload, limit=limit)


def _owner_candidates(worker: Any, workload: Any) -> tuple[int, ...]:
    candidates: list[int] = []
    for raw in (getattr(workload, "owner_id", None), getattr(worker, "owner_id", None)):
        try:
            owner_id = int(raw)
        except (TypeError, ValueError):
            continue
        if owner_id not in candidates:
            candidates.append(owner_id)
    return tuple(candidates)


def _validate_reference(
    content: LegacyResultContent,
    worker: Any,
    workload: Any,
) -> str | None:
    owners = _owner_candidates(worker, workload)
    if not owners:
        raise LegacyAdapterError(LegacyRejectReason.INVALID_REFERENCE)
    if content.kind == LegacyContentKind.OBJECT_KEY:
        for owner_id in owners:
            try:
                validate_owned_object_key(owner_id, content.reference)
                return validate_owned_object_key(owner_id, content.reference)
            except StorageReferenceError:
                continue
        raise LegacyAdapterError(LegacyRejectReason.CROSS_TENANT)
    if content.kind == LegacyContentKind.TRUSTED_OSS_URL:
        for owner_id in owners:
            try:
                owned_key_from_presigned_url(owner_id, content.reference)
                return owned_key_from_presigned_url(owner_id, content.reference)
            except StorageReferenceError:
                continue
        raise LegacyAdapterError(LegacyRejectReason.UNSAFE_URL)
    return None


def bind_legacy_frame(
    session: Session,
    parsed: _ParsedLegacy,
    *,
    authenticated_worker_id: str,
    connection_id: str,
) -> LegacyEnvelope:
    """Bind a parsed historical frame to one current delivered assignment."""
    worker_id = _safe_id(authenticated_worker_id, required=True)
    server_connection = _safe_id(connection_id, required=True)
    if parsed.client_worker_id is not None and parsed.client_worker_id != worker_id:
        raise LegacyAdapterError(
            LegacyRejectReason.WORKER_MISMATCH,
            frame_type=parsed.frame_type,
        )
    shard = ShardRepo.by_id(session, parsed.shard_id)
    if shard is None:
        raise LegacyAdapterError(
            LegacyRejectReason.SHARD_NOT_FOUND,
            frame_type=parsed.frame_type,
        )
    if shard.status not in _ACTIVE_STATUSES:
        raise LegacyAdapterError(
            LegacyRejectReason.INACTIVE_SHARD,
            frame_type=parsed.frame_type,
        )
    active_workers = ShardRepo.race_workers_of(shard)
    if shard.lease_by_node:
        active_workers.add(str(shard.lease_by_node))
    if str(worker_id) not in active_workers:
        raise LegacyAdapterError(
            LegacyRejectReason.WORKER_MISMATCH,
            frame_type=parsed.frame_type,
        )
    if (
        shard.status == ShardStatus.LEASED
        and str(shard.lease_by_node or "") != str(worker_id)
    ):
        raise LegacyAdapterError(
            LegacyRejectReason.WORKER_MISMATCH,
            frame_type=parsed.frame_type,
        )
    current_attempt = int(shard.attempts)
    if parsed.client_attempt is not None and parsed.client_attempt != current_attempt:
        raise LegacyAdapterError(
            LegacyRejectReason.ATTEMPT_MISMATCH,
            frame_type=parsed.frame_type,
        )
    if parsed.lease_token_present:
        from platform_v8.services.artifact_lease import verify_lease_token

        if not verify_lease_token(
            parsed.lease_token,
            shard_id=str(shard.id),
            worker_id=str(worker_id),
            attempt=current_attempt,
        ):
            raise LegacyAdapterError(
                LegacyRejectReason.INVALID_LEASE_TOKEN,
                frame_type=parsed.frame_type,
            )
    current = AssignmentDeliveryRepo.get_current_for_connection(
        session,
        str(server_connection),
        shard_id=str(shard.id),
        worker_id=str(worker_id),
    )
    if not current:
        raise LegacyAdapterError(
            LegacyRejectReason.DELIVERY_MISSING,
            frame_type=parsed.frame_type,
        )
    if len(current) != 1:
        raise LegacyAdapterError(
            LegacyRejectReason.DELIVERY_AMBIGUOUS,
            frame_type=parsed.frame_type,
        )
    delivery = current[0]
    if delivery.connection_id != server_connection:
        raise LegacyAdapterError(
            LegacyRejectReason.CONNECTION_MISMATCH,
            frame_type=parsed.frame_type,
        )
    if delivery.attempt != current_attempt:
        raise LegacyAdapterError(
            LegacyRejectReason.ATTEMPT_MISMATCH,
            frame_type=parsed.frame_type,
        )
    history = AssignmentDeliveryRepo.attempt_history_for_shard_worker(
        session,
        shard_id=str(shard.id),
        worker_id=str(worker_id),
    )
    if len({row.attempt for row in history}) != 1:
        raise LegacyAdapterError(
            LegacyRejectReason.DELIVERY_AMBIGUOUS,
            frame_type=parsed.frame_type,
        )
    if not AssignmentDeliveryRepo.has_unambiguous_current_delivery(
        session,
        shard_id=str(shard.id),
        worker_id=str(worker_id),
        connection_id=str(server_connection),
    ):
        raise LegacyAdapterError(
            LegacyRejectReason.DELIVERY_AMBIGUOUS,
            frame_type=parsed.frame_type,
        )
    workload = WorkloadRepo.by_id(session, shard.workload_id)
    worker = WorkerRepo.by_id(session, str(worker_id))
    if workload is None or worker is None:
        raise LegacyAdapterError(
            LegacyRejectReason.WORKLOAD_MISMATCH,
            frame_type=parsed.frame_type,
        )
    if (
        str(delivery.workload_id) != str(shard.workload_id)
        or str(workload.id) != str(shard.workload_id)
        or (
            parsed.client_workload_id is not None
            and parsed.client_workload_id != str(shard.workload_id)
        )
    ):
        raise LegacyAdapterError(
            LegacyRejectReason.WORKLOAD_MISMATCH,
            frame_type=parsed.frame_type,
        )
    if parsed.content is not None:
        if parsed.content.artifact is not None:
            try:
                artifact = ArtifactV1.model_validate(parsed.content.artifact)
                validate_artifact_against_context(
                    artifact,
                    account_id=int(workload.owner_id),
                    workload_id=str(workload.id),
                    shard_id=str(shard.id),
                )
            except Exception as exc:
                raise LegacyAdapterError(
                    LegacyRejectReason.CROSS_TENANT,
                    frame_type=parsed.frame_type,
                ) from exc
        else:
            canonical_reference = _validate_reference(
                parsed.content, worker, workload,
            )
            if canonical_reference is not None:
                parsed = replace(
                    parsed,
                    content=replace(
                        parsed.content, reference=canonical_reference,
                    ),
                )
    binding = LegacyBinding(
        shard_id=str(shard.id),
        workload_id=str(shard.workload_id),
        worker_id=str(worker_id),
        attempt=current_attempt,
        connection_id=str(server_connection),
        delivery_mode=delivery.mode,
        client_version=delivery.client_version,
        client_build=delivery.client_build,
        protocol_capabilities=tuple(delivery.protocol_capabilities),
    )
    common = {
        "binding": binding,
        "shape": parsed.shape,
        "client_worker_id": parsed.client_worker_id,
        "client_attempt": parsed.client_attempt,
        "client_workload_id": parsed.client_workload_id,
    }
    if parsed.frame_type == "shard_progress":
        assert parsed.pct is not None
        return LegacyProgressEnvelope(
            pct=parsed.pct,
            message=parsed.message,
            **common,
        )
    assert parsed.ok is not None
    return LegacyResultEnvelope(
        ok=parsed.ok,
        content=parsed.content,
        elapsed_ms=parsed.elapsed_ms,
        error=parsed.error,
        stderr_tail=parsed.stderr_tail,
        exit_code=parsed.exit_code,
        python_used=parsed.python_used,
        failure_class=parsed.failure_class,
        missing_dep=parsed.missing_dep,
        lease_token_present=parsed.lease_token_present,
        _binding_capability=_BOUND_ENVELOPE_CAPABILITY,
        **common,
    )


def adapt_after_strict_failure(
    session: Session,
    raw: str | bytes,
    *,
    authenticated_worker_id: str,
    connection_id: str,
    enabled: bool = True,
    max_frame_bytes: int | None = None,
    max_inline_bytes: int | None = None,
    decision: Any | None = None,
) -> LegacyEnvelope:
    """Parse and bind after the caller's modern parser has already failed."""
    from platform_v8.protocol.capability_profile import (
        observation_for_legacy_shape,
    )
    from platform_v8.services.legacy_compat import GateMode, accept_decision
    from platform_v8.services.observability import (
        record_legacy_accept,
        record_legacy_gate_block,
        record_legacy_reject,
    )

    if not enabled:
        record_legacy_reject(LegacyRejectReason.DISABLED, stage="adapter")
        raise LegacyAdapterError(LegacyRejectReason.DISABLED)
    gate = decision or accept_decision(
        authenticated_worker_id, session=session,
    )
    if not gate.allows:
        # Shadow mode validates only the bounded shape. It never binds or
        # promotes a capability profile.
        if gate.mode == GateMode.SHADOW:
            try:
                parse_legacy_frame(
                    raw,
                    max_frame_bytes=max_frame_bytes,
                    max_inline_bytes=max_inline_bytes,
                )
            except LegacyAdapterError as exc:
                record_legacy_reject(
                    exc.reason,
                    frame_type=(
                        "progress" if exc.frame_type == "shard_progress"
                        else "result" if exc.frame_type == "shard_result"
                        else "unknown"
                    ),
                    stage="adapter",
                )
                raise
        record_legacy_gate_block(gate, gate="accept")
        record_legacy_reject(LegacyRejectReason.DISABLED, stage="adapter")
        raise LegacyAdapterError(LegacyRejectReason.DISABLED)
    parsed: _ParsedLegacy | None = None
    try:
        parsed = parse_legacy_frame(
            raw,
            max_frame_bytes=max_frame_bytes,
            max_inline_bytes=max_inline_bytes,
        )
        envelope = bind_legacy_frame(
            session,
            parsed,
            authenticated_worker_id=authenticated_worker_id,
            connection_id=connection_id,
        )
    except LegacyAdapterError as exc:
        raw_type = exc.frame_type or (
            parsed.frame_type if parsed is not None else None
        )
        record_legacy_reject(
            exc.reason,
            frame_type=(
                "progress" if raw_type == "shard_progress"
                else "result" if raw_type == "shard_result"
                else "unknown"
            ),
            stage="adapter",
        )
        raise
    content = getattr(envelope, "content", None)
    kind = getattr(getattr(content, "kind", None), "value", "")
    source_kind = (
        "inline"
        if kind in {"inline_text", "inline_bytes"}
        else "owned_object_key" if kind == "object_key"
        else "trusted_oss_url" if kind == "trusted_oss_url"
        else "artifact"
        if kind in {"artifact", "artifact_inline_duplicate"}
        else "none"
    )
    record_legacy_accept(
        frame_type=(
            "progress"
            if parsed.frame_type == "shard_progress"
            else "result"
        ),
        shape=envelope.shape,
        source_kind=source_kind,
        profile=observation_for_legacy_shape(envelope.shape),
    )
    return envelope


def parse_with_legacy_fallback(
    session: Session,
    raw: str | bytes,
    *,
    authenticated_worker_id: str,
    connection_id: str,
    enabled: bool = True,
    max_frame_bytes: int | None = None,
    max_inline_bytes: int | None = None,
):
    """Apply the byte cap, strict parser, then the bounded legacy fallback."""
    from platform_v8.protocol import ws_schema

    ensure_frame_size(raw, max_frame_bytes=max_frame_bytes)
    text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
    try:
        return ws_schema.parse_incoming(text)
    except ws_schema.ProtocolError:
        return adapt_after_strict_failure(
            session,
            raw,
            authenticated_worker_id=authenticated_worker_id,
            connection_id=connection_id,
            enabled=enabled,
            max_frame_bytes=max_frame_bytes,
            max_inline_bytes=max_inline_bytes,
        )
