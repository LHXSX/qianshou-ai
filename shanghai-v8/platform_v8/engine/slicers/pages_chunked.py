"""
pages_chunked slicer · PDF 按页范围切片

适用:
  - pdf_to_text / pdf_ocr

设计 (chicken-egg 解法):
  planner 不下载 PDF · 不知道总页数
  → 用 "页范围百分比" 切: shard.metadata.page_pct_range = [start_pct, end_pct]
  → 节点端拿到 PDF 后 · pages = total_pages * pct_range · 处理对应页范围
  → 这样 slicer 永远 O(1) · 节点端按需读取
"""
from __future__ import annotations

from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine.task_registry import get_spec


def slice_pages_chunked(workload: Workload, n_workers: int) -> list[Shard]:
    spec = workload.spec
    task_meta = get_spec(spec.task_type)
    # 用户请求的并行度（计费边界）优先；再受 registry 上限与在线 worker 数约束
    requested = max(1, int(spec.max_shards or 1))
    max_shards = max(1, min(
        requested,
        task_meta.max_shards_limit,
        max(1, n_workers),
    ))
    if max_shards != requested:
        import logging
        logging.getLogger(__name__).info(
            "pages_chunked · workload=%s requested=%s applied=%s (limit=%s workers=%s)",
            workload.id, requested, max_shards, task_meta.max_shards_limit, n_workers,
        )

    # 如果用户在 params 里给了 total_pages · 用真实页数切 (更精确)
    total_pages = int(spec.params.get("total_pages", 0) or 0)
    shards: list[Shard] = []

    if total_pages > 0:
        # 真页数 · 节点端不需算
        if total_pages < max_shards:
            max_shards = total_pages
        base, extra = divmod(total_pages, max_shards)
        page = 0
        for i in range(max_shards):
            count = base + (1 if i < extra else 0)
            shards.append(_mk(workload, spec, i, max_shards,
                              page_start=page, page_end=page + count, total_pages=total_pages))
            page += count
    else:
        # 用百分比 · 节点端再算实际页
        for i in range(max_shards):
            shards.append(_mk(workload, spec, i, max_shards,
                              page_pct_start=i / max_shards,
                              page_pct_end=(i + 1) / max_shards))
    return shards


def _mk(workload, spec, i: int, total: int, **slice_extra) -> Shard:
    refs = list(spec.input_refs or ([spec.input_ref] if spec.input_ref else []))
    return Shard(
        workload_id=workload.id,
        index=i,
        total=total,
        status=ShardStatus.PENDING,
        input_ref=spec.input_ref,  # 每片都拿同一个 PDF (节点按 slice_meta 处理自己的页)
        metadata={
            "slice_strategy": "pages_chunked",
            "workload_name": workload.name,
            "input_kind": spec.input_kind or "single_file",
            "inline_input": spec.inline_input,
            "params": dict(spec.params or {}),
            "input_refs": refs,
            "input_manifest": {
                "schema": "input_manifest.v1",
                "semantics": "single_item",
                "entries": [
                    {"name": (spec.params or {}).get("input_name") or f"input-{j}", "ref": r}
                    for j, r in enumerate(refs)
                ],
            },
            # New page_start/page_end payloads are explicitly 0-based and
            # right-open. Historical payloads without this marker remain
            # interpreted as 1-based closed intervals by executors.
            "slice_meta": {"page_index_base": 0, **slice_extra},
        },
    )
