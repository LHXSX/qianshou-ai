"""
duration_chunked slicer · 视频/音频按时长切片

适用:
  - video_compress / audio_transcode / whisper_transcribe

设计:
  跟 pages_chunked 同思路 · planner 不下载视频 · 用百分比切
  shard.slice_meta = {start_pct: 0.0, end_pct: 0.25}
  节点端 ffprobe 拿 duration · 算实际 (start_s, end_s) 给 ffmpeg -ss / -t

  如果用户在 params 传 total_duration_s · slicer 直接算秒数 (更精确)
"""
from __future__ import annotations

from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine.task_registry import get_spec


def slice_duration_chunked(workload: Workload, n_workers: int) -> list[Shard]:
    spec = workload.spec
    task_meta = get_spec(spec.task_type)
    max_shards = max(1, min(
        spec.max_shards,
        task_meta.max_shards_limit,
        n_workers,
    ))

    total_duration_s = float(spec.params.get("total_duration_s", 0) or 0)
    shards: list[Shard] = []

    if total_duration_s > 0:
        # 真时长 · 节点端不需算
        chunk_s = total_duration_s / max_shards
        for i in range(max_shards):
            start_s = round(i * chunk_s, 3)
            end_s = round((i + 1) * chunk_s, 3) if i < max_shards - 1 else total_duration_s
            shards.append(_mk(workload, spec, i, max_shards,
                              start_s=start_s, end_s=end_s,
                              total_duration_s=total_duration_s))
    else:
        # 用百分比 · 节点端 ffprobe 再算
        for i in range(max_shards):
            shards.append(_mk(workload, spec, i, max_shards,
                              start_pct=i / max_shards,
                              end_pct=(i + 1) / max_shards))
    return shards


def _mk(workload, spec, i: int, total: int, **slice_extra) -> Shard:
    return Shard(
        workload_id=workload.id,
        index=i,
        total=total,
        status=ShardStatus.PENDING,
        input_ref=spec.input_ref,
        metadata={
            "slice_strategy": "duration_chunked",
            "workload_name": workload.name,
            "input_kind": spec.input_kind or "single_file",
            "inline_input": spec.inline_input,
            "params": dict(spec.params or {}),
            "slice_meta": slice_extra,
        },
    )
