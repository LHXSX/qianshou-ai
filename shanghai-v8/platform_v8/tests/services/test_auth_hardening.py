from __future__ import annotations

import os
import hashlib
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

os.environ.setdefault(
    "V8_JWT_SECRET",
    "auth-hardening-tests-use-a-long-non-production-secret",
)


@pytest.fixture
def auth_engine(tmp_path):
    from platform_v8.services.auth.passwords import hash_password
    from platform_v8.storage.repo import AccountRepo, create_all_for_testing

    engine = create_engine(f"sqlite:///{tmp_path / 'auth.db'}")
    create_all_for_testing(engine)
    with Session(engine) as session:
        AccountRepo.create(
            session,
            username="hardening-user",
            email="hardening@example.com",
            password_hash=hash_password("Test-2026!"),
        )
        session.commit()
    try:
        yield engine
    finally:
        engine.dispose()


def _new_login(engine):
    from platform_v8.services.auth import login
    from platform_v8.storage.repo import AccountRepo

    with Session(engine) as session:
        account = AccountRepo.by_id(session, 1)
        out = login.complete_login(
            session,
            account,
            login.LoginInput(
                username=account.username,
                password="",
                remember_me=True,
            ),
        )
        session.commit()
        return out


def test_refresh_cas_reuse_revokes_family(auth_engine):
    from platform_v8.services.auth import login, token, validation
    from platform_v8.storage.repo import AuthSessionRepo

    initial = _new_login(auth_engine)
    with Session(auth_engine) as session:
        rotated = login.refresh(session, initial.tokens.refresh_token)
        session.commit()

    with Session(auth_engine) as session:
        with pytest.raises(login.LoginError, match="重用"):
            login.refresh(session, initial.tokens.refresh_token)

    with Session(auth_engine) as session:
        sid = token.verify_token(rotated.tokens.access_token).sid
        row = AuthSessionRepo.by_id_for_account(session, sid, 1)
        assert row["revoked_at"] is not None
        with pytest.raises(validation.AuthValidationError):
            validation.validate_v8_access(
                session,
                rotated.tokens.access_token,
            )


def test_refresh_compare_and_swap_allows_one_contender(auth_engine):
    from platform_v8.services.auth import token
    from platform_v8.storage.repo import AuthSessionRepo

    initial = _new_login(auth_engine)
    claims = token.verify_token(
        initial.tokens.refresh_token,
        expected_kind="refresh",
    )
    expected = hashlib.sha256(claims.jti.encode()).hexdigest()
    expiry = datetime.utcnow() + timedelta(days=7)

    with Session(auth_engine) as first:
        assert AuthSessionRepo.rotate_refresh(
            first,
            claims.sid,
            claims.account_id,
            expected_jti_hash=expected,
            new_jti_hash="a" * 64,
            new_expires_at=expiry,
        )
        first.commit()
    with Session(auth_engine) as second:
        assert not AuthSessionRepo.rotate_refresh(
            second,
            claims.sid,
            claims.account_id,
            expected_jti_hash=expected,
            new_jti_hash="b" * 64,
            new_expires_at=expiry,
        )


def test_legacy_refresh_family_fails_closed(auth_engine):
    from platform_v8.services.auth import login, token
    from platform_v8.storage.repo import AuthSessionRepo

    with Session(auth_engine) as session:
        AuthSessionRepo.create(
            session,
            session_id="legacy-session",
            account_id=1,
            device_id=None,
            device_name="legacy",
            device_type="desktop",
            browser="legacy",
            os_name="legacy",
            user_agent="legacy",
            client_ip=None,
        )
        pair = token.issue_token_pair(
            account_id=1,
            role="personal",
            session_id="legacy-session",
        )
        session.commit()

    with Session(auth_engine) as session:
        with pytest.raises(login.LoginError, match="旧版"):
            login.refresh(session, pair.refresh_token)

    with Session(auth_engine) as session:
        row = AuthSessionRepo.by_id_for_account(session, "legacy-session", 1)
        assert row["revoked_at"] is not None


def test_shared_validator_checks_jti_and_session(auth_engine):
    from platform_v8.services.auth import validation
    from platform_v8.storage.repo import AuthSessionRepo

    out = _new_login(auth_engine)
    with Session(auth_engine) as session:
        validated = validation.validate_v8_access(
            session,
            out.tokens.access_token,
        )
        assert validated.account.id == 1
        AuthSessionRepo.revoke(
            session,
            validated.claims.sid,
            validated.claims.account_id,
        )
        session.commit()

    with Session(auth_engine) as session:
        with pytest.raises(validation.AuthValidationError, match="会话"):
            validation.validate_v8_access(session, out.tokens.access_token)


def test_legacy_desktop_ws_accepts_only_current_refresh_head(
    auth_engine,
    monkeypatch: pytest.MonkeyPatch,
):
    from platform_v8.services.auth import login, validation

    monkeypatch.delenv("V8_WS_REFRESH_COMPAT_DISABLED", raising=False)
    monkeypatch.setenv("V8_WS_REFRESH_COMPAT_UNTIL", "2099-01-01T00:00:00Z")
    initial = _new_login(auth_engine)

    with Session(auth_engine) as session:
        validated = validation.validate_legacy_v8_ws_refresh(
            session,
            initial.tokens.refresh_token,
        )
        assert validated.account.id == 1

    with Session(auth_engine) as session:
        login.refresh(session, initial.tokens.refresh_token)
        session.commit()

    with Session(auth_engine) as session:
        # refresh 轮换后旧 token 的 jti 与会话头不一致，走会话校验而非 jti 吊销表
        with pytest.raises(validation.AuthValidationError, match="轮换|过期|退出"):
            validation.validate_legacy_v8_ws_refresh(
                session,
                initial.tokens.refresh_token,
            )


def test_legacy_desktop_ws_compatibility_can_be_disabled(
    auth_engine,
    monkeypatch: pytest.MonkeyPatch,
):
    from platform_v8.services.auth import validation

    initial = _new_login(auth_engine)
    monkeypatch.setenv("V8_WS_REFRESH_COMPAT_DISABLED", "true")

    with Session(auth_engine) as session:
        with pytest.raises(validation.AuthValidationError, match="已停用"):
            validation.validate_legacy_v8_ws_refresh(
                session,
                initial.tokens.refresh_token,
            )


def test_totp_counter_compare_and_swap_rejects_replay(auth_engine):
    from platform_v8.storage.repo import AccountRepo

    with Session(auth_engine) as session:
        assert AccountRepo.accept_totp_counter(session, 1, 100)
        assert not AccountRepo.accept_totp_counter(session, 1, 100)
        assert not AccountRepo.accept_totp_counter(session, 1, 99)
        assert AccountRepo.accept_totp_counter(session, 1, 101)


def test_failed_password_audit_commits(auth_engine):
    from platform_v8.services.auth import login
    from platform_v8.storage.repo import AuditRepo

    with Session(auth_engine) as session:
        with pytest.raises(login.LoginError):
            login.authenticate(
                session,
                login.LoginInput(
                    username="hardening-user",
                    password="wrong-password",
                ),
            )

    with Session(auth_engine) as session:
        failures = AuditRepo.recent(
            session,
            action="auth.login_fail",
        )
        assert failures
        assert failures[0]["detail"]["reason"] == "wrong_password"
