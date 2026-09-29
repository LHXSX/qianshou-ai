"""
W6 · e2e · admin API HTTP 链路 (TestClient · 走真实 FastAPI 路由)

覆盖:
  - /api/v8/admin/proxy/stats · 全局指标
  - /api/v8/admin/proxy/blacklist · 黑名单读
  - /api/v8/admin/proxy/sessions/active · 活跃列表 (空)
  - 各 endpoint 拒绝未认证请求

策略:
  绕过 admin auth · 统一 client_with_admin
  其他 endpoint 走真路由 · 验路由挂载 + 序列化无误
"""
from __future__ import annotations

import os

import pytest

# 必须 import app 前设置 (CORS/DB env 读一次)
os.environ.setdefault("V8_CORS_ORIGINS", "https://www.qianshousuanli.com")
os.environ.setdefault("V8_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("POSTGRES_PASSWORD", "e2e-test")

# admin API 走真实路由 · 依赖 PyJWT/FastAPI 等 · 本地环境缺则 skip 整文件
pytest.importorskip("jwt", reason="PyJWT 未装 · 跳 admin API e2e (CI 镜像已装)")
pytest.importorskip("fastapi", reason="FastAPI 未装")

pytestmark = pytest.mark.e2e


@pytest.fixture
def admin_client():
    """TestClient + admin auth bypass（经 tests.utils 标准化）。"""
    from platform_v8.api.app import app
    from platform_v8.tests.utils import client_with_admin

    with client_with_admin(app) as client:
        yield client


# ════════════════════════════════════════════════════════════════
# proxy admin endpoints
# ════════════════════════════════════════════════════════════════
def test_proxy_stats_endpoint(admin_client):
    """GET /api/v8/admin/proxy/stats · 应返 JSON"""
    r = admin_client.get("/api/v8/admin/proxy/stats")
    assert r.status_code == 200, r.text
    data = r.json()
    assert "active_sessions" in data
    assert "bytes_up_total" in data
    assert isinstance(data["active_sessions"], int)


def test_proxy_active_sessions_empty(admin_client):
    """无 session 时 · 返空 list"""
    r = admin_client.get("/api/v8/admin/proxy/sessions/active")
    assert r.status_code == 200
    assert r.json() == []


def test_proxy_blacklist_empty(admin_client):
    """无黑名单 · 返空 workers list"""
    r = admin_client.get("/api/v8/admin/proxy/blacklist")
    assert r.status_code == 200
    data = r.json()
    assert "workers" in data
    assert data["workers"] == []


def test_proxy_blacklist_add_remove(admin_client):
    """add/list/remove 黑名单 · 状态正确"""
    test_worker = "worker-e2e-test-001"

    # add
    r = admin_client.post(f"/api/v8/admin/proxy/blacklist/{test_worker}")
    assert r.status_code == 200, r.text
    assert test_worker in r.json()["workers"]

    # list 现在有它
    r = admin_client.get("/api/v8/admin/proxy/blacklist")
    assert test_worker in r.json()["workers"]

    # remove
    r = admin_client.delete(f"/api/v8/admin/proxy/blacklist/{test_worker}")
    assert r.status_code == 200
    assert test_worker not in r.json()["workers"]


# ════════════════════════════════════════════════════════════════
# 拒绝未认证请求
# ════════════════════════════════════════════════════════════════
def test_admin_endpoints_require_auth():
    """没 mock admin · 应被拒 (401/403)"""
    from fastapi.testclient import TestClient
    from platform_v8.api.app import app

    client = TestClient(app)
    r = client.get("/api/v8/admin/proxy/stats")
    # 应被 admin guard 拦截
    assert r.status_code in (401, 403, 422), f"未认证应被拒 · 实得 {r.status_code}"
