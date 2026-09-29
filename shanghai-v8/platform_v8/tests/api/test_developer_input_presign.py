"""开发者文件输入必须在派单前转换成节点可下载 URL。"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from platform_v8.api.v8 import developer
from platform_v8.services import oss_provider


class _Provider:
    def __init__(self, *, invalid: bool = False):
        self.invalid = invalid
        self.calls: list[tuple[str, int]] = []

    def presign_get(self, key: str, *, expires: int):
        self.calls.append((key, expires))
        if self.invalid:
            return {"url": key}
        return {"url": f"https://oss.example.test/{key}?signed=1"}


def test_presign_input_refs_returns_http_urls(monkeypatch):
    provider = _Provider()
    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: provider)

    urls = developer._presign_input_refs(
        ["v8/account-6/developer/input/a.pdf"], timeout_s=3600
    )

    assert urls == [
        "https://oss.example.test/v8/account-6/developer/input/a.pdf?signed=1"
    ]
    assert provider.calls[0][1] >= 86400


def test_presign_input_refs_rejects_non_http_result(monkeypatch):
    monkeypatch.setattr(
        oss_provider, "get_oss_provider", lambda: _Provider(invalid=True)
    )

    with pytest.raises(HTTPException) as exc:
        developer._presign_input_refs(
            ["v8/account-6/developer/input/a.pdf"], timeout_s=3600
        )

    assert exc.value.status_code == 503


def test_developer_owned_key_supports_sts_namespace_and_rejects_traversal():
    key = "uploads/tenant_6/task_x/input/a.pdf"
    assert developer._validate_owned_object_key(6, key) == key
    with pytest.raises(HTTPException) as exc:
        developer._validate_owned_object_key(
            6, "v8/account-6/input/%252e%252e/foreign.pdf"
        )
    assert exc.value.status_code == 403