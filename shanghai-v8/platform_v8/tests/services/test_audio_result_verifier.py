from __future__ import annotations

import base64
from io import BytesIO

import pytest

from platform_v8.services.result_verifier import (
    ResultValidationError,
    _validate_audio_transcribe_refine,
    _validate_image_compress,
    _validate_processing_receipt,
)
from platform_v8.protocol.batch_contract import InputManifestV1


def _encoded(value: str) -> str:
    return base64.b64encode(value.encode()).decode()


def _valid_result() -> dict:
    return {
        "status": "ok",
        "contract_version": "1",
        "task_type": "audio_transcribe_refine",
        "result_files_b64": {
            "clip.srt": _encoded("1\n00:00:00,000 --> 00:00:01,000\nhello\n"),
            "clip_dialogue.txt": _encoded("[00:00:00] SPEAKER_01: hello"),
            "clip.json": _encoded("{}"),
        },
        "results": [{"filename": "clip.mp3", "segments_count": 1}],
        "summary": {"total_files": 1, "segments": 1},
    }


def test_audio_result_semantics_accepts_contract():
    _validate_audio_transcribe_refine(_valid_result(), {"outputs": ["srt", "dialogue"]})


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda p: p.update(status="failed"), "status"),
        (lambda p: p["result_files_b64"].pop("clip.srt"), "SRT"),
        (lambda p: p["result_files_b64"].update({"clip.srt": "not-base64"}), "base64"),
        (lambda p: p["summary"].update(total_files=2), "total_files"),
    ],
)
def test_audio_result_semantics_rejects_invalid_contract(mutate, message):
    payload = _valid_result()
    mutate(payload)
    with pytest.raises(ResultValidationError, match=message):
        _validate_audio_transcribe_refine(payload, {"outputs": ["srt", "dialogue"]})


def test_processing_receipt_must_cover_the_server_issued_input():
    manifest = {
        "schema": "input_manifest.v1",
        "semantics": "per_item",
        "total_entries": 2,
        "entries": [{
            "id": "input-a",
            "source_index": 0,
            "name": "clip.mp3",
            "object_key": "v8/account-1/input/clip.mp3",
            "size_bytes": 3,
        }],
    }
    payload = _valid_result()
    payload["processing_receipt"] = {
        "schema": "processing_receipt.v1",
        "input_manifest_sha256": InputManifestV1.model_validate(manifest).digest(),
        "items": [{
            "input_id": "input-a",
            "status": "succeeded",
            "outputs": [{"name": name} for name in payload["result_files_b64"]],
        }],
    }

    _validate_processing_receipt(
        payload, {"input_kind": "multi_file", "input_manifest": manifest},
    )


def test_processing_receipt_rejects_unissued_input_identity():
    manifest = {
        "schema": "input_manifest.v1",
        "semantics": "per_item",
        "total_entries": 1,
        "entries": [{
            "id": "input-a", "source_index": 0, "name": "clip.mp3",
            "object_key": "v8/account-1/input/clip.mp3", "size_bytes": 3,
        }],
    }
    payload = _valid_result()
    payload["processing_receipt"] = {
        "schema": "processing_receipt.v1",
        "input_manifest_sha256": InputManifestV1.model_validate(manifest).digest(),
        "items": [{"input_id": "forged", "status": "succeeded"}],
    }

    with pytest.raises(ResultValidationError, match="does not cover"):
        _validate_processing_receipt(
            payload, {"input_kind": "multi_file", "input_manifest": manifest},
        )


def test_processing_receipt_rejects_output_substitution():
    manifest = {
        "schema": "input_manifest.v1",
        "semantics": "per_item",
        "total_entries": 1,
        "entries": [{
            "id": "input-a", "source_index": 0, "name": "clip.mp3",
            "object_key": "v8/account-1/input/clip.mp3", "size_bytes": 3,
        }],
    }
    payload = _valid_result()
    payload["processing_receipt"] = {
        "schema": "processing_receipt.v1",
        "input_manifest_sha256": InputManifestV1.model_validate(manifest).digest(),
        "items": [{
            "input_id": "input-a",
            "status": "succeeded",
            "outputs": [{"name": "forged.txt"}],
        }],
    }

    with pytest.raises(ResultValidationError, match="outputs do not match"):
        _validate_processing_receipt(
            payload, {"input_kind": "multi_file", "input_manifest": manifest},
        )


def test_single_file_audio_keeps_legacy_receipt_compatibility():
    _validate_processing_receipt(
        _valid_result(),
        {"input_kind": "single_file", "input_manifest": {"not": "used"}},
    )


def test_image_compress_semantics_rejects_partial_or_invalid_output():
    Image = pytest.importorskip("PIL.Image")
    raw = BytesIO()
    Image.new("RGB", (1, 1), "white").save(raw, "PNG")
    payload = {
        "status": "ok",
        "contract_version": "1",
        "task_type": "image_compress",
        "result_images_b64": {"out.png": base64.b64encode(raw.getvalue()).decode()},
        "results": [{"filename": "out.png"}],
        "summary": {"success": 1, "failed": 0},
    }
    _validate_image_compress(payload)

    payload["summary"]["failed"] = 1
    with pytest.raises(ResultValidationError, match="failed"):
        _validate_image_compress(payload)
