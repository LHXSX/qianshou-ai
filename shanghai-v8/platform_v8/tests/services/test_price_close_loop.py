"""报价闭环 · task_pricing 与 effective budget"""
from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest

from platform_v8.services.economy import task_pricing as tp
from platform_v8.services.workloads.submit import zero_budget_allowed


def test_zero_budget_denied_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EDGE_ALLOW_ZERO_BUDGET", raising=False)
    assert zero_budget_allowed(is_admin=False) is False


def test_zero_budget_allowed_for_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EDGE_ALLOW_ZERO_BUDGET", raising=False)
    assert zero_budget_allowed(is_admin=True) is True


def _fake_settings(**extra):
    base = {
        "version": 2,
        "task_pricing": [
            {"task_type": "base64_encode", "base_price": 0.5, "min_charge": 0.1, "unit": "次"}
        ],
        "speed_t24": 1.0,
        "quality_standard": 1.0,
        "node_share": 0.65,
        "platform_share": 0.30,
        "channel_share": 0.05,
        "risk_pool_share": 0.0,
    }
    base.update(extra)
    return base


def test_compute_price_uses_task_pricing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tp, "_load_settings", lambda _s: _fake_settings())
    monkeypatch.setattr(tp, "_account_profile", lambda _s, _a: {})
    q = tp.compute_price_for_spec(
        None,  # type: ignore[arg-type]
        {"task_type": "base64_encode", "input_kind": "inline", "max_shards": 1},
        account_id=1,
    )
    assert q.total_yuan == Decimal("0.50")
    assert "task_pricing[base64_encode]" in q.price_basis


def test_resolve_forces_server_price_for_normal_user(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tp, "_load_settings", lambda _s: _fake_settings())
    monkeypatch.setattr(tp, "_account_profile", lambda _s, _a: {})
    effective, quote, mode = tp.resolve_effective_budget(
        None,  # type: ignore[arg-type]
        spec={"task_type": "base64_encode", "input_kind": "inline"},
        client_budget=Decimal("0.01"),
        account_id=104,
        is_admin=False,
    )
    assert mode == "server_price"
    assert effective == Decimal("0.50")
    assert quote.total_yuan == Decimal("0.50")


def test_resolve_honors_client_for_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tp, "_load_settings", lambda _s: _fake_settings())
    monkeypatch.setattr(tp, "_account_profile", lambda _s, _a: {})
    effective, _quote, mode = tp.resolve_effective_budget(
        None,  # type: ignore[arg-type]
        spec={"task_type": "base64_encode", "input_kind": "inline"},
        client_budget=Decimal("0.01"),
        account_id=1,
        is_admin=True,
    )
    assert mode == "client_budget"
    assert effective == Decimal("0.01")


def test_resolve_honors_profile_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tp, "_load_settings", lambda _s: _fake_settings())
    monkeypatch.setattr(
        tp,
        "_account_profile",
        lambda _s, _a: {"honor_client_budget": True},
    )
    effective, _quote, mode = tp.resolve_effective_budget(
        None,  # type: ignore[arg-type]
        spec={"task_type": "base64_encode", "input_kind": "inline"},
        client_budget=Decimal("0.02"),
        account_id=9,
        is_admin=False,
    )
    assert mode == "client_budget"
    assert effective == Decimal("0.02")


def test_profile_override_and_discount(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tp, "_load_settings", lambda _s: _fake_settings())
    monkeypatch.setattr(
        tp,
        "_account_profile",
        lambda _s, _a: {
            "task_price_overrides": {"base64_encode": 1.0},
            "workload_discount_pct": 50,
        },
    )
    q = tp.compute_price_for_spec(
        None,  # type: ignore[arg-type]
        {"task_type": "base64_encode", "input_kind": "inline"},
        account_id=3,
    )
    # 1.0 unit * 1.0 base → 1.0, then 50% off → 0.50
    assert q.total_yuan == Decimal("0.50")
    assert "override" in q.price_basis
    assert q.discount_pct == Decimal("50")
