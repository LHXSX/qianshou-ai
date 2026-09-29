"""Public candidate regressions for route authorization and opt-in surfaces."""
from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request

from platform_v8.api.v8 import admin_fe, bundles, edge, files, models, runtime_releases, scripts, skills
from platform_v8.services import result_store


@pytest.mark.asyncio
async def test_worker_model_routes_require_login_and_owner(monkeypatch):
    app = FastAPI()
    app.include_router(models.router)
    app.dependency_overrides[models.get_session] = lambda: object()
    monkeypatch.setattr(
        models.WorkerRepo, "by_id",
        lambda _db, _wid: SimpleNamespace(owner_id=8),
    )
    path = "/api/v8/models/workers/peer/installed"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (await client.get(path)).status_code == 401
        assert (await client.post(path, params={"model_id": "m"})).status_code == 401

        app.dependency_overrides[models.get_current_account] = lambda: SimpleNamespace(
            id=7, is_admin=False
        )
        assert (await client.get(path)).status_code == 403
        assert (await client.post(path, params={"model_id": "m"})).status_code == 403
        assert (
            await client.post(path, params={"model_id": "m", "status": "arbitrary"})
        ).status_code == 422


def test_admin_create_user_has_no_default_password():
    with pytest.raises(HTTPException) as error:
        admin_fe.create_user(
            {"username": "new", "email": "new@example.test"},
            session=object(), _admin=SimpleNamespace(is_admin=True),
        )
    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_legacy_edge_provider_path_is_disabled_by_default(monkeypatch):
    monkeypatch.delenv("V8_EDGE_ACCELERATE_ENABLED", raising=False)
    app = FastAPI()
    app.include_router(edge.router)
    app.dependency_overrides[edge.get_admin_account] = lambda: SimpleNamespace(
        id=1, is_admin=True
    )

    async def should_not_call(*_args, **_kwargs):
        raise AssertionError("provider should not be contacted")

    monkeypatch.setattr(edge, "_process_chunk_direct", should_not_call)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        path = "/api/v8/edge/accelerate"
        body = {"chunks": [{"index": 0, "text": "sample"}]}
        assert (await client.post(path, json=body)).status_code == 503
        monkeypatch.setenv("V8_EDGE_ACCELERATE_ENABLED", "1")
        assert (
            await client.post(path, json={"chunks": body["chunks"] * 17})
        ).status_code == 422
        assert (
            await client.post(path, json={"chunks": [{"text": "x" * 8001}]})
        ).status_code == 422


def test_runtime_static_mount_requires_explicit_opt_in(monkeypatch, tmp_path):
    root = tmp_path / "releases"
    root.mkdir()
    (root / "unrelated.txt").write_text("test", encoding="utf-8")
    monkeypatch.setenv("EDGE_RUNTIME_RELEASES_DIR", str(root))
    monkeypatch.delenv("EDGE_SERVE_RUNTIME_RELEASES", raising=False)
    app = FastAPI()
    assert runtime_releases.mount_if_configured(app) is False
    assert all(getattr(route, "path", None) != "/static/runtime-releases" for route in app.routes)
    assert runtime_releases.runtime_releases_info()["enabled"] is False

    monkeypatch.setenv("EDGE_SERVE_RUNTIME_RELEASES", "1")
    assert runtime_releases.mount_if_configured(app) is True
    assert any(getattr(route, "path", None) == "/static/runtime-releases" for route in app.routes)
    info = runtime_releases.runtime_releases_info()
    assert info["enabled"] is True
    assert "dir" not in info
    assert "192.168." not in repr(info)


def test_legacy_result_url_signing_requires_private_secret(monkeypatch, tmp_path):
    monkeypatch.setattr(result_store, "_SIGN_SECRET", "")
    store = result_store.ResultStore(root=tmp_path)
    ref = result_store.ResultRef(1, 2, "out.txt", 0, "")
    with pytest.raises(RuntimeError):
        store.sign_url(ref)
    assert store.verify_signed_url(ref.path_key, "9999999999", "anything") is False


@pytest.mark.asyncio
async def test_legacy_file_bridge_is_opt_in(monkeypatch):
    monkeypatch.delenv("V8_LEGACY_DIRECT_FILE_BRIDGE_ENABLED", raising=False)
    req = Request({"type": "http", "method": "POST", "path": "/api/v8/files/direct-put", "headers": []})
    with pytest.raises(HTTPException) as error:
        await files.direct_put(req, current=SimpleNamespace(id=1))
    assert error.value.status_code == 503
    with pytest.raises(HTTPException) as error:
        await files.get_local_blob("a" * 32)
    assert error.value.status_code == 503


@pytest.mark.asyncio
async def test_upload_presign_rejects_ambiguous_tenant_path():
    with pytest.raises(HTTPException) as error:
        await files.upload_url(
            files.UploadURLReq(filename="file.txt", task_id="../account-8"),
            current=SimpleNamespace(id=7),
        )
    assert error.value.status_code == 400


def test_public_skill_archive_skips_hidden_paths_and_symlinks(tmp_path):
    import io
    import zipfile

    source = tmp_path / "skill"
    source.mkdir()
    (source / "public.py").write_text("print('public')", encoding="utf-8")
    hidden = source / ".private"
    hidden.mkdir()
    (hidden / "notes.json").write_text("private", encoding="utf-8")
    outside = tmp_path / "outside.json"
    outside.write_text("outside", encoding="utf-8")
    (source / "alias.json").symlink_to(outside)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        skills._add_dir_to_zip(archive, source, "")
    with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as archive:
        assert archive.namelist() == ["public.py"]


@pytest.mark.asyncio
async def test_script_download_cannot_follow_sibling_prefix_symlink(monkeypatch, tmp_path):
    task_dir = tmp_path / "tasks"
    private_dir = tmp_path / "tasks-private"
    task_dir.mkdir()
    private_dir.mkdir()
    (private_dir / "secret.py").write_text("private", encoding="utf-8")
    (task_dir / "visible.py").symlink_to(private_dir / "secret.py")
    monkeypatch.setattr(scripts, "_TASK_SCRIPTS_DIR", str(task_dir))
    with pytest.raises(HTTPException) as error:
        await scripts.serve_task_script("visible.py")
    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_anonymous_crash_report_caps_body_and_ignores_spoofed_xff(monkeypatch):
    app = FastAPI()
    app.include_router(bundles.router)
    seen_ips: list[str] = []

    def deny_and_record(ip):
        seen_ips.append(ip)
        return True

    monkeypatch.setattr(bundles, "_rate_limited", deny_and_record)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=("198.51.100.8", 1234)),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/api/v8/client/crash-report", json={},
            headers={"X-Forwarded-For": "203.0.113.1"},
        )
        assert response.json()["error"] == "rate_limited"
    assert seen_ips == ["198.51.100.8"]

    monkeypatch.setattr(bundles, "_rate_limited", lambda _ip: False)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/v8/client/crash-report", content=b"x" * (32 * 1024 + 1),
        )
    assert response.json()["error"] == "body_too_large"
