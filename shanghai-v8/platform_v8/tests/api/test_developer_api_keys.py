"""开发者 API Key · CRUD + Bearer qs_ 鉴权。"""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("V8_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault(
    "V8_JWT_SECRET",
    "developer-api-key-tests-use-a-non-production-secret",
)


@pytest.fixture
def developer_app():
    from platform_v8.api.app import app
    from platform_v8.api.deps import get_session
    from platform_v8.api.rate_limit import _hits
    from platform_v8.services.auth.passwords import hash_password
    from platform_v8.storage.repo import AccountRepo, create_all_for_testing

    _hits.clear()
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    create_all_for_testing(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    with session_factory() as session:
        AccountRepo.create(
            session,
            username="dev-api-user",
            email="dev-api@example.com",
            password_hash=hash_password("Test-2026!"),
        )
        session.commit()

    def _session_override():
        with session_factory() as session:
            try:
                yield session
                session.commit()
            except Exception:
                session.rollback()
                raise

    app.dependency_overrides[get_session] = _session_override
    try:
        yield app, session_factory
    finally:
        app.dependency_overrides.pop(get_session, None)
        engine.dispose()
        _hits.clear()


async def _login(client: httpx.AsyncClient) -> str:
    resp = await client.post(
        "/api/v8/auth/login",
        json={"username": "dev-api-user", "password": "Test-2026!"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _me_username(payload: dict) -> str:
    if "username" in payload:
        return payload["username"]
    account = payload.get("account") or {}
    return account.get("username") or ""


@pytest.mark.asyncio
async def test_developer_keys_crud_and_bearer_auth(developer_app):
    app, _session_factory = developer_app
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        jwt = await _login(client)
        jwt_headers = {"Authorization": f"Bearer {jwt}"}

        me = await client.get("/api/v8/auth/me", headers=jwt_headers)
        assert me.status_code == 200
        assert _me_username(me.json()) == "dev-api-user"
        created = await client.post(
            "/api/v8/developer/keys",
            headers=jwt_headers,
            json={"name": "ci-key", "scopes": ["files", "workloads"]},
        )
        assert created.status_code == 201, created.text
        body = created.json()
        assert body["ok"] is True
        item = body["item"]
        secret = item["secret_once"]
        assert secret.startswith("qs_")
        assert item["key_prefix"].startswith("qs_")
        key_id = item["id"]

        listed = await client.get("/api/v8/developer/keys", headers=jwt_headers)
        assert listed.status_code == 200
        items = listed.json()["items"]
        assert len(items) == 1
        assert "secret_once" not in items[0]
        assert items[0]["key_prefix"] == item["key_prefix"]

        key_headers = {"Authorization": f"Bearer {secret}"}
        me_via_key = await client.get("/api/v8/auth/me", headers=key_headers)
        assert me_via_key.status_code == 403

        mock_provider = MagicMock()
        mock_provider.presign_put.return_value = {
            "url": "https://example.test/put",
            "headers": {},
        }
        with patch(
            "platform_v8.services.oss_provider.get_oss_provider",
            return_value=mock_provider,
        ):
            up = await client.post(
                "/api/v8/files/upload-url",
                headers=key_headers,
                json={
                    "filename": "a.png",
                    "content_type": "image/png",
                    "purpose": "input",
                },
            )
        assert up.status_code == 200, up.text
        assert up.json()["object_key"].startswith("v8/account-")
        assert up.json()["upload_url"] == "https://example.test/put"

        submit = await client.post(
            "/api/v8/workloads",
            headers=key_headers,
            json={"name": "dev-test", "budget": 0, "spec": {"task_type": "local_llm_chat"}},
        )
        assert submit.status_code == 403

        revoked = await client.delete(
            f"/api/v8/developer/keys/{key_id}",
            headers=jwt_headers,
        )
        assert revoked.status_code == 200
        after = await client.get("/api/v8/developer/task-types", headers=key_headers)
        assert after.status_code == 401


@pytest.mark.asyncio
async def test_developer_key_ownership_and_limit(developer_app):
    from platform_v8.api.rate_limit import _hits
    from platform_v8.services.auth.passwords import hash_password
    from platform_v8.storage.repo import API_KEY_MAX_PER_ACCOUNT, AccountRepo, ApiKeyRepo

    app, session_factory = developer_app

    with session_factory() as session:
        other = AccountRepo.create(
            session,
            username="dev-api-other",
            email="dev-other@example.com",
            password_hash=hash_password("Test-2026!"),
        )
        owner = AccountRepo.by_username(session, "dev-api-user")
        assert owner is not None
        for i in range(API_KEY_MAX_PER_ACCOUNT):
            ApiKeyRepo.create(session, account_id=owner.id, name=f"k{i}")
        session.commit()
        other_id = other.id
        owner_id = owner.id

    _hits.clear()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        jwt = await _login(client)
        headers = {"Authorization": f"Bearer {jwt}"}

        overflow = await client.post(
            "/api/v8/developer/keys",
            headers=headers,
            json={"name": "overflow"},
        )
        assert overflow.status_code == 400

        other_login = await client.post(
            "/api/v8/auth/login",
            json={"username": "dev-api-other", "password": "Test-2026!"},
        )
        assert other_login.status_code == 200
        other_jwt = other_login.json()["access_token"]
        listed = await client.get("/api/v8/developer/keys", headers=headers)
        victim_id = listed.json()["items"][0]["id"]
        stolen = await client.delete(
            f"/api/v8/developer/keys/{victim_id}",
            headers={"Authorization": f"Bearer {other_jwt}"},
        )
        assert stolen.status_code == 404
        assert other_id != owner_id
