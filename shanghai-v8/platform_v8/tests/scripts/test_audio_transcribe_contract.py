from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from platform_v8.core import Workload, WorkloadSpec
from platform_v8.engine.slicers import slice_workload
from platform_v8.engine.task_registry import get_spec
from platform_v8.protocol.batch_contract import InputManifestV1


def _load_script():
    path = Path(__file__).parents[2] / "scripts" / "tasks" / "audio_transcribe_refine.py"
    spec = importlib.util.spec_from_file_location("audio_transcribe_refine_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_audio_transcribe_refine_supports_explicit_batch_sharding():
    task = get_spec("audio_transcribe_refine")
    assert task.accepted_input_kinds == ("single_file", "multi_file", "archive")
    assert task.slicer == "files_chunked"
    assert task.max_shards_limit > 1
    assert task.settlement_policy == "semantic"


def test_audio_script_rejects_multiple_downloaded_inputs(tmp_path, monkeypatch):
    (tmp_path / "first.mp3").write_bytes(b"one")
    (tmp_path / "second.mp3").write_bytes(b"two")
    monkeypatch.setenv("EC_INPUT_DIR", str(tmp_path))

    with pytest.raises(ValueError, match="每片只能处理一个文件"):
        _load_script()._read_audio({})


def test_audio_script_ignores_input_manifest_in_download_directory(tmp_path, monkeypatch):
    (tmp_path / "input_manifest.v1.json").write_text("{}")
    (tmp_path / "clip.mp3").write_bytes(b"one")
    monkeypatch.setenv("EC_INPUT_DIR", str(tmp_path))

    assert _load_script()._read_audio({}) == ("clip.mp3", b"one")


def test_audio_script_receipt_uses_server_canonical_manifest_digest(tmp_path, monkeypatch):
    manifest = {
        "schema": "input_manifest.v1",
        "semantics": "per_item",
        "total_entries": 1,
        "entries": [{
            "id": "input-1",
            "source_index": 0,
            "name": "clip.mp3",
            "object_key": "v8/account-1/input/clip.mp3",
            "size_bytes": 3,
        }],
    }
    path = tmp_path / "input_manifest.v1.json"
    path.write_text(__import__("json").dumps(manifest))
    monkeypatch.setenv("EC_INPUT_MANIFEST", str(path))

    receipt = _load_script()._processing_receipt(["clip.srt", "clip.json"])

    assert receipt["input_manifest_sha256"] == InputManifestV1.model_validate(manifest).digest()
    assert receipt["items"][0]["input_id"] == "input-1"


def test_audio_batch_keeps_one_file_per_shard_when_workers_are_scarce():
    workload = Workload(spec=WorkloadSpec(
        task_type="audio_transcribe_refine",
        input_kind="multi_file",
        input_refs=[f"v8/account-1/input/{index}.mp3" for index in range(4)],
        max_shards=20,
    ))

    shards = slice_workload(workload, n_workers=1)

    assert len(shards) == 4
    assert all(shard.metadata["files_in_shard"] == 1 for shard in shards)


def test_single_slicer_preserves_trusted_batch_identity():
    workload = Workload(spec=WorkloadSpec(
        task_type="image_compress",
        input_kind="multi_file",
        input_refs=["v8/account-1/input/photo.jpg"],
        params={"input_batch": {"entries": [{
            "id": "upload-9",
            "index": 4,
            "name": "customer/photo.jpg",
            "object_key": "v8/account-1/input/photo.jpg",
            "size_bytes": 123,
            "sha256": "a" * 64,
            "content_type": "image/jpeg",
        }]}},
    ))

    shard = slice_workload(workload, n_workers=1)[0]
    entry = shard.metadata["input_manifest"]["entries"][0]
    assert entry["id"] == "upload-9"
    assert entry["name"] == "customer/photo.jpg"
    assert entry["sha256"] == "a" * 64
