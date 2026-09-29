"""
Admission-First Fair Dispatch · 权威在途负载 + 硬并发帽 + 速度亲和

不变量: ∀w: L_w ≤ C_w (C_w=5)
L_w = owner活跃 + race活跃 + 本回合预留 R_w

速度亲和: 刚完成一片的节点 (just_idle) 优先续派；近期平均耗时更短的节点
在未满帽时得分更高 → 快设备多吃、慢设备不堆，缩短整案 wall-clock。
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from typing import Any

logger = logging.getLogger(__name__)

# 全局硬并发帽（任意任务类型）
MAX_ACTIVE_SHARDS_PER_WORKER = 5

# 评分参数
_BETA_QUEUE = 2.0          # (1 - L/C)^β
_GAMMA_LOAD = 1.0          # (1 - load)^γ
_LAMBDA_RECENT = 25.0      # 与 planner recent_dispatch 同量纲
_DELTA_JUST_IDLE = 50.0    # 刚完成节点亲和
_SPEED_BONUS_MAX = 30.0    # 速度亲和上限分

# 进程内：worker 近期完成耗时 (ms) · 用于速度亲和
_RECENT_SPEED: dict[str, list[tuple[float, float]]] = {}  # wid → [(ts, elapsed_ms)]
_SPEED_WINDOW_S = 600.0
_SPEED_SAMPLES = 8


def record_completion_speed(worker_id: str, elapsed_ms: float | int | None) -> None:
    """shard DONE 时记录耗时 · 供后续派发速度亲和。"""
    if not worker_id or elapsed_ms is None:
        return
    try:
        ms = float(elapsed_ms)
    except (TypeError, ValueError):
        return
    if ms <= 0:
        return
    wid = str(worker_id)
    now = time.time()
    bucket = _RECENT_SPEED.setdefault(wid, [])
    bucket.append((now, ms))
    # purge
    _RECENT_SPEED[wid] = [
        (t, e) for t, e in bucket
        if now - t < _SPEED_WINDOW_S
    ][-_SPEED_SAMPLES:]


def avg_speed_ms(worker_id: str) -> float | None:
    wid = str(worker_id or "")
    samples = _RECENT_SPEED.get(wid) or []
    if not samples:
        return None
    return sum(e for _, e in samples) / len(samples)


def can_admit(L: int, C: int = MAX_ACTIVE_SHARDS_PER_WORKER, cost: int = 1) -> bool:
    return int(L) + int(cost) <= int(C)


def score_worker(
    w: Any,
    L: int,
    C: int = MAX_ACTIVE_SHARDS_PER_WORKER,
    *,
    just_idle: bool = False,
    power: float | None = None,
    recent_penalty_count: int = 0,
) -> float:
    """
    P = power·rep · (1-L/C)^β · (1-load)^γ − λ·recent + δ·just_idle + speed_bonus
    满载时 (1-L/C)^β = 0 → 分数归零，强制让给空闲节点。
    """
    C = max(1, int(C))
    L = max(0, int(L))
    if L >= C:
        return -1e9

    # power
    if power is None:
        try:
            from platform_v8.engine import planner as _pl
            power = float(_pl._worker_power(w))
        except Exception:
            power = 0.5
    power = max(0.05, min(1.0, float(power)))

    # rep_factor = 0.4 + 0.6*(rep/100)
    try:
        rep = float(getattr(w, "rep_main", None) or getattr(w, "reputation", None) or 60)
    except Exception:
        rep = 60.0
    rep = max(0.0, min(100.0, rep))
    rep_factor = 0.4 + 0.6 * (rep / 100.0)

    try:
        load = float(getattr(w, "load", 0) or 0)
    except Exception:
        load = 0.0
    load = max(0.0, min(1.0, load))

    queue_term = (1.0 - (L / float(C))) ** _BETA_QUEUE
    load_term = (1.0 - load) ** _GAMMA_LOAD
    score = power * rep_factor * queue_term * load_term
    score -= _LAMBDA_RECENT * max(0, int(recent_penalty_count))
    if just_idle:
        score += _DELTA_JUST_IDLE

    # 速度亲和：比池内中位更快 → 加分（未满帽时多吃）
    speed = avg_speed_ms(str(getattr(w, "id", "") or ""))
    if speed is not None and speed > 0:
        # 归一：越快加分越多；用 1/(1+speed/60s) 近似
        # 30s→较高 · 180s→较低
        speed_norm = 1.0 / (1.0 + speed / 60000.0)
        score += _SPEED_BONUS_MAX * speed_norm

    return float(score)


def assign_shards(
    shards: list,
    workers: list,
    *,
    inflight: dict[str, int] | None = None,
    just_idle_id: str | None = None,
    cap: int = MAX_ACTIVE_SHARDS_PER_WORKER,
    filter_shard_workers=None,
    record_dispatch=None,
    score_fallback=None,
) -> list:
    """两阶段指派：Admission → Ranking。

    filter_shard_workers(shard, workers) -> list[Worker]  分片级能力过滤
    record_dispatch(worker_id)  可选 · 记 recent penalty
    score_fallback(worker, shard)  可选 · Assignment.score 字段
    返回 list[Assignment]（类型由调用方 planner.Assignment）
    """
    from platform_v8.engine.planner import Assignment, _recent_dispatch_count, _record_dispatch

    if not shards or not workers:
        return []

    L: dict[str, int] = {}
    for w in workers:
        wid = str(w.id)
        base = 0
        if inflight is not None:
            base = int(inflight.get(wid, 0) or 0)
        else:
            base = int(getattr(w, "active_shards", 0) or 0)
        L[wid] = base

    just = str(just_idle_id or "").strip()

    # 重 OCR 优先
    shard_list = list(shards)
    try:
        shard_list.sort(
            key=lambda sh: -int((getattr(sh, "metadata", None) or {}).get("dispatch_weight") or 0)
        )
    except Exception:
        pass

    already: dict[str, set] = defaultdict(set)
    assignments: list[Assignment] = []

    for sh in shard_list:
        meta = getattr(sh, "metadata", None) or {}
        canonical = str(meta.get("replica_of", sh.id))
        used = already[canonical]
        # excluded 始终尊重（不再受 feedback flag 门控）
        sh_excluded = {str(x) for x in (meta.get("excluded_workers") or []) if x}

        pool = workers
        if filter_shard_workers is not None:
            try:
                pool = filter_shard_workers(sh, workers) or []
            except Exception:
                pool = workers
        if not pool:
            continue

        best = None
        best_p = -1e18
        for w in pool:
            wid = str(w.id)
            if wid in used:
                continue
            if sh_excluded and wid in sh_excluded:
                continue
            Lw = int(L.get(wid, 0))
            if not can_admit(Lw, cap, cost=1):
                continue
            recent_n = 0
            try:
                recent_n = int(_recent_dispatch_count(wid))
            except Exception:
                recent_n = 0
            p = score_worker(
                w, Lw, cap,
                just_idle=(bool(just) and wid == just),
                recent_penalty_count=recent_n,
            )
            if p > best_p:
                best_p = p
                best = w

        if best is None:
            continue

        wid = str(best.id)
        used.add(wid)
        L[wid] = int(L.get(wid, 0)) + 1
        try:
            if record_dispatch:
                record_dispatch(wid)
            else:
                _record_dispatch(wid)
        except Exception:
            pass
        sc = float(best_p)
        if score_fallback is not None:
            try:
                sc = float(score_fallback(best, sh))
            except Exception:
                pass
        assignments.append(Assignment(shard_id=sh.id, worker_id=best.id, score=sc))

    logger.info(
        "admission.assign · shards=%d assigned=%d workers=%d cap=%d just_idle=%s",
        len(shard_list), len(assignments), len(workers), cap,
        (just[:8] if just else "-"),
    )
    return assignments


def refresh_workers_inflight(session, workers: list) -> dict[str, int]:
    """用 DB 实况覆盖 worker.active_shards，返回 inflight map。"""
    from platform_v8.storage.repo import ShardRepo

    ids = [str(w.id) for w in workers if getattr(w, "id", None)]
    live = ShardRepo.count_inflight_by_workers(session, ids) if hasattr(
        ShardRepo, "count_inflight_by_workers"
    ) else ShardRepo.count_active_by_workers(session, ids)
    for w in workers:
        wid = str(w.id)
        try:
            w.active_shards = int(live.get(wid, 0))
        except Exception:
            pass
    return {str(k): int(v) for k, v in live.items()}
