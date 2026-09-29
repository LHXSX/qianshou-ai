"""Offline authorization regressions for worker models and local OSS."""
from __future__ import annotations

import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from platform_v8.api.v8 import models, oss
from platform_v8.services.auth import validation as auth_validation
from platform_v8.services.oss_provider import sign_local_object, verify_local_object_sig


@pytest.mark.asyncio
async def test_installed_model_routes_require_login_and_owner(monkeypatch):
    app = FastAPI()
    app.include_router(models.router)
    app.dependency_overrides[models.get_session] = lambda: object()
    monkeypatch.setattr(models.WorkerRepo, "by_id", lambda _db, _wid: SimpleNamespace(owner_id=8))
    path = "/api/v8/models/workers/peer/installed"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get(path)).status_code == 401
        assert (await client.post(path, params={"model_id": "m"})).status_code == 401
        app.dependency_overrides[models.get_current_account] = lambda: SimpleNamespace(id=7, is_admin=False)
        assert (await client.get(path)).status_code == 403
        assert (await client.post(path, params={"model_id": "m"})).status_code == 403
        assert (await client.post(path, params={"model_id": "m", "status": "arbitrary"})).status_code == 422


def test_local_oss_bearer_requires_active_owner_and_unprotected_key(monkeypatch):
    from starlette.requests import Request

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [(b"authorization", b"Bearer fixture-token")]})
    seen = []

    def validate(session, token, *, touch):
        seen.append((session, token, touch))
        return SimpleNamespace(account=SimpleNamespace(id=7))

    monkeypatch.setattr(auth_validation, "validate_v8_access", validate)
    session = object()
    oss._authorize_local_bearer(request, "v8/account-7/input/own.bin", session)
    assert seen == [(session, "fixture-token", False)]
    for key in (
        "v8/account-8/input/foreign.bin",
        "v8/account-7/../account-8/input/foreign.bin",
        "v8/account-7/workload-x/shard-y/result/z/output.mp4",
    ):
        with pytest.raises(HTTPException) as error:
            oss._authorize_local_bearer(request, key, session)
        assert error.value.status_code == 403

    def revoked(*_args, **_kwargs):
        raise auth_validation.AuthValidationError("revoked")

    monkeypatch.setattr(auth_validation, "validate_v8_access", revoked)
    with pytest.raises(HTTPException) as error:
        oss._authorize_local_bearer(request, "v8/account-7/input/own.bin", session)
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_local_oss_routes_reject_foreign_bearer_but_allow_object_signed_get(monkeypatch, tmp_path):
    monkeypatch.setattr(oss, "_local_storage_root", lambda: str(tmp_path))
    monkeypatch.setenv("V8_LOCAL_OSS_SECRET", "offline-fixture-secret-with-at-least-thirty-two-characters")
    monkeypatch.setattr(auth_validation, "validate_v8_access", lambda *_args, **_kwargs: SimpleNamespace(account=SimpleNamespace(id=7)))
    app = FastAPI()
    app.include_router(oss.router)
    app.dependency_overrides[oss.get_session] = lambda: object()
    own = "v8/account-7/input/own.bin"
    foreign = "v8/account-8/input/foreign.bin"
    headers = {"authorization": "Bearer fixture-token"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        denied = await client.put(f"/api/v8/oss/local/upload/{foreign}", content=b"foreign", headers=headers)
        assert denied.status_code == 403
        assert not (tmp_path / foreign).exists()
        created = await client.put(f"/api/v8/oss/local/upload/{own}", content=b"owned", headers=headers)
        assert created.status_code == 200
        read = await client.get(f"/api/v8/oss/local/download/{own}", headers=headers)
        assert read.status_code == 200 and read.content == b"owned"
        path = tmp_path / foreign
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fixture-peer-data")
        denied = await client.get(f"/api/v8/oss/local/download/{foreign}", headers=headers)
        assert denied.status_code == 403
        expiry = int(time.time()) + 60
        signed = sign_local_object("GET", foreign, expiry)
        delegated = await client.get(f"/api/v8/oss/local/download/{foreign}", params={"expires": expiry, "sig": signed})
        assert delegated.status_code == 200 and delegated.content == b"fixture-peer-data"


def test_local_oss_signing_has_no_public_default(monkeypatch):
    for name in ("V8_LOCAL_OSS_SECRET", "V8_JWT_SECRET", "JWT_SECRET", "SECRET_KEY"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(RuntimeError):
        sign_local_object("GET", "v8/account-7/input/a.bin", 2_000_000_000)
    assert not verify_local_object_sig("GET", "v8/account-7/input/a.bin", 2_000_000_000, "fixture-signature")
