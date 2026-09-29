"""RT-B · marketplace apps plugin 字段校验（不连库）。"""
from __future__ import annotations

import pytest

from platform_v8.services.marketplace import apps as apps_svc


def test_validate_plugin_fields_defaults_for_app():
    out = apps_svc._validate_runtime_plugin_fields({"launch_kind": "workload"}, for_publish=False)
    assert out["package_kind"] == "app"
    assert out["capabilities"] == []
    assert out["plugin_package_url"] is None


def test_validate_plugin_publish_requires_caps_and_url():
    with pytest.raises(apps_svc.MarketplaceError):
        apps_svc._validate_runtime_plugin_fields(
            {"launch_kind": "plugin", "package_kind": "plugin"},
            for_publish=True,
        )
    with pytest.raises(apps_svc.MarketplaceError):
        apps_svc._validate_runtime_plugin_fields(
            {
                "launch_kind": "plugin",
                "package_kind": "plugin",
                "capabilities": ["doc.ocr"],
            },
            for_publish=True,
        )
    ok = apps_svc._validate_runtime_plugin_fields(
        {
            "launch_kind": "plugin",
            "package_kind": "plugin",
            "capabilities": ["doc.ocr"],
            "plugin_package_url": "https://example.com/p.zip",
        },
        for_publish=True,
    )
    assert ok["runtime_api"] == "1.0.0"
    assert ok["capabilities"] == ["doc.ocr"]


def test_build_run_hint_plugin_mode():
    hint = apps_svc.build_run_hint(
        {
            "launch_kind": "plugin",
            "package_kind": "plugin",
            "runtime_api": "1.0.0",
            "capabilities": ["doc.ocr"],
            "plugin_manifest_url": "https://example.com/m.json",
        }
    )
    assert hint["mode"] == "plugin"
    assert hint["executor"] == "plugin.v1"
    assert hint["ready"] is True


def test_serialize_app_fills_plugin_defaults():
    out = apps_svc._serialize_app({"name": "x", "slug": "x", "launch_kind": "workload"})
    assert out["capabilities"] == []
    assert out["package_kind"] == "app"
