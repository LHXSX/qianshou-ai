"""Worker success-result validation gate.

A current shard owner is authorized to submit a result, not to declare arbitrary
bytes a successful business outcome.  This module validates the lease, the
server-issued artifact binding, object integrity, and task-specific contracts
before the shard can transition to DONE.
"""
from __future__ import annotations

import base64
import hashlib
import re
import json
import os
import time
from dataclasses import dataclass
from typing import Any

from platform_v8.protocol.artifact import (
    MAX_ARTIFACT_BYTES,
    MAX_INLINE_WITHOUT_ARTIFACT,
    ArtifactV1,
    parse_artifact_ref,
    validate_artifact_against_context,
)
from platform_v8.protocol.batch_contract import InputManifestV1, ProcessingReceiptV1
from platform_v8.services.artifact_lease import verify_lease_token
from platform_v8.storage import db as db_mod
from platform_v8.storage.repo import ShardRepo, WorkerRepo, WorkloadRepo
from platform_v8.services import film_media_compat as media_compat


class ResultValidationError(ValueError):
    """A worker result cannot be accepted as a successful shard outcome."""


class ResultIsolationError(ResultValidationError):
    """A legacy/unsettleable result must be isolated without recompute."""

    def __init__(self, message: str, *, attempt: int) -> None:
        super().__init__(message)
        self.attempt = int(attempt)


class VerificationInfrastructureError(ResultValidationError):
    """A platform-side verification dependency was unavailable."""

    def __init__(self, message: str, *, attempt: int | None = None) -> None:
        super().__init__(message)
        self.attempt = attempt


def _registered_task_spec(task_type: str):
    """Load a reviewed dynamic contract in this verifier process on demand.

    Quote, dispatch and websocket result verification can run in different
    Uvicorn workers. Their in-memory registries are independent, so a direct
    TASK_REGISTRY lookup can quarantine a valid result after execution.
    Unknown and blocked task types still have no settlement authority.
    """
    from platform_v8.engine.task_registry import TASK_REGISTRY, get_spec

    spec = TASK_REGISTRY.get(task_type)
    if spec is None or spec.adapter_input_contract == "__blocked__":
        spec = get_spec(task_type)
    if (getattr(spec, "task_type", None) != task_type
            or getattr(spec, "adapter_input_contract", None) == "__blocked__"):
        return None
    return spec


def _reject_unwired_external_verifier(task_type: str, *, attempt: int,
                                      legacy: bool = False) -> None:
    """Never pull candidate media bytes into Shanghai for settlement.

    The admission gate prevents new orders. This is a second boundary for
    persisted or administratively created shards and for delayed verify jobs.
    """
    from platform_v8.engine.task_registry import TASK_REGISTRY

    spec = _registered_task_spec(task_type)
    if spec is not None and spec.external_artifact_verifier_required:
        if getattr(spec, "adapter_file_schema", None):
            from platform_v8.services.external_file_verifier import available
            ready = available()
        else:
            from platform_v8.services.external_media_verifier import available
            ready = available(task_type)
        if legacy or not ready:
            raise ResultIsolationError(
                "EXTERNAL_ARTIFACT_VERIFIER_REQUIRED",
                attempt=attempt,
            )


def _require_reviewed_worker_adapter(task_type: str, *, worker_id: str,
                                     input_kind: str, attempt: int, shard=None) -> None:
    """Persisted/admin-created shards cannot bypass the owner publication gate."""
    from platform_v8.engine.task_registry import TASK_REGISTRY
    from platform_v8.services.workers.task_adapter_routing import can_route_reviewed_adapter

    spec = _registered_task_spec(task_type)
    if spec is None or not spec.requires_verified_adapter:
        return
    try:
        with db_mod.session_scope() as session:
            from platform_v8.services.workers.native_h3_task_lease import require_result_lease
            if shard is not None:
                require_result_lease(session, task_type=task_type, shard_id=str(shard.id),
                    workload_id=str(shard.workload_id), worker_id=worker_id, attempt=attempt)
            worker = WorkerRepo.by_id(session, worker_id)
            if worker is None:
                raise ValueError("worker missing")
            if not can_route_reviewed_adapter(
                session, worker, task_type=task_type, input_kind=input_kind,
                capability_id=spec.adapter_capability_id,
                output_kind=spec.adapter_output_kind,
            ):
                raise ValueError("worker adapter publication unavailable")
    except Exception as exc:
        raise ResultIsolationError(
            "TASK_ADAPTER_PUBLICATION_NOT_READY", attempt=attempt,
        ) from exc


def _require_official_worker(task_type: str, *, worker_id: str,
                             attempt: int) -> None:
    """A seller or buyer worker cannot impersonate a platform cloud provider."""
    from platform_v8.engine.task_registry import TASK_REGISTRY
    spec = _registered_task_spec(task_type)
    if spec is None or not getattr(spec, "official_provider_id", ""):
        return
    from platform_v8.services.workloads.official_image_admission import result_worker_matches
    try:
        with db_mod.session_scope() as session:
            if result_worker_matches(session, worker_id):
                return
    except Exception:
        pass
    raise ResultIsolationError("OFFICIAL_PROVIDER_WORKER_REQUIRED", attempt=attempt)


@dataclass(frozen=True)
class VerifiedShardResult:
    output_ref: str
    verification: dict[str, Any]
    attempt: int
    disposition: str = "VERIFIED"
    reason_code: str = ""


@dataclass(frozen=True)
class PreparedVerification:
    shard_id: str
    workload_id: str
    worker_id: str
    attempt: int
    policy: str
    verifier_key: str
    output_ref: str
    content_sha256: str
    artifact: dict[str, Any]
    evidence: dict[str, Any]


def _load_context(shard_id: str):
    with db_mod.session_scope() as session:
        shard = ShardRepo.by_id(session, shard_id)
        workload = WorkloadRepo.by_id(session, shard.workload_id) if shard else None
        return shard, workload


def _bounded_size_env(name: str, default: int, *, low: int, high: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        value = default
    return min(max(value, low), high)


def _stream_artifact(
    art: ArtifactV1,
    *,
    materialize_limit: int | None,
) -> bytes | None:
    """Verify one object in constant memory unless semantics need its bytes."""
    from platform_v8.services.oss_provider import get_oss_provider
    from platform_v8.services.url_safety import (
        URLPolicy,
        safe_stream,
        safe_transport_error,
    )

    total_limit = _bounded_size_env(
        "V8_RESULT_VERIFY_MAX_ARTIFACT_BYTES",
        MAX_ARTIFACT_BYTES,
        low=64 * 1024,
        high=MAX_ARTIFACT_BYTES,
    )
    if art.size_bytes > total_limit:
        raise ResultValidationError(
            f"artifact exceeds maximum verification size ({total_limit} bytes)"
        )
    if materialize_limit is not None and art.size_bytes > materialize_limit:
        raise ResultValidationError(
            "semantic artifact exceeds verification memory budget "
            f"({materialize_limit} bytes)"
        )
    try:
        signed = get_oss_provider().presign_get(art.object_key, expires=300)
        url = signed.url if hasattr(signed, "url") else signed["url"]
    except Exception as exc:
        raise VerificationInfrastructureError(
            "object storage signing unavailable"
        ) from exc
    digest = hashlib.sha256()
    body = bytearray() if materialize_limit is not None else None
    received = 0
    try:
        policy = URLPolicy(
            max_response_bytes=total_limit,
            timeout=180.0,
        )
        with safe_stream(url, policy=policy) as response:
            if not 200 <= int(response.status) < 300:
                raise VerificationInfrastructureError(
                    f"object storage HTTP {response.status}"
                )
            while True:
                chunk = response.read(128 * 1024)
                if not chunk:
                    break
                received += len(chunk)
                if received > art.size_bytes or received > total_limit:
                    raise ResultValidationError("artifact exceeds declared size")
                digest.update(chunk)
                if body is not None:
                    body.extend(chunk)
    except (ResultValidationError, VerificationInfrastructureError):
        raise
    except Exception as exc:
        raise VerificationInfrastructureError(safe_transport_error(exc)) from exc
    if received != art.size_bytes:
        raise ResultValidationError("artifact size mismatch")
    if digest.hexdigest() != art.sha256:
        raise ResultValidationError("artifact sha256 mismatch")
    return bytes(body) if body is not None else None


def _verify_artifact_integrity(art: ArtifactV1) -> None:
    _stream_artifact(art, materialize_limit=None)


def _read_artifact_bytes(art: ArtifactV1) -> bytes:
    """Materialize an artifact only for a bounded semantic verifier."""
    memory_limit = _bounded_size_env(
        "V8_RESULT_VERIFY_MAX_BYTES",
        16 * 1024 * 1024,
        low=64 * 1024,
        high=64 * 1024 * 1024,
    )
    body = _stream_artifact(art, materialize_limit=memory_limit)
    assert body is not None
    return body


def _json_object(raw: str | bytes) -> dict[str, Any]:
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError, UnicodeDecodeError) as exc:
        raise ResultValidationError("result must be a JSON object") from exc
    if not isinstance(payload, dict):
        raise ResultValidationError("result JSON root must be an object")
    return payload


def _requested_outputs(params: dict[str, Any]) -> set[str]:
    raw = params.get("outputs", params.get("result_types"))
    if raw is None:
        return {"srt", "dialogue"}
    if isinstance(raw, str):
        values = raw.replace("|", ",").split(",")
    elif isinstance(raw, (list, tuple)):
        values = raw
    else:
        values = []
    aliases = {
        "srt": "srt", "subtitle": "srt", "subtitles": "srt", "字幕": "srt",
        "dialogue": "dialogue", "dialog": "dialogue", "txt": "dialogue",
        "text": "dialogue", "对话": "dialogue", "对话文本": "dialogue",
    }
    selected = {aliases.get(str(value).strip().lower()) for value in values}
    return {item for item in selected if item} or {"srt", "dialogue"}


def _validate_audio_transcribe_refine(payload: dict[str, Any], params: dict[str, Any]) -> None:
    if payload.get("status") != "ok":
        raise ResultValidationError("audio result status is not ok")
    if payload.get("contract_version") != "1":
        raise ResultValidationError("unsupported audio result contract")
    if payload.get("task_type") != "audio_transcribe_refine":
        raise ResultValidationError("audio result task_type mismatch")
    files = payload.get("result_files_b64")
    results = payload.get("results")
    summary = payload.get("summary")
    if not isinstance(files, dict) or not isinstance(results, list) or len(results) != 1:
        raise ResultValidationError("audio result must contain exactly one result")
    if not isinstance(summary, dict) or int(summary.get("total_files") or 0) != 1:
        raise ResultValidationError("audio result total_files must equal one")

    names = {str(name) for name in files}
    outputs = _requested_outputs(params)
    if not any(name.endswith(".json") for name in names):
        raise ResultValidationError("audio result metadata JSON is missing")
    if "srt" in outputs and not any(name.endswith(".srt") for name in names):
        raise ResultValidationError("audio result SRT is missing")
    if "dialogue" in outputs and not any(name.endswith("_dialogue.txt") for name in names):
        raise ResultValidationError("audio result dialogue text is missing")
    for name, encoded in files.items():
        if not isinstance(name, str) or not isinstance(encoded, str):
            raise ResultValidationError("audio result files are malformed")
        try:
            base64.b64decode(encoded, validate=True)
        except Exception as exc:
            raise ResultValidationError(f"audio result file {name} is invalid base64") from exc

    result = results[0]
    if not isinstance(result, dict):
        raise ResultValidationError("audio result entry is malformed")
    segments = int(result.get("segments_count") or 0)
    if segments < 0 or int(summary.get("segments") or 0) != segments:
        raise ResultValidationError("audio segment count mismatch")


def _validate_processing_receipt(
    payload: dict[str, Any], shard_metadata: dict[str, Any],
) -> dict[str, Any]:
    """Require a source-aware completion record for batch-derived inputs."""
    if shard_metadata.get("input_kind") != "multi_file":
        return {}
    raw_manifest = shard_metadata.get("input_manifest")
    if not raw_manifest:
        return {}
    try:
        manifest = InputManifestV1.model_validate(raw_manifest)
        receipt = ProcessingReceiptV1.model_validate(payload.get("processing_receipt"))
    except Exception as exc:
        raise ResultValidationError("invalid processing receipt") from exc
    if receipt.input_manifest_sha256 != manifest.digest():
        raise ResultValidationError("processing receipt manifest digest mismatch")
    expected_ids = {entry.id for entry in manifest.entries}
    received = {item.input_id for item in receipt.items}
    if received != expected_ids:
        raise ResultValidationError("processing receipt does not cover shard inputs")
    if any(item.status != "succeeded" for item in receipt.items):
        raise ResultValidationError("processing receipt contains unsuccessful input")
    expected_outputs = set(
        (payload.get("result_files_b64") or payload.get("result_images_b64") or {}).keys()
    )
    receipt_outputs: list[str] = []
    for item in receipt.items:
        for output in item.outputs:
            name = output.get("name") if isinstance(output, dict) else None
            if not isinstance(name, str) or not name:
                raise ResultValidationError("processing receipt output is malformed")
            receipt_outputs.append(name)
    if len(receipt_outputs) != len(set(receipt_outputs)):
        raise ResultValidationError("processing receipt output names are duplicated")
    if set(receipt_outputs) != expected_outputs:
        raise ResultValidationError("processing receipt outputs do not match result files")
    return {
        "input_manifest_sha256": manifest.digest(),
        "verified_input_ids": sorted(received),
    }


def _validate_image_compress(payload: dict[str, Any]) -> None:
    if (
        payload.get("status") != "ok"
        or payload.get("contract_version") != "1"
        or payload.get("task_type") != "image_compress"
    ):
        raise ResultValidationError("invalid image_compress result contract")
    outputs = payload.get("result_images_b64")
    results = payload.get("results")
    summary = payload.get("summary")
    if (
        not isinstance(outputs, dict)
        or not outputs
        or not isinstance(results, list)
        or not isinstance(summary, dict)
    ):
        raise ResultValidationError("image_compress result has no deliverable images")
    if int(summary.get("failed") or 0) != 0:
        raise ResultValidationError("image_compress reported failed inputs")
    if int(summary.get("success") or 0) != len(results):
        raise ResultValidationError("image_compress success count mismatch")
    result_by_name = {
        str(item.get("filename") or ""): item
        for item in results
        if isinstance(item, dict) and not item.get("error")
    }
    if set(result_by_name) != set(outputs):
        raise ResultValidationError("image_compress result files do not match outputs")
    for name, encoded in outputs.items():
        if not isinstance(name, str) or not name or not isinstance(encoded, str):
            raise ResultValidationError("image_compress output is malformed")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except Exception as exc:
            raise ResultValidationError("image_compress output is invalid base64") from exc
        if not (
            raw.startswith(b"\xff\xd8\xff")
            or raw.startswith(b"\x89PNG\r\n\x1a\n")
            or (raw.startswith(b"RIFF") and raw[8:12] == b"WEBP")
        ):
            raise ResultValidationError("image_compress output has an invalid image signature")
        expected_hash = str(result_by_name[name].get("sha256_output") or "").lower()
        if expected_hash and hashlib.sha256(raw).hexdigest()[:len(expected_hash)] != expected_hash:
            raise ResultValidationError("image_compress output hash mismatch")
        try:
            from PIL import Image
            from io import BytesIO
            with Image.open(BytesIO(raw)) as image:
                image.verify()
        except ImportError as exc:
            raise VerificationInfrastructureError(
                "image verifier dependency is unavailable"
            ) from exc
        except Exception as exc:
            raise ResultValidationError("image_compress output cannot be decoded") from exc


def _artifact_issuance(
    shard: Any,
    *,
    worker_id: str,
    artifact: ArtifactV1,
) -> dict[str, Any]:
    metadata = dict(shard.metadata or {})
    issued = (
        (metadata.get("result_upload_issuances") or {}).get(str(worker_id))
        or metadata.get("result_upload_issuance")
        or {}
    )
    if (
        issued.get("worker_id") != str(worker_id)
        or int(issued.get("attempt", -1)) != int(shard.attempts)
        or issued.get("object_key") != artifact.object_key
        or issued.get("result_id") != artifact.result_id
        or int(issued.get("size_bytes") or -1) != artifact.size_bytes
        or str(issued.get("sha256") or "").lower() != artifact.sha256
        or str(issued.get("content_type") or "") != artifact.content_type
    ):
        raise ResultValidationError("artifact was not issued for this shard attempt")
    return dict(issued)


def prepare_verification_request(
    *,
    shard_id: str,
    worker_id: str,
    lease_token: str,
    output_ref: str | None,
    inline_output: str | None,
    artifact: dict[str, Any] | None,
) -> PreparedVerification:
    """Validate assignment/artifact bindings before durable queueing."""
    shard, workload = _load_context(shard_id)
    if shard is None or workload is None:
        raise ResultValidationError("shard not found")
    if (isinstance(workload.spec.params, dict)
            and workload.spec.params.get("review_sample_only") is True):
        raise ResultValidationError("独立审核样单禁止进入生产结果或结算队列")
    if str(worker_id) not in ShardRepo.race_workers_of(shard):
        raise ResultValidationError("worker does not hold shard")
    if not verify_lease_token(
        lease_token, shard_id=shard_id, worker_id=worker_id, attempt=shard.attempts,
    ):
        raise ResultValidationError("invalid or expired lease token")

    from platform_v8.engine.task_registry import TASK_REGISTRY
    from platform_v8.services import lan_qa

    registered = _registered_task_spec(workload.spec.task_type)
    _reject_unwired_external_verifier(
        workload.spec.task_type,
        attempt=int(shard.attempts),
    )
    _require_reviewed_worker_adapter(
        workload.spec.task_type, worker_id=worker_id,
        input_kind=str(workload.spec.input_kind or ""),
        attempt=int(shard.attempts), shard=shard,
    )
    _require_official_worker(
        workload.spec.task_type, worker_id=worker_id,
        attempt=int(shard.attempts),
    )
    # registry.settlement_policy 为结算真源；workload 旧 quarantine 不得挡住已健康能力任务完成
    if registered is None:
        policy = "quarantine"
    elif registered.external_artifact_verifier_required:
        policy = ("artifact" if getattr(registered, "adapter_file_schema", None)
                  else "semantic")  # Both paths use off-Shanghai proof; file integrity is not semantics.
    else:
        policy = str(getattr(registered, "settlement_policy", "quarantine") or "quarantine")
    if policy not in {"semantic", "artifact", "quarantine"}:
        policy = "quarantine"
    # LAN/验收：临时把 quarantine 收口到 artifact，避免误伤生产需显式 EDGE_LAN_QA_RELAX_VERIFIER
    policy = lan_qa.effective_settlement_policy(policy)

    art: ArtifactV1 | None = None
    if artifact is not None:
        try:
            art = ArtifactV1.model_validate(artifact)
        except Exception as exc:
            raise ResultValidationError(f"invalid artifact manifest: {exc}") from exc
        try:
            validate_artifact_against_context(
                art,
                account_id=int(workload.owner_id),
                workload_id=str(workload.id),
                shard_id=str(shard.id),
            )
        except ValueError as exc:
            raise ResultValidationError(str(exc)) from exc
        ref_art = parse_artifact_ref(output_ref)
        if ref_art is None or ref_art.model_dump() != art.model_dump():
            raise ResultValidationError("artifact and output_ref must match")
        issued = _artifact_issuance(shard, worker_id=worker_id, artifact=art)
        if int(issued.get("expires_at") or 0) < int(time.time()):
            raise ResultValidationError("artifact issuance has expired")
        canonical_output = art.to_storage_ref()
        content_sha256 = art.sha256
        artifact_data = art.model_dump(by_alias=True)
    else:
        if output_ref or not inline_output:
            raise ResultValidationError("success requires exactly one artifact or inline output")
        raw = inline_output.encode("utf-8")
        if len(raw) > MAX_INLINE_WITHOUT_ARTIFACT:
            raise ResultValidationError("inline output exceeds maximum size")
        canonical_output = inline_output
        content_sha256 = hashlib.sha256(raw).hexdigest()
        artifact_data = {}
    if policy == "artifact" and art is None:
        if not lan_qa.allow_inline_under_artifact():
            raise ResultIsolationError(
                "artifact policy requires server-issued artifact.v1",
                attempt=int(shard.attempts),
            )
    if registered is not None and registered.external_artifact_verifier_required and art is None:
        raise ResultIsolationError(
            "external media verifier requires server-issued artifact.v1",
            attempt=int(shard.attempts),
        )
    if (registered is not None and registered.external_artifact_verifier_required
            and art is not None and not art.object_version_id):
        raise ResultValidationError("external media artifact requires exact OSS object_version_id")
    if registered is not None and registered.external_artifact_verifier_required:
        if getattr(registered, "adapter_file_schema", None):
            from platform_v8.services.external_file_verifier import build_request
            try:
                build_request(task_type=workload.spec.task_type, account_id=int(workload.owner_id),
                              workload_id=str(workload.id), shard_id=str(shard.id), worker_id=worker_id,
                              attempt=int(shard.attempts), artifact=artifact_data,
                              file_schema=registered.adapter_file_schema)
            except (TypeError, ValueError) as exc:
                raise ResultValidationError("file result violates reviewed declaration") from exc
            verifier_key = f"external-file.{workload.spec.task_type}.v1"
        else:
            verifier_key = f"external-media.{workload.spec.task_type}.v1"
    elif policy == "semantic":
        verifier_key = f"{workload.spec.task_type}.v1"
    elif policy == "artifact":
        verifier_key = "artifact.v1"
    else:
        verifier_key = "quarantine"
    evidence = {
        "inline_output": inline_output if art is None else None,
        "output_ref": canonical_output,
    }
    if policy == "artifact" and art is None:
        evidence["legacy_inline_compat"] = True
    return PreparedVerification(
        shard_id=str(shard.id),
        workload_id=str(workload.id),
        worker_id=str(worker_id),
        attempt=int(shard.attempts),
        policy=policy,
        verifier_key=verifier_key,
        output_ref=canonical_output,
        content_sha256=content_sha256,
        artifact=artifact_data,
        evidence=evidence,
    )


def prepare_bound_legacy_artifact(
    envelope: object,
    *,
    artifact: dict[str, Any],
    evidence: dict[str, Any],
) -> PreparedVerification:
    """Prepare canonical legacy evidence without fabricating a lease token.

    The sole accepted authority is the typed envelope emitted by
    ``legacy_result_adapter`` after assignment-delivery binding.
    """
    from platform_v8.core import ShardStatus
    from platform_v8.engine.task_registry import TASK_REGISTRY
    from platform_v8.services.legacy_result_adapter import (
        LegacyResultEnvelope,
        is_assignment_bound_result,
    )

    if (
        not isinstance(envelope, LegacyResultEnvelope)
        or not is_assignment_bound_result(envelope)
        or not envelope.ok
    ):
        raise ResultValidationError(
            "legacy artifact requires an assignment-bound success envelope"
        )
    binding = envelope.binding
    shard, workload = _load_context(binding.shard_id)
    if shard is None or workload is None:
        raise ResultValidationError("shard not found")
    if (isinstance(workload.spec.params, dict)
            and workload.spec.params.get("review_sample_only") is True):
        raise ResultValidationError("独立审核样单禁止进入生产结果或结算队列")
    _reject_unwired_external_verifier(
        workload.spec.task_type,
        attempt=int(shard.attempts),
        legacy=True,
    )
    if (
        str(shard.id) != str(binding.shard_id)
        or str(shard.workload_id) != str(binding.workload_id)
        or int(shard.attempts) != int(binding.attempt)
        or shard.status not in {
            ShardStatus.DISPATCHED,
            ShardStatus.LEASED,
            ShardStatus.RUNNING,
            ShardStatus.VERIFYING,
        }
    ):
        raise ResultValidationError("stale assignment-bound legacy result")
    active_workers = ShardRepo.race_workers_of(shard)
    if shard.status == ShardStatus.VERIFYING:
        active_workers.add(str(shard.worker_id or ""))
    if str(binding.worker_id) not in active_workers:
        raise ResultValidationError("legacy result worker no longer holds shard")

    try:
        art = ArtifactV1.model_validate(artifact)
        validate_artifact_against_context(
            art,
            account_id=int(workload.owner_id),
            workload_id=str(workload.id),
            shard_id=str(shard.id),
        )
    except Exception as exc:
        raise ResultValidationError("invalid canonical legacy artifact") from exc
    issued = _artifact_issuance(
        shard,
        worker_id=str(binding.worker_id),
        artifact=art,
    )
    if (
        shard.status != ShardStatus.VERIFYING
        and int(issued.get("expires_at") or 0) < int(time.time())
    ):
        raise ResultValidationError("artifact issuance has expired")

    from platform_v8.services import lan_qa

    policy = str(
        getattr(workload.spec, "verification_policy", "quarantine")
        or "quarantine"
    )
    registered = _registered_task_spec(workload.spec.task_type)
    if registered is None:
        policy = "quarantine"
    elif policy != getattr(registered, "settlement_policy", "quarantine"):
        pass  # registry authoritative; ignore persisted mismatch
    if policy not in {"semantic", "artifact", "quarantine"}:
        policy = "quarantine"
    policy = lan_qa.effective_settlement_policy(policy)
    verifier_key = (
        f"{workload.spec.task_type}.v1"
        if policy == "semantic"
        else "artifact.v1" if policy == "artifact" else "quarantine"
    )
    canonical_output = art.to_storage_ref()
    safe_evidence = dict(evidence)
    safe_evidence["output_ref"] = canonical_output
    return PreparedVerification(
        shard_id=str(shard.id),
        workload_id=str(workload.id),
        worker_id=str(binding.worker_id),
        attempt=int(binding.attempt),
        policy=policy,
        verifier_key=verifier_key,
        output_ref=canonical_output,
        content_sha256=art.sha256,
        artifact=art.model_dump(by_alias=True),
        evidence=safe_evidence,
    )


def _legacy_downgrade(
    prepared: PreparedVerification,
    verification: dict[str, Any],
    *,
    reason: str,
) -> VerifiedShardResult:
    verification.update({
        "original_policy": prepared.policy,
        "actual_disposition": "legacy_artifact",
        "downgrade_reason": reason,
        "semantic_contract": "artifact-integrity.v1",
        "disposition": "LEGACY_ARTIFACT_VERIFIED",
        "reason_code": "LEGACY_SEMANTIC_DOWNGRADE",
    })
    return VerifiedShardResult(
        output_ref=prepared.output_ref,
        verification=verification,
        attempt=int(prepared.attempt),
        disposition="LEGACY_ARTIFACT_VERIFIED",
        reason_code="LEGACY_SEMANTIC_DOWNGRADE",
    )


def external_media_result_path_for(task_type: str, spec: Any = None):
    """Return a registered external-media strategy, never infer it by name."""
    if spec is None:
        from platform_v8.engine.task_registry import TASK_REGISTRY
        spec = _registered_task_spec(task_type)
    if (spec is None or not (spec.requires_verified_adapter
                             or getattr(spec, "official_provider_id", ""))
            or not spec.external_artifact_verifier_required
            or spec.adapter_result_strategy != "external-media.v1"):
        return None
    try:
        from platform_v8.services import external_media_verifier
    except ImportError:
        return None
    if (callable(getattr(external_media_verifier, "verify", None))
            and external_media_verifier._reviewed_policy(task_type, spec) is not None):
        return _verify_reviewed_media_result
    return None


_RESULT_STRATEGIES: dict[str, tuple[bool, str, Any]] = {}


def register_reviewed_result_strategy(strategy_id: str, *, media_required: bool,
                                      output_kind: str, resolver: Any) -> None:
    """Register a loaded, platform-owned verifier once at process startup."""
    if (not isinstance(strategy_id, str) or not strategy_id
            or strategy_id in _RESULT_STRATEGIES
            or not isinstance(output_kind, str) or not output_kind
            or not callable(resolver)):
        raise ValueError("duplicate or invalid reviewed result strategy")
    _RESULT_STRATEGIES[strategy_id] = (media_required, output_kind, resolver)


def reviewed_result_path_for(task_type: str):
    """Resolve a reviewed strategy from the signed platform task contract."""
    from platform_v8.engine.task_registry import TASK_REGISTRY
    spec = _registered_task_spec(task_type)
    return reviewed_result_path_for_spec(spec)


def reviewed_result_path_for_spec(spec: Any):
    """Check a candidate policy before its approved task type is registered."""
    if spec is None or not spec.requires_verified_adapter:
        return None
    registered = _RESULT_STRATEGIES.get(spec.adapter_result_strategy)
    if (registered is None
            or registered[0] != spec.external_artifact_verifier_required
            or registered[1] != spec.adapter_output_kind):
        return None
    path = registered[2](spec)
    return path if callable(path) else None


def _verify_inline_text_reverse_result(
    prepared: PreparedVerification, shard: Any, workload: Any,
) -> VerifiedShardResult:
    """Deterministic inline verification for the second registered sample."""
    if prepared.policy != "semantic" or prepared.artifact:
        raise ResultValidationError("inline reverse requires semantic inline proof")
    from platform_v8.engine.task_registry import TASK_REGISTRY
    from platform_v8.services.workloads.reviewed_adapter_contract import validate_reviewed_order
    spec = _registered_task_spec(workload.spec.task_type)
    if spec is None:
        raise ResultValidationError("reviewed text contract was withdrawn")
    try:
        source = validate_reviewed_order(
            spec, input_kind=str(workload.spec.input_kind or ""),
            inline_input=workload.spec.inline_input,
            params=workload.spec.params,
        )
        inline = prepared.evidence.get("inline_output")
        if not isinstance(inline, str) or len(inline.encode("utf-8")) > 32 * 1024:
            raise ValueError("bounded inline output required")
        from platform_v8.services.workloads.reviewed_media_contract import (
            _reject_constant, _unique_object,
        )
        answer = json.loads(inline, object_pairs_hook=_unique_object,
                            parse_constant=_reject_constant)
        if (not isinstance(answer, dict) or set(answer) != {"text"}
                or answer["text"] != source["text"][::-1]
                or prepared.output_ref != inline
                or prepared.content_sha256 != hashlib.sha256(inline.encode()).hexdigest()):
            raise ValueError("output is not the exact reversed text")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ResultValidationError("reviewed inline result does not match input") from exc
    return VerifiedShardResult(
        output_ref=prepared.output_ref,
        verification={
            "kind": "inline", "size_bytes": len(inline.encode("utf-8")),
            "sha256": prepared.content_sha256, "policy": "semantic",
            "original_policy": "semantic", "actual_disposition": "semantic",
            "semantic_contract": "inline-text-reverse.v1",
            "disposition": "VERIFIED", "reason_code": "", "downgrade_reason": "",
        },
        attempt=int(prepared.attempt), disposition="VERIFIED",
    )


def _verify_buyer_confirmed_structure(
    prepared: PreparedVerification, shard: Any, workload: Any,
) -> VerifiedShardResult:
    """Accept a bounded shape for preview, never as machine semantic success."""
    if prepared.policy != "semantic" or prepared.artifact:
        raise ResultValidationError("buyer-confirmed result requires inline JSON")
    from platform_v8.engine.task_registry import TASK_REGISTRY
    from platform_v8.services.workloads.reviewed_adapter_contract import validate_reviewed_order
    from platform_v8.services.workloads.reviewed_json_shape import (
        matches_shape, parse_bounded_json, validate_shape_schema,
    )
    spec = _registered_task_spec(workload.spec.task_type)
    if (spec is None or not spec.requires_verified_adapter
            or spec.adapter_result_strategy != "buyer-confirmed-structure.v1"):
        raise ResultValidationError("buyer-confirmed contract unavailable")
    raw = prepared.evidence.get("inline_output")
    try:
        validate_reviewed_order(
            spec, input_kind=str(workload.spec.input_kind or ""),
            inline_input=workload.spec.inline_input, params=workload.spec.params,
        )
        schema = validate_shape_schema(spec.adapter_output_schema)
        shape_digest = "sha256:" + hashlib.sha256(json.dumps(
            schema, sort_keys=True, separators=(",", ":"),
            ensure_ascii=False, allow_nan=False,
        ).encode("utf-8")).hexdigest()
        bound = (workload.spec.requirements or {}).get("_reviewed_task_contract")
        if (not isinstance(bound, dict)
                or bound.get("schema") != "qianshou.reviewed-workload-contract.v1"
                or bound.get("result_strategy") != "buyer-confirmed-structure.v1"
                or bound.get("output_kind") != "inline_json"
                or bound.get("output_schema_sha256") != shape_digest):
            raise ValueError("reviewed result contract changed after order creation")
        output = parse_bounded_json(raw)
        if (not matches_shape(output, schema)
                or prepared.output_ref != raw
                or prepared.content_sha256 != hashlib.sha256(raw.encode("utf-8")).hexdigest()):
            raise ValueError("result does not match reviewed output shape")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ResultValidationError("buyer-confirmed result shape invalid") from exc
    return VerifiedShardResult(
        output_ref=raw,
        verification={
            "kind": "inline", "size_bytes": len(raw.encode("utf-8")),
            "sha256": prepared.content_sha256, "policy": "semantic",
            "original_policy": "semantic", "actual_disposition": "structure",
            "semantic_contract": "buyer-confirmed-structure.v1",
            "disposition": "QUARANTINED",
            "reason_code": "BUYER_ACCEPTANCE_REQUIRED", "downgrade_reason": "",
            "machine_semantics_verified": False,
            "output_schema_sha256": shape_digest,
            "reviewed_contract_sha256": bound["contract_sha256"],
        },
        attempt=int(prepared.attempt), disposition="QUARANTINED",
        reason_code="BUYER_ACCEPTANCE_REQUIRED",
    )


def _verify_reviewed_media_result(
    prepared: PreparedVerification, shard: Any, workload: Any,
) -> VerifiedShardResult:
    if prepared.policy != "semantic" or not prepared.artifact:
        raise ResultIsolationError("external media requires semantic artifact proof",
                                   attempt=int(prepared.attempt))
    try:
        art = ArtifactV1.model_validate(prepared.artifact)
        validate_artifact_against_context(
            art, account_id=int(workload.owner_id),
            workload_id=str(workload.id), shard_id=str(shard.id),
        )
    except Exception as exc:
        raise ResultValidationError("persisted media artifact binding invalid") from exc
    if not art.object_version_id:
        raise ResultValidationError("persisted media artifact lacks exact OSS object version")
    _artifact_issuance(shard, worker_id=prepared.worker_id, artifact=art)
    if prepared.output_ref != art.to_storage_ref() or prepared.content_sha256 != art.sha256:
        raise ResultValidationError("persisted media artifact reference mismatch")
    recipe=str(workload.spec.inline_input or "")
    output_format=str((workload.spec.params or {}).get("output_format") or "")
    registered_spec=_registered_task_spec(workload.spec.task_type)
    if registered_spec and registered_spec.adapter_input_contract=="h3-prompt-fixed-frame.v1":
        from platform_v8.protocol.native_h3 import validate_order,canonical
        recipe=canonical(validate_order(input_kind="inline",inline_input=recipe,
            params=workload.spec.params or {})).decode("utf-8")
        output_format="mp4"
    from platform_v8.services import external_media_verifier
    try:
        receipt = external_media_verifier.verify(
            task_type=workload.spec.task_type,
            account_id=int(workload.owner_id), workload_id=str(workload.id),
            shard_id=str(shard.id), worker_id=prepared.worker_id,
            attempt=int(prepared.attempt), artifact=art.model_dump(by_alias=True),
            recipe=recipe,
            output_format=output_format,
        )
    except external_media_verifier.ExternalVerifierUnavailable as exc:
        raise VerificationInfrastructureError(
            str(exc), attempt=int(prepared.attempt),
        ) from exc
    except external_media_verifier.ExternalMediaRejected as exc:
        raise ResultValidationError(str(exc)) from exc
    from platform_v8.engine.task_registry import TASK_REGISTRY
    official = bool(getattr(_registered_task_spec(workload.spec.task_type),
                            "official_provider_id", ""))
    verification = {
        "kind": "artifact.v1", "size_bytes": art.size_bytes,
        "sha256": art.sha256, "object_key": art.object_key,
        "result_id": art.result_id, "policy": "semantic",
        "original_policy": "semantic", "actual_disposition": "semantic",
        "semantic_contract": "external-media.v1", "disposition": "VERIFIED",
        "reason_code": "", "downgrade_reason": "",
        "external_media_receipt": receipt,
    }
    if official:
        verification["machine_prompt_semantics_verified"] = False
        verification["output_contract"] = "decoded-static-image-v1"
    return VerifiedShardResult(
        output_ref=prepared.output_ref, verification=verification,
        attempt=int(prepared.attempt), disposition="VERIFIED",
    )


def _verify_reviewed_file_result(prepared: PreparedVerification, shard: Any, workload: Any) -> VerifiedShardResult:
    from platform_v8.protocol.generic_file import FILE_POLICY, file_schema_sha256
    from platform_v8.services import external_file_verifier
    spec = _registered_task_spec(workload.spec.task_type)
    bound = (workload.spec.requirements or {}).get("_reviewed_task_contract")
    if (prepared.policy != "artifact" or not prepared.artifact or spec is None
            or spec.adapter_result_strategy != FILE_POLICY or not spec.adapter_file_schema
            or not isinstance(bound, dict) or bound.get("result_strategy") != FILE_POLICY
            or bound.get("schema") != "qianshou.reviewed-workload-contract.v1"
            or not isinstance(bound.get("contract_sha256"), str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", bound["contract_sha256"])
            or bound.get("output_kind") != "artifact_ref"
            or bound.get("file_schema_sha256") != file_schema_sha256(spec.adapter_file_schema)):
        raise ResultValidationError("file result differs from frozen reviewed contract")
    art = ArtifactV1.model_validate(prepared.artifact)
    validate_artifact_against_context(art, account_id=int(workload.owner_id),
                                      workload_id=str(workload.id), shard_id=str(shard.id))
    _artifact_issuance(shard, worker_id=prepared.worker_id, artifact=art)
    if prepared.output_ref != art.to_storage_ref() or prepared.content_sha256 != art.sha256:
        raise ResultValidationError("file result reference mismatch")
    try:
        receipt = external_file_verifier.verify(
            task_type=workload.spec.task_type, account_id=int(workload.owner_id),
            workload_id=str(workload.id), shard_id=str(shard.id), worker_id=prepared.worker_id,
            attempt=prepared.attempt, artifact=art.model_dump(by_alias=True), file_schema=spec.adapter_file_schema)
    except external_file_verifier.ExternalVerifierUnavailable as exc:
        raise VerificationInfrastructureError("independent file verifier unavailable", attempt=prepared.attempt) from exc
    except (external_file_verifier.ExternalFileRejected, ValueError) as exc:
        raise ResultValidationError("independent file proof rejected") from exc
    evidence = {"kind": "artifact.v1", "size_bytes": art.size_bytes, "sha256": art.sha256,
                "object_key": art.object_key, "result_id": art.result_id,
                "policy": "artifact", "actual_disposition": "artifact",
                "semantic_contract": "artifact-integrity.v1", "disposition": "ARTIFACT_VERIFIED",
                "machine_semantics_verified": False, "media_semantics_verified": False,
                "file_schema_sha256": bound["file_schema_sha256"], "external_file_receipt": receipt}
    return VerifiedShardResult(output_ref=prepared.output_ref, verification=evidence,
                               attempt=prepared.attempt, disposition="ARTIFACT_VERIFIED")


register_reviewed_result_strategy(
    "independent-file-bytes.v1", media_required=True, output_kind="artifact_ref",
    resolver=lambda spec: (_verify_reviewed_file_result if getattr(spec, "adapter_file_schema", None) else None),
)
register_reviewed_result_strategy(
    "external-media.v1", media_required=True, output_kind="artifact_ref",
    resolver=lambda spec: external_media_result_path_for(spec.task_type, spec),
)
register_reviewed_result_strategy(
    "inline-text-reverse.v1", media_required=False, output_kind="inline_json",
    resolver=lambda _task_type: _verify_inline_text_reverse_result,
)
register_reviewed_result_strategy(
    "buyer-confirmed-structure.v1", media_required=False,
    output_kind="inline_json",
    resolver=lambda spec: (_verify_buyer_confirmed_structure
                           if spec.adapter_output_schema else None),
)


def verify_prepared_request(prepared: PreparedVerification) -> VerifiedShardResult:
    """Run integrity/semantic verification for one durable request."""
    shard, workload = _load_context(prepared.shard_id)
    if shard is None or workload is None:
        raise ResultValidationError("shard not found")
    _reject_unwired_external_verifier(
        workload.spec.task_type,
        attempt=int(prepared.attempt),
    )
    _require_reviewed_worker_adapter(
        workload.spec.task_type, worker_id=prepared.worker_id,
        input_kind=str(workload.spec.input_kind or ""),
        attempt=int(prepared.attempt), shard=shard,
    )
    _require_official_worker(
        workload.spec.task_type, worker_id=prepared.worker_id,
        attempt=int(prepared.attempt),
    )
    if (
        int(shard.attempts) != int(prepared.attempt)
        or str(shard.worker_id or shard.lease_by_node or "") != prepared.worker_id
        or str(shard.workload_id) != prepared.workload_id
    ):
        raise ResultValidationError("stale shard verification request")
    # 以 prepared.policy（来自 registry）为准；旧 workload quarantine 不再阻断结算
    wl_policy = str(getattr(workload.spec, "verification_policy", "") or "")
    if wl_policy and wl_policy != prepared.policy and wl_policy != "quarantine":
        raise ResultValidationError("verification policy changed")

    from platform_v8.engine.task_registry import TASK_REGISTRY
    registered = _registered_task_spec(workload.spec.task_type)
    if registered is not None and registered.requires_verified_adapter:
        path = reviewed_result_path_for(workload.spec.task_type)
        if path is None:
            reason = ("EXTERNAL_ARTIFACT_VERIFIER_REQUIRED"
                      if registered.external_artifact_verifier_required else
                      "REVIEWED_RESULT_VERIFIER_REQUIRED")
            raise ResultIsolationError(reason,
                                       attempt=int(prepared.attempt))
        return path(prepared, shard, workload)
    if registered is not None and getattr(registered, "official_provider_id", ""):
        path = external_media_result_path_for(workload.spec.task_type, registered)
        if path is None:
            raise ResultIsolationError("EXTERNAL_ARTIFACT_VERIFIER_REQUIRED",
                                       attempt=int(prepared.attempt))
        return path(prepared, shard, workload)

    art: ArtifactV1 | None = None
    materialized: bytes | None
    if prepared.artifact:
        try:
            art = ArtifactV1.model_validate(prepared.artifact)
        except Exception as exc:
            raise ResultValidationError("persisted artifact manifest is invalid") from exc
        _artifact_issuance(shard, worker_id=prepared.worker_id, artifact=art)
        try:
            if prepared.policy == "semantic":
                materialized = _read_artifact_bytes(art)
            else:
                _verify_artifact_integrity(art)
                materialized = None
        except VerificationInfrastructureError as exc:
            raise VerificationInfrastructureError(
                str(exc), attempt=int(prepared.attempt)
            ) from exc
    else:
        inline = prepared.evidence.get("inline_output")
        if not isinstance(inline, str):
            raise ResultValidationError("persisted inline result is missing")
        materialized = inline.encode("utf-8")

    verification = {
        "kind": "artifact.v1" if art is not None else "inline",
        "size_bytes": art.size_bytes if art is not None else len(materialized or b""),
        "sha256": prepared.content_sha256,
        "policy": prepared.policy,
        "original_policy": prepared.policy,
    }
    if art is not None:
        verification.update({
            "object_key": art.object_key,
            "result_id": art.result_id,
        })

    is_legacy = bool(prepared.evidence.get("adapter_version"))
    if is_legacy:
        from platform_v8.services.legacy_compat import settle_decision
        from platform_v8.services.observability import record_legacy_gate_block

        settlement_gate = settle_decision(prepared.worker_id)
        verification["adapter_metadata"] = {
            "adapter_version": prepared.evidence.get("adapter_version"),
            "legacy_shape": prepared.evidence.get("legacy_shape"),
            "binding_method": prepared.evidence.get("binding_method"),
            "gate": settlement_gate.audit(),
        }
        if not settlement_gate.allows:
            from platform_v8.services import lan_qa

            if lan_qa.force_legacy_settle():
                verification["lan_qa_settle_relax"] = True
                verification["gate_would_block"] = settlement_gate.audit()
            else:
                record_legacy_gate_block(settlement_gate, gate="settle")
                verification.update({
                    "actual_disposition": "quarantine",
                    "downgrade_reason": "legacy_settlement_gate_closed",
                    "semantic_contract": "artifact-integrity.v1",
                    "disposition": "QUARANTINED",
                    "reason_code": "LEGACY_SETTLEMENT_DISABLED",
                })
                return VerifiedShardResult(
                    output_ref=prepared.output_ref,
                    verification=verification,
                    attempt=int(prepared.attempt),
                    disposition="QUARANTINED",
                    reason_code="LEGACY_SETTLEMENT_DISABLED",
                )

    if prepared.policy == "semantic":
        if workload.spec.task_type not in {"audio_transcribe_refine", "image_compress", "qianshou_film_media"}:
            if is_legacy and art is not None:
                return _legacy_downgrade(
                    prepared,
                    verification,
                    reason="semantic_verifier_unavailable",
                )
            raise ResultValidationError("semantic policy lacks a task verifier")
        if (shard.metadata or {}).get("input_kind") == "archive":
            # P1 normalizes archives into account-owned multi_file entries
            # before planning. A legacy archive shard has no member manifest,
            # so it cannot prove per-file completion and must not settle.
            raise ResultValidationError("automatic archive result lacks normalized input manifest")
        if materialized is None:
            raise ResultValidationError("semantic artifact was not materialized")
        payload = _json_object(materialized)
        try:
            if workload.spec.task_type == "qianshou_film_media":
                try:
                    verification.update(media_compat.validate_media_result(payload, workload, shard))
                except (ValueError, KeyError, TypeError) as exc:
                    raise ResultValidationError("MEDIA_SEMANTIC_VERIFICATION_FAILED") from exc
            elif workload.spec.task_type == "audio_transcribe_refine":
                _validate_audio_transcribe_refine(
                    payload, dict(workload.spec.params or {})
                )
            else:
                _validate_image_compress(payload)
        except VerificationInfrastructureError:
            if is_legacy and art is not None:
                return _legacy_downgrade(
                    prepared,
                    verification,
                    reason="semantic_verifier_unavailable",
                )
            raise
        shard_metadata = dict(shard.metadata or {})
        receipt_required = (
            shard_metadata.get("input_kind") == "multi_file"
            and bool(shard_metadata.get("input_manifest"))
        )
        if receipt_required and payload.get("processing_receipt") is None:
            if is_legacy and art is not None:
                return _legacy_downgrade(
                    prepared,
                    verification,
                    reason="legacy_processing_receipt_missing",
                )
            raise ResultValidationError("processing receipt is missing")
        verification.update(_validate_processing_receipt(payload, shard_metadata))
        verification["semantic_contract"] = f"{workload.spec.task_type}.v1"
        verification["actual_disposition"] = "semantic"
        verification["downgrade_reason"] = ""
        disposition = "VERIFIED"
        reason_code = ""
    elif prepared.policy == "artifact":
        if art is None:
            from platform_v8.services import lan_qa

            if lan_qa.allow_inline_under_artifact() and materialized is not None:
                disposition = "ARTIFACT_VERIFIED"
                reason_code = "LEGACY_INLINE_COMPAT"
                verification["semantic_contract"] = "artifact-integrity.v1"
                # settlement gate 要求 actual_disposition == "artifact"
                verification["actual_disposition"] = "artifact"
                verification["downgrade_reason"] = "legacy_inline_under_artifact"
                verification["legacy_inline_compat"] = True
            else:
                raise ResultValidationError("artifact policy cannot verify inline output")
        else:
            disposition = "ARTIFACT_VERIFIED"
            reason_code = ""
            verification["semantic_contract"] = "artifact-integrity.v1"
            verification["actual_disposition"] = "artifact"
            verification["downgrade_reason"] = ""
    else:
        disposition = "QUARANTINED"
        reason_code = "REGISTRY_QUARANTINE"
        verification["semantic_contract"] = "none"
        verification["actual_disposition"] = "quarantine"
        verification["downgrade_reason"] = "registry_quarantine"
    verification["disposition"] = disposition
    verification["reason_code"] = reason_code
    return VerifiedShardResult(
        output_ref=prepared.output_ref,
        verification=verification,
        attempt=int(prepared.attempt),
        disposition=disposition,
        reason_code=reason_code,
    )


def verify_shard_success(
    *,
    shard_id: str,
    worker_id: str,
    lease_token: str,
    output_ref: str | None,
    inline_output: str | None,
    artifact: dict[str, Any] | None,
) -> VerifiedShardResult:
    """Compatibility synchronous path used by focused verifier tests."""
    prepared = prepare_verification_request(
        shard_id=shard_id,
        worker_id=worker_id,
        lease_token=lease_token,
        output_ref=output_ref,
        inline_output=inline_output,
        artifact=artifact,
    )
    return verify_prepared_request(prepared)
