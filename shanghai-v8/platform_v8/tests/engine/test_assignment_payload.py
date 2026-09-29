from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

import pytest

from platform_v8.core import Shard, ShardStatus, Workload, WorkloadSpec
from platform_v8.core.enums import Runtime, WorkloadStatus
from platform_v8.engine.assignment_payload import (
    AssignmentPayloadError,
    build_assignment_payload,
    ensure_capability_op,
)
from platform_v8.services import oss_provider


def _objects():
    workload = Workload(
        id="workload-1",
        owner_id=7,
        name="private",
        status=WorkloadStatus.RUNNING,
        spec=WorkloadSpec(
            task_type="pdf_to_text",
            runtime=Runtime.PYTHON3,
            input_kind="multi_file",
            timeout_s=321,
        ),
        budget=1,
        created_at=datetime.utcnow(),
    )
    shard = Shard(
        id="shard-1",
        workload_id=workload.id,
        index=0,
        total=1,
        status=ShardStatus.DISPATCHED,
        input_ref="v8/account-7/input/a.pdf",
        attempts=2,
        metadata={
            "input_kind": "multi_file",
            "input_refs": ["uploads/tenant_7/task_x/b.pdf"],
            "input_manifest": {"schema": "input_manifest.v1"},
            "slice_meta": {"page_start": 0},
        },
    )
    return workload, shard


class _Provider:
    def presign_get(self, key: str, *, expires: int):
        return {"url": f"https://oss.example.test/{key}?signed=1"}


@pytest.mark.parametrize("worker_id", ["push", "pull", "race", "reconnect"])
def test_all_dispatch_paths_materialize_complete_payload(monkeypatch, worker_id):
    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Provider())
    workload, shard = _objects()
    payload = build_assignment_payload(shard, workload, worker_id=worker_id)
    assert payload.input_ref.startswith("https://")
    assert payload.input_refs[0].startswith("https://")
    assert payload.input_manifest["schema"] == "input_manifest.v1"
    assert payload.timeout_s > 0
    assert payload.lease_token


def test_signing_failure_never_emits_raw_key(monkeypatch):
    class _Fail:
        def presign_get(self, key: str, *, expires: int):
            raise RuntimeError("provider down")

    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Fail())
    workload, shard = _objects()
    with pytest.raises(AssignmentPayloadError):
        build_assignment_payload(shard, workload, worker_id="push")


def test_v2_payload_keeps_code_url_and_adds_capability(monkeypatch):
    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Provider())
    monkeypatch.setenv("PUBLIC_API_BASE", "http://192.168.2.215:8000")
    workload, shard = _objects()
    workload.spec.execution_model = "runtime_v2"
    workload.spec.params = {
        "execution_model": "runtime_v2",
        "app_slug": "pdf-text-v2",
        "required_capabilities": [{"name": "doc.pdf.text", "version": "1.0.0"}],
    }
    payload = build_assignment_payload(shard, workload, worker_id="eco")
    assert payload.code_url.endswith("/api/v8/scripts/pdf_to_text.py")
    assert payload.execution_model == "runtime_v2"
    assert payload.runtime_api == "2.0"
    assert payload.capability == "doc.pdf.text"
    assert payload.capability_version
    dumped = payload.model_dump()
    assert "code_url" in dumped and dumped["code_url"]
    assert dumped["execution_model"] == "runtime_v2"


def test_ensure_capability_op_fills_text_replace():
    assert ensure_capability_op("text_replace", {})["op"] == "replace"
    assert ensure_capability_op("text_replace", {"op": "dedup"})["op"] == "dedup"
    assert "op" not in ensure_capability_op("pdf_to_text", {})


def test_files_chunked_payload_does_not_expand_to_full_workload_refs(monkeypatch):
    """回归：借调并行时每片只能拿到本片文件，不能把 9 张都打给每个节点。"""
    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Provider())
    files = [f"v8/account-1/input/{i}.webp" for i in range(9)]
    workload = Workload(
        id="workload-convert",
        owner_id=1,
        name="格式转换",
        status=WorkloadStatus.RUNNING,
        spec=WorkloadSpec(
            task_type="image_convert",
            runtime=Runtime.PYTHON3,
            input_kind="multi_file",
            input_refs=files,
            max_shards=4,
        ),
        budget=1,
        created_at=datetime.utcnow(),
    )
    from platform_v8.engine.slicers import slice_workload

    shards = slice_workload(workload, n_workers=4)
    assert len(shards) == 4
    chunk_sizes = []
    for sh in shards:
        meta_n = len(sh.metadata.get("input_refs") or [])
        payload = build_assignment_payload(sh, workload, worker_id="worker-1")
        assert len(payload.input_refs) == meta_n
        assert len(payload.input_refs) < len(files)
        chunk_sizes.append(len(payload.input_refs))
    assert sum(chunk_sizes) == len(files)
