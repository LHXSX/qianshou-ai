"""Versioned platform tariffs for reviewed adapter policies, not seller quotes.

One approved policy tariff can price many new task types. Its exact persisted
row is signed by the independent pricing issuer and rechecked at order quote,
publication approval and dispatch. No policy match means no paid admission.
"""
from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any

_POLICY = re.compile(r"[a-z][a-z0-9_.-]{2,99}\Z")
_KINDS = {"inline_json", "artifact_ref"}
_FIELDS = {"input_contract", "result_strategy", "output_kind",
           "currency", "unit", "base_price", "min_charge"}


def valid_tariff_row(row: Any) -> bool:
    if (not isinstance(row, dict) or set(row) != _FIELDS
            or row["currency"] != "CNY" or row["unit"] != "次"
            or row["output_kind"] not in _KINDS
            or any(not isinstance(row[name], str) or not _POLICY.fullmatch(row[name])
                   for name in ("input_contract", "result_strategy"))
            or any(isinstance(row[name], bool) for name in ("base_price", "min_charge"))):
        return False
    try:
        price = Decimal(str(row["base_price"]))
        minimum = Decimal(str(row["min_charge"]))
    except (InvalidOperation, TypeError, ValueError):
        return False
    return (price.is_finite() and minimum.is_finite()
            and Decimal("0") < price <= Decimal("100000")
            and Decimal("0") <= minimum <= price
            and price.as_tuple().exponent >= -2
            and minimum.as_tuple().exponent >= -2)


def valid_tariff_rows(rows: Any) -> bool:
    if not isinstance(rows, list) or len(rows) > 50:
        return False
    keys: set[tuple[str, str, str]] = set()
    for row in rows:
        if not valid_tariff_row(row):
            return False
        key = row["input_contract"], row["result_strategy"], row["output_kind"]
        if key in keys:
            return False
        keys.add(key)
    return True


def resolve_tariff(settings: dict[str, Any], spec: Any) -> dict[str, Any] | None:
    if not getattr(spec, "requires_verified_adapter", False):
        return None
    rows = settings.get("reviewed_adapter_tariffs")
    if not valid_tariff_rows(rows):
        return None
    matches = [row for row in rows if isinstance(row, dict)
               and row.get("input_contract") == getattr(spec, "adapter_input_contract", None)
               and row.get("result_strategy") == getattr(spec, "adapter_result_strategy", None)
               and row.get("output_kind") == getattr(spec, "adapter_output_kind", None)]
    if len(matches) != 1:
        return None
    row = matches[0]
    return row
