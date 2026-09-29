"""账户等级 / tier 倍率（调度优先 + 结算加价共用）。

等级按 we_accounts.balance 划分，与 /my/profile、概览 KPI 展示一致。
倍率范围 1.0 ~ 1.5；调度用乘性 boost，结算对节点分润加价（差额从平台/渠道池拨出）。
"""
from __future__ import annotations

from decimal import Decimal


def calc_level(balance: float) -> tuple[int, str, float]:
    """根据余额算 (level, tier, multiplier)。"""
    bal = float(balance or 0)
    if bal < 100:
        return (1, "basic", 1.0)
    if bal < 500:
        return (2, "bronze", 1.1)
    if bal < 2000:
        return (3, "silver", 1.2)
    if bal < 10000:
        return (4, "gold", 1.3)
    return (5, "diamond", 1.5)


def multiplier_for_balance(balance: float) -> float:
    return calc_level(balance)[2]


def boost_node_payouts(
    node_payouts: list[tuple[int, Decimal]],
    owner_balances: dict[int, float],
    platform_pool: Decimal,
    channel_pool: Decimal,
) -> tuple[list[tuple[int, Decimal]], Decimal, Decimal]:
    """节点分润 × tier 倍率；加价部分优先从 platform_pool、再从 channel_pool 拨出。

    若平台+渠道池不够覆盖全部加价，则按比例缩放到可拨额度，避免超发 escrow。
    返回 (boosted_payouts, new_platform_pool, new_channel_pool)。
    """
    if not node_payouts:
        return list(node_payouts), platform_pool, channel_pool

    desired: list[tuple[int, Decimal, Decimal]] = []  # owner, base, desired
    for owner_id, amount in node_payouts:
        if amount <= 0:
            desired.append((owner_id, amount, amount))
            continue
        mult = Decimal(str(multiplier_for_balance(owner_balances.get(int(owner_id), 0.0))))
        want = (amount * mult).quantize(Decimal("0.0001"))
        desired.append((owner_id, amount, want))

    extras = [(oid, want - base) for oid, base, want in desired if want > base]
    total_extra = sum((e for _, e in extras), Decimal("0"))
    if total_extra <= 0:
        return [(oid, want) for oid, _, want in desired], platform_pool, channel_pool

    available = platform_pool + channel_pool
    if available <= 0:
        return [(oid, base) for oid, base, _ in desired], platform_pool, channel_pool

    scale = Decimal("1")
    if total_extra > available:
        scale = (available / total_extra).quantize(Decimal("0.0000001"))

    funded = Decimal("0")
    out: list[tuple[int, Decimal]] = []
    for oid, base, want in desired:
        extra = want - base
        if extra <= 0 or scale <= 0:
            out.append((oid, base))
            continue
        applied = (extra * scale).quantize(Decimal("0.0001"))
        funded += applied
        out.append((oid, base + applied))

    # 从 platform 再 channel 扣
    remain = funded
    take_plat = min(platform_pool, remain)
    new_plat = platform_pool - take_plat
    remain -= take_plat
    take_chan = min(channel_pool, remain)
    new_chan = channel_pool - take_chan

    return out, new_plat, new_chan
