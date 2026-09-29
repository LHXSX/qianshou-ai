"""Submission must freeze the price the account explicitly confirmed."""
from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from platform_v8.api.v8 import economy
from platform_v8.services.economy import task_pricing as prices
from platform_v8.services.economy import workload_quote as tickets
from platform_v8.services.workloads import submit


SPEC = {"task_type": "base64_encode", "input_kind": "inline", "inline_input": "hello"}


@pytest.fixture(autouse=True)
def quote_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("V8_JWT_SECRET", "workload-quote-test-secret-is-not-a-production-key")


@pytest.fixture
def price_policy(monkeypatch: pytest.MonkeyPatch) -> dict:
    settings = {
        "version": 7,
        "task_pricing": [{"task_type": "base64_encode", "base_price": 0.5, "min_charge": 0.1, "unit": "次"}],
        "speed_t24": 1.0,
        "quality_standard": 1.0,
    }
    profile: dict = {}
    monkeypatch.setattr(prices, "_load_settings", lambda _s: settings)
    monkeypatch.setattr(prices, "_account_profile", lambda _s, _account_id: profile)
    return {"settings": settings, "profile": profile}


def _ticket(account_id: int = 17, spec: dict | None = None) -> str:
    spec = spec or SPEC
    quote = prices.compute_price_for_spec(None, tickets.pricing_spec(spec), account_id=account_id)
    token, _ = tickets.issue_confirmation(account_id=account_id, spec=spec, quote=quote)
    return token


def test_quote_ticket_rejects_tampering_wrong_account_changed_spec_and_expiry(price_policy: dict) -> None:
    quote = prices.compute_price_for_spec(None, tickets.pricing_spec(SPEC), account_id=17)
    token, expires = tickets.issue_confirmation(account_id=17, spec=SPEC, quote=quote, now=1000)
    tickets.verify_confirmation(token, account_id=17, spec=SPEC, quote=quote, now=1001)
    with pytest.raises(tickets.WorkloadQuoteError, match="过期"):
        tickets.verify_confirmation(token, account_id=17, spec=SPEC, quote=quote, now=expires)
    with pytest.raises(tickets.WorkloadQuoteError, match="不匹配"):
        tickets.verify_confirmation(token, account_id=18, spec=SPEC, quote=quote, now=1001)
    with pytest.raises(tickets.WorkloadQuoteError, match="不匹配"):
        tickets.verify_confirmation(token, account_id=17,
            spec={**SPEC, "inline_input": "different work"}, quote=quote, now=1001)
    altered = ("A" if token[0] != "A" else "B") + token[1:]
    with pytest.raises(tickets.WorkloadQuoteError, match="无效"):
        tickets.verify_confirmation(altered,
            account_id=17, spec=SPEC, quote=quote, now=1001)


def test_quote_ticket_rejects_policy_change_even_when_amount_is_same(price_policy: dict) -> None:
    token = _ticket()
    price_policy["settings"]["version"] += 1
    current = prices.compute_price_for_spec(None, tickets.pricing_spec(SPEC), account_id=17)
    with pytest.raises(tickets.WorkloadQuoteError, match="价格已更新"):
        tickets.verify_confirmation(token, account_id=17, spec=SPEC, quote=current)


def test_legacy_video_tariff_cannot_invent_an_executable_profile(price_policy: dict) -> None:
    price_policy["settings"]["task_pricing"].append(
        {"task_type": "video_generate", "base_price": 0.5, "min_charge": 0.1, "unit": "秒"}
    )
    with pytest.raises(ValueError, match="quote_unavailable"):
        prices.compute_price_for_spec(None, {"task_type": "video_generate"}, account_id=17)


def test_estimate_issues_ticket_for_exact_spec_and_price(
    monkeypatch: pytest.MonkeyPatch, price_policy: dict,
) -> None:
    monkeypatch.setattr(economy, "_load_settings", lambda _s: price_policy["settings"])
    monkeypatch.setattr(economy.balance_svc, "get_balance", lambda *_args: Decimal("10"))
    response = economy.estimate_workload(
        economy.EstimateRequest(spec=SPEC), session=None,
        current=SimpleNamespace(id=17, is_admin=False),
    )
    assert response["recommended_budget"] == "0.50"
    assert response["billing_mode"] == "server_price"
    assert response["settings_version"] == 7
    assert isinstance(response["quote_expires_at"], int)
    quote = prices.compute_price_for_spec(None, tickets.pricing_spec(SPEC), account_id=17)
    tickets.verify_confirmation(response["quote_token"], account_id=17, spec=SPEC, quote=quote)


def test_estimate_refuses_unconfigured_price(
    monkeypatch: pytest.MonkeyPatch, price_policy: dict,
) -> None:
    monkeypatch.setattr(economy, "_load_settings", lambda _s: price_policy["settings"])
    with pytest.raises(HTTPException, match="尚未配置服务端价目"):
        economy.estimate_workload(
            economy.EstimateRequest(spec={"task_type": "word_count", "input_kind": "inline"}),
            session=None, current=SimpleNamespace(id=17, is_admin=False),
        )


@pytest.fixture
def isolated_submission(monkeypatch: pytest.MonkeyPatch, price_policy: dict) -> dict:
    writes: dict[str, list] = {"workload": [], "escrow": [], "audit": []}

    def create(_session, workload):
        writes["workload"].append(workload)
        return workload

    monkeypatch.setattr(submit.WorkloadRepo, "create", create)
    monkeypatch.setattr(submit.ledger_svc, "escrow_hold", lambda *_args, **kwargs: writes["escrow"].append(kwargs))
    monkeypatch.setattr(submit.AuditRepo, "write", lambda *_args, **kwargs: writes["audit"].append(kwargs))
    monkeypatch.setattr(submit.balance_svc, "get_balance", lambda *_args: Decimal("10.00"))
    return writes


def _submit(*, budget: str, token: str | None = None, account_id: int = 17,
            is_admin: bool = False, spec: dict | None = None):
    return submit.submit_workload(None, submit.SubmitInput(
        owner_id=account_id, name="encode", spec_dict=spec or SPEC,
        budget=Decimal(budget), quote_token=token, is_admin=is_admin,
    ))


def test_ordinary_submit_uses_confirmed_server_price_for_workload_and_escrow(
    isolated_submission: dict,
) -> None:
    workload = _submit(budget="0.50", token=_ticket())
    assert workload.budget == Decimal("0.50")
    assert isolated_submission["escrow"][0]["amount"] == Decimal("0.50")
    assert isolated_submission["audit"][0]["detail"]["pricing_mode"] == "server_price"
    assert isolated_submission["audit"][0]["detail"]["settings_version"] == 7


@pytest.mark.parametrize("budget,token", [
    ("0.01", "valid"), ("1.00", "valid"), ("0.50", None),
])
def test_ordinary_submit_rejects_underbid_overbid_or_missing_confirmation_without_writes(
    isolated_submission: dict, budget: str, token: str | None,
) -> None:
    with pytest.raises(submit.SubmitWorkloadError):
        _submit(budget=budget, token=_ticket() if token else None)
    assert isolated_submission == {"workload": [], "escrow": [], "audit": []}


def test_ordinary_submit_rejects_cross_account_or_stale_quote_without_writes(
    isolated_submission: dict, price_policy: dict,
) -> None:
    with pytest.raises(submit.SubmitWorkloadError, match="不匹配"):
        _submit(budget="0.50", token=_ticket(account_id=18))
    old_ticket = _ticket()
    price_policy["settings"]["version"] += 1
    with pytest.raises(submit.SubmitWorkloadError, match="价格已更新"):
        _submit(budget="0.50", token=old_ticket)
    assert isolated_submission == {"workload": [], "escrow": [], "audit": []}


def test_unconfigured_task_has_no_executable_price_for_ordinary_account(
    isolated_submission: dict,
) -> None:
    with pytest.raises(submit.SubmitWorkloadError, match="尚未配置服务端价目"):
        _submit(budget="0.50", spec={"task_type": "word_count", "input_kind": "inline", "inline_input": "hi"})
    assert isolated_submission == {"workload": [], "escrow": [], "audit": []}


def test_admin_and_explicit_profile_contract_keep_client_budget(
    isolated_submission: dict, price_policy: dict,
) -> None:
    admin_workload = _submit(budget="0.02", is_admin=True)
    assert admin_workload.budget == Decimal("0.02")
    assert isolated_submission["audit"][0]["detail"]["pricing_mode"] == "client_budget"
    price_policy["profile"]["honor_client_budget"] = True
    contract_workload = _submit(budget="0.03")
    assert contract_workload.budget == Decimal("0.03")
    assert [entry["amount"] for entry in isolated_submission["escrow"]] == [Decimal("0.02"), Decimal("0.03")]
