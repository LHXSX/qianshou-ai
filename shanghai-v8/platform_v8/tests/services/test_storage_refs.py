from __future__ import annotations

from types import SimpleNamespace

import pytest

from platform_v8.services import oss_provider
from platform_v8.services.storage_refs import (
    StorageReferenceError,
    canonicalize_owned_reference,
    materialize_get_url,
    validate_owned_object_key,
)


class _Provider:
    endpoint = "https://oss-cn-guangzhou.aliyuncs.com"
    bucket = "edgecompute"
    prefix = ""

    def presign_get(self, key: str, *, expires: int):
        return SimpleNamespace(
            url=f"https://edgecompute.oss-cn-guangzhou.aliyuncs.com/{key}?secret=yes"
        )


@pytest.mark.parametrize(
    "key",
    [
        "v8/account-7/input/a.pdf",
        "uploads/tenant_7/task_x/a.pdf",
    ],
)
def test_owned_key_accepts_both_namespaces(key):
    assert validate_owned_object_key(7, key) == key


@pytest.mark.parametrize(
    "key",
    [
        "v8/account-8/input/a.pdf",
        "https://example.test/v8/account-7/a",
        "v8/account-7/a?token=x",
        "v8/account-7/a\\b",
        "v8/account-7//a",
        "v8/account-7/%2e%2e/a",
        "v8/account-7/%252e%252e/a",
        "v8/account-7/a\x00b",
    ],
)
def test_owned_key_rejects_foreign_and_ambiguous_paths(key):
    with pytest.raises(StorageReferenceError):
        validate_owned_object_key(7, key)


def test_historical_presigned_url_recovers_owned_key(monkeypatch):
    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Provider())
    url = (
        "https://edgecompute.oss-cn-guangzhou.aliyuncs.com/"
        "v8/account-7/input/a.pdf?OSSAccessKeyId=secret"
    )
    assert canonicalize_owned_reference(7, url) == "v8/account-7/input/a.pdf"
    with pytest.raises(StorageReferenceError):
        canonicalize_owned_reference(8, url)
    with pytest.raises(StorageReferenceError):
        canonicalize_owned_reference(
            7, "https://evil.example/v8/account-7/input/a.pdf?secret=x"
        )


def test_materialize_supports_provider_shape_and_never_returns_key(monkeypatch):
    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Provider())
    url = materialize_get_url(7, "v8/account-7/input/a.pdf", 600)
    assert url.startswith("https://")
    assert url != "v8/account-7/input/a.pdf"

    class _Bad(_Provider):
        def presign_get(self, key: str, *, expires: int):
            return {"url": key}

    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Bad())
    with pytest.raises(StorageReferenceError):
        materialize_get_url(7, "v8/account-7/input/a.pdf", 600)
