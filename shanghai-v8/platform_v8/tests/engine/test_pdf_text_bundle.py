from __future__ import annotations

import json
from types import SimpleNamespace

from platform_v8.engine.aggregators import pdf_text_bundle


def _workload() -> SimpleNamespace:
    return SimpleNamespace(
        id="workload-1",
        owner_id=7,
        spec=SimpleNamespace(task_type="pdf_to_text"),
    )


def _shard(index: int, filename: str, pages: list[tuple[int, str]]) -> SimpleNamespace:
    return SimpleNamespace(
        index=index,
        output_ref=json.dumps({
            "status": "ok",
            "elapsed_ms": 10,
            "results": [{
                "filename": filename,
                "pages_total": 2,
                "route": "text",
                "backend": "PyMuPDF",
                "text_pages": [{"page": n, "chars": len(text), "text": text} for n, text in pages],
            }],
        }, ensure_ascii=False),
    )


def test_single_file_is_sorted_and_has_preview(monkeypatch):
    monkeypatch.setattr(pdf_text_bundle, "_upload_preview_to_oss", lambda *_: "https://example.test/result.txt")
    result = pdf_text_bundle.aggregate_pdf_text_bundle(
        _workload(),
        [_shard(1, "a.pdf", [(2, "second")]), _shard(0, "a.pdf", [(1, "first")])],
    )
    payload = json.loads(result.output_ref)
    assert payload["delivery"] == "text"
    assert payload["download_url"].endswith("result.txt")
    assert payload["files"][0]["text_preview"].startswith("first\n\nsecond")


def test_multi_file_is_delivered_as_zip(monkeypatch):
    monkeypatch.setattr(pdf_text_bundle, "_upload_to_oss", lambda *_: "https://example.test/results.zip")
    result = pdf_text_bundle.aggregate_pdf_text_bundle(
        _workload(),
        [_shard(0, "a.pdf", [(1, "A")]), _shard(1, "b.pdf", [(1, "B")])],
    )
    payload = json.loads(result.output_ref)
    assert payload["delivery"] == "zip"
    assert payload["download_url"].endswith("results.zip")
    assert len(payload["files"]) == 2
