"""
engine/capability_feedback.py · 能力反馈层 (2026-06-02)

解决: 节点"声称"有能力(装了 tier / 报了 software)但实际跑不动某 task_type
      (机器不达标 / 依赖坏 / 模型缺失) → 任务被反复派给它 → 一直失败。

机制(全部 `nce_capability_feedback` flag 门控 · 默认 OFF · OFF 时全部 no-op):
  1. 学习型 per-(task_type, worker) 不胜任:
     - 某节点连续/近窗口内失败某 task_type 达阈值 → 标记冷却 (Redis TTL)。
     - 冷却期内 planner 不再把该 task_type 派给它 (推/拉两路统一)。
     - 成功一次即清零计数 (容忍偶发抖动 · 只惩罚"持续跑不动")。
  2. 调度器据此过滤候选 · 配合 shard 级 excluded_workers (失败即排除该片该节点)。

依赖只向内: 本层只用 Redis(kv) + flag · 不认识 WS/进程。Redis 挂 → 降级放行(不惩罚)。
"""
from __future__ import annotations
import logging

logger = logging.getLogger(__name__)

_FLAG = "nce_capability_feedback"

_CNT_PREFIX = "v8:capfail:"      # 失败计数 v8:capfail:<task_type>:<worker> (滑窗 TTL)
_COOLDOWN_PREFIX = "v8:incap:"   # 不胜任冷却 v8:incap:<task_type>:<worker>

FAIL_THRESHOLD = 2               # 近窗口内失败 N 次 → 判定该节点暂不胜任此 task_type
CNT_WINDOW_S = 1800              # 失败计数滑窗 (30 min · 无新失败则衰减过期)
COOLDOWN_S = 1800                # 不胜任冷却时长 (30 min · 到期自动恢复重试)


def enabled() -> bool:
    try:
        from platform_v8.services.ops import feature_flags as ff
        return ff.is_enabled(_FLAG, subject_id=None)
    except Exception:
        return False


def _redis():
    try:
        from platform_v8.storage import kv as kv_mod
        return kv_mod.get_redis()
    except Exception:
        return None


def _cnt_key(task_type: str, worker_id: str) -> str:
    return f"{_CNT_PREFIX}{task_type}:{worker_id}"


def _cd_key(task_type: str, worker_id: str) -> str:
    return f"{_COOLDOWN_PREFIX}{task_type}:{worker_id}"


def record_failure(task_type: str, worker_id: str) -> bool:
    """记一次"节点 worker 跑 task_type 失败"。
       近窗口内累计达阈 → 置不胜任冷却。返 True=已置冷却(本次触发)。
       OFF / 无 task_type/worker / Redis 挂 → no-op 返 False。"""
    if not enabled() or not task_type or not worker_id:
        return False
    try:
        r = _redis()
        if r is None:
            return False
        ck = _cnt_key(task_type, worker_id)
        n = int(r.incr(ck) or 1)
        if n == 1:
            r.expire(ck, CNT_WINDOW_S)
        if n >= FAIL_THRESHOLD:
            r.set(_cd_key(task_type, worker_id), str(n), ex=COOLDOWN_S)
            logger.warning("capfeedback · 节点=%s 连续失败 task=%s %d次 · 标记不胜任冷却 %ds",
                           str(worker_id)[:8], task_type, n, COOLDOWN_S)
            return True
        return False
    except Exception as exc:
        logger.debug("capfeedback.record_failure fail: %s", exc)
        return False


def record_success(task_type: str, worker_id: str) -> None:
    """节点成功跑一次 task_type → 清失败计数 + 解除冷却 (容忍偶发抖动)。OFF → no-op。"""
    if not enabled() or not task_type or not worker_id:
        return
    try:
        r = _redis()
        if r is not None:
            r.delete(_cnt_key(task_type, worker_id), _cd_key(task_type, worker_id))
    except Exception as exc:
        logger.debug("capfeedback.record_success fail: %s", exc)


def is_incapable(task_type: str, worker_id: str) -> bool:
    """该节点是否在 task_type 的不胜任冷却期内。OFF / Redis 挂 → False(放行·不误杀)。"""
    if not enabled() or not task_type or not worker_id:
        return False
    try:
        r = _redis()
        if r is None:
            return False
        return r.exists(_cd_key(task_type, worker_id)) > 0
    except Exception:
        return False


def filter_capable(task_type: str, worker_ids: list[str]) -> list[str]:
    """从候选里剔除当前对 task_type 不胜任(冷却中)的节点。OFF → 原样返回。"""
    if not enabled() or not task_type or not worker_ids:
        return list(worker_ids)
    try:
        r = _redis()
        if r is None:
            return list(worker_ids)
        keep, dropped = [], []
        for wid in worker_ids:
            if r.exists(_cd_key(task_type, str(wid))) > 0:
                dropped.append(str(wid)[:8])
            else:
                keep.append(wid)
        if dropped:
            logger.info("capfeedback · task=%s 跳过不胜任节点 %s", task_type, dropped)
        return keep
    except Exception:
        return list(worker_ids)
