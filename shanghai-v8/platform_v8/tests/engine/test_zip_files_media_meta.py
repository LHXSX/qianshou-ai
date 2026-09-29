"""zip_files · 媒体 batch zip 元数据与 UTF-8 文件名"""
from __future__ import annotations

import io
import json
import zipfile

from platform_v8.engine.aggregators import zip_files as zf


def test_zip_member_basename_utf8_flag():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        info = zipfile.ZipInfo("中文名.png")
        info.flag_bits |= 0x800
        z.writestr(info, b"\x89PNG\r\n\x1a\n")
    with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as z2:
        info = z2.infolist()[0]
        assert zf._zip_member_basename(info) == "中文名.png"


def test_parse_results_from_zip_json():
    blob = json.dumps({
        "results": [
            {"filename": "a.jpg", "output_filename": "a-thumbnail-1.jpg", "status": "ok"},
        ]
    }).encode()
    rows = zf._parse_results_from_zip_json(blob)
    assert rows[0]["filename"] == "a.jpg"


def test_ingest_skips_output_json_for_video_thumbnail(monkeypatch):
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
    meta = json.dumps({
        "results": [
            {
                "filename": "源.mp4",
                "output_filename": "源-thumbnail-1.jpg",
                "format": "jpg",
                "output_size": "12 KB",
                "status": "ok",
            }
        ]
    }).encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        info = zipfile.ZipInfo("源-thumbnail-1.jpg")
        info.flag_bits |= 0x800
        z.writestr(info, png)
        z.writestr("output.json", meta)

    monkeypatch.setattr(zf, "_download_object_bytes", lambda key, **kw: buf.getvalue())
    all_files: dict = {}
    all_results: list = []
    zf._ingest_artifact_v1(
        {"schema": "artifact.v1", "object_key": "v8/x/batch.zip", "filename": "media-thumbnail-batch.zip"},
        shard_index=0,
        shard_count=1,
        all_files=all_files,
        all_results=all_results,
        task_type="video_thumbnail",
    )
    assert "output.json" not in all_files
    assert any(k.endswith(".jpg") for k in all_files)
    assert all_results[0]["filename"] == "源.mp4"
    assert all_results[0]["output_filename"] == "源-thumbnail-1.jpg"


def test_artifact_has_capability_payload():
    assert zf._artifact_has_capability_payload({
        "capability": "media.transform",
        "results": [{"filename": "a"}],
    })
    assert not zf._artifact_has_capability_payload({
        "schema": "artifact.v1",
        "object_key": "x",
    })
