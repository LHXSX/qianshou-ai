"""
samples_chunked slicer · 把"样本数/迭代数"类参数均分给 N 个 worker

适用:
  - monte_carlo (params.samples) · 蒙特卡洛模拟 · 每片跑 samples/N 次 + 独立 seed
  - 任何带可拆分样本计数参数的计算任务

行为:
  spec.params = {"samples": 1_000_000, "seed": 42} · n_workers=4 · max_shards=4
  → shard0.params = {"samples": 250000, "seed": 42}
  → shard1.params = {"samples": 250000, "seed": 43}
  → shard2.params = {"samples": 250000, "seed": 44}
  → shard3.params = {"samples": 250000, "seed": 45}
  每片用不同 seed → 独立随机序列 (不重复采样) · aggregator(numeric_sum) 把各片
  summary 数值字段累加 (samples 累加 = 原总数 · hits/result 等可还原)

边界:
  - 没有可拆分的样本数参数 (如 pi_compute 用 digits 走确定性 Chudnovsky · 不可采样并行)
    → fallback single (1 片跑全量)
  - 样本数 < 2 或 max_shards<=1 → fallback single
"""
from __future__ import annotations
import logging

from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine.task_registry import get_spec

logger = logging.getLogger(__name__)

# 可拆分的"样本/迭代数"参数名 (按优先级) · 命中即按它切
_SAMPLE_KEYS = ("samples", "num_samples", "n", "iterations", "sims", "trials", "rounds")


def slice_samples_chunked(workload: Workload, n_workers: int) -> list[Shard]:
    spec = workload.spec
    params = dict(spec.params or {})

    # 找一个整数型样本计数参数
    sample_key = None
    for k in _SAMPLE_KEYS:
        v = params.get(k)
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)) and int(v) > 0:
            sample_key = k
            break

    if sample_key is None:
        logger.info("samples_chunked: workload=%s 无可拆分样本数参数 (%s) · fallback single",
                    workload.id, list(_SAMPLE_KEYS))
        from .single import slice_single
        return slice_single(workload, n_workers)

    total_samples = int(params[sample_key])
    task_meta = get_spec(spec.task_type)
    max_shards = max(1, min(
        spec.max_shards,
        task_meta.max_shards_limit,
        n_workers,
        total_samples,
    ))
    if max_shards <= 1:
        from .single import slice_single
        return slice_single(workload, n_workers)

    base_seed = int(params.get("seed", 42)) if isinstance(params.get("seed", 42), (int, float)) else 42
    base, extra = divmod(total_samples, max_shards)

    shards: list[Shard] = []
    for i in range(max_shards):
        count = base + (1 if i < extra else 0)
        if count == 0:
            continue
        shard_params = dict(params)
        shard_params[sample_key] = count
        shard_params["seed"] = base_seed + i  # 每片独立随机序列 · 防重复采样
        sh = Shard(
            workload_id=workload.id,
            index=i,
            total=max_shards,
            status=ShardStatus.PENDING,
            input_ref=spec.input_ref or "",
            metadata={
                "slice_strategy": "samples_chunked",
                "workload_name": workload.name,
                "input_kind": spec.input_kind or "params_only",
                "inline_input": spec.inline_input,
                "input_refs": list(spec.input_refs) if spec.input_refs else [],
                "slice_meta": {
                    "sample_key": sample_key,
                    "shard_samples": count,
                    "total_samples": total_samples,
                    "seed": base_seed + i,
                },
                "params": shard_params,
            },
        )
        shards.append(sh)

    logger.info("samples_chunked: workload=%s · %s=%d → %d 片",
                workload.id, sample_key, total_samples, len(shards))
    return shards
