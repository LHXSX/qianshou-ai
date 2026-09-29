"""
frames_chunked slicer · 把帧区间 [frame_start, frame_end] 均分给 N 个 worker

适用:
  - blender_render · 渲染农场核心场景:N 个节点各渲一段连续帧,聚合成整段

行为:
  spec.params = {"frame_start": 1, "frame_end": 100, "engine": "CYCLES"} · n_workers=4
  → shard0.params = {..., "frame_start": 1,  "frame_end": 25}
  → shard1.params = {..., "frame_start": 26, "frame_end": 50}
  → shard2.params = {..., "frame_start": 51, "frame_end": 75}
  → shard3.params = {..., "frame_start": 76, "frame_end": 100}
  .blend 场景输入 (inline_input 的 blend_b64 或 input_ref 的 URL) 原样复制到每片
  (帧渲染本质:每个节点都要完整场景 · 只渲自己那段帧)
  blender_render.py 优先读 EC_PARAMS 的 frame_start/frame_end (本切片器写入) · 覆盖 stdin 内嵌值
  aggregator(frames_to_video) 按 frame 序号合并各片产物

帧区间来源 (按优先级):
  1. spec.params.frame_start / frame_end
  2. 解析 inline_input JSON 里的 params.frame_start / frame_end
  缺失 → fallback single (无法拆 · 1 片渲全部)
"""
from __future__ import annotations
import json
import logging

from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine.task_registry import get_spec

logger = logging.getLogger(__name__)


def _resolve_frame_range(spec) -> tuple[int | None, int | None]:
    params = spec.params or {}
    fs = params.get("frame_start")
    fe = params.get("frame_end")
    if fs is not None and fe is not None:
        try:
            return int(fs), int(fe)
        except (TypeError, ValueError):
            pass
    # 退而解析 inline_input JSON (节点把帧范围塞在 stdin payload 里)
    raw = spec.inline_input
    if raw and isinstance(raw, str):
        stripped = raw.lstrip()
        if stripped.startswith("{"):
            try:
                obj = json.loads(raw)
                p = obj.get("params", {}) or {}
                fs2, fe2 = p.get("frame_start"), p.get("frame_end")
                if fs2 is not None and fe2 is not None:
                    return int(fs2), int(fe2)
            except Exception:
                pass
    return None, None


def slice_frames_chunked(workload: Workload, n_workers: int) -> list[Shard]:
    spec = workload.spec
    fs, fe = _resolve_frame_range(spec)

    if fs is None or fe is None or fe < fs:
        logger.info("frames_chunked: workload=%s 无有效帧区间 (frame_start/frame_end) · fallback single",
                    workload.id)
        from .single import slice_single
        return slice_single(workload, n_workers)

    total_frames = fe - fs + 1
    task_meta = get_spec(spec.task_type)
    max_shards = max(1, min(
        spec.max_shards,
        task_meta.max_shards_limit,
        n_workers,
        total_frames,
    ))
    if max_shards <= 1:
        from .single import slice_single
        return slice_single(workload, n_workers)

    base_params = dict(spec.params or {})
    base, extra = divmod(total_frames, max_shards)

    shards: list[Shard] = []
    cursor = fs
    for i in range(max_shards):
        count = base + (1 if i < extra else 0)
        if count == 0:
            continue
        shard_fs = cursor
        shard_fe = cursor + count - 1
        shard_params = dict(base_params)
        shard_params["frame_start"] = shard_fs
        shard_params["frame_end"] = shard_fe
        sh = Shard(
            workload_id=workload.id,
            index=i,
            total=max_shards,
            status=ShardStatus.PENDING,
            input_ref=spec.input_ref or "",  # 整 .blend URL 复制到每片
            metadata={
                "slice_strategy": "frames_chunked",
                "workload_name": workload.name,
                "input_kind": spec.input_kind or "single_file",
                "inline_input": spec.inline_input,  # blend_b64 整场景复制到每片
                "input_refs": list(spec.input_refs) if spec.input_refs else [],
                "slice_meta": {
                    "frame_start": shard_fs,
                    "frame_end": shard_fe,
                    "frames_in_shard": count,
                    "total_frames": total_frames,
                    "global_frame_start": fs,
                    "global_frame_end": fe,
                },
                "params": shard_params,
            },
        )
        cursor += count
        shards.append(sh)

    logger.info("frames_chunked: workload=%s · 帧 [%d,%d] (%d 帧) → %d 片",
                workload.id, fs, fe, total_frames, len(shards))
    return shards
