"""
files_chunked slicer · 把 multi_file 列表均分给 N 个 worker

适用:
  - image_resize / image_compress / image_thumbnail (批量图)
  - ocr_image (批量 OCR)
  - onnx_infer (批量推理)
  - video_info / video_thumbnail (批量视频 · 可按体积装箱)

行为:
  spec.input_refs = [url1, url2, url3, url4, url5]  · n_workers=2 · max_shards=3
  → 实际切 min(N文件, n_workers, max_shards) = min(5, 2, 3) = 2 片

  若 params.input_sizes 与 input_refs 对齐:
  → 按体积降序 + 贪心装箱，使各片总字节尽量接近
  否则按个数均分
"""
from __future__ import annotations
import logging

from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine.slicers.input_names import resolve_entry_name
from platform_v8.engine.task_registry import get_spec

logger = logging.getLogger(__name__)

def _input_entries(files: list[str], params: dict, selected: list[str]) -> list[dict]:
    """Project trusted input_batch entries into this shard, preserving identity."""
    indexed = {
        str(item.get("object_key") or ""): dict(item)
        for item in (params.get("input_batch") or {}).get("entries", [])
        if isinstance(item, dict)
    }
    result: list[dict] = []
    used_names: set[str] = set()
    for fallback_index, ref in enumerate(selected):
        entry = indexed.get(str(ref), {})
        src_index = int(entry.get("index", files.index(ref)))
        result.append({
            "id": str(entry.get("id") or f"file:{files.index(ref)}"),
            "source_index": src_index,
            "name": resolve_entry_name(
                ref, entry, index=src_index, params=params, used=used_names,
            ),
            "object_key": str(entry.get("object_key") or ref),
            "size_bytes": int(entry.get("size_bytes") or 0),
            "sha256": str(entry.get("sha256") or ""),
            "content_type": str(entry.get("content_type") or "application/octet-stream"),
            "fetch_ref": "",
            "selector": {},
        })
    return result


def _parse_sizes(files: list[str], params: dict) -> list[int] | None:
    raw = params.get("input_sizes")
    if not isinstance(raw, list) or len(raw) != len(files):
        return None
    try:
        sizes = [max(0, int(v)) for v in raw]
    except (TypeError, ValueError):
        return None
    if all(s == 0 for s in sizes):
        return None
    return sizes


def pack_by_size(
    files: list[str],
    sizes: list[int],
    max_shards: int,
    *,
    max_files_per_shard: int = 0,
) -> list[list[tuple[str, int]]]:
    """体积降序 + 贪心装箱，同时遵守每片文件数硬上限。"""
    indexed = sorted(
        zip(files, sizes),
        key=lambda item: item[1],
        reverse=True,
    )
    buckets: list[list[tuple[str, int]]] = [[] for _ in range(max_shards)]
    loads = [0] * max_shards
    for file_ref, size in indexed:
        candidates = [
            i for i in range(max_shards)
            if max_files_per_shard <= 0 or len(buckets[i]) < max_files_per_shard
        ]
        if not candidates:
            from platform_v8.engine.task_registry import ShardCapacityError

            raise ShardCapacityError("files_chunked 没有可容纳剩余文件的分片")
        target = min(candidates, key=lambda i: (loads[i], i))
        buckets[target].append((file_ref, size))
        loads[target] += size
    # 去掉空桶并保持稳定顺序（按首次装入的大文件顺序）
    return [b for b in buckets if b]


def slice_files_chunked(workload: Workload, n_workers: int) -> list[Shard]:
    spec = workload.spec
    files = list(spec.input_refs or [])

    # 兼容: 用户传 single_file (只 1 个 input_ref) · 也允许 · 但只切 1 片
    if not files and spec.input_ref:
        files = [spec.input_ref]

    if not files:
        logger.warning("files_chunked: workload=%s 没有 input_refs · 退化 single",
                       workload.id)
        from .single import slice_single
        return slice_single(workload, n_workers)

    task_meta = get_spec(spec.task_type)
    configured_shards = max(1, min(
        int(spec.max_shards or 1),
        int(task_meta.max_shards_limit or 1),
        len(files),
    ))
    from platform_v8.engine.task_registry import validate_file_shard_capacity

    required_shards = validate_file_shard_capacity(
        task_meta,
        len(files),
        configured_shards,
    )
    per_shard_limit = max(0, int(task_meta.max_files_per_shard or 0))
    if per_shard_limit:
        # 容量合同优先于在线并发：不够的 worker 让多余分片 PENDING，绝不把两文件塞进一片。
        # 也禁止把「必须同片处理」的任务（如 text_diff 恰好 2 文件）拆成多片。
        max_shards = max(
            required_shards,
            min(configured_shards, len(files)),
        )
        max_shards = min(
            max_shards,
            int(task_meta.max_shards_limit or max_shards),
            len(files),
        )
    else:
        # 单节点也能排队：不要把 N 个文件压成 1 片（否则多文件产物只剩 1 路）。
        max_shards = max(1, min(configured_shards, len(files)))
    capacity_queued = bool(per_shard_limit and n_workers < required_shards)
    if capacity_queued:
        logger.info(
            "files_chunked: workload=%s · 需要 %d 片但在线 worker=%d · 超出并发的分片保持 PENDING",
            workload.id,
            required_shards,
            n_workers,
        )

    params = dict(spec.params or {})
    sizes = _parse_sizes(files, params)
    shards: list[Shard] = []

    if sizes is not None and max_shards > 1:
        buckets = pack_by_size(
            files,
            sizes,
            max_shards,
            max_files_per_shard=per_shard_limit,
        )
        for i, bucket in enumerate(buckets):
            chunk = [item[0] for item in bucket]
            bytes_in_shard = sum(item[1] for item in bucket)
            shards.append(Shard(
                workload_id=workload.id,
                index=i,
                total=len(buckets),
                status=ShardStatus.PENDING,
                input_ref="",
                metadata={
                    "slice_strategy": "files_chunked",
                    "workload_name": workload.name,
                    "input_kind": "multi_file",
                    "input_refs": chunk,
                    "input_manifest": {
                        "schema": "input_manifest.v1",
                        "semantics": task_meta.batch_semantics,
                        "total_entries": len(files),
                        "entries": _input_entries(files, params, chunk),
                    },
                    "files_in_shard": len(chunk),
                    "bytes_in_shard": bytes_in_shard,
                    "total_files": len(files),
                    "capacity_queued": capacity_queued,
                    "queue_reason": (
                        "等待可用 worker，保持每片文件数合同"
                        if capacity_queued else ""
                    ),
                    "params": params,
                },
            ))
        logger.info(
            "files_chunked: workload=%s · size-balanced %d files → %d shards · loads=%s",
            workload.id,
            len(files),
            len(shards),
            [sh.metadata.get("bytes_in_shard") for sh in shards],
        )
        return shards

    # 按个数均分 (尽量平均 · 余数前几片多 1 个)
    base, extra = divmod(len(files), max_shards)
    cursor = 0
    for i in range(max_shards):
        count = base + (1 if i < extra else 0)
        chunk = files[cursor:cursor + count]
        cursor += count
        shards.append(Shard(
            workload_id=workload.id,
            index=i,
            total=max_shards,
            status=ShardStatus.PENDING,
            input_ref="",
            metadata={
                "slice_strategy": "files_chunked",
                "workload_name": workload.name,
                "input_kind": "multi_file",
                "input_refs": chunk,
                "input_manifest": {
                    "schema": "input_manifest.v1",
                    "semantics": task_meta.batch_semantics,
                    "total_entries": len(files),
                    "entries": _input_entries(files, params, chunk),
                },
                "files_in_shard": len(chunk),
                "total_files": len(files),
                "capacity_queued": capacity_queued,
                "queue_reason": (
                    "等待可用 worker，保持每片文件数合同"
                    if capacity_queued else ""
                ),
                "params": params,
            },
        ))
    return shards
