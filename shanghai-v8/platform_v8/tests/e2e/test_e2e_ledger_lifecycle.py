"""
W6 · e2e · ledger.transfer 全链路 (sqlite + 真 service code)

覆盖:
  - seed 客户 10 EDG + 节点 0 + 平台 0
  - 跑 ledger.transfer (100 EDG · 15% fee · 但客户只有 10 · 验扣到负)
  - 验客户 -10 · 节点 +85 · 平台 +15 · 三方平衡 = 0
  - 重复调 (幂等冲突) · 余额不变
"""
from __future__ import annotations
from decimal import Decimal

import pytest

from platform_v8.services.economy import ledger
from platform_v8.storage.repo import LedgerRepo


pytestmark = pytest.mark.e2e


# ════════════════════════════════════════════════════════════════
# 基础 fixture 自检
# ════════════════════════════════════════════════════════════════
def test_fixture_db_works(db_session, seed_accounts):
    """fixture 自检: 3 账号 seed 完毕 · 客户余额是 10"""
    s = db_session
    assert seed_accounts["customer"]["balance"] == Decimal("10")

    # ledger 真的写进去了
    from sqlalchemy import text
    n = s.execute(text("SELECT COUNT(*) FROM we_ledger WHERE account_id=100")).scalar()
    assert n == 1

    bal = LedgerRepo.sum_balance(s, 100)
    assert bal == Decimal("10")


# ════════════════════════════════════════════════════════════════
# ledger.transfer e2e
# ════════════════════════════════════════════════════════════════
def test_transfer_three_party_balance(db_session, seed_accounts):
    """transfer 100 EDG · fee=15% · 验三方账面 + 总平衡"""
    s = db_session

    result = ledger.transfer(
        s,
        client_account_id=100,
        worker_owner_id=200,
        platform_account_id=1,
        total_amount=Decimal("100"),
        platform_fee_pct=Decimal("15"),
        workload_id="e2e_proxy_001",
    )
    s.commit()

    # 返值校验
    assert result["client_deducted"] == Decimal("100")
    assert result["node_paid"] == Decimal("85.0000")
    assert result["platform_fee"] == Decimal("15.0000")

    # ledger 实际余额
    client_bal = LedgerRepo.sum_balance(s, 100)
    node_bal = LedgerRepo.sum_balance(s, 200)
    platform_bal = LedgerRepo.sum_balance(s, 1)

    # 客户 seed=10 · 扣 100 → -90
    assert client_bal == Decimal("-90")
    # 节点 seed=0 · 加 85 → 85
    assert node_bal == Decimal("85")
    # 平台 seed=0 · 加 15 → 15
    assert platform_bal == Decimal("15")

    # 三方平衡 · 只看本次 transfer 的 3 条 entry · 应总和 = 0
    # (SQLite SUM 用 float · 加容差 · PG 用 Numeric 精确)
    from sqlalchemy import text
    transfer_sum = s.execute(text(
        "SELECT COALESCE(SUM(amount), 0) FROM we_ledger "
        "WHERE workload_id = 'e2e_proxy_001'"
    )).scalar()
    assert abs(float(transfer_sum)) < 1e-10


def test_transfer_idempotent(db_session, seed_accounts):
    """重复调同一 workload_id · 不会双扣 (幂等键守住)"""
    s = db_session

    # 第一次
    ledger.transfer(s, client_account_id=100, worker_owner_id=200,
                    platform_account_id=1,
                    total_amount=Decimal("5"), platform_fee_pct=Decimal("20"),
                    workload_id="e2e_idem_001")
    s.commit()

    bal_after_1 = LedgerRepo.sum_balance(s, 100)
    assert bal_after_1 == Decimal("5")  # 10 - 5

    # 第二次同 workload_id (幂等冲突 · 应静默)
    ledger.transfer(s, client_account_id=100, worker_owner_id=200,
                    platform_account_id=1,
                    total_amount=Decimal("5"), platform_fee_pct=Decimal("20"),
                    workload_id="e2e_idem_001")
    s.commit()

    bal_after_2 = LedgerRepo.sum_balance(s, 100)
    # 余额跟第 1 次后一样 (幂等生效)
    assert bal_after_2 == Decimal("5")


def test_transfer_distinct_workloads_accumulate(db_session, seed_accounts):
    """不同 workload_id · 正常累加"""
    s = db_session

    for i in range(3):
        ledger.transfer(s, client_account_id=100, worker_owner_id=200,
                        platform_account_id=1,
                        total_amount=Decimal("1"), platform_fee_pct=Decimal("10"),
                        workload_id=f"e2e_multi_{i}")
        s.commit()

    client_bal = LedgerRepo.sum_balance(s, 100)
    node_bal = LedgerRepo.sum_balance(s, 200)
    platform_bal = LedgerRepo.sum_balance(s, 1)

    assert client_bal == Decimal("7")           # 10 - 3
    assert node_bal == Decimal("2.7000")        # 3 × 0.9
    assert platform_bal == Decimal("0.3000")    # 3 × 0.1
    assert client_bal + node_bal + platform_bal == Decimal("10")


def test_transfer_zero_fee_node_takes_all(db_session, seed_accounts):
    """fee=0 · 节点拿全部 · 不写平台 entry"""
    s = db_session

    ledger.transfer(s, client_account_id=100, worker_owner_id=200,
                    platform_account_id=1,
                    total_amount=Decimal("2"), platform_fee_pct=Decimal("0"),
                    workload_id="e2e_zero_fee")
    s.commit()

    from sqlalchemy import text
    by_type = dict(s.execute(text(
        "SELECT type, COUNT(*) FROM we_ledger "
        "WHERE workload_id='e2e_zero_fee' GROUP BY type"
    )).fetchall())

    assert by_type.get("ESCROW_HOLD") == 1
    assert by_type.get("REWARD") == 1
    assert "PLATFORM_FEE" not in by_type  # 没写
