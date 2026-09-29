"""
inline_concat · 直接拼字符串 (现有默认行为)

- 1 片: 直接返
- N 片: 用 ; 分隔拼接 output_ref

Runtime V2 / artifact 策略下 output_ref 常是 artifact.v1 指针；JSON 类任务
（base64 / 哈希碰撞 / FFT 等）需要展开成 Capability JSON，否则下载/预览
只剩 {schema, object_key, filename}。
"""
from __future__ import annotations

from platform_v8.core import Workload, Shard, WorkloadResult
from platform_v8.engine.aggregators.zip_files import materialize_output_ref


def aggregate_inline_concat(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    output_refs = [
        materialize_output_ref(sh.output_ref)
        for sh in shards
        if sh.output_ref
    ]
    output_ref = ";".join(output_refs) if len(output_refs) > 1 else (output_refs[0] if output_refs else "")
    return WorkloadResult(
        output_ref=output_ref,
        summary=f"完成 {len(shards)} 个分片",
        elapsed_ms=sum((sh.elapsed_ms or 0) for sh in shards),
        metadata={"shard_count": len(shards), "strategy": "inline_concat"},
    )
