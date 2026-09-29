from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from contextlib import contextmanager
import hashlib
from dataclasses import replace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from platform_v8.core import (
    Shard,
    ShardStatus,
    Workload,
    WorkloadSpec,
    WorkloadStatus,
)
from platform_v8.engine.aggregator import (
    _logical_unit_id,
    _verification_gate_error,
)
from platform_v8.engine.task_registry import (
    TASK_REGISTRY,
    TaskMode,
    _resolve_settlement_policy,
    get_spec,
)
from platform_v8.protocol.artifact import ArtifactV1, build_object_key
from platform_v8.services.economy import anti_cheat
from platform_v8.services.economy.anti_cheat import (
    CheatVerdict,
    evaluate_redundant_results,
)
from platform_v8.services import result_verification_jobs as verification_jobs
from platform_v8.services.observability import (
    legacy_metrics_snapshot,
    reset_metrics_for_test,
)
from platform_v8.services.result_verification_jobs import _config, _retry_at
from platform_v8.services.result_verifier import (
    ResultIsolationError,
    ResultValidationError,
    VerificationInfrastructureError,
    _read_artifact_bytes,
    prepare_verification_request,
    verify_prepared_request,
)
from platform_v8.storage.repo import (
    ResultVerificationRepo,
    ShardRepo,
    VerifierCircuitRepo,
    WorkloadRepo,
    create_all_for_testing,
)


def _artifact_context(task_type: str = "video_compress"):
    workload = Workload(
        id="workload-a",
        owner_id=7,
        spec=WorkloadSpec(
            task_type=task_type,
            verification_policy=(
                "semantic"
                if task_type == "audio_transcribe_refine"
                else "artifact"
            ),
        ),
        status=WorkloadStatus.RUNNING,
    )
    object_key = build_object_key(
        account_id=7,
        workload_id=workload.id,
        shard_id="shard-a",
        result_id="result-a",
        filename="result.json",
    )
    artifact = ArtifactV1(
        schema="artifact.v1",
        object_key=object_key,
        filename="result.json",
        size_bytes=2,
        content_type="application/json",
        sha256="a" * 64,
        result_id="result-a",
        shard_id="shard-a",
        workload_id=workload.id,
        account_id=7,
    )
    shard = Shard(
        id="shard-a",
        workload_id=workload.id,
        status=ShardStatus.RUNNING,
        worker_id="worker-a",
        attempts=2,
        metadata={
            "result_upload_issuance": {
                "worker_id": "worker-a",
                "attempt": 2,
                "object_key": object_key,
                "result_id": "result-a",
                "size_bytes": 2,
                "sha256": "a" * 64,
                "content_type": "application/json",
                "expires_at": 4_000_000_000,
            }
        },
    )
    return workload, shard, artifact


def test_registry_resolves_only_registered_oneshot_tasks_to_settleable_policy():
    assert get_spec("audio_transcribe_refine").settlement_policy == "semantic"
    assert get_spec("image_compress").settlement_policy == "semantic"
    assert get_spec("__unknown_task__").settlement_policy == "quarantine"
    for spec in TASK_REGISTRY.values():
        if spec.mode == TaskMode.ONESHOT:
            assert spec.settlement_policy in {"semantic", "artifact"}
        else:
            assert spec.settlement_policy == "quarantine"


def test_legacy_auto_policy_normalizes_to_semantic():
    legacy = replace(
        get_spec("audio_transcribe_refine"),
        settlement_policy="auto",  # type: ignore[arg-type]
    )
    assert _resolve_settlement_policy(legacy).settlement_policy == "semantic"


def test_artifact_prepare_requires_server_issuance_and_current_lease(monkeypatch):
    workload, shard, artifact = _artifact_context()
    # Strict artifact.v1 verification is independent of every legacy gate.
    monkeypatch.setenv("V8_LEGACY_RESULT_ADAPTER_SETTLE", "off")
    monkeypatch.setenv("V8_LEGACY_RESULT_ADAPTER_KILL_SWITCH", "1")
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._load_context",
        lambda _shard_id: (shard, workload),
    )
    monkeypatch.setattr(
        "platform_v8.services.result_verifier.verify_lease_token",
        lambda *_args, **_kwargs: True,
    )
    prepared = prepare_verification_request(
        shard_id=shard.id,
        worker_id="worker-a",
        lease_token="lease",
        output_ref=artifact.to_storage_ref(),
        inline_output=None,
        artifact=artifact.model_dump(by_alias=True),
    )
    assert prepared.policy == "artifact"
    assert prepared.attempt == 2
    assert prepared.content_sha256 == "a" * 64
    assert "adapter_version" not in prepared.evidence
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._verify_artifact_integrity",
        lambda _artifact: None,
    )
    verified = verify_prepared_request(prepared)
    assert verified.disposition == "ARTIFACT_VERIFIED"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("worker_id", "worker-b"),
        ("attempt", 1),
        ("result_id", "result-b"),
        ("size_bytes", 3),
        ("sha256", "b" * 64),
    ],
)
def test_artifact_prepare_rejects_forged_issuance(monkeypatch, field, value):
    workload, shard, artifact = _artifact_context()
    shard.metadata["result_upload_issuance"][field] = value
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._load_context",
        lambda _shard_id: (shard, workload),
    )
    monkeypatch.setattr(
        "platform_v8.services.result_verifier.verify_lease_token",
        lambda *_args, **_kwargs: True,
    )
    with pytest.raises(ResultValidationError, match="not issued"):
        prepare_verification_request(
            shard_id=shard.id,
            worker_id="worker-a",
            lease_token="lease",
            output_ref=artifact.to_storage_ref(),
            inline_output=None,
            artifact=artifact.model_dump(by_alias=True),
        )


def test_artifact_policy_never_accepts_legacy_inline_result(monkeypatch):
    workload, shard, _artifact = _artifact_context()
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._load_context",
        lambda _shard_id: (shard, workload),
    )
    monkeypatch.setattr(
        "platform_v8.services.result_verifier.verify_lease_token",
        lambda *_args, **_kwargs: True,
    )
    with pytest.raises(ResultIsolationError):
        prepare_verification_request(
            shard_id=shard.id,
            worker_id="worker-a",
            lease_token="lease",
            output_ref=None,
            inline_output="legacy",
            artifact=None,
        )


def test_artifact_prepare_rejects_wrong_object_owner(monkeypatch):
    workload, shard, artifact = _artifact_context()
    forged = artifact.model_copy(update={"account_id": 8})
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._load_context",
        lambda _shard_id: (shard, workload),
    )
    monkeypatch.setattr(
        "platform_v8.services.result_verifier.verify_lease_token",
        lambda *_args, **_kwargs: True,
    )
    with pytest.raises(ResultValidationError):
        prepare_verification_request(
            shard_id=shard.id,
            worker_id="worker-a",
            lease_token="lease",
            output_ref=forged.to_storage_ref(),
            inline_output=None,
            artifact=forged.model_dump(by_alias=True),
        )


@pytest.mark.parametrize(
    ("body", "declared_size", "declared_sha", "message"),
    [
        (b"x", 2, hashlib.sha256(b"x").hexdigest(), "size mismatch"),
        (b"ok", 2, "b" * 64, "sha256 mismatch"),
    ],
)
def test_artifact_materialization_checks_actual_size_and_sha(
    monkeypatch, body, declared_size, declared_sha, message
):
    _workload, _shard, artifact = _artifact_context()
    artifact = artifact.model_copy(update={
        "size_bytes": declared_size,
        "sha256": declared_sha,
    })

    class Response:
        status = 200

        def __init__(self):
            self._read = False

        def read(self, _size):
            if self._read:
                return b""
            self._read = True
            return body

    @contextmanager
    def stream(_url, *, policy):
        yield Response()

    class Provider:
        def presign_get(self, _key, expires):
            return {"url": "https://storage.invalid/result"}

    monkeypatch.setattr(
        "platform_v8.services.oss_provider.get_oss_provider",
        lambda: Provider(),
    )
    monkeypatch.setattr(
        "platform_v8.services.url_safety.safe_stream", stream
    )
    with pytest.raises(ResultValidationError, match=message):
        _read_artifact_bytes(artifact)


def test_large_artifact_policy_streams_without_semantic_materialization(monkeypatch):
    workload, shard, artifact = _artifact_context()
    chunk = b"x" * (32 * 1024)
    chunk_count = 4
    size = len(chunk) * chunk_count
    digest = hashlib.sha256(chunk * chunk_count).hexdigest()
    artifact = artifact.model_copy(update={"size_bytes": size, "sha256": digest})
    issuance = shard.metadata["result_upload_issuance"]
    issuance["size_bytes"] = size
    issuance["sha256"] = digest
    monkeypatch.setenv("V8_RESULT_VERIFY_MAX_BYTES", str(64 * 1024))
    monkeypatch.setenv("V8_RESULT_VERIFY_MAX_ARTIFACT_BYTES", str(1024 * 1024))

    class Response:
        status = 200

        def __init__(self):
            self.remaining = chunk_count
            self.read_calls = 0

        def read(self, _size):
            self.read_calls += 1
            if self.remaining <= 0:
                return b""
            self.remaining -= 1
            return chunk

    response = Response()

    @contextmanager
    def stream(_url, *, policy):
        assert policy.max_response_bytes == 1024 * 1024
        yield response

    class Provider:
        def presign_get(self, _key, expires):
            return {"url": "https://storage.invalid/large"}

    monkeypatch.setattr(
        "platform_v8.services.oss_provider.get_oss_provider",
        lambda: Provider(),
    )
    monkeypatch.setattr("platform_v8.services.url_safety.safe_stream", stream)
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._load_context",
        lambda _shard_id: (shard, workload),
    )
    monkeypatch.setattr(
        "platform_v8.services.result_verifier.verify_lease_token",
        lambda *_args, **_kwargs: True,
    )
    prepared = prepare_verification_request(
        shard_id=shard.id,
        worker_id="worker-a",
        lease_token="lease",
        output_ref=artifact.to_storage_ref(),
        inline_output=None,
        artifact=artifact.model_dump(by_alias=True),
    )
    verified = verify_prepared_request(prepared)
    assert verified.disposition == "ARTIFACT_VERIFIED"
    assert verified.verification["size_bytes"] == size
    assert response.read_calls == chunk_count + 1


def test_large_semantic_artifact_rejects_before_transport(monkeypatch):
    workload, shard, artifact = _artifact_context("audio_transcribe_refine")
    size = 128 * 1024
    artifact = artifact.model_copy(update={
        "size_bytes": size,
        "sha256": "c" * 64,
    })
    issuance = shard.metadata["result_upload_issuance"]
    issuance["size_bytes"] = size
    issuance["sha256"] = "c" * 64
    monkeypatch.setenv("V8_RESULT_VERIFY_MAX_BYTES", str(64 * 1024))
    monkeypatch.setenv("V8_RESULT_VERIFY_MAX_ARTIFACT_BYTES", str(1024 * 1024))
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._load_context",
        lambda _shard_id: (shard, workload),
    )
    monkeypatch.setattr(
        "platform_v8.services.result_verifier.verify_lease_token",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        "platform_v8.services.url_safety.safe_stream",
        lambda *_args, **_kwargs: pytest.fail("semantic oversize must not fetch"),
    )
    prepared = prepare_verification_request(
        shard_id=shard.id,
        worker_id="worker-a",
        lease_token="lease",
        output_ref=artifact.to_storage_ref(),
        inline_output=None,
        artifact=artifact.model_dump(by_alias=True),
    )
    with pytest.raises(ResultValidationError, match="semantic artifact exceeds"):
        verify_prepared_request(prepared)


def test_semantic_policy_does_not_fall_back_to_artifact_integrity(monkeypatch):
    workload, shard, artifact = _artifact_context("audio_transcribe_refine")
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._load_context",
        lambda _shard_id: (shard, workload),
    )
    monkeypatch.setattr(
        "platform_v8.services.result_verifier.verify_lease_token",
        lambda *_args, **_kwargs: True,
    )
    prepared = prepare_verification_request(
        shard_id=shard.id,
        worker_id="worker-a",
        lease_token="lease",
        output_ref=artifact.to_storage_ref(),
        inline_output=None,
        artifact=artifact.model_dump(by_alias=True),
    )
    monkeypatch.setattr(
        "platform_v8.services.result_verifier._read_artifact_bytes",
        lambda _artifact: b"{}",
    )
    with pytest.raises(ResultValidationError, match="status"):
        verify_prepared_request(prepared)


def test_retry_backoff_is_exponential_and_bounded(monkeypatch):
    monkeypatch.setenv("V8_RESULT_VERIFY_BACKOFF_S", "2")
    monkeypatch.setenv("V8_RESULT_VERIFY_MAX_BACKOFF_S", "5")
    now = datetime(2026, 8, 12, tzinfo=timezone.utc)
    cfg = _config()
    delays = [
        (_retry_at(
            {"retry_count": retry},
            now=now,
            cfg=cfg,
            jitter=lambda _a, _b: 0,
        ) - now).total_seconds()
        for retry in range(4)
    ]
    assert delays == [2, 4, 5, 5]


def test_circuit_open_defers_without_budget_then_half_open_failure_consumes_one(
    monkeypatch,
):
    engine = create_engine("sqlite:///:memory:", future=True)
    create_all_for_testing(engine)

    @contextmanager
    def session_scope():
        with Session(engine) as session:
            yield session

    shard = Shard(
        id="circuit-shard",
        workload_id="circuit-workload",
        status=ShardStatus.VERIFYING,
        worker_id="worker-a",
        attempts=1,
    )
    with Session(engine) as session:
        ShardRepo.create_batch(session, [shard])
        ResultVerificationRepo.upsert(
            session,
            shard_id=shard.id,
            workload_id=shard.workload_id,
            worker_id=shard.worker_id,
            attempt=shard.attempts,
            requested_policy="artifact",
            verifier_key="artifact.v1",
            content_sha256="a" * 64,
            artifact={"schema": "artifact.v1"},
            evidence={"output_ref": "artifact"},
            max_retries=3,
        )
        session.commit()

    cfg = {
        "max_retries": 3,
        "failure_threshold": 1,
        "cooldown_seconds": 1,
        "base_backoff_seconds": 1,
        "max_backoff_seconds": 8,
        "lease_seconds": 30,
        "batch_size": 10,
    }
    monkeypatch.setattr(
        verification_jobs.db_mod, "session_scope", session_scope
    )
    monkeypatch.setattr(verification_jobs, "_config", lambda: cfg)
    real_circuit_access = verification_jobs._circuit_access
    monkeypatch.setattr(
        verification_jobs,
        "_circuit_access",
        lambda _key, *, now, cfg: (
            False,
            None,
            now + timedelta(seconds=1),
        ),
    )
    verify_calls = 0

    def infrastructure_failure(_prepared):
        nonlocal verify_calls
        verify_calls += 1
        raise VerificationInfrastructureError("storage unavailable", attempt=1)

    monkeypatch.setattr(
        verification_jobs, "verify_prepared_request", infrastructure_failure
    )
    start = datetime.now(timezone.utc) + timedelta(seconds=1)
    for offset in (0, 2, 4):
        verification_jobs.process_due_verifications(
            clock=lambda offset=offset: start + timedelta(seconds=offset),
            jitter=lambda _a, _b: 0,
        )
    with Session(engine) as session:
        deferred = ResultVerificationRepo.get(session, shard.id, 1)
    assert deferred["retry_count"] == 0
    assert verify_calls == 0

    with Session(engine) as session:
        VerifierCircuitRepo.record_failure(
            session,
            "artifact.v1",
            failure_threshold=1,
            cooldown_seconds=1,
            now=start,
        )
        session.commit()
    monkeypatch.setattr(
        verification_jobs, "_circuit_access", real_circuit_access
    )
    verification_jobs.process_due_verifications(
        clock=lambda: start + timedelta(seconds=6),
        jitter=lambda _a, _b: 0,
    )
    with Session(engine) as session:
        retried = ResultVerificationRepo.get(session, shard.id, 1)
        circuit = VerifierCircuitRepo.get(session, "artifact.v1")
    assert verify_calls == 1
    assert retried["retry_count"] == 1
    assert retried["state"] == ResultVerificationRepo.RETRY_SCHEDULED
    assert circuit["state"] == VerifierCircuitRepo.OPEN


def test_recovery_exhausts_three_verify_retries_without_recompute(monkeypatch):
    reset_metrics_for_test()
    engine = create_engine("sqlite:///:memory:", future=True)
    create_all_for_testing(engine)

    @contextmanager
    def session_scope():
        with Session(engine) as session:
            yield session

    shard = Shard(
        id="recover-shard",
        workload_id="recover-workload",
        status=ShardStatus.VERIFYING,
        worker_id="worker-a",
        attempts=2,
    )
    with Session(engine) as session:
        ShardRepo.create_batch(session, [shard])
        ResultVerificationRepo.upsert(
            session,
            shard_id=shard.id,
            workload_id=shard.workload_id,
            worker_id=shard.worker_id,
            attempt=shard.attempts,
            requested_policy="artifact",
            verifier_key="artifact.v1",
            content_sha256="a" * 64,
            artifact={"schema": "artifact.v1"},
            evidence={
                "output_ref": "artifact",
                "adapter_version": "legacy-result.v1",
            },
            max_retries=3,
        )
        session.commit()

    monkeypatch.setattr(
        verification_jobs.db_mod, "session_scope", session_scope
    )
    verify_calls = 0

    def infrastructure_failure(_prepared):
        nonlocal verify_calls
        verify_calls += 1
        raise VerificationInfrastructureError("storage unavailable", attempt=2)

    monkeypatch.setattr(
        verification_jobs, "verify_prepared_request", infrastructure_failure
    )
    monkeypatch.setattr(
        verification_jobs,
        "_config",
        lambda: {
            "max_retries": 3,
            "failure_threshold": 20,
            "cooldown_seconds": 10,
            "base_backoff_seconds": 1,
            "max_backoff_seconds": 8,
            "lease_seconds": 30,
            "batch_size": 10,
        },
    )
    start = datetime.now(timezone.utc) + timedelta(seconds=1)
    for offset in (0, 2, 5, 10):
        verification_jobs.process_due_verifications(
            clock=lambda offset=offset: start + timedelta(seconds=offset),
            jitter=lambda _a, _b: 0,
        )

    with Session(engine) as session:
        row = ResultVerificationRepo.get(session, shard.id, 2)
        refreshed = ShardRepo.by_id(session, shard.id)
    assert row["state"] == ResultVerificationRepo.FAILED
    assert row["retry_count"] == 3
    # retry_count == max_retries remains claimable for the final actual call:
    # one initial call plus three retries.
    assert verify_calls == 4
    assert refreshed.status == ShardStatus.FAILED
    assert refreshed.attempts == 2
    assert refreshed.worker_id == "worker-a"
    assert legacy_metrics_snapshot()["legacy_replay_total"][
        ("durable_retry", "verification")
    ] == 3


def _verification(shard: Shard, digest: str) -> dict:
    return {
        "shard_id": shard.id,
        "workload_id": shard.workload_id,
        "worker_id": shard.worker_id,
        "attempt": shard.attempts,
        "requested_policy": "artifact",
        "state": "SUCCEEDED",
        "disposition": "ARTIFACT_VERIFIED",
        "content_sha256": digest,
    }


def test_settlement_gate_rejects_stale_and_accepts_current_verification():
    workload = Workload(
        id="workload-a",
        spec=WorkloadSpec(verification_policy="artifact"),
    )
    shard = Shard(
        id="shard-a",
        workload_id=workload.id,
        worker_id="worker-a",
        attempts=3,
        status=ShardStatus.DONE,
    )
    current = _verification(shard, "a" * 64)
    assert _verification_gate_error(workload, [shard], [current]) is None
    stale = dict(current, attempt=2)
    assert "attempt mismatch" in _verification_gate_error(
        workload, [shard], [stale]
    )


@pytest.mark.parametrize(
    ("rows", "expected"),
    [
        ([], "missing verification"),
        ([{"state": "PENDING"}], "verification incomplete"),
        ([{"state": "FAILED"}], "verification incomplete"),
    ],
)
def test_missing_pending_and_failed_verification_cannot_enter_reward_gate(
    rows, expected,
):
    workload = Workload(
        id="workload-gated",
        spec=WorkloadSpec(verification_policy="artifact"),
    )
    shard = Shard(
        id="shard-gated",
        workload_id=workload.id,
        worker_id="worker-gated",
        attempts=1,
        status=ShardStatus.DONE,
    )
    verification_rows = []
    if rows:
        verification_rows = [{
            **_verification(shard, "a" * 64),
            **rows[0],
        }]
    assert expected in _verification_gate_error(
        workload, [shard], verification_rows,
    )


def test_two_replicas_must_match_and_missing_digest_has_no_canonical():
    shards = [
        Shard(
            id=f"s-{idx}",
            workload_id="w",
            worker_id=f"worker-{idx}",
            status=ShardStatus.DONE,
            metadata={"replica_of": "logical-1"},
        )
        for idx in range(2)
    ]
    mismatch = {
        shards[0].id: _verification(shards[0], "a" * 64),
        shards[1].id: _verification(shards[1], "b" * 64),
    }
    verdict = evaluate_redundant_results("w", shards, mismatch)
    assert not verdict.has_canonical
    assert verdict.cheating_nodes == []

    missing = {shards[0].id: mismatch[shards[0].id]}
    assert not evaluate_redundant_results("w", shards, missing).has_canonical


def test_strict_majority_excludes_cheating_worker_and_replica_bills_once():
    shards = [
        Shard(
            id=f"s-{idx}",
            workload_id="w",
            worker_id=f"worker-{idx}",
            status=ShardStatus.DONE,
            metadata={"replica_of": "logical-1"},
        )
        for idx in range(3)
    ]
    rows = {
        shard.id: _verification(
            shard, "a" * 64 if idx < 2 else "b" * 64
        )
        for idx, shard in enumerate(shards)
    }
    verdict = evaluate_redundant_results("w", shards, rows)
    assert verdict.honest_nodes == ["worker-0", "worker-1"]
    assert verdict.cheating_nodes == ["worker-2"]
    assert {_logical_unit_id(shard) for shard in shards} == {"logical-1"}


def test_penalty_failure_propagates_for_aggregator_fail_closed(monkeypatch):
    called: list[str] = []

    def fail_one(worker_id, _outcome):
        called.append(worker_id)
        if worker_id == "worker-1":
            raise RuntimeError("sensitive dependency detail")

    monkeypatch.setattr(anti_cheat, "observe_shard", fail_one)
    verdict = CheatVerdict(
        workload_id="workload-a",
        cheating_nodes=["worker-1", "worker-2"],
    )
    with pytest.raises(RuntimeError, match="penalties failed for 1 worker"):
        anti_cheat.punish_cheaters(None, verdict)  # type: ignore[arg-type]
    assert called == ["worker-1", "worker-2"]


def test_penalty_false_persistence_signal_also_fails_closed(monkeypatch):
    monkeypatch.setattr(
        anti_cheat, "observe_shard", lambda _worker_id, _outcome: False
    )
    verdict = CheatVerdict(
        workload_id="workload-a",
        cheating_nodes=["worker-1"],
    )
    with pytest.raises(RuntimeError, match="penalties failed"):
        anti_cheat.punish_cheaters(None, verdict)  # type: ignore[arg-type]


def test_set_spent_is_transactional_and_status_guarded():
    engine = create_engine("sqlite:///:memory:", future=True)
    create_all_for_testing(engine)
    workload = Workload(
        id="workload-spent",
        owner_id=1,
        status=WorkloadStatus.AGGREGATING,
        budget=Decimal("10"),
    )
    with Session(engine) as session:
        WorkloadRepo.create(session, workload)
        session.commit()
        assert WorkloadRepo.set_spent(
            session,
            workload.id,
            Decimal("7.5000"),
            expected_status=WorkloadStatus.AGGREGATING,
        )
        session.rollback()
        assert WorkloadRepo.by_id(session, workload.id).spent == Decimal("0")
        assert WorkloadRepo.set_spent(
            session,
            workload.id,
            Decimal("7.5000"),
            expected_status=WorkloadStatus.AGGREGATING,
        )
        session.commit()
        assert WorkloadRepo.by_id(session, workload.id).spent == Decimal("7.5000")
        WorkloadRepo.transition_status(
            session,
            workload.id,
            WorkloadStatus.DONE,
            expected_statuses=(WorkloadStatus.AGGREGATING,),
        )
        assert not WorkloadRepo.set_spent(
            session,
            workload.id,
            Decimal("10"),
            expected_status=WorkloadStatus.AGGREGATING,
        )
