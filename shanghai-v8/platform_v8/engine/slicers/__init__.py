"""
Slicers · 按 task_type 把 workload 切成 N 个 shard

设计:
  - slice_workload(workload, n_workers) → list[Shard]
  - 每个 shard 包含独立的 input_ref / input_refs / inline_input + slice_meta
  - slice_meta 通过 Shard.metadata['slice_meta'] 传给节点 (节点端 args["slice_meta"])
  - input_refs 列表通过 Shard.metadata['input_refs'] 传 (Shard.input_ref str 不够)

加新 slicer:
  1. 在本目录加新文件 (e.g. samples_chunked.py)
  2. 实现 def slice(workload: Workload, n_workers: int) -> list[Shard]
  3. 在 _SLICERS 注册
  4. task_registry 给某些 task_type 用这个 slicer
"""
from __future__ import annotations
import logging
from typing import Callable

from platform_v8.core import Workload, Shard
from platform_v8.engine.task_registry import get_spec

from .single import slice_single
from .files_chunked import slice_files_chunked
from .files_pages_chunked import slice_files_pages_chunked
from .pages_chunked import slice_pages_chunked
from .duration_chunked import slice_duration_chunked
from .archive_files_chunked import slice_archive_files_chunked
from .lines_chunked import slice_lines_chunked
from .samples_chunked import slice_samples_chunked
from .frames_chunked import slice_frames_chunked
from .prompts_chunked import slice_prompts_chunked
from .video_hybrid import slice_video_hybrid
from .package_recipe import slice_package_recipe

logger = logging.getLogger(__name__)


SlicerFn = Callable[[Workload, int], list[Shard]]

_PACKAGE_TASK_TYPES = frozenset({"package_digest", "material_digest"})


_SLICERS: dict[str, SlicerFn] = {
    "single": slice_single,
    "files_chunked": slice_files_chunked,
    "files_pages_chunked": slice_files_pages_chunked,
    "pages_chunked": slice_pages_chunked,
    "duration_chunked": slice_duration_chunked,
    "archive_files_chunked": slice_archive_files_chunked,
    "lines_chunked": slice_lines_chunked,  # 2026-05-23 P0-B3 · 真实按行切
    # 2026-06-03 · 三个真实切片器上线 (此前 fallback single · 无法并行)
    "samples_chunked": slice_samples_chunked,  # monte_carlo 等:按样本数切 + 独立 seed
    "frames_chunked": slice_frames_chunked,    # blender_render:按帧区间切 (渲染农场)
    "prompts_chunked": slice_prompts_chunked,  # crawl_batch_fetch 等:按列表项切
    "video_hybrid": slice_video_hybrid,
    "package_recipe": slice_package_recipe,  # 异构混合包
}


def slice_workload(workload: Workload, n_workers: int) -> list[Shard]:
    """根据 task_registry + input_kind 选 slicer · 把 workload 切成 N 片

    优先级:
      0. package_digest / material_digest → 强制 package_recipe (异构)
      1. video_hybrid · 按自身规则处理 single/multi/archive
      2. archive input_kind → archive_files_chunked (zip 解压切片)
      3. multi_file input_kind → files_chunked (按文件均分/体积装箱)
      4. single_file · pages/duration/frames 可切 · 否则 single
      5. 否则 → task_registry.slicer (inline/params_only)
    """
    spec_meta = get_spec(workload.spec.task_type)
    input_kind = workload.spec.input_kind or "single_file"

    if workload.spec.task_type in _PACKAGE_TASK_TYPES or spec_meta.slicer == "package_recipe":
        slicer_name = "package_recipe"
    elif spec_meta.slicer == "video_hybrid":
        slicer_name = "video_hybrid"
    elif input_kind == "multi_file" and spec_meta.batch_semantics in (
        "whole_set", "exact_set",
    ):
        slicer_name = "single"
    elif input_kind == "archive":
        slicer_name = "archive_files_chunked"
    elif input_kind == "multi_file":
        slicer_name = (
            "files_pages_chunked"
            if spec_meta.slicer == "pages_chunked"
            else "files_chunked"
        )
    elif input_kind == "single_file":
        # 单文件 · 节点端按 slice_meta 处理 (pages/duration 等) · 否则 single
        slicer_name = spec_meta.slicer if spec_meta.slicer in (
            "pages_chunked", "duration_chunked", "frames_chunked",
        ) else "single"
    else:
        slicer_name = spec_meta.slicer

    slicer_fn = _SLICERS.get(slicer_name, slice_single)
    shards = slicer_fn(workload, n_workers)
    logger.info("slicer.%s · workload=%s → %d shards (workers=%d · task_type=%s · input_kind=%s)",
                slicer_name, workload.id, len(shards), n_workers,
                workload.spec.task_type, input_kind)
    return shards
