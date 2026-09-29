"""
W6 · e2e · workload + ledger 完整生命周期 (ONESHOT/PUSH)

覆盖:
  - escrow_hold (客户提任务 · 余额冻结)
  - reward (节点完成 · 拿钱)
  - escrow_release (任务正常结束 · 标记释放)
  - 余额前后一致性 · 客户 -预算 节点 +奖励 · ledger 平衡
  - refund 失败场景 (任务取消 · 退款给客户)
"""
from __future__ import annotations
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text

from platform_v8.services.economy import ledger
from platform_v8.storage.repo import LedgerRepo


pytestmark = pytest.mark.e2e


def _create_workload(s, workload_id: str, owner_id: int, budget: Decimal) -> None:
    """seed 一个 workload + 1 shard · ONESHOT/PUSH"""
    now = "2026-05-26T00:00:00"
    s.execute(text("""
        INSERT INTO we_workloads (id, owner_id, name, spec, status,
                                   progress, total_shards, completed_shards,
                                   failed_shards, budget, spent, error,
                                   created_at, updated_at)
        VALUES (:id, :oid, 'e2e_workload', :spec, 'CREATED',
                0.0, 1, 0,
                0, :budget, 0, '',
                :ts, :ts)
    """), {
        "id": workload_id, "oid": owner_id, "spec": '{"task_type":"word_count"}',
        "budget": float(budget), "ts": now,
    })


# ════════════════════════════════════════════════════════════════
# 完整正常流: escrow_hold → reward → escrow_release
# ════════════════════════════════════════════════════════════════
def test_workload_full_lifecycle_normal(db_session, seed_accounts, seed_worker):
    """客户提任务 → 节点完成 → 客户 -1 EDG · 节点 +0.9 EDG · 平台 +0.1 EDG"""
    s = db_session
    workload_id = str(uuid.uuid4())
    _create_workload(s, workload_id, owner_id=100, budget=Decimal("1"))
    s.commit()

    # 1. 客户提交时 escrow (冻结 1 EDG)
    ledger.escrow_hold(s, account_id=100, amount=Decimal("1"),
                       workload_id=workload_id, note="e2e_test")
    s.commit()

    client_after_hold = LedgerRepo.sum_balance(s, 100)
    assert client_after_hold == Decimal("9")  # 10 - 1

    # 2. 节点完成 · 给 node owner 0.9 EDG · 平台 0.1 EDG (suffix 区分幂等键)
    ledger.reward(s, worker_owner_id=200, amount=Decimal("0.9"),
                  workload_id=workload_id, note="e2e_node",
                  idempotent_suffix="node")
    ledger.reward(s, worker_owner_id=1, amount=Decimal("0.1"),
                  workload_id=workload_id, note="e2e_platform",
                  idempotent_suffix="platform")
    s.commit()

    node_bal = LedgerRepo.sum_balance(s, 200)
    platform_bal = LedgerRepo.sum_balance(s, 1)
    assert node_bal == Decimal("0.9")
    assert platform_bal == Decimal("0.1")

    # 3. escrow_release (任务标记完成 · amount=0 · 仅审计标)
    ledger.escrow_release(s, account_id=100, amount=Decimal("1"),
                          workload_id=workload_id)
    s.commit()

    # 客户余额不变 (release 是 amount=0)
    assert LedgerRepo.sum_balance(s, 100) == Decimal("9")

    # 全 ledger 平衡 (本 workload 所有 entry 之和)
    workload_sum = s.execute(text(
        "SELECT COALESCE(SUM(amount), 0) FROM we_ledger WHERE workload_id = :wid"
    ), {"wid": workload_id}).scalar()
    # -1 (hold) + 0.9 (node) + 0.1 (platform) + 0 (release) = 0
    # SQLite 用 float · 容忍 1e-10 精度误差 (PG 是 Numeric 精确)
    assert abs(float(workload_sum)) < 1e-10


# ════════════════════════════════════════════════════════════════
# 失败流: escrow_hold → refund (任务取消 · 退款)
# ════════════════════════════════════════════════════════════════
def test_workload_cancel_refund(db_session, seed_accounts):
    """客户提任务后取消 · 余额回到原状"""
    s = db_session
    workload_id = str(uuid.uuid4())
    _create_workload(s, workload_id, owner_id=100, budget=Decimal("2"))
    s.commit()

    initial = LedgerRepo.sum_balance(s, 100)

    # 1. escrow hold
    ledger.escrow_hold(s, account_id=100, amount=Decimal("2"),
                       workload_id=workload_id)
    s.commit()
    assert LedgerRepo.sum_balance(s, 100) == initial - Decimal("2")

    # 2. refund (取消 · 全额退)
    ledger.refund(s, account_id=100, amount=Decimal("2"),
                  workload_id=workload_id, reason="e2e_cancel")
    s.commit()

    # 余额回到原状
    assert LedgerRepo.sum_balance(s, 100) == initial

    # workload 总账平衡 (SQLite float 容差)
    workload_sum = s.execute(text(
        "SELECT COALESCE(SUM(amount), 0) FROM we_ledger WHERE workload_id = :wid"
    ), {"wid": workload_id}).scalar()
    assert abs(float(workload_sum)) < 1e-10


# ════════════════════════════════════════════════════════════════
# 幂等: escrow_hold 重复调
# ════════════════════════════════════════════════════════════════
def test_escrow_hold_idempotent(db_session, seed_accounts):
    """同 workload_id 重复 escrow_hold · 不会双扣"""
    s = db_session
    workload_id = str(uuid.uuid4())
    _create_workload(s, workload_id, owner_id=100, budget=Decimal("3"))
    s.commit()

    initial = LedgerRepo.sum_balance(s, 100)

    for _ in range(3):  # 调 3 次
        ledger.escrow_hold(s, account_id=100, amount=Decimal("3"),
                           workload_id=workload_id)
        s.commit()

    # 只扣一次 · 不是 3 次
    assert LedgerRepo.sum_balance(s, 100) == initial - Decimal("3")


# ════════════════════════════════════════════════════════════════
# 多 workload 隔离
# ════════════════════════════════════════════════════════════════
def test_multi_workload_isolation(db_session, seed_accounts):
    """3 个独立 workload · 各扣 1 EDG · 累加到 -3"""
    s = db_session
    initial = LedgerRepo.sum_balance(s, 100)

    for i in range(3):
        wid = f"e2e_multi_{i}_{uuid.uuid4().hex[:8]}"
        _create_workload(s, wid, owner_id=100, budget=Decimal("1"))
        ledger.escrow_hold(s, account_id=100, amount=Decimal("1"),
                           workload_id=wid)
        s.commit()

    assert LedgerRepo.sum_balance(s, 100) == initial - Decimal("3")
