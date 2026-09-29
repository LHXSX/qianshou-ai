"""Durable workload-backed archive normalization jobs.

The workload's NORMALIZING state is the durable queue entry.  No archive bytes
are read in the HTTP submission transaction; a successful job atomically
replaces the archive spec with the normal multi_file contract.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import text

from platform_v8.core import WorkloadSpec, WorkloadStatus
from platform_v8.storage import db as db_mod
from platform_v8.storage.repo import WorkloadRepo

logger = logging.getLogger(__name__)


def shards_after_archive_unpack(task_type: str, file_count: int, submitted_max_shards: int) -> int:
    """解压后应使用的 max_shards：至少能装下全部成员，且不超过任务上限。"""
    from platform_v8.engine.task_registry import get_spec

    file_count = max(1, int(file_count or 1))
    submitted = max(1, int(submitted_max_shards or 1))
    meta = get_spec(task_type)
    limit = max(1, int(getattr(meta, "max_shards_limit", 1) or 1))
    per = int(getattr(meta, "max_files_per_shard", 0) or 0)
    needed = file_count
    if per > 0:
        import math
        needed = int(math.ceil(file_count / float(per)))
    else:
        # 无每片上限时仍按文件数切，避免两文件压进一片只产出 1 路
        needed = file_count
    return max(submitted, min(limit, needed))


def _configured_concurrency() -> int:
    try:
        configured = int(os.getenv("EDGE_ARCHIVE_NORMALIZE_CONCURRENCY", "2"))
    except (TypeError, ValueError):
        configured = 2
    return max(1, min(configured, 8))


_MAX_CONCURRENT = _configured_concurrency()
_ARCHIVE_EXECUTOR = ThreadPoolExecutor(
    max_workers=_MAX_CONCURRENT,
    thread_name_prefix="archive-normalize",
)
_EXECUTOR_SHUTDOWN = False
_EXECUTOR_SHUTDOWN_LOCK = threading.Lock()
_INFLIGHT_EXECUTOR_FUTURES: set[asyncio.Future] = set()
_ACTIVE_RECOVERY_TASKS: dict[str, asyncio.Task[str]] = {}
_PROCESS_LOCKS: dict[int, threading.Lock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()

_PUBLISHED = "published"
_FAILED = "failed"
_LOCK_BUSY = "lock_busy"
_STALE = "stale"


def _executor_for_submit() -> ThreadPoolExecutor:
    """Return a live executor across repeated app lifespan start/stop cycles."""
    global _ARCHIVE_EXECUTOR, _EXECUTOR_SHUTDOWN
    with _EXECUTOR_SHUTDOWN_LOCK:
        if _EXECUTOR_SHUTDOWN:
            _ARCHIVE_EXECUTOR = ThreadPoolExecutor(
                max_workers=_MAX_CONCURRENT,
                thread_name_prefix="archive-normalize",
            )
            _EXECUTOR_SHUTDOWN = False
        return _ARCHIVE_EXECUTOR


def _lock_key(workload_id: str) -> int:
    digest = hashlib.sha256(
        f"archive-normalization:{workload_id}".encode("utf-8")
    ).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=True)


def _process_lock_for(key: int) -> threading.Lock:
    with _PROCESS_LOCKS_GUARD:
        return _PROCESS_LOCKS.setdefault(key, threading.Lock())


@contextmanager
def _normalization_lock(workload_id: str) -> Iterator[bool]:
    """Hold a cross-worker PG lock or a safe process-local test/SQLite lock."""
    key = _lock_key(workload_id)
    lock_session = db_mod.get_session_factory()()
    try:
        dialect = str(lock_session.get_bind().dialect.name)
        if dialect == "postgresql":
            acquired = bool(
                lock_session.execute(
                    text("SELECT pg_try_advisory_lock(:key)"),
                    {"key": key},
                ).scalar()
            )
            try:
                yield acquired
            finally:
                if acquired:
                    try:
                        lock_session.execute(
                            text("SELECT pg_advisory_unlock(:key)"),
                            {"key": key},
                        )
                    except Exception:
                        logger.warning(
                            "archive.normalize advisory unlock failed",
                            exc_info=True,
                        )
                lock_session.rollback()
            return
    finally:
        lock_session.close()

    process_lock = _process_lock_for(key)
    acquired = process_lock.acquire(blocking=False)
    try:
        yield acquired
    finally:
        if acquired:
            process_lock.release()


def _load_normalizing_workload(workload_id: str):
    with db_mod.session_scope() as session:
        workload = WorkloadRepo.by_id(session, workload_id)
        if workload is None or workload.status != WorkloadStatus.NORMALIZING:
            return None
        return workload


def _mark_failed(workload_id: str, reason: str) -> None:
    with db_mod.session_scope() as session:
        WorkloadRepo.transition_status(
            session,
            workload_id,
            WorkloadStatus.FAILED,
            expected_statuses=(WorkloadStatus.NORMALIZING,),
            error=f"archive normalization failed: {reason}",
        )
        session.commit()


def _normalize_workload_sync(workload_id: str) -> str:
    """Run the complete archive I/O pipeline under one durable lock."""
    with _normalization_lock(workload_id) as acquired:
        if not acquired:
            return _LOCK_BUSY

        workload = _load_normalizing_workload(workload_id)
        if workload is None:
            return _STALE

        try:
            from platform_v8.services.archive_normalizer import (
                normalize_archive_to_batch,
            )
            from platform_v8.services.storage_refs import (
                canonicalize_owned_reference,
            )

            owner_id = int(workload.owner_id)
            source_key = canonicalize_owned_reference(
                owner_id,
                workload.spec.input_ref,
            )
            batch = normalize_archive_to_batch(
                owner_id=owner_id,
                object_key=source_key,
                task_type=workload.spec.task_type,
                max_shards=workload.spec.max_shards,
                batch_id=str(workload.id),
            )
            params = dict(workload.spec.params or {})
            params["input_batch"] = batch
            params["input_sizes"] = [
                int(item["size_bytes"]) for item in batch["entries"]
            ]
            # 解压后按文件数抬分片：提交时 max_shards 往往按「1 个压缩包」写死，
            # 规范化成 multi_file 后若不抬，word_to_text / audio_transcribe 等
            # max_files_per_shard=1 的任务会直接失败。
            file_count = len(batch["entries"])
            max_shards = shards_after_archive_unpack(
                workload.spec.task_type,
                file_count,
                int(workload.spec.max_shards or 1),
            )
            normalized = WorkloadSpec(
                kind=workload.spec.kind,
                task_type=workload.spec.task_type,
                runtime=workload.spec.runtime,
                code_url=workload.spec.code_url,
                input_kind="multi_file",
                input_ref="",
                input_refs=[
                    str(item["object_key"]) for item in batch["entries"]
                ],
                inline_input=workload.spec.inline_input,
                params=params,
                max_shards=max_shards,
                redundancy_factor=workload.spec.redundancy_factor,
                timeout_s=workload.spec.timeout_s,
                requirements=workload.spec.requirements,
            )
            with db_mod.session_scope() as session:
                published = WorkloadRepo.replace_spec_and_transition(
                    session,
                    workload_id,
                    normalized,
                    expected_status=WorkloadStatus.NORMALIZING,
                    target_status=WorkloadStatus.CREATED,
                )
                session.commit()
            return _PUBLISHED if published else _STALE
        except Exception as exc:
            logger.warning(
                "archive.normalize failed · workload=%s: %s",
                workload_id,
                type(exc).__name__,
            )
            try:
                _mark_failed(workload_id, str(exc) or type(exc).__name__)
            except Exception:
                logger.exception(
                    "archive.normalize failed-status update failed · workload=%s",
                    workload_id,
                )
            return _FAILED


async def normalize_then_start(workload_id: str) -> str:
    """Normalize one pending archive and start normal lifecycle on success."""
    loop = asyncio.get_running_loop()
    future = loop.run_in_executor(
        _executor_for_submit(),
        _normalize_workload_sync,
        str(workload_id),
    )
    _INFLIGHT_EXECUTOR_FUTURES.add(future)
    try:
        outcome = await future
    finally:
        _INFLIGHT_EXECUTOR_FUTURES.discard(future)
    if outcome == _PUBLISHED:
        from platform_v8.engine import lifecycle

        await lifecycle.start(str(workload_id))
    return outcome


async def start_submitted_workload(workload_id: str) -> None:
    """Start every submission through the status-aware archive gate."""
    def _load_status():
        with db_mod.session_scope() as session:
            workload = WorkloadRepo.by_id(session, str(workload_id))
            return None if workload is None else workload.status

    status = await asyncio.to_thread(_load_status)
    if status is None:
        return
    status_value = getattr(status, "value", status)
    if str(status_value) == WorkloadStatus.NORMALIZING.value:
        await normalize_then_start(str(workload_id))
        return

    from platform_v8.engine import lifecycle

    await lifecycle.start(str(workload_id))


def _schedule_recovery(workload_id: str) -> asyncio.Task[str]:
    existing = _ACTIVE_RECOVERY_TASKS.get(workload_id)
    if existing is not None and not existing.done():
        return existing
    task = asyncio.create_task(normalize_then_start(workload_id))
    _ACTIVE_RECOVERY_TASKS[workload_id] = task

    def _remove(completed: asyncio.Task[str]) -> None:
        if _ACTIVE_RECOVERY_TASKS.get(workload_id) is completed:
            _ACTIVE_RECOVERY_TASKS.pop(workload_id, None)

    task.add_done_callback(_remove)
    return task


async def recover_pending_normalizations(*, limit: int = 20) -> int:
    """Drain durable NORMALIZING workloads in bounded batches until empty."""
    batch_size = max(1, min(int(limit), 100))

    def _list_ids() -> list[str]:
        with db_mod.session_scope() as session:
            return [
                str(workload.id)
                for workload in WorkloadRepo.list_normalizing(
                    session,
                    limit=batch_size,
                )
            ]

    scheduled = 0
    while True:
        ids = await asyncio.to_thread(_list_ids)
        if not ids:
            break
        tasks: list[asyncio.Task[str]] = []
        for workload_id in dict.fromkeys(ids):
            if workload_id not in _ACTIVE_RECOVERY_TASKS:
                scheduled += 1
            tasks.append(_schedule_recovery(workload_id))
        outcomes = await asyncio.gather(
            *(asyncio.shield(task) for task in tasks),
            return_exceptions=True,
        )
        if outcomes and all(outcome == _LOCK_BUSY for outcome in outcomes):
            await asyncio.sleep(0.5)

    if scheduled:
        logger.info("archive.normalize recovery drained · count=%d", scheduled)
    return scheduled


async def shutdown_archive_normalization_jobs() -> None:
    """Wait for archive work, then close its executor exactly once."""
    global _EXECUTOR_SHUTDOWN
    active_tasks = list(_ACTIVE_RECOVERY_TASKS.values())
    if active_tasks:
        await asyncio.gather(*active_tasks, return_exceptions=True)
    pending = list(_INFLIGHT_EXECUTOR_FUTURES)
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    with _EXECUTOR_SHUTDOWN_LOCK:
        if _EXECUTOR_SHUTDOWN:
            return
        _EXECUTOR_SHUTDOWN = True
        _ARCHIVE_EXECUTOR.shutdown(wait=True, cancel_futures=False)
