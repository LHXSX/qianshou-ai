import json

from platform_v8.core import Shard, Workload, WorkloadSpec
from platform_v8.engine.aggregators import lines_merge


def test_lines_merge_loads_spooled_object_key(monkeypatch):
    object_key = "v8/account-9/shard/result/output.json"
    monkeypatch.setattr(
        lines_merge,
        "_load_shard_json",
        lambda ref: {
            "status": "ok",
            "task_type": "json_filter",
            "result_lines": ['{"id":1}', '{"id":2}'],
            "summary": {"matched_rows": 2},
            "elapsed_ms": 8,
        } if ref == object_key else {},
    )
    workload = Workload(
        spec=WorkloadSpec(task_type="json_filter", input_kind="multi_file"),
    )
    shard = Shard(
        workload_id=workload.id,
        index=0,
        output_ref=object_key,
    )

    result = lines_merge.aggregate_lines_merge(workload, [shard])
    payload = json.loads(result.output_ref)

    assert payload["result_lines"] == ['{"id":1}', '{"id":2}']
    assert payload["summary"]["matched_rows"] == 2
    assert payload["elapsed_ms"] == 8


def test_lines_merge_keeps_hash_result_objects(monkeypatch):
    monkeypatch.setattr(
        lines_merge,
        "_load_shard_json",
        lambda ref: {
            "capability": "crypto.hash",
            "legacyTaskType": "hash_batch",
            "columns": ["filename", "algorithm", "digest"],
            "results": [{"filename": "a.txt", "algorithm": "sha256", "digest": "abc"}],
            "result_lines": ["abc\ta.txt"],
            "summary": {"items": 1},
            "elapsed_ms": 3,
        },
    )
    workload = Workload(spec=WorkloadSpec(task_type="hash_batch", input_kind="single_file"))
    shard = Shard(workload_id=workload.id, index=0, output_ref='{"schema":"artifact.v1"}')

    result = lines_merge.aggregate_lines_merge(workload, [shard])
    payload = json.loads(result.output_ref)

    assert payload["results"] == [{"filename": "a.txt", "algorithm": "sha256", "digest": "abc"}]
    assert payload["capability"] == "crypto.hash"
    assert payload["columns"][0] == "filename"
    assert "1 条结果" in payload["summary_text"]
