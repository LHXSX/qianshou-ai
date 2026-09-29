"""
W7 · services/business/contracts.py 单测 (2026-05-26)

覆盖:
  - create/get/list/update/set_status
  - get_active_contract · 找最新 active
  - check_monthly_quota · 配额计算 (有/无合约 · 不限/限额 · 超额)
  - 字段校验 (business_type / status / tier / 范围)
"""
from __future__ import annotations
import sys
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.business import contracts as svc
from platform_v8.storage.repo import create_all_for_testing


@pytest.fixture
def session():
    """sqlite + 全 v8 表 + seed 一个 customer 账号"""
    eng = create_engine("sqlite:///:memory:", future=True)
    create_all_for_testing(eng)
    factory = sessionmaker(bind=eng, autoflush=False, autocommit=False,
                           expire_on_commit=False, future=True)
    s = factory()
    s.execute(text("""
        INSERT INTO we_accounts (id, username, email, password_hash, role, balance,
                                  status, profile, created_at, updated_at)
        VALUES (100, 'biz', 'biz@t', 'x', 'business', 0, 'active', '{}',
                '2026-05-26', '2026-05-26')
    """))
    s.commit()
    try:
        yield s
    finally:
        s.close()
        eng.dispose()


# ════════════════════════════════════════════════════════════════
# CREATE 校验
# ════════════════════════════════════════════════════════════════
def test_create_minimal(session):
    cid = svc.create_contract(session, account_id=100, name="豆包-2026Q2")
    session.commit()
    assert cid > 0

    c = svc.get_contract(session, cid)
    assert c is not None
    assert c["account_id"] == 100
    assert c["name"] == "豆包-2026Q2"
    assert c["business_type"] == "ip_proxy"
    assert c["status"] == "draft"
    assert c["quota_bytes_per_month"] == 0  # 不限
    assert c["quota_concurrent_sessions"] == 100
    assert float(c["sla_uptime_pct"]) == 99.0


def test_create_full(session):
    cid = svc.create_contract(
        session, account_id=100,
        name="大客户A · 1TB/月", business_type="ip_proxy",
        quota_bytes_per_month=1024 ** 4,
        quota_concurrent_sessions=500,
        price_per_gb_edg=Decimal("0.008"),
        discount_pct=Decimal("20"),
        sla_uptime_pct=Decimal("99.95"),
        sla_support_tier="enterprise",
        status="active",
        notes="销售 zhang3",
        metadata={"contract_pdf": "oss://.../foo.pdf"},
    )
    session.commit()
    c = svc.get_contract(session, cid)
    assert c["quota_bytes_per_month"] == 1024 ** 4
    assert c["status"] == "active"
    assert c["sla_support_tier"] == "enterprise"


def test_create_rejects_bad_business_type(session):
    with pytest.raises(ValueError, match="business_type"):
        svc.create_contract(session, account_id=100, name="x", business_type="invalid")


def test_create_rejects_bad_status(session):
    with pytest.raises(ValueError, match="status"):
        svc.create_contract(session, account_id=100, name="x", status="invalid")


def test_create_rejects_bad_tier(session):
    with pytest.raises(ValueError, match="sla_support_tier"):
        svc.create_contract(session, account_id=100, name="x", sla_support_tier="gold")


def test_create_rejects_negative_quota(session):
    with pytest.raises(ValueError, match="quota_bytes_per_month"):
        svc.create_contract(session, account_id=100, name="x", quota_bytes_per_month=-1)


def test_create_rejects_bad_discount(session):
    with pytest.raises(ValueError, match="discount_pct"):
        svc.create_contract(session, account_id=100, name="x", discount_pct=Decimal("150"))


# ════════════════════════════════════════════════════════════════
# LIST 过滤
# ════════════════════════════════════════════════════════════════
def test_list_filter_by_status(session):
    svc.create_contract(session, account_id=100, name="A", status="active")
    svc.create_contract(session, account_id=100, name="B", status="suspended")
    svc.create_contract(session, account_id=100, name="C", status="active")
    session.commit()

    active = svc.list_contracts(session, status="active")
    assert len(active) == 2

    suspended = svc.list_contracts(session, status="suspended")
    assert len(suspended) == 1
    assert suspended[0]["name"] == "B"


def test_list_filter_by_account(session):
    # 加另一个客户
    session.execute(text("""
        INSERT INTO we_accounts (id, username, email, password_hash, role, balance,
                                  status, profile, created_at, updated_at)
        VALUES (200, 'biz2', 'biz2@t', 'x', 'business', 0, 'active', '{}',
                '2026-05-26', '2026-05-26')
    """))
    svc.create_contract(session, account_id=100, name="A")
    svc.create_contract(session, account_id=200, name="B")
    session.commit()

    by_100 = svc.list_contracts(session, account_id=100)
    assert len(by_100) == 1
    assert by_100[0]["name"] == "A"


# ════════════════════════════════════════════════════════════════
# UPDATE
# ════════════════════════════════════════════════════════════════
def test_update_quota_and_price(session):
    cid = svc.create_contract(session, account_id=100, name="A")
    session.commit()

    ok = svc.update_contract(session, cid,
                              quota_bytes_per_month=999999,
                              price_per_gb_edg=Decimal("0.005"),
                              notes="价格谈到 0.005")
    session.commit()
    assert ok is True

    c = svc.get_contract(session, cid)
    assert c["quota_bytes_per_month"] == 999999
    assert float(c["price_per_gb_edg"]) == 0.005
    assert "0.005" in c["notes"]


def test_update_unknown_contract(session):
    ok = svc.update_contract(session, 99999, name="ghost")
    assert ok is False


def test_update_ignores_readonly_fields(session):
    cid = svc.create_contract(session, account_id=100, name="A")
    session.commit()
    # account_id 不在白名单 · 不会改
    ok = svc.update_contract(session, cid, account_id=999, business_type="crawl")
    assert ok is False  # 没有 _UPDATABLE_FIELDS 字段
    c = svc.get_contract(session, cid)
    assert c["account_id"] == 100  # 未变
    assert c["business_type"] == "ip_proxy"


# ════════════════════════════════════════════════════════════════
# STATUS 状态机
# ════════════════════════════════════════════════════════════════
def test_set_status(session):
    cid = svc.create_contract(session, account_id=100, name="A", status="draft")
    session.commit()

    assert svc.set_status(session, cid, "active") is True
    session.commit()
    assert svc.get_contract(session, cid)["status"] == "active"

    assert svc.set_status(session, cid, "suspended") is True
    session.commit()
    assert svc.get_contract(session, cid)["status"] == "suspended"


def test_set_status_rejects_invalid(session):
    cid = svc.create_contract(session, account_id=100, name="A")
    session.commit()
    with pytest.raises(ValueError):
        svc.set_status(session, cid, "deleted")


# ════════════════════════════════════════════════════════════════
# get_active_contract (proxy gateway 高频)
# ════════════════════════════════════════════════════════════════
def test_get_active_returns_none_when_no_contract(session):
    c = svc.get_active_contract(session, account_id=100)
    assert c is None


def test_get_active_skips_draft(session):
    svc.create_contract(session, account_id=100, name="A", status="draft")
    session.commit()
    assert svc.get_active_contract(session, account_id=100) is None


def test_get_active_returns_active(session):
    svc.create_contract(session, account_id=100, name="A", status="active")
    session.commit()
    c = svc.get_active_contract(session, account_id=100)
    assert c is not None
    assert c["name"] == "A"


def test_get_active_skips_expired_by_end_at(session):
    past = datetime.utcnow() - timedelta(days=1)
    svc.create_contract(session, account_id=100, name="A",
                        status="active", end_at=past)
    session.commit()
    assert svc.get_active_contract(session, account_id=100) is None


def test_get_active_filters_by_business_type(session):
    svc.create_contract(session, account_id=100, name="proxy", status="active",
                        business_type="ip_proxy")
    svc.create_contract(session, account_id=100, name="crawl", status="active",
                        business_type="crawl")
    session.commit()
    p = svc.get_active_contract(session, account_id=100, business_type="ip_proxy")
    assert p["name"] == "proxy"
    c = svc.get_active_contract(session, account_id=100, business_type="crawl")
    assert c["name"] == "crawl"


# ════════════════════════════════════════════════════════════════
# 月配额检查
# ════════════════════════════════════════════════════════════════
def test_quota_no_contract(session):
    q = svc.check_monthly_quota(session, account_id=100)
    assert q["has_contract"] is False
    assert q["exceeded"] is False
    assert q["remaining_bytes"] == -1


def test_quota_unlimited(session):
    svc.create_contract(session, account_id=100, name="A", status="active",
                        quota_bytes_per_month=0)
    session.commit()
    q = svc.check_monthly_quota(session, account_id=100)
    assert q["has_contract"] is True
    assert q["quota_bytes"] == 0
    assert q["exceeded"] is False
    assert q["remaining_bytes"] == -1


def test_quota_under_limit(session):
    svc.create_contract(session, account_id=100, name="A", status="active",
                        quota_bytes_per_month=1000)
    session.commit()
    q = svc.check_monthly_quota(session, account_id=100)
    assert q["quota_bytes"] == 1000
    assert q["used_bytes"] == 0
    assert q["exceeded"] is False
    assert q["remaining_bytes"] == 1000


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
