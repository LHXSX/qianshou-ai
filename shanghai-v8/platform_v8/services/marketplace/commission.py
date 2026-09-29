"""应用市场 / 出借抽成结算。"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

# 与计划锁定一致
PLATFORM_APP_SHARE = Decimal("0.20")       # 应用市场平台 20%
DEVELOPER_APP_SHARE = Decimal("0.80")
PLATFORM_LENDING_SHARE = Decimal("0.28")   # 出借差价平台 25–30% 取中
LENDER_SHARE = Decimal("0.72")


def split_app_revenue(gross: Decimal | float | str) -> dict[str, Decimal]:
    """应用一次付费/按次：平台 20% · 开发者 80%。"""
    g = Decimal(str(gross)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    platform = (g * PLATFORM_APP_SHARE).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    developer = (g - platform).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return {"gross": g, "platform": platform, "developer": developer}


def split_lending_revenue(gross: Decimal | float | str) -> dict[str, Decimal]:
    """出借核时收益：平台 28% · 矿主 72%。"""
    g = Decimal(str(gross)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    platform = (g * PLATFORM_LENDING_SHARE).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    lender = (g - platform).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return {"gross": g, "platform": platform, "lender": lender}


def auto_lending_rate_per_hour(*, cpu_cores: int = 2, gpu: bool = False) -> Decimal:
    """auto 定价：按核时粗算（EDG/小时）。"""
    base = Decimal("0.08") * max(1, int(cpu_cores))
    if gpu:
        base += Decimal("0.40")
    return base.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
