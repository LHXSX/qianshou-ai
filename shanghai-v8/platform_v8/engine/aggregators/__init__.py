"""
Aggregators · workload 全 shard DONE 时按 task_type 合并结果

设计:
  - 入口: aggregate(workload, shards) → WorkloadResult
  - 根据 task_registry.aggregator 选具体实现
  - 每个 shard 的 output_ref 是 inline JSON 字符串 (节点回报)
    或 OSS URL (节点上传大文件后给 URL)

加新 aggregator:
  1. 本目录加新文件 (e.g. my_agg.py)
  2. 实现 def aggregate(workload, shards, **ctx) -> WorkloadResult
  3. 在 _AGGREGATORS 注册
  4. task_registry 给某些 task_type 用这个 aggregator
"""
from __future__ import annotations
import logging
from typing import Callable

from platform_v8.core import Workload, Shard, WorkloadResult
from platform_v8.engine.task_registry import get_spec

from .inline_concat import aggregate_inline_concat
from .artifact_reference import aggregate_artifact_reference
from .ordered_concat import aggregate_ordered_concat
from .pdf_text_bundle import aggregate_pdf_text_bundle
from .numeric_sum import aggregate_numeric_sum
from .zip_files import aggregate_zip_files
from .manifest_only import aggregate_manifest_only
from .lines_merge import aggregate_lines_merge
from .media_concat import aggregate_ffmpeg_concat, aggregate_frames_to_video
from .video_outputs import aggregate_video_outputs
from .package_merge import aggregate_package_merge

logger = logging.getLogger(__name__)


AggregatorFn = Callable[..., WorkloadResult]


_AGGREGATORS: dict[str, AggregatorFn] = {
    "artifact_reference": aggregate_artifact_reference,
    "inline_concat": aggregate_inline_concat,
    "lines_merge": aggregate_lines_merge,
    "ordered_concat": aggregate_ordered_concat,
    "pdf_text_bundle": aggregate_pdf_text_bundle,
    "numeric_sum": aggregate_numeric_sum,
    "zip_files": aggregate_zip_files,
    "manifest_only": aggregate_manifest_only,
    # 2026-06-03 · 媒体有序合并 (此前 fallback inline_concat · 产物不可用)
    "ffmpeg_concat": aggregate_ffmpeg_concat,    # video_compress/audio_transcode 分段
    "frames_to_video": aggregate_frames_to_video,  # blender 帧序列
    "video_outputs": aggregate_video_outputs,    # 同源 concat + 多源 zip
    "package_merge": aggregate_package_merge,    # 异构混合包
}


def aggregate(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    """根据 task_registry 选 aggregator · 合并全 shard 结果 → WorkloadResult"""
    spec_meta = get_spec(workload.spec.task_type)
    agg_name = spec_meta.aggregator
    agg_fn = _AGGREGATORS.get(agg_name, aggregate_inline_concat)
    result = agg_fn(workload, shards)
    logger.info("aggregator.%s · workload=%s shards=%d task_type=%s",
                agg_name, workload.id, len(shards), workload.spec.task_type)
    return result
