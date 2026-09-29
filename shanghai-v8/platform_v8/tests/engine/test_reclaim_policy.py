from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from platform_v8.core import Shard, ShardMode, ShardStatus
from platform_v8.engine.effective_task import (
    soft_reclaim_dispatched_horizon_s,
    soft_reclaim_running_horizon_s,
)
from platform_v8.engine.lifecycle import _active_reclaim_reason
from platform_v8.storage.repo import ShardRepo, create_all_for_testing


NOW = datetime(2026, 8, 12, 6, 0, tzinfo=timezone.utc)


def _session() -> Session:
    engine = create_engine("sqlite:///:memory:", future=True)
    create_all_for_testing(engine)
    return Session(engine)


def _workload(timeout_s: int, task_type: str = "pdf_ocr"):
    return SimpleNamespace(
        spec=SimpleNamespace(
            task_type=task_type,
            timeout_s=timeout_s,
            code_url="",
            params={},
        )
    )


def _row(
    *,
    status: str = "RUNNING",
    worker_id: str | None = "worker-1",
    lease_by_node: str | None = None,
    dispatched_at: datetime | None = None,
    started_at: datetime | None = None,
    progress_at: datetime | None = None,
    lease_expires_at: datetime | None = None,
    timeout_s: int = 60,
):
    return SimpleNamespace(
        status=status,
        worker_id=worker_id,
        lease_by_node=lease_by_node,
        dispatched_at=dispatched_at,
        started_at=started_at,
        progress_at=progress_at,
        lease_expires_at=lease_expires_at,
        metadata={"timeout_s": timeout_s},
    )


def test_effective_horizons_do_not_reclaim_900s_ocr_at_180s():
    workload = _workload(900)
    row = _row(
        started_at=NOW - timedelta(seconds=180),
        dispatched_at=NOW - timedelta(seconds=190),
        timeout_s=900,
    )
    assert soft_reclaim_dispatched_horizon_s(workload, row) == 945
    assert soft_reclaim_running_horizon_s(workload, row) == 945
    assert (
        _active_reclaim_reason(
            row, workload, online_set={"worker-1"}, now=NOW
        )
        is None
    )


def test_short_task_stale_and_fresh_progress_rules():
    workload = _workload(60)
    stale = _row(
        started_at=NOW - timedelta(seconds=181),
        dispatched_at=NOW - timedelta(seconds=190),
    )
    assert (
        _active_reclaim_reason(
            stale, workload, online_set={"worker-1"}, now=NOW
        )
        == "STALE_RUNNING"
    )

    fresh = _row(
        started_at=NOW - timedelta(seconds=500),
        dispatched_at=NOW - timedelta(seconds=510),
        progress_at=NOW - timedelta(seconds=10),
    )
    assert (
        _active_reclaim_reason(
            fresh, workload, online_set={"worker-1"}, now=NOW
        )
        is None
    )


def test_old_client_falls_back_to_started_or_dispatched():
    workload = _workload(60)
    running = _row(
        started_at=NOW - timedelta(seconds=181),
        dispatched_at=NOW - timedelta(seconds=200),
        progress_at=None,
    )
    dispatched = _row(
        status="DISPATCHED",
        started_at=None,
        dispatched_at=NOW - timedelta(seconds=106),
        progress_at=None,
    )
    assert _active_reclaim_reason(
        running, workload, online_set={"worker-1"}, now=NOW
    ) == "STALE_RUNNING"
    assert _active_reclaim_reason(
        dispatched, workload, online_set={"worker-1"}, now=NOW
    ) == "STALE_DISPATCHED"


def test_pull_lease_and_offline_precedence():
    workload = _workload(60)
    future = _row(
        lease_expires_at=NOW + timedelta(seconds=1),
        started_at=NOW - timedelta(hours=1),
    )
    expired = _row(
        lease_expires_at=NOW - timedelta(seconds=1),
        started_at=NOW - timedelta(seconds=1),
    )
    assert _active_reclaim_reason(
        future, workload, online_set={"worker-1"}, now=NOW
    ) is None
    assert _active_reclaim_reason(
        expired, workload, online_set={"worker-1"}, now=NOW
    ) == "EXPIRED_LEASE"
    assert _active_reclaim_reason(
        future, workload, online_set=set(), now=NOW
    ) == "WORKER_OFFLINE"


def test_touch_progress_guards_worker_attempt_and_renews_pull_lease():
    old_progress = NOW - timedelta(seconds=30)
    old_lease = NOW.replace(tzinfo=None) + timedelta(seconds=10)
    with _session() as session:
        shard = Shard(
            workload_id="workload-progress",
            status=ShardStatus.RUNNING,
            worker_id="worker-1",
            attempts=2,
            mode=ShardMode.PULL,
            started_at=NOW.replace(tzinfo=None) - timedelta(seconds=40),
            progress_at=old_progress,
            lease_by_node="worker-1",
            lease_expires_at=old_lease,
        )
        ShardRepo.create_batch(session, [shard])
        session.commit()

        assert not ShardRepo.touch_progress(
            session,
            shard.id,
            expected_worker_id="stale-worker",
            expected_attempt=2,
            lease_seconds=180,
            now=NOW,
        )
        assert not ShardRepo.touch_progress(
            session,
            shard.id,
            expected_worker_id="worker-1",
            expected_attempt=1,
            lease_seconds=180,
            now=NOW,
        )
        unchanged = ShardRepo.by_id(session, shard.id)
        assert unchanged is not None
        assert unchanged.lease_expires_at == old_lease

        assert ShardRepo.touch_progress(
            session,
            shard.id,
            expected_worker_id="worker-1",
            expected_attempt=2,
            lease_seconds=180,
            now=NOW,
        )
        touched = ShardRepo.by_id(session, shard.id)
        assert touched is not None
        assert touched.progress_at is not None
        assert touched.lease_expires_at == (
            NOW.replace(tzinfo=None) + timedelta(seconds=180)
        )


def test_first_progress_starts_shard_reset_clears_and_reclaim_cas_loses_race():
    scan_progress = NOW - timedelta(seconds=40)
    scan_lease = NOW.replace(tzinfo=None) - timedelta(seconds=1)
    with _session() as session:
        shard = Shard(
            workload_id="workload-race",
            status=ShardStatus.DISPATCHED,
            worker_id="worker-1",
            attempts=3,
            dispatched_at=NOW.replace(tzinfo=None) - timedelta(seconds=200),
            progress_at=scan_progress,
            lease_expires_at=scan_lease,
        )
        ShardRepo.create_batch(session, [shard])
        session.commit()

        assert ShardRepo.touch_progress(
            session,
            shard.id,
            expected_worker_id="worker-1",
            expected_attempt=3,
            now=NOW,
        )
        started = ShardRepo.by_id(session, shard.id)
        assert started is not None
        assert started.status == ShardStatus.RUNNING
        assert started.started_at is not None

        assert not ShardRepo.reclaim_active_if_unchanged(
            session,
            shard.id,
            expected_status="DISPATCHED",
            expected_worker_id="worker-1",
            expected_attempt=3,
            expected_progress_at=scan_progress,
            expected_lease_expires_at=scan_lease,
        )
        assert ShardRepo.reset_pending(session, shard.id)
        reset = ShardRepo.by_id(session, shard.id)
        assert reset is not None
        assert reset.status == ShardStatus.PENDING
        assert reset.progress_at is None
        assert reset.started_at is None
        assert reset.lease_expires_at is None


def test_terminal_transitions_clear_progress():
    with _session() as session:
        shards = [
            Shard(
                workload_id="workload-terminal",
                index=index,
                total=3,
                status=ShardStatus.RUNNING,
                worker_id="worker-1",
                attempts=1,
                progress_at=NOW,
                lease_by_node="worker-1",
                lease_expires_at=NOW.replace(tzinfo=None) + timedelta(seconds=10),
            )
            for index in range(3)
        ]
        ShardRepo.create_batch(session, shards)
        assert ShardRepo.mark_done(
            session, shards[0].id, expected_worker_id="worker-1"
        )
        assert ShardRepo.mark_failed(session, shards[1].id, error="failed")
        assert (
            ShardRepo.cancel_all_pending(
                session, "workload-terminal", error="cancelled"
            )
            == 1
        )
        session.commit()

        loaded = [ShardRepo.by_id(session, shard.id) for shard in shards]
        assert [shard.status for shard in loaded if shard is not None] == [
            ShardStatus.DONE,
            ShardStatus.FAILED,
            ShardStatus.CANCELLED,
        ]
        assert all(
            shard is not None
            and shard.progress_at is None
            and shard.lease_expires_at is None
            for shard in loaded
        )
