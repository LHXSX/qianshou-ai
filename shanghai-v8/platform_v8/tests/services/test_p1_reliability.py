from __future__ import annotations

import asyncio
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from platform_v8.core import Shard, ShardStatus
from platform_v8.engine import lifecycle
from platform_v8.engine.aggregator import partial_delivery_settlement
from platform_v8.engine.planner import schedule_assignments
from platform_v8.protocol.artifact import ArtifactV1, build_object_key
from platform_v8.services.result_verifier import ResultValidationError, _read_artifact_bytes
from platform_v8.storage.repo import ShardRepo, create_all_for_testing
from platform_v8.core.worker import Worker


def test_partial_delivery_settlement_refunds_unverified_units() -> None:
    spend, refund = partial_delivery_settlement(Decimal("10"), 3, 1)
    assert spend == Decimal("7.5000")
    assert refund == Decimal("2.5000")


def test_partial_delivery_with_no_verified_units_refunds_all() -> None:
    assert partial_delivery_settlement(Decimal("10"), 0, 4) == (
        Decimal("0"), Decimal("10"),
    )


def test_infrastructure_retry_freezes_same_compute_attempt() -> None:
    engine = create_engine("sqlite:///:memory:", future=True)
    create_all_for_testing(engine)
    shard = Shard(
        workload_id="workload",
        status=ShardStatus.RUNNING,
        worker_id="worker-a",
        attempts=1,
        metadata={
            "result_upload_issuance": {
                "object_key": "v8/account-1/workload-workload/shard-s/result/r/out.json",
            }
        },
    )
    with Session(engine) as session:
        ShardRepo.create_batch(session, [shard])
        session.commit()
        assert ShardRepo.begin_verification(
            session,
            shard.id,
            expected_worker_id="worker-a",
            expected_attempt=1,
        )
        session.commit()
        refreshed = ShardRepo.by_id(session, shard.id)
    assert refreshed is not None
    assert refreshed.status == ShardStatus.VERIFYING
    assert refreshed.attempts == 1
    assert refreshed.worker_id == "worker-a"
    assert refreshed.metadata["result_upload_issuance"]["object_key"].endswith("out.json")


def test_artifact_verification_rejects_declared_size_over_budget(monkeypatch) -> None:
    monkeypatch.setenv("V8_RESULT_VERIFY_MAX_BYTES", "65536")
    artifact = ArtifactV1(
        schema="artifact.v1",
        object_key=build_object_key(
            account_id=1, workload_id="w", shard_id="s", result_id="r", filename="out.json",
        ),
        filename="out.json",
        size_bytes=65537,
        content_type="application/json",
        sha256="a" * 64,
        result_id="r",
        shard_id="s",
        workload_id="w",
        account_id=1,
    )
    try:
        _read_artifact_bytes(artifact)
    except ResultValidationError as exc:
        assert "memory budget" in str(exc)
    else:
        raise AssertionError("oversized artifact must not be fetched")


def test_redispatch_debounces_duplicate_local_events(monkeypatch) -> None:
    lifecycle._redispatch_local_locks.clear()
    lifecycle._redispatch_last_started.clear()
    calls = 0

    async def authorized(_: str) -> dict:
        nonlocal calls
        calls += 1
        return {"dispatched": 1, "failed": 0}

    monkeypatch.setattr(lifecycle, "_redispatch_pending_authorized", authorized)

    async def run() -> tuple[dict, dict]:
        return (
            await lifecycle.redispatch_pending("workload"),
            await lifecycle.redispatch_pending("workload"),
        )

    first, second = asyncio.run(run())
    assert first["dispatched"] == 1
    assert second["skipped"] == "debounced"
    assert calls == 1


def test_retry_exclusion_is_active_only_until_its_ttl() -> None:
    worker = Worker(id="worker-a", owner_id=1, name="A")
    blocked = Shard(
        metadata={"retry_excluded_until": {"worker-a": 4_000_000_000}},
    )
    expired = Shard(
        metadata={"retry_excluded_until": {"worker-a": 1}},
    )
    assert schedule_assignments([blocked], [worker]) == []
    assignments = schedule_assignments([expired], [worker])
    assert [assignment.worker_id for assignment in assignments] == ["worker-a"]
