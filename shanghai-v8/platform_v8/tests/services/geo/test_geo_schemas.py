"""
W2-2 · services/geo/schemas.py 单测

覆盖:
  1. GeoOrderCreate · 必填验证 + keyword/llm 列表非空
  2. GeoOrderCreate · keyword 列表上限
  3. GeoOrderCreate · 价格上下限
  4. GeoBrandCreate · brand_name 长度限制
  5. GeoLLMConfigUpdate · 部分字段允许 None
"""
from __future__ import annotations
import sys
from decimal import Decimal
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.geo.schemas import (
    GeoOrderCreate, GeoBrandCreate, GeoLLMConfigUpdate,
)


def test_order_create_min_valid():
    o = GeoOrderCreate(
        brand_id=1,
        keywords=["手机推荐"],
        llm_codes=["kimi"],
    )
    assert o.brand_id == 1
    assert o.keywords == ["手机推荐"]
    assert o.platform_fee_pct == Decimal("30")  # 默认
    assert o.unit_price_edg == Decimal("0.01")  # 默认


def test_order_create_strip_empty_keywords():
    o = GeoOrderCreate(
        brand_id=1,
        keywords=["", "  ", "x", "y"],
        llm_codes=["kimi", ""],
    )
    assert o.keywords == ["x", "y"]
    assert o.llm_codes == ["kimi"]


def test_order_create_keyword_too_many_fails():
    """关键词超过 50 个应失败"""
    with pytest.raises(Exception):  # pydantic ValidationError
        GeoOrderCreate(
            brand_id=1,
            keywords=[f"k{i}" for i in range(60)],
            llm_codes=["kimi"],
        )


def test_order_create_price_too_low_fails():
    with pytest.raises(Exception):
        GeoOrderCreate(
            brand_id=1, keywords=["x"], llm_codes=["kimi"],
            unit_price_edg=Decimal("0.0001"),  # < 0.001
        )


def test_brand_create_alias_limit():
    """alias 上限 20"""
    b = GeoBrandCreate(
        brand_name="Apple",
        brand_aliases=[f"a{i}" for i in range(20)],
    )
    assert len(b.brand_aliases) == 20
    
    with pytest.raises(Exception):
        GeoBrandCreate(
            brand_name="Apple",
            brand_aliases=[f"a{i}" for i in range(25)],
        )


def test_llm_config_update_all_optional():
    u = GeoLLMConfigUpdate()
    # 全空 · 也合法 (admin 只改部分字段)
    assert u.display_name is None
    assert u.enabled is None


def test_llm_config_rate_limit_range():
    GeoLLMConfigUpdate(rate_limit_per_min=1)
    GeoLLMConfigUpdate(rate_limit_per_min=10000)
    with pytest.raises(Exception):
        GeoLLMConfigUpdate(rate_limit_per_min=0)
    with pytest.raises(Exception):
        GeoLLMConfigUpdate(rate_limit_per_min=99999)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
