"""
NCE 观察者 · shard 完成时触发 NCE 完整 rep_scoring 重算

2026-05-25 · 取代老 reputation.observe (EMA 平滑) 体系
  
设计:
  - 每个 shard 状态变化 (DONE/FAILED/TIMEOUT/MISMATCH)
  - 立即调 rep_scoring.evaluate_worker (NCE 4 子分调和平均)
  - 立即调 persist_score (写 we_workers.rep_* + we_reputation_events 审计)
  - 严重作弊 (MISMATCH / BENCHMARK_FAIL) 额外硬罚 rep_main 砍半
  
为什么删老体系:
  - 老 EMA 用 we_workers.reputation 单字段 · planner 已不读 (用 rep_main)
  - 老 observe 不写审计 · 业务事件不可追溯
  - 双体系易打架 (M4 老 rep=0.986 新 rep_main=49)
  - 新体系基于统计 · 自动包含成功率/速度/在线时长/资源 · 更准

调用方:
  - aggregator.py · shard DONE → SUCCESS
  - aggregator.py · shard FAILED → FAILURE / TIMEOUT
  - anti_cheat.py · 多副本不一致 → MISMATCH (硬罚)
"""
from __future__ import annotations
import logging
from enum import Enum

logger = logging.getLogger(__name__)


# ════════════════════════════════════════════════════════════════════════════
# 事件类型 · 简化 enum (兼容老 reputation.ReputationEvent 命名)
# ════════════════════════════════════════════════════════════════════════════

class ShardOutcome(str, Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    TIMEOUT = "timeout"
    MISMATCH = "mismatch"              # 反作弊检测 · 多副本不一致 · 严重
    BENCHMARK_FAIL = "benchmark_fail"
    ATTESTATION_FAIL = "attestation_fail"
    MANUAL_BAN = "manual_ban"


# 严重作弊事件 (NCE 重算后再砍半 rep_main)
_HARD_PENALTY_EVENTS = {
    ShardOutcome.MISMATCH,
    ShardOutcome.BENCHMARK_FAIL,
    ShardOutcome.ATTESTATION_FAIL,
    ShardOutcome.MANUAL_BAN,
}

# 砍半系数
_HARD_PENALTY_FACTOR = 0.5


# ════════════════════════════════════════════════════════════════════════════
# 主入口 · 给 caller 用
# ════════════════════════════════════════════════════════════════════════════

def observe_shard(worker_id: str, outcome: ShardOutcome) -> bool:
    """
    shard 完成 → 触发 NCE 重算 · 严重作弊额外硬罚
    
    幂等性: 由 caller 保证 (一次 shard 状态变化只调一次)
    返回是否完整持久化；普通调用方可忽略，结算反作弊路径必须检查。
    """
    if not worker_id:
        return False

    wid = str(worker_id)

    # 1. NCE 完整重算 + 持久化 (4 子分调和平均)
    try:
        from platform_v8.services.economy import rep_scoring
        result = rep_scoring.evaluate_worker(wid)
        rep_scoring.persist_score(result, trigger=f"shard_{outcome.value}")
        new_main = result.rep_main
        logger.info("nce_observer · worker=%s outcome=%s rep_main=%d",
                    wid[:8], outcome.value, new_main)
    except Exception as exc:
        logger.warning(
            "nce_observer · NCE recompute failed: %s", type(exc).__name__
        )
        return False

    # 2. 严重作弊 · NCE 算完后再砍半 (硬罚)
    if outcome in _HARD_PENALTY_EVENTS:
        try:
            from platform_v8.storage import db as db_mod
            from sqlalchemy import text
            import json
            with db_mod.session_scope() as s:
                # 砍半 rep_main · 防 0 → 至少 1
                s.execute(
                    text("""
                        UPDATE we_workers
                        SET rep_main = GREATEST(CAST(rep_main * :factor AS INT), 1)
                        WHERE id = CAST(:wid AS text)
                    """),
                    {"wid": wid, "factor": _HARD_PENALTY_FACTOR},
                )
                # 写审计
                s.execute(
                    text("""
                        INSERT INTO we_reputation_events
                            (worker_id, event_type, delta,
                             before_score, after_score,
                             reason, metadata, is_shadow, created_at)
                        VALUES
                            (CAST(:wid AS uuid), :etype, :delta,
                             :before, :after,
                             :reason, CAST(:meta AS jsonb), FALSE, NOW())
                    """),
                    {
                        "wid": wid,
                        "etype": f"hard_penalty_{outcome.value}",
                        "delta": -int(new_main * (1 - _HARD_PENALTY_FACTOR)),
                        "before": int(new_main),
                        "after": int(new_main * _HARD_PENALTY_FACTOR),
                        "reason": f"严重作弊 {outcome.value} · rep_main × {_HARD_PENALTY_FACTOR}",
                        "meta": json.dumps({"factor": _HARD_PENALTY_FACTOR}),
                    },
                )
                s.commit()
            logger.warning("nce_observer · worker=%s 硬罚 %s · rep_main %d → %d",
                           wid[:8], outcome.value,
                           int(new_main), int(new_main * _HARD_PENALTY_FACTOR))
        except Exception as exc:
            logger.warning(
                "nce_observer · hard penalty failed: %s", type(exc).__name__
            )
            return False
    return True


# ════════════════════════════════════════════════════════════════════════════
# 辅助 · planner 用 (信誉门槛检查)
# ════════════════════════════════════════════════════════════════════════════

MIN_REPUTATION_MAIN = 30   # rep_main < 30 的节点过滤掉 (原 0.3 × 100)


def is_trusted(worker_id: str) -> bool:
    """节点 rep_main >= 30 视为可信"""
    try:
        from platform_v8.storage import db as db_mod
        from platform_v8.storage.repo import WorkerRepo
        with db_mod.session_scope() as s:
            w = WorkerRepo.by_id(s, str(worker_id))
            if w is None:
                return False
            return int(getattr(w, "rep_main", 60) or 60) >= MIN_REPUTATION_MAIN
    except Exception:
        return True   # fail-safe · 异常时默认信任 (不阻塞业务)
