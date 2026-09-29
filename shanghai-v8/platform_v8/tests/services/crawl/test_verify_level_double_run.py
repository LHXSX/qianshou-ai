"""
W4-phase2 · verify_level=2 双跑机制单测 (2026-05-26)

覆盖:
  - orders._create_unified_workload_for_crawl_order · verify_level=1 → 不复制 (N 个 shard)
  - orders._create_unified_workload_for_crawl_order · verify_level=2 → 复制 (2N 个 shard)
  - aggregator_hook._hash_compare_siblings · hash 一致/不一致
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

from platform_v8.services.crawl.orders import _create_unified_workload_for_crawl_order
from platform_v8.services.crawl.schemas import OrderIn, OrderQuoteOut
from platform_v8.services.crawl import aggregator_hook as hook


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


def _recipe_row() -> dict:
    return {"id": 1, "datasource_id": 2, "parser_type": "json"}


# ════════════════════════════════════════════════════════════════
# orders · verify_level=1 (单跑)
# ════════════════════════════════════════════════════════════════
def test_verify_level_1_no_replica():
    """verify_level=1 · redundancy=1 · 3 个 params → 3 个 shard · 每个无 replica_of(=self)"""
    fake_session = MagicMock()
    order_in = _make_order_in(total_count=3, verify_level=1)
    params_list = [{"u": f"x{i}"} for i in range(3)]

    with patch("platform_v8.storage.repo.WorkloadRepo.create") as mock_wl, \
         patch("platform_v8.storage.repo.ShardRepo.create_batch") as mock_sh:
        _create_unified_workload_for_crawl_order(
            fake_session,
            order_id=1,
            customer_id=1,
            recipe_row=_recipe_row(),
            quote=_make_quote("3.00"),
            order_in=order_in,
            params_list=params_list,
        )

    wl = mock_wl.call_args[0][1]
    assert wl.spec.redundancy_factor == 1
    assert wl.total_shards == 3

    shards = mock_sh.call_args[0][1]
    assert len(shards) == 3
    # 每个都是 canonical · replica_of 指向自己 · replica_index=0
    for sh in shards:
        assert sh.metadata["replica_index"] == 0
        assert sh.metadata["replica_of"] == sh.id  # canonical 指向自己


# ════════════════════════════════════════════════════════════════
# orders · verify_level=2 (双跑)
# ════════════════════════════════════════════════════════════════
def test_verify_level_2_replicates_shards():
    """verify_level=2 · redundancy=2 · 3 params → 6 shard (3 canonical + 3 replica)"""
    fake_session = MagicMock()
    order_in = _make_order_in(total_count=3, verify_level=2)
    params_list = [{"u": f"x{i}"} for i in range(3)]

    with patch("platform_v8.storage.repo.WorkloadRepo.create") as mock_wl, \
         patch("platform_v8.storage.repo.ShardRepo.create_batch") as mock_sh:
        _create_unified_workload_for_crawl_order(
            fake_session,
            order_id=10,
            customer_id=1,
            recipe_row=_recipe_row(),
            quote=_make_quote("10.00"),
            order_in=order_in,
            params_list=params_list,
        )

    wl = mock_wl.call_args[0][1]
    assert wl.spec.redundancy_factor == 2
    assert wl.total_shards == 6  # 3×2

    shards = mock_sh.call_args[0][1]
    assert len(shards) == 6

    # 按 (crawl_seq, replica_index) 分组验证
    grouped = {}  # crawl_seq → list of (replica_index, id, replica_of)
    for sh in shards:
        seq = sh.metadata["crawl_seq"]
        grouped.setdefault(seq, []).append(
            (sh.metadata["replica_index"], sh.id, sh.metadata["replica_of"])
        )

    assert sorted(grouped.keys()) == [0, 1, 2]
    for seq, replicas in grouped.items():
        assert len(replicas) == 2
        # replica_index 一个 0 一个 1
        indices = sorted(r[0] for r in replicas)
        assert indices == [0, 1]
        # 同 canonical (replica_of 一致 · 指向 index=0 的 id)
        canonical_id = next(r[1] for r in replicas if r[0] == 0)
        for replica_index, shard_id, replica_of in replicas:
            assert replica_of == canonical_id, f"seq={seq} replica={replica_index}"


# ════════════════════════════════════════════════════════════════
# hash_compare_siblings · 一致/不一致
# ════════════════════════════════════════════════════════════════
def test_hash_compare_siblings_consistent():
    """两副本 hash 一致 · consistent=True"""
    done = [
        {
            "id": "a", "status": "DONE",
            "output_ref": '{"result_hash":"abc","result_oss_url":"oss://a","result_size_bytes":10}',
            "lease_by_node": "node-1",
            "metadata": {"replica_index": 0},
        },
        {
            "id": "b", "status": "DONE",
            "output_ref": '{"result_hash":"abc","result_oss_url":"oss://b","result_size_bytes":10}',
            "lease_by_node": "node-2",
            "metadata": {"replica_index": 1},
        },
    ]
    verdict = hook._hash_compare_siblings(done)
    assert verdict["consistent"] is True
    assert verdict["primary"]["worker_id"] == "node-1"
    assert verdict["verify"]["worker_id"] == "node-2"


def test_hash_compare_siblings_mismatch():
    """两副本 hash 不一致 · consistent=False"""
    done = [
        {
            "id": "a", "status": "DONE",
            "output_ref": '{"result_hash":"abc"}',
            "lease_by_node": "node-1",
            "metadata": {"replica_index": 0},
        },
        {
            "id": "b", "status": "DONE",
            "output_ref": '{"result_hash":"xyz"}',
            "lease_by_node": "node-2",
            "metadata": {"replica_index": 1},
        },
    ]
    verdict = hook._hash_compare_siblings(done)
    assert verdict["consistent"] is False


def test_hash_compare_siblings_empty_hash():
    """空 hash · consistent=False (避免空 hash 蒙混)"""
    done = [
        {"id": "a", "status": "DONE", "output_ref": "", "lease_by_node": "n1",
         "metadata": {"replica_index": 0}},
        {"id": "b", "status": "DONE", "output_ref": "", "lease_by_node": "n2",
         "metadata": {"replica_index": 1}},
    ]
    verdict = hook._hash_compare_siblings(done)
    assert verdict["consistent"] is False


def test_hash_compare_siblings_orders_by_replica_index():
    """primary=replica_index=0 · verify=replica_index=1 · 排序保证 (即使输入乱序)"""
    done = [
        # 故意把 index=1 先放
        {"id": "b", "status": "DONE", "output_ref": '{"result_hash":"h"}',
         "lease_by_node": "verify-node", "metadata": {"replica_index": 1}},
        {"id": "a", "status": "DONE", "output_ref": '{"result_hash":"h"}',
         "lease_by_node": "primary-node", "metadata": {"replica_index": 0}},
    ]
    verdict = hook._hash_compare_siblings(done)
    assert verdict["primary"]["worker_id"] == "primary-node"
    assert verdict["verify"]["worker_id"] == "verify-node"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
