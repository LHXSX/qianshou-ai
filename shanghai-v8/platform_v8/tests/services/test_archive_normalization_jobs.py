from __future__ import annotations

import asyncio
import threading
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from platform_v8.core import WorkloadStatus
from platform_v8.services import archive_normalization_jobs as jobs


@contextmanager
def _session_scope():
    yield SimpleNamespace()


@pytest.fixture(autouse=True)
def _clear_recovery_tasks():
    jobs._ACTIVE_RECOVERY_TASKS.clear()
    yield
    jobs._ACTIVE_RECOVERY_TASKS.clear()


def test_postgres_advisory_lock_is_always_released(monkeypatch):
    statements = []

    class _Result:
        def scalar(self):
            return True

    class _Session:
        def get_bind(self):
            return SimpleNamespace(
                dialect=SimpleNamespace(name="postgresql")
            )

        def execute(self, statement, parameters):
            statements.append((str(statement), parameters))
            return _Result()

        def rollback(self):
            statements.append(("rollback", {}))

        def close(self):
            statements.append(("close", {}))

    session = _Session()
    monkeypatch.setattr(
        jobs.db_mod,
        "get_session_factory",
        lambda: lambda: session,
    )

    with jobs._normalization_lock("workload-id") as acquired:
        assert acquired is True

    assert "pg_try_advisory_lock" in statements[0][0]
    assert any("pg_advisory_unlock" in item[0] for item in statements)
    assert statements[-2:] == [("rollback", {}), ("close", {})]


def test_non_postgres_lock_deduplicates_in_process(monkeypatch):
    class _Session:
        def get_bind(self):
            return SimpleNamespace(dialect=SimpleNamespace(name="sqlite"))

        def close(self):
            pass

    monkeypatch.setattr(
        jobs.db_mod,
        "get_session_factory",
        lambda: lambda: _Session(),
    )

    with jobs._normalization_lock("same-id") as first:
        with jobs._normalization_lock("same-id") as second:
            assert first is True
            assert second is False


@pytest.mark.asyncio
async def test_start_submitted_workload_routes_by_current_status(monkeypatch):
    current_status = {"value": WorkloadStatus.NORMALIZING}
    calls: list[tuple[str, str]] = []

    monkeypatch.setattr(jobs.db_mod, "session_scope", _session_scope)
    monkeypatch.setattr(
        jobs.WorkloadRepo,
        "by_id",
        lambda _session, _wid: SimpleNamespace(status=current_status["value"]),
    )

    async def _normalize(workload_id):
        calls.append(("normalize", workload_id))

    async def _start(workload_id):
        calls.append(("lifecycle", workload_id))

    from platform_v8.engine import lifecycle

    monkeypatch.setattr(jobs, "normalize_then_start", _normalize)
    monkeypatch.setattr(lifecycle, "start", _start)

    await jobs.start_submitted_workload("archive-id")
    current_status["value"] = WorkloadStatus.CREATED
    await jobs.start_submitted_workload("ordinary-id")

    assert calls == [
        ("normalize", "archive-id"),
        ("lifecycle", "ordinary-id"),
    ]


@pytest.mark.asyncio
async def test_archive_work_runs_on_dedicated_executor(monkeypatch):
    thread_names: list[str] = []

    def _run(_workload_id):
        thread_names.append(threading.current_thread().name)
        return jobs._STALE

    monkeypatch.setattr(jobs, "_normalize_workload_sync", _run)
    # A prior TestClient lifespan shuts down the module executor.  A subsequent
    # lifespan in the same process must be able to submit archive work again.
    await jobs.shutdown_archive_normalization_jobs()

    assert await jobs.normalize_then_start("workload-id") == jobs._STALE
    assert jobs._EXECUTOR_SHUTDOWN is False
    assert thread_names
    assert thread_names[0].startswith("archive-normalize")


def test_archive_unpack_raises_max_shards_for_per_file_tasks():
    from platform_v8.services.archive_normalization_jobs import shards_after_archive_unpack

    assert shards_after_archive_unpack("word_to_text", 2, 1) == 2
    assert shards_after_archive_unpack("audio_transcribe_refine", 2, 1) == 2
    assert shards_after_archive_unpack("image_compress", 2, 1) == 2


@pytest.mark.asyncio
async def test_concurrent_recovery_schedules_same_workload_once(monkeypatch):
    pending = {"same-id"}
    normalized: list[str] = []

    monkeypatch.setattr(jobs.db_mod, "session_scope", _session_scope)
    monkeypatch.setattr(
        jobs.WorkloadRepo,
        "list_normalizing",
        lambda _session, *, limit: [
            SimpleNamespace(id=wid) for wid in sorted(pending)[:limit]
        ],
    )

    async def _normalize(workload_id):
        normalized.append(workload_id)
        await asyncio.sleep(0.05)
        pending.discard(workload_id)
        return jobs._PUBLISHED

    monkeypatch.setattr(jobs, "normalize_then_start", _normalize)

    counts = await asyncio.gather(
        jobs.recover_pending_normalizations(limit=20),
        jobs.recover_pending_normalizations(limit=20),
    )

    assert normalized == ["same-id"]
    assert sum(counts) == 1


@pytest.mark.asyncio
async def test_recovery_drains_more_than_one_batch(monkeypatch):
    pending = {f"workload-{index:02d}" for index in range(25)}
    normalized: list[str] = []

    monkeypatch.setattr(jobs.db_mod, "session_scope", _session_scope)
    monkeypatch.setattr(
        jobs.WorkloadRepo,
        "list_normalizing",
        lambda _session, *, limit: [
            SimpleNamespace(id=wid) for wid in sorted(pending)[:limit]
        ],
    )

    async def _normalize(workload_id):
        normalized.append(workload_id)
        pending.discard(workload_id)
        return jobs._PUBLISHED

    monkeypatch.setattr(jobs, "normalize_then_start", _normalize)

    count = await jobs.recover_pending_normalizations(limit=20)

    assert count == 25
    assert len(normalized) == 25
    assert pending == set()
