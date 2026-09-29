"""tests.utils · Auth TestClient helper 行为约束。"""
from __future__ import annotations

from platform_v8.api.deps import get_admin_account
from platform_v8.tests.utils import client_with_admin, make_fake_account


def test_client_with_admin_restores_overrides():
    from platform_v8.api.app import app

    assert get_admin_account not in app.dependency_overrides
    with client_with_admin(app, account=make_fake_account(account_id=9)) as client:
        assert get_admin_account in app.dependency_overrides
        client.get("/api/v8/admin/proxy/stats")
    assert get_admin_account not in app.dependency_overrides
