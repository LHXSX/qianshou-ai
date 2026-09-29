"""Registered, server-owned input contracts for reviewed local adapters.

The task registry selects a reviewed policy identifier. The author can only
submit a package for that exact contract; quote and submit use the independently
reviewed declaration, never a caller-supplied schema or validator. New adapters
register an input policy here and a separate result strategy before publishing.
"""
from __future__ import annotations

import json
from typing import Any, Callable

from platform_v8.services.workloads.reviewed_media_contract import (
    _reject_constant, _unique_object, validate_bar_chart_svg_order,
)
from platform_v8.services.workloads.reviewed_json_shape import (
    matches_shape, parse_bounded_json, validate_shape_schema,
)

InputValidator = Callable[..., dict[str, Any]]
_INPUT_VALIDATORS: dict[str, InputValidator] = {}


def input_contract_loaded(contract_id: str) -> bool:
    return isinstance(contract_id, str) and contract_id in _INPUT_VALIDATORS


def register_input_contract(contract_id: str, validator: InputValidator) -> None:
    if not contract_id or contract_id in _INPUT_VALIDATORS or not callable(validator):
        raise ValueError("duplicate or invalid reviewed input contract")
    _INPUT_VALIDATORS[contract_id] = validator


def validate_reviewed_order(spec: Any, *, input_kind: str,
                            inline_input: Any, params: Any) -> dict[str, Any]:
    """Fail closed when a task has no loaded, reviewed input validator."""
    if not getattr(spec, "requires_verified_adapter", False):
        raise ValueError("task is not a reviewed adapter")
    contract_id = getattr(spec, "adapter_input_contract", "")
    validator = _INPUT_VALIDATORS.get(contract_id)
    if validator is None:
        raise ValueError("reviewed adapter input contract is not loaded")
    value = validator(input_kind=input_kind, inline_input=inline_input, params=params)
    form = getattr(spec, "inline_input_form", {}) or {}
    if "contentSchema" in form:
        if (contract_id != "inline-json-bounded.v1"
                or form.get("contentMediaType") != "application/json"):
            raise ValueError("reviewed JSON input schema invalid")
        schema = validate_shape_schema(form["contentSchema"])
        if schema["type"] != "object" or not matches_shape(value, schema):
            raise ValueError("输入内容不符合已审核的字段、类型或范围")
    if input_kind == "inline" and isinstance(inline_input, str) and form:
        if not form.get("minLength", 0) <= len(inline_input) <= form.get("maxLength", 16384):
            raise ValueError("输入内容长度不符合已审核范围")
    return value


def validate_inline_text_reverse_order(*, input_kind: str, inline_input: Any,
                                       params: Any) -> dict[str, Any]:
    """Bounded JSON text input; exact semantics are checked on every result."""
    if input_kind != "inline" or not isinstance(inline_input, str):
        raise ValueError("text reverse accepts only inline JSON input")
    if len(inline_input.encode("utf-8")) > 16 * 1024:
        raise ValueError("text reverse input exceeds 16 KiB")
    if params not in ({}, None):
        raise ValueError("text reverse does not accept task parameters")
    try:
        value = json.loads(inline_input, object_pairs_hook=_unique_object,
                           parse_constant=_reject_constant)
    except (TypeError, ValueError) as exc:
        raise ValueError("text reverse input must be JSON") from exc
    if (not isinstance(value, dict) or set(value) != {"text"}
            or not isinstance(value["text"], str) or not value["text"]
            or len(value["text"]) > 8000):
        raise ValueError("text reverse requires one nonempty text field")
    try:
        value["text"].encode("utf-8")
    except UnicodeError as exc:
        raise ValueError("text reverse requires valid UTF-8 text") from exc
    return value


def validate_inline_json_bounded_order(*, input_kind: str, inline_input: Any,
                                       params: Any) -> dict[str, Any]:
    """Generic JSON input shape; the signed package defines its semantics."""
    if input_kind != "inline" or not isinstance(inline_input, str):
        raise ValueError("reviewed JSON adapter requires inline input")
    value = parse_bounded_json(inline_input, max_bytes=16 * 1024)
    if not isinstance(value, dict) or not value:
        raise ValueError("reviewed JSON adapter requires a nonempty object")
    if not isinstance(params, dict):
        raise ValueError("reviewed JSON adapter parameters invalid")
    return value


register_input_contract("bar-chart-svg-order.v1", validate_bar_chart_svg_order)
register_input_contract("inline-text-reverse.v1", validate_inline_text_reverse_order)
register_input_contract("inline-json-bounded.v1", validate_inline_json_bounded_order)
from platform_v8.protocol.native_h3 import validate_order as validate_native_h3_order
register_input_contract("h3-prompt-fixed-frame.v1", validate_native_h3_order)
