"""Bounded declarative JSON checks for reviewed task inputs and results.

This deliberately supports a small JSON Schema subset. Passing it means only
that bytes have the declared shape; it never claims that the answer is correct.
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

_FIELD = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]{0,63}\Z")
_KINDS = {"object", "array", "string", "integer", "number", "boolean", "null"}
_MAX_SCHEMA_BYTES = 4096
_MAX_RESULT_BYTES = 64 * 1024


def _pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in items:
        if key in value:
            raise ValueError("duplicate JSON field")
        value[key] = item
    return value


def _constant(_value: str) -> None:
    raise ValueError("non-finite JSON number")


def _finite_float(raw: str) -> float:
    value = float(raw)
    if not math.isfinite(value):
        raise ValueError("non-finite JSON number")
    return value


def parse_bounded_json(raw: str, *, max_bytes: int = _MAX_RESULT_BYTES) -> Any:
    try:
        size = len(raw.encode("utf-8")) if isinstance(raw, str) else 0
    except UnicodeError as exc:
        raise ValueError("JSON result invalid") from exc
    if not 1 <= size <= max_bytes:
        raise ValueError("JSON result size invalid")
    try:
        value = json.loads(raw, object_pairs_hook=_pairs, parse_constant=_constant,
                           parse_float=_finite_float)
        # Escaped lone surrogates also fail the UTF-8 declaration. Checking
        # parsed text prevents escapes from bypassing the raw-byte check.
        json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        return value
    except (UnicodeError, TypeError, ValueError, RecursionError) as exc:
        raise ValueError("JSON result invalid") from exc


def validate_shape_schema(schema: Any) -> dict[str, Any]:
    """Validate a resource-bounded schema before publishing a task contract."""
    try:
        encoded = json.dumps(schema, sort_keys=True, separators=(",", ":"),
                             ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise ValueError("output schema invalid") from exc
    if len(encoded) > _MAX_SCHEMA_BYTES:
        raise ValueError("output schema too large")
    nodes = 0

    def walk(rule: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > 64 or depth > 5 or not isinstance(rule, dict):
            raise ValueError("output schema too complex")
        kind = rule.get("type")
        if not isinstance(kind, str) or kind not in _KINDS:
            raise ValueError("output schema type unsupported")
        keys = {"type", "title"}
        if kind == "object":
            keys |= {"properties", "required", "additionalProperties"}
            properties = rule.get("properties")
            required = rule.get("required", [])
            if (not isinstance(properties, dict) or len(properties) > 32
                    or not isinstance(required, list) or len(required) > 32
                    or any(not isinstance(name, str) for name in required)
                    or len(set(required)) != len(required)
                    or any(not isinstance(name, str) or not _FIELD.fullmatch(name)
                           for name in properties)
                    or any(name not in properties for name in required)
                    or rule.get("additionalProperties") is not False):
                raise ValueError("output object schema invalid")
            for child in properties.values():
                walk(child, depth + 1)
        elif kind == "array":
            keys |= {"items", "minItems", "maxItems"}
            low, high = rule.get("minItems", 0), rule.get("maxItems", 128)
            if (type(low) is not int or type(high) is not int
                    or not 0 <= low <= high <= 128):
                raise ValueError("output array bounds invalid")
            walk(rule.get("items"), depth + 1)
        elif kind == "string":
            keys |= {"minLength", "maxLength", "enum"}
            low, high = rule.get("minLength", 0), rule.get("maxLength", 16384)
            if (type(low) is not int or type(high) is not int
                    or not 0 <= low <= high <= 16384):
                raise ValueError("output string bounds invalid")
            if "enum" in rule and (not isinstance(rule["enum"], list)
                                   or not 1 <= len(rule["enum"]) <= 32
                                   or any(not isinstance(v, str) for v in rule["enum"])):
                raise ValueError("output string enum invalid")
        elif kind in {"integer", "number"}:
            keys |= {"minimum", "maximum"}
            low, high = rule.get("minimum"), rule.get("maximum")
            if any(type(rule[key]) not in {int, float}
                   or type(rule[key]) is float and not math.isfinite(rule[key])
                   for key in ("minimum", "maximum") if key in rule):
                raise ValueError("output number bounds invalid")
            if low is not None and high is not None and low > high:
                raise ValueError("output number bounds invalid")
        if (set(rule) - keys or not isinstance(rule.get("title", ""), str)
                or len(rule.get("title", "")) > 100):
            raise ValueError("output schema keyword unsupported")

    walk(schema, 0)
    return schema


def matches_shape(value: Any, schema: dict[str, Any]) -> bool:
    """Check a parsed value only against the pinned, validated subset."""
    kind = schema["type"]
    if kind == "object":
        if not isinstance(value, dict):
            return False
        props = schema["properties"]
        if any(key not in props for key in value):
            return False
        if any(key not in value for key in schema.get("required", [])):
            return False
        return all(matches_shape(item, props[key]) for key, item in value.items())
    if kind == "array":
        return (isinstance(value, list)
                and schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 128)
                and all(matches_shape(item, schema["items"]) for item in value))
    if kind == "string":
        return (isinstance(value, str)
                and schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", 16384)
                and ("enum" not in schema or value in schema["enum"]))
    if kind == "integer":
        valid = type(value) is int
    elif kind == "number":
        valid = type(value) is int or type(value) is float and math.isfinite(value)
    elif kind == "boolean":
        return type(value) is bool
    else:
        return value is None
    return (valid and ("minimum" not in schema or value >= schema["minimum"])
            and ("maximum" not in schema or value <= schema["maximum"]))
