"""
Planner · 分片 (slice) + 调度 (schedule)

设计要点 (考虑全链路):
  1. slice(workload, workers) → list[Shard]
     根据 max_shards 和在线 worker 数决定切几片 (不超过 worker 数)
     单 worker 时 1 个 shard · N worker 时切 min(max_shards, N)
  
  2. schedule(shards, workers) → list[Assignment]
     Assignment = (shard_id, worker_id, score)
     算法: 简单负载均衡 + tier 偏好 (后续可扩 ML)
     失败时返空 list (caller 处理 WAITING_FOR_WORKERS)
  
  3. 不动 DB · 纯计算 · 易测
"""
from __future__ import annotations
import logging
from dataclasses import dataclass

from platform_v8.core import Workload, Worker, Shard, ShardStatus

logger = logging.getLogger(__name__)


@dataclass
class Assignment:
    """调度结果: 哪个 shard 派给哪个 worker"""
    shard_id: str
    worker_id: str
    score: float = 0.0


def slice_workload(workload: Workload, workers: list[Worker]) -> list[Shard]:
    """
    把 workload 切成 N 个 shard (N = min(max_shards, len(workers)))
    
    没 worker → 切 1 个 (留待 WAITING · auto-queue 重提)
    """
    max_shards = max(1, workload.spec.max_shards)
    n_workers = len(workers)
    if n_workers == 0:
        # 没 worker · 留 1 个 shard · 让 caller 进 WAITING
        n_shards = 1
    else:
        n_shards = min(max_shards, n_workers)

    shards: list[Shard] = []
    for i in range(n_shards):
        sh = Shard(
            workload_id=workload.id,
            index=i,
            total=n_shards,
            status=ShardStatus.PENDING,
            input_ref=_slice_input(workload, i, n_shards),
            metadata={
                "slice_strategy": "even" if n_shards > 1 else "single",
                "workload_name": workload.name,
            },
        )
        shards.append(sh)
    logger.info("planner.slice · workload=%s → %d shards (workers=%d, max=%d)",
                workload.id, n_shards, n_workers, max_shards)
    return shards


def _slice_input(workload: Workload, index: int, total: int) -> str:
    """切分输入数据 · 简化版: 给每片相同 input_ref · 让 worker 自己读 + index 切片"""
    if total == 1:
        return workload.spec.input_ref
    return f"{workload.spec.input_ref}#shard={index}/{total}"


def schedule_assignments(shards: list[Shard], workers: list[Worker],
                         *, workload=None) -> list[Assignment]:
    """
    给每个 shard 选 worker · 简单贪心 + task_registry 过滤:
      1. 按 task_registry.requirements 过滤 candidate workers
         (软件 / 内存 / GPU 都不满足的节点不派)
      2. 按 worker.load 升序排
      3. 给每片选当前负载最低的可用 worker
      4. 同 worker 可拿多片 (除非满了)
    
    打分: capability_score - load * 10 (后续可扩 ML)
    """
    if not shards:
        return []
    if not workers:
        logger.warning("planner.schedule · 没 worker 可用 · 返空")
        return []

    # 2026-05-18 · 按 task_registry 过滤节点
    candidates = _filter_by_requirements(workers, workload)
    if not candidates:
        logger.warning("planner.schedule · 没节点满足 task=%s 要求 (workers=%d)",
                       workload.spec.task_type if workload else "?", len(workers))
        return []  # 让 lifecycle 转 WAITING_FOR_WORKERS

    # 按 load 升序排 (负载低的优先) · 二级 key 随机化让 load 相等时不再总选第 0 个
    # 2026-05-24 修偏斜: 之前只按 load 排 · load 全 0 时 sorted stable 永远选第一个 worker
    import random as _random
    sorted_workers = sorted(candidates, key=lambda w: (w.load, _random.random()))
    n = len(sorted_workers)
    assignments: list[Assignment] = []

    # 2026-05-18 · 冗余感知调度
    # 同一 replica_of (相同原片) 的副本必须派给不同 worker (避免一个节点跑 N 副本骗钱)
    # 记 already_assigned_workers[replica_of] = set(worker_id)
    already: dict[str, set] = {}
    for i, sh in enumerate(shards):
        meta = sh.metadata or {}
        canonical = str(meta.get("replica_of", sh.id))
        used = already.setdefault(canonical, set())
        # 找一个没被这片用过的 worker
        chosen = None
        for offset in range(n):
            w = sorted_workers[(i + offset) % n]
            if w.id not in used:
                chosen = w
                break
        if chosen is None:
            logger.warning("planner.schedule · 副本 #%s (canonical=%s) 找不到独立 worker · 跳过",
                           sh.id[:8], canonical[:8])
            continue
        used.add(chosen.id)
        assignments.append(Assignment(shard_id=sh.id, worker_id=chosen.id,
                                      score=_score(chosen, sh)))

    logger.info("planner.schedule · %d shards → %d assignments (candidates=%d/%d · redundancy ok)",
                len(shards), len(assignments), n, len(workers))
    return assignments


def _filter_by_requirements(workers: list[Worker], workload) -> list[Worker]:
    """根据 pin + task_registry 能力要求过滤节点。

    storage.planner 为引擎 planner 的薄镜像；硬 pin 委托 engine.planner，
    避免两套逻辑漂移。
    """
    if workload is None:
        return workers
    try:
        from platform_v8.engine.planner import _filter_by_worker_pin
        workers = _filter_by_worker_pin(workers, workload)
        if not workers:
            return []
    except Exception as exc:
        logger.debug("storage.planner.pin · 委托失败 fail-open: %s", exc)

    try:
        from platform_v8.engine.task_registry import get_spec
    except Exception:
        return workers

    spec_meta = get_spec(workload.spec.task_type)
    needed_sw = set(spec_meta.required_software)
    min_mem = spec_meta.min_memory_mb
    need_gpu = spec_meta.requires_gpu

    if not (needed_sw or min_mem > 0 or need_gpu):
        return workers  # 无能力要求 · 保留 pin 后候选

    matched: list[Worker] = []
    for w in workers:
        cap = w.capabilities
        # software 检查
        worker_sw = set()
        # cap 是 WorkerCapabilities dataclass · 无 software 字段直接取
        # 但 DB 里 capabilities.software list 通过 _row_to_worker 没映射 (那个表只塞固定字段)
        # 应急: 从 cap.__dict__ 找 software · 没有就从原 dict (sigh)
        if hasattr(cap, "__dict__"):
            worker_sw = set(getattr(cap, "software", []) or [])
        # 退一步: 看 runtimes
        if not worker_sw:
            worker_sw = set(getattr(cap, "runtimes", []) or [])

        if needed_sw and not needed_sw.issubset(worker_sw):
            missing = needed_sw - worker_sw
            logger.debug("planner.filter · worker=%s 缺 software=%s · skip", w.id, missing)
            continue

        # 内存
        worker_mem = int(getattr(cap, "total_memory_mb", 0) or 0)
        if worker_mem == 0:
            # 老节点没上报 · 回退 memory_gb
            worker_mem = int(float(getattr(cap, "memory_gb", 0) or 0) * 1024)
        if min_mem > 0 and worker_mem > 0 and worker_mem < min_mem:
            logger.debug("planner.filter · worker=%s 内存 %d MB < %d MB · skip",
                         w.id, worker_mem, min_mem)
            continue

        # GPU
        if need_gpu and int(getattr(cap, "gpu_count", 0) or 0) < 1:
            logger.debug("planner.filter · worker=%s 缺 GPU · skip", w.id)
            continue

        matched.append(w)
    return matched


def _score(worker: Worker, shard: Shard) -> float:
    """worker × shard 匹配度打分"""
    base = max(worker.capability_score, 1.0)
    load_penalty = worker.load * 10
    reputation_bonus = (worker.reputation - 0.5) * 5
    return base - load_penalty + reputation_bonus
