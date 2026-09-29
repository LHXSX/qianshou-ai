"""
W7-phase2 · services/business/billing.py 单测 (2026-05-26)

覆盖:
  - generate_invoice 空数据 (无 ledger 也能生成 0 EDG draft)
  - generate_invoice 有 ledger · 聚合 ESCROW_HOLD + REWARD + PLATFORM_FEE
  - 幂等 (同 period+account+biz 重生成只更新 draft · 不动 issued/paid)
  - 状态机 draft → issued → paid · 不可逆 cancel
  - list 过滤
"""
from __future__ import annotations
import uuid
from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, insert, update
from sqlalchemy.orm import sessionmaker

from platform_v8.services.business import billing as svc
from platform_v8.services.economy import ledger
from platform_v8.storage.repo import accounts_t, create_all_for_testing, ledger_t


@pytest.fixture
def session():
    eng = create_engine("sqlite:///:memory:", future=True)
    create_all_for_testing(eng)
    factory = sessionmaker(bind=eng, autoflush=False, autocommit=False,
                           expire_on_commit=False, future=True)
    s = factory()
    # seed 3 账号 (admin=1, customer=100, worker_owner=200) · Core insert
    now = datetime(2026, 5, 26)
    s.execute(
        insert(accounts_t),
        [
            {
                "id": 1,
                "username": "admin",
                "email": "a@t",
                "password_hash": "x",
                "role": "admin",
                "balance": 0,
                "status": "active",
                "profile": {},
                "created_at": now,
                "updated_at": now,
            },
            {
                "id": 100,
                "username": "biz",
                "email": "b@t",
                "password_hash": "x",
                "role": "business",
                "balance": 100,
                "status": "active",
                "profile": {},
                "created_at": now,
                "updated_at": now,
            },
            {
                "id": 200,
                "username": "node",
                "email": "n@t",
                "password_hash": "x",
                "role": "user",
                "balance": 0,
                "status": "active",
                "profile": {},
                "created_at": now,
                "updated_at": now,
            },
        ],
    )
    s.commit()
    try:
        yield s
    finally:
        s.close()
        eng.dispose()


def _seed_proxy_transfer(s, *, workload_suffix: str, amount: Decimal,
                        client_id: int = 100, owner_id: int = 200,
                        platform_id: int = 1, fee_pct: Decimal = Decimal("15")):
    """seed 一笔 proxy ledger.transfer (3 条 entry)"""
    workload_id = f"proxy_{workload_suffix}"
    ledger.transfer(
        s,
        client_account_id=client_id,
        worker_owner_id=owner_id,
        platform_account_id=platform_id,
        total_amount=amount,
        platform_fee_pct=fee_pct,
        workload_id=workload_id,
    )
    # 账单按 created_at 归期；通过 Table/Core update 固定时间，避免硬编码 SQL 文本
    s.execute(
        update(ledger_t)
        .where(ledger_t.c.workload_id == workload_id)
        .values(created_at=datetime(2026, 5, 26, 12, 0, 0))
    )


# ════════════════════════════════════════════════════════════════
# generate_invoice 基础
# ════════════════════════════════════════════════════════════════
def test_generate_empty_period(session):
    """无 ledger · 生成 draft 0 EDG"""
    inv = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05")
    session.commit()
    assert inv["status"] == "draft"
    assert float(inv["amount_edg"]) == 0
    assert float(inv["node_paid_edg"]) == 0
    assert float(inv["platform_fee_edg"]) == 0
    assert inv["session_count"] == 0


def test_generate_with_ledger_data(session):
    """2 笔 proxy transfer · 客户共扣 30 EDG · 节点 25.5 · 平台 4.5"""
    _seed_proxy_transfer(session, workload_suffix="s1", amount=Decimal("10"))
    _seed_proxy_transfer(session, workload_suffix="s2", amount=Decimal("20"))
    session.commit()

    inv = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05")
    session.commit()

    # 15% fee → node 85% / platform 15%
    assert float(inv["amount_edg"]) == 30.0
    assert float(inv["node_paid_edg"]) == pytest.approx(25.5)
    assert float(inv["platform_fee_edg"]) == pytest.approx(4.5)
    assert inv["session_count"] == 2
    assert inv["status"] == "draft"


def test_generate_isolates_by_account(session):
    """加另一个 biz 客户 200 · 200 的 transfer 不进 100 的账单"""
    _seed_proxy_transfer(session, workload_suffix="s1", amount=Decimal("10"),
                        client_id=100)
    _seed_proxy_transfer(session, workload_suffix="s2", amount=Decimal("20"),
                        client_id=200)
    session.commit()

    inv_100 = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05")
    inv_200 = svc.generate_invoice(session, account_id=200, period_yyyymm="2026-05")
    session.commit()

    assert float(inv_100["amount_edg"]) == 10
    assert float(inv_200["amount_edg"]) == 20


def test_generate_auto_issue(session):
    """auto_issue=True · 直接进 issued 状态 + 设 due_at"""
    inv = svc.generate_invoice(
        session, account_id=100, period_yyyymm="2026-05",
        auto_issue=True, due_days=30,
    )
    session.commit()
    assert inv["status"] == "issued"
    assert inv["issued_at"] is not None
    assert inv["due_at"] is not None


def test_generate_rejects_bad_business_type(session):
    with pytest.raises(ValueError, match="business_type"):
        svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05",
                             business_type="invalid")


# ════════════════════════════════════════════════════════════════
# 幂等
# ════════════════════════════════════════════════════════════════
def test_generate_idempotent_updates_draft(session):
    """重生成 · draft 状态会更新金额 (反映新 ledger 数据)"""
    _seed_proxy_transfer(session, workload_suffix="s1", amount=Decimal("10"))
    session.commit()

    inv1 = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05")
    session.commit()
    invoice_id = inv1["id"]
    assert float(inv1["amount_edg"]) == 10

    # 加一笔 · 重生成 · 金额应该变 30
    _seed_proxy_transfer(session, workload_suffix="s2", amount=Decimal("20"))
    session.commit()
    inv2 = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05")
    session.commit()
    assert inv2["id"] == invoice_id  # 同一张
    assert float(inv2["amount_edg"]) == 30


def test_generate_does_not_touch_issued(session):
    """已 issued 的账单重生成 · 金额不动 (锁住数据)"""
    _seed_proxy_transfer(session, workload_suffix="s1", amount=Decimal("10"))
    session.commit()
    inv = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05",
                                auto_issue=True)
    session.commit()
    assert inv["status"] == "issued"
    original_amount = float(inv["amount_edg"])

    # 加新数据 · 重生成 · 金额应保持
    _seed_proxy_transfer(session, workload_suffix="s2", amount=Decimal("50"))
    session.commit()
    inv2 = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05")
    session.commit()
    assert float(inv2["amount_edg"]) == original_amount  # 未变


# ════════════════════════════════════════════════════════════════
# 状态机
# ════════════════════════════════════════════════════════════════
def test_full_lifecycle(session):
    """draft → issued → paid"""
    inv = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05")
    session.commit()
    iid = inv["id"]
    assert inv["status"] == "draft"

    assert svc.issue_invoice(session, iid) is True
    session.commit()
    assert svc.get_invoice(session, iid)["status"] == "issued"

    assert svc.mark_paid(session, iid, paid_note="链下转账完成") is True
    session.commit()
    final = svc.get_invoice(session, iid)
    assert final["status"] == "paid"
    assert final["paid_at"] is not None


def test_issue_fails_when_not_draft(session):
    inv = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05",
                                auto_issue=True)
    session.commit()
    # 已 issued · 不能再 issue
    assert svc.issue_invoice(session, inv["id"]) is False


def test_pay_fails_when_not_issued(session):
    inv = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05")
    session.commit()
    # 还在 draft · 不能直接 pay
    assert svc.mark_paid(session, inv["id"]) is False


def test_cancel_works_when_not_paid(session):
    inv = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05")
    session.commit()
    assert svc.cancel_invoice(session, inv["id"], reason="测试") is True
    session.commit()
    assert svc.get_invoice(session, inv["id"])["status"] == "cancelled"


def test_cancel_fails_when_paid(session):
    """已 paid 不可撤"""
    inv = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05",
                                auto_issue=True)
    session.commit()
    svc.mark_paid(session, inv["id"])
    session.commit()
    assert svc.cancel_invoice(session, inv["id"]) is False


# ════════════════════════════════════════════════════════════════
# list 过滤
# ════════════════════════════════════════════════════════════════
def test_list_filter_by_status(session):
    inv1 = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05")
    inv2 = svc.generate_invoice(session, account_id=100, period_yyyymm="2026-04",
                                 auto_issue=True)
    session.commit()
    drafts = svc.list_invoices(session, status="draft")
    issued = svc.list_invoices(session, status="issued")
    assert len(drafts) == 1
    assert len(issued) == 1
    assert drafts[0]["period_yyyymm"] == "2026-05"
    assert issued[0]["period_yyyymm"] == "2026-04"


def test_list_filter_by_period(session):
    svc.generate_invoice(session, account_id=100, period_yyyymm="2026-05")
    svc.generate_invoice(session, account_id=100, period_yyyymm="2026-04")
    session.commit()
    may = svc.list_invoices(session, period_yyyymm="2026-05")
    assert len(may) == 1


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
