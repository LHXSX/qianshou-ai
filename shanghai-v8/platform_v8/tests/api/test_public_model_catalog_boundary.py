"""Anonymous model catalog must expose only released client metadata."""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from platform_v8.api.v8 import models


_ACTIVE = {
    "id": "public-model", "name": "Public model", "version": "1.0",
    "description": "For clients", "size_mb": 12, "sha256": "a" * 64,
    "filename": "model.bin", "download_path": "/models/public-model/model.bin",
    "mirrors": '["https://example.test/model.bin"]', "runtime": "python",
    "requirements": '{"memory_gb": 8}', "industry": ["image"],
    "tags": ["fast"], "status": "active",
    "serve_cmd": "private-server-command", "stop_cmd": "private-stop-command",
    "health_endpoint": "http://internal-service.invalid/health",
    "future_admin_field": "private-future-field",
}
_DRAFT = {**_ACTIVE, "id": "draft-model", "status": "draft"}


class _Result:
    def __init__(self, rows):
        self.rows = rows

    def mappings(self):
        return self

    def all(self):
        return self.rows

    def first(self):
        return self.rows[0] if self.rows else None


class _Session:
    def __init__(self):
        self.queries = []

    def execute(self, statement, params):
        sql = str(statement)
        self.queries.append((sql, dict(params)))
        assert "SELECT *" not in sql
        assert "status = 'active'" in sql
        rows = [_ACTIVE, _DRAFT]
        rows = [row for row in rows if row["status"] == "active"]
        if "id = :id" in sql:
            rows = [row for row in rows if row["id"] == params["id"]]
        # Return a deliberately over-complete row to test the response
        # whitelist even if a future query accidentally selects extra fields.
        return _Result(rows)


@pytest.mark.asyncio
async def test_anonymous_list_and_detail_hide_internal_fields_and_drafts():
    session = _Session()
    app = FastAPI()
    app.include_router(models.router)
    app.dependency_overrides[models.get_session] = lambda: session

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        listing = await client.get("/api/v8/models")
        assert listing.status_code == 200
        assert listing.json()["count"] == 1
        public = listing.json()["models"][0]
        assert public["id"] == "public-model"
        assert public["status"] == "active"
        assert public["mirrors"] == ["https://example.test/model.bin"]
        assert public["requirements"] == {"memory_gb": 8}

        detail = await client.get("/api/v8/models/public-model")
        assert detail.status_code == 200
        assert detail.json()["model"] == public
        assert (await client.get("/api/v8/models/draft-model")).status_code == 404

        queries_before = len(session.queries)
        assert (await client.get("/api/v8/models?status=all")).status_code == 403
        assert (await client.get("/api/v8/models?status=draft")).status_code == 403
        assert len(session.queries) == queries_before

    for private_value in ("private-server-command", "private-stop-command",
                          "internal-service.invalid", "private-future-field", "draft-model"):
        assert private_value not in repr(public)


@pytest.mark.asyncio
async def test_anonymous_full_catalog_keeps_install_metadata_without_internal_fields():
    session = _Session()
    app = FastAPI()
    app.include_router(models.router)
    app.dependency_overrides[models.get_session] = lambda: session

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v8/models/catalog/full")

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    public = body["models"][0]
    assert public["id"] == "public-model"
    assert public["download_path"] == "/models/public-model/model.bin"
    assert public["mirrors"] == ["https://example.test/model.bin"]
    assert public["requirements"] == {"memory_gb": 8}
    assert "description" not in public  # Preserve the existing catalog shape.
    assert "status" not in public
    assert not {"serve_cmd", "stop_cmd", "health_endpoint", "future_admin_field"} & public.keys()
