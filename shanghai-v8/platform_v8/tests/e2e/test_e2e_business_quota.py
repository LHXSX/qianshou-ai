"""
W7 · e2e · B2B 合约配额 + proxy gateway 集成

覆盖:
  - admin 创合约 → proxy gateway 配额检查通过
  - 合约 status=suspended → proxy gateway 跳过 (没 active 合约)
  - 配额 0 (不限) → 永远通过
  - 客户无合约 → 走默认 (放行)
  - _check_business_quota 完整 sqlite 链路
"""
from __future__ import annotations
import pytest
from decimal import Decimal

from platform_v8.services.business import contracts as svc
from platform_v8.services.proxy import gateway as pg


pytestmark = pytest.mark.e2e


def test_no_contract_passes_quota_check(db_session, seed_accounts):
    """无合约客户 · _check_business_quota 放行 (走默认计费)"""
    ok, reason = pg._check_business_quota("100")
    assert ok is True
    assert reason == ""


def test_active_unlimited_contract_passes(db_session, seed_accounts):
    """active 合约 · quota=0 (不限) · 永远通过"""
    svc.create_contract(db_session, account_id=100, name="无限套餐",
                        status="active", quota_bytes_per_month=0)
    db_session.commit()

    ok, reason = pg._check_business_quota("100")
    assert ok is True
    assert reason == ""


def test_active_with_quota_passes_when_under(db_session, seed_accounts):
    """active 合约 · quota=1GB · 本月已用 0 · 通过"""
    svc.create_contract(db_session, account_id=100, name="1GB套餐",
                        status="active", quota_bytes_per_month=1024 ** 3)
    db_session.commit()

    ok, reason = pg._check_business_quota("100")
    assert ok is True


def test_suspended_contract_falls_back_to_default(db_session, seed_accounts):
    """suspended 合约 · 视作无合约 · 放行 (走默认计费)"""
    cid = svc.create_contract(db_session, account_id=100, name="A",
                              status="active", quota_bytes_per_month=1000)
    svc.set_status(db_session, cid, "suspended")
    db_session.commit()

    ok, reason = pg._check_business_quota("100")
    assert ok is True


def test_quota_check_skips_non_int_client(db_session, seed_accounts):
    """非数字 client_id · 直接放行 (api_key 客户)"""
    ok, reason = pg._check_business_quota("api_key_xyz")
    assert ok is True


# ════════════════════════════════════════════════════════════════
# 合约创建 + 状态机 e2e
# ════════════════════════════════════════════════════════════════
def test_contract_lifecycle(db_session, seed_accounts):
    """创合约 → 改 active → 改 suspended → 查 active 合约"""
    cid = svc.create_contract(
        db_session, account_id=100, name="豆包-Q2",
        quota_bytes_per_month=1024 ** 4,
        price_per_gb_edg=Decimal("0.008"),
        sla_support_tier="enterprise",
    )
    db_session.commit()
    assert cid > 0
    assert svc.get_contract(db_session, cid)["status"] == "draft"

    # 上线
    svc.set_status(db_session, cid, "active")
    db_session.commit()
    active = svc.get_active_contract(db_session, account_id=100)
    assert active is not None
    assert active["id"] == cid
    assert float(active["price_per_gb_edg"]) == 0.008

    # 暂停
    svc.set_status(db_session, cid, "suspended")
    db_session.commit()
    assert svc.get_active_contract(db_session, account_id=100) is None

    # 改回 active
    svc.set_status(db_session, cid, "active")
    db_session.commit()
    assert svc.get_active_contract(db_session, account_id=100) is not None


def test_multiple_business_types_isolated(db_session, seed_accounts):
    """proxy / crawl / geo_monitor 三个合约独立查"""
    svc.create_contract(db_session, account_id=100, name="proxy",
                        status="active", business_type="ip_proxy")
    svc.create_contract(db_session, account_id=100, name="crawl",
                        status="active", business_type="crawl")
    svc.create_contract(db_session, account_id=100, name="geo",
                        status="active", business_type="geo_monitor")
    db_session.commit()

    assert svc.get_active_contract(db_session, account_id=100,
                                    business_type="ip_proxy")["name"] == "proxy"
    assert svc.get_active_contract(db_session, account_id=100,
                                    business_type="crawl")["name"] == "crawl"
    assert svc.get_active_contract(db_session, account_id=100,
                                    business_type="geo_monitor")["name"] == "geo"
