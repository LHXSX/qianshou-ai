"""
Planner · 分片 (slice) + 调度 (schedule)

设计要点 (考虑全链路):
  1. slice(workload, workers) → list[Shard]
     根据 max_shards 和在线 worker 数决定切几片 (不超过 worker 数)
     单 worker 时 1 个 shard · N worker 时切 min(max_shards, N)
  
  2. schedule(shards, workers) → list[Assignment]
     Assignment = (shard_id, worker_id, score)
     算法:
       - 默认 (old): 仅按 load 升序 · reputation 不参与 (P0 bug)
       - NCE v1 (new): composite_score = load + reputation + capability_score
     选择: feature flag nce_planner_use_reputation 控制
     影子模式: nce_planner_shadow_mode · 算新排序写 we_planner_decisions · 不影响派单
     失败时返空 list (caller 处理 WAITING_FOR_WORKERS)
  
  3. 不动 DB · 纯计算 · 易测 (影子写入独立异步 · 失败不阻塞)
"""
from __future__ import annotations
import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from platform_v8.core import Workload, Worker, Shard, ShardStatus
from platform_v8.services import film_media_compat as media_compat
from platform_v8.services import film_text_compat as text_compat

logger = logging.getLogger(__name__)

# NCE 排序算法权重 (v2 · power×contrib×rep×load · 主项×100 与冷启动/惩罚同量纲)
_NCE_W_POWER = 100.0          # power×contrib×rep×(1-load)^1.5 的缩放
_NCE_LOAD_EXP = 1.5           # 负载指数 · 高负载更强降权
_NCE_REP_FLOOR = 0.4          # 信誉软地板 · rep_factor = 0.4 + 0.6*(rep/100)
_NCE_REP_SPAN = 0.6

# P2 · hw_tier 排序加成（v2 主分不再加 tier_bonus · 仍用于过滤/对照）
_HW_TIER_BONUS = {
    "S": 30, "A": 20, "B": 0, "C": -10, "D": -25,
}

# P4.10 多目标优化 · 任务难度对应的 SLA 优先级 (难任务派给好节点)
# 用 task difficulty 决定 SLA 权重 · difficulty >= 2.0 时 hw_tier 加成 ×2
_SLA_AMPLIFY_THRESHOLD = 2.0     # 难度 ≥ 此值 · hw_tier_bonus 放大
_SLA_AMPLIFY_FACTOR = 2.0

# P4.11 冷启动加成 · 新节点 / 新业务 给小加分让其有机会展示
# 注册时间 < 24h 的新节点 · 给 +10 加分 (让平台分点活儿给它学习)
# 实际效果: 防止"鸡生蛋蛋生鸡"-新节点没数据不被派单 → 永远没数据
_COLD_START_BONUS_NEW_NODE = 10   # 新节点 (< 24h) 排序加成
_COLD_START_NEW_NODE_HOURS = 24

# P4.12 候选池缓存 · 同 owner + 同 task_type 一段时间共用候选池
# 派单热路径 5min 缓存 · 减少 DB 查询 + 减少排序计算
_CANDIDATES_CACHE: dict[str, tuple[float, list]] = {}
_CANDIDATES_CACHE_TTL_S = 5       # 5s · 让 P4.21 recent_dispatch_penalty 5s 内必生效
_CANDIDATES_CACHE_MAX = 1000      # 缓存大小上限 (防内存爆)

# P4.20 · 顶部分数带抖动 · 防 top-1 worker 长期独占短任务 (1-shard workload)
# 顶部 N% 分数差内的 worker 视为"并列" · 按 (active_shards, load, 随机) 重排
# 不在 _sort_workers_nce_v1 里改 · 因为 cache 30s 会复用 · 抖动必须每次重算
_NCE_TOP_BAND_RATIO = 0.05        # 顶部 5% 分数差视为并列 (af 159 / da 157 都进 band)

# P4.21 · 近期派单惩罚 · 修"D 档节点永远没机会"BUG
# 60s 滚动窗口内 · 每收到 1 个 dispatch · composite_score -25
# 效果: 高分节点连续接到任务后会临时跌出顶部 · 让低分节点也有机会接单
# 例: af(159) 接 2 单后 → 159-50=109 · 4721eb7a(105) 反超
# 重启后清空 (in-process · 不持久化 · 可接受)
_RECENT_DISPATCH_WINDOW_S = 60
_RECENT_DISPATCH_PENALTY = 25     # 每个最近 dispatch 扣分
_RECENT_DISPATCH: dict[str, list[float]] = {}    # worker_id → [ts1, ts2, ...]


@dataclass
class Assignment:
    """调度结果: 哪个 shard 派给哪个 worker"""
    shard_id: str
    worker_id: str
    score: float = 0.0


# 注:旧版 even 切片 slice_workload() / _slice_input() 已移除(2026-06-24)。
# 真实切片走 platform_v8/engine/slicers/(按 task_registry 选 slicer),lifecycle.start
# 调的是 slicers.slice_workload。此处旧实现产出的 "<url>#shard=i/n" 是假分片输入,
# 早已无调用方,删除以免误用。


def schedule_assignments(shards: list[Shard], workers: list[Worker],
                         *, workload=None) -> list[Assignment]:
    """
    给每个 shard 选 worker · 简单贪心 + task_registry 过滤:
      1. 按 task_registry.requirements 过滤 candidate workers
         (软件 / 内存 / GPU 都不满足的节点不派)
      2. 排序:
         - 默认: 按 worker.load 升序
         - flag nce_planner_use_reputation ON: 用 NCE composite_score (load + reputation + capability)
         - flag nce_planner_shadow_mode ON: 同时算新排序写 audit 表 · 派单用旧的
      3. 给每片选当前最优的可用 worker (避免同一副本派同节点)
      4. 同 worker 可拿多片 (除非满了)
    """
    if not shards:
        return []
    from platform_v8.services.media_profiles import require_formal_media_channel, MediaProfileError, is_media
    if is_media(workload):
        return []  # the durable Guangzhou media dispatcher owns media leases
    try:
        require_formal_media_channel(workload)
    except MediaProfileError:
        return []  # do not reserve a shard before the missing media channel is connected
    if not workers:
        logger.warning("planner.schedule · 没 worker 可用 · 返空")
        return []

    # 2026-08-10 · 管理员定向派发白名单 · 放在最前 (名单外节点根本不该参与打分)
    # 此前 PUSH 侧没有这道过滤 · 只有 PULL 的 SQL 有 · 属于两侧不同口径。
    scoped = _filter_by_allowed_workers(workers, workload)
    if not scoped:
        logger.warning("planner.schedule · workload 定向节点均不在候选内 · 返空(转 WAITING)")
        return []

    # 2026-05-21 P0-2 · 先过滤节能/暂停节点 (mode=paused 或 throttle_pct=0)
    awake = _filter_by_throttle(scoped)
    if len(awake) < len(scoped):
        logger.info("planner.schedule · 排除 %d 个暂停/节能节点 (剩 %d)",
                    len(scoped) - len(awake), len(awake))
    protocol_compatible = _filter_by_protocol_profile(awake, workload)
    # Opt-in nodes must prove the exact task and input format they can execute.
    # A broad capability name or installed package alone cannot authorize an order.
    protocol_compatible = _filter_by_task_adapters(protocol_compatible, workload)
    # 2026-05-18 · 按 task_registry 过滤节点
    candidates = _filter_by_requirements(protocol_compatible, workload)
    _capability_shadow_safe(workload, protocol_compatible, candidates)
    candidates = _filter_by_runtime_v2(candidates, workload)
    if not candidates:
        logger.warning("planner.schedule · 没节点满足 task=%s 要求 (workers=%d)",
                       workload.spec.task_type if workload else "?", len(workers))
        return []  # 让 lifecycle 转 WAITING_FOR_WORKERS

    # 2026-06-02 · 学习型不胜任过滤 (nce_capability_feedback flag 控 · 默认 OFF)
    # 近窗口内反复跑挂某 task_type 的节点(机器不达标/依赖坏/模型缺) 暂时跳过 · 冷却到期自动恢复。
    # 与 _filter_by_requirements 的"声称能力硬过滤"互补: 这里基于"实测跑挂"的事后学习。
    candidates = _filter_by_learned_incapability(candidates, workload)
    if not candidates:
        logger.warning(
            "planner.schedule · 合格节点均近期跑挂 task=%s · 冷却中 · 返空(转 WAITING)",
            workload.spec.task_type if workload else "?")
        return []

    # 2026-05-25 NCE P2 · 硬件等级硬过滤 (flag 控 · 默认 OFF)
    # 按任务难度自动决定最低档位 · workload spec 也可显式指定 required_hw_tier
    if _flag_enabled_silent("nce_hw_tier_filter"):
        before = len(candidates)
        candidates = _filter_by_hw_tier(candidates, workload)
        if not candidates:
            logger.warning(
                "planner.schedule · hw_tier 过滤后无节点 (before=%d task=%s)",
                before, workload.spec.task_type if workload else "?")
            return []
        if len(candidates) < before:
            logger.info("planner.schedule · hw_tier 过滤: %d → %d 节点", before, len(candidates))

    # 2026-05-25 NCE P1 · 排序算法选择 (feature flag 控)
    # 默认 flag OFF · 走老的 load 升序 · 零回归
    owner_id = getattr(workload, "owner_id", None) if workload else None
    use_nce = _flag_enabled("nce_planner_use_reputation", owner_id)
    shadow_mode = _flag_enabled("nce_planner_shadow_mode", owner_id)

    # P4.10 · 设 task_difficulty / requires_gpu 上下文 (透传给 _composite_score_nce_v1)
    global _ctx_task_difficulty, _ctx_requires_gpu
    _ctx_task_difficulty = None
    _ctx_requires_gpu = False
    if workload is not None:
        try:
            from platform_v8.services.economy.task_difficulty import get_difficulty
            tt = getattr(workload.spec, "task_type", None) if hasattr(workload, "spec") else None
            if tt:
                _ctx_task_difficulty = get_difficulty(tt)
        except Exception:
            pass
        try:
            from platform_v8.engine.task_registry import get_spec
            tt = getattr(workload.spec, "task_type", None) if hasattr(workload, "spec") else None
            if tt:
                spec_meta = get_spec(tt)
                _ctx_requires_gpu = bool(getattr(spec_meta, "requires_gpu", False))
        except Exception:
            pass

    sorted_old = _sort_workers_old(candidates)
    if use_nce:
        sorted_workers = _sort_workers_nce_v1_cached(candidates, owner_id, _ctx_task_difficulty)
        # P4.20 · 顶部分数带抖动 (修 BUG: top-1 worker 长期独占短任务)
        # cache 之外应用 · 保证每次派单都重新抖 · 不被 30s cache 锁死
        sorted_workers = _apply_top_band_jitter(sorted_workers)
        algo_version = "nce_v1"
    else:
        sorted_workers = sorted_old
        algo_version = "legacy_load"

    # 2026-06-11 · V8.2 RFC 节点执行层重构 · executor 偏好软排序
    # 不阻断 · 让支持 task.executor 的节点优先 · 不支持的也保留(走 python3 兜底)
    # 老节点 supported_executors=[] · 默认认为只支持 python3 · 派给它们老 task 行为不变
    sorted_workers = _apply_executor_preference(sorted_workers, workload)
    sorted_workers = _prefer_strict_profiles(sorted_workers)

    # 2026-08-10 · 显式 preferred_worker_ids 置顶
    sorted_workers = _apply_preferred_worker_ids(sorted_workers, workload)

    # 影子模式: 不管 use_nce 与否 · 只要 shadow 开 就算出 NCE 顺序对照
    sorted_shadow: list[Worker] | None = None
    if shadow_mode and not use_nce:
        sorted_shadow = _sort_workers_nce_v1(candidates)
    elif shadow_mode and use_nce:
        # 跳 NCE 模式 · 影子则是老的 (对照看“如果不用 NCE 会选谁”)
        sorted_shadow = sorted_old

    n = len(sorted_workers)
    assignments: list[Assignment] = []

    # 2026-05-25 NCE P4.15 · 一节点一片公平派单 (flag 控)
    # ON 时: 本回合每 worker 最多接 1 片 · 多余 shard 留 PENDING
    #        sweeper 30s 后会 redispatch_pending · 那时 worker 已完成 idle · 可再接
    #        效果: 不一家独大 · 公平派单 + 容错 (单节点挂只丢 1 片)
    # OFF 时: 老逻辑 (sorted_workers[(i+offset) % n] 循环 · 同 worker 可多片)
    #
    # 2026-08-04 · package_digest/material_digest：一节点一片会饿死 PENDING → burst=4
    from collections import Counter
    one_shard_mode = _flag_enabled_silent("nce_one_shard_per_worker")
    tt = None
    try:
        tt = getattr(getattr(workload, "spec", None), "task_type", None) if workload else None
    except Exception:
        tt = None
    contract_queue_mode = False
    if tt:
        try:
            from platform_v8.engine.task_registry import get_spec as _get_task_spec

            contract_queue_mode = (
                _get_task_spec(tt).batch_semantics == "single_item"
            )
        except Exception:
            contract_queue_mode = False
    per_worker_cap = 1 if (one_shard_mode or contract_queue_mode) else 10**9
    if tt in ("package_digest", "material_digest") and one_shard_mode:
        per_worker_cap = 4
    one_shard_used: Counter = Counter()

    # 2026-05-18 · 冗余感知调度
    # 同一 replica_of (相同原片) 的副本必须派给不同 worker (避免一个节点跑 N 副本骗钱)
    # 记 already_assigned_workers[replica_of] = set(worker_id)
    already: dict[str, set] = {}
    shard_list = _order_shards_heavy_first(shards)
    for i, sh in enumerate(shard_list):
        meta = sh.metadata or {}
        canonical = str(meta.get("replica_of", sh.id))
        used = already.setdefault(canonical, set())
        # 该片已失败/卡住过的节点不再重派（始终生效；软回收与手动重派依赖此字段）
        # flag nce_capability_feedback 仅控制其它反馈路径；excluded 名单本身必须硬读。
        sh_excluded = {str(x) for x in (meta.get("excluded_workers") or [])}
        # A normal execution failure gets a bounded exclusion even when
        # capability feedback is disabled.  Expired entries are ignored so a
        # temporarily unhealthy worker can rejoin future retries.
        try:
            import time as _time
            retry_until = dict(meta.get("retry_excluded_until") or {})
            now_s = int(_time.time())
            sh_excluded.update(
                str(worker_id)
                for worker_id, expires_at in retry_until.items()
                if int(expires_at or 0) > now_s
            )
        except (TypeError, ValueError):
            pass
        # 本任务已成功跑完其它分片的节点 · 手动重派优先（perfect-run affinity）
        sh_preferred = {str(x) for x in (meta.get("preferred_workers") or [])}

        def _eligible(w) -> bool:
            if w.id in used:
                return False
            if one_shard_used[w.id] >= per_worker_cap:
                return False
            if sh_excluded and str(w.id) in sh_excluded:
                return False
            return True

        # 找一个没被这片用过的 worker（先 preferred，再按原 round-robin）
        chosen = None
        if sh_preferred:
            for w in sorted_workers:
                if str(w.id) not in sh_preferred:
                    continue
                if _eligible(w):
                    chosen = w
                    break
        if chosen is None:
            for offset in range(n):
                w = sorted_workers[(i + offset) % n]
                if not _eligible(w):
                    continue
                chosen = w
                break
        # Preserve retry exclusions, replica separation and per-worker caps.
        # A sole ineligible node must wait instead of exhausting dispatch retries.
        if chosen is None:
            if one_shard_mode or contract_queue_mode:
                logger.info(
                    "planner.schedule.one_shard · shard #%s 无空闲节点 · 留 PENDING (sweeper 重派) cap=%d",
                    str(sh.id)[:8], per_worker_cap,
                )
            else:
                logger.warning("planner.schedule · 副本 #%s (canonical=%s) 找不到独立 worker · 跳过",
                               str(sh.id)[:8], str(canonical)[:8])
            continue
        used.add(chosen.id)
        one_shard_used[chosen.id] += 1
        # P4.21 · 记派单 (60s 窗口) · 让下次同节点 composite_score 暂时下降 · 公平轮转
        if use_nce:
            _record_dispatch(chosen.id)
        assignments.append(Assignment(shard_id=sh.id, worker_id=chosen.id,
                                      score=_score(chosen, sh)))

    if one_shard_mode or contract_queue_mode:
        logger.info(
            "planner.schedule.one_shard · 本回合派 %d/%d 片 · cap=%d/worker · contract=%s · 剩余等 sweeper",
            len(assignments), len(shard_list), per_worker_cap, contract_queue_mode,
        )

    logger.info("planner.schedule · %d shards → %d assignments (candidates=%d/%d · algo=%s%s)",
                len(shards), len(assignments), n, len(workers),
                algo_version, " · SHADOW" if shadow_mode else "")

    # 影子模式 / NCE 排序 · 异步写 audit (失败不阻塞派单)
    if shadow_mode or use_nce:
        _log_planner_decision_safe(
            workload=workload,
            shards=shards,
            assignments=assignments,
            sorted_main=sorted_workers,
            sorted_shadow=sorted_shadow,
            algo_version=algo_version,
            shadow_mode=shadow_mode,
        )

    return assignments


def _filter_by_throttle(workers: list[Worker]) -> list[Worker]:
    """2026-05-21 P0-2 · 排除节能/暂停节点

    capabilities 里 mode/throttle_pct 由客户端 hb 上报合入 (services/workers/heartbeat.py)
      mode=paused / sleeping → 跳过
      throttle_pct == 0      → 跳过 (用户拉到 0 = 完全暂停接单)
    旧客户端不上报 → 当作 100/running 处理 (不排除 · 向后兼容)
    """
    awake: list[Worker] = []
    for w in workers:
        cap = w.capabilities
        # capabilities 是 dataclass · 看 __dict__ 或 raw dict
        if hasattr(cap, "__dict__"):
            raw = cap.__dict__
        elif isinstance(cap, dict):
            raw = cap
        else:
            raw = {}
        if raw.get("review_only") is True:
            logger.debug("planner.throttle · worker=%s dedicated review-only · skip", w.id)
            continue
        # WorkerCapabilities dataclass 上的字段名是 contribute_mode (repo mapper 把
        # 心跳 JSON 的 "mode" 映射到它)，只读 "mode" 会永远拿到 None → 暂停失效。
        mode = (raw.get("mode") or raw.get("contribute_mode") or "").lower()
        if mode in ("paused", "sleeping", "stopped"):
            logger.debug("planner.throttle · worker=%s mode=%s · skip", w.id, mode)
            continue
        tp = raw.get("throttle_pct")
        if tp is not None and int(tp) <= 0:
            logger.debug("planner.throttle · worker=%s throttle=0 · skip", w.id)
            continue
        awake.append(w)
    return awake


def _film_writing_executor_scope(workload):
    """None: ordinary private-pin semantics; empty scope: Film authority denied.

    eco_app is only a classification. A Film scope is trusted solely after
    reading the existing committed completion grant and operator pool policy.
    """
    if media_compat.is_media(workload):
        return media_compat.trusted_executor_owners(workload)
    if text_compat.is_semantic(workload):
        return text_compat.trusted_executor_owners(workload)
    params = getattr(getattr(workload, "spec", None), "params", None)
    eco = params.get("eco_app") if isinstance(params, dict) else None
    if not (isinstance(eco, dict) and eco.get("id") == "qianshou-film" and "writing_recipe" in eco):
        return None
    owners = text_compat.writing_trusted_executor_owners(workload)
    # 生产者缺席（归档）或集成/DB/配置缺失，都不得打开他人的 pin。
    return {} if owners is None else owners


def _allowed_worker_ids(workload) -> set[str]:
    """管理员定向派发白名单 · 取 spec.requirements.allowed_worker_ids。

    返回空集 = 不限制。非 list 形状 (脏数据) 一律当作不限制,
    宁可放开也不要因为一个坏字段把任务永久锁死。
    与 PULL 侧 SQL 防线 (ShardRepo.lease_pending_pull) 保持同一语义。
    """
    if workload is None:
        return set()
    spec = getattr(workload, "spec", None)
    req = getattr(spec, "requirements", None) if spec is not None else None
    if not isinstance(req, dict):
        return set()
    raw = req.get("allowed_worker_ids")
    if not isinstance(raw, list):
        return set()
    return {str(x) for x in raw if x}


def worker_allowed_for_workload(worker_id: str, workload) -> bool:
    """单节点定向判定 · PULL (pull_dispatcher) 与 PUSH 共用,避免两侧口径漂移。"""
    from platform_v8.engine.task_registry import TASK_REGISTRY
    spec = TASK_REGISTRY.get(getattr(getattr(workload, "spec", None), "task_type", ""))
    if spec is not None and getattr(spec, "official_provider_id", ""):
        from platform_v8.services.workloads.official_image_admission import trusted_worker_identity
        identity = trusted_worker_identity()
        return identity is not None and str(worker_id) == identity[0]
    scope = _film_writing_executor_scope(workload)
    if scope is not None:
        return str(worker_id) in scope
    allowed = _allowed_worker_ids(workload)
    if not allowed:
        return True
    return str(worker_id) in allowed


def _filter_by_allowed_workers(workers: list[Worker], workload) -> list[Worker]:
    """白名单非空时只留名单内节点。"""
    scope = _film_writing_executor_scope(workload)
    if scope is not None:
        return [w for w in workers if str(w.id) in scope]
    allowed = _allowed_worker_ids(workload)
    if not allowed:
        return workers
    kept = [w for w in workers if str(w.id) in allowed]
    if len(kept) < len(workers):
        logger.info("planner.allowed · 定向白名单 %d 个 · 候选 %d → %d",
                    len(allowed), len(workers), len(kept))
    return kept


def pinned_worker_ids(workload) -> set[str] | None:
    """从 workload.spec.requirements 解析硬 pin 的 worker 集合。

    支持字段（任一非空即生效，取并集）:
      - worker_ids
      - allowed_worker_ids

    返回:
      None  → 未 pin（开放调度）
      set() → 显式空列表（无合法节点，应 WAITING）
      set{…}→ 只允许这些 worker_id
    """
    if workload is None:
        return None
    spec = getattr(workload, "spec", None)
    req = getattr(spec, "requirements", None) or {}
    if not isinstance(req, dict):
        return None
    raw: list = []
    for key in ("worker_ids", "allowed_worker_ids"):
        v = req.get(key)
        if isinstance(v, (list, tuple, set)):
            raw.extend(v)
        elif isinstance(v, str) and v.strip():
            raw.append(v.strip())
    if not raw and "worker_ids" not in req and "allowed_worker_ids" not in req:
        return None
    # 显式传了空列表 → 空集合（禁止全员抢）
    if not raw and ("worker_ids" in req or "allowed_worker_ids" in req):
        return set()
    out = {str(x).strip() for x in raw if str(x).strip()}
    return out


PIN_OFFLINE_GRACE = timedelta(minutes=30)


def pin_dead_reason(
    pin: set[str] | None,
    *,
    online_ids: set[str],
    known_ids: set[str],
    age: timedelta | None,
    grace: timedelta = PIN_OFFLINE_GRACE,
) -> str | None:
    """纠-14：硬 pin 已不可能满足时给出终态原因；仍可能恢复则 None。

    pin 为 None = 未 pin，不判死。
    显式空集合保持 WAITING（本刀不改）。
    库里没有这些 worker_id → 立刻 pin_missing。
    人都在但全离线 → 超过 grace 才 pin_offline_expired。
    """
    if pin is None:
        return None
    pin_s = {str(x).strip() for x in pin if str(x).strip()}
    if not pin_s:
        return None
    online = {str(x).strip() for x in online_ids if str(x).strip()}
    known = {str(x).strip() for x in known_ids if str(x).strip()}
    if pin_s & online:
        return None
    if not (pin_s & known):
        return "pin_missing"
    if age is not None and age >= grace:
        return "pin_offline_expired"
    return None


def _filter_by_worker_pin(workers: list[Worker], workload) -> list[Worker]:
    """硬 pin：requirements.worker_ids / allowed_worker_ids。

    律所 OCR 等会写入本账号六台 Mac 的 ID；此前只入库不强制，
    共享池里别家 ONLINE 节点仍会抢到分片。此处强制执行。
    pin 生效时额外要求 worker.owner_id == workload.owner_id，
    防止伪造/错绑 ID 跨账号接单。
    """
    from platform_v8.engine.task_registry import TASK_REGISTRY
    spec = TASK_REGISTRY.get(getattr(getattr(workload, "spec", None), "task_type", ""))
    if spec is not None and getattr(spec, "official_provider_id", ""):
        from platform_v8.services.workloads.official_image_admission import worker_matches
        return [worker for worker in workers if worker_matches(worker)]
    scope = _film_writing_executor_scope(workload)
    if scope is not None:
        return [w for w in workers if str(w.id) in scope]
    pin = pinned_worker_ids(workload)
    if pin is None:
        return workers
    owner_id = int(getattr(workload, "owner_id", 0) or 0)
    matched: list[Worker] = []
    for w in workers:
        wid = str(getattr(w, "id", "") or "").strip()
        if wid not in pin:
            continue
        if owner_id and int(getattr(w, "owner_id", 0) or 0) != owner_id:
            logger.info(
                "planner.pin · worker=%s owner=%s ≠ workload.owner=%s · skip",
                wid[:13], getattr(w, "owner_id", None), owner_id,
            )
            continue
        matched.append(w)
    if not matched:
        logger.warning(
            "planner.pin · 无候选: pin=%d online=%d owner=%s task=%s",
            len(pin), len(workers), owner_id,
            getattr(getattr(workload, "spec", None), "task_type", "?"),
        )
    else:
        logger.info(
            "planner.pin · 收紧候选 %d→%d (pin=%d owner=%s)",
            len(workers), len(matched), len(pin), owner_id,
        )
    return matched


_AUTO_MODEL_TOKENS = ("auto", "自动", "智能", "default", "any")


def _is_auto_ollama_model(name: str) -> bool:
    """任务把模型交给节点自选 · 此时不按模型名过滤。"""
    return str(name or "").strip().lower() in _AUTO_MODEL_TOKENS


def _normalize_model_name(name: str) -> str:
    """把模型标识归一化,用于跨格式比对。

    节点上报的可能是 ollama 短名 (qwen2.5:1.5b) 也可能是本地权重文件绝对路径
    (/Users/x/.qianshou/llm/models/qwen3.5-4b/model.gguf)。统一小写、
    把 : _ . 折成 -、去掉权重后缀,让两种格式能对上。
    """
    s = str(name or "").strip().lower()
    for suffix in (".gguf", ".bin", ".safetensors"):
        if s.endswith(suffix):
            s = s[: -len(suffix)]
    for ch in (":", "_", ".", " "):
        s = s.replace(ch, "-")
    return s


def _ollama_model_match(wanted: str, available: list[str] | tuple[str, ...]) -> bool:
    """任务要的模型是否在节点已有模型里。

    空 / auto → True (不限制)。否则依次尝试:
      1. 精确相等
      2. 节点模型以要求名开头 (量化后缀 qwen2.5:1.5b-q4_K_M)
      3. 归一化后包含 (节点报绝对路径时唯一能对上的方式)
    """
    want = str(wanted or "").strip()
    if not want or _is_auto_ollama_model(want):
        return True
    have = [str(x) for x in (available or []) if x]
    if not have:
        return False
    want_l = want.lower()
    for m in have:
        m_l = m.lower()
        if m_l == want_l or m_l.startswith(want_l):
            return True
    want_n = _normalize_model_name(want)
    if not want_n:
        return True
    return any(want_n in _normalize_model_name(m) for m in have)


def _worker_llm_models(cap) -> list[str]:
    """节点可用的本地大模型列表 · 新旧字段合并 (llm_models 是新的,ollama_models 是旧的)。"""
    out: list[str] = []
    for field in ("llm_models", "ollama_models"):
        for m in (getattr(cap, field, None) or []):
            if m and str(m) not in out:
                out.append(str(m))
    return out


def _has_local_llm_capability(cap, worker_sw: set[str]) -> bool:
    """节点是否具备跑本地大模型的能力。

    过渡期有三种上报形态,任一成立即算具备:
      · software 里有 local_llm (新客户端)
      · software 里有 ollama (旧客户端)
      · 压根没打 software 标签,但上报了模型列表 (hb 探针漏标)
    """
    if "local_llm" in worker_sw or "ollama" in worker_sw:
        return True
    return bool(_worker_llm_models(cap))


def _requested_llm_models(workload) -> tuple[str, str]:
    """任务要求的 (主模型, 视觉模型) · 都可能为空。"""
    spec = getattr(workload, "spec", None)
    params = getattr(spec, "params", None) if spec is not None else None
    if not isinstance(params, dict):
        return "", ""
    main = params.get("ollama_model") or params.get("model") or ""
    vision = params.get("vision_model") or ""
    return str(main or ""), str(vision or "")



def _required_caps_for_workload(workload) -> list:
    """Prefer author-declared params.required_capabilities; else task_registry map."""
    from platform_v8.engine import capabilities as cap_reg
    from platform_v8.engine.task_registry import get_spec

    params = getattr(getattr(workload, "spec", None), "params", None) or {}
    declared = cap_reg.normalize_capability_list(
        params.get("required_capabilities") if isinstance(params, dict) else None
    )
    if declared:
        return declared
    spec = get_spec(getattr(getattr(workload, "spec", None), "task_type", ""))
    return cap_reg.resolve_required(spec)


def _filter_by_runtime_v2(workers: list[Worker], workload) -> list[Worker]:
    """V2：优先派给正式广告 Capability 的节点；一个都没有则 fail-open 给旧千手节点。"""
    if not workers or workload is None:
        return workers
    try:
        from platform_v8.services.marketplace.execution_model import (
            EXEC_V2,
            planner_v2_hard_match_enabled,
            resolve_from_workload,
        )
        from platform_v8.engine import capabilities as cap_reg
    except Exception:
        return workers

    if resolve_from_workload(workload) != EXEC_V2:
        return workers

    try:
        required = _required_caps_for_workload(workload)
    except Exception:
        required = []
    primary = required[0]["name"] if required else None
    owner_id = getattr(workload, "owner_id", None)
    app_slug = None
    try:
        app_slug = (getattr(workload.spec, "params", None) or {}).get("app_slug")
    except Exception:
        app_slug = None
    if not planner_v2_hard_match_enabled(
        account_id=owner_id,
        app_slug=app_slug,
        capability=primary,
    ):
        return workers

    matched: list[Worker] = []
    for w in workers:
        if cap_reg.worker_matches_v2_capabilities(w.capabilities, required):
            matched.append(w)
        else:
            logger.debug(
                "planner.v2 · worker=%s 缺 provided_capabilities=%s · skip",
                w.id,
                required,
            )
    if matched:
        logger.info(
            "planner.v2 · prefer %d/%d workers with %s",
            len(matched),
            len(workers),
            required,
        )
        return matched
    logger.info(
        "planner.v2 · no capability match · fail-open to %d software-filtered workers (old 千手节点)",
        len(workers),
    )
    return workers



def _capability_shadow_safe(workload, pool, old_matched) -> None:
    """换血阶段①：契约语义匹配 vs required_software，只记不改候选。"""
    try:
        from platform_v8.services.capability_shadow import record_shadow
        record_shadow(workload, pool, old_matched)
    except Exception as exc:
        logger.warning("planner.capability_shadow FAIL (静默跳过) · err=%s", exc)



def _software_for_requirements(cap) -> set:
    """required_software 硬过滤用的节点软件名。

    software，若空则 runtimes；并始终并上 native_binaries。
    `:936` 做 NATIVE 偏好排序已经读 native_binaries；硬过滤此前漏了，
    只在 native_binaries 里报 ffmpeg 的节点接不到 video_compress 等任务。
    """
    if cap is None:
        return set()
    if isinstance(cap, dict):
        software = cap.get("software") or []
        runtimes = cap.get("runtimes") or []
        bins = cap.get("native_binaries") or []
    else:
        software = getattr(cap, "software", None) or []
        runtimes = getattr(cap, "runtimes", None) or []
        bins = getattr(cap, "native_binaries", None) or []
    worker_sw = set(software)
    if not worker_sw:
        worker_sw = set(runtimes)
    worker_sw |= set(bins)
    return worker_sw


def _filter_by_requirements(workers: list[Worker], workload) -> list[Worker]:
    """根据 pin + task_registry.required_software / min_memory_mb / requires_gpu 过滤节点

    节点 capabilities 字段 (来自 v8_ws.collect_capabilities):
      software: list[str]      ["pillow", "ffmpeg", "blender", "ollama", ...]
      total_memory_mb: int     真实物理内存
      gpu_count: int           >= 1 即有 GPU

    2026-08 · 先执行 requirements.worker_ids 硬 pin（律所六台），再跑能力过滤。
    """
    if workload is None:
        return workers

    from platform_v8.services.media_profiles import filter_media_workers
    workers = filter_media_workers(workers, workload)
    if not workers:
        return []

    workers = _filter_by_worker_pin(workers, workload)
    if not workers:
        return []

    # HX-88 · hello-union 能力（text.transform 等）只认 provided_capabilities 广告。
    # required_software 为空时下面会整表放行，所以门放在这之前。
    try:
        from platform_v8.services.capability_shadow import hello_union_gate
        workers = hello_union_gate(
            getattr(getattr(workload, "spec", None), "task_type", "") or "",
            workers,
        )
    except Exception as exc:
        logger.warning("planner.hello_union_gate FAIL (静默跳过) · err=%s", exc)
    if not workers:
        return []

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
        # software 检查 · HX-03: 并入 native_binaries（:936 排序已读，硬过滤此前漏了）
        worker_sw = _software_for_requirements(cap)

        # local_llm 是能力概念不是单一包名 · 新客户端报 local_llm、旧的报 ollama、
        # 探针漏标时只有模型列表 · 三种形态都算具备,否则会把能跑的节点全过滤掉。
        effective_needed = set(needed_sw)
        wants_llm = "local_llm" in needed_sw
        try:
            from platform_v8.services.capability_shadow import relax_required_software
            effective_needed = relax_required_software(
                getattr(getattr(workload, "spec", None), "task_type", "") or "",
                w,
                effective_needed,
            )
        except Exception as exc:
            logger.warning("planner.relax_required_software FAIL (静默跳过) · err=%s", exc)
        if wants_llm and _has_local_llm_capability(cap, worker_sw):
            effective_needed.discard("local_llm")

        if effective_needed and not effective_needed.issubset(worker_sw):
            missing = effective_needed - worker_sw
            logger.debug("planner.filter · worker=%s 缺 software=%s · skip", w.id, missing)
            continue

        # 任务点名了具体模型 → 节点得真的有 (auto / 空 = 交给节点自选,不过滤)
        if wants_llm:
            models = _worker_llm_models(cap)
            main_model, vision_model = _requested_llm_models(workload)
            if not _ollama_model_match(main_model, models):
                logger.debug("planner.filter · worker=%s 没有模型 %s · skip", w.id, main_model)
                continue
            if vision_model and not _ollama_model_match(vision_model, models):
                logger.debug("planner.filter · worker=%s 没有视觉模型 %s · skip",
                             w.id, vision_model)
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


def _filter_by_protocol_profile(
    workers: list[Worker],
    workload: Any,
) -> list[Worker]:
    """Keep legacy nodes on safe ONESHOT Python fallbacks only."""
    if workload is None:
        return workers
    try:
        from platform_v8.engine.effective_task import (
            legacy_python_fallback,
            resolve_dispatch_task,
        )
        from platform_v8.engine.task_registry import TaskMode, get_spec
        from platform_v8.protocol.capability_profile import (
            CapabilityProfile,
            is_legacy_profile,
            parse_profile,
        )

        task_type, code_url, _task = resolve_dispatch_task(workload, None)
        task_spec = get_spec(task_type)
        input_kind = str(getattr(workload.spec, "input_kind", "") or "")
    except Exception:
        return []

    kept: list[Worker] = []
    fallback = legacy_python_fallback(task_type, code_url)
    for worker in workers:
        profile = parse_profile(
            getattr(worker.capabilities, "protocol_profile", "")
        )
        if profile == CapabilityProfile.UNSUPPORTED:
            continue
        if is_legacy_profile(profile):
            if (
                task_spec.mode != TaskMode.ONESHOT
                or input_kind == "stream"
                or not fallback
            ):
                continue
        kept.append(worker)
    return kept


def _filter_by_task_adapters(workers: list[Worker], workload: Any) -> list[Worker]:
    """Exact opt-in adapter gate, before broad software/capability matching."""
    if workload is None:
        return workers
    from platform_v8.services.workers.task_adapters import matches
    from platform_v8.engine.task_registry import get_spec

    spec = getattr(workload, "spec", None)
    task_type = str(getattr(spec, "task_type", "") or "")
    input_kind = str(getattr(spec, "input_kind", "") or "")
    registered = get_spec(task_type)
    if registered.requires_verified_adapter:
        from platform_v8.services.workers.task_adapter_routing import can_route_reviewed_adapter
        from platform_v8.storage import db as db_mod
        allowed: list[Worker] = []
        try:
            with db_mod.session_scope() as session:
                for worker in workers:
                    if can_route_reviewed_adapter(
                        session, worker, task_type=task_type, input_kind=input_kind,
                        capability_id=registered.adapter_capability_id,
                        output_kind=registered.adapter_output_kind, renew_lock=True,
                    ):
                        allowed.append(worker)
            return allowed
        except Exception:
            return []
    approved_digest = registered.approved_adapter_digest
    if registered.requires_verified_adapter and not approved_digest:
        return []
    return [
        worker for worker in workers
        if matches(
            worker,
            task_type=task_type,
            input_kind=input_kind,
            require_verified=registered.requires_verified_adapter,
            capability_id=registered.adapter_capability_id,
            output_kind=registered.adapter_output_kind,
            artifact_digest=approved_digest,
        )
    ]


def _prefer_strict_profiles(workers: list[Worker]) -> list[Worker]:
    """Stable preference: strict-capable sessions before legacy fallbacks."""
    from platform_v8.protocol.capability_profile import is_legacy_profile

    strict = [
        worker for worker in workers
        if not is_legacy_profile(worker.capabilities.protocol_profile)
    ]
    legacy = [
        worker for worker in workers
        if is_legacy_profile(worker.capabilities.protocol_profile)
    ]
    return strict + legacy



def _extract_preferred_worker_ids(workload) -> list[str]:
    """从 spec.requirements / spec.params 读取 preferred_worker_ids。"""
    if workload is None:
        return []
    spec = getattr(workload, "spec", None)
    if spec is None:
        return []
    bags = []
    for bag_name in ("requirements", "params"):
        bag = getattr(spec, bag_name, None)
        if isinstance(bag, dict):
            bags.append(bag)
        elif isinstance(spec, dict) and isinstance(spec.get(bag_name), dict):
            bags.append(spec[bag_name])
    out: list[str] = []
    seen: set[str] = set()
    for bag in bags:
        raw = bag.get("preferred_worker_ids")
        if raw is None and bag.get("preferred_worker_id"):
            raw = [bag.get("preferred_worker_id")]
        if raw is None:
            continue
        if isinstance(raw, str):
            items = [raw]
        elif isinstance(raw, (list, tuple)):
            items = list(raw)
        else:
            continue
        for item in items:
            wid = str(item or "").strip()
            if not wid or wid in seen:
                continue
            seen.add(wid)
            out.append(wid)
    return out


def _apply_preferred_worker_ids(sorted_workers: list, workload):
    """把显式指定的 worker 稳定置顶 · 未命中候选则忽略。"""
    if not sorted_workers:
        return sorted_workers
    preferred_ids = _extract_preferred_worker_ids(workload)
    if not preferred_ids:
        return sorted_workers
    by_id = {str(w.id): w for w in sorted_workers}
    head = [by_id[i] for i in preferred_ids if i in by_id]
    if not head:
        logger.info(
            "planner.preferred_workers · 指定 %d 个但不在合格候选中 · 回落原序",
            len(preferred_ids),
        )
        return sorted_workers
    head_ids = {str(w.id) for w in head}
    tail = [w for w in sorted_workers if str(w.id) not in head_ids]
    logger.info(
        "planner.preferred_workers · hit=%d/%d · pin_first=%s",
        len(head), len(preferred_ids), ",".join(str(w.id)[:8] for w in head[:3]),
    )
    return head + tail


def _apply_executor_preference(sorted_workers: list[Worker], workload) -> list[Worker]:
    """2026-06-11 V8.2 RFC · executor 偏好稳定排序

    设计原则:
      - 不阻断 · 不删节点 · 老节点(supported_executors=[]) 全保留
      - 仅稳定排序: 支持 task.executor 的节点提前(冒到前面)· 不支持的也派得到
      - workload.spec.task_type 的 executor 字段决定偏好:
          PYTHON3 → 无偏好 · 直接返回
          NATIVE  → 节点 supported_executors 含 'native' + native_binaries 含 task.native_binary
          ONNX    → 节点 supported_executors 含 'onnx' + onnx_models 含 task.onnx_model
          HTTP    → 节点 supported_executors 含 'http'(基本所有 8.2+ 节点都支持)
      - 不在的节点不报错 · 仅排后(走 python3 老脚本兜底)
      - 异常/无 workload → 原样返回 · 零回归

    返回: list[Worker] · 已按 executor 偏好稳定排序 · 主排序键(load/nce)保留
    """
    if not sorted_workers or workload is None:
        return sorted_workers
    try:
        from platform_v8.engine.task_registry import get_spec, Executor
    except Exception:
        return sorted_workers
    spec = get_spec(getattr(getattr(workload, "spec", None), "task_type", ""))
    if spec.executor == Executor.PYTHON3:
        return sorted_workers  # PYTHON3 无偏好 · 维持现状

    target_exec = spec.executor.value      # 'native' / 'onnx' / 'http'
    target_bin = spec.native_binary        # 仅 NATIVE 用
    target_model = spec.onnx_model         # 仅 ONNX 用

    def supports(w: Worker) -> int:
        """返 1 = 节点完整支持 task 的原生 executor · 返 0 = 走 python3 兜底
        中间档(支持 executor 但缺 binary/model)算 0 · 因为 native_runner 会失败
        """
        cap = w.capabilities
        supported = set(getattr(cap, "supported_executors", []) or [])
        if target_exec not in supported:
            return 0
        if spec.executor == Executor.NATIVE and target_bin:
            bins = set(getattr(cap, "native_binaries", []) or [])
            if target_bin not in bins:
                return 0
        elif spec.executor == Executor.ONNX and target_model:
            models = set(getattr(cap, "onnx_models", []) or [])
            if target_model not in models:
                return 0
        # HTTP 不需要额外资源 · 只看 supported_executors
        return 1

    # 稳定排序: 支持的在前 · 不支持的在后 · 同档内保持原排序
    # 不删任何节点 · 老节点也参派单 · 维持老脚本兜底
    preferred = [w for w in sorted_workers if supports(w) == 1]
    fallback = [w for w in sorted_workers if supports(w) == 0]
    if preferred and fallback:
        logger.info(
            "planner.executor_pref · task=%s executor=%s · preferred=%d fallback=%d",
            spec.task_type, target_exec, len(preferred), len(fallback))
    return preferred + fallback


def _filter_by_learned_incapability(workers: list[Worker], workload) -> list[Worker]:
    """剔除"近期反复跑挂此 task_type"的节点 (capability_feedback 冷却中)。
       flag OFF / 无 task_type / Redis 挂 → 原样返回 (放行 · 不误杀)。"""
    if workload is None:
        return workers
    try:
        task_type = getattr(getattr(workload, "spec", None), "task_type", None)
        if not task_type:
            return workers
        from platform_v8.engine import capability_feedback as cf
        if not cf.enabled():
            return workers
        keep_ids = set(cf.filter_capable(task_type, [str(w.id) for w in workers]))
        kept = [w for w in workers if str(w.id) in keep_ids]
        return kept if kept else []
    except Exception as exc:
        logger.debug("planner.learned_incap · 异常 fail-open: %s", exc)
        return workers


def worker_can_run(worker: Worker, workload) -> bool:
    """
    单节点能力校验 · PULL 抢单对齐 PUSH 硬过滤 (2026-06-02 P1-问题3)

    复用 PUSH 主路完全相同的过滤器 · 保证"推/拉两路"能力判定单一来源:
      - _filter_by_requirements: required_software / min_memory_mb / requires_gpu (硬)
      - _filter_by_hw_tier:      客户显式 required_hw_tier 硬过滤 · 自动推断 tier 软排序
                                 (不在此拦 · 与 PUSH 软分级行为一致)

    返 True = 该节点可跑此 workload · False = 缺能力 (PULL 该释放 lease 回 PENDING)
    校验自身异常 → fail-open 返 True (跟 planner 各 filter 的异常降级一致 · 不误杀)
    """
    from platform_v8.services.media_profiles import require_formal_media_channel, MediaProfileError, is_media
    if is_media(workload):
        return False
    try:
        require_formal_media_channel(workload)
    except MediaProfileError:
        return False
    if getattr(worker.capabilities, "review_only", False) is True:
        return False
    try:
        if not _filter_by_protocol_profile([worker], workload):
            return False
        # PULL uses this single-worker path instead of schedule_assignments.
        # Apply the same exact installed/reviewed adapter gate as PUSH.
        if not _filter_by_task_adapters([worker], workload):
            return False
        if not _filter_by_requirements([worker], workload):
            return False
        if not _filter_by_hw_tier([worker], workload):
            return False
        # 2026-06-02 · 学习型不胜任 (推/拉两路统一) · 冷却中的节点 PULL 也不该抢此 task_type
        if not _filter_by_learned_incapability([worker], workload):
            return False
        return True
    except Exception as exc:
        # A reviewed adapter is an authorization gate, so unavailable review
        # state must never turn an unverified node into an eligible PULL node.
        try:
            from platform_v8.engine.task_registry import get_spec
            task_type = str(getattr(getattr(workload, "spec", None), "task_type", "") or "")
            if get_spec(task_type).requires_verified_adapter:
                return False
        except Exception:
            return False
        logger.debug("planner.worker_can_run · 校验异常 fail-open · worker=%s err=%s",
                     getattr(worker, "id", "?"), exc)
        from platform_v8.services.media_profiles import is_media
        if is_media(workload):
            return False
        return True


def _score(worker: Worker, shard: Shard) -> float:
    """worker × shard 匹配度打分"""
    base = max(worker.capability_score, 1.0)
    load_penalty = worker.load * 10
    reputation_bonus = (worker.reputation - 0.5) * 5
    return base - load_penalty + reputation_bonus


# ════════════════════════════════════════════════════════════════════════════
# 2026-05-25 NCE P1 · 排序算法 + feature flag + 影子模式 audit
# ════════════════════════════════════════════════════════════════════════════

def _sort_workers_old(candidates: list[Worker]) -> list[Worker]:
    """Legacy 排序 · 2026-06-07 S1-T5 公平性增强:
    - 主键: load 量化到 0.05 (避免 0.121 vs 0.125 这种微小差稳定 top-1)
    - 次键: active_shards 升序 (实时负载 · 不依赖 30s 滞后心跳的 load)
    - 三键: 每次派单生成随机 perm (同负载 worker 均匀轮转)
    
    旧版仅 `sorted(candidates, key=load)`,导致单 shard 任务永远派给 sorted[0]
    引发"5 节点 1 个扛 74% / 1 个全程闲置"实测问题。
    
    本改动不依赖任何 feature flag · 立即生效 · 与 NCE v1 排序互不影响
    (use_nce=True 时走 _sort_workers_nce_v1_cached + top_band_jitter)。
    """
    import random
    # 同 (load_bucket, active_shards) 的 worker 给随机 jitter (-0.5~+0.5)
    # 保证 sorted 稳定但同条件分布均匀
    jitters = {w.id: random.random() for w in candidates}
    mults = _batch_owner_tier_mults(candidates)
    return sorted(
        candidates,
        key=lambda w: (
            round(getattr(w, "load", 0.0) * 20) / 20,  # 量化到 0.05 桶
            getattr(w, "active_shards", 0),
            # 同负载下高等级优先（倍率越大越靠前）
            -float(mults.get(int(getattr(w, "owner_id", 0) or 0), 1.0)),
            jitters[w.id],
        ),
    )


# 档位序 (高 → 低) · 用于判断 worker 档位是否 >= 要求档位
_HW_TIER_ORDER = ["S", "A", "B", "C", "D"]
_HW_TIER_INDEX = {t: i for i, t in enumerate(_HW_TIER_ORDER)}


def _required_hw_tier_detail(workload) -> tuple[str | None, bool]:
    """
    决定 workload 需要的最低 hw_tier · 返 (tier, is_explicit)

    is_explicit=True  → 客户在 spec.required_hw_tier 显式指定 (尊重客户 SLA · 硬过滤)
    is_explicit=False → 按 task_type 难度自动推断 (默认软排序 · 见 _filter_by_hw_tier)

    自动推断:
      difficulty >= 2.0 → "B"   (重任务)
      difficulty >= 1.0 → "C"   (中等)
      else             → None   (轻任务 · 全档可用)
    """
    if workload is None:
        return None, False
    # 1. 显式指定 (客户控)
    spec = getattr(workload, "spec", None)
    if spec is not None:
        explicit = getattr(spec, "required_hw_tier", None)
        if explicit and explicit in _HW_TIER_INDEX:
            return explicit, True
        # 也可能 spec 是 dict
        if isinstance(spec, dict):
            explicit2 = spec.get("required_hw_tier")
            if explicit2 and explicit2 in _HW_TIER_INDEX:
                return explicit2, True

    # 2. 按难度自动推断 (非显式)
    try:
        from platform_v8.services.economy.task_difficulty import get_difficulty
        task_type = getattr(spec, "task_type", None) if spec else None
        if not task_type and isinstance(spec, dict):
            task_type = spec.get("task_type")
        if task_type:
            d = get_difficulty(task_type)
            if d >= 2.0:
                return "B", False
            if d >= 1.0:
                return "C", False
    except Exception:
        pass

    return None, False


def _required_hw_tier_for_workload(workload) -> str | None:
    """兼容旧调用 · 只返 tier (不含 is_explicit)"""
    tier, _ = _required_hw_tier_detail(workload)
    return tier


def _filter_by_hw_tier(candidates: list[Worker], workload) -> list[Worker]:
    """
    按硬件等级过滤 · 节点 hw_tier 必须 >= required_hw_tier

    2026-06-02 修正 · 区分"客户显式要求" vs "难度自动推断":
      - 客户显式 spec.required_hw_tier → 硬过滤 (尊重客户 SLA · 达不到不派)
      - 难度自动推断的 tier:
          flag nce_hw_tier_soft_auto ON  → *软排序* · 不硬踢 (靠 _HW_TIER_BONUS 加权
              让高档优先 · 但不把低档/新节点清零) · 防节点池被清空 + 破冷启动死循环
          flag OFF → 老硬过滤行为 (零回归 · 可一键回退)

    例: required=B → 留下 S/A/B · 排除 C/D · None = 不过滤
    """
    required, is_explicit = _required_hw_tier_detail(workload)
    if required is None:
        return candidates

    # 难度自动推断 + flag ON → 软排序 (返全部候选 · 优先级交给打分阶段的 tier 加成)
    if not is_explicit and _flag_enabled_silent("nce_hw_tier_soft_auto"):
        logger.debug(
            "planner.hw_tier · 自动 tier=%s · 软排序(不硬过滤) · 候选保留=%d",
            required, len(candidates))
        return candidates

    # 硬过滤 (客户显式要求 · 或 flag OFF 的老行为)
    required_idx = _HW_TIER_INDEX[required]
    matched = []
    for w in candidates:
        w_tier = getattr(w, "hw_tier", "B") or "B"
        w_idx = _HW_TIER_INDEX.get(w_tier, 2)  # 不识别按 B
        if w_idx <= required_idx:    # idx 越小档位越高
            matched.append(w)
    return matched


def _composite_score_nce_v1(w: Worker) -> float:
    """
    NCE v1 综合评分 (越大越优先)

    公式: 100 * power * contribution * rep_factor * (1-load)^1.5。
    这是 NCE 的纯评分函数；调度公平性（近期派单、冷启动等）必须在候选
    排序层处理，不能改变这个可审计的基础分。
    """
    raw_load = w.load if w.load is not None else 0.0
    load = max(0.0, min(1.0, float(raw_load)))
    raw_rep = getattr(w, "rep_main", None)
    reputation = max(0.0, min(1.0, float(raw_rep if raw_rep is not None else 60) / 100.0))
    rep_factor = 0.4 + 0.6 * reputation
    contribution = 1.0
    return 100.0 * _worker_power(w) * contribution * rep_factor * ((1.0 - load) ** 1.5)


_ctx_requires_gpu = False


def _worker_power(w: Worker) -> float:
    """Return normalized usable compute power from ranked CPU and throttle."""
    cap = getattr(w, "capabilities", None)
    cpu_brand = str(getattr(cap, "cpu_brand", "") or "")
    cores = max(0, int(getattr(cap, "cpu_cores", 0) or 0))
    if cores <= 0:
        return 0.0
    try:
        from platform_v8.services.economy.cpu_rank import cpu_coeff_for_brand, _FALLBACK_COEFF_CAP
        power = cpu_coeff_for_brand(cpu_brand)
    except Exception:
        power = 0.0
    # 新型号/未入 rank 表的机器按核心数给保守兜底；完全没有核心上报时
    # 不能凭旧 capability_score 虚构算力。
    if power <= 0.0:
        power = min(_FALLBACK_COEFF_CAP, cores / 8.0)
    if _ctx_requires_gpu and int(getattr(cap, "gpu_count", 0) or 0) < 1:
        return 0.0
    throttle = max(0.0, min(100.0, float(getattr(cap, "throttle_pct", 100) or 0)))
    return max(0.0, min(1.0, float(power))) * (throttle / 100.0)


def _order_shards_heavy_first(shards: list[Shard]) -> list[Shard]:
    """Prioritize expensive package shards while preserving equal-weight order."""
    return sorted(
        shards,
        key=lambda sh: -int((getattr(sh, "metadata", None) or {}).get("dispatch_weight") or 0),
    )


def _recent_dispatch_count(worker_id: str) -> int:
    """
    P4.21 · 返 worker 在最近 60s 内被派单次数 (用于 composite_score 惩罚)
    
    同时 purge 过期的时间戳 (lazy cleanup · 防内存爆)
    """
    import time
    now = time.time()
    ts_list = _RECENT_DISPATCH.get(str(worker_id))
    if not ts_list:
        return 0
    fresh = [t for t in ts_list if now - t < _RECENT_DISPATCH_WINDOW_S]
    if len(fresh) != len(ts_list):
        _RECENT_DISPATCH[str(worker_id)] = fresh  # purge in place
    return len(fresh)


def _record_dispatch(worker_id: str) -> None:
    """P4.21 · 派单后记一笔时间戳 (60s 后自动失效)"""
    import time
    _RECENT_DISPATCH.setdefault(str(worker_id), []).append(time.time())


# P4.10 · 派单上下文 (task difficulty / GPU 透传给 score 函数)
# 用模块变量传 · 不破坏 _composite_score_nce_v1 已有签名 (老测试不动)
_ctx_task_difficulty: float | None = None
_ctx_requires_gpu: bool = False


def _is_new_node(w: Worker) -> bool:
    """P4.11 · 判定新节点 (注册 < 24h)"""
    from datetime import datetime, timedelta, timezone
    reg = getattr(w, "registered_at", None)
    if reg is None:
        return False
    if reg.tzinfo is None:
        reg = reg.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - reg) < timedelta(hours=_COLD_START_NEW_NODE_HOURS)


# P4.17b · owner 维度冷启动防刷缓存 (5min TTL · 同 owner 多节点派单去重)
# key: owner_id · val: (has_mature_bool, expire_ts)
_OWNER_MATURE_CACHE: dict[int, tuple[bool, float]] = {}
_OWNER_MATURE_TTL_S = 300  # 5 min

# owner 等级倍率缓存 (60s · 调度热路径少打 balance)
_OWNER_TIER_MULT_CACHE: dict[int, tuple[float, float]] = {}
_OWNER_TIER_MULT_TTL_S = 60


def _batch_owner_tier_mults(candidates: list[Worker]) -> dict[int, float]:
    """批量取 owner 等级倍率；失败则全 1.0（不影响派单）。"""
    import time
    from platform_v8.services.economy.tier import multiplier_for_balance

    now = time.time()
    out: dict[int, float] = {}
    missing: list[int] = []
    for w in candidates:
        oid = getattr(w, "owner_id", None)
        if not oid:
            continue
        oid = int(oid)
        cached = _OWNER_TIER_MULT_CACHE.get(oid)
        if cached and cached[1] > now:
            out[oid] = cached[0]
        else:
            missing.append(oid)

    if not missing:
        return out

    try:
        from platform_v8.storage import db as db_mod
        from sqlalchemy import text as sa_text
        uniq = sorted(set(missing))
        with db_mod.session_scope() as s:
            rows = s.execute(
                sa_text("SELECT id, balance FROM we_accounts WHERE id = ANY(:ids)"),
                {"ids": uniq},
            ).mappings().all()
        found = {int(r["id"]): float(r["balance"] or 0) for r in rows}
        for oid in uniq:
            mult = float(multiplier_for_balance(found.get(oid, 0.0)))
            _OWNER_TIER_MULT_CACHE[oid] = (mult, now + _OWNER_TIER_MULT_TTL_S)
            out[oid] = mult
    except Exception as exc:
        logger.debug("_batch_owner_tier_mults fail-safe: %s", exc)
        for oid in missing:
            out.setdefault(int(oid), 1.0)
    return out


def _owner_has_mature_node(w: Worker) -> bool:
    """
    P4.17b · owner 名下是否已有"毕业"节点 (注册 > 24h)
    
    返 True (有老节点) → 不给冷启动加成 (老 owner 加新机不算冷启动 · 防刷)
    返 False (全是新节点) → 给冷启动加成 (真新 owner · 鼓励)
    
    带 5min 进程内缓存 · 减少 DB 压力 (派单热路径)
    异常 fail-safe: 查不到默认 False (允许给加成 · 不破坏老逻辑)
    """
    import time
    owner_id = getattr(w, "owner_id", None)
    if not owner_id:
        return False  # 无主节点 · 直接当真新
    
    now = time.time()
    cached = _OWNER_MATURE_CACHE.get(owner_id)
    if cached and cached[1] > now:
        return cached[0]
    
    try:
        from datetime import datetime, timedelta, timezone
        from platform_v8.storage import db as db_mod
        from sqlalchemy import text as sa_text
        threshold = datetime.now(timezone.utc) - timedelta(hours=_COLD_START_NEW_NODE_HOURS)
        with db_mod.session_scope() as s:
            row = s.execute(sa_text(
                "SELECT 1 FROM we_workers WHERE owner_id=:oid AND registered_at < :th LIMIT 1"
            ), {"oid": owner_id, "th": threshold}).first()
        has_mature = row is not None
        _OWNER_MATURE_CACHE[owner_id] = (has_mature, now + _OWNER_MATURE_TTL_S)
        return has_mature
    except Exception as exc:
        logger.debug("_owner_has_mature_node fail-safe owner=%s exc=%s", owner_id, exc)
        return False


def _flag_enabled_silent(flag_name: str) -> bool:
    """全局 flag 检查 · 不带 subject · 仅看 enabled+rollout_pct=100 · 任何异常 False"""
    try:
        from platform_v8.services.ops import feature_flags as ff
        return ff.is_enabled(flag_name, subject_id=None)
    except Exception:
        return False


def _sort_workers_nce_v1(candidates: list[Worker]) -> list[Worker]:
    """NCE v1 排序: composite_score × owner tier 倍率 降序 (高分在前)"""
    mults = _batch_owner_tier_mults(candidates)
    return sorted(
        candidates,
        key=lambda w: -(
            _composite_score_nce_v1(w) * float(mults.get(int(getattr(w, "owner_id", 0) or 0), 1.0))
        ),
    )


def _apply_top_band_jitter(sorted_workers: list[Worker]) -> list[Worker]:
    """
    P4.20 · 顶部分数带抖动 · 防 top-1 worker 长期独占短任务

    场景: 4 节点 NCE score 分别 159 / 157 / 105 / 77
      老逻辑: 总挑 159 那个 (1-shard 短任务 load=0 永远没机会让 157 上位)
      新逻辑: 顶部 5% 分数差内 (159 vs 157) 视为"并列" · 按 (active_shards, load) 排
              同 active_shards / load 的随机打散 · 50/50 公平派单

    sorted_workers: 已按 composite_score 降序排好 (来自 _sort_workers_nce_v1_cached)
    返回: 顶部 band 内按 (active_shards 升, load 升, 随机) 重排 · rest 顺序不变
    """
    if len(sorted_workers) < 2:
        return sorted_workers

    import random
    # 算 top score · 取 band 阈值
    top_score = _composite_score_nce_v1(sorted_workers[0])
    if top_score <= 0:
        return sorted_workers
    threshold = top_score * (1.0 - _NCE_TOP_BAND_RATIO)

    band: list[Worker] = []
    rest: list[Worker] = []
    for w in sorted_workers:
        s = _composite_score_nce_v1(w)
        if s >= threshold:
            band.append(w)
        else:
            rest.append(w)

    if len(band) <= 1:
        # top band 只 1 个 worker · 不需抖动
        return sorted_workers

    # band 内: 先随机打散 · 再按 (active_shards, load) 稳定排
    # Python sort 稳定 · 等 key 的 worker 保持 shuffle 后顺序
    random.shuffle(band)
    band.sort(key=lambda w: (w.active_shards, w.load))

    logger.debug("planner.top_band_jitter · band=%d top=%.1f thresh=%.1f winner=%s",
                 len(band), top_score, threshold, str(band[0].id)[:8])
    return band + rest


def _sort_workers_nce_v1_cached(
    candidates: list[Worker],
    owner_id,
    task_difficulty: float | None,
) -> list[Worker]:
    """
    P4.12 · 候选池缓存版排序 · 30s 内同 key 复用结果
    
    缓存 key: owner_id + task_difficulty 分档 + worker_ids 指纹
    - 同 owner + 同难度档 + 同候选池 → 复用排序
    - 任一变化 → 重算
    
    fail-safe: 缓存异常退回非缓存版
    """
    # P4.21 · 小候选池绕过缓存 · 让 _recent_dispatch_count 惩罚每次重算生效
    # < 10 节点时 · 排序成本可忽略 (4 节点排序 < 0.1ms)
    # 缓存仅服务于"很多节点 + 短时间内大量派单"场景
    if len(candidates) < 10:
        return _sort_workers_nce_v1(candidates)

    try:
        import time
        # 缓存 key
        diff_bucket = "none" if task_difficulty is None else f"{task_difficulty:.1f}"
        # worker_id 指纹 (排序确保稳定)
        wids_fp = ",".join(sorted(str(w.id) for w in candidates))
        cache_key = f"{owner_id}|{diff_bucket}|{hash(wids_fp)}"

        # 查缓存
        entry = _CANDIDATES_CACHE.get(cache_key)
        if entry is not None:
            expires_at, cached_sorted = entry
            if time.time() < expires_at:
                # 命中 · 用 worker_id 映射回真实 Worker 对象 (load 可能更新)
                wid_map = {str(w.id): w for w in candidates}
                fresh = [wid_map[wid] for wid in cached_sorted if wid in wid_map]
                if len(fresh) == len(candidates):
                    return fresh

        # 不命中 · 真排序
        sorted_workers = _sort_workers_nce_v1(candidates)

        # 写缓存 (存 worker_id 列表 · 不存对象引用)
        if len(_CANDIDATES_CACHE) >= _CANDIDATES_CACHE_MAX:
            # 简单淘汰: 清半数最老的
            sorted_keys = sorted(
                _CANDIDATES_CACHE.items(), key=lambda kv: kv[1][0]
            )[: _CANDIDATES_CACHE_MAX // 2]
            for k, _ in sorted_keys:
                _CANDIDATES_CACHE.pop(k, None)

        _CANDIDATES_CACHE[cache_key] = (
            time.time() + _CANDIDATES_CACHE_TTL_S,
            [str(w.id) for w in sorted_workers],
        )
        return sorted_workers
    except Exception as exc:
        logger.debug("planner._sort_workers_nce_v1_cached fail · 退回直排: %s", exc)
        return _sort_workers_nce_v1(candidates)


def invalidate_candidates_cache() -> None:
    """admin 触发 · 节点变化时清缓存"""
    _CANDIDATES_CACHE.clear()


def _flag_enabled(flag_name: str, owner_id) -> bool:
    """
    安全读 feature flag · 任何异常都返 False (fail-safe · 派单不能挂)
    """
    try:
        from platform_v8.services.ops import feature_flags as ff
        return ff.is_enabled(flag_name, subject_id=owner_id)
    except Exception as exc:
        logger.warning("planner._flag_enabled · flag=%s err=%s · 默认 OFF",
                       flag_name, exc)
        return False


def _log_planner_decision_safe(
    *,
    workload,
    shards: list[Shard],
    assignments: list[Assignment],
    sorted_main: list[Worker],
    sorted_shadow: list[Worker] | None,
    algo_version: str,
    shadow_mode: bool,
) -> None:
    """
    写 we_planner_decisions audit 表 · 任何异常静默 (不能阻塞派单热路径)
    
    记录每个 shard 的:
      - chosen_worker_id: 实际派给谁 (走 sorted_main 的结果)
      - shadow_chosen_id: 影子算法选谁 (sorted_shadow Top 1)
      - match_old: 两者是否一致
      - candidates: Top 5 候选 + 各自 composite_score 摘要
    """
    try:
        _log_planner_decision_impl(
            workload=workload,
            shards=shards,
            assignments=assignments,
            sorted_main=sorted_main,
            sorted_shadow=sorted_shadow,
            algo_version=algo_version,
            shadow_mode=shadow_mode,
        )
    except Exception as exc:
        logger.warning("planner._log_planner_decision FAIL (\u9759\u9ed8\u8df3\u8fc7) · err=%s", exc)


def _log_planner_decision_impl(
    *,
    workload,
    shards: list[Shard],
    assignments: list[Assignment],
    sorted_main: list[Worker],
    sorted_shadow: list[Worker] | None,
    algo_version: str,
    shadow_mode: bool,
) -> None:
    """实际写入实现 · 调用方包了 try/except"""
    from sqlalchemy import text
    from platform_v8.storage import db as db_mod

    workload_id = getattr(workload, "id", None) if workload else None
    task_type = (
        getattr(workload.spec, "task_type", None) if workload else None
    )

    # workload_id NOT NULL · 拿不到时跳过 (生产派单都会传 workload · 仅测试场景为 None)
    if workload_id is None:
        logger.debug("planner._log_planner_decision skip · workload_id is None")
        return

    # 候选摘要 (Top 5 · 含双算法 score)
    top5 = sorted_main[:5]
    candidates_summary = [
        {
            "worker_id": str(w.id),
            "load": round(float(w.load or 0), 3),
            "reputation": round(float(w.reputation or 0), 3),
            "capability_score": round(float(w.capability_score or 0), 2),
            "nce_v1_score": round(_composite_score_nce_v1(w), 2),
        }
        for w in top5
    ]

    # shadow Top 1 (用于对照)
    shadow_top1_id = None
    if sorted_shadow:
        shadow_top1_id = str(sorted_shadow[0].id)

    # assignments 转 dict (shard_id → worker_id)
    chosen_map = {a.shard_id: (a.worker_id, a.score) for a in assignments}

    # 每个 shard 写一行
    rows = []
    for sh in shards:
        chosen_id, chosen_score = chosen_map.get(sh.id, (None, None))
        match_old = (
            None if shadow_top1_id is None or chosen_id is None
            else (str(chosen_id) == shadow_top1_id)
        )
        rows.append({
            "shard_id": str(sh.id),
            "workload_id": str(workload_id) if workload_id else None,
            "task_type": task_type,
            "algo_version": algo_version,
            "chosen_worker_id": str(chosen_id) if chosen_id else None,
            "chosen_score": float(chosen_score) if chosen_score is not None else None,
            "candidates": _json_dumps(candidates_summary),
            "shadow_chosen_id": shadow_top1_id,
            "shadow_score": (
                round(_composite_score_nce_v1(sorted_shadow[0]), 2)
                if sorted_shadow else None
            ),
            "match_old": match_old,
            "candidate_count": len(sorted_main),
        })

    if not rows:
        return

    with db_mod.session_scope() as s:
        s.execute(
            text("""
                INSERT INTO we_planner_decisions
                    (shard_id, workload_id, task_type, algo_version,
                     chosen_worker_id, chosen_score, candidates,
                     shadow_chosen_id, shadow_score, match_old,
                     candidate_count, created_at)
                VALUES
                    (CAST(:shard_id AS uuid),
                     CAST(:workload_id AS uuid),
                     :task_type, :algo_version,
                     CAST(:chosen_worker_id AS uuid),
                     :chosen_score,
                     CAST(:candidates AS jsonb),
                     CAST(:shadow_chosen_id AS uuid),
                     :shadow_score, :match_old,
                     :candidate_count, NOW())
            """),
            rows,
        )
        s.commit()


def _json_dumps(obj) -> str:
    import json
    return json.dumps(obj, ensure_ascii=False, default=str)
