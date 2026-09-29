from __future__ import annotations

import os
import time
from datetime import datetime, timedelta
from unittest.mock import patch

import httpx
import pyotp
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


os.environ.setdefault("V8_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault(
    "V8_JWT_SECRET",
    "trusted-device-api-tests-use-a-non-production-secret",
)
os.environ.setdefault(
    "V8_TRUSTED_DEVICE_PEPPER",
    "trusted-device-api-tests-use-a-non-production-pepper",
)
os.environ.setdefault("V8_TOTP_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))


@pytest.fixture
def trusted_auth_app():
    from platform_v8.api.app import app
    from platform_v8.api.deps import get_session
    from platform_v8.api.rate_limit import _hits
    from platform_v8.services.auth import totp as totp_service
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
    secrets: dict[str, str] = {}
    with session_factory() as session:
        for username in ("trusted-api-one", "trusted-api-two"):
            account = AccountRepo.create(
                session,
                username=username,
                email=f"{username}@example.com",
                password_hash=hash_password("Test-2026!"),
            )
            secret = pyotp.random_base32()
            AccountRepo.enable_totp(
                session,
                account.id,
                totp_service.encrypt_secret(secret),
            )
            secrets[username] = secret
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
        yield app, session_factory, secrets
    finally:
        app.dependency_overrides.pop(get_session, None)
        engine.dispose()


def _tauri_headers(
    credential: str | None = None,
    *,
    ip: str = "198.51.100.10",
) -> dict[str, str]:
    headers = {
        "X-Client-Type": "tauri",
        "X-Forwarded-For": ip,
        "User-Agent": "Qianshou Tauri/3.0 macOS",
    }
    if credential:
        headers["X-Device-Credential"] = credential
    return headers


@pytest.mark.asyncio
async def test_tauri_trust_bypass_durations_revoke_and_remote_invalidation(
    trusted_auth_app,
):
    from platform_v8.services.auth import token as token_service
    from platform_v8.services.auth import trusted_devices
    from platform_v8.storage.repo import AuthSessionRepo, TrustedDeviceRepo

    app, session_factory, secrets = trusted_auth_app
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        challenge_response = await client.post(
            "/api/v8/auth/login",
            json={"username": "trusted-api-one", "password": "Test-2026!"},
            headers=_tauri_headers(),
        )
        assert challenge_response.status_code == 200, challenge_response.text
        challenge = challenge_response.json()
        credential = challenge["device_credential"]
        assert challenge["two_factor_required"] is True
        assert "access_token" not in challenge
        with session_factory() as session:
            from sqlalchemy import func, select
            from platform_v8.storage.repo import auth_devices_t

            assert session.execute(
                select(func.count()).select_from(auth_devices_t)
            ).scalar_one() == 0

        current_code = pyotp.TOTP(secrets["trusted-api-one"]).now()
        wrong_totp = await client.post(
            "/api/v8/auth/login/totp",
            json={
                "challenge_token": challenge["challenge_token"],
                "code": f"{(int(current_code) + 1) % 1_000_000:06d}",
            },
            headers=_tauri_headers(credential),
        )
        assert wrong_totp.status_code == 401
        with session_factory() as session:
            from platform_v8.storage.repo import AuditRepo

            failures = AuditRepo.recent(
                session,
                action="auth.login_2fa_fail",
            )
            assert failures[0]["detail"]["reason"] == "wrong_totp"

        detached_challenge = await client.post(
            "/api/v8/auth/login/totp",
            json={
                "challenge_token": challenge["challenge_token"],
                "code": pyotp.TOTP(secrets["trusted-api-one"]).now(),
                "trust_device": True,
            },
            headers=_tauri_headers(),
        )
        assert detached_challenge.status_code == 401
        assert "登录设备验证失败" in detached_challenge.text

        accepted_time = time.time()
        with patch(
            "platform_v8.services.auth.totp._unix_time",
            return_value=accepted_time,
        ):
            trusted_login = await client.post(
                "/api/v8/auth/login/totp",
                json={
                    "challenge_token": challenge["challenge_token"],
                    "code": pyotp.TOTP(secrets["trusted-api-one"]).at(
                        accepted_time
                    ),
                    "trust_device": True,
                },
                headers=_tauri_headers(credential),
            )
        assert trusted_login.status_code == 200, trusted_login.text
        trusted_data = trusted_login.json()
        assert trusted_data["device_credential"] == credential
        first_access = trusted_data["access_token"]
        first_sid = token_service.verify_token(first_access).sid

        bypass = await client.post(
            "/api/v8/auth/login",
            json={"username": "trusted-api-one", "password": "Test-2026!"},
            headers=_tauri_headers(credential),
        )
        assert bypass.status_code == 200, bypass.text
        assert bypass.json()["access_token"]
        assert "two_factor_required" not in bypass.json()
        assert bypass.json()["device_credential"] == credential
        bypass_access = bypass.json()["access_token"]
        bypass_sid = token_service.verify_token(bypass_access).sid
        with session_factory() as session:
            first_row = AuthSessionRepo.by_id_for_account(
                session,
                first_sid,
                1,
            )
            assert first_row["revoked_at"] is not None
            device_id = str(first_row["device_id"])
            bypass_row = AuthSessionRepo.by_id_for_account(
                session,
                bypass_sid,
                1,
            )
            assert bypass_row["revoked_at"] is None
            assert str(bypass_row["device_id"]) == device_id
            same_device_ids = AuthSessionRepo.active_device_ids_for_others(
                session,
                1,
                bypass_sid,
                exclude_device_id=device_id,
            )
            assert same_device_ids == []
            AuthSessionRepo.create(
                session,
                session_id="expired-session",
                account_id=1,
                device_id=device_id,
                device_name="expired",
                device_type="desktop",
                browser="test",
                os_name="test",
                user_agent="test",
                client_ip=None,
            )
            AuthSessionRepo.initialize_refresh(
                session,
                "expired-session",
                1,
                refresh_jti_hash="e" * 64,
                refresh_expires_at=datetime.utcnow() - timedelta(seconds=1),
            )
            session.commit()

        sessions = await client.get(
            "/api/v8/auth/sessions",
            headers={"Authorization": f"Bearer {bypass_access}"},
        )
        assert sessions.status_code == 200, sessions.text
        assert next(
            item for item in sessions.json()["sessions"]
            if item["session_id"] == "expired-session"
        )["status"] == "expired"
        active_session = next(
            item for item in sessions.json()["sessions"]
            if item["session_id"] == bypass_sid
        )
        assert active_session["device_id"] == device_id
        assert active_session["trust_eligible"] is True
        assert active_session["is_trusted"] is True
        assert active_session["trusted_at"]
        assert active_session["trusted_until"]
        assert active_session["trust_permanent"] is False

        revoke_others = await client.delete(
            "/api/v8/auth/sessions",
            headers={"Authorization": f"Bearer {bypass_access}"},
        )
        assert revoke_others.status_code == 200, revoke_others.text
        same_device_bypass = await client.post(
            "/api/v8/auth/login",
            json={"username": "trusted-api-one", "password": "Test-2026!"},
            headers=_tauri_headers(credential),
        )
        assert "two_factor_required" not in same_device_bypass.json()
        bypass_access = same_device_bypass.json()["access_token"]
        bypass_sid = token_service.verify_token(bypass_access).sid

        auth_headers = {"Authorization": f"Bearer {bypass_access}"}
        wrong_password = await client.put(
            f"/api/v8/auth/sessions/{bypass_sid}/trust",
            json={
                "duration": "7d",
                "current_password": "wrong-password",
                "code": pyotp.TOTP(secrets["trusted-api-one"]).now(),
            },
            headers=auth_headers,
        )
        assert wrong_password.status_code == 400

        for step, duration in enumerate(("7d", "90d", "permanent"), start=1):
            trust_time = accepted_time + 30 * step
            with patch(
                "platform_v8.services.auth.totp._unix_time",
                return_value=trust_time,
            ):
                update_trust = await client.put(
                    f"/api/v8/auth/sessions/{bypass_sid}/trust",
                    json={
                        "duration": duration,
                        "current_password": "Test-2026!",
                        "code": pyotp.TOTP(secrets["trusted-api-one"]).at(
                            trust_time
                        ),
                    },
                    headers=auth_headers,
                )
            assert update_trust.status_code == 200, update_trust.text
            assert update_trust.json()["duration"] == duration
            assert update_trust.json()["is_trusted"] is True
            assert update_trust.json()["trust_permanent"] is (
                duration == "permanent"
            )
            assert (update_trust.json()["trusted_until"] is None) is (
                duration == "permanent"
            )

        revoked = await client.delete(
            f"/api/v8/auth/sessions/{bypass_sid}/trust",
            headers=auth_headers,
        )
        assert revoked.status_code == 200, revoked.text
        assert revoked.json()["is_trusted"] is False

        # 另一台设备上的独立会话，用于稍后远程退出当前设备
        other_challenge = await client.post(
            "/api/v8/auth/login",
            json={"username": "trusted-api-one", "password": "Test-2026!"},
            headers=_tauri_headers(ip="203.0.113.50"),
        )
        assert other_challenge.json()["two_factor_required"] is True
        other_credential = other_challenge.json()["device_credential"]
        other_totp_time = accepted_time + 150
        with patch(
            "platform_v8.services.auth.totp._unix_time",
            return_value=other_totp_time,
        ):
            other_login = await client.post(
                "/api/v8/auth/login/totp",
                json={
                    "challenge_token": other_challenge.json()["challenge_token"],
                    "code": pyotp.TOTP(secrets["trusted-api-one"]).at(
                        other_totp_time
                    ),
                    "trust_device": False,
                },
                headers=_tauri_headers(other_credential, ip="203.0.113.50"),
            )
        assert other_login.status_code == 200, other_login.text
        observer_access = other_login.json()["access_token"]

        requires_totp_again = await client.post(
            "/api/v8/auth/login",
            json={"username": "trusted-api-one", "password": "Test-2026!"},
            headers=_tauri_headers(credential),
        )
        assert requires_totp_again.json()["two_factor_required"] is True

        retrust_time = accepted_time + 180
        with patch(
            "platform_v8.services.auth.totp._unix_time",
            return_value=retrust_time,
        ):
            retrusted = await client.post(
                "/api/v8/auth/login/totp",
                json={
                    "challenge_token": requires_totp_again.json()["challenge_token"],
                    "code": pyotp.TOTP(secrets["trusted-api-one"]).at(
                        retrust_time
                    ),
                    "trust_device": True,
                },
                headers=_tauri_headers(credential),
            )
        assert retrusted.status_code == 200, retrusted.text
        retrusted_sid = token_service.verify_token(
            retrusted.json()["access_token"]
        ).sid

        remote_revoke = await client.delete(
            f"/api/v8/auth/sessions/{retrusted_sid}",
            headers={"Authorization": f"Bearer {observer_access}"},
        )
        assert remote_revoke.status_code == 200, remote_revoke.text

        after_remote_revoke = await client.post(
            "/api/v8/auth/login",
            json={"username": "trusted-api-one", "password": "Test-2026!"},
            headers=_tauri_headers(credential),
        )
        assert after_remote_revoke.json()["two_factor_required"] is True

        with session_factory() as session:
            device = trusted_devices.resolve_for_account(
                session,
                account_id=1,
                credential=credential,
            )
            assert device is not None
            assert device["credential_hash"] != credential
            assert device["trust_revoked_at"] is not None
            assert device["last_trusted_login_at"] is not None
            assert TrustedDeviceRepo.by_id_for_account(
                session,
                device_id,
                1,
            )["credential_hash"] != credential

        wrong_account = await client.post(
            "/api/v8/auth/login",
            json={"username": "trusted-api-two", "password": "Test-2026!"},
            headers=_tauri_headers(credential, ip="198.51.100.20"),
        )
        assert wrong_account.status_code == 200, wrong_account.text
        assert wrong_account.json()["two_factor_required"] is True
        assert wrong_account.json()["device_credential"] != credential

        assert bypass_sid != first_sid
        assert retrusted_sid != bypass_sid
@pytest.mark.asyncio
async def test_web_cookie_is_httponly_local_http_and_supports_trusted_bypass(
    trusted_auth_app,
):
    app, _, secrets = trusted_auth_app
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"X-Forwarded-For": "198.51.100.30"},
    ) as client:
        challenge_response = await client.post(
            "/api/v8/auth/login",
            json={"username": "trusted-api-one", "password": "Test-2026!"},
        )
        assert challenge_response.status_code == 200, challenge_response.text
        # 网页也回传 device_credential（跨端口 MFA），同时仍写 HttpOnly Cookie
        challenge_body = challenge_response.json()
        assert challenge_body.get("device_credential")
        set_cookie = challenge_response.headers["set-cookie"]
        assert "we_trusted_device=" in set_cookie
        assert "httponly" in set_cookie.lower()
        assert "samesite=lax" in set_cookie.lower()
        assert "secure" not in set_cookie.lower()

        verified = await client.post(
            "/api/v8/auth/login/totp",
            json={
                "challenge_token": challenge_response.json()["challenge_token"],
                "code": pyotp.TOTP(secrets["trusted-api-one"]).now(),
                "trust_device": True,
            },
        )
        assert verified.status_code == 200, verified.text
        assert verified.json().get("device_credential")
        assert verified.json()["refresh_token"]  # body + cookie · 跨端口 SPA 靠 body
        refresh_set_cookie = next(
            value for value in verified.headers.get_list("set-cookie")
            if value.startswith("we_refresh_token=")
        )
        assert "max-age=" not in refresh_set_cookie.lower()
        refresh_cookie = client.cookies.get("we_refresh_token")
        assert refresh_cookie
        refreshed = await client.post("/api/v8/auth/refresh")
        assert refreshed.status_code == 200, refreshed.text
        assert refreshed.json()["tokens"]["refresh_token"]
        assert client.cookies.get("we_refresh_token") != refresh_cookie

        bypass = await client.post(
            "/api/v8/auth/login",
            json={
                "username": "trusted-api-one",
                "password": "Test-2026!",
                "remember_me": True,
            },
        )
        assert bypass.status_code == 200, bypass.text
        assert bypass.json()["access_token"]
        assert "two_factor_required" not in bypass.json()
        assert bypass.json().get("device_credential")
        persistent_refresh = next(
            value for value in bypass.headers.get_list("set-cookie")
            if value.startswith("we_refresh_token=")
        )
        assert "max-age=" in persistent_refresh.lower()

        logout = await client.post(
            "/api/v8/auth/logout",
            headers={"Authorization": f"Bearer {bypass.json()['access_token']}"},
        )
        assert logout.status_code == 200, logout.text

        after_logout = await client.post(
            "/api/v8/auth/login",
            json={"username": "trusted-api-one", "password": "Test-2026!"},
        )
        assert after_logout.status_code == 200, after_logout.text
        assert "two_factor_required" not in after_logout.json()

        password_change = await client.put(
            "/api/v8/auth/me",
            json={
                "old_password": "Test-2026!",
                "password": "Changed-2026!",
            },
            headers={
                "Authorization": f"Bearer {after_logout.json()['access_token']}"
            },
        )
        assert password_change.status_code == 200, password_change.text
        assert password_change.json()["reauthentication_required"] is True
        revoked_current = await client.get(
            "/api/v8/auth/me",
            headers={
                "Authorization": f"Bearer {after_logout.json()['access_token']}"
            },
        )
        assert revoked_current.status_code == 401

        after_password_change = await client.post(
            "/api/v8/auth/login",
            json={"username": "trusted-api-one", "password": "Changed-2026!"},
        )
        assert after_password_change.status_code == 200
        assert after_password_change.json()["two_factor_required"] is True


@pytest.mark.asyncio
async def test_registration_creates_device_bound_refresh_session(
    trusted_auth_app,
):
    from platform_v8.services.auth import token as token_service
    from platform_v8.storage.repo import AuthSessionRepo, TrustedDeviceRepo

    app, session_factory, _ = trusted_auth_app
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        registered = await client.post(
            "/api/v8/auth/register",
            json={
                "username": "registered-device-user",
                "email": "registered-device@example.com",
                "password": "Test-2026!",
                "remember_me": True,
            },
        )
        assert registered.status_code == 200, registered.text
        assert registered.json()["refresh_token"]
        assert client.cookies.get("we_refresh_token")
        assert client.cookies.get("we_trusted_device")

        claims = token_service.verify_token(
            registered.json()["access_token"],
            expected_kind="access",
        )
        with session_factory() as session:
            row = AuthSessionRepo.by_id_for_account(
                session,
                claims.sid,
                claims.account_id,
            )
            assert row["refresh_jti_hash"]
            assert row["refresh_expires_at"]
            assert row["remember_me"] is True
            assert TrustedDeviceRepo.by_id_for_account(
                session,
                str(row["device_id"]),
                claims.account_id,
            ) is not None
