"""内置 task_pricing 与 billing stub 契约 · 无 DB"""
from __future__ import annotations

from platform_v8.api.v8.economy import _BUILTIN_TASK_PRICING, _apply_builtin_task_pricing
from platform_v8.api.v8 import billing_stubs


def test_builtin_task_pricing_non_empty() -> None:
    assert len(_BUILTIN_TASK_PRICING) >= 10
    assert any(r["task_type"] == "base64_encode" for r in _BUILTIN_TASK_PRICING)
    assert any(r["task_type"] == "pdf_to_text" for r in _BUILTIN_TASK_PRICING)


def test_apply_builtin_fills_empty() -> None:
    merged = _apply_builtin_task_pricing({"task_pricing": []})
    assert len(merged["task_pricing"]) == len(_BUILTIN_TASK_PRICING)


def test_apply_builtin_keeps_existing() -> None:
    custom = [{"task_type": "custom_x", "base_price": 9, "min_charge": 1, "unit": "次"}]
    merged = _apply_builtin_task_pricing({"task_pricing": custom})
    assert merged["task_pricing"] == custom


def test_billing_stubs_marked_deprecated() -> None:
    assert billing_stubs._DEPRECATED["deprecated"] is True
    assert "/api/v8/economy/balance" in billing_stubs._DEPRECATED["redirect"]["balance"]
