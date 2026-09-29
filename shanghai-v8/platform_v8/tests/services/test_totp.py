from __future__ import annotations

import json

import pyotp
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from platform_v8.services.auth import totp


@pytest.fixture(autouse=True)
def totp_key(monkeypatch):
    monkeypatch.setenv("V8_TOTP_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))


def test_setup_confirm_encrypts_secret():
    setup = totp.create_setup(account_id=12, account_name="user@example.com")

    assert setup.secret in setup.otpauth_uri
    assert setup.secret not in setup.setup_token
    code = pyotp.TOTP(setup.secret).now()
    secret_enc = totp.confirm_setup(
        account_id=12,
        setup_token=setup.setup_token,
        code=code,
    )

    assert setup.secret not in secret_enc
    assert totp.decrypt_secret(secret_enc) == setup.secret
    assert totp.verify_code(secret_enc, code)


def test_confirm_rejects_wrong_code_and_account():
    setup = totp.create_setup(account_id=12, account_name="user@example.com")

    with pytest.raises(totp.TotpError, match="不正确"):
        totp.confirm_setup(
            account_id=12,
            setup_token=setup.setup_token,
            code="000000",
        )

    with pytest.raises(totp.TotpError, match="不匹配"):
        totp.confirm_setup(
            account_id=99,
            setup_token=setup.setup_token,
            code=pyotp.TOTP(setup.secret).now(),
        )


def test_confirm_rejects_expired_setup_token():
    setup = totp.create_setup(account_id=12, account_name="user@example.com")
    fernet = totp._fernet()
    payload = json.loads(fernet.decrypt(setup.setup_token.encode("ascii")).decode("utf-8"))
    payload["exp"] = 0
    expired_token = fernet.encrypt(json.dumps(payload).encode("utf-8")).decode("ascii")

    with pytest.raises(totp.TotpError, match="已过期"):
        totp.confirm_setup(
            account_id=12,
            setup_token=expired_token,
            code=pyotp.TOTP(setup.secret).now(),
        )


def test_missing_or_invalid_encryption_key_fails_closed(monkeypatch):
    monkeypatch.delenv("V8_TOTP_ENCRYPTION_KEY", raising=False)
    with pytest.raises(totp.TotpError, match="未配置"):
        totp.create_setup(account_id=1, account_name="user")

    monkeypatch.setenv("V8_TOTP_ENCRYPTION_KEY", "not-a-fernet-key")
    with pytest.raises(totp.TotpError, match="格式无效"):
        totp.create_setup(account_id=1, account_name="user")


def test_login_challenge_is_persisted_account_bound_and_one_time():
    from platform_v8.storage.repo import create_all_for_testing

    engine = create_engine("sqlite://")
    create_all_for_testing(engine)
    with Session(engine) as session:
        challenge = totp.create_login_challenge(session, account_id=42)
        session.commit()

        assert "42" not in challenge
        data = totp.resolve_login_challenge_data(session, challenge)
        assert data.account_id == 42
        totp.consume_login_challenge(session, data.challenge_id)
        session.commit()

        with pytest.raises(totp.TotpError, match="已使用"):
            totp.resolve_login_challenge_data(session, challenge)

        setup = totp.create_setup(account_id=42, account_name="user")
        with pytest.raises(totp.TotpError):
            totp.resolve_login_challenge_data(session, setup.setup_token)
