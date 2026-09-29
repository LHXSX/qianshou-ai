from __future__ import annotations

import os
import time
from unittest.mock import patch

import pyotp
import pytest
import httpx
from cryptography.fernet import Fernet
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


os.environ.setdefault("V8_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("V8_JWT_SECRET", "test-jwt-secret-that-is-longer-than-32-characters")
os.environ.setdefault("V8_TOTP_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))


@pytest.fixture
def totp_app():
    from platform_v8.api.app import app
    from platform_v8.api.deps import get_current_account, get_session
    from platform_v8.services.auth.passwords import hash_password
    from platform_v8.storage.repo import AccountRepo, create_all_for_testing

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    create_all_for_testing(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    with session_factory() as session:
        account = AccountRepo.create(
            session,
            username="totp-user",
            email="totp@example.com",
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

    def _account_override():
        with session_factory() as session:
            return AccountRepo.by_id(session, account.id)

    app.dependency_overrides[get_session] = _session_override
    app.dependency_overrides[get_current_account] = _account_override
    try:
        yield app, session_factory
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_current_account, None)
        engine.dispose()


def _wrong_code(code: str) -> str:
    return f"{(int(code) + 1) % 1_000_000:06d}"


@pytest.mark.asyncio
async def test_totp_setup_confirm_status_disable_flow(totp_app):
    app, session_factory = totp_app
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await _assert_totp_flow(client, session_factory)


async def _assert_totp_flow(client: httpx.AsyncClient, session_factory):
    from platform_v8.services.auth import token as token_service
    from platform_v8.storage.repo import AuthSessionRepo

    status = await client.get("/api/v8/auth/totp/status")
    assert status.status_code == 200
    assert status.json()["enabled"] is False

    wrong_password = await client.post(
        "/api/v8/auth/totp/setup",
        json={"current_password": "wrong-password"},
    )
    assert wrong_password.status_code == 400

    pre_enable_login = await client.post(
        "/api/v8/auth/login",
        json={"username": "totp-user", "password": "Test-2026!"},
    )
    pre_enable_sid = token_service.verify_token(
        pre_enable_login.json()["access_token"]
    ).sid

    setup = await client.post(
        "/api/v8/auth/totp/setup",
        json={"current_password": "Test-2026!"},
    )
    assert setup.status_code == 200, setup.text
    assert setup.headers["cache-control"] == "no-store"
    setup_data = setup.json()
    assert setup_data["secret"]
    assert setup_data["secret"] not in setup_data["setup_token"]

    code = pyotp.TOTP(setup_data["secret"]).now()
    wrong_confirm = await client.post(
        "/api/v8/auth/totp/confirm",
        json={"setup_token": setup_data["setup_token"], "code": _wrong_code(code)},
    )
    assert wrong_confirm.status_code == 400

    confirmed = await client.post(
        "/api/v8/auth/totp/confirm",
        json={"setup_token": setup_data["setup_token"], "code": code},
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["enabled"] is True
    assert confirmed.json()["reauthentication_required"] is True
    assert "secret" not in confirmed.text.lower()
    with session_factory() as session:
        assert AuthSessionRepo.by_id_for_account(
            session,
            pre_enable_sid,
            1,
        )["revoked_at"] is not None

    enabled_status = await client.get("/api/v8/auth/totp/status")
    assert enabled_status.status_code == 200
    assert enabled_status.json()["enabled"] is True
    assert enabled_status.json()["enabled_at"]
    assert "secret" not in enabled_status.text.lower()

    password_login = await client.post(
        "/api/v8/auth/login",
        json={"username": "totp-user", "password": "Test-2026!"},
    )
    assert password_login.status_code == 200, password_login.text
    challenge = password_login.json()
    assert challenge["two_factor_required"] is True
    assert challenge["challenge_token"]
    assert "access_token" not in challenge
    assert challenge["default_method"] == "totp"
    assert [item["method"] for item in challenge["available_methods"]] == ["totp"]

    wrong_login_code = await client.post(
        "/api/v8/auth/login/totp",
        json={
            "challenge_token": challenge["challenge_token"],
            "code": _wrong_code(code),
        },
    )
    assert wrong_login_code.status_code == 401

    login_time = time.time() + 30
    with patch(
        "platform_v8.services.auth.totp._unix_time",
        return_value=login_time,
    ):
        verified_login = await client.post(
            "/api/v8/auth/login/totp",
            json={
                "challenge_token": challenge["challenge_token"],
                "code": pyotp.TOTP(setup_data["secret"]).at(login_time),
            },
        )
    assert verified_login.status_code == 200, verified_login.text
    assert verified_login.json()["access_token"]
    replayed_challenge = await client.post(
        "/api/v8/auth/login/totp",
        json={
            "challenge_token": challenge["challenge_token"],
            "code": pyotp.TOTP(setup_data["secret"]).at(login_time + 30),
        },
    )
    assert replayed_challenge.status_code == 401
    verified_claims = token_service.verify_token(
        verified_login.json()["access_token"],
        expected_kind="access",
    )
    assert verified_claims.sid

    sessions = await client.get(
        "/api/v8/auth/sessions",
        headers={"Authorization": f"Bearer {verified_login.json()['access_token']}"},
    )
    assert sessions.status_code == 200, sessions.text
    active_sessions = [item for item in sessions.json()["sessions"] if item["status"] == "active"]
    assert active_sessions
    assert active_sessions[0]["device_name"]
    assert active_sessions[0]["last_seen_at"]

    revoked = await client.delete(
        f"/api/v8/auth/sessions/{active_sessions[0]['session_id']}",
        headers={"Authorization": f"Bearer {verified_login.json()['access_token']}"},
    )
    assert revoked.status_code == 200
    history = await client.get(
        "/api/v8/auth/sessions",
        headers={"Authorization": f"Bearer {verified_login.json()['access_token']}"},
    )
    assert any(item["status"] == "revoked" for item in history.json()["sessions"])

    duplicate = await client.post(
        "/api/v8/auth/totp/confirm",
        json={"setup_token": setup_data["setup_token"], "code": code},
    )
    assert duplicate.status_code == 409

    wrong_disable = await client.post(
        "/api/v8/auth/totp/disable",
        json={"current_password": "Test-2026!", "code": _wrong_code(code)},
    )
    assert wrong_disable.status_code == 400

    disable_time = login_time + 30
    with patch(
        "platform_v8.services.auth.totp._unix_time",
        return_value=disable_time,
    ):
        disabled = await client.post(
            "/api/v8/auth/totp/disable",
            json={
                "current_password": "Test-2026!",
                "code": pyotp.TOTP(setup_data["secret"]).at(disable_time),
            },
        )
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["enabled"] is False
    assert disabled.json()["reauthentication_required"] is True
    with session_factory() as session:
        assert AuthSessionRepo.by_id_for_account(
            session,
            verified_claims.sid,
            1,
        )["revoked_at"] is not None

    final_status = await client.get("/api/v8/auth/totp/status")
    assert final_status.json() == {"ok": True, "enabled": False, "enabled_at": None}

    normal_login = await client.post(
        "/api/v8/auth/login",
        json={"username": "totp-user", "password": "Test-2026!"},
    )
    assert normal_login.status_code == 200
    assert normal_login.json()["access_token"]
    assert "two_factor_required" not in normal_login.json()
    normal_access_claims = token_service.verify_token(normal_login.json()["access_token"])
    assert normal_login.json()["refresh_token"]
    refreshed = await client.post("/api/v8/auth/refresh", json={})
    assert refreshed.status_code == 200, refreshed.text
    refreshed_claims = token_service.verify_token(
        refreshed.json()["tokens"]["access_token"],
    )
    assert refreshed_claims.sid == normal_access_claims.sid
    assert refreshed.json()["tokens"]["refresh_token"]
