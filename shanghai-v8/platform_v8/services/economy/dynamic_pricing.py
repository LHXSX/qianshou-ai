"""
NCE P4.14 · 价格自适应

设计要点 (考虑全链路):
  1. 实时根据供需调价 (供过于求 ↓ · 求过于供 ↑)
  2. 输入: 在线节点数 + 队列长度 + task_type
  3. 输出: 基准价 × 乘数 (0.7-1.5 区间)
  4. 时间衰减: 极端比例 1 小时内逐步回归 1.0
  5. fail-safe: 异常返 1.0 (默认价不调)
  
  公式 (P4 简化版):
    supply_ratio = online_workers / max_workers_target
    demand_ratio = pending_shards / online_workers
    
    if demand >> supply:    # 求过于供 (排队)
        multiplier = 1.0 + min(0.5, demand * 0.1)   # 加价 · 上限 1.5
    elif supply >> demand:  # 供过于求 (闲)
        multiplier = max(0.7, 1.0 - supply * 0.05)  # 降价 · 下限 0.7
    else:
        multiplier = 1.0
  
  应用:
    - workload 提交时算预算 (estimate_cost)
    - admin 看实时供需比 + 价格曲线
"""
from __future__ import annotations
import logging
import time
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# ════════════════════════════════════════════════════════════════════════════
# 参数 (P4 拍 · P5 看真实经济数据调)
# ════════════════════════════════════════════════════════════════════════════

PRICE_FLOOR = 0.7         # 价格乘数下限 (再低节点不接 · 平台跑不起来)
PRICE_CEILING = 1.5       # 价格乘数上限 (再高客户不接 · 转其他平台)
PRICE_NEUTRAL = 1.0

# 触发调价的阈值
DEMAND_HIGH_RATIO = 2.0   # pending / online > 2 → 加价
SUPPLY_HIGH_RATIO = 5.0   # online / pending > 5 → 降价

# 缓存 TTL (避免高频重算)
_CACHE_TTL_S = 60
_pricing_cache: tuple[float, "PricingDecision"] | None = None


# ════════════════════════════════════════════════════════════════════════════
# 数据模型
# ════════════════════════════════════════════════════════════════════════════

@dataclass
class PricingDecision:
    multiplier: float
    reason: str
    supply_count: int        # online 节点数
    demand_count: int        # pending shard 数
    supply_demand_ratio: float
    timestamp: float


# ════════════════════════════════════════════════════════════════════════════
# 算实时价格乘数
# ════════════════════════════════════════════════════════════════════════════

def calculate_multiplier(force_refresh: bool = False) -> PricingDecision:
    """
    算当前价格乘数 · 60s 缓存
    
    Returns: PricingDecision(multiplier 在 0.7-1.5 之间)
    """
    global _pricing_cache

    if not force_refresh and _pricing_cache:
        ts, decision = _pricing_cache
        if time.time() - ts < _CACHE_TTL_S:
            return decision

    try:
        decision = _do_calculate()
        _pricing_cache = (time.time(), decision)
        return decision
    except Exception as exc:
        logger.warning("dynamic_pricing fail · 返中性价 · err=%s", exc)
        return PricingDecision(
            multiplier=PRICE_NEUTRAL,
            reason=f"error_fallback: {exc}",
            supply_count=0, demand_count=0,
            supply_demand_ratio=1.0,
            timestamp=time.time(),
        )


def _do_calculate() -> PricingDecision:
    from sqlalchemy import text
    from platform_v8.storage import db as db_mod

    with db_mod.session_scope() as s:
        # supply = ONLINE/BUSY 节点数
        supply = s.execute(
            text("SELECT COUNT(*) FROM we_workers WHERE status IN ('ONLINE','BUSY')")
        ).scalar() or 0

        # demand = PENDING shard 数 + 最近 10min RUNNING workload 数
        demand_pending = s.execute(
            text("SELECT COUNT(*) FROM we_shards WHERE status = 'PENDING'")
        ).scalar() or 0
        demand_running = s.execute(
            text("""
                SELECT COUNT(*) FROM we_workloads 
                WHERE status = 'RUNNING' 
                  AND created_at > NOW() - INTERVAL '10 minutes'
            """)
        ).scalar() or 0
        demand = int(demand_pending) + int(demand_running)

    supply = int(supply)

    if supply == 0:
        # 没节点 · 价格不调 (不重要 · 派不出去)
        return PricingDecision(
            multiplier=PRICE_NEUTRAL,
            reason="no_workers_online",
            supply_count=0, demand_count=demand,
            supply_demand_ratio=0.0,
            timestamp=time.time(),
        )

    if demand == 0:
        # 没需求 · 降价吸引 (上限不动)
        ratio = supply / 1   # 无穷大 · 走 supply_high
        multiplier = max(PRICE_FLOOR, PRICE_NEUTRAL - min(0.3, supply * 0.02))
        return PricingDecision(
            multiplier=round(multiplier, 3),
            reason=f"no_demand · supply={supply} · 降价吸引",
            supply_count=supply, demand_count=0,
            supply_demand_ratio=999.0,
            timestamp=time.time(),
        )

    sd_ratio = supply / demand
    ds_ratio = demand / supply

    if ds_ratio >= DEMAND_HIGH_RATIO:
        # 求过于供 → 加价
        excess = (ds_ratio - DEMAND_HIGH_RATIO) / DEMAND_HIGH_RATIO
        multiplier = min(PRICE_CEILING, PRICE_NEUTRAL + 0.2 + excess * 0.2)
        reason = f"high_demand · {demand} pending / {supply} workers (ratio {ds_ratio:.2f})"
    elif sd_ratio >= SUPPLY_HIGH_RATIO:
        # 供过于求 → 降价
        excess = (sd_ratio - SUPPLY_HIGH_RATIO) / SUPPLY_HIGH_RATIO
        multiplier = max(PRICE_FLOOR, PRICE_NEUTRAL - 0.15 - excess * 0.05)
        reason = f"high_supply · {supply} workers / {demand} pending (ratio {sd_ratio:.2f})"
    else:
        multiplier = PRICE_NEUTRAL
        reason = f"balanced · supply={supply} demand={demand}"

    return PricingDecision(
        multiplier=round(multiplier, 3),
        reason=reason,
        supply_count=supply, demand_count=demand,
        supply_demand_ratio=round(sd_ratio, 3),
        timestamp=time.time(),
    )


def apply_to_base_price(base_price: float, task_type: str | None = None) -> dict:
    """
    给一个基准价应用动态乘数
    
    Returns:
        {base, multiplier, final, reason}
    """
    decision = calculate_multiplier()
    return {
        "base_price": round(base_price, 4),
        "multiplier": decision.multiplier,
        "final_price": round(base_price * decision.multiplier, 4),
        "task_type": task_type,
        "reason": decision.reason,
        "supply_count": decision.supply_count,
        "demand_count": decision.demand_count,
    }
