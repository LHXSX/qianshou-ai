"""声明式 Runtime V2 作者上架：caps 真相源 + 门禁。"""
from __future__ import annotations

import pytest

from platform_v8.engine import capabilities as cap_reg
from platform_v8.services.marketplace.apps import (
    _merge_v2_author_fields_into_body,
    _sanitize_display_meta,
    _validate_v2_author_app,
    build_run_hint,
    MarketplaceError,
)
from platform_v8.services.marketplace.execution_model import marketplace_manifest_v2_fields
from platform_v8.services.marketplace.readiness import build_requirements


def test_sanitize_keeps_runtime_api_and_caps():
    meta = _sanitize_display_meta(
        {
            "execution_model": "runtime_v2",
            "runtime_api": "2.0",
            "required_capabilities": [
                {"name": "media.probe", "version": ">=1.0.0 <2.0.0"},
                {"name": "not.a.cap", "version": "1"},
            ],
            "tagline": "hello",
        }
    )
    assert meta["execution_model"] == "runtime_v2"
    assert meta["runtime_api"] == "2.0"
    assert meta["required_capabilities"] == [
        {"name": "media.probe", "version": ">=1.0.0 <2.0.0"}
    ]
    assert meta["tagline"] == "hello"


def test_manifest_v2_prefers_author_caps_over_registry():
    app = {
        "task_type": "word_count",  # registry → 无 MVP caps
        "display_meta": {
            "execution_model": "runtime_v2",
            "required_capabilities": [
                {"name": "media.probe", "version": ">=1.0.0 <2.0.0"}
            ],
        },
    }
    fields = marketplace_manifest_v2_fields(app)
    assert fields["execution_model"] == "runtime_v2"
    assert [c["name"] for c in fields["required_capabilities"]] == ["media.probe"]
    req = build_requirements(app)
    assert [c["name"] for c in req["required_capabilities"]] == ["media.probe"]


def test_validate_rejects_empty_and_unknown():
    with pytest.raises(MarketplaceError, match="至少 1 个"):
        _validate_v2_author_app(
            {"execution_model": "runtime_v2"},
            display_meta={"execution_model": "runtime_v2"},
        )
    with pytest.raises(MarketplaceError, match="不支持的 Capability"):
        _validate_v2_author_app(
            {
                "execution_model": "runtime_v2",
                "required_capabilities": [{"name": "evil.cap", "version": "1"}],
            },
            display_meta={"execution_model": "runtime_v2"},
        )


def test_merge_app_manifest_v2():
    body = _merge_v2_author_fields_into_body(
        {
            "slug": "demo-media",
            "app_manifest_v2": {
                "name": "媒体探查",
                "executionModel": "runtime_v2",
                "runtimeApi": ">=2.0.0 <3.0.0",
                "requiresCapabilities": [{"name": "media.probe", "version": ">=1.0.0 <2.0.0"}],
                "input": {"kind": "single_file", "accept": ["video/*"]},
                "fallback": {"legacyTaskType": "video_info"},
            },
        }
    )
    assert body["name"] == "媒体探查"
    assert body["task_type"] == "video_info"
    assert body["input_kind"] == "single_file"
    assert body["display_meta"]["execution_model"] == "runtime_v2"
    assert body["display_meta"]["required_capabilities"][0]["name"] == "media.probe"


def test_build_run_hint_runtime_v2():
    hint = build_run_hint(
        {
            "launch_kind": "workload",
            "execution_model": "runtime_v2",
            "required_capabilities": [
                {"name": "data.table.read", "version": "1.0.0"}
            ],
            "input_kind": "single_file",
        }
    )
    assert hint["mode"] == "runtime_v2"
    assert hint["ready"] is True
    assert hint["required_capabilities"][0]["name"] == "data.table.read"


def test_validate_author_capabilities_helper():
    cleaned = cap_reg.validate_author_capabilities_for_v2(
        [{"name": "doc.pdf.text", "version": ">=1.0.0 <2.0.0"}]
    )
    assert cleaned[0]["name"] == "doc.pdf.text"
