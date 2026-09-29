"""
files_pages_chunked · multi_file PDF：先保证每文件至少一片，再按页（或百分比）切开。

适用:
  - pdf_to_text / pdf_ocr（registry.slicer = pages_chunked + input_kind=multi_file）

策略:
  1. 文件数 > 可用片数 → 退回 files_chunked（只能按文件装箱，无法再按页）
  2. 否则：按体积（params.input_sizes）或均分，把片槽分给各文件（每文件 ≥1）
  3. 若 params.file_page_counts[i] 已知 → 按真页数切；否则用 page_pct_* 百分比
  4. 每片只携带 1 个 input_ref + slice_meta 页范围，节点脚本复用既有 _apply_slice_meta
"""
from __future__ import annotations
import logging

from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine.task_registry import get_spec
from platform_v8.engine.slicers.files_chunked import slice_files_chunked, _parse_sizes

logger = logging.getLogger(__name__)


def _allocate_slots(n_files: int, n_slots: int, weights: list[int] | None) -> list[int]:
    """把 n_slots 分给 n_files，每文件至少 1；余量按权重（最大余数法）或轮询。"""
    if n_slots < n_files:
        raise ValueError("n_slots < n_files")
    slots = [1] * n_files
    remain = n_slots - n_files
    if remain <= 0:
        return slots
    if weights and len(weights) == n_files and sum(weights) > 0:
        total_w = float(sum(weights))
        raw = [remain * (w / total_w) for w in weights]
        extra = [int(x) for x in raw]
        used = sum(extra)
        # 按小数部分从大到小补齐
        frac_order = sorted(
            range(n_files),
            key=lambda i: (raw[i] - extra[i], weights[i], -i),
            reverse=True,
        )
        for i in frac_order:
            if used >= remain:
                break
            extra[i] += 1
            used += 1
        for i, e in enumerate(extra):
            slots[i] += e
        return slots
    for i in range(remain):
        slots[i % n_files] += 1
    return slots


def _parse_file_page_counts(files: list[str], params: dict) -> list[int] | None:
    raw = params.get("file_page_counts")
    if not isinstance(raw, list) or len(raw) != len(files):
        return None
    try:
        counts = [max(0, int(v)) for v in raw]
    except (TypeError, ValueError):
        return None
    if any(c <= 0 for c in counts):
        return None
    return counts


def _page_shards_for_file(
    *,
    workload: Workload,
    spec,
    params: dict,
    file_ref: str,
    file_index: int,
    total_files: int,
    n_page_shards: int,
    total_pages: int | None,
    shard_index_start: int,
    shard_total: int,
) -> list[Shard]:
    """为一个文件生成 n_page_shards 个页切片（真页数或百分比）。"""
    k = max(1, n_page_shards)
    if total_pages and total_pages > 0:
        k = min(k, total_pages)
        base, extra = divmod(total_pages, k)
        page = 0
        out: list[Shard] = []
        for i in range(k):
            count = base + (1 if i < extra else 0)
            out.append(_mk(
                workload, spec, params,
                index=shard_index_start + i,
                total=shard_total,
                file_ref=file_ref,
                file_index=file_index,
                total_files=total_files,
                page_start=page,
                page_end=page + count,
                total_pages=total_pages,
            ))
            page += count
        return out

    out = []
    for i in range(k):
        out.append(_mk(
            workload, spec, params,
            index=shard_index_start + i,
            total=shard_total,
            file_ref=file_ref,
            file_index=file_index,
            total_files=total_files,
            page_pct_start=i / k,
            page_pct_end=(i + 1) / k,
        ))
    return out


def _mk(
    workload,
    spec,
    params: dict,
    *,
    index: int,
    total: int,
    file_ref: str,
    file_index: int,
    total_files: int,
    **slice_extra,
) -> Shard:
    return Shard(
        workload_id=workload.id,
        index=index,
        total=total,
        status=ShardStatus.PENDING,
        input_ref="",
        metadata={
            "slice_strategy": "files_pages_chunked",
            "workload_name": workload.name,
            "input_kind": "multi_file",
            "input_refs": [file_ref],
            "files_in_shard": 1,
            "total_files": total_files,
            "file_index": file_index,
            "params": params,
            # 与 pages_chunked 一致：0-index / 右开区间
            "slice_meta": {"page_index_base": 0, **slice_extra},
        },
    )


def slice_files_pages_chunked(workload: Workload, n_workers: int) -> list[Shard]:
    spec = workload.spec
    files = list(spec.input_refs or [])
    if not files and spec.input_ref:
        files = [spec.input_ref]
    if not files:
        from platform_v8.engine.slicers.single import slice_single
        return slice_single(workload, n_workers)

    task_meta = get_spec(spec.task_type)
    max_shards = max(1, min(
        spec.max_shards,
        task_meta.max_shards_limit,
        n_workers,
    ))
    params = dict(spec.params or {})

    # 文件比片槽还多：无法「每文件至少 1 片后再按页」，退回按文件装箱。
    if len(files) > max_shards:
        logger.info(
            "files_pages_chunked: workload=%s files=%d > slots=%d · 退回 files_chunked",
            workload.id, len(files), max_shards,
        )
        return slice_files_chunked(workload, n_workers)

    sizes = _parse_sizes(files, params)
    page_counts = _parse_file_page_counts(files, params)
    slots_per_file = _allocate_slots(len(files), max_shards, sizes)

    # 真页数已知时，单文件片数不能超过页数；收回的槽分给还能扩的文件。
    if page_counts is not None:
        for i, pages in enumerate(page_counts):
            if slots_per_file[i] > pages:
                slots_per_file[i] = pages
        spare = max_shards - sum(slots_per_file)
        while spare > 0:
            expanded = False
            order = sorted(
                range(len(files)),
                key=lambda i: (
                    -(sizes[i] if sizes else 1),
                    -page_counts[i],
                    i,
                ),
            )
            for i in order:
                if spare <= 0:
                    break
                if slots_per_file[i] < page_counts[i]:
                    slots_per_file[i] += 1
                    spare -= 1
                    expanded = True
            if not expanded:
                break

    # 先算最终片数（页数裁剪后可能 < max_shards）
    planned: list[tuple[int, int, int | None]] = []  # (file_idx, n_shards, pages|None)
    for i, n in enumerate(slots_per_file):
        pages = page_counts[i] if page_counts is not None else None
        k = max(1, n)
        if pages and pages > 0:
            k = min(k, pages)
        planned.append((i, k, pages))
    shard_total = sum(k for _, k, _ in planned)

    shards: list[Shard] = []
    cursor = 0
    for file_index, n_page_shards, pages in planned:
        part = _page_shards_for_file(
            workload=workload,
            spec=spec,
            params=params,
            file_ref=files[file_index],
            file_index=file_index,
            total_files=len(files),
            n_page_shards=n_page_shards,
            total_pages=pages,
            shard_index_start=cursor,
            shard_total=shard_total,
        )
        shards.extend(part)
        cursor += len(part)

    logger.info(
        "files_pages_chunked: workload=%s · %d files → %d shards · slots=%s pages=%s",
        workload.id, len(files), len(shards), slots_per_file, page_counts,
    )
    return shards
