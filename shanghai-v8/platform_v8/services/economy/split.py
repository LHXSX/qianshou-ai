"""
任务 budget 三方分润 (移植自 super_engine_v2/economy/settlement.py · 适配 v8 模型)

设计:
  workload.budget = 用户付的总金额 (GMV)
  ↓
  按 ratio 切三份:
    client_pool   = GMV * 65%  → 给节点 owners (按贡献二次分配)
    channel_pool  = GMV *  5%  → 给渠道账号 (固定)
    platform_pool = GMV * 30%  → 给平台账号 (固定)
  ↓
  client_pool 再按节点贡献分:
    weight = shard_count × quality(0-1) × reputation(0-1) × risk(0-1)
    每节点 owner 拿 client_pool × (own_weight / total_weight)

配置 (env):
  V8_SETTLEMENT_CLIENT_RATIO    = 0.65
  V8_SETTLEMENT_PLATFORM_RATIO  = 0.30
  V8_SETTLEMENT_CHANNEL_RATIO   = 0.05
  V8_PLATFORM_ACCOUNT_ID        = 1     (默认 admin)
  V8_CHANNEL_ACCOUNT_ID         = 0     (0 = 没渠道账号 · 那 5% 也归平台)
"""
from __future__ import annotations
import logging
import os
from dataclasses import dataclass, field
from decimal import Decimal

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SplitConfig:
    client_ratio: Decimal = Decimal("0.65")
    platform_ratio: Decimal = Decimal("0.30")
    channel_ratio: Decimal = Decimal("0.05")
    platform_account_id: int = 1
    channel_account_id: int = 0  # 0 = 无渠道 · 这 5% 并入 platform


def _resolve_platform_account_id() -> int:
    """优先取 env · 没设的话动态查第一个 admin 账户 · 兜底返 1

    2026-05-25 · 抽到 services/auth/admin_lookup.py · 给 deps.py 一起复用
    防 deps.py 和 split.py 两边硬编码不一致 (P0 bug)
    """
    from platform_v8.services.auth.admin_lookup import resolve_admin_account_id
    return resolve_admin_account_id()


def load_config_from_env() -> SplitConfig:
    return SplitConfig(
        client_ratio=Decimal(os.environ.get("V8_SETTLEMENT_CLIENT_RATIO", "0.65")),
        platform_ratio=Decimal(os.environ.get("V8_SETTLEMENT_PLATFORM_RATIO", "0.30")),
        channel_ratio=Decimal(os.environ.get("V8_SETTLEMENT_CHANNEL_RATIO", "0.05")),
        platform_account_id=_resolve_platform_account_id(),
        channel_account_id=int(os.environ.get("V8_CHANNEL_ACCOUNT_ID", "0")),
    )


@dataclass
class NodeContribution:
    """单节点贡献"""
    worker_id: str
    owner_id: int
    shard_count: int = 1                 # 跑了几片
    quality: Decimal = Decimal("1.0")    # 0-1 · 当前 v8 默认 1.0 (没 verifier)
    reputation: Decimal = Decimal("0.5") # 来自 Worker.reputation
    risk: Decimal = Decimal("1.0")       # 0-1 · 反作弊系数 · 当前 1.0


@dataclass
class SplitResult:
    """分润结果"""
    gmv: Decimal
    client_pool: Decimal
    platform_pool: Decimal
    channel_pool: Decimal
    # 节点收益明细 [(owner_id, amount), ...]
    node_payouts: list[tuple[int, Decimal]] = field(default_factory=list)


def compute_split(
    budget: Decimal,
    contributions: list[NodeContribution],
    config: SplitConfig | None = None,
) -> SplitResult:
    """
    把 workload.budget 按三方分润 + 节点二次分配

    返回 SplitResult · 由调用方写 ledger (reward/platform_revenue/channel_revenue)
    """
    cfg = config or load_config_from_env()
    # 渠道账号缺失时 · 渠道份额并入平台
    if cfg.channel_account_id == 0:
        effective_platform_ratio = cfg.platform_ratio + cfg.channel_ratio
        effective_channel_ratio = Decimal("0")
    else:
        effective_platform_ratio = cfg.platform_ratio
        effective_channel_ratio = cfg.channel_ratio

    gmv = Decimal(budget)
    client_pool = (gmv * cfg.client_ratio).quantize(Decimal("0.0001"))
    platform_pool = (gmv * effective_platform_ratio).quantize(Decimal("0.0001"))
    channel_pool = (gmv * effective_channel_ratio).quantize(Decimal("0.0001"))

    # 节点二次分配 (按贡献权重)
    if not contributions:
        return SplitResult(
            gmv=gmv, client_pool=client_pool,
            platform_pool=platform_pool, channel_pool=channel_pool,
        )

    weights: list[Decimal] = []
    for c in contributions:
        w = (Decimal(c.shard_count) * c.quality * c.reputation * c.risk)
        weights.append(w if w > 0 else Decimal("0"))
    total_w = sum(weights)

    payouts: list[tuple[int, Decimal]] = []
    if total_w <= 0:
        # 全是 0 权重 · 平均分 (兜底)
        per = (client_pool / len(contributions)).quantize(Decimal("0.0001"))
        for c in contributions:
            payouts.append((c.owner_id, per))
    else:
        for c, w in zip(contributions, weights):
            amount = (client_pool * w / total_w).quantize(Decimal("0.0001"))
            payouts.append((c.owner_id, amount))

    # 合并同 owner_id (一个 owner 多个节点)
    by_owner: dict[int, Decimal] = {}
    for owner_id, amt in payouts:
        by_owner[owner_id] = by_owner.get(owner_id, Decimal("0")) + amt
    node_payouts = list(by_owner.items())

    return SplitResult(
        gmv=gmv,
        client_pool=client_pool,
        platform_pool=platform_pool,
        channel_pool=channel_pool,
        node_payouts=node_payouts,
    )
