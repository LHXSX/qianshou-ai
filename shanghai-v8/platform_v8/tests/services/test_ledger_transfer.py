"""
W5-Step1 · ledger.transfer 单测 (2026-05-26)

覆盖:
  - transfer 写 3 条 ledger entry (客户 ESCROW_HOLD / 节点 REWARD / 平台 PLATFORM_FEE)
  - 平台 fee = 0 时不写第 3 条
  - 金额校验 / fee_pct 范围校验
  - 幂等键格式 (transfer:{wl_id}:{shard_id|all}:{role})
"""
from __future__ import annotations
import sys
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.economy import ledger
from platform_v8.core import LedgerType


# ════════════════════════════════════════════════════════════════
# 校验
# ════════════════════════════════════════════════════════════════
def test_transfer_rejects_zero_amount():
    fake_s = MagicMock()
    with pytest.raises(ValueError, match="total_amount 必须 > 0"):
        ledger.transfer(
            fake_s,
            client_account_id=1, worker_owner_id=2, platform_account_id=99,
            total_amount=Decimal("0"),
            platform_fee_pct=Decimal("15"),
            workload_id="proxy_test",
        )


def test_transfer_rejects_negative_amount():
    fake_s = MagicMock()
    with pytest.raises(ValueError, match="total_amount 必须 > 0"):
        ledger.transfer(
            fake_s,
            client_account_id=1, worker_owner_id=2, platform_account_id=99,
            total_amount=Decimal("-1"),
            platform_fee_pct=Decimal("15"),
            workload_id="proxy_test",
        )


def test_transfer_rejects_invalid_fee_pct():
    fake_s = MagicMock()
    for bad_pct in [Decimal("-1"), Decimal("101"), Decimal("200")]:
        with pytest.raises(ValueError, match="platform_fee_pct"):
            ledger.transfer(
                fake_s,
                client_account_id=1, worker_owner_id=2, platform_account_id=99,
                total_amount=Decimal("10"),
                platform_fee_pct=bad_pct,
                workload_id="proxy_test",
            )


# ════════════════════════════════════════════════════════════════
# 正常 3 条原子写入
# ════════════════════════════════════════════════════════════════
def test_transfer_writes_three_entries():
    """fee=15% · total=100 → 客户 -100 · 节点 +85 · 平台 +15"""
    fake_s = MagicMock()
    writes = []
    def _capture_write(_s, entry):
        writes.append(entry)

    with patch("platform_v8.services.economy.ledger.LedgerRepo.write",
               side_effect=_capture_write), \
         patch("platform_v8.services.economy.ledger._refresh_balance_cache"):
        result = ledger.transfer(
            fake_s,
            client_account_id=10,
            worker_owner_id=20,
            platform_account_id=99,
            total_amount=Decimal("100"),
            platform_fee_pct=Decimal("15"),
            workload_id="proxy_abc",
        )

    assert len(writes) == 3

    # 1. 客户扣钱
    client = writes[0]
    assert client.account_id == 10
    assert client.type == LedgerType.ESCROW_HOLD
    assert client.amount == Decimal("-100")
    assert client.workload_id == "proxy_abc"
    assert client.idempotent_key == "transfer:proxy_abc:all:client"

    # 2. 节点拿大头
    node = writes[1]
    assert node.account_id == 20
    assert node.type == LedgerType.REWARD
    assert node.amount == Decimal("85.0000")
    assert node.idempotent_key == "transfer:proxy_abc:all:node"

    # 3. 平台抽 fee
    platform = writes[2]
    assert platform.account_id == 99
    assert platform.type == LedgerType.PLATFORM_FEE
    assert platform.amount == Decimal("15.0000")
    assert platform.idempotent_key == "transfer:proxy_abc:all:platform"

    # 返值
    assert result["client_deducted"] == Decimal("100")
    assert result["node_paid"] == Decimal("85.0000")
    assert result["platform_fee"] == Decimal("15.0000")


def test_transfer_zero_fee_skips_platform_entry():
    """fee=0 · 只写 2 条 (客户 + 节点) · 不写平台"""
    fake_s = MagicMock()
    writes = []
    def _capture_write(_s, entry):
        writes.append(entry)

    with patch("platform_v8.services.economy.ledger.LedgerRepo.write",
               side_effect=_capture_write), \
         patch("platform_v8.services.economy.ledger._refresh_balance_cache"):
        result = ledger.transfer(
            fake_s,
            client_account_id=10,
            worker_owner_id=20,
            platform_account_id=99,
            total_amount=Decimal("100"),
            platform_fee_pct=Decimal("0"),
            workload_id="proxy_zero_fee",
        )

    assert len(writes) == 2  # 客户 + 节点 · 无平台
    assert writes[0].type == LedgerType.ESCROW_HOLD
    assert writes[1].type == LedgerType.REWARD
    assert writes[1].amount == Decimal("100.0000")  # 节点拿全部
    assert result["platform_fee"] == Decimal("0.0000")


def test_transfer_with_shard_id_in_idempotent_key():
    """shard_id 影响幂等键"""
    fake_s = MagicMock()
    writes = []
    with patch("platform_v8.services.economy.ledger.LedgerRepo.write",
               side_effect=lambda _s, e: writes.append(e)), \
         patch("platform_v8.services.economy.ledger._refresh_balance_cache"):
        ledger.transfer(
            fake_s,
            client_account_id=1, worker_owner_id=2, platform_account_id=99,
            total_amount=Decimal("10"),
            platform_fee_pct=Decimal("15"),
            workload_id="wl1",
            shard_id="sh-42",
        )

    assert writes[0].idempotent_key == "transfer:wl1:sh-42:client"
    assert writes[1].idempotent_key == "transfer:wl1:sh-42:node"
    assert writes[2].idempotent_key == "transfer:wl1:sh-42:platform"


def test_transfer_idempotent_conflict_swallowed():
    """重复调 (幂等冲突) · 仍然返回正确金额 · 不抛"""
    fake_s = MagicMock()
    from platform_v8.storage.repo import IdempotentConflict

    with patch("platform_v8.services.economy.ledger.LedgerRepo.write",
               side_effect=IdempotentConflict("dup")), \
         patch("platform_v8.services.economy.ledger._refresh_balance_cache"):
        # 不抛
        result = ledger.transfer(
            fake_s,
            client_account_id=1, worker_owner_id=2, platform_account_id=99,
            total_amount=Decimal("100"),
            platform_fee_pct=Decimal("15"),
            workload_id="proxy_dup",
        )
    # 返值仍然是计算出来的
    assert result["client_deducted"] == Decimal("100")
    assert result["node_paid"] == Decimal("85.0000")
    assert result["platform_fee"] == Decimal("15.0000")


def test_transfer_fee_pct_25_split():
    """fee=25% · 验金额拆分准确"""
    fake_s = MagicMock()
    writes = []
    with patch("platform_v8.services.economy.ledger.LedgerRepo.write",
               side_effect=lambda _s, e: writes.append(e)), \
         patch("platform_v8.services.economy.ledger._refresh_balance_cache"):
        result = ledger.transfer(
            fake_s,
            client_account_id=1, worker_owner_id=2, platform_account_id=99,
            total_amount=Decimal("80"),
            platform_fee_pct=Decimal("25"),
            workload_id="x",
        )
    assert result["node_paid"] == Decimal("60.0000")
    assert result["platform_fee"] == Decimal("20.0000")


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
