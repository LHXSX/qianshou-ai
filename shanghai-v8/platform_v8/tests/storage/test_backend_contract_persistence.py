from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from platform_v8.core import Shard, ShardStatus, WorkloadStatus
from platform_v8.storage.repo import (
    ResultVerificationRepo,
    ShardRepo,
    VerifierCircuitRepo,
    create_all_for_testing,
    result_verifications_t,
    shards_t,
    verifier_circuits_t,
)


def _session() -> Session:
    engine = create_engine("sqlite:///:memory:", future=True)
    create_all_for_testing(engine)
    return Session(engine)


def test_v8_047_metadata_and_shard_progress_round_trip():
    assert ShardStatus.VERIFYING.value == "VERIFYING"
    assert "progress_at" in shards_t.c
    assert {
        "shard_id",
        "workload_id",
        "worker_id",
        "attempt",
        "requested_policy",
        "state",
        "disposition",
        "verifier_key",
        "content_sha256",
        "artifact",
        "evidence",
        "retry_count",
        "max_retries",
        "next_retry_at",
        "lease_until",
        "error",
        "created_at",
        "updated_at",
    }.issubset(result_verifications_t.c.keys())
    assert {
        "verifier_key",
        "state",
        "consecutive_failures",
        "opened_until",
        "probe_lease_until",
        "updated_at",
    }.issubset(verifier_circuits_t.c.keys())

    progress_at = datetime(2026, 8, 12, 5, 0, tzinfo=timezone.utc)
    with _session() as session:
        shard = Shard(
            workload_id="workload-1",
            status=ShardStatus.DISPATCHED,
            worker_id="worker-1",
            progress_at=progress_at,
        )
        ShardRepo.create_batch(session, [shard])
        loaded = ShardRepo.by_id(session, shard.id)
        assert loaded is not None
        assert loaded.progress_at is not None

        assert ShardRepo.reset_pending(session, shard.id)
        reset = ShardRepo.by_id(session, shard.id)
        assert reset is not None
        assert reset.status == ShardStatus.PENDING
        assert reset.progress_at is None


def test_result_verification_repo_retry_and_terminal_cas():
    now = datetime.now(timezone.utc)
    with _session() as session:
        created = ResultVerificationRepo.upsert(
            session,
            shard_id="shard-1",
            workload_id="workload-1",
            worker_id="worker-1",
            attempt=2,
            requested_policy="semantic",
            verifier_key="audio.v1",
            content_sha256="a" * 64,
            artifact={"object_key": "results/1.json"},
            max_retries=2,
        )
        assert created["state"] == ResultVerificationRepo.PENDING
        assert ResultVerificationRepo.current(session, "shard-1")["attempt"] == 2
        with pytest.raises(ValueError, match="contract conflicts"):
            ResultVerificationRepo.upsert(
                session,
                shard_id="shard-1",
                workload_id="workload-1",
                worker_id="other-worker",
                attempt=2,
                requested_policy="semantic",
                verifier_key="audio.v1",
                content_sha256="a" * 64,
                max_retries=2,
            )

        claimed = ResultVerificationRepo.claim_due_retries(
            session, now=now + timedelta(minutes=1), lease_seconds=30,
        )
        assert len(claimed) == 1
        assert claimed[0]["state"] == ResultVerificationRepo.LEASED

        retry_at = now + timedelta(minutes=2)
        assert ResultVerificationRepo.schedule_retry(
            session,
            "shard-1",
            2,
            retry_at=retry_at,
            error="verifier unavailable",
            expected_retry_count=0,
        )
        scheduled = ResultVerificationRepo.get(session, "shard-1", 2)
        assert scheduled is not None
        assert scheduled["state"] == ResultVerificationRepo.RETRY_SCHEDULED
        assert scheduled["retry_count"] == 1

        claimed = ResultVerificationRepo.claim_due_retries(
            session, now=retry_at + timedelta(seconds=1),
        )
        assert len(claimed) == 1
        assert ResultVerificationRepo.mark_succeeded(
            session,
            "shard-1",
            2,
            disposition="VERIFIED",
            evidence={"contract": "audio.v1"},
            expected_retry_count=1,
        )
        assert not ResultVerificationRepo.mark_failed(
            session,
            "shard-1",
            2,
            error="late failure",
            expected_retry_count=1,
        )


def test_verifier_circuit_open_probe_and_close():
    now = datetime(2026, 8, 12, 5, 0, tzinfo=timezone.utc)
    with _session() as session:
        first = VerifierCircuitRepo.record_failure(
            session, "audio.v1", failure_threshold=2, now=now,
        )
        assert first["state"] == VerifierCircuitRepo.CLOSED
        opened = VerifierCircuitRepo.record_failure(
            session,
            "audio.v1",
            failure_threshold=2,
            cooldown_seconds=10,
            now=now + timedelta(seconds=1),
        )
        assert opened["state"] == VerifierCircuitRepo.OPEN

        assert VerifierCircuitRepo.claim_half_open(
            session, "audio.v1", now=now + timedelta(seconds=5),
        ) is None
        probe = VerifierCircuitRepo.claim_half_open(
            session, "audio.v1", now=now + timedelta(seconds=12),
        )
        assert probe is not None
        assert probe["state"] == VerifierCircuitRepo.HALF_OPEN
        assert VerifierCircuitRepo.record_success(
            session,
            "audio.v1",
            expected_state=VerifierCircuitRepo.HALF_OPEN,
            now=now + timedelta(seconds=13),
        )
        assert VerifierCircuitRepo.get(session, "audio.v1")["state"] == "closed"


def test_v8_047_sql_is_conservative_and_rollback_fails_closed():
    migrations = Path(__file__).resolve().parents[2] / "migrations"
    forward = (
        migrations / "v8_047_backend_contract_hardening.sql"
    ).read_text(encoding="utf-8")
    rollback = (
        migrations / "v8_047_backend_contract_hardening_rollback.sql"
    ).read_text(encoding="utf-8")

    for status in (*WorkloadStatus, *ShardStatus):
        assert f"'{status.value}'" in forward
    for status in ("NORMALIZING", "QUARANTINED", "LEASED", "VERIFYING"):
        assert status in forward
    assert "metadata->>'actual_spend'" in forward
    assert "workload.status = 'DONE'" in forward
    assert "workload.spent = 0" in forward
    assert "shard.mode <> 'oneshot'" in forward
    assert "RAISE EXCEPTION" in rollback
    assert "SET status = 'PENDING'" not in rollback
