"""Admission contracts for reviewed local adapters with media-file results.

Only small control data enters Shanghai.  This module never reads media bytes.
The worker independently checks the recipe again before it renders anything.
"""
from __future__ import annotations

import json
import math
import re
import unicodedata
from typing import Any


MAX_BAR_CHART_RECIPE_BYTES = 16 * 1024
_BAR_CHART_KEYS = frozenset({
    "kind", "title", "unit", "durationSeconds", "fps", "width", "height", "bars",
})
_BAR_KEYS = frozenset({"label", "value", "color"})
_COLOR = re.compile(r"#[0-9a-fA-F]{6}\Z")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError(f"invalid JSON number: {value}")


def _bounded_text(value: Any, *, limit: int, field: str) -> None:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > limit
        or any(char.isspace() for char in value)
        or any(unicodedata.category(char) in {"Cc", "Cf", "Cs"} for char in value)
    ):
        raise ValueError(f"{field} must be non-whitespace printable text of at most {limit} characters")


def validate_bar_chart_svg_order(
    *,
    input_kind: str,
    inline_input: Any,
    params: Any,
) -> dict[str, Any]:
    """Validate the first local media adapter's bounded, data-only recipe.

    The returned value is used only for admission.  The original JSON is sent
    to the node, which repeats this validation before rendering.
    """
    if input_kind != "inline":
        raise ValueError("bar_chart_svg_v1 accepts only inline JSON input")
    if not isinstance(inline_input, str):
        raise ValueError("bar_chart_svg_v1 requires inline JSON input")
    try:
        input_size = len(inline_input.encode("utf-8"))
    except UnicodeError as exc:
        raise ValueError("bar_chart_svg_v1 recipe must be UTF-8") from exc
    if input_size > MAX_BAR_CHART_RECIPE_BYTES:
        raise ValueError("bar_chart_svg_v1 recipe exceeds 16 KiB")
    output_format = params.get("output_format") if isinstance(params, dict) else None
    if not isinstance(output_format, str) or output_format not in {"gif", "mp4"}:
        raise ValueError("params.output_format must be gif or mp4")
    try:
        scene = json.loads(
            inline_input,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("bar_chart_svg_v1 recipe is not valid JSON") from exc
    if not isinstance(scene, dict) or set(scene) - _BAR_CHART_KEYS:
        raise ValueError("bar_chart_svg_v1 recipe has unknown fields")
    if scene.get("kind") != "bar_chart_svg_v1":
        raise ValueError("bar_chart_svg_v1 recipe kind mismatch")
    if (scene.get("width"), scene.get("height"), scene.get("fps")) != (640, 360, 20):
        raise ValueError("bar_chart_svg_v1 supports only 640x360 at 20 fps")
    seconds = scene.get("durationSeconds")
    if type(seconds) is not int or not 1 <= seconds <= 5:
        raise ValueError("durationSeconds must be an integer in 1..5")
    _bounded_text(scene.get("title"), limit=20, field="title")
    if "unit" in scene:
        _bounded_text(scene["unit"], limit=3, field="unit")
    bars = scene.get("bars")
    if not isinstance(bars, list) or not 1 <= len(bars) <= 6:
        raise ValueError("bars must contain 1..6 entries")
    for index, bar in enumerate(bars):
        if not isinstance(bar, dict) or set(bar) != _BAR_KEYS:
            raise ValueError(f"bars[{index}] must contain label, value and color")
        _bounded_text(bar["label"], limit=7, field=f"bars[{index}].label")
        value = bar["value"]
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not 0 < value <= 1000
            or (isinstance(value, float) and not math.isfinite(value))
        ):
            raise ValueError(f"bars[{index}].value must be in (0, 1000]")
        if not isinstance(bar["color"], str) or not _COLOR.fullmatch(bar["color"]):
            raise ValueError(f"bars[{index}].color must be #RRGGBB")
    return scene
