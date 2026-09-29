"""产品 API 契约：package-digest 与引擎解耦。"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from platform_v8.api.v8 import product_v1
from platform_v8.services.product import package_digest_api as pkg
from platform_v8.services import oss_provider
from platform_v8.services.workloads import submit as submit_svc
from platform_v8.storage.repo import WorkloadRepo


def test_map_status():
    assert pkg.map_status("NORMALIZING") == "queued"
    assert pkg.map_status("CREATED") == "queued"
    assert pkg.map_status("RUNNING") == "running"
    assert pkg.map_status("DONE") == "done"
    assert pkg.map_status("FAILED") == "failed"


def test_build_submit_spec_hides_engine_details_but_sets_package_digest():
    spec = pkg.build_submit_spec(
        input_refs=["v8/account-1/a.pdf", "v8/account-1/b.docx"],
        files=[
            {"object_key": "v8/account-1/a.pdf", "name": "a.pdf", "size": 10, "content_type": "application/pdf"},
            {"object_key": "v8/account-1/b.docx", "name": "b.docx", "size": 20},
        ],
    )
    assert spec["task_type"] == "package_digest"
    assert spec["code_url"] == ""
    assert spec["input_kind"] == "multi_file"
    assert spec["input_refs"] == ["v8/account-1/a.pdf", "v8/account-1/b.docx"]
    assert spec["params"]["recipe"] == "law_materials"
    assert spec["params"]["_product_api"] == "package-digest"
    assert spec["params"]["_product_api_version"] == "v1"
    assert len(spec["params"]["file_manifest"]) == 2
    assert spec["params"]["file_manifest"][0]["name"] == "a.pdf"


def test_extract_package_payload_from_metadata_inline_json():
    w = SimpleNamespace(
        id="job-1",
        status="DONE",
        progress=1.0,
        total_shards=2,
        completed_shards=2,
        failed_shards=0,
        error="",
        result=SimpleNamespace(
            metadata={
                "schema_version": "package_digest.v1",
                "inline_json": {
                    "schema_version": "package_digest.v1",
                    "result_text": "hello materials",
                    "materials": [{"name": "a.pdf", "text": "hello"}],
                },
            },
            output_ref="",
            inline_output="",
            summary="ok",
            elapsed_ms=1234,
        ),
    )
    out = pkg.result_payload(w)
    assert out["api_version"] == "v1"
    assert out["product"] == "package-digest"
    assert out["job_id"] == "job-1"
    assert out["status"] == "done"
    assert out["text"] == "hello materials"
    assert out["materials"][0]["name"] == "a.pdf"
    assert out["status_url"].endswith("/package-digest/job-1")
    assert out["result_url"].endswith("/package-digest/job-1/result")


def test_result_payload_rejects_unfinished():
    w = SimpleNamespace(
        id="job-2",
        status="RUNNING",
        progress=0.2,
        total_shards=1,
        completed_shards=0,
        failed_shards=0,
        error="",
        result=None,
    )
    try:
        pkg.result_payload(w)
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert "尚未完成" in str(e)


def test_product_submission_persists_canonical_key_not_presigned_url(monkeypatch):
    class _Provider:
        endpoint = "https://oss.example.test"
        bucket = "edgecompute"
        prefix = ""

    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Provider())
    captured = {}

    def _submit(_session, inp):
        captured["spec"] = inp.spec_dict
        return SimpleNamespace(id="job-1", spec=SimpleNamespace())

    monkeypatch.setattr(submit_svc, "submit_workload", _submit)
    monkeypatch.setattr(WorkloadRepo, "update_name", lambda *_a, **_k: None)
    monkeypatch.setattr(pkg, "cluster_capacity", lambda **_k: {})
    monkeypatch.setattr(
        pkg, "status_payload", lambda _w: {"job_id": "job-1", "status": "queued"}
    )
    body = product_v1.PackageDigestCreateIn(
        files=[
            product_v1.PackageDigestFileIn(
                object_key=(
                    "https://edgecompute.oss.example.test/"
                    "v8/account-7/input/bundle.zip?signature=secret"
                ),
                name="bundle.zip",
            )
        ],
        input_kind="archive",
        budget=1,
    )
    request = SimpleNamespace(
        headers={},
        client=SimpleNamespace(host="127.0.0.1"),
        state=SimpleNamespace(trace_id="trace"),
    )
    scheduled = []
    bg = SimpleNamespace(
        add_task=lambda callback, *args: scheduled.append((callback, args))
    )
    session = SimpleNamespace(commit=lambda: None)
    current = SimpleNamespace(id=7, is_admin=False)

    product_v1.create_package_digest(body, request, bg, session, current)

    assert captured["spec"]["input_ref"] == "v8/account-7/input/bundle.zip"
    assert captured["spec"]["input_refs"] == []
    assert captured["spec"]["input_kind"] == "archive"
    assert "signature" not in str(captured["spec"])
    assert scheduled == [
        (
            product_v1._async_wrap,
            (product_v1.start_submitted_workload, "job-1"),
        )
    ]
    body.files[0].object_key = "v8/account-8/input/bundle.zip"
    with pytest.raises(HTTPException) as exc:
        product_v1.create_package_digest(body, request, bg, session, current)
    assert exc.value.status_code == 403
