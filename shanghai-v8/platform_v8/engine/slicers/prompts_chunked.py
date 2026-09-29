"""
prompts_chunked slicer · 把"列表型"参数(URL/prompt/item 列表)均分给 N 个 worker

适用:
  - crawl_batch_fetch (params.urls) · 批量抓取 · 每片抓一批 URL
  - 任何带可拆分列表参数的批处理任务 (批量 prompt / 批量 item)

行为:
  spec.params = {"urls": [u1..u100], "timeout_s": 30} · n_workers=4 · max_shards=4
  → shard0.params = {"urls": [u1..u25],  "timeout_s": 30}
  → shard1.params = {"urls": [u26..u50], "timeout_s": 30}
  → ...
  其余非列表参数原样复制到每片 · aggregator(manifest_only / lines_merge) 汇总各片结果

边界:
  - 没有可拆分的列表参数 (如 llm_chat 单 prompt 从 stdin 读) → fallback single
  - 列表长度 < 2 或 max_shards<=1 → fallback single
"""
from __future__ import annotations
import logging

from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine.task_registry import get_spec

logger = logging.getLogger(__name__)

# 可拆分的"列表型"参数名 (按优先级) · 命中即按它切
_LIST_KEYS = ("urls", "prompts", "items", "inputs", "texts", "queries", "tasks")


def slice_prompts_chunked(workload: Workload, n_workers: int) -> list[Shard]:
    spec = workload.spec
    params = dict(spec.params or {})

    # 找一个非空 list 参数
    list_key = None
    for k in _LIST_KEYS:
        v = params.get(k)
        if isinstance(v, list) and len(v) > 0:
            list_key = k
            break

    if list_key is None:
        logger.info("prompts_chunked: workload=%s 无可拆分列表参数 (%s) · fallback single",
                    workload.id, list(_LIST_KEYS))
        from .single import slice_single
        return slice_single(workload, n_workers)

    items = list(params[list_key])
    task_meta = get_spec(spec.task_type)
    max_shards = max(1, min(
        spec.max_shards,
        task_meta.max_shards_limit,
        n_workers,
        len(items),
    ))
    if max_shards <= 1:
        from .single import slice_single
        return slice_single(workload, n_workers)

    base, extra = divmod(len(items), max_shards)
    shards: list[Shard] = []
    cursor = 0
    for i in range(max_shards):
        count = base + (1 if i < extra else 0)
        if count == 0:
            continue
        chunk = items[cursor:cursor + count]
        shard_params = dict(params)
        shard_params[list_key] = chunk
        sh = Shard(
            workload_id=workload.id,
            index=i,
            total=max_shards,
            status=ShardStatus.PENDING,
            input_ref=spec.input_ref or "",
            metadata={
                "slice_strategy": "prompts_chunked",
                "workload_name": workload.name,
                "input_kind": spec.input_kind or "params_only",
                "inline_input": spec.inline_input,
                "input_refs": list(spec.input_refs) if spec.input_refs else [],
                "slice_meta": {
                    "list_key": list_key,
                    "item_start": cursor,
                    "item_end": cursor + count,
                    "items_in_shard": count,
                    "total_items": len(items),
                },
                "params": shard_params,
            },
        )
        cursor += count
        shards.append(sh)

    logger.info("prompts_chunked: workload=%s · %s=%d 项 → %d 片",
                workload.id, list_key, len(items), len(shards))
    return shards
