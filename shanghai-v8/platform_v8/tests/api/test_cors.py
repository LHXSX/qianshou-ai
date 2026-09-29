"""
CORS 回归测试 (2026-05-26 根治版)

防止 Tauri 客户端因后端 CORS 白名单缺 tauri://localhost 而出现 "Load failed"。
任何修改 app.py CORS 配置都要让这套测试继续过。
"""
import os

import pytest

# 必须在 import app 前设置 · CORSMiddleware 读 env 时一次性快照
os.environ["V8_CORS_ORIGINS"] = "https://www.qianshousuanli.com,https://qianshousuanli.com"

from fastapi.testclient import TestClient

from platform_v8.api.app import app

client = TestClient(app)


def _check_acao(origin: str, *, expected_pass: bool, path: str = "/api/v8/runtime/task-catalog"):
    """发 GET · 验返 Access-Control-Allow-Origin 是否符合预期"""
    resp = client.get(path, headers={"Origin": origin})
    acao = resp.headers.get("access-control-allow-origin")
    if expected_pass:
        assert acao is not None, f"origin={origin!r} 缺 ACAO 头 (CORS block) · 端点 {path}"
        # 凭据模式不能用 * · 必须 echo 具体 origin
        assert acao == origin or acao == "*", f"ACAO={acao!r} 不符预期"
    else:
        assert acao is None or acao != origin, f"origin={origin!r} 不应通过 CORS · 实得 ACAO={acao!r}"


# ── Tauri 桌面客户端 (P0 · 任何环境必须通过) ────────────────────

@pytest.mark.parametrize("origin", [
    "tauri://localhost",          # mac/linux Tauri 2
    "https://tauri.localhost",    # Windows Tauri 2
])
def test_tauri_origins_always_allowed(origin):
    """Tauri 桌面端 origin 必须通过 · 否则智能能力等页 Load failed"""
    _check_acao(origin, expected_pass=True)


# ── 生产域名白名单 (env V8_CORS_ORIGINS 配的) ────────────────────

@pytest.mark.parametrize("origin", [
    "https://www.qianshousuanli.com",
    "https://qianshousuanli.com",
])
def test_env_whitelisted_origins_allowed(origin):
    _check_acao(origin, expected_pass=True)


# ── dev / 兜底 regex (vite dev server / dev localhost) ──────────

@pytest.mark.parametrize("origin", [
    "http://localhost:5173",
    "http://localhost:5177",
    "http://localhost",
    "https://localhost:8443",
])
def test_dev_localhost_via_regex(origin):
    """开发期 vite dev server · 走 allow_origin_regex 兜底"""
    _check_acao(origin, expected_pass=True)


# ── 不该通过的恶意/无关 origin ─────────────────────────────

@pytest.mark.parametrize("origin", [
    "https://evil.com",
    "http://attacker.net",
    "https://wuji-fake-domain.io",
])
def test_random_origins_blocked(origin):
    _check_acao(origin, expected_pass=False)
