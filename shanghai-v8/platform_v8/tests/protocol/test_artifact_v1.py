"""artifact.v1 / lease 单元测试"""
from __future__ import annotations

import json

import pytest

from platform_v8.protocol.artifact import (
    ARTIFACT_SCHEMA,
    MAX_ARTIFACT_BYTES,
    ArtifactV1,
    build_object_key,
    expected_object_key_prefix,
    parse_artifact_ref,
    validate_artifact_against_context,
)
from platform_v8.services.artifact_lease import mint_lease_token, verify_lease_token
from platform_v8.protocol import ws_schema
from platform_v8.protocol.ws_schema import ShardResultPayload


def test_mint_and_verify_lease():
    tok = mint_lease_token(shard_id="s1", worker_id="w1", attempt=2, ttl_s=600)
    assert verify_lease_token(tok, shard_id="s1", worker_id="w1", attempt=2)
    assert not verify_lease_token(tok, shard_id="s1", worker_id="w1", attempt=3)
    assert not verify_lease_token(tok, shard_id="s1", worker_id="other", attempt=2)
    assert not verify_lease_token(tok, shard_id="other", worker_id="w1", attempt=2)
    assert not verify_lease_token("bad", shard_id="s1", worker_id="w1", attempt=2)


def test_build_object_key_prefix():
    key = build_object_key(
        account_id=7,
        workload_id="wl-1",
        shard_id="sh-1",
        result_id="rid",
        filename="out.mp4",
    )
    prefix = expected_object_key_prefix(
        account_id=7, workload_id="wl-1", shard_id="sh-1", result_id="rid"
    )
    assert key.startswith(prefix)
    assert key.endswith("out.mp4")


def test_filename_normalizes_chinese_and_common_punct():
    from platform_v8.protocol.artifact import normalize_artifact_filename

    assert normalize_artifact_filename("视频压缩 · 1 个输入_f7d5afe6.mp3") == (
        "视频压缩 · 1 个输入_f7d5afe6.mp3"
    )
    assert normalize_artifact_filename(
        "[BraveDown.Com] [东北往事完整版] [1784702087] _副本3.mp3"
    ).endswith("_副本3.mp3")
    assert "[" in normalize_artifact_filename("[a]b.mp3")
    # 路径穿越只留叶子；危险字符替换
    assert normalize_artifact_filename("../../x/a:b?.mp3") == "a_b_.mp3"
    assert normalize_artifact_filename("") == "output.bin"
    assert normalize_artifact_filename("..") == "output.bin"

    art = ArtifactV1(
        schema=ARTIFACT_SCHEMA,
        object_key=build_object_key(
            account_id=3,
            workload_id="w",
            shard_id="s",
            result_id="r",
            filename="视频压缩 · 1 个输入.mp3",
        ),
        filename="视频压缩 · 1 个输入.mp3",
        size_bytes=10,
        sha256="a" * 64,
        result_id="r",
    )
    assert art.filename == "视频压缩 · 1 个输入.mp3"
    assert "视频压缩" in art.object_key


def test_artifact_roundtrip_and_validate():
    key = build_object_key(
        account_id=3,
        workload_id="w",
        shard_id="s",
        result_id="r",
        filename="seg.mp4",
    )
    art = ArtifactV1(
        schema=ARTIFACT_SCHEMA,
        object_key=key,
        filename="seg.mp4",
        size_bytes=1024,
        content_type="video/mp4",
        sha256="a" * 64,
        result_id="r",
        shard_id="s",
        workload_id="w",
        account_id=3,
    )
    ref = art.to_storage_ref()
    parsed = parse_artifact_ref(ref)
    assert parsed is not None
    assert parsed.object_key == key
    validate_artifact_against_context(
        parsed, account_id=3, workload_id="w", shard_id="s"
    )
    with pytest.raises(ValueError):
        validate_artifact_against_context(
            parsed, account_id=9, workload_id="w", shard_id="s"
        )


def test_artifact_2gib_boundary_uses_manifest_only():
    fields = {
        "schema": ARTIFACT_SCHEMA,
        "object_key": build_object_key(
            account_id=3,
            workload_id="w",
            shard_id="s",
            result_id="r",
            filename="large.bin",
        ),
        "filename": "large.bin",
        "content_type": "application/octet-stream",
        "sha256": "a" * 64,
        "result_id": "r",
        "shard_id": "s",
        "workload_id": "w",
        "account_id": 3,
    }
    artifact = ArtifactV1(size_bytes=MAX_ARTIFACT_BYTES, **fields)
    assert artifact.size_bytes == 2 * 1024 * 1024 * 1024
    with pytest.raises(ValueError):
        ArtifactV1(size_bytes=MAX_ARTIFACT_BYTES + 1, **fields)


def test_844_strict_artifact_frame_stays_on_modern_path(monkeypatch):
    artifact = ArtifactV1(
        schema=ARTIFACT_SCHEMA,
        object_key=build_object_key(
            account_id=3,
            workload_id="w",
            shard_id="s",
            result_id="r",
            filename="out.bin",
        ),
        filename="out.bin",
        size_bytes=3,
        sha256="a" * 64,
        result_id="r",
        shard_id="s",
        workload_id="w",
        account_id=3,
    )
    monkeypatch.setenv("V8_LEGACY_RESULT_ADAPTER_KILL_SWITCH", "1")
    frame = ws_schema.parse_incoming(json.dumps({
        "v": "8.4.4",
        "type": "shard_result",
        "payload": {
            "shard_id": "s",
            "workload_id": "w",
            "worker_id": "worker",
            "attempt": 2,
            "ok": True,
            "output_ref": artifact.to_storage_ref(),
            "artifact": artifact.model_dump(by_alias=True),
            "lease_token": "strict-token",
        },
    }))
    assert isinstance(frame, ws_schema.ShardResult)
    assert frame.payload.artifact == artifact.model_dump(by_alias=True)
    validate_artifact_against_context(
        ArtifactV1.model_validate(frame.payload.artifact),
        account_id=3,
        workload_id="w",
        shard_id="s",
    )


def test_parse_non_artifact():
    assert parse_artifact_ref(None) is None
    assert parse_artifact_ref("https://example.com/x") is None
    assert parse_artifact_ref(json.dumps({"ok": True})) is None


def test_success_frame_rejects_empty_or_ambiguous_result():
    with pytest.raises(ValueError, match="lease_token"):
        ShardResultPayload(shard_id="s", ok=True)
    with pytest.raises(ValueError, match="exactly one"):
        ShardResultPayload(shard_id="s", ok=True, lease_token="token")
    with pytest.raises(ValueError, match="no inline"):
        ShardResultPayload(
            shard_id="s",
            ok=True,
            lease_token="token",
            output_ref='{"schema":"artifact.v1"}',
            inline_output="also-present",
            artifact={},
        )
