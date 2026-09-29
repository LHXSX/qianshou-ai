from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from platform_v8.core import (
    Shard,
    ShardStatus,
    Workload,
    WorkloadSpec,
    WorkloadStatus,
)
from platform_v8.engine.aggregator import _verification_gate_error
from platform_v8.engine.broker import _assignment_rows_from_server_frame
from platform_v8.engine.assignment_payload import (
    AssignmentPayloadError,
    build_assignment_payload,
)
from platform_v8.protocol import ws_schema
from platform_v8.protocol.capability_profile import (
    CapabilityProfile,
    merge_observation,
    observation_for_legacy_shape,
    profile_from_hello,
)
from platform_v8.services import oss_provider
from platform_v8.services.legacy_compat import (
    GateMode,
    accept_decision,
    settle_decision,
    stable_worker_bucket,
)
from platform_v8.services.legacy_result_adapter import LegacyShape
from platform_v8.services.observability import (
    legacy_metrics_snapshot,
    reset_metrics_for_test,
)
from platform_v8.services.result_verifier import (
    PreparedVerification,
    VerifiedShardResult,
    verify_prepared_request,
)
from platform_v8.storage.repo import (
    ResultVerificationRepo,
    ShardRepo,
    WorkloadRepo,
    create_all_for_testing,
)


class _Provider:
    def presign_get(self, key: str, *, expires: int):
        return {"url": f"https://objects.example.test/{key}?signed=1"}


def _routing_objects(task_type: str = "ocr_image", input_kind: str = "multi_file"):
    workload = Workload(
        id="workload-legacy",
        owner_id=7,
        spec=WorkloadSpec(
            task_type=task_type,
            input_kind=input_kind,
            input_refs=["v8/account-7/input/a.png"],
        ),
    )
    shard = Shard(
        id="shard-legacy",
        workload_id=workload.id,
        status=ShardStatus.DISPATCHED,
        worker_id="worker-legacy",
        input_ref="v8/account-7/input/a.png",
        attempts=1,
        metadata={
            "input_kind": input_kind,
            "input_refs": ["v8/account-7/input/a.png"],
            "input_manifest": {
                "schema": "input_manifest.v1",
                "semantics": "per_item",
                "entries": [{"id": "input-1"}],
            },
        },
    )
    return workload, shard


def test_profile_hello_and_observations_are_version_independent_and_monotonic():
    assert profile_from_hello(None) == CapabilityProfile.LEGACY_INLINE
    assert profile_from_hello([]) == CapabilityProfile.UNSUPPORTED
    assert profile_from_hello(
        ["lease_token_v1"]
    ) == CapabilityProfile.LEASE_INLINE_V1
    assert profile_from_hello(
        ["artifact.v1", "progress_lease.v1", "input_manifest.v1"]
    ) == CapabilityProfile.SECURE_ARTIFACT_V1
    assert profile_from_hello(
        ["legacy_inline", "secure_artifact_v1"]
    ) == CapabilityProfile.UNSUPPORTED
    assert observation_for_legacy_shape(
        LegacyShape.RESULT_OBJECT_KEY
    ) == CapabilityProfile.LEGACY_OWNED_REF
    assert merge_observation(
        CapabilityProfile.LEGACY_OWNED_REF,
        CapabilityProfile.LEGACY_INLINE,
    ) == CapabilityProfile.LEGACY_OWNED_REF
    assert merge_observation(
        CapabilityProfile.LEGACY_INLINE,
        CapabilityProfile.SECURE_ARTIFACT_V1,
    ) == CapabilityProfile.SECURE_ARTIFACT_V1


def test_stable_gate_bucket_and_modes(monkeypatch):
    first = stable_worker_bucket("worker-a")
    assert first == stable_worker_bucket("worker-a")
    assert first != stable_worker_bucket("worker-b") or first in range(100)

    monkeypatch.setenv("V8_LEGACY_RESULT_ADAPTER_ACCEPT", "shadow")
    decision = accept_decision("worker-a")
    assert decision.mode == GateMode.SHADOW
    assert not decision.allows

    monkeypatch.setenv("V8_LEGACY_RESULT_ADAPTER_ACCEPT", "100")
    assert accept_decision("worker-a").allows
    monkeypatch.setenv("V8_LEGACY_RESULT_ADAPTER_KILL_SWITCH", "1")
    assert not accept_decision("worker-a").allows
    assert not settle_decision("worker-a").allows


def test_legacy_assignment_forces_python_fallback_and_keeps_manifest(monkeypatch):
    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Provider())
    workload, shard = _routing_objects()
    payload = build_assignment_payload(
        shard,
        workload,
        worker_id="worker-legacy",
        capability_profile="legacy_inline",
    )
    assert payload.runtime == "python3"
    assert payload.executor == "python3"
    assert payload.required_tier == ""
    assert payload.fallback_tiers == []
    assert payload.native_binary == ""
    assert payload.onnx_model == ""
    assert payload.code_url.endswith("/api/v8/scripts/ocr_image.py")
    assert payload.input_manifest == shard.metadata["input_manifest"]
    rows = _assignment_rows_from_server_frame(
        ws_schema.ShardAssign(payload=payload).model_dump_json(),
        source="dispatch",
    )
    assert rows[0]["assignment_manifest"]["input_manifest"] == (
        shard.metadata["input_manifest"]
    )
    assert rows[0]["assignment_manifest"]["input_refs_count"] == 1


def test_single_and_multi_assignment_manifests_are_stable(monkeypatch):
    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Provider())
    workload, shard = _routing_objects()
    single_a = build_assignment_payload(
        shard,
        workload,
        worker_id="worker-legacy",
        capability_profile="legacy_inline",
    )
    single_b = build_assignment_payload(
        shard,
        workload,
        worker_id="worker-legacy",
        capability_profile="legacy_inline",
    )
    assert single_a.input_manifest == single_b.input_manifest

    shard.metadata["input_refs"] = [
        "v8/account-7/input/a.png",
        "v8/account-7/input/b.png",
    ]
    shard.metadata["input_manifest"] = {
        "schema": "input_manifest.v1",
        "semantics": "per_item",
        "entries": [{"id": "input-1"}, {"id": "input-2"}],
    }
    multi = build_assignment_payload(
        shard,
        workload,
        worker_id="worker-legacy",
        capability_profile="legacy_inline",
    )
    rows = _assignment_rows_from_server_frame(
        ws_schema.build_pull_assign(shards=[single_a, multi]),
        source="pull",
    )
    assert rows[0]["assignment_manifest"]["input_manifest"] == (
        single_a.input_manifest
    )
    assert rows[1]["assignment_manifest"]["input_manifest"] == (
        multi.input_manifest
    )
    assert rows[1]["assignment_manifest"]["input_refs_count"] == 2


@pytest.mark.parametrize(
    ("task_type", "input_kind", "profile"),
    [
        ("package_digest", "single_file", "legacy_inline"),
        ("ocr_image", "stream", "legacy_inline"),
        ("ocr_image", "multi_file", "unsupported"),
    ],
)
def test_legacy_unsupported_routing_fails_closed(
    monkeypatch, task_type, input_kind, profile
):
    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Provider())
    workload, shard = _routing_objects(task_type, input_kind)
    with pytest.raises(AssignmentPayloadError):
        build_assignment_payload(
            shard,
            workload,
            worker_id="worker-legacy",
            capability_profile=profile,
        )


def _legacy_semantic_context():
    workload = Workload(
        id="workload-semantic",
        owner_id=7,
        spec=WorkloadSpec(
            task_type="audio_transcribe_refine",
            input_kind="multi_file",
            verification_policy="semantic",
        ),
    )
    artifact = {
        "schema": "artifact.v1",
        "object_key": (
            "v8/account-7/workload-workload-semantic/shard-shard-semantic/"
            "result/result-1/result.json"
        ),
        "filename": "result.json",
        "size_bytes": 2,
        "content_type": "application/json",
        "sha256": "a" * 64,
        "result_id": "result-1",
        "shard_id": "shard-semantic",
        "workload_id": "workload-semantic",
        "account_id": 7,
    }
    shard = Shard(
        id="shard-semantic",
        workload_id=workload.id,
        status=ShardStatus.VERIFYING,
        worker_id="worker-legacy",
        attempts=2,
        metadata={
            "input_kind": "multi_file",
            "input_manifest": {
                "schema": "input_manifest.v1",
                "semantics": "single_item",
                "entries": [{
                    "id": "input-1",
                    "source_index": 0,
                    "name": "audio.wav",
                    "size_bytes": 1,
                }],
                "total_entries": 1,
            },
            "result_upload_issuance": {
                "worker_id": "worker-legacy",
                "attempt": 2,
                "object_key": artifact["object_key"],
                "result_id": artifact["result_id"],
                "size_bytes": artifact["size_bytes"],
                "sha256": artifact["sha256"],
                "content_type": artifact["content_type"],
                "expires_at": 4_000_000_000,
            },
        },
    )
    prepared = PreparedVerification(
        shard_id=shard.id,
        workload_id=workload.id,
        worker_id="worker-legacy",
        attempt=2,
        policy="semantic",
        verifier_key="audio_transcribe_refine.v1",
        output_ref=json.dumps(artifact),
        content_sha256=artifact["sha256"],
        artifact=artifact,
        evidence={
            "adapter_version": "legacy-result.v1",
            "legacy_shape": "result_inline",
            "binding_method": "assignment_delivery",
        },
    )
    payload = {
        "status": "ok",
        "contract_version": "1",
        "task_type": "audio_transcribe_refine",
        "result_files_b64": {
            "result.json": "e30=",
            "result.srt": "",
            "result_dialogue.txt": "",
        },
        "results": [{"segments_count": 0}],
        "summary": {"total_files": 1, "segments": 0},
    }
    return workload, shard, prepared, json.dumps(payload).encode()


def test_legacy_semantic_missing_receipt_has_explicit_downgrade(
    monkeypatch,
):
    workload, shard, prepared, body = _legacy_semantic_context()
    monkeypatch.setenv("V8_LEGACY_RESULT_ADAPTER_SETTLE", "100")
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._load_context",
        lambda _shard_id: (shard, workload),
    )
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._read_artifact_bytes",
        lambda _artifact: body,
    )
    verified = verify_prepared_request(prepared)
    assert verified.disposition == "LEGACY_ARTIFACT_VERIFIED"
    assert verified.verification["actual_disposition"] == "legacy_artifact"
    assert verified.verification["original_policy"] == "semantic"
    assert verified.verification["downgrade_reason"] == (
        "legacy_processing_receipt_missing"
    )


def test_legacy_missing_semantic_verifier_has_explicit_downgrade(monkeypatch):
    workload, shard, prepared, body = _legacy_semantic_context()
    workload.spec.task_type = "semantic_without_verifier"
    prepared = PreparedVerification(
        **{
            **prepared.__dict__,
            "verifier_key": "semantic_without_verifier.v1",
        }
    )
    monkeypatch.setenv("V8_LEGACY_RESULT_ADAPTER_SETTLE", "100")
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._load_context",
        lambda _shard_id: (shard, workload),
    )
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._read_artifact_bytes",
        lambda _artifact: body,
    )
    verified = verify_prepared_request(prepared)
    assert verified.disposition == "LEGACY_ARTIFACT_VERIFIED"
    assert verified.verification["actual_disposition"] == "legacy_artifact"
    assert verified.verification["downgrade_reason"] == (
        "semantic_verifier_unavailable"
    )


def test_settle_off_quarantines_after_artifact_verification(monkeypatch):
    reset_metrics_for_test()
    workload, shard, prepared, body = _legacy_semantic_context()
    monkeypatch.setenv("V8_LEGACY_RESULT_ADAPTER_SETTLE", "off")
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._load_context",
        lambda _shard_id: (shard, workload),
    )
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._read_artifact_bytes",
        lambda _artifact: body,
    )
    verified = verify_prepared_request(prepared)
    assert verified.disposition == "QUARANTINED"
    assert verified.verification["actual_disposition"] == "quarantine"
    assert verified.verification["reason_code"] == "LEGACY_SETTLEMENT_DISABLED"
    assert legacy_metrics_snapshot()["legacy_gate_block_total"][
        ("settle", "off", "env")
    ] == 1


def test_quarantined_verification_persists_manual_state_without_spend(
    monkeypatch,
):
    reset_metrics_for_test()
    from platform_v8.services import result_verification_jobs as jobs

    engine = create_engine(
        "sqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    create_all_for_testing(engine)
    workload = Workload(
        id="workload-manual",
        owner_id=7,
        status=WorkloadStatus.RUNNING,
        budget=10,
        spec=WorkloadSpec(
            task_type="video_compress",
            verification_policy="artifact",
        ),
    )
    shard = Shard(
        id="shard-manual",
        workload_id=workload.id,
        status=ShardStatus.VERIFYING,
        worker_id="worker-legacy",
        attempts=1,
    )
    with Session(engine) as session:
        WorkloadRepo.create(session, workload)
        ShardRepo.create_batch(session, [shard])
        ResultVerificationRepo.upsert(
            session,
            shard_id=shard.id,
            workload_id=workload.id,
            worker_id=shard.worker_id,
            attempt=1,
            requested_policy="artifact",
            verifier_key="artifact.v1",
            content_sha256="a" * 64,
            artifact={"schema": "artifact.v1"},
            evidence={"adapter_version": "legacy-result.v1"},
        )
        rows = ResultVerificationRepo.claim_due_retries(session)
        session.commit()
    assert len(rows) == 1

    @contextmanager
    def scope():
        with Session(engine) as session:
            yield session

    monkeypatch.setattr(jobs.db_mod, "session_scope", scope)
    outcome = jobs._complete_success(
        rows[0],
        VerifiedShardResult(
            output_ref="artifact",
            verification={
                "actual_disposition": "quarantine",
                "reason_code": "LEGACY_SETTLEMENT_DISABLED",
            },
            attempt=1,
            disposition="QUARANTINED",
            reason_code="LEGACY_SETTLEMENT_DISABLED",
        ),
        expected_circuit_state=None,
        now=datetime.now(timezone.utc),
    )
    assert outcome == "quarantined"
    with Session(engine) as session:
        stored_workload = WorkloadRepo.by_id(session, workload.id)
        stored_row = ResultVerificationRepo.get(session, shard.id, 1)
    assert stored_workload.status == WorkloadStatus.QUARANTINED
    assert stored_workload.spent == 0
    assert stored_row["state"] == ResultVerificationRepo.SUCCEEDED
    assert stored_row["disposition"] == "QUARANTINED"
    assert legacy_metrics_snapshot()["legacy_settlement_total"][
        ("settlement_blocked", "settlement_gate_closed")
    ] == 1


def test_missing_verification_never_settles_and_strict_parser_ignores_kill(
    monkeypatch,
):
    workload, shard, _prepared, _body = _legacy_semantic_context()
    shard.status = ShardStatus.DONE
    assert "missing verification" in _verification_gate_error(
        workload, [shard], []
    )

    monkeypatch.setenv("V8_LEGACY_RESULT_ADAPTER_KILL_SWITCH", "1")
    strict = ws_schema.parse_incoming(json.dumps({
        "type": "shard_result",
        "v": "8.0",
        "payload": {
            "shard_id": "shard-semantic",
            "ok": True,
            "inline_output": "{}",
            "attempt": 2,
            "lease_token": "valid-shape-token",
        },
    }))
    assert isinstance(strict, ws_schema.ShardResult)
