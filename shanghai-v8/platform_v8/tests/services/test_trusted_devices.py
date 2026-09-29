from __future__ import annotations

import os
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine, select, update
from sqlalchemy.orm import sessionmaker


os.environ.setdefault(
    "V8_JWT_SECRET",
    "trusted-device-tests-use-a-non-production-jwt-secret",
)
os.environ.setdefault(
    "V8_TRUSTED_DEVICE_PEPPER",
    "trusted-device-tests-use-a-non-production-pepper",
)


@pytest.fixture
def trusted_store():
    from platform_v8.services.auth.passwords import hash_password
    from platform_v8.storage.repo import AccountRepo, create_all_for_testing

    engine = create_engine("sqlite:///:memory:")
    create_all_for_testing(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    with session_factory() as session:
        first = AccountRepo.create(
            session,
            username="trusted-one",
            email="trusted-one@example.com",
            password_hash=hash_password("Test-2026!"),
        )
        second = AccountRepo.create(
            session,
            username="trusted-two",
            email="trusted-two@example.com",
            password_hash=hash_password("Test-2026!"),
        )
        session.commit()
    try:
        yield session_factory, first.id, second.id
    finally:
        engine.dispose()


def test_opaque_credential_durations_permanent_revoke_and_expiry(trusted_store):
    from platform_v8.services.auth import trusted_devices
    from platform_v8.storage.repo import TrustedDeviceRepo, auth_devices_t

    session_factory, first_id, _ = trusted_store
    with session_factory() as session:
        resolution = trusted_devices.resolve_or_register(
            session,
            account_id=first_id,
            credential=None,
            metadata={"client_type": "tauri"},
        )
        assert len(resolution.credential) >= 43
        stored = session.execute(
            select(auth_devices_t).where(
                auth_devices_t.c.id == resolution.device_id
            )
        ).one()
        assert stored.credential_hash != resolution.credential
        assert resolution.credential not in str(dict(stored._mapping))

        expected_days = {"7d": 7, "30d": 30, "90d": 90}
        for duration, days in expected_days.items():
            before = datetime.utcnow()
            device = trusted_devices.activate_trust(
                session,
                device_id=resolution.device_id,
                account_id=first_id,
                duration=duration,
            )
            assert trusted_devices.is_trusted(device)
            assert before + timedelta(days=days) <= device["trusted_until"]
            fixed_until = device["trusted_until"]
            trusted_devices.mark_trusted_login(
                session,
                device_id=resolution.device_id,
                account_id=first_id,
            )
            unchanged = TrustedDeviceRepo.by_id_for_account(
                session,
                resolution.device_id,
                first_id,
            )
            assert unchanged["trusted_until"] == fixed_until

        permanent = trusted_devices.activate_trust(
            session,
            device_id=resolution.device_id,
            account_id=first_id,
            duration="permanent",
        )
        assert permanent["trust_permanent"] is True
        assert permanent["trusted_until"] is None
        assert trusted_devices.is_trusted(permanent)

        assert trusted_devices.revoke(
            session,
            device_id=resolution.device_id,
            account_id=first_id,
        )
        revoked = TrustedDeviceRepo.by_id_for_account(
            session,
            resolution.device_id,
            first_id,
        )
        assert trusted_devices.is_trusted(revoked) is False

        active = trusted_devices.activate_trust(
            session,
            device_id=resolution.device_id,
            account_id=first_id,
            duration="7d",
        )
        session.execute(
            update(auth_devices_t)
            .where(auth_devices_t.c.id == resolution.device_id)
            .values(trusted_until=datetime.utcnow() - timedelta(seconds=1))
        )
        expired = TrustedDeviceRepo.by_id_for_account(
            session,
            resolution.device_id,
            first_id,
        )
        assert active["trust_permanent"] is False
        assert trusted_devices.is_trusted(expired) is False

        with pytest.raises(trusted_devices.TrustedDeviceError):
            trusted_devices.activate_trust(
                session,
                device_id=resolution.device_id,
                account_id=first_id,
                duration="1d",
            )


def test_wrong_account_and_invalid_credential_rotate_device(trusted_store):
    from platform_v8.services.auth import trusted_devices

    session_factory, first_id, second_id = trusted_store
    with session_factory() as session:
        first = trusted_devices.resolve_or_register(
            session,
            account_id=first_id,
            credential=None,
            metadata={"client_type": "web"},
        )
        assert trusted_devices.resolve_for_account(
            session,
            account_id=second_id,
            credential=first.credential,
        ) is None

        second = trusted_devices.resolve_or_register(
            session,
            account_id=second_id,
            credential=first.credential,
            metadata={"client_type": "tauri"},
        )
        assert second.registered is True
        assert second.device_id != first.device_id
        assert second.credential != first.credential

        invalid = trusted_devices.resolve_or_register(
            session,
            account_id=first_id,
            credential="not-a-valid-device-credential",
            metadata={"client_type": "tauri"},
        )
        assert invalid.registered is True
        assert invalid.device_id != first.device_id
        assert invalid.credential != "not-a-valid-device-credential"
