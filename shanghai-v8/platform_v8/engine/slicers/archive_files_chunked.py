"""
archive_files_chunked slicer · 压缩包按文件数百分比切片

适用:
  - image_resize / image_compress 等批量任务 · 用户传 zip 上传 (而不是多个单文件)
  - pdf_ocr (用户传 PDF zip 多文件)
  - video_info / video_thumbnail / video_compress (archive)

设计 (chicken-egg 解法):
  planner 不下载 zip · 不知道里面有多少文件 → 用 "文件序号百分比" 切
    shard.slice_meta = {file_idx_pct_start: 0.0, file_idx_pct_end: 0.33}
  节点端下载 zip · 解压 · 看实际文件数 N · 算自己处理哪段

  如果用户在 params 里给了 total_files · slicer 用真实文件数切 (更精确)
  若同时给了 input_sizes (与序号对齐的字节列表) · 按体积装箱分配序号区间
"""
from __future__ import annotations

from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine.task_registry import get_spec
from platform_v8.engine.slicers.files_chunked import pack_by_size


def slice_archive_files_chunked(workload: Workload, n_workers: int) -> list[Shard]:
    spec = workload.spec
    task_meta = get_spec(spec.task_type)
    max_shards = max(1, min(
        spec.max_shards,
        task_meta.max_shards_limit,
        n_workers,
    ))

    # 真实文件数 (前端 jszip 分析后传 params.total_files · 没传就用百分比)
    total_files = int(spec.params.get("total_files", 0) or 0)
    params = dict(spec.params or {})
    shards: list[Shard] = []

    if total_files > 0:
        if total_files < max_shards:
            max_shards = total_files

        sizes_raw = params.get("input_sizes")
        sizes: list[int] | None = None
        if isinstance(sizes_raw, list) and len(sizes_raw) == total_files:
            try:
                sizes = [max(0, int(v)) for v in sizes_raw]
            except (TypeError, ValueError):
                sizes = None
            if sizes is not None and all(s == 0 for s in sizes):
                sizes = None

        if sizes is not None and max_shards > 1:
            # 用虚拟路径索引做体积装箱，再映射回连续序号区间可能不连续
            # → 每片存 file_indices 列表；脚本优先认 file_indices，否则 file_idx_start/end
            virtual = [str(i) for i in range(total_files)]
            buckets = pack_by_size(virtual, sizes, max_shards)
            for i, bucket in enumerate(buckets):
                indices = sorted(int(item[0]) for item in bucket)
                bytes_in_shard = sum(item[1] for item in bucket)
                # 若 indices 连续，同时写 start/end 方便旧脚本
                contiguous = (
                    indices
                    and indices[-1] - indices[0] + 1 == len(indices)
                    and indices == list(range(indices[0], indices[-1] + 1))
                )
                extra: dict = {
                    "total_files": total_files,
                    "file_indices": indices,
                    "bytes_in_shard": bytes_in_shard,
                }
                if contiguous:
                    extra["file_idx_start"] = indices[0]
                    extra["file_idx_end"] = indices[-1] + 1
                shards.append(_mk(workload, spec, i, len(buckets), **extra))
            return shards

        # 按序号均分
        base, extra = divmod(total_files, max_shards)
        cursor = 0
        for i in range(max_shards):
            count = base + (1 if i < extra else 0)
            shards.append(_mk(workload, spec, i, max_shards,
                              file_idx_start=cursor, file_idx_end=cursor + count,
                              total_files=total_files))
            cursor += count
    else:
        # 用百分比 · 节点端再算
        for i in range(max_shards):
            shards.append(_mk(workload, spec, i, max_shards,
                              file_idx_pct_start=i / max_shards,
                              file_idx_pct_end=(i + 1) / max_shards))
    return shards


def _mk(workload, spec, i: int, total: int, **slice_extra) -> Shard:
    return Shard(
        workload_id=workload.id,
        index=i,
        total=total,
        status=ShardStatus.PENDING,
        input_ref=spec.input_ref,  # 每片下同一 zip URL (MVP)
        metadata={
            "slice_strategy": "archive_files_chunked",
            "workload_name": workload.name,
            "input_kind": "archive",
            "inline_input": spec.inline_input,
            "params": dict(spec.params or {}),
            "slice_meta": slice_extra,
        },
    )
