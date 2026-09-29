"""Cross-owner device visibility and local-storage authorization boundaries."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request

from platform_v8.api.v8 import ai, capabilities, dashboard_api, oss, public_stats, workers
from platform_v8.services.ai import tools as ai_tools
from platform_v8.services.auth import validation as auth_validation
from platform_v8.services.oss_provider import sign_local_object, verify_local_object_sig


def test_online_pool_returns_status_only_even_for_rich_peer_inventory(monkeypatch):
    peer = SimpleNamespace(
        id="stable-device-id", owner_id=8, name="private-hostname",
        status="ONLINE", capabilities={"ip": "private-ip", "model_path": "private-path"},
        client_version="private-version", last_seen="private-timestamp",
    )
    monkeypatch.setattr(workers.WorkerRepo, "list_online", lambda *args, **kwargs: [peer])

    result = workers.list_workers(
        session=object(), current=SimpleNamespace(id=7, is_admin=False),
        all=False, scope="online_pool",
    )
    assert result == [{"status": "ONLINE"}]
    assert "stable-device-id" not in repr(result)
    assert "private-hostname" not in repr(result)
    assert "private-path" not in repr(result)


def test_capability_directory_counts_peers_without_peer_device_identity(monkeypatch):
    seen = datetime.utcnow()
    rows = [
        SimpleNamespace(id="mine", owner_id=7, name="my-device", status="ONLINE",
                        last_seen=seen, capabilities={}),
        SimpleNamespace(id="foreign-stable-id", owner_id=8, name="foreign-hostname",
                        status="ONLINE", last_seen=seen, capabilities={}),
    ]

    class Session:
        def execute(self, statement):
            return SimpleNamespace(fetchall=lambda: rows)

    monkeypatch.setattr(capabilities.executor_block, "capability_entry", lambda name: {
        "implementations": ["impl"], "legacy_task_types": [],
    })
    monkeypatch.setattr(capabilities.executor_block, "registry_version", lambda: "test")
    monkeypatch.setattr(capabilities, "declared_impl", lambda name, caps: "impl")
    result = capabilities.workers_for_capability(
        "image.generate", session=Session(), current=SimpleNamespace(id=7, is_admin=False),
        include_offline=True,
    )
    assert result["declared"]["count"] == 2
    assert result["available_now"]["count"] == 2
    assert [entry["worker_id"] for entry in result["provides"]] == ["mine"]
    assert "foreign-stable-id" not in repr(result)
    assert "foreign-hostname" not in repr(result)


def _request_with_bearer(token: str = "valid") -> Request:
    return Request({
        "type": "http", "method": "GET", "path": "/", "headers": [
            (b"authorization", f"Bearer {token}".encode()),
        ],
    })


def test_local_bearer_requires_active_session_and_owned_unprotected_key(monkeypatch):
    seen: list[tuple[object, str, bool]] = []

    def validated(session, token, *, touch):
        seen.append((session, token, touch))
        return SimpleNamespace(account=SimpleNamespace(id=7))

    monkeypatch.setattr(auth_validation, "validate_v8_access", validated)
    session = object()
    oss._authorize_local_bearer(_request_with_bearer(), "v8/account-7/input/a.bin", session)
    assert seen == [(session, "valid", False)]

    for key in (
        "v8/account-8/input/a.bin",
        "tasks/123/output/other-user.bin",
        "v8/account-7/../account-8/input/a.bin",
        "v8/account-7/workload-x/shard-y/result/z/output.mp4",
    ):
        with pytest.raises(HTTPException) as error:
            oss._authorize_local_bearer(_request_with_bearer(), key, session)
        assert error.value.status_code == 403

    def revoked(session, token, *, touch):
        raise auth_validation.AuthValidationError("revoked")

    monkeypatch.setattr(auth_validation, "validate_v8_access", revoked)
    with pytest.raises(HTTPException) as error:
        oss._authorize_local_bearer(_request_with_bearer(), "v8/account-7/input/a.bin", session)
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_local_routes_enforce_bearer_ownership_and_keep_signed_delegation(monkeypatch, tmp_path):
    monkeypatch.setattr(oss, "_local_storage_root", lambda: str(tmp_path))
    monkeypatch.setenv("V8_LOCAL_OSS_SECRET", "isolated-test-secret-with-at-least-thirty-two-characters")
    monkeypatch.setattr(
        auth_validation, "validate_v8_access",
        lambda session, token, *, touch: SimpleNamespace(account=SimpleNamespace(id=7)),
    )
    app = FastAPI()
    app.include_router(oss.router)
    app.dependency_overrides[oss.get_session] = lambda: object()
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    own = "/api/v8/oss/local/upload/v8/account-7/input/owned.bin"
    foreign = "/api/v8/oss/local/upload/v8/account-8/input/foreign.bin"
    headers = {"authorization": "Bearer current-user-token"}
    try:
        denied = await client.put(foreign, content=b"foreign", headers=headers)
        assert denied.status_code == 403
        assert not (tmp_path / "v8/account-8/input/foreign.bin").exists()

        created = await client.put(own, content=b"owned", headers=headers)
        assert created.status_code == 200
        own_download = await client.get(
            "/api/v8/oss/local/download/v8/account-7/input/owned.bin", headers=headers,
        )
        assert own_download.status_code == 200
        assert own_download.content == b"owned"

        peer_path = tmp_path / "v8/account-8/input/foreign.bin"
        peer_path.parent.mkdir(parents=True, exist_ok=True)
        peer_path.write_bytes(b"peer-secret")
        denied_get = await client.get(
            "/api/v8/oss/local/download/v8/account-8/input/foreign.bin", headers=headers,
        )
        assert denied_get.status_code == 403
        assert b"peer-secret" not in denied_get.content

        # A valid object-bound URL is an explicit bearer delegation and remains usable.
        import time
        expiry = int(time.time()) + 60
        key = "v8/account-8/input/foreign.bin"
        sig = sign_local_object("GET", key, expiry)
        delegated = await client.get(
            f"/api/v8/oss/local/download/{key}", params={"expires": expiry, "sig": sig},
        )
        assert delegated.status_code == 200
        assert delegated.content == b"peer-secret"
    finally:
        await client.aclose()


def test_local_presign_has_no_public_default_key(monkeypatch):
    for name in ("V8_LOCAL_OSS_SECRET", "V8_JWT_SECRET", "JWT_SECRET", "SECRET_KEY"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(RuntimeError):
        sign_local_object("GET", "v8/account-7/input/a.bin", 2_000_000_000)
    assert not verify_local_object_sig(
        "GET", "v8/account-7/input/a.bin", 2_000_000_000, "fake-signature",
    )


def test_anonymous_console_snapshot_has_no_device_or_task_stream(monkeypatch):
    class Result:
        def __init__(self, value):
            self.value = value

        def mappings(self):
            return self

        def first(self):
            return self.value

        def all(self):
            return self.value

        def scalar(self):
            return self.value

    class Session:
        def __init__(self):
            self.queries = []

        def execute(self, statement):
            sql = str(statement)
            self.queries.append(sql)
            if "FROM we_workers WHERE" in sql:
                return Result(1.0)
            if "FROM we_workers" in sql:
                return Result({"total": 2, "online": 1})
            if "GROUP BY task_type" in sql:
                return Result([{"task_type": "image", "n": 1}])
            if "FROM we_workloads" in sql and "COUNT" in sql:
                return Result({"total": 1, "done": 1, "running": 0, "recent_24h": 1})
            if "FROM we_accounts" in sql:
                return Result(2)
            raise AssertionError(sql)

    session = Session()
    data = public_stats.console_snapshot(session)
    assert data["top_metrics"]["nodes_online"] == 1
    assert data["nodes"] == []
    assert data["live_feed"] == []
    assert not any("w.capabilities" in query or "w.name" in query for query in session.queries)


@pytest.mark.asyncio
async def test_public_live_dashboard_does_not_query_device_names(monkeypatch):
    class Result:
        def __init__(self, value):
            self.value = value

        def scalar(self):
            return self.value

        def fetchall(self):
            return self.value

    class Session:
        def __init__(self):
            self.queries = []

        def execute(self, statement):
            sql = str(statement)
            self.queries.append(sql)
            if "GROUP BY hw_tier" in sql:
                return Result([("basic", 2)])
            if "GROUP BY status" in sql:
                return Result([("DONE", 3)])
            if "count(*) FROM we_workers" in sql:
                return Result(2)
            if "count(*) FROM we_shards WHERE status='DONE'" in sql:
                return Result(3)
            raise AssertionError(sql)

    session = Session()

    @contextmanager
    def scope():
        yield session

    monkeypatch.setattr(dashboard_api, "session_scope", scope)
    result = await dashboard_api.dashboard_live()
    assert result["online_workers"] == 2
    assert result["tiers"] == {"basic": 2}
    assert result["workers"] == []
    assert result["recent"] == []
    assert all("name" not in sql and "last_seen" not in sql for sql in session.queries)


@pytest.mark.asyncio
async def test_ai_node_tool_reports_global_counts_but_only_own_inventory(monkeypatch):
    class Result:
        def __init__(self, rows):
            self.rows = rows

        def fetchall(self):
            return self.rows

    class Session:
        def __init__(self):
            self.queries = []

        def execute(self, statement, params=None):
            sql = str(statement)
            self.queries.append((sql, params))
            if "GROUP BY status" in sql:
                return Result([("ONLINE", 2), ("BUSY", 1)])
            if "owner_id = :owner_id" in sql:
                return Result([(
                    "owned-id", "owned-device", "ONLINE", 8, 16.0,
                    "basic", "macos", [], 0.0,
                )])
            raise AssertionError(sql)

    session = Session()

    @contextmanager
    def scope():
        yield session

    monkeypatch.setattr(ai_tools, "_get_repo_v8", lambda: SimpleNamespace(_session_factory=scope))
    result = await ai_tools.query_nodes.__wrapped__({"id": 7}, {})
    assert result["total_online"] == 3
    assert result["available"] == 2
    assert [node["id"] for node in result["nodes"]] == ["owned-id"]
    assert session.queries[1][1] == {"owner_id": 7}


@pytest.mark.asyncio
async def test_ai_context_limits_non_admin_inventory_to_owner(monkeypatch):
    from platform_v8.storage import db

    class Result:
        def __init__(self, rows):
            self.rows = rows

        def fetchall(self):
            return self.rows

        def fetchone(self):
            return self.rows[0] if self.rows else None

        def scalar(self):
            return 0

    class Session:
        def __init__(self):
            self.queries = []

        def execute(self, statement, params=None):
            sql = str(statement)
            self.queries.append((sql, params))
            if "FROM we_workers" in sql:
                return Result([(
                    "own-id", "my-node", "ONLINE", 8, 16.0, "basic",
                    "cpu", "gpu-vendor", "gpu-model", 0.0, None,
                )])
            if "FROM we_templates" in sql:
                return Result([])
            if "FROM we_ledger" in sql:
                return Result([(0, 0)])
            return Result([])

    session = Session()

    @contextmanager
    def scope():
        yield session

    monkeypatch.setattr(db, "session_scope", scope)
    account = SimpleNamespace(
        id=7, is_admin=False, username="owner", email="owner@example.test",
        balance=0, status="active",
    )
    result = await ai._build_ai_context(account)
    assert result["nodes"]["total"] == 1
    worker_queries = [(sql, params) for sql, params in session.queries if "FROM we_workers" in sql]
    assert len(worker_queries) == 1
    assert "WHERE owner_id = :owner_id" in worker_queries[0][0]
    assert worker_queries[0][1] == {"owner_id": 7}
