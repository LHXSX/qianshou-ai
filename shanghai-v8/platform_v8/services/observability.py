"""Redacted, dependency-free lifecycle telemetry.

This module intentionally owns no persistence and never participates in the
dispatch or settlement transaction.  Callers may safely invoke it on success
or failure paths; logging/metrics failures are contained here.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import re
import threading
import time
from collections import Counter, defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("platform_v8.observability")

_ALLOWED_EVENTS = frozenset({
    "dispatch",
    "reclaim",
    "verification",
    "quarantine",
    "settlement",
    "refund",
    # QS-20 · mark_done 的 CAS/状态守卫拒绝一条迟到结果时留痕（reason_code 区分原因）
    "result_rejected",
})
_ALLOWED_OUTCOMES = frozenset({
    "success",
    "failure",
    "sent",
    "failed",
    "verified",
    "quarantined",
    "reclaimed",
    "issued",
    "idempotent",
    "rejected",
    "unknown",
})
_SENSITIVE_KEYS = frozenset({
    "artifact",
    "authorization",
    "content",
    "inline_output",
    "input_ref",
    "lease_token",
    "object_key",
    "output_ref",
    "payload",
    "presigned_url",
    "signature",
    "signed_url",
    "url",
})
_counter: Counter[str] = Counter()
_latency: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
_lock = threading.Lock()
_fallback_redaction_key = os.urandom(16)


@dataclass(frozen=True)
class _MetricSpec:
    labels: tuple[str, ...]
    allowed: Mapping[str, frozenset[str]]
    description: str


_NONE = "none"
_OTHER = "other"
_FRAME_TYPES = frozenset({"progress", "result", "unknown", _NONE, _OTHER})
_LEGACY_SHAPES = frozenset({
    "progress_tokenless",
    "progress_aliased",
    "result_inline",
    "result_inline_base64",
    "result_object_key",
    "result_oss_url",
    "result_artifact_inline",
    "result_artifact",
    "result_failed",
    "result_aliased",
    _NONE,
    _OTHER,
})
_LEGACY_REASONS = frozenset({
    "disabled",
    "frame_too_large",
    "invalid_json",
    "invalid_envelope",
    "unsupported_type",
    "not_legacy",
    "modern_invalid",
    "invalid_shape",
    "inline_too_large",
    "invalid_base64",
    "empty_success",
    "invalid_reference",
    "cross_tenant",
    "unsafe_url",
    "hash_mismatch",
    "shard_not_found",
    "inactive_shard",
    "worker_mismatch",
    "attempt_mismatch",
    "invalid_lease_token",
    "connection_mismatch",
    "delivery_missing",
    "delivery_ambiguous",
    "workload_mismatch",
    "context_missing",
    "stale_assignment",
    "worker_no_longer_owner",
    "object_metadata_invalid",
    "size_limit",
    "source_unreadable",
    "empty_result",
    "artifact_invalid",
    "issuance_conflict",
    "write_failed",
    "evidence_conflict",
    "enqueue_conflict",
    "registry_quarantine",
    "settlement_gate_closed",
    "verification_rejected",
    "infrastructure_unavailable",
    _NONE,
    _OTHER,
})
_PROFILES = frozenset({
    "unsupported",
    "legacy_inline",
    "legacy_owned_ref",
    "lease_inline_v1",
    "secure_artifact_v1",
    _NONE,
    _OTHER,
})
_SOURCE_KINDS = frozenset({
    "inline",
    "owned_object_key",
    "trusted_oss_url",
    "artifact",
    _NONE,
    _OTHER,
})
_LEGACY_METRICS: dict[str, _MetricSpec] = {
    "legacy_frame_accept_total": _MetricSpec(
        ("frame_type", "shape", "source_kind", "profile"),
        {
            "frame_type": _FRAME_TYPES,
            "shape": _LEGACY_SHAPES,
            "source_kind": _SOURCE_KINDS,
            "profile": _PROFILES,
        },
        "Accepted assignment-bound legacy result protocol frames.",
    ),
    "legacy_frame_reject_total": _MetricSpec(
        ("frame_type", "stage", "reason"),
        {
            "frame_type": _FRAME_TYPES,
            "stage": frozenset({
                "gateway", "adapter", "binding", "normalization",
                "verification", "settlement", _OTHER,
            }),
            "reason": _LEGACY_REASONS,
        },
        "Rejected legacy result protocol frames.",
    ),
    "legacy_gate_block_total": _MetricSpec(
        ("gate", "mode", "source"),
        {
            "gate": frozenset({"accept", "settle", _OTHER}),
            "mode": frozenset({"off", "shadow", "on", _OTHER}),
            "source": frozenset({
                "default", "env", "feature_flag", "kill_switch",
                "invalid_env", _OTHER,
            }),
        },
        "Legacy compatibility frames blocked by a rollout gate.",
    ),
    "legacy_binding_total": _MetricSpec(
        ("outcome", "reason"),
        {
            "outcome": frozenset({
                "accepted", "rejected", "late", "ambiguous", _OTHER,
            }),
            "reason": _LEGACY_REASONS,
        },
        "Legacy assignment binding outcomes.",
    ),
    "legacy_normalization_total": _MetricSpec(
        ("outcome", "source_kind", "reason"),
        {
            "outcome": frozenset({"success", "failure", _OTHER}),
            "source_kind": _SOURCE_KINDS,
            "reason": _LEGACY_REASONS,
        },
        "Legacy result normalization outcomes.",
    ),
    "legacy_security_block_total": _MetricSpec(
        ("control", "stage"),
        {
            "control": frozenset({
                "cross_tenant", "unsafe_url", "size", "hash", _OTHER,
            }),
            "stage": frozenset({
                "gateway", "adapter", "binding", "normalization",
                "verification", _OTHER,
            }),
        },
        "Security controls blocking legacy result data.",
    ),
    "legacy_capability_profile_total": _MetricSpec(
        ("event", "from_profile", "to_profile"),
        {
            "event": frozenset({"observed", "transition", _OTHER}),
            "from_profile": _PROFILES,
            "to_profile": _PROFILES,
        },
        "Observed legacy capability profiles and monotonic transitions.",
    ),
    "legacy_settlement_total": _MetricSpec(
        ("disposition", "reason"),
        {
            "disposition": frozenset({
                "verified", "legacy_artifact", "quarantine",
                "settlement_blocked", _OTHER,
            }),
            "reason": _LEGACY_REASONS,
        },
        "Durable legacy verification and settlement dispositions.",
    ),
    "legacy_replay_total": _MetricSpec(
        ("kind", "stage"),
        {
            "kind": frozenset({"duplicate", "durable_retry", _OTHER}),
            "stage": frozenset({
                "normalization", "verification", "settlement", _OTHER,
            }),
        },
        "Idempotent duplicates and durable legacy retries.",
    ),
}
_LEGACY_AUDIT_EVENTS = frozenset({
    "accept",
    "reject",
    "gate_block",
    "binding",
    "normalization",
    "security_block",
    "profile",
    "settlement",
    "replay",
})
_legacy_counter: Counter[tuple[str, tuple[str, ...]]] = Counter()
_prometheus_counters: dict[str, Any] = {}


def _init_prometheus_counters() -> None:
    """Register optional counters; local snapshots remain available without it."""
    try:
        from prometheus_client import Counter as PrometheusCounter

        for name, spec in _LEGACY_METRICS.items():
            _prometheus_counters[name] = PrometheusCounter(
                name,
                spec.description,
                spec.labels,
            )
    except Exception:
        # Metrics are best effort. This also keeps test/minimal environments
        # without prometheus-client importable.
        _prometheus_counters.clear()


_init_prometheus_counters()


def _redaction_key() -> bytes:
    configured = os.getenv("OBSERVABILITY_REDACTION_KEY", "").strip()
    return configured.encode("utf-8") if configured else _fallback_redaction_key


def redact_identifier(value: object | None) -> str | None:
    """Return a stable, non-reversible correlation token for an identifier."""
    if value is None:
        return None
    raw = str(value).encode("utf-8", "replace")
    digest = hashlib.blake2s(raw, key=_redaction_key(), digest_size=8).hexdigest()
    return f"id:{digest}"


def prometheus_registry() -> Any | None:
    """Return the existing registry or a multiprocess aggregate registry.

    Prometheus' multiprocess mode is enabled only when its standard environment
    variable is configured before process start. No directory is created here.
    """
    try:
        from prometheus_client import CollectorRegistry, REGISTRY, multiprocess
    except Exception:
        return None
    if not os.getenv("PROMETHEUS_MULTIPROC_DIR", "").strip():
        return REGISTRY
    try:
        registry = CollectorRegistry()
        multiprocess.MultiProcessCollector(registry)
        return registry
    except Exception:
        logger.debug("multiprocess metrics registry unavailable")
        return REGISTRY


def _legacy_label(
    spec: _MetricSpec,
    label: str,
    value: object | None,
) -> str:
    normalized = str(value if value is not None else _NONE).strip().lower()
    if not normalized:
        normalized = _NONE
    return normalized if normalized in spec.allowed[label] else _OTHER


def record_legacy_metric(
    metric: str,
    *,
    audit_event: str | None = None,
    identifiers: Mapping[str, object | None] | None = None,
    **labels: object,
) -> tuple[str, ...]:
    """Increment one fixed-cardinality legacy metric and emit safe audit JSON."""
    if metric not in _LEGACY_METRICS:
        raise ValueError(f"unsupported legacy metric: {metric}")
    if audit_event is not None and audit_event not in _LEGACY_AUDIT_EVENTS:
        raise ValueError(f"unsupported legacy audit event: {audit_event}")
    spec = _LEGACY_METRICS[metric]
    normalized = tuple(
        _legacy_label(spec, label, labels.get(label))
        for label in spec.labels
    )
    try:
        with _lock:
            _legacy_counter[(metric, normalized)] += 1
        prometheus_counter = _prometheus_counters.get(metric)
        if prometheus_counter is not None:
            prometheus_counter.labels(*normalized).inc()
        if audit_event is not None:
            fields = dict(zip(spec.labels, normalized))
            for key, value in (identifiers or {}).items():
                safe_key = str(key).strip().lower()
                if safe_key not in {"workload", "shard", "worker", "connection"}:
                    continue
                redacted = redact_identifier(value)
                if redacted is not None:
                    fields[safe_key] = redacted
            logger.info(
                "legacy_event=%s fields=%s",
                audit_event,
                json.dumps(
                    fields,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
            )
    except Exception:
        logger.debug("legacy telemetry emission failed")
    return normalized


def legacy_metrics_snapshot() -> dict[str, dict[tuple[str, ...], int]]:
    """Return process-local samples; tuple labels make snapshots mergeable."""
    snapshot: dict[str, dict[tuple[str, ...], int]] = {
        name: {} for name in _LEGACY_METRICS
    }
    with _lock:
        for (metric, labels), value in _legacy_counter.items():
            snapshot[metric][labels] = int(value)
    return snapshot


def merge_legacy_metrics_snapshots(
    *snapshots: Mapping[str, Mapping[tuple[str, ...], int]],
) -> dict[str, dict[tuple[str, ...], int]]:
    """Merge process-local snapshots without adding a worker label."""
    merged: dict[str, dict[tuple[str, ...], int]] = {
        name: {} for name in _LEGACY_METRICS
    }
    for snapshot in snapshots:
        for metric, samples in snapshot.items():
            if metric not in _LEGACY_METRICS or not isinstance(samples, Mapping):
                continue
            target = merged[metric]
            for labels, value in samples.items():
                if (
                    not isinstance(labels, tuple)
                    or len(labels) != len(_LEGACY_METRICS[metric].labels)
                ):
                    continue
                try:
                    increment = max(0, int(value))
                except (TypeError, ValueError):
                    continue
                target[labels] = target.get(labels, 0) + increment
    return merged


def legacy_metric_schema() -> dict[str, tuple[str, ...]]:
    """Expose the immutable label schema for exporters and contract tests."""
    return {
        name: spec.labels
        for name, spec in _LEGACY_METRICS.items()
    }


def record_legacy_reject(
    reason: object,
    *,
    frame_type: object | None = None,
    stage: object = "adapter",
) -> None:
    normalized_reason = str(getattr(reason, "value", reason) or "").lower()
    binding_reasons = {
        "shard_not_found",
        "inactive_shard",
        "worker_mismatch",
        "attempt_mismatch",
        "invalid_lease_token",
        "connection_mismatch",
        "delivery_missing",
        "delivery_ambiguous",
        "workload_mismatch",
        "cross_tenant",
        "unsafe_url",
        "invalid_reference",
    }
    late_reasons = {
        "inactive_shard", "attempt_mismatch", "delivery_missing",
    }
    metric_stage = "binding" if normalized_reason in binding_reasons else stage
    record_legacy_metric(
        "legacy_frame_reject_total",
        audit_event="reject",
        frame_type=frame_type,
        stage=metric_stage,
        reason=normalized_reason,
    )
    if normalized_reason in binding_reasons:
        outcome = (
            "ambiguous"
            if normalized_reason == "delivery_ambiguous"
            else "late" if normalized_reason in late_reasons else "rejected"
        )
        record_legacy_metric(
            "legacy_binding_total",
            audit_event="binding",
            outcome=outcome,
            reason=normalized_reason,
        )
    security_control = {
        "frame_too_large": "size",
        "inline_too_large": "size",
        "size_limit": "size",
        "hash_mismatch": "hash",
        "cross_tenant": "cross_tenant",
        "invalid_reference": "cross_tenant",
        "unsafe_url": "unsafe_url",
    }.get(normalized_reason)
    if security_control is not None:
        record_legacy_metric(
            "legacy_security_block_total",
            audit_event="security_block",
            control=security_control,
            stage=metric_stage,
        )


def record_legacy_accept(
    *,
    frame_type: object,
    shape: object,
    source_kind: object,
    profile: object,
) -> None:
    record_legacy_metric(
        "legacy_frame_accept_total",
        audit_event="accept",
        frame_type=frame_type,
        shape=getattr(shape, "value", shape),
        source_kind=source_kind,
        profile=getattr(profile, "value", profile),
    )
    record_legacy_metric(
        "legacy_binding_total",
        outcome="accepted",
        reason=_NONE,
    )


def record_legacy_gate_block(decision: object, *, gate: str) -> None:
    mode = getattr(getattr(decision, "mode", None), "value", None)
    source = getattr(decision, "source", None)
    record_legacy_metric(
        "legacy_gate_block_total",
        audit_event="gate_block",
        gate=gate,
        mode=mode,
        source=source,
    )


def record_legacy_normalization(
    *,
    outcome: str,
    source_kind: object,
    reason: object | None = None,
) -> None:
    record_legacy_metric(
        "legacy_normalization_total",
        audit_event="normalization",
        outcome=outcome,
        source_kind=source_kind,
        reason=getattr(reason, "value", reason),
    )
    if outcome == "failure":
        normalized = str(getattr(reason, "value", reason) or "").lower()
        control = {
            "cross_tenant": "cross_tenant",
            "unsafe_url": "unsafe_url",
            "size_limit": "size",
            "hash_mismatch": "hash",
        }.get(normalized)
        if control is not None:
            record_legacy_metric(
                "legacy_security_block_total",
                audit_event="security_block",
                control=control,
                stage="normalization",
            )


def record_legacy_profile(
    *,
    observed: object,
    previous: object,
    current: object,
) -> None:
    observed_value = getattr(observed, "value", observed)
    previous_value = getattr(previous, "value", previous)
    current_value = getattr(current, "value", current)
    record_legacy_metric(
        "legacy_capability_profile_total",
        audit_event="profile",
        event="observed",
        from_profile=previous_value,
        to_profile=observed_value,
    )
    if str(previous_value) != str(current_value):
        record_legacy_metric(
            "legacy_capability_profile_total",
            event="transition",
            from_profile=previous_value,
            to_profile=current_value,
        )


def record_legacy_settlement(
    *,
    disposition: object,
    reason: object | None = None,
) -> None:
    record_legacy_metric(
        "legacy_settlement_total",
        audit_event="settlement",
        disposition=disposition,
        reason=reason,
    )


def record_legacy_verification_disposition(
    *,
    disposition: object,
    reason_code: object | None = None,
) -> None:
    """Map verifier vocabulary to stable settlement metric enums."""
    raw_disposition = str(disposition or "").upper()
    raw_reason = str(reason_code or "").upper()
    if raw_reason == "LEGACY_SETTLEMENT_DISABLED":
        metric_disposition = "settlement_blocked"
        reason = "settlement_gate_closed"
    elif raw_disposition == "QUARANTINED":
        metric_disposition = "quarantine"
        reason = (
            "registry_quarantine"
            if raw_reason == "REGISTRY_QUARANTINE"
            else "verification_rejected"
        )
    elif raw_disposition == "LEGACY_ARTIFACT_VERIFIED":
        metric_disposition = "legacy_artifact"
        reason = "none"
    elif raw_disposition in {"VERIFIED", "ARTIFACT_VERIFIED"}:
        metric_disposition = "verified"
        reason = "none"
    else:
        metric_disposition = "other"
        reason = "other"
    record_legacy_settlement(
        disposition=metric_disposition,
        reason=reason,
    )


def record_legacy_replay(*, kind: str, stage: str) -> None:
    record_legacy_metric(
        "legacy_replay_total",
        audit_event="replay",
        kind=kind,
        stage=stage,
    )


def _safe_reason(reason_code: object | None) -> str | None:
    if reason_code is None:
        return None
    raw = str(reason_code).strip()
    if not raw:
        return None
    if "://" in raw or "/" in raw or "\\" in raw:
        return "UNSAFE_REASON"
    return re.sub(r"[^A-Z0-9_:-]", "_", raw.upper())[:96]


def _safe_outcome(outcome: object | None) -> str:
    normalized = str(outcome or "unknown").strip().lower()
    return normalized if normalized in _ALLOWED_OUTCOMES else "unknown"


def _event_fields(
    *,
    workload_id: object | None,
    shard_id: object | None,
    worker_id: object | None,
    attempt: int | None,
    reason_code: object | None,
    latency_ms: float | int | None,
    bytes_count: float | int | None,
    outcome: str | None,
    extra: Mapping[str, Any] | None,
) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "workload": redact_identifier(workload_id),
        "shard": redact_identifier(shard_id),
        "worker": redact_identifier(worker_id),
        "attempt": int(attempt) if attempt is not None else None,
        "reason_code": _safe_reason(reason_code),
        "latency_ms": max(0.0, float(latency_ms)) if latency_ms is not None else None,
        "bytes": max(0, int(bytes_count)) if bytes_count is not None else None,
        "outcome": _safe_outcome(outcome),
    }
    for key, value in (extra or {}).items():
        normalized = str(key).lower()
        if normalized in _SENSITIVE_KEYS or "url" in normalized or "payload" in normalized:
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            fields[f"meta_{normalized[:48]}"] = value
    return {key: value for key, value in fields.items() if value is not None}


# ---- QS-15 · we_audit sink：与 _counter / logger.info 并存（先加后删，本处不删任何旧路径）----
# 开关 V8_LIFECYCLE_AUDIT_SINK：未设或 1/true/yes/on/enabled = 开；其他值 = 关（回滚 = .env 加一行 =0 + 重启）。
# 写库在独立守护线程里批量进行；record_lifecycle_event 本身只做 put_nowait，永不阻塞工作负载转移。
# 队满 / 写失败都计数并打 WARNING/ERROR（静默即缺陷），不重试、不阻塞。
_AUDIT_SINK_ENV = "V8_LIFECYCLE_AUDIT_SINK"
_AUDIT_SINK_QUEUE_MAX = 10_000
_AUDIT_SINK_BATCH_MAX = 200
_AUDIT_SINK_FLUSH_SECONDS = 1.0
_audit_queue: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=_AUDIT_SINK_QUEUE_MAX)
_audit_thread: threading.Thread | None = None
_audit_thread_lock = threading.Lock()


def lifecycle_audit_sink_enabled() -> bool:
    """Whether lifecycle events are also appended to we_audit (env V8_LIFECYCLE_AUDIT_SINK, default on)."""
    raw = os.getenv(_AUDIT_SINK_ENV)
    if raw is None:
        return True
    return raw.strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _audit_row(
    event: str,
    fields: Mapping[str, Any],
    *,
    workload_id: object | None,
    shard_id: object | None,
    worker_id: object | None,
) -> dict[str, Any]:
    """One we_audit row: action lifecycle.<event>, actor system, target = shard > workload > worker.

    target_id 与 detail 里的 *_id 存原始标识（可回溯）；fields 里的 workload/shard/worker 是日志同款脱敏 token，
    两者并存以便日志行与审计行互相对照。
    """
    if shard_id is not None:
        target_kind, target_id = "shard", str(shard_id)
    elif workload_id is not None:
        target_kind, target_id = "workload", str(workload_id)
    elif worker_id is not None:
        target_kind, target_id = "worker", str(worker_id)
    else:
        target_kind, target_id = None, None
    detail: dict[str, Any] = dict(fields)
    if workload_id is not None:
        detail["workload_id"] = str(workload_id)
    if shard_id is not None:
        detail["shard_id"] = str(shard_id)
    if worker_id is not None:
        detail["worker_id"] = str(worker_id)
    return {
        "action": f"lifecycle.{event}",
        "actor_kind": "system",
        "target_kind": target_kind,
        "target_id": target_id,
        "detail": detail,
    }


def _audit_writer_loop() -> None:
    # 懒 import：本模块不能在模块级依赖 storage（storage 侧可能反向依赖 observability）。
    from platform_v8.storage.db import get_session_factory
    from platform_v8.storage.repo import AuditRepo

    while True:
        batch = [_audit_queue.get()]
        deadline = time.monotonic() + _AUDIT_SINK_FLUSH_SECONDS
        while len(batch) < _AUDIT_SINK_BATCH_MAX:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                batch.append(_audit_queue.get(timeout=remaining))
            except queue.Empty:
                break
        try:
            with get_session_factory()() as session:
                for row in batch:
                    AuditRepo.write(session, **row)
                session.commit()
            with _lock:
                _counter["lifecycle_audit_sink_written_total"] += len(batch)
        except Exception:
            with _lock:
                _counter["lifecycle_audit_sink_failed_total"] += len(batch)
            logger.error(
                "lifecycle audit sink: %d row(s) lost (%s)",
                len(batch),
                ",".join(sorted({str(row["action"]) for row in batch})),
                exc_info=True,
            )


def _ensure_audit_writer() -> None:
    global _audit_thread
    with _audit_thread_lock:
        if _audit_thread is not None and _audit_thread.is_alive():
            return
        _audit_thread = threading.Thread(
            target=_audit_writer_loop, name="lifecycle-audit-sink", daemon=True,
        )
        _audit_thread.start()


def _enqueue_audit(row: dict[str, Any]) -> None:
    try:
        _audit_queue.put_nowait(row)
    except queue.Full:
        with _lock:
            _counter["lifecycle_audit_sink_dropped_total"] += 1
        logger.warning("lifecycle audit sink: queue full, dropped %s", row["action"])
        return
    with _lock:
        _counter["lifecycle_audit_sink_enqueued_total"] += 1
    _ensure_audit_writer()


def record_lifecycle_event(
    event: str,
    *,
    workload_id: object | None = None,
    shard_id: object | None = None,
    worker_id: object | None = None,
    attempt: int | None = None,
    reason_code: object | None = None,
    latency_ms: float | int | None = None,
    bytes_count: float | int | None = None,
    outcome: str | None = None,
    extra: Mapping[str, Any] | None = None,
) -> None:
    """Emit one approved lifecycle event and update in-process metrics.

    Unknown event names are rejected to prevent callers from inadvertently
    creating unbounded metric cardinality.  This function must remain best
    effort: telemetry cannot block a workload transition.
    """
    if event not in _ALLOWED_EVENTS:
        raise ValueError(f"unsupported lifecycle event: {event}")
    try:
        fields = _event_fields(
            workload_id=workload_id,
            shard_id=shard_id,
            worker_id=worker_id,
            attempt=attempt,
            reason_code=reason_code,
            latency_ms=latency_ms,
            bytes_count=bytes_count,
            outcome=outcome,
            extra=extra,
        )
        with _lock:
            _counter[f"lifecycle_{event}_total"] += 1
            _counter[f"lifecycle_{event}_{fields.get('outcome', 'unknown')}_total"] += 1
            if fields.get("bytes") is not None:
                _counter[f"lifecycle_{event}_bytes_total"] += int(fields["bytes"])
            if fields.get("latency_ms") is not None:
                count, total, maximum = _latency[event]
                _latency[event] = [
                    count + 1,
                    total + float(fields["latency_ms"]),
                    max(maximum, float(fields["latency_ms"])),
                ]
        logger.info("lifecycle_event=%s fields=%s", event, json.dumps(
            fields, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        ))
        if lifecycle_audit_sink_enabled():
            _enqueue_audit(_audit_row(
                event, fields, workload_id=workload_id, shard_id=shard_id, worker_id=worker_id,
            ))
    except Exception:
        logger.debug("lifecycle telemetry emission failed", exc_info=True)


def metrics_snapshot() -> dict[str, float | int]:
    """Return a copy for tests and a future metrics exporter."""
    with _lock:
        snapshot: dict[str, float | int] = dict(_counter)
        for event, (count, total, maximum) in _latency.items():
            snapshot[f"lifecycle_{event}_latency_ms_count"] = int(count)
            snapshot[f"lifecycle_{event}_latency_ms_sum"] = total
            snapshot[f"lifecycle_{event}_latency_ms_max"] = maximum
        return snapshot


def reset_metrics_for_test() -> None:
    """Reset local state; only use from isolated unit tests."""
    with _lock:
        _counter.clear()
        _latency.clear()
        _legacy_counter.clear()
