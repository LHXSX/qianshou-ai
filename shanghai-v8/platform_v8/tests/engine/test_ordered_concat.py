import json

from platform_v8.core import Shard, Workload, WorkloadSpec
from platform_v8.engine.aggregators import ordered_concat


def test_ordered_concat_loads_spooled_object_key(monkeypatch):
    object_key = "v8/account-11/shard/result/output.json"
    monkeypatch.setattr(
        ordered_concat,
        "_load_shard_json",
        lambda ref: {
            "status": "ok",
            "task_type": "pdf_to_text",
            "result_text": "从 OSS JSON 读取的 PDF 正文",
            "elapsed_ms": 12,
        } if ref == object_key else {},
    )
    workload = Workload(
        spec=WorkloadSpec(task_type="pdf_to_text", input_kind="single_file"),
    )
    shard = Shard(
        workload_id=workload.id,
        index=0,
        output_ref=object_key,
    )

    result = ordered_concat.aggregate_ordered_concat(workload, [shard])
    payload = json.loads(result.output_ref)

    assert payload["text"] == "从 OSS JSON 读取的 PDF 正文"
    assert payload["elapsed_ms"] == 12
