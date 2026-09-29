from __future__ import annotations

import base64
import asyncio
import hashlib
import json
import logging
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, func, insert, select, update
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from platform_v8.api.v8.ws import _persist_legacy_shard_progress
from platform_v8.protocol.artifact import ArtifactV1, build_object_key
from platform_v8.protocol.ws_schema import ShardResult
from platform_v8.engine import aggregator
from platform_v8.services.legacy_result_adapter import (
    LegacyAdapterError,
    LegacyBindingMethod,
    LegacyContentKind,
    LegacyProgressEnvelope,
    LegacyRejectReason,
    LegacyResultEnvelope,
    LegacyShape,
    parse_with_legacy_fallback,
)
from platform_v8.services.observability import (
    legacy_metrics_snapshot,
    reset_metrics_for_test,
)
from platform_v8.storage.repo import (
    AssignmentDeliveryRepo,
    ShardRepo,
    assignment_deliveries_t,
    create_all_for_testing,
    shards_t,
    workers_t,
    workloads_t,
)


def _session(
    *,
    status: str = "RUNNING",
    worker_id: str | None = "worker-1",
    lease_by_node: str | None = None,
    attempt: int = 1,
    metadata: dict | None = None,
    connection_id: str = "connection-1",
    delivery_worker: str = "worker-1",
    mode: str = "push",
) -> Session:
    engine = create_engine(
        "sqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    create_all_for_testing(engine)
    session = Session(engine)
    session.execute(insert(workers_t), [
        {
            "id": "worker-1",
            "owner_id": 2,
            "name": "worker one",
            "status": "ONLINE",
            "capabilities": {},
        },
        {
            "id": "worker-2",
            "owner_id": 3,
            "name": "worker two",
            "status": "ONLINE",
            "capabilities": {},
        },
    ])
    session.execute(insert(workloads_t).values(
        id="workload-1",
        owner_id=1,
        name="workload",
        spec={"task_type": "noop", "runtime": "python3"},
        status="RUNNING",
        budget=0,
    ))
    session.execute(insert(shards_t).values(
        id="shard-1",
        workload_id="workload-1",
        status=status,
        worker_id=worker_id,
        lease_by_node=lease_by_node,
        attempts=attempt,
        metadata=metadata or {},
    ))
    AssignmentDeliveryRepo.record_after_send(
        session,
        shard_id="shard-1",
        workload_id="workload-1",
        worker_id=delivery_worker,
        attempt=attempt,
        connection_id=connection_id,
        mode=mode,
        client_version="8.0.9",
        client_build="legacy-build",
        protocol_capabilities=["legacy-result"],
    )
    session.commit()
    return session


def _raw(frame_type: str, payload: dict, *, version: str = "8.0") -> str:
    return json.dumps(
        {"type": frame_type, "v": version, "payload": payload},
        ensure_ascii=False,
    )


def _parse(session: Session, raw: str, **kwargs):
    return parse_with_legacy_fallback(
        session,
        raw,
        authenticated_worker_id=kwargs.pop("worker_id", "worker-1"),
        connection_id=kwargs.pop("connection_id", "connection-1"),
        **kwargs,
    )


def _artifact() -> dict:
    result_id = "result-1"
    return ArtifactV1(
        schema="artifact.v1",
        object_key=build_object_key(
            account_id=1,
            workload_id="workload-1",
            shard_id="shard-1",
            result_id=result_id,
            filename="out.bin",
        ),
        filename="out.bin",
        size_bytes=3,
        sha256=hashlib.sha256(b"abc").hexdigest(),
        result_id=result_id,
        shard_id="shard-1",
        workload_id="workload-1",
        account_id=1,
    ).model_dump(by_alias=True)


@pytest.mark.parametrize(
    ("payload", "shape", "kind"),
    [
        (
            {"shard_id": "shard-1", "ok": True, "inline_output": "hello"},
            LegacyShape.RESULT_INLINE,
            LegacyContentKind.INLINE_TEXT,
        ),
        (
            {
                "shard_id": "shard-1",
                "ok": True,
                "output_ref": "v8/account-1/legacy/result.json",
            },
            LegacyShape.RESULT_OBJECT_KEY,
            LegacyContentKind.OBJECT_KEY,
        ),
        (
            {
                "task_id": "shard-1",
                "ok": True,
                "output": "historical task output",
            },
            LegacyShape.RESULT_ALIASED,
            LegacyContentKind.INLINE_TEXT,
        ),
    ],
)
def test_parses_historical_inline_key_and_real_task_result_alias(
    payload, shape, kind,
):
    with _session() as session:
        frame = _parse(session, _raw("shard_result", payload))
    assert isinstance(frame, LegacyResultEnvelope)
    assert frame.shape == shape
    assert frame.content is not None and frame.content.kind == kind
    assert frame.binding.attempt == 1
    assert frame.binding.method == LegacyBindingMethod.ASSIGNMENT_DELIVERY
    assert frame.binding.client_version == "8.0.9"


@pytest.mark.parametrize("version", ["8.2", "8.3.0"])
def test_82_and_early_83_bare_owned_keys(version):
    with _session() as session:
        frame = _parse(session, _raw("shard_result", {
            "shard_id": "shard-1",
            "ok": True,
            "output_ref": "v8/account-1/legacy/result.json",
        }, version=version))
    assert isinstance(frame, LegacyResultEnvelope)
    assert frame.shape == LegacyShape.RESULT_OBJECT_KEY
    assert frame.content is not None
    assert frame.content.reference == "v8/account-1/legacy/result.json"


def test_parses_trusted_legacy_oss_url_without_storing_query(monkeypatch):
    provider = SimpleNamespace(
        endpoint="https://oss.example.test",
        public_endpoint="",
        base_url="",
        cdn_domain="",
        bucket="edgecompute",
        prefix="",
        config=None,
    )
    monkeypatch.setattr(
        "platform_v8.services.oss_provider.get_oss_provider",
        lambda: provider,
    )
    signed = (
        "https://oss.example.test/v8/account-1/legacy/result.json"
        "?Signature=secret&Expires=999"
    )
    with _session() as session:
        frame = _parse(session, _raw("shard_result", {
            "shard_id": "shard-1",
            "ok": True,
            "output_ref": signed,
        }))
    assert isinstance(frame, LegacyResultEnvelope)
    assert frame.shape == LegacyShape.RESULT_OSS_URL
    assert frame.content is not None
    assert frame.content.kind == LegacyContentKind.TRUSTED_OSS_URL
    assert frame.content.reference == "v8/account-1/legacy/result.json"
    assert "secret" not in repr(frame)


def test_parses_historical_artifact_and_inline_duplicate():
    artifact = _artifact()
    manifest = json.dumps(artifact, separators=(",", ":"))
    with _session() as session:
        frame = _parse(session, _raw("shard_result", {
            "shard_id": "shard-1",
            "ok": True,
            "artifact": artifact,
            "output_ref": manifest,
            "inline_output": "abc",
            "lease_token": "",
        }))
    assert isinstance(frame, LegacyResultEnvelope)
    assert frame.shape == LegacyShape.RESULT_ARTIFACT_INLINE
    assert frame.content is not None
    assert frame.content.kind == LegacyContentKind.ARTIFACT_INLINE_DUPLICATE

    with _session() as session:
        binary_duplicate = _parse(session, _raw("shard_result", {
            "shard_id": "shard-1",
            "ok": True,
            "artifact": artifact,
            "output_ref": manifest,
            "inline_output_b64": base64.b64encode(b"abc").decode("ascii"),
        }))
    assert isinstance(binary_duplicate, LegacyResultEnvelope)
    assert binary_duplicate.content is not None
    assert binary_duplicate.content.inline_bytes == b"abc"


def test_tokenless_progress_binds_attempt_and_client_metadata():
    with _session(mode="pull") as session:
        frame = _parse(session, _raw("shard_progress", {
            "shard_id": "shard-1",
            "pct": 0.4,
            "message": "working",
            "worker_id": "worker-1",
            "attempt": 1,
            "workload_id": "workload-1",
        }))
    assert isinstance(frame, LegacyProgressEnvelope)
    assert frame.binding.attempt == 1
    assert frame.client_worker_id == "worker-1"
    assert frame.client_attempt == 1
    assert frame.client_workload_id == "workload-1"


@pytest.mark.parametrize(
    "reassignment",
    [
        {"attempts": 2},
        {"worker_id": "worker-2"},
    ],
)
def test_legacy_progress_persistence_uses_worker_and_attempt_cas(reassignment):
    with _session() as session:
        frame = _parse(session, _raw("shard_progress", {
            "shard_id": "shard-1",
            "pct": 0.4,
        }))
        assert isinstance(frame, LegacyProgressEnvelope)
        session.execute(
            update(shards_t)
            .where(shards_t.c.id == "shard-1")
            .values(**reassignment)
        )
        session.commit()

        @contextmanager
        def _scope():
            yield session

        with patch("platform_v8.storage.db.session_scope", _scope):
            assert _persist_legacy_shard_progress(frame) is None


@pytest.mark.parametrize(
    ("payload_update", "reason"),
    [
        ({"worker_id": "worker-2"}, LegacyRejectReason.WORKER_MISMATCH),
        ({"attempt": 0}, LegacyRejectReason.ATTEMPT_MISMATCH),
        ({"workload_id": "workload-other"}, LegacyRejectReason.WORKLOAD_MISMATCH),
    ],
)
def test_rejects_client_worker_attempt_and_workload_mismatch(
    payload_update, reason,
):
    payload = {
        "shard_id": "shard-1",
        "ok": False,
        "error": "failed",
    }
    payload.update(payload_update)
    with _session() as session, pytest.raises(LegacyAdapterError) as exc:
        _parse(session, _raw("shard_result", payload))
    assert exc.value.reason == reason


def test_rejects_delivery_from_different_connection():
    with _session(connection_id="connection-other") as session, pytest.raises(
        LegacyAdapterError,
    ) as exc:
        _parse(session, _raw("shard_result", {
            "shard_id": "shard-1",
            "ok": False,
        }))
    assert exc.value.reason == LegacyRejectReason.DELIVERY_MISSING


def test_reconnect_invalidates_delivery_evidence_for_old_connection():
    with _session(connection_id="connection-old") as session:
        AssignmentDeliveryRepo.record_after_send(
            session,
            shard_id="shard-1",
            workload_id="workload-1",
            worker_id="worker-1",
            attempt=1,
            connection_id="connection-new",
            mode="recovery",
        )
        session.commit()
        with pytest.raises(LegacyAdapterError) as exc:
            _parse(
                session,
                _raw("shard_result", {
                    "shard_id": "shard-1",
                    "ok": False,
                }),
                connection_id="connection-old",
            )
        current = _parse(
            session,
            _raw("shard_result", {
                "shard_id": "shard-1",
                "ok": False,
            }),
            connection_id="connection-new",
        )
    assert exc.value.reason == LegacyRejectReason.DELIVERY_AMBIGUOUS
    assert isinstance(current, LegacyResultEnvelope)


def test_reassignment_and_same_worker_multi_attempt_are_ambiguous():
    with _session(attempt=1) as session:
        session.execute(
            update(shards_t)
            .where(shards_t.c.id == "shard-1")
            .values(attempts=2, status="RUNNING")
        )
        AssignmentDeliveryRepo.record_after_send(
            session,
            shard_id="shard-1",
            workload_id="workload-1",
            worker_id="worker-1",
            attempt=2,
            connection_id="connection-1",
            mode="recovery",
        )
        session.commit()
        with pytest.raises(LegacyAdapterError) as exc:
            _parse(session, _raw("shard_result", {
                "shard_id": "shard-1",
                "ok": False,
            }))
    assert exc.value.reason == LegacyRejectReason.DELIVERY_AMBIGUOUS


def test_late_failure_attempt_cannot_reset_reassigned_same_worker():
    with _session(attempt=2) as session:
        assert not ShardRepo.reset_pending(
            session,
            "shard-1",
            expected_worker_id="worker-1",
            expected_attempt=1,
        )
        assert not ShardRepo.mark_failed(
            session,
            "shard-1",
            error="late failure",
            expected_worker_id="worker-1",
            expected_attempt=1,
        )
        shard = ShardRepo.by_id(session, "shard-1")
    assert shard is not None
    assert shard.status.value == "RUNNING"
    assert shard.attempts == 2


def test_aggregator_ignores_late_failure_from_old_same_worker_attempt():
    with _session(attempt=2) as session:
        @contextmanager
        def _scope():
            yield session

        with patch("platform_v8.storage.db.session_scope", _scope):
            asyncio.run(aggregator.on_shard_failed(
                "shard-1",
                error="late failure",
                expected_worker_id="worker-1",
                expected_attempt=1,
            ))
        shard = ShardRepo.by_id(session, "shard-1")
    assert shard is not None
    assert shard.status.value == "RUNNING"
    assert shard.attempts == 2


@pytest.mark.parametrize(
    "session_kwargs",
    [
        {
            "status": "LEASED",
            "worker_id": None,
            "lease_by_node": "worker-1",
            "mode": "pull",
        },
        {
            "status": "RUNNING",
            "worker_id": "worker-1",
            "metadata": {"race_workers": ["worker-2"], "race_enabled": True},
            "delivery_worker": "worker-2",
            "mode": "race",
        },
    ],
)
def test_pull_lease_holder_and_racer_are_valid_current_workers(session_kwargs):
    auth_worker = session_kwargs.get("delivery_worker", "worker-1")
    with _session(**session_kwargs) as session:
        frame = _parse(
            session,
            _raw("shard_result", {
                "shard_id": "shard-1",
                "ok": False,
            }),
            worker_id=auth_worker,
        )
    assert isinstance(frame, LegacyResultEnvelope)
    assert frame.binding.worker_id == auth_worker


def test_modern_bad_token_and_invalid_artifact_never_use_legacy_fallback():
    modern_bad_token = _raw("shard_result", {
        "shard_id": "shard-1",
        "ok": True,
        "inline_output": "hello",
        "lease_token": "wrong-but-present",
    })
    with _session() as session:
        strict = _parse(session, modern_bad_token)
    assert isinstance(strict, ShardResult)
    assert strict.payload.lease_token == "wrong-but-present"

    invalid_artifact = _raw("shard_result", {
        "shard_id": "shard-1",
        "ok": True,
        "artifact": {"schema": "artifact.v1", "object_key": "../bad"},
        "output_ref": "{}",
        "inline_output": "{}",
    })
    with _session() as session, pytest.raises(LegacyAdapterError) as exc:
        _parse(session, invalid_artifact)
    assert exc.value.reason == LegacyRejectReason.MODERN_INVALID


def test_historical_duplicate_shape_cannot_bypass_bad_lease_token():
    artifact = _artifact()
    manifest = json.dumps(artifact, separators=(",", ":"))
    raw = _raw("shard_result", {
        "shard_id": "shard-1",
        "ok": True,
        "artifact": artifact,
        "output_ref": manifest,
        "inline_output": "abc",
        "lease_token": "wrong-token",
    })
    with _session() as session, patch(
        "platform_v8.services.artifact_lease.verify_lease_token",
        return_value=False,
    ), pytest.raises(LegacyAdapterError) as exc:
        _parse(session, raw)
    assert exc.value.reason == LegacyRejectReason.INVALID_LEASE_TOKEN


def test_frame_inline_base64_and_empty_success_limits_are_fail_closed():
    with _session() as session:
        decoded = _parse(session, _raw("shard_result", {
            "shard_id": "shard-1",
            "ok": True,
            "output_b64": base64.b64encode(b"hello").decode("ascii"),
        }))
    assert isinstance(decoded, LegacyResultEnvelope)
    assert decoded.content is not None
    assert decoded.content.inline_bytes == b"hello"

    with _session() as session, pytest.raises(LegacyAdapterError) as exc:
        _parse(
            session,
            _raw("shard_result", {
                "shard_id": "shard-1",
                "ok": True,
                "inline_output": "x" * 2048,
            }),
            max_inline_bytes=1024,
        )
    assert exc.value.reason == LegacyRejectReason.INLINE_TOO_LARGE

    with _session() as session, pytest.raises(LegacyAdapterError) as exc:
        _parse(
            session,
            _raw("shard_result", {
                "shard_id": "shard-1",
                "ok": True,
                "output_b64": "not*base64",
            }),
        )
    assert exc.value.reason == LegacyRejectReason.INVALID_BASE64

    with _session() as session, pytest.raises(LegacyAdapterError) as exc:
        _parse(session, _raw("shard_result", {
            "shard_id": "shard-1",
            "ok": True,
        }))
    assert exc.value.reason == LegacyRejectReason.EMPTY_SUCCESS

    oversized = _raw("shard_result", {
        "shard_id": "shard-1",
        "ok": True,
        "inline_output": "secret" * 500,
    })
    with _session() as session, pytest.raises(LegacyAdapterError) as exc:
        _parse(session, oversized, max_frame_bytes=1024)
    assert exc.value.reason == LegacyRejectReason.FRAME_TOO_LARGE


def test_legacy_fallback_can_be_disabled_without_changing_strict_path():
    strict_raw = _raw("shard_result", {
        "shard_id": "shard-1",
        "ok": True,
        "inline_output": "modern",
        "lease_token": "present",
    })
    with _session() as session:
        assert isinstance(_parse(session, strict_raw, enabled=False), ShardResult)

    with _session() as session, pytest.raises(LegacyAdapterError) as exc:
        _parse(session, _raw("shard_progress", {
            "shard_id": "shard-1",
            "pct": 0.2,
        }), enabled=False)
    assert exc.value.reason == LegacyRejectReason.DISABLED


def test_rejections_and_logs_do_not_expose_frame_secrets(caplog):
    secret = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturesecret"
    signed = "https://evil.example/x?Signature=super-secret"
    raw = _raw("shard_result", {
        "shard_id": "shard-1",
        "ok": True,
        "inline_output": f"{secret} {signed}",
        "artifact": {"bad": secret},
    })
    caplog.set_level(logging.DEBUG)
    with _session() as session, pytest.raises(LegacyAdapterError) as exc:
        _parse(session, raw)
    rendered = str(exc.value) + "\n" + caplog.text
    assert "signaturesecret" not in rendered
    assert "super-secret" not in rendered
    assert "eyJhbGci" not in rendered


def test_delivery_table_remains_append_only_during_adapter_use():
    with _session() as session:
        before = session.scalar(
            select(func.count()).select_from(assignment_deliveries_t)
        )
        _parse(session, _raw("shard_progress", {
            "shard_id": "shard-1",
            "pct": 0.2,
        }))
        after = session.scalar(
            select(func.count()).select_from(assignment_deliveries_t)
        )
    assert before == after == 1


def test_legacy_metrics_cover_accept_binding_reject_and_modern_isolation():
    reset_metrics_for_test()
    modern = _raw("shard_result", {
        "shard_id": "shard-1",
        "ok": True,
        "inline_output": "modern",
        "lease_token": "present",
    })
    with _session() as session:
        assert isinstance(_parse(session, modern), ShardResult)
    assert not legacy_metrics_snapshot()["legacy_frame_accept_total"]

    with _session() as session:
        frame = _parse(session, _raw("shard_result", {
            "shard_id": "shard-1",
            "ok": True,
            "inline_output": "legacy",
        }))
    assert isinstance(frame, LegacyResultEnvelope)
    accepted = legacy_metrics_snapshot()
    assert accepted["legacy_frame_accept_total"][
        ("result", "result_inline", "inline", "legacy_inline")
    ] == 1
    assert accepted["legacy_binding_total"][("accepted", "none")] == 1

    with _session() as session, pytest.raises(LegacyAdapterError):
        _parse(session, _raw("shard_result", {
            "shard_id": "shard-1",
            "ok": False,
            "attempt": 0,
        }))
    rejected = legacy_metrics_snapshot()
    assert rejected["legacy_binding_total"][("late", "attempt_mismatch")] == 1


def test_legacy_diagnostic_strips_query_token_and_long_base64():
    long_base64 = "A" * 256
    with _session() as session:
        frame = _parse(session, _raw("shard_result", {
            "shard_id": "shard-1",
            "ok": False,
            "error": (
                "download https://storage.example/result"
                "?Signature=query-secret "
                "Authorization=token-secret "
                f"{long_base64}"
            ),
        }))
    assert isinstance(frame, LegacyResultEnvelope)
    assert "query-secret" not in frame.error
    assert "token-secret" not in frame.error
    assert long_base64 not in frame.error
    assert "https://storage.example/result" in frame.error


@pytest.mark.parametrize(
    ("env", "value", "mode", "source"),
    [
        ("V8_LEGACY_RESULT_ADAPTER_ACCEPT", "off", "off", "env"),
        ("V8_LEGACY_RESULT_ADAPTER_ACCEPT", "shadow", "shadow", "env"),
        (
            "V8_LEGACY_RESULT_ADAPTER_KILL_SWITCH",
            "true",
            "off",
            "kill_switch",
        ),
    ],
)
def test_legacy_gate_blocks_are_low_cardinality_metrics(
    monkeypatch, env, value, mode, source,
):
    reset_metrics_for_test()
    monkeypatch.delenv(
        "V8_LEGACY_RESULT_ADAPTER_KILL_SWITCH",
        raising=False,
    )
    monkeypatch.delenv("V8_LEGACY_RESULT_ADAPTER_ACCEPT", raising=False)
    monkeypatch.setenv(env, value)
    with _session() as session, pytest.raises(LegacyAdapterError) as exc:
        _parse(session, _raw("shard_progress", {
            "shard_id": "shard-1",
            "pct": 0.2,
        }))
    assert exc.value.reason == LegacyRejectReason.DISABLED
    snapshot = legacy_metrics_snapshot()
    assert snapshot["legacy_gate_block_total"][("accept", mode, source)] == 1


@pytest.mark.parametrize(
    ("payload_factory", "reason", "control", "stage"),
    [
        (
            lambda: {
                "shard_id": "shard-1",
                "ok": True,
                "output_ref": "v8/account-99/foreign.bin",
            },
            LegacyRejectReason.CROSS_TENANT,
            "cross_tenant",
            "binding",
        ),
        (
            lambda: {
                "shard_id": "shard-1",
                "ok": True,
                "output_ref": "https://evil.example/private?token=secret",
            },
            LegacyRejectReason.UNSAFE_URL,
            "unsafe_url",
            "binding",
        ),
        (
            lambda: {
                "shard_id": "shard-1",
                "ok": True,
                "artifact": _artifact(),
                "output_ref": json.dumps(_artifact()),
                "inline_output": "xyz",
            },
            LegacyRejectReason.HASH_MISMATCH,
            "hash",
            "adapter",
        ),
    ],
)
def test_legacy_security_blocks_have_stable_control_labels(
    payload_factory, reason, control, stage,
):
    reset_metrics_for_test()
    with _session() as session, pytest.raises(LegacyAdapterError) as exc:
        _parse(session, _raw("shard_result", payload_factory()))
    assert exc.value.reason == reason
    assert legacy_metrics_snapshot()["legacy_security_block_total"][
        (control, stage)
    ] == 1
