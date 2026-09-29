from __future__ import annotations

import logging

import pytest

from platform_v8.services.observability import (
    legacy_metric_schema,
    legacy_metrics_snapshot,
    merge_legacy_metrics_snapshots,
    metrics_snapshot,
    prometheus_registry,
    record_legacy_metric,
    record_legacy_profile,
    record_legacy_verification_disposition,
    record_lifecycle_event,
    redact_identifier,
    reset_metrics_for_test,
)


@pytest.fixture(autouse=True)
def reset_metrics():
    reset_metrics_for_test()
    yield
    reset_metrics_for_test()


def test_lifecycle_event_redacts_identifiers_and_sensitive_fields(caplog):
    with caplog.at_level(logging.INFO, logger="platform_v8.observability"):
        record_lifecycle_event(
            "dispatch",
            workload_id="workload-secret",
            shard_id="shard-secret",
            worker_id="worker-secret",
            attempt=2,
            reason_code="lease expired",
            latency_ms=12.5,
            bytes_count=1024,
            outcome="sent",
            extra={
                "signed_url": "https://storage.example/signed-secret",
                "payload": {"private": "value"},
                "queue_depth": 3,
            },
        )

    message = caplog.messages[-1]
    assert "workload-secret" not in message
    assert "shard-secret" not in message
    assert "worker-secret" not in message
    assert "signed-secret" not in message
    assert '"meta_queue_depth":3' in message
    assert '"reason_code":"LEASE_EXPIRED"' in message
    assert redact_identifier("workload-secret") in message


def test_lifecycle_event_records_count_and_latency_metrics():
    record_lifecycle_event(
        "verification",
        shard_id="s-1",
        attempt=4,
        latency_ms=11,
        bytes_count=2048,
        outcome="verified",
    )
    record_lifecycle_event(
        "verification",
        shard_id="s-2",
        attempt=4,
        latency_ms=7,
        outcome="quarantined",
    )

    metrics = metrics_snapshot()
    assert metrics["lifecycle_verification_total"] == 2
    assert metrics["lifecycle_verification_verified_total"] == 1
    assert metrics["lifecycle_verification_quarantined_total"] == 1
    assert metrics["lifecycle_verification_bytes_total"] == 2048
    assert metrics["lifecycle_verification_latency_ms_count"] == 2
    assert metrics["lifecycle_verification_latency_ms_sum"] == 18
    assert metrics["lifecycle_verification_latency_ms_max"] == 11


def test_lifecycle_event_rejects_unknown_event_names():
    with pytest.raises(ValueError, match="unsupported lifecycle event"):
        record_lifecycle_event("unbounded_cardinality")


def test_reason_code_cannot_log_url_or_path(caplog):
    with caplog.at_level(logging.INFO, logger="platform_v8.observability"):
        record_lifecycle_event(
            "refund",
            workload_id="workload",
            reason_code="https://storage.example/private",
            outcome="issued",
        )

    assert "storage.example" not in caplog.messages[-1]
    assert '"reason_code":"UNSAFE_REASON"' in caplog.messages[-1]


def test_legacy_unknown_labels_collapse_to_other_and_snapshots_merge():
    labels = record_legacy_metric(
        "legacy_frame_reject_total",
        frame_type="workload-specific-frame",
        stage="exception-type",
        reason="https://storage.example/private?token=secret",
    )
    first = legacy_metrics_snapshot()
    second = legacy_metrics_snapshot()
    merged = merge_legacy_metrics_snapshots(first, second)

    assert labels == ("other", "other", "other")
    assert merged["legacy_frame_reject_total"][labels] == 2


def test_legacy_metric_schema_has_only_fixed_low_cardinality_labels():
    forbidden = {
        "worker",
        "shard",
        "workload",
        "connection",
        "client_build",
        "version",
        "object_key",
        "url",
        "exception",
    }
    schema = legacy_metric_schema()

    assert schema
    assert not forbidden.intersection({
        label
        for labels in schema.values()
        for label in labels
    })


def test_legacy_audit_hashes_ids_and_never_logs_secret_values(caplog):
    secret_url = "https://storage.example/x?Signature=query-secret"
    long_base64 = "A" * 256
    with caplog.at_level(logging.INFO, logger="platform_v8.observability"):
        record_legacy_metric(
            "legacy_frame_reject_total",
            audit_event="reject",
            identifiers={
                "worker": "worker-secret",
                "shard": long_base64,
            },
            frame_type="result",
            stage="adapter",
            reason=secret_url,
        )

    message = caplog.messages[-1]
    assert "worker-secret" not in message
    assert long_base64 not in message
    assert "query-secret" not in message
    assert "storage.example" not in message
    assert redact_identifier("worker-secret") in message
    assert '"reason":"other"' in message


def test_prometheus_registry_is_optional_and_env_safe(monkeypatch):
    monkeypatch.delenv("PROMETHEUS_MULTIPROC_DIR", raising=False)
    disabled = prometheus_registry()
    monkeypatch.setenv(
        "PROMETHEUS_MULTIPROC_DIR",
        "/path/that/is/not/created/by-observability",
    )
    enabled = prometheus_registry()

    assert disabled is None or hasattr(disabled, "collect")
    assert enabled is None or hasattr(enabled, "collect")


def test_legacy_capability_observation_and_transition_are_separate():
    record_legacy_profile(
        observed="legacy_owned_ref",
        previous="legacy_inline",
        current="legacy_owned_ref",
    )
    metrics = legacy_metrics_snapshot()["legacy_capability_profile_total"]

    assert metrics[
        ("observed", "legacy_inline", "legacy_owned_ref")
    ] == 1
    assert metrics[
        ("transition", "legacy_inline", "legacy_owned_ref")
    ] == 1


def test_legacy_counter_is_visible_to_existing_prometheus_exporter(monkeypatch):
    prometheus_client = pytest.importorskip("prometheus_client")
    monkeypatch.delenv("PROMETHEUS_MULTIPROC_DIR", raising=False)
    record_legacy_metric(
        "legacy_frame_accept_total",
        frame_type="progress",
        shape="progress_tokenless",
        source_kind="none",
        profile="legacy_inline",
    )

    rendered = prometheus_client.generate_latest(prometheus_registry()).decode()
    assert "legacy_frame_accept_total{" in rendered
    assert 'shape="progress_tokenless"' in rendered


@pytest.mark.parametrize(
    ("disposition", "reason_code", "sample"),
    [
        (
            "LEGACY_ARTIFACT_VERIFIED",
            "LEGACY_SEMANTIC_DOWNGRADE",
            ("legacy_artifact", "none"),
        ),
        (
            "QUARANTINED",
            "REGISTRY_QUARANTINE",
            ("quarantine", "registry_quarantine"),
        ),
        (
            "QUARANTINED",
            "LEGACY_SETTLEMENT_DISABLED",
            ("settlement_blocked", "settlement_gate_closed"),
        ),
        ("future-disposition", "dynamic-detail", ("other", "other")),
    ],
)
def test_legacy_verification_dispositions_use_stable_settlement_labels(
    disposition, reason_code, sample,
):
    record_legacy_verification_disposition(
        disposition=disposition,
        reason_code=reason_code,
    )
    assert legacy_metrics_snapshot()["legacy_settlement_total"][sample] == 1
