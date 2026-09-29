from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from platform_v8.protocol.batch_contract import InputManifestV1


def _load_script():
    path = Path(__file__).parents[2] / "scripts" / "tasks" / "image_compress.py"
    spec = importlib.util.spec_from_file_location("image_compress_batch_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_image_compress_receipt_binds_every_input_and_output(tmp_path, monkeypatch):
    manifest = {
        "schema": "input_manifest.v1",
        "semantics": "per_item",
        "total_entries": 2,
        "entries": [
            {
                "id": "input-1", "source_index": 0, "name": "a.jpg",
                "object_key": "v8/account-1/a.jpg", "size_bytes": 1,
            },
            {
                "id": "input-2", "source_index": 1, "name": "b.jpg",
                "object_key": "v8/account-1/b.jpg", "size_bytes": 1,
            },
        ],
    }
    manifest_path = tmp_path / "input_manifest.v1.json"
    manifest_path.write_text(json.dumps(manifest))
    monkeypatch.setenv("EC_INPUT_MANIFEST", str(manifest_path))

    receipt = _load_script()._processing_receipt([["a_q85.jpg"], ["b_q85.jpg"]])

    assert receipt["input_manifest_sha256"] == InputManifestV1.model_validate(manifest).digest()
    assert [item["input_id"] for item in receipt["items"]] == ["input-1", "input-2"]
    assert receipt["items"][1]["outputs"] == [{"name": "b_q85.jpg"}]
