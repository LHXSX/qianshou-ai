"""Unit tests for login device UA classification."""
from __future__ import annotations

from platform_v8.services.auth.sessions import describe_user_agent


def test_edgecompute_client_ua_is_native_client():
    described = describe_user_agent("EdgeCompute-Client/3.2.1")
    assert described["browser"] == "千手节点客户端"
    assert described["device_type"] == "client"
    assert described["device_name"].startswith("千手节点客户端")


def test_edgecompute_client_ua_with_platform():
    described = describe_user_agent("EdgeCompute-Client/3.2.1 (macos; Tauri)")
    assert described["browser"] == "千手节点客户端"
    assert described["os"] == "macOS"
    assert described["device_name"] == "千手节点客户端 · macOS"
    assert described["device_type"] == "client"


def test_x_client_type_overrides_unknown_ua():
    described = describe_user_agent(
        "custom-agent/1.0",
        client_type="tauri",
        client_platform="windows",
    )
    assert described["browser"] == "千手节点客户端"
    assert described["os"] == "Windows"
    assert described["device_type"] == "client"


def test_chrome_ua_unchanged():
    described = describe_user_agent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
    assert described["browser"] == "Chrome"
    assert described["os"] == "macOS"
    assert described["device_type"] == "desktop"
