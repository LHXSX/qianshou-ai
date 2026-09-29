"""
W4-D2 · _create_unified_workload_for_crawl_order 单测 (2026-05-26)

只验:
  - WorkloadRepo.create 调用一次 (workload_id 格式 + spec.task_type + budget)
  - ShardRepo.create_batch 调用一次 · 长度 = total_count · 每个 mode=PULL/status=PENDING
  - shard.metadata 含 business=crawl + crawl_order_id + crawl_seq + params

不验真 DB · 用 MagicMock 拦截 Repo.create*
"""
from __future__ import annotations
import sys
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.crawl.orders import (
    _create_unified_workload_for_crawl_order,
    _resolve_crawl_subtask_script_url,
)
from platform_v8.services.crawl.schemas import OrderIn, OrderQuoteOut


def _make_quote(total_price: str = "10.00") -> OrderQuoteOut:
    return OrderQuoteOut(
        recipe_id=1,
        total_count=3,
        unit_price_edg=Decimal("1.0"),
        verify_multiplier=Decimal("1.0"),
        priority_multiplier=Decimal("1.0"),
        final_unit_price_edg=Decimal("1.0"),
        total_price_edg=Decimal(total_price),
        platform_fee_pct=Decimal("15.00"),
        node_payout_per_subtask=Decimal("0.85"),
    )


def _make_order_in(total_count: int = 3, verify_level: int = 1) -> OrderIn:
    return OrderIn(
        recipe_id=1,
        title="测试订单",
        total_count=total_count,
        concurrency=2,
        verify_level=verify_level,
        priority=0,
        params_oss_url="https://oss.example.com/params.csv",
        webhook_url="",
        consent_signature="x" * 32,
    )


def test_resolve_script_url_default():
    """env 未设 · 返相对路径"""
    import os
    old = os.environ.pop("V8_PUBLIC_BASE_URL", None)
    old2 = os.environ.pop("PUBLIC_API_BASE", None)
    try:
        assert _resolve_crawl_subtask_script_url() == "/api/v8/scripts/crawl_subtask.py"
    finally:
        if old is not None:
            os.environ["V8_PUBLIC_BASE_URL"] = old
        if old2 is not None:
            os.environ["PUBLIC_API_BASE"] = old2


def test_resolve_script_url_with_env():
    import os
    os.environ["V8_PUBLIC_BASE_URL"] = "https://api.example.com"
    try:
        url = _resolve_crawl_subtask_script_url()
        assert url == "https://api.example.com/api/v8/scripts/crawl_subtask.py"
    finally:
        os.environ.pop("V8_PUBLIC_BASE_URL")


def test_create_unified_workload_basic():
    """正常 path · 调一次 WorkloadRepo.create + 一次 ShardRepo.create_batch"""
    fake_session = MagicMock()
    quote = _make_quote("10.00")
    order_in = _make_order_in(total_count=3)
    recipe_row = {
        "id": 1,
        "datasource_id": 2,
        "parser_type": "json",
    }
    params_list = [
        {"url": f"https://x.com/{i}"} for i in range(3)
    ]

    with patch("platform_v8.storage.repo.WorkloadRepo.create") as mock_wl_create, \
         patch("platform_v8.storage.repo.ShardRepo.create_batch") as mock_sh_batch:
        _create_unified_workload_for_crawl_order(
            fake_session,
            order_id=42,
            customer_id=100,
            recipe_row=recipe_row,
            quote=quote,
            order_in=order_in,
            params_list=params_list,
        )

    # WorkloadRepo.create 调一次
    mock_wl_create.assert_called_once()
    wl = mock_wl_create.call_args[0][1]
    assert wl.id == "crawl_order_42"
    assert wl.owner_id == 100
    assert wl.name == "测试订单"
    assert wl.spec.task_type == "crawl_subtask"
    assert wl.spec.input_kind == "params_only"
    assert wl.spec.code_url.endswith("/crawl_subtask.py")
    assert wl.budget == Decimal("10.00")
    assert wl.total_shards == 3
    # params 透传
    assert wl.spec.params["crawl_order_id"] == 42
    assert wl.spec.params["recipe_id"] == 1
    assert wl.spec.params["datasource_id"] == 2
    assert wl.spec.params["parser_type"] == "json"
    assert wl.spec.params["verify_level"] == 1

    # ShardRepo.create_batch 调一次 · 3 个 shard
    mock_sh_batch.assert_called_once()
    shards = mock_sh_batch.call_args[0][1]
    assert len(shards) == 3
    for i, sh in enumerate(shards):
        assert sh.workload_id == "crawl_order_42"
        assert sh.index == i
        assert sh.total == 3
        from platform_v8.core.enums import ShardStatus, ShardMode
        assert sh.status == ShardStatus.PENDING
        assert sh.mode == ShardMode.PULL
        assert sh.metadata["business"] == "crawl"
        assert sh.metadata["crawl_order_id"] == 42
        assert sh.metadata["crawl_seq"] == i
        assert sh.metadata["params"] == {"url": f"https://x.com/{i}"}


def test_create_unified_workload_empty_params():
    """params_list 为空 · workload 仍创 · 但 shards 不创"""
    fake_session = MagicMock()
    recipe_row = {"id": 1, "datasource_id": 2, "parser_type": "json"}

    with patch("platform_v8.storage.repo.WorkloadRepo.create") as mock_wl, \
         patch("platform_v8.storage.repo.ShardRepo.create_batch") as mock_sh:
        _create_unified_workload_for_crawl_order(
            fake_session,
            order_id=1,
            customer_id=1,
            recipe_row=recipe_row,
            quote=_make_quote("1.0"),
            order_in=_make_order_in(total_count=1),
            params_list=[],  # 空 · 不应该调 create_batch
        )
    mock_wl.assert_called_once()
    mock_sh.assert_not_called()


def test_create_unified_workload_name_fallback():
    """order_in.title 为空 · workload.name 用 fallback crawl_order_{id}"""
    fake_session = MagicMock()
    order_in = _make_order_in()
    order_in.title = ""
    recipe_row = {"id": 1, "datasource_id": 2, "parser_type": "html"}

    with patch("platform_v8.storage.repo.WorkloadRepo.create") as mock_wl, \
         patch("platform_v8.storage.repo.ShardRepo.create_batch"):
        _create_unified_workload_for_crawl_order(
            fake_session,
            order_id=99,
            customer_id=1,
            recipe_row=recipe_row,
            quote=_make_quote("3.0"),
            order_in=order_in,
            params_list=[{"a": 1}, {"b": 2}, {"c": 3}],
        )
    wl = mock_wl.call_args[0][1]
    assert wl.name == "crawl_order_99"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
