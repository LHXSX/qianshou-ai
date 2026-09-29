import json

from platform_v8.core import Shard, Workload, WorkloadSpec
from platform_v8.engine.aggregators import manifest_only


def test_manifest_only_loads_spooled_object_key(monkeypatch):
    object_key = "v8/account-9/shard/result/output.json"
    monkeypatch.setattr(
        manifest_only,
        "_load_shard_json",
        lambda ref: {
            "status": "ok",
            "task_type": "pdf_info",
            "results": [{"filename": "a.pdf", "pages": 3}],
            "summary": {"files_ok": 1, "pages": 3},
            "elapsed_ms": 7,
        } if ref == object_key else {},
    )
    workload = Workload(
        spec=WorkloadSpec(task_type="pdf_info", input_kind="multi_file"),
    )
    shard = Shard(
        workload_id=workload.id,
        index=0,
        output_ref=object_key,
    )

    result = manifest_only.aggregate_manifest_only(workload, [shard])
    payload = json.loads(result.output_ref)

    assert payload["results"] == [{"filename": "a.pdf", "pages": 3}]
    assert payload["summary"]["files_ok"] == 1
    assert payload["elapsed_ms"] == 7
