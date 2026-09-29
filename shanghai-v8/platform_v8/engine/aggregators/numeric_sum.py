"""
numeric_sum · 数值加总 + 求 mean/min/max

适用: pi_compute / monte_carlo (每片产一个 sample 计数 · 合并求 π)
"""
from __future__ import annotations
import json
import logging

from platform_v8.core import Workload, Shard, WorkloadResult
from platform_v8.engine.aggregators.zip_files import load_shard_result

logger = logging.getLogger(__name__)


def aggregate_numeric_sum(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    sums: dict[str, float] = {}
    samples: dict[str, list[float]] = {}
    elapsed_total = 0

    for sh in shards:
        if not sh.output_ref:
            continue
        try:
            data = load_shard_result(sh.output_ref)
        except Exception:
            try:
                data = json.loads(sh.output_ref)
            except Exception:
                continue
        if not isinstance(data, dict):
            continue

        # 把所有数值字段累加 (summary 里的)
        for k, v in (data.get("summary", {}) or {}).items():
            if isinstance(v, (int, float)):
                sums[k] = sums.get(k, 0.0) + float(v)
                samples.setdefault(k, []).append(float(v))

        elapsed_total += int(data.get("elapsed_ms", 0) or 0)

    # 算 mean/min/max
    stats: dict[str, dict] = {}
    for k, vs in samples.items():
        if not vs:
            continue
        stats[k] = {
            "sum": sums[k],
            "mean": sum(vs) / len(vs),
            "min": min(vs),
            "max": max(vs),
            "count": len(vs),
        }

    final = {
        "status": "ok",
        "schema_version": "v1",
        "task_type": workload.spec.task_type,
        "elapsed_ms": elapsed_total,
        "summary": sums,           # 直接累加
        "stats": stats,            # mean/min/max
        "shard_count": len(shards),
        "summary_text": f"数值合并 {len(shards)} 个分片",
    }
    return WorkloadResult(
        output_ref=json.dumps(final, ensure_ascii=False),
        summary=f"数值累加 {len(shards)} 片",
        elapsed_ms=elapsed_total,
        metadata={"shard_count": len(shards), "strategy": "numeric_sum"},
    )
