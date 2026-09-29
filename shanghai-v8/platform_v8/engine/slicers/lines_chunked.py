"""
lines_chunked slicer · 把 inline_input 文本按行均分给 N 个 worker

适用:
  - word_count / json_filter / hash_batch / line_count (按行处理)

行为 (inline 模式):
  spec.inline_input = "line1\nline2\nline3\nline4\nline5" · n_workers=2 · max_shards=3
  → 实际切 min(n_workers, max_shards, max_shards_limit, 行数) = 2 片
  → shard0.inline_input = "line1\nline2\nline3"
  → shard1.inline_input = "line4\nline5"

  每片节点端: stdin 收到自己那批 lines · 跑脚本 · 返回 result_lines + summary
  aggregator (lines_merge): 合并 N 个 result_lines · summary 数字字段累加

边界:
  - 没 inline_input 但有 input_ref → fallback single (单 worker 跑整文件)
    (MVP 不实现远程下载 + 切 + 上传子文件路径)
  - 没任何输入 → fallback single (节点会自己报错)
"""
from __future__ import annotations
import logging

from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine.task_registry import get_spec

logger = logging.getLogger(__name__)


def slice_lines_chunked(workload: Workload, n_workers: int) -> list[Shard]:
    spec = workload.spec
    text = spec.inline_input or ""

    # 没 inline · 走 single (single_file URL 由 1 个节点拉完跑)
    if not text:
        logger.info(
            "lines_chunked: workload=%s 无 inline_input · fallback single",
            workload.id,
        )
        from .single import slice_single
        return slice_single(workload, n_workers)

    lines = text.split("\n")
    # 文件结尾常带空行 · 不切空 shard
    if lines and lines[-1] == "":
        lines = lines[:-1]
    if not lines:
        logger.info(
            "lines_chunked: workload=%s inline_input 空 · fallback single",
            workload.id,
        )
        from .single import slice_single
        return slice_single(workload, n_workers)

    task_meta = get_spec(spec.task_type)
    max_shards = max(1, min(
        spec.max_shards,
        task_meta.max_shards_limit,
        n_workers,
        len(lines),
    ))

    base, extra = divmod(len(lines), max_shards)
    shards: list[Shard] = []
    cursor = 0
    for i in range(max_shards):
        count = base + (1 if i < extra else 0)
        if count == 0:
            continue
        chunk = lines[cursor:cursor + count]
        sub_text = "\n".join(chunk)
        sh = Shard(
            workload_id=workload.id,
            index=i,
            total=max_shards,
            status=ShardStatus.PENDING,
            input_ref="",
            metadata={
                "slice_strategy": "lines_chunked",
                "workload_name": workload.name,
                "input_kind": "inline",
                "inline_input": sub_text,
                "input_refs": [],
                "slice_meta": {
                    "line_start": cursor,
                    "line_end": cursor + count,
                    "total_lines": len(lines),
                },
                "lines_in_shard": count,
                "total_lines": len(lines),
                "params": dict(spec.params or {}),
            },
        )
        cursor += count
        shards.append(sh)
    return shards
