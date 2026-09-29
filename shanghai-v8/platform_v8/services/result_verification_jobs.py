"""Durable result-verification queue.

Compute finishes once.  Infrastructure failures retry the same persisted
artifact/evidence and never return a shard to PENDING or decrement attempts.
"""
from __future__ import annotations

import asyncio
import logging
import os
import random
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from platform_v8.services.result_verifier import (
    PreparedVerification,
    ResultValidationError,
    VerificationInfrastructureError,
    verify_prepared_request,
)
from platform_v8.storage import db as db_mod
from platform_v8.storage.repo import (
    ResultVerificationRepo,
    ShardRepo,
    VerifierCircuitRepo,
    WorkloadRepo,
)

logger = logging.getLogger(__name__)

_executor: ThreadPoolExecutor | None = None
_wake_event: asyncio.Event | None = None
_stop_event: asyncio.Event | None = None
_event_loop: asyncio.AbstractEventLoop | None = None


def _utc_aware(value: datetime) -> datetime:
    return (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )


def _bounded_env(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        value = default
    return min(max(value, low), high)


def _config() -> dict[str, int]:
    return {
        "max_retries": 3,
        "failure_threshold": _bounded_env(
            "V8_VERIFIER_CIRCUIT_THRESHOLD", 3, 1, 20
        ),
        "cooldown_seconds": _bounded_env(
            "V8_VERIFIER_CIRCUIT_COOLDOWN_S", 60, 1, 3600
        ),
        "base_backoff_seconds": _bounded_env(
            "V8_RESULT_VERIFY_BACKOFF_S", 2, 1, 300
        ),
        "max_backoff_seconds": _bounded_env(
            "V8_RESULT_VERIFY_MAX_BACKOFF_S", 120, 1, 3600
        ),
        "lease_seconds": _bounded_env(
            "V8_RESULT_VERIFY_LEASE_S", 240, 30, 1800
        ),
        "batch_size": _bounded_env(
            "V8_RESULT_VERIFY_BATCH", 10, 1, 100
        ),
    }


def _bounded_elapsed_ms(value: Any) -> int | None:
    """Store only a duration; older nodes sometimes send an epoch timestamp."""
    if type(value) is not int or not 0 <= value <= 86_400_000:
        return None
    return value


def enqueue_verification(
    prepared: PreparedVerification,
    *,
    elapsed_ms: int | None = None,
) -> bool:
    """Atomically persist evidence and freeze the current compute attempt."""
    if prepared.policy not in {"semantic", "artifact"}:
        raise ValueError("only settleable policies enter verification queue")
    cfg = _config()
    with db_mod.session_scope() as session:
        if not ShardRepo.begin_verification(
            session,
            prepared.shard_id,
            expected_worker_id=prepared.worker_id,
            expected_attempt=prepared.attempt,
        ):
            return False
        evidence = dict(prepared.evidence)
        evidence["elapsed_ms"] = _bounded_elapsed_ms(elapsed_ms)
        ResultVerificationRepo.upsert(
            session,
            shard_id=prepared.shard_id,
            workload_id=prepared.workload_id,
            worker_id=prepared.worker_id,
            attempt=prepared.attempt,
            requested_policy=prepared.policy,
            verifier_key=prepared.verifier_key,
            content_sha256=prepared.content_sha256,
            artifact=prepared.artifact,
            evidence=evidence,
            max_retries=cfg["max_retries"],
        )
        session.commit()
    notify_verification_jobs()
    return True


def notify_verification_jobs() -> None:
    event = _wake_event
    loop = _event_loop
    if event is not None and loop is not None and not loop.is_closed():
        loop.call_soon_threadsafe(event.set)


def _prepared_from_row(row: dict[str, Any]) -> PreparedVerification:
    evidence = dict(row.get("evidence") or {})
    return PreparedVerification(
        shard_id=str(row["shard_id"]),
        workload_id=str(row["workload_id"]),
        worker_id=str(row["worker_id"]),
        attempt=int(row["attempt"]),
        policy=str(row["requested_policy"]),
        verifier_key=str(row["verifier_key"]),
        output_ref=str(evidence.get("output_ref") or ""),
        content_sha256=str(row.get("content_sha256") or ""),
        artifact=dict(row.get("artifact") or {}),
        evidence=evidence,
    )


def _claim_due(now: datetime, cfg: dict[str, int]) -> list[dict[str, Any]]:
    with db_mod.session_scope() as session:
        rows = ResultVerificationRepo.claim_due_retries(
            session,
            limit=cfg["batch_size"],
            lease_seconds=cfg["lease_seconds"],
            now=now,
        )
        session.commit()
        return rows


def _circuit_access(
    verifier_key: str,
    *,
    now: datetime,
    cfg: dict[str, int],
) -> tuple[bool, str | None, datetime | None]:
    """Return access permission, expected probe state, and reopen time."""
    with db_mod.session_scope() as session:
        circuit = VerifierCircuitRepo.get(session, verifier_key)
        if circuit is None or circuit["state"] == VerifierCircuitRepo.CLOSED:
            return True, VerifierCircuitRepo.CLOSED, None
        if circuit["state"] == VerifierCircuitRepo.OPEN:
            opened_until = circuit.get("opened_until")
            if (
                opened_until is not None
                and _utc_aware(opened_until) > _utc_aware(now)
            ):
                return False, None, opened_until
            probe = VerifierCircuitRepo.claim_half_open(
                session,
                verifier_key,
                lease_seconds=cfg["lease_seconds"],
                now=now,
            )
            session.commit()
            return (probe is not None), (
                VerifierCircuitRepo.HALF_OPEN if probe is not None else None
            ), None
        probe_until = circuit.get("probe_lease_until")
        if (
            probe_until is not None
            and _utc_aware(probe_until) > _utc_aware(now)
        ):
            return False, None, probe_until
        probe = VerifierCircuitRepo.claim_half_open(
            session,
            verifier_key,
            lease_seconds=cfg["lease_seconds"],
            now=now,
        )
        session.commit()
        return (probe is not None), (
            VerifierCircuitRepo.HALF_OPEN if probe is not None else None
        ), None


def _retry_at(
    row: dict[str, Any],
    *,
    now: datetime,
    cfg: dict[str, int],
    jitter: Callable[[float, float], float],
    not_before: datetime | None = None,
) -> datetime:
    delay = min(
        cfg["max_backoff_seconds"],
        cfg["base_backoff_seconds"] * (2 ** int(row.get("retry_count") or 0)),
    )
    delay += max(0.0, float(jitter(0.0, max(0.1, delay * 0.25))))
    candidate = _utc_aware(now) + timedelta(seconds=delay)
    return (
        max(candidate, _utc_aware(not_before))
        if not_before is not None
        else candidate
    )


def _schedule_or_exhaust(
    row: dict[str, Any],
    *,
    error: str,
    now: datetime,
    cfg: dict[str, int],
    jitter: Callable[[float, float], float],
    not_before: datetime | None = None,
    disposition: str = "INFRASTRUCTURE_FAILED",
) -> str:
    shard_id = str(row["shard_id"])
    attempt = int(row["attempt"])
    retry_count = int(row.get("retry_count") or 0)
    with db_mod.session_scope() as session:
        if ResultVerificationRepo.schedule_retry(
            session,
            shard_id,
            attempt,
            retry_at=_retry_at(
                row, now=now, cfg=cfg, jitter=jitter, not_before=not_before
            ),
            error=error,
            expected_retry_count=retry_count,
        ):
            session.commit()
            if (row.get("evidence") or {}).get("adapter_version"):
                from platform_v8.services.observability import (
                    record_legacy_replay,
                )

                record_legacy_replay(
                    kind="durable_retry",
                    stage="verification",
                )
            return "retry"
        marked = ResultVerificationRepo.mark_failed(
            session,
            shard_id,
            attempt,
            error=error,
            disposition=disposition,
            expected_retry_count=retry_count,
        )
        failed = ShardRepo.fail_verification(
            session,
            shard_id,
            expected_worker_id=str(row["worker_id"]),
            expected_attempt=attempt,
            error=f"verification_infrastructure:{error}",
        )
        if not marked or not failed:
            session.rollback()
            return "stale"
        session.commit()
        return "failed"


def _defer_circuit_blocked(
    row: dict[str, Any],
    *,
    now: datetime,
    cfg: dict[str, int],
    jitter: Callable[[float, float], float],
    not_before: datetime | None,
) -> str:
    """Release a claimed row without charging an unattempted dependency call."""
    with db_mod.session_scope() as session:
        deferred = ResultVerificationRepo.defer_retry(
            session,
            str(row["shard_id"]),
            int(row["attempt"]),
            retry_at=_retry_at(
                row,
                now=now,
                cfg=cfg,
                jitter=jitter,
                not_before=not_before,
            ),
            error="verifier circuit open",
            expected_retry_count=int(row.get("retry_count") or 0),
        )
        if deferred:
            session.commit()
            return "deferred"
        session.rollback()
        return "stale"


def _complete_success(
    row: dict[str, Any],
    verified: Any,
    *,
    expected_circuit_state: str | None,
    now: datetime,
) -> str:
    with db_mod.session_scope() as session:
        persisted_evidence = dict(row.get("evidence") or {})
        persisted_evidence.update(dict(verified.verification))
        if not ResultVerificationRepo.mark_succeeded(
            session,
            str(row["shard_id"]),
            int(row["attempt"]),
            disposition=verified.disposition,
            evidence=persisted_evidence,
            expected_retry_count=int(row.get("retry_count") or 0),
        ):
            return "stale"
        if not ShardRepo.complete_verification(
            session,
            str(row["shard_id"]),
            expected_worker_id=str(row["worker_id"]),
            expected_attempt=int(row["attempt"]),
            output_ref=verified.output_ref,
            elapsed_ms=_bounded_elapsed_ms(
                (row.get("evidence") or {}).get("elapsed_ms")
            ),
            verification=verified.verification,
        ):
            session.rollback()
            return "stale"
        if verified.disposition == "QUARANTINED":
            from platform_v8.core import WorkloadStatus

            WorkloadRepo.transition_status(
                session,
                str(row["workload_id"]),
                WorkloadStatus.QUARANTINED,
                expected_statuses=(
                    WorkloadStatus.CREATED,
                    WorkloadStatus.PLANNED,
                    WorkloadStatus.RUNNING,
                    WorkloadStatus.WAITING_FOR_WORKERS,
                    WorkloadStatus.AGGREGATING,
                ),
                error=f"result_quarantined:{verified.reason_code}",
            )
        VerifierCircuitRepo.record_success(
            session,
            str(row["verifier_key"]),
            expected_state=expected_circuit_state,
            now=now,
        )
        session.commit()
        if persisted_evidence.get("adapter_version"):
            from platform_v8.services.observability import (
                record_legacy_verification_disposition,
            )

            record_legacy_verification_disposition(
                disposition=verified.disposition,
                reason_code=verified.reason_code,
            )
        return (
            "quarantined"
            if verified.disposition == "QUARANTINED"
            else "done"
        )


def _reject_result(
    row: dict[str, Any],
    *,
    error: str,
) -> str:
    with db_mod.session_scope() as session:
        marked = ResultVerificationRepo.mark_failed(
            session,
            str(row["shard_id"]),
            int(row["attempt"]),
            error=error,
            disposition="REJECTED",
            expected_retry_count=int(row.get("retry_count") or 0),
        )
        failed = ShardRepo.fail_verification(
            session,
            str(row["shard_id"]),
            expected_worker_id=str(row["worker_id"]),
            expected_attempt=int(row["attempt"]),
            error=f"result_validation:{error}",
        )
        if not marked or not failed:
            session.rollback()
            return "stale"
        session.commit()
        return "rejected"


def process_due_verifications(
    *,
    clock: Callable[[], datetime] | None = None,
    jitter: Callable[[float, float], float] = random.uniform,
) -> list[dict[str, str]]:
    """Claim and process one batch; injectable clock/jitter keep tests exact."""
    clock = clock or (lambda: datetime.now(timezone.utc))
    cfg = _config()
    rows = _claim_due(clock(), cfg)
    outcomes: list[dict[str, str]] = []
    for row in rows:
        now = clock()
        allowed, expected_state, not_before = _circuit_access(
            str(row["verifier_key"]), now=now, cfg=cfg
        )
        if not allowed:
            outcome = _defer_circuit_blocked(
                row,
                now=now,
                cfg=cfg,
                jitter=jitter,
                not_before=not_before,
            )
        else:
            try:
                verified = verify_prepared_request(_prepared_from_row(row))
            except VerificationInfrastructureError as exc:
                with db_mod.session_scope() as session:
                    circuit = VerifierCircuitRepo.record_failure(
                        session,
                        str(row["verifier_key"]),
                        failure_threshold=cfg["failure_threshold"],
                        cooldown_seconds=cfg["cooldown_seconds"],
                        now=now,
                    )
                    session.commit()
                outcome = _schedule_or_exhaust(
                    row,
                    error=str(exc),
                    now=now,
                    cfg=cfg,
                    jitter=jitter,
                    not_before=circuit.get("opened_until"),
                )
            except ResultValidationError as exc:
                outcome = _reject_result(row, error=str(exc))
            except Exception as exc:
                # Unexpected verifier exceptions are platform failures.  Keep
                # the compute result and consume only the bounded verify budget.
                with db_mod.session_scope() as session:
                    circuit = VerifierCircuitRepo.record_failure(
                        session,
                        str(row["verifier_key"]),
                        failure_threshold=cfg["failure_threshold"],
                        cooldown_seconds=cfg["cooldown_seconds"],
                        now=now,
                    )
                    session.commit()
                outcome = _schedule_or_exhaust(
                    row,
                    error=f"{type(exc).__name__}: {exc}",
                    now=now,
                    cfg=cfg,
                    jitter=jitter,
                    not_before=circuit.get("opened_until"),
                )
            else:
                outcome = _complete_success(
                    row,
                    verified,
                    expected_circuit_state=expected_state,
                    now=now,
                )
        outcomes.append({
            "workload_id": str(row["workload_id"]),
            "shard_id": str(row["shard_id"]),
            "worker_id": str(row["worker_id"]),
            "outcome": outcome,
        })
    return outcomes


async def verification_worker_loop(
    *,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    poll_seconds: float = 1.0,
) -> None:
    """Recovery + retry loop using a dedicated bounded executor."""
    global _executor, _wake_event, _stop_event, _event_loop
    if _executor is None:
        _executor = ThreadPoolExecutor(
            max_workers=_bounded_env("V8_RESULT_VERIFY_WORKERS", 2, 1, 4),
            thread_name_prefix="result-verifier",
        )
    _wake_event = asyncio.Event()
    _stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    _event_loop = loop
    while not _stop_event.is_set():
        # Clear before claiming so an enqueue racing with verification remains
        # observable and triggers the next immediate poll.
        _wake_event.clear()
        try:
            outcomes = await loop.run_in_executor(
                _executor, process_due_verifications
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("result verification worker poll failed")
            outcomes = []
        for item in outcomes:
            if item["outcome"] in {"done", "failed", "rejected", "quarantined"}:
                from platform_v8.engine import aggregator

                if item["outcome"] == "rejected":
                    # Preserve invalid-result compute retries.  Only platform
                    # infrastructure failures freeze and reuse the same output.
                    await aggregator.on_shard_failed(
                        item["shard_id"],
                        error="result_validation:verification_rejected",
                        expected_worker_id=item["worker_id"],
                        failure_class="result_validation",
                    )
                    continue
                if item["outcome"] != "quarantined":
                    await aggregator._maybe_finalize_workload(item["workload_id"])
                try:
                    from platform_v8.services.economy import event_bus

                    event_bus.publish(
                        "shard.completed",
                        workload_id=item["workload_id"],
                        shard_id=item["shard_id"],
                        worker_id=item["worker_id"],
                        outcome=(
                            "success" if item["outcome"] == "done" else item["outcome"]
                        ),
                    )
                except Exception:
                    logger.debug(
                        "verification shard.completed publish failed",
                        exc_info=True,
                    )
        wake_wait = asyncio.ensure_future(_wake_event.wait())
        poll_wait = asyncio.ensure_future(
            sleep(max(0.05, float(poll_seconds)))
        )
        _done, pending = await asyncio.wait(
            {wake_wait, poll_wait}, return_when=asyncio.FIRST_COMPLETED
        )
        for future in pending:
            future.cancel()


async def shutdown_verification_jobs() -> None:
    global _executor, _event_loop
    if _stop_event is not None:
        _stop_event.set()
    if _wake_event is not None:
        _wake_event.set()
    executor = _executor
    _executor = None
    _event_loop = None
    if executor is not None:
        executor.shutdown(wait=False, cancel_futures=True)
