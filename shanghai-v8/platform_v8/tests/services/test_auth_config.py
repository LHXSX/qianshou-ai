from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, inspect, text

from platform_v8.services.auth import config
from platform_v8.storage import db
from platform_v8.storage.repo import metadata


@pytest.mark.parametrize("environment", ["", "development", "staging"])
def test_non_production_does_not_require_production_secrets(
    monkeypatch: pytest.MonkeyPatch,
    environment: str,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.delenv("V8_JWT_SECRET", raising=False)
    monkeypatch.delenv("V8_TOTP_ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("V8_TRUSTED_DEVICE_PEPPER", raising=False)

    config.validate_production_auth_config()


def test_production_rejects_missing_auth_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("V8_JWT_SECRET", raising=False)
    monkeypatch.delenv("V8_TOTP_ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("V8_TRUSTED_DEVICE_PEPPER", raising=False)

    with pytest.raises(RuntimeError, match="V8_JWT_SECRET"):
        config.validate_production_auth_config()


def test_production_accepts_independent_strong_auth_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("V8_JWT_SECRET", "j" * 48)
    monkeypatch.setenv("V8_TOTP_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("V8_TRUSTED_DEVICE_PEPPER", "p" * 48)

    config.validate_production_auth_config()
    assert config.config_healthcheck()["auth_config"] == "ok"


def test_auth_schema_healthcheck_detects_missing_migrations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = create_engine("sqlite:///:memory:")
    metadata.create_all(engine)
    monkeypatch.setattr(db, "get_engine", lambda: engine)
    assert db.auth_schema_healthcheck()["auth_schema"] == "ok"

    with engine.begin() as connection:
        connection.execute(text("DROP TABLE we_auth_login_challenges"))

    report = db.auth_schema_healthcheck()
    assert report["auth_schema"] == "error"
    assert "we_auth_login_challenges" in report["detail"]


def test_explicit_sqlite_bootstrap_creates_auth_schema(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """本地 UI 联调的 SQLite 仅在显式开关下建表，生产迁移不受影响。"""
    database_path = tmp_path / "local-ui.db"
    monkeypatch.setenv("V8_DATABASE_URL", f"sqlite:///{database_path}")
    monkeypatch.setenv("V8_BOOTSTRAP_SQLITE_SCHEMA", "1")
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr(db, "_session_factory", None)

    engine = db.init_db()
    try:
        assert "we_accounts" in inspect(engine).get_table_names()
        assert "we_auth_sessions" in inspect(engine).get_table_names()
    finally:
        engine.dispose()


def test_migration_healthcheck_is_disabled_outside_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "staging")
    assert db.migration_healthcheck() == {"migrations": "disabled"}


def test_migration_healthcheck_requires_production_ledger(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = create_engine("sqlite:///:memory:")
    metadata.create_all(engine)
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setattr(db, "get_engine", lambda: engine)

    report = db.migration_healthcheck()

    assert report["migrations"] == "error"
    assert "we_schema_migrations" in report["detail"]
