from __future__ import annotations

from platform_v8.core import WorkloadResult
from platform_v8.engine.aggregator import _result_delivery_error


def test_aggregation_failure_result_is_not_deliverable():
    result = WorkloadResult(
        output_ref='{"status":"failed","error":"没有可打包的输出文件"}',
    )
    assert "没有可打包" in _result_delivery_error(result)


def test_empty_aggregation_result_is_not_deliverable():
    assert _result_delivery_error(WorkloadResult()) == "聚合未生成可交付结果"


def test_deliverable_result_passes_gate():
    assert not _result_delivery_error(WorkloadResult(output_ref="object-key"))
