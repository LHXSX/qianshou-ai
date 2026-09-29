"""
crawl orders · 算价单元测试 (纯函数 · 无需 DB)
"""
from decimal import Decimal

import pytest

from platform_v8.services.crawl.orders import compute_quote
from platform_v8.services.crawl.schemas import OrderQuoteOut


def test_quote_basic_1of1_normal():
    out = compute_quote(
        recipe_id=1,
        unit_price_edg=Decimal("0.05"),
        total_count=100,
        verify_level=1,
        priority=0,
    )
    assert isinstance(out, OrderQuoteOut)
    assert out.final_unit_price_edg == Decimal("0.0500")
    assert out.total_price_edg == Decimal("5.00")
    assert out.verify_multiplier == Decimal("1.0")
    assert out.priority_multiplier == Decimal("1.0")
    # 节点拿 85% (0.05 * 0.85 = 0.0425)
    assert out.node_payout_per_subtask == Decimal("0.0425")


def test_quote_2of2_with_priority():
    out = compute_quote(
        recipe_id=1,
        unit_price_edg=Decimal("0.10"),
        total_count=50,
        verify_level=2,
        priority=1,
    )
    # 0.10 * 1.95 * 2.0 = 0.39
    assert out.final_unit_price_edg == Decimal("0.3900")
    assert out.total_price_edg == Decimal("19.50")


def test_quote_zero_count_raises():
    with pytest.raises(ValueError, match="total_count"):
        compute_quote(
            recipe_id=1,
            unit_price_edg=Decimal("0.05"),
            total_count=0,
            verify_level=1,
            priority=0,
        )


def test_quote_invalid_verify_raises():
    with pytest.raises(ValueError, match="verify_level"):
        compute_quote(
            recipe_id=1,
            unit_price_edg=Decimal("0.05"),
            total_count=10,
            verify_level=99,
            priority=0,
        )


def test_quote_invalid_priority_raises():
    with pytest.raises(ValueError, match="priority"):
        compute_quote(
            recipe_id=1,
            unit_price_edg=Decimal("0.05"),
            total_count=10,
            verify_level=1,
            priority=99,
        )
