from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager
from dataclasses import replace

import pytest
from sqlalchemy import create_engine, insert, update
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from platform_v8.api.v8.ws import (
    _adapt_legacy_worker_frame,
    _observe_legacy_profile,
)
from platform_v8.protocol.artifact import ArtifactV1, build_object_key
from platform_v8.services.legacy_result_adapter import (
    LegacyAdapterError,
    LegacyBinding,
    LegacyContentKind,
    LegacyResultContent,
    LegacyResultEnvelope,
    LegacyShape,
    parse_with_legacy_fallback,
)
from platform_v8.services.legacy_result_normalizer import (
    LegacyNormalizationConflict,
    LegacyNormalizationError,
    LegacyResultNormalizer,
)
from platform_v8.services.oss_provider import LocalFallbackProvider
from platform_v8.services.observability import (
    legacy_metrics_snapshot,
    reset_metrics_for_test,
)
from platform_v8.storage import db as db_mod
from platform_v8.storage.repo import (
    AssignmentDeliveryRepo,
    ResultVerificationRepo,
    ShardRepo,
    create_all_for_testing,
    shards_t,
    workers_t,
    workloads_t,
)


def _raw(payload: dict) -> str:
    return json.dumps({
        "type": "shard_result",
        "v": "8.0",
        "payload": payload,
    })


@pytest.fixture
def legacy_env(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    create_all_for_testing(engine)
    with Session(engine) as session:
        session.execute(insert(workers_t), [
            {
                "id": "worker-1",
                "owner_id": 2,
                "name": "worker",
                "status": "ONLINE",
                "capabilities": {},
            },
        ])
        session.execute(insert(workloads_t).values(
            id="workload-1",
            owner_id=1,
            name="workload",
            spec={
                "task_type": "video_compress",
                "runtime": "python3",
                "verification_policy": "artifact",
            },
            status="RUNNING",
            budget=0,
        ))
        session.execute(insert(shards_t).values(
            id="shard-1",
            workload_id="workload-1",
            status="RUNNING",
            worker_id="worker-1",
            attempts=1,
            metadata={},
        ))
        AssignmentDeliveryRepo.record_after_send(
            session,
            shard_id="shard-1",
            workload_id="workload-1",
            worker_id="worker-1",
            attempt=1,
            connection_id="connection-1",
            mode="push",
            client_version="8.0.9",
            client_build="legacy",
            protocol_capabilities=["legacy-result"],
        )
        session.commit()

    @contextmanager
    def scope():
        session = Session(engine)
        try:
            yield session
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    provider = LocalFallbackProvider(
        storage_root=str(tmp_path / "objects"),
        base_url="https://storage.example.test",
    )
    monkeypatch.setattr(db_mod, "session_scope", scope)
    monkeypatch.setattr(
        "platform_v8.services.oss_provider.get_oss_provider",
        lambda: provider,
    )

    def bind(payload: dict) -> LegacyResultEnvelope:
        with Session(engine) as session:
            envelope = parse_with_legacy_fallback(
                session,
                _raw(payload),
                authenticated_worker_id="worker-1",
                connection_id="connection-1",
            )
        assert isinstance(envelope, LegacyResultEnvelope)
        return envelope

    return engine, provider, scope, bind


def test_inline_normalizes_enqueues_and_persists_safe_evidence(
    legacy_env, monkeypatch,
):
    reset_metrics_for_test()
    engine, provider, scope, bind = legacy_env
    envelope = bind({
        "shard_id": "shard-1",
        "ok": True,
        "inline_output": '{"status":"ok"}',
        "elapsed_ms": 12,
    })
    result = LegacyResultNormalizer(
        provider=provider,
        session_scope_factory=scope,
    ).normalize_and_enqueue(envelope)

    assert result.artifact.schema_version == "artifact.v1"
    assert result.artifact.object_key.startswith(
        "v8/account-1/workload-workload-1/shard-shard-1/result/"
    )
    assert b"".join(provider.iter_object(result.artifact.object_key)) == (
        b'{"status":"ok"}'
    )
    with Session(engine) as session:
        row = ResultVerificationRepo.get(session, "shard-1", 1)
        shard = ShardRepo.by_id(session, "shard-1")
    assert row is not None
    assert shard is not None and shard.status.value == "VERIFYING"
    evidence = row["evidence"]
    assert evidence["adapter_version"] == "legacy-result.v1"
    assert evidence["legacy_shape"] == "result_inline"
    assert evidence["binding_method"] == "assignment_delivery"
    assert evidence["connection"].startswith("id:")
    assert "connection-1" not in json.dumps(evidence)
    assert "8.0.9" not in json.dumps(evidence)
    assert evidence["source_kind"] == "inline"
    assert evidence["compat_disposition"] == "normalized_inline"
    rendered = json.dumps(evidence)
    assert "status" not in rendered
    assert "base64" not in rendered.lower()
    assert "token" not in rendered.lower()

    monkeypatch.setattr(
        "platform_v8.services.result_verifier._verify_artifact_integrity",
        lambda _artifact: None,
    )
    from platform_v8.services.result_verification_jobs import (
        process_due_verifications,
    )

    outcomes = process_due_verifications()
    assert outcomes[0]["outcome"] == "done"
    with Session(engine) as session:
        completed = ResultVerificationRepo.get(session, "shard-1", 1)
        shard = ShardRepo.by_id(session, "shard-1")
    assert completed is not None
    assert completed["evidence"]["adapter_version"] == "legacy-result.v1"
    assert completed["evidence"]["kind"] == "artifact.v1"
    assert shard is not None and shard.status.value == "DONE"
    assert legacy_metrics_snapshot()["legacy_settlement_total"][
        ("verified", "none")
    ] == 1


def test_ws_adapter_to_normalizer_enqueues_durable_verification(legacy_env):
    """Exercise the WS fallback boundary through canonical queue persistence."""
    engine, provider, scope, _bind = legacy_env
    envelope = _adapt_legacy_worker_frame(
        _raw({
            "shard_id": "shard-1",
            "ok": True,
            "inline_output": "ws-bound-result",
        }),
        worker_id="worker-1",
        connection_id="connection-1",
    )
    assert isinstance(envelope, LegacyResultEnvelope)
    normalized = LegacyResultNormalizer(
        provider=provider,
        session_scope_factory=scope,
    ).normalize_and_enqueue(envelope)
    observed_profile = _observe_legacy_profile("worker-1", envelope.shape)

    with Session(engine) as session:
        row = ResultVerificationRepo.get(session, "shard-1", 1)
        shard = ShardRepo.by_id(session, "shard-1")
        worker = session.execute(
            workers_t.select().where(workers_t.c.id == "worker-1")
        ).one()
    assert normalized.enqueued
    assert observed_profile == "legacy_inline"
    assert row is not None
    assert row["state"] == ResultVerificationRepo.PENDING
    assert row["evidence"]["adapter_version"] == "legacy-result.v1"
    assert shard is not None and shard.status.value == "VERIFYING"
    assert worker.capabilities["protocol_profile"] == "legacy_inline"
    assert worker.capabilities["protocol_profile_observations"] == [
        "normalized:result_inline",
    ]


def test_normalization_is_idempotent_and_conflicting_content_is_rejected(
    legacy_env,
):
    reset_metrics_for_test()
    _engine, provider, scope, bind = legacy_env
    envelope = bind({
        "shard_id": "shard-1",
        "ok": True,
        "inline_output": "same",
    })
    normalizer = LegacyResultNormalizer(
        provider=provider,
        session_scope_factory=scope,
    )
    first = normalizer.normalize_and_enqueue(envelope)
    second = normalizer.normalize_and_enqueue(envelope)
    assert second.idempotent
    assert second.artifact.model_dump() == first.artifact.model_dump()

    conflicting = replace(
        envelope,
        content=replace(envelope.content, inline_text="different"),
    )
    with pytest.raises(LegacyNormalizationConflict):
        normalizer.normalize_and_enqueue(conflicting)
    metrics = legacy_metrics_snapshot()
    assert metrics["legacy_normalization_total"][
        ("success", "inline", "none")
    ] == 2
    assert metrics["legacy_normalization_total"][
        ("failure", "inline", "evidence_conflict")
    ] == 1
    assert metrics["legacy_replay_total"][
        ("duplicate", "normalization")
    ] == 1


def test_late_success_cannot_enqueue_after_attempt_changes(legacy_env):
    engine, provider, scope, bind = legacy_env
    envelope = bind({
        "shard_id": "shard-1",
        "ok": True,
        "inline_output": "late",
    })
    with Session(engine) as session:
        session.execute(
            update(shards_t)
            .where(shards_t.c.id == "shard-1")
            .values(attempts=2)
        )
        session.commit()

    with pytest.raises(
        LegacyNormalizationConflict,
        match="no longer current",
    ):
        LegacyResultNormalizer(
            provider=provider,
            session_scope_factory=scope,
        ).normalize_and_enqueue(envelope)
    with Session(engine) as session:
        assert ResultVerificationRepo.get(session, "shard-1", 1) is None


@pytest.mark.parametrize(
    "source_key",
    [
        "v8/account-1/legacy/workload-owned.bin",
        "v8/account-2/legacy/worker-owned.bin",
    ],
)
def test_workload_and_worker_owned_keys_copy_to_canonical(
    legacy_env, source_key,
):
    _engine, provider, scope, bind = legacy_env
    body = b"owned legacy object"
    provider.write_stream(source_key, (body,))
    envelope = bind({
        "shard_id": "shard-1",
        "ok": True,
        "output_ref": source_key,
    })
    result = LegacyResultNormalizer(
        provider=provider,
        session_scope_factory=scope,
    ).normalize_and_enqueue(envelope)
    assert result.artifact.object_key != source_key
    assert b"".join(provider.iter_object(result.artifact.object_key)) == body
    assert result.prepared.evidence["source_kind"] == "owned_object_key"


@pytest.mark.parametrize(
    "reference",
    [
        "v8/account-9/foreign.bin",
        "tasks/old/output.bin",
    ],
)
def test_cross_account_and_ownerless_task_keys_are_rejected(
    legacy_env, reference,
):
    _engine, _provider, _scope, bind = legacy_env
    with pytest.raises(LegacyAdapterError):
        bind({
            "shard_id": "shard-1",
            "ok": True,
            "output_ref": reference,
        })


def test_trusted_url_is_canonicalized_and_query_never_persisted(legacy_env):
    _engine, provider, scope, bind = legacy_env
    key = "v8/account-1/legacy/signed.bin"
    provider.write_stream(key, (b"signed object",))
    envelope = bind({
        "shard_id": "shard-1",
        "ok": True,
        "output_ref": (
            f"https://storage.example.test/{key}"
            "?Signature=secret&SecurityToken=private"
        ),
    })
    assert envelope.content is not None
    assert envelope.content.reference == key
    result = LegacyResultNormalizer(
        provider=provider,
        session_scope_factory=scope,
    ).normalize_and_enqueue(envelope)
    rendered = json.dumps(result.prepared.evidence)
    assert "Signature" not in rendered
    assert "secret" not in rendered
    assert result.prepared.evidence["source_kind"] == "trusted_oss_url"


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/v8/account-1/result.bin",
        "https://user:pass@storage.example.test/v8/account-1/result.bin",
        "https://127.0.0.1/v8/account-1/result.bin",
    ],
)
def test_unknown_userinfo_and_ip_hosts_are_rejected(legacy_env, url):
    _engine, _provider, _scope, bind = legacy_env
    with pytest.raises(LegacyAdapterError):
        bind({
            "shard_id": "shard-1",
            "ok": True,
            "output_ref": url,
        })


def test_source_change_between_hash_and_copy_aborts(legacy_env):
    _engine, provider, scope, bind = legacy_env
    key = "v8/account-1/legacy/changing.bin"
    provider.write_stream(key, (b"before",))
    envelope = bind({
        "shard_id": "shard-1",
        "ok": True,
        "output_ref": key,
    })
    original_iter = provider.iter_object
    calls = 0

    def changing_iter(object_key, *, chunk_size=1024 * 1024):
        nonlocal calls
        calls += 1
        if calls == 2 and object_key == key:
            yield b"after!"
            return
        yield from original_iter(object_key, chunk_size=chunk_size)

    provider.iter_object = changing_iter
    with pytest.raises(LegacyNormalizationError, match="write failed"):
        LegacyResultNormalizer(
            provider=provider,
            session_scope_factory=scope,
        ).normalize_and_enqueue(envelope)


def test_configured_object_limit_aborts_before_canonical_write(
    legacy_env, monkeypatch,
):
    reset_metrics_for_test()
    _engine, provider, scope, bind = legacy_env
    key = "v8/account-1/legacy/large.bin"
    provider.write_stream(key, (b"x" * (64 * 1024 + 1),))
    envelope = bind({
        "shard_id": "shard-1",
        "ok": True,
        "output_ref": key,
    })
    monkeypatch.setenv("V8_LEGACY_RESULT_MAX_OBJECT_BYTES", str(64 * 1024))
    with pytest.raises(LegacyNormalizationError, match="size limit"):
        LegacyResultNormalizer(
            provider=provider,
            session_scope_factory=scope,
        ).normalize_and_enqueue(envelope)
    metrics = legacy_metrics_snapshot()
    assert metrics["legacy_normalization_total"][
        ("failure", "owned_object_key", "size_limit")
    ] == 1
    assert metrics["legacy_security_block_total"][
        ("size", "normalization")
    ] == 1


def test_strict_artifact_inline_duplicate_reuses_issuance_without_copy(
    legacy_env,
):
    engine, provider, scope, bind = legacy_env
    body = b"abc"
    digest = hashlib.sha256(body).hexdigest()
    artifact = ArtifactV1(
        schema="artifact.v1",
        object_key=build_object_key(
            account_id=1,
            workload_id="workload-1",
            shard_id="shard-1",
            result_id="modern-result",
            filename="out.bin",
        ),
        filename="out.bin",
        size_bytes=len(body),
        content_type="application/octet-stream",
        sha256=digest,
        result_id="modern-result",
        shard_id="shard-1",
        workload_id="workload-1",
        account_id=1,
    )
    provider.write_stream(artifact.object_key, (body,))
    with Session(engine) as session:
        assert ShardRepo.record_result_upload_issuance(
            session,
            "shard-1",
            worker_id="worker-1",
            object_key=artifact.object_key,
            result_id=artifact.result_id,
            size_bytes=artifact.size_bytes,
            sha256=artifact.sha256,
            content_type=artifact.content_type,
            expires_at=4_000_000_000,
            expected_attempt=1,
        )
        session.commit()
    manifest = artifact.model_dump(by_alias=True)
    envelope = bind({
        "shard_id": "shard-1",
        "ok": True,
        "artifact": manifest,
        "output_ref": artifact.to_storage_ref(),
        "inline_output": body.decode(),
    })
    result = LegacyResultNormalizer(
        provider=provider,
        session_scope_factory=scope,
    ).normalize_and_enqueue(envelope)
    assert result.artifact.model_dump() == artifact.model_dump()
    assert (
        result.prepared.evidence["compat_disposition"]
        == "strict_artifact_inline_deduplicated"
    )


def test_artifact_inline_hash_conflict_and_unbound_input_are_rejected(
    legacy_env,
):
    _engine, _provider, _scope, bind = legacy_env
    digest = hashlib.sha256(b"abc").hexdigest()
    artifact = {
        "schema": "artifact.v1",
        "object_key": (
            "v8/account-1/workload-workload-1/shard-shard-1/"
            "result/r/out.bin"
        ),
        "filename": "out.bin",
        "size_bytes": 3,
        "content_type": "application/octet-stream",
        "sha256": digest,
        "result_id": "r",
        "shard_id": "shard-1",
        "workload_id": "workload-1",
        "account_id": 1,
    }
    with pytest.raises(LegacyAdapterError):
        bind({
            "shard_id": "shard-1",
            "ok": True,
            "artifact": artifact,
            "output_ref": json.dumps(artifact),
            "inline_output": "xyz",
        })
    with pytest.raises(TypeError):
        LegacyResultNormalizer().normalize_and_enqueue({"ok": True})  # type: ignore[arg-type]
    fabricated = LegacyResultEnvelope(
        binding=LegacyBinding(
            shard_id="shard-1",
            workload_id="workload-1",
            worker_id="worker-1",
            attempt=1,
            connection_id="connection-1",
        ),
        shape=LegacyShape.RESULT_INLINE,
        ok=True,
        content=LegacyResultContent(
            kind=LegacyContentKind.INLINE_TEXT,
            inline_text="abc",
        ),
    )
    with pytest.raises(TypeError, match="bound"):
        LegacyResultNormalizer().normalize_and_enqueue(fabricated)
