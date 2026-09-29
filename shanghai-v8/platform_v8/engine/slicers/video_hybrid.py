"""
video_hybrid slicer · 视频压缩的多文件 / 时长混合切片

规则 (计划 1C):
  - 1 个视频 → duration_chunked (按时长百分比或秒数切)
  - N 个视频 → 先按体积装箱；「超大」个体再拆成时长段
  - 超大判定: size > max(总大小 * 0.4, 80MB)

每片 metadata 带 source_ref / source_index，供聚合器按源拼接。
"""
from __future__ import annotations
import logging

from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine.task_registry import get_spec
from platform_v8.engine.slicers.files_chunked import pack_by_size, _parse_sizes
from platform_v8.engine.slicers.duration_chunked import slice_duration_chunked

logger = logging.getLogger(__name__)

_OVERSIZE_FLOOR_BYTES = 80 * 1024 * 1024  # 80MB


def _is_oversized(size: int, total_bytes: int) -> bool:
    if size <= 0:
        return False
    threshold = max(int(total_bytes * 0.4), _OVERSIZE_FLOOR_BYTES)
    return size > threshold


def _duration_parts_for_source(
    workload: Workload,
    source_ref: str,
    source_index: int,
    n_parts: int,
    *,
    total_duration_s: float = 0.0,
) -> list[Shard]:
    """为单个源视频生成 n_parts 个时长分片。"""
    n_parts = max(1, n_parts)
    params = dict(workload.spec.params or {})
    shards: list[Shard] = []
    if total_duration_s > 0:
        chunk_s = total_duration_s / n_parts
        for i in range(n_parts):
            start_s = round(i * chunk_s, 3)
            end_s = (
                round((i + 1) * chunk_s, 3)
                if i < n_parts - 1
                else total_duration_s
            )
            slice_meta = {
                "start_s": start_s,
                "end_s": end_s,
                "start_sec": start_s,
                "end_sec": end_s,
                "total_duration_s": total_duration_s,
                "source_ref": source_ref,
                "source_index": source_index,
                "part_index": i,
                "part_total": n_parts,
            }
            shards.append(_mk_duration(workload, source_ref, i, n_parts, params, slice_meta))
    else:
        for i in range(n_parts):
            slice_meta = {
                "start_pct": i / n_parts,
                "end_pct": (i + 1) / n_parts,
                "source_ref": source_ref,
                "source_index": source_index,
                "part_index": i,
                "part_total": n_parts,
            }
            shards.append(_mk_duration(workload, source_ref, i, n_parts, params, slice_meta))
    return shards


def _mk_duration(
    workload: Workload,
    source_ref: str,
    part_index: int,
    part_total: int,
    params: dict,
    slice_meta: dict,
) -> Shard:
    return Shard(
        workload_id=workload.id,
        index=part_index,  # 临时 · 外层会重编号
        total=part_total,
        status=ShardStatus.PENDING,
        input_ref=source_ref,
        metadata={
            "slice_strategy": "duration_chunked",
            "workload_name": workload.name,
            "input_kind": "single_file",
            "inline_input": workload.spec.inline_input,
            "params": params,
            "slice_meta": slice_meta,
            "source_ref": source_ref,
            "source_index": slice_meta.get("source_index", 0),
        },
    )


def _mk_whole_file(
    workload: Workload,
    files: list[str],
    sizes: list[int] | None,
    index: int,
    params: dict,
) -> Shard:
    bytes_in_shard = sum(sizes) if sizes else 0
    return Shard(
        workload_id=workload.id,
        index=index,
        total=1,  # 临时
        status=ShardStatus.PENDING,
        input_ref="",
        metadata={
            "slice_strategy": "files_chunked",
            "workload_name": workload.name,
            "input_kind": "multi_file",
            "input_refs": list(files),
            "files_in_shard": len(files),
            "bytes_in_shard": bytes_in_shard,
            "params": params,
            "source_refs": list(files),
        },
    )


def _renumber(shards: list[Shard]) -> list[Shard]:
    total = len(shards)
    for i, sh in enumerate(shards):
        sh.index = i
        sh.total = total
    return shards


def slice_video_hybrid(workload: Workload, n_workers: int) -> list[Shard]:
    spec = workload.spec
    task_meta = get_spec(spec.task_type)
    params = dict(spec.params or {})
    input_kind = (spec.input_kind or "single_file").strip()

    # archive：沿用 archive_files_chunked（含体积装箱区间）
    if input_kind == "archive":
        from platform_v8.engine.slicers.archive_files_chunked import slice_archive_files_chunked
        return slice_archive_files_chunked(workload, n_workers)

    files = list(spec.input_refs or [])
    if not files and spec.input_ref:
        files = [spec.input_ref]

    max_shards = max(1, min(
        spec.max_shards,
        task_meta.max_shards_limit,
        n_workers,
    ))

    # 单文件 → 纯时长切
    if len(files) <= 1:
        shards = slice_duration_chunked(workload, n_workers)
        source = files[0] if files else (spec.input_ref or "")
        for sh in shards:
            meta = dict(sh.metadata or {})
            slice_meta = dict(meta.get("slice_meta") or {})
            slice_meta.setdefault("source_ref", source)
            slice_meta.setdefault("source_index", 0)
            meta["slice_meta"] = slice_meta
            meta["source_ref"] = source
            meta["source_index"] = 0
            sh.metadata = meta
            if source and not sh.input_ref:
                sh.input_ref = source
        return shards

    sizes = _parse_sizes(files, params)
    if sizes is None:
        sizes = [0] * len(files)
    total_bytes = sum(sizes) or 1

    # 先识别超大文件，预留时长片额度
    oversized = [
        (idx, ref, sizes[idx])
        for idx, ref in enumerate(files)
        if _is_oversized(sizes[idx], total_bytes)
    ]
    normal = [
        (idx, ref, sizes[idx])
        for idx, ref in enumerate(files)
        if not _is_oversized(sizes[idx], total_bytes)
    ]

    # 超大文件各至少占 2 片（若额度允许），其余额度给体积装箱
    remaining = max_shards
    duration_plan: list[tuple[int, str, int]] = []  # source_index, ref, n_parts
    if oversized and remaining >= 2:
        # 把额度大致均分给超大文件，每个至少 2、至多 remaining
        per = max(2, remaining // max(1, len(oversized) + (1 if normal else 0)))
        for source_index, ref, _size in oversized:
            n_parts = min(per, remaining)
            if n_parts < 2 and remaining >= 2:
                n_parts = 2
            n_parts = max(1, min(n_parts, remaining))
            duration_plan.append((source_index, ref, n_parts))
            remaining -= n_parts
            if remaining <= 0:
                break
    elif oversized and remaining == 1:
        # 额度不够拆时长 · 当整文件处理
        for source_index, ref, size in oversized:
            normal.append((source_index, ref, size))
        oversized = []

    out: list[Shard] = []
    total_duration_s = float(params.get("total_duration_s", 0) or 0)

    for source_index, ref, n_parts in duration_plan:
        # 仅单源且 params 带总时长时才用绝对秒；多源超大一律百分比
        use_dur = total_duration_s if len(files) == 1 else 0.0
        parts = _duration_parts_for_source(
            workload, ref, source_index, n_parts, total_duration_s=use_dur,
        )
        out.extend(parts)

    if normal and remaining > 0:
        normal_files = [ref for _, ref, _ in normal]
        normal_sizes = [size for _, _, size in normal]
        pack_n = min(remaining, len(normal_files))
        if pack_n <= 0:
            pack_n = 1
        if any(normal_sizes) and pack_n > 1:
            buckets = pack_by_size(normal_files, normal_sizes, pack_n)
        else:
            # 个数均分
            base, extra = divmod(len(normal_files), pack_n)
            buckets = []
            cursor = 0
            for i in range(pack_n):
                count = base + (1 if i < extra else 0)
                chunk = normal_files[cursor:cursor + count]
                chunk_sizes = normal_sizes[cursor:cursor + count]
                cursor += count
                buckets.append(list(zip(chunk, chunk_sizes)))
        for bucket in buckets:
            refs = [item[0] for item in bucket]
            sz = [item[1] for item in bucket]
            out.append(_mk_whole_file(workload, refs, sz, 0, params))
    elif normal and remaining <= 0:
        # 时长片占满额度 · 普通文件合并进最后一片或追加（允许略超 max_shards）
        refs = [ref for _, ref, _ in normal]
        sz = [size for _, _, size in normal]
        out.append(_mk_whole_file(workload, refs, sz, 0, params))

    if not out:
        return slice_duration_chunked(workload, n_workers)

    shards = _renumber(out)
    logger.info(
        "video_hybrid: workload=%s · files=%d oversized=%d → %d shards",
        workload.id, len(files), len(duration_plan), len(shards),
    )
    return shards
