"""Normalize assignment-bound historical successes into canonical artifact.v1."""
from __future__ import annotations

import hashlib
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, ContextManager

from platform_v8.core import ShardStatus
from platform_v8.protocol.artifact import (
    MAX_ARTIFACT_BYTES,
    ArtifactV1,
    build_object_key,
)
from platform_v8.services.legacy_result_adapter import (
    LegacyContentKind,
    LegacyResultEnvelope,
    inline_limit_bytes,
    is_assignment_bound_result,
)
from platform_v8.services.result_verifier import (
    PreparedVerification,
    ResultIsolationError,
    prepare_bound_legacy_artifact,
)
from platform_v8.services.storage_refs import canonicalize_owned_reference
from platform_v8.storage.repo import (
    ResultVerificationRepo,
    ShardRepo,
    WorkerRepo,
    WorkloadRepo,
)


class LegacyNormalizationError(ValueError):
    """Legacy success could not safely enter the canonical result path."""

    def __init__(self, message: str, *, reason: str = "other") -> None:
        self.reason = reason
        super().__init__(message)


class LegacyNormalizationConflict(LegacyNormalizationError):
    """The same shard attempt already carries different immutable evidence."""

    def __init__(self, message: str, *, reason: str = "evidence_conflict") -> None:
        super().__init__(message, reason=reason)


@dataclass(frozen=True)
class NormalizedLegacyResult:
    artifact: ArtifactV1
    prepared: PreparedVerification
    enqueued: bool
    idempotent: bool = False


def _object_limit_bytes() -> int:
    try:
        configured = int(os.getenv(
            "V8_LEGACY_RESULT_MAX_OBJECT_BYTES",
            str(MAX_ARTIFACT_BYTES),
        ))
    except (TypeError, ValueError):
        configured = MAX_ARTIFACT_BYTES
    return min(max(64 * 1024, configured), MAX_ARTIFACT_BYTES)


def _result_id(envelope: LegacyResultEnvelope, digest: str) -> str:
    identity = (
        "legacy-result.v1|"
        f"{envelope.binding.shard_id}|{envelope.binding.attempt}|{digest}"
    )
    return str(uuid.uuid5(uuid.NAMESPACE_URL, identity))


class LegacyResultNormalizer:
    """Canonicalize only adapter-created, assignment-bound result envelopes."""

    def __init__(
        self,
        *,
        provider: Any | None = None,
        session_scope_factory: Callable[[], ContextManager[Any]] | None = None,
        enqueue: Callable[..., bool] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._provider = provider
        self._session_scope_factory = session_scope_factory
        self._enqueue = enqueue
        self._clock = clock

    def _scope(self) -> ContextManager[Any]:
        if self._session_scope_factory is not None:
            return self._session_scope_factory()
        from platform_v8.storage import db as db_mod

        return db_mod.session_scope()

    def _storage(self):
        if self._provider is None:
            from platform_v8.services.oss_provider import get_oss_provider

            self._provider = get_oss_provider()
        return self._provider

    def _enqueue_prepared(
        self,
        prepared: PreparedVerification,
        *,
        elapsed_ms: int | None,
    ) -> bool:
        if self._enqueue is None:
            from platform_v8.services.result_verification_jobs import (
                enqueue_verification,
            )

            self._enqueue = enqueue_verification
        return bool(self._enqueue(prepared, elapsed_ms=elapsed_ms))

    def _load_bound_context(
        self,
        envelope: LegacyResultEnvelope,
    ) -> tuple[Any, Any, Any]:
        with self._scope() as session:
            shard = ShardRepo.by_id(session, envelope.binding.shard_id)
            workload = (
                WorkloadRepo.by_id(session, shard.workload_id)
                if shard is not None else None
            )
            worker = WorkerRepo.by_id(session, envelope.binding.worker_id)
            if shard is None or workload is None or worker is None:
                raise LegacyNormalizationError(
                    "bound result context no longer exists",
                    reason="context_missing",
                )
            if (
                str(shard.workload_id) != envelope.binding.workload_id
                or str(workload.id) != envelope.binding.workload_id
                or int(shard.attempts) != int(envelope.binding.attempt)
                or shard.status not in {
                    ShardStatus.DISPATCHED,
                    ShardStatus.LEASED,
                    ShardStatus.RUNNING,
                    ShardStatus.VERIFYING,
                }
            ):
                raise LegacyNormalizationConflict(
                    "bound shard attempt is no longer current",
                    reason="stale_assignment",
                )
            active = ShardRepo.race_workers_of(shard)
            if shard.status == ShardStatus.VERIFYING:
                active.add(str(shard.worker_id or ""))
            if envelope.binding.worker_id not in active:
                raise LegacyNormalizationConflict(
                    "bound worker no longer owns the shard attempt",
                    reason="worker_no_longer_owner",
                )
            return shard, workload, worker

    @staticmethod
    def _owner_candidates(workload: Any, worker: Any) -> tuple[int, ...]:
        owners: list[int] = []
        for raw in (workload.owner_id, worker.owner_id):
            owner = int(raw)
            if owner not in owners:
                owners.append(owner)
        return tuple(owners)

    def _canonical_source_key(
        self,
        reference: str,
        *,
        workload: Any,
        worker: Any,
    ) -> str:
        for owner_id in self._owner_candidates(workload, worker):
            try:
                return canonicalize_owned_reference(owner_id, reference)
            except Exception:
                continue
        raise LegacyNormalizationError(
            "legacy object is outside permitted owner namespaces",
            reason="cross_tenant",
        )

    def _inspect_source(
        self,
        source_key: str,
    ) -> tuple[int, str, str, str]:
        provider = self._storage()
        limit = _object_limit_bytes()
        metadata = provider.head_object(source_key) or {}
        declared = metadata.get("content_length")
        if declared is not None:
            try:
                declared = int(declared)
            except (TypeError, ValueError) as exc:
                raise LegacyNormalizationError(
                    "legacy object metadata size is invalid",
                    reason="object_metadata_invalid",
                ) from exc
            if declared < 0 or declared > limit:
                raise LegacyNormalizationError(
                    "legacy object exceeds configured size limit",
                    reason="size_limit",
                )
        digest = hashlib.sha256()
        received = 0
        try:
            for chunk in provider.iter_object(source_key):
                if not isinstance(chunk, (bytes, bytearray, memoryview)):
                    raise LegacyNormalizationError(
                        "legacy object stream is malformed",
                        reason="source_unreadable",
                    )
                data = bytes(chunk)
                received += len(data)
                if received > limit:
                    raise LegacyNormalizationError(
                        "legacy object exceeds configured size limit",
                        reason="size_limit",
                    )
                digest.update(data)
        except LegacyNormalizationError:
            raise
        except Exception as exc:
            raise LegacyNormalizationError(
                "legacy object could not be read",
                reason="source_unreadable",
            ) from exc
        if received == 0:
            raise LegacyNormalizationError(
                "legacy success object is empty",
                reason="empty_result",
            )
        if declared is not None and received != declared:
            raise LegacyNormalizationError(
                "legacy object metadata size mismatch",
                reason="hash_mismatch",
            )
        return (
            received,
            digest.hexdigest(),
            "application/octet-stream",
            "legacy-result.bin",
        )

    @staticmethod
    def _memory_chunks(
        raw: bytes,
        *,
        chunk_size: int = 128 * 1024,
    ):
        for offset in range(0, len(raw), chunk_size):
            yield raw[offset:offset + chunk_size]

    @staticmethod
    def _inline_content(
        envelope: LegacyResultEnvelope,
    ) -> tuple[bytes, str, str]:
        content = envelope.content
        assert content is not None
        if content.kind == LegacyContentKind.INLINE_TEXT:
            raw = (content.inline_text or "").encode("utf-8")
        elif content.kind == LegacyContentKind.INLINE_BYTES:
            raw = bytes(content.inline_bytes or b"")
        else:
            raise LegacyNormalizationError("legacy content is not inline")
        if not raw:
            raise LegacyNormalizationError(
                "legacy success inline is empty",
                reason="empty_result",
            )
        if len(raw) > inline_limit_bytes():
            raise LegacyNormalizationError(
                "legacy inline exceeds configured size limit",
                reason="size_limit",
            )
        return raw, "application/octet-stream", "legacy-result.bin"

    def _evidence(
        self,
        envelope: LegacyResultEnvelope,
        *,
        source_kind: str,
        disposition: str,
    ) -> dict[str, Any]:
        from platform_v8.services.observability import redact_identifier

        gate = dict(envelope.adapter_metadata or {})
        return {
            "adapter_version": envelope.adapter_version,
            "legacy_shape": envelope.shape.value,
            "binding_method": envelope.binding.method.value,
            "connection": redact_identifier(envelope.binding.connection_id),
            "source_kind": source_kind,
            "compat_disposition": disposition,
            "adapter_metadata": {
                key: gate[key]
                for key in (
                    "gate", "mode", "bucket", "rollout_pct", "source", "allowed",
                )
                if key in gate
                and isinstance(gate[key], (str, int, float, bool, type(None)))
            },
        }

    def _existing_result(
        self,
        envelope: LegacyResultEnvelope,
        artifact: ArtifactV1,
    ) -> dict[str, Any] | None:
        with self._scope() as session:
            existing = ResultVerificationRepo.get(
                session,
                envelope.binding.shard_id,
                envelope.binding.attempt,
            )
        if existing is None:
            return None
        expected_artifact = artifact.model_dump(by_alias=True)
        if (
            str(existing.get("workload_id")) != envelope.binding.workload_id
            or str(existing.get("worker_id")) != envelope.binding.worker_id
            or str(existing.get("content_sha256") or "") != artifact.sha256
            or dict(existing.get("artifact") or {}) != expected_artifact
        ):
            raise LegacyNormalizationConflict(
                "legacy result conflicts with existing shard attempt evidence",
                reason="evidence_conflict",
            )
        return existing

    @staticmethod
    def _prepared_from_existing(
        existing: dict[str, Any],
        artifact: ArtifactV1,
    ) -> PreparedVerification:
        evidence = dict(existing.get("evidence") or {})
        return PreparedVerification(
            shard_id=str(existing["shard_id"]),
            workload_id=str(existing["workload_id"]),
            worker_id=str(existing["worker_id"]),
            attempt=int(existing["attempt"]),
            policy=str(existing["requested_policy"]),
            verifier_key=str(existing["verifier_key"]),
            output_ref=str(evidence.get("output_ref") or artifact.to_storage_ref()),
            content_sha256=str(existing["content_sha256"]),
            artifact=dict(existing.get("artifact") or {}),
            evidence=evidence,
        )

    def _record_issuance(
        self,
        envelope: LegacyResultEnvelope,
        artifact: ArtifactV1,
    ) -> None:
        with self._scope() as session:
            accepted = ShardRepo.record_result_upload_issuance(
                session,
                envelope.binding.shard_id,
                worker_id=envelope.binding.worker_id,
                object_key=artifact.object_key,
                result_id=artifact.result_id,
                size_bytes=artifact.size_bytes,
                sha256=artifact.sha256,
                content_type=artifact.content_type,
                expires_at=int(self._clock()) + 3600,
                expected_attempt=envelope.binding.attempt,
            )
            if not accepted:
                raise LegacyNormalizationConflict(
                    "canonical issuance conflicts with current shard attempt",
                    reason="issuance_conflict",
                )
            session.commit()

    def _normalize_and_enqueue(
        self,
        envelope: LegacyResultEnvelope,
    ) -> NormalizedLegacyResult:
        if not is_assignment_bound_result(envelope):
            raise TypeError(
                "LegacyResultNormalizer requires a bound LegacyResultEnvelope"
            )
        if not envelope.ok or envelope.content is None:
            raise LegacyNormalizationError(
                "only bound legacy success results can be normalized",
                reason="invalid_shape",
            )
        _shard, workload, worker = self._load_bound_context(envelope)
        content = envelope.content

        if content.kind in {
            LegacyContentKind.ARTIFACT,
            LegacyContentKind.ARTIFACT_INLINE_DUPLICATE,
        }:
            try:
                artifact = ArtifactV1.model_validate(content.artifact)
            except Exception as exc:
                raise LegacyNormalizationError(
                    "legacy artifact manifest is invalid",
                    reason="artifact_invalid",
                ) from exc
            source_kind = "artifact"
            disposition = (
                "strict_artifact_inline_deduplicated"
                if content.kind == LegacyContentKind.ARTIFACT_INLINE_DUPLICATE
                else "strict_artifact_reused"
            )
        else:
            source_key: str | None = None
            inline: bytes | None = None
            if content.kind in {
                LegacyContentKind.INLINE_TEXT,
                LegacyContentKind.INLINE_BYTES,
            }:
                inline, content_type, filename = self._inline_content(envelope)
                size_bytes = len(inline)
                inline_digest = hashlib.sha256()
                for chunk in self._memory_chunks(inline):
                    inline_digest.update(chunk)
                digest = inline_digest.hexdigest()
                source_kind = "inline"
                disposition = "normalized_inline"
            elif content.kind in {
                LegacyContentKind.OBJECT_KEY,
                LegacyContentKind.TRUSTED_OSS_URL,
            }:
                source_key = self._canonical_source_key(
                    str(content.reference or ""),
                    workload=workload,
                    worker=worker,
                )
                size_bytes, digest, content_type, filename = (
                    self._inspect_source(source_key)
                )
                source_kind = (
                    "trusted_oss_url"
                    if content.kind == LegacyContentKind.TRUSTED_OSS_URL
                    else "owned_object_key"
                )
                disposition = "copied_to_canonical"
            else:
                raise LegacyNormalizationError(
                    "unsupported legacy success shape",
                    reason="invalid_shape",
                )

            result_id = _result_id(envelope, digest)
            object_key = build_object_key(
                account_id=int(workload.owner_id),
                workload_id=envelope.binding.workload_id,
                shard_id=envelope.binding.shard_id,
                result_id=result_id,
                filename=filename,
            )
            artifact = ArtifactV1(
                schema="artifact.v1",
                object_key=object_key,
                filename=filename,
                size_bytes=size_bytes,
                content_type=content_type,
                sha256=digest,
                result_id=result_id,
                shard_id=envelope.binding.shard_id,
                workload_id=envelope.binding.workload_id,
                account_id=int(workload.owner_id),
            )
            existing = self._existing_result(envelope, artifact)
            if existing is not None:
                return NormalizedLegacyResult(
                    artifact=artifact,
                    prepared=self._prepared_from_existing(existing, artifact),
                    enqueued=True,
                    idempotent=True,
                )
            self._record_issuance(envelope, artifact)
            try:
                if inline is not None:
                    written = self._storage().write_stream(
                        artifact.object_key,
                        self._memory_chunks(inline),
                        content_type=artifact.content_type,
                        max_size=inline_limit_bytes(),
                        expected_size=artifact.size_bytes,
                        expected_sha256=artifact.sha256,
                    )
                else:
                    assert source_key is not None
                    written = self._storage().copy_object(
                        source_key,
                        artifact.object_key,
                        content_type=artifact.content_type,
                        max_size=_object_limit_bytes(),
                        expected_size=artifact.size_bytes,
                        expected_sha256=artifact.sha256,
                    )
            except Exception as exc:
                raise LegacyNormalizationError(
                    "canonical legacy artifact write failed",
                    reason="write_failed",
                ) from exc
            if (
                written.object_key != artifact.object_key
                or written.size_bytes != artifact.size_bytes
                or written.sha256 != artifact.sha256
            ):
                raise LegacyNormalizationError(
                    "canonical legacy artifact evidence mismatch",
                    reason="hash_mismatch",
                )

        evidence = self._evidence(
            envelope,
            source_kind=source_kind,
            disposition=disposition,
        )
        existing = self._existing_result(envelope, artifact)
        if existing is not None:
            return NormalizedLegacyResult(
                artifact=artifact,
                prepared=self._prepared_from_existing(existing, artifact),
                enqueued=True,
                idempotent=True,
            )
        prepared = prepare_bound_legacy_artifact(
            envelope,
            artifact=artifact.model_dump(by_alias=True),
            evidence=evidence,
        )
        if prepared.policy == "quarantine":
            from platform_v8.services import lan_qa

            if not lan_qa.relax_verifier_enabled():
                raise ResultIsolationError(
                    "legacy canonical artifact is not settleable by registry policy",
                    attempt=envelope.binding.attempt,
                )
            # LAN/验收：quarantine → 按 artifact 路径继续入队（不改生产默认）
            prepared = PreparedVerification(
                shard_id=prepared.shard_id,
                workload_id=prepared.workload_id,
                worker_id=prepared.worker_id,
                attempt=prepared.attempt,
                policy="artifact",
                verifier_key="artifact.v1",
                output_ref=prepared.output_ref,
                content_sha256=prepared.content_sha256,
                artifact=prepared.artifact,
                evidence={
                    **dict(prepared.evidence or {}),
                    "lan_qa_quarantine_relax": True,
                },
            )
        accepted = self._enqueue_prepared(
            prepared,
            elapsed_ms=envelope.elapsed_ms,
        )
        if not accepted:
            existing = self._existing_result(envelope, artifact)
            if existing is None:
                raise LegacyNormalizationConflict(
                    "shard attempt changed before verification enqueue",
                    reason="enqueue_conflict",
                )
            return NormalizedLegacyResult(
                artifact=artifact,
                prepared=self._prepared_from_existing(existing, artifact),
                enqueued=True,
                idempotent=True,
            )
        return NormalizedLegacyResult(
            artifact=artifact,
            prepared=prepared,
            enqueued=True,
        )

    def normalize_and_enqueue(
        self,
        envelope: LegacyResultEnvelope,
    ) -> NormalizedLegacyResult:
        """Normalize once and account at this single semantic boundary."""
        from platform_v8.services.observability import (
            record_legacy_normalization,
            record_legacy_replay,
        )

        content = getattr(envelope, "content", None)
        raw_kind = getattr(getattr(content, "kind", None), "value", "")
        source_kind = (
            "inline"
            if raw_kind in {"inline_text", "inline_bytes"}
            else "owned_object_key" if raw_kind == "object_key"
            else "trusted_oss_url" if raw_kind == "trusted_oss_url"
            else "artifact"
            if raw_kind in {"artifact", "artifact_inline_duplicate"}
            else "none"
        )
        try:
            result = self._normalize_and_enqueue(envelope)
        except ResultIsolationError:
            record_legacy_normalization(
                outcome="failure",
                source_kind=source_kind,
                reason="registry_quarantine",
            )
            raise
        except LegacyNormalizationError as exc:
            record_legacy_normalization(
                outcome="failure",
                source_kind=source_kind,
                reason=exc.reason,
            )
            raise
        except Exception:
            record_legacy_normalization(
                outcome="failure",
                source_kind=source_kind,
                reason="infrastructure_unavailable",
            )
            raise
        record_legacy_normalization(
            outcome="success",
            source_kind=source_kind,
            reason="none",
        )
        if result.idempotent:
            record_legacy_replay(kind="duplicate", stage="normalization")
        return result
