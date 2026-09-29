"""
W3-D3 · IP 代理池 e2e 集成测试 (2026-05-26)

覆盖完整 happy path:
  1. gateway.pick_worker      → 模拟 broker 返一个节点
  2. gateway.open_session     → 创建 ProxySession + 调 session_dispatcher.open_tunnel
  3. gateway.forward_to_node  → 上行数据 (客户 → 节点)
  4. gateway.on_node_chunk    → 下行数据 (节点 → 平台 queue)
  5. gateway.read_from_node   → 客户取下行
  6. gateway.close_session    → workload→DONE · 资源清理

不依赖 DB / ledger / jwt · 全 mock.

跑法:
  PYTHONPATH=... pytest platform_v8/tests/services/test_proxy_e2e.py -v
"""
from __future__ import annotations

import asyncio
import base64
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.proxy import gateway as pg


# ──── 测试前/后清理全局 ────
@pytest.fixture(autouse=True)
def _reset_proxy_globals():
    pg._sessions.clear()
    pg._node_sessions.clear()
    pg._blacklist_workers.clear()
    yield
    pg._sessions.clear()
    pg._node_sessions.clear()
    pg._blacklist_workers.clear()


# 所有需要 open_session 的测试都得开 hidden_business 总闸
@pytest.fixture
def _enable_hidden_business():
    """master flag mock 为 ON · 跑 e2e 流程"""
    with patch("platform_v8.services.ops.feature_flags.is_enabled",
               return_value=True):
        yield


# ════════════════════════════════════════════════════════════════
# e2e · 完整 open → forward → on_chunk → close 链路
# ════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_e2e_open_forward_chunk_close(_enable_hidden_business):
    """模拟客户开 session · 发数据 · 节点回 · 客户读 · 关 session"""
    # ── 1. mock 选节点 ──
    # 直接 patch pick_worker · 跳过 DB
    with patch("platform_v8.services.proxy.gateway.pick_worker",
               AsyncMock(return_value="worker_e2e_1")), \
         patch("platform_v8.services.proxy.gateway.session_dispatcher.open_tunnel",
               AsyncMock(return_value=True)), \
         patch("platform_v8.services.proxy.gateway.session_dispatcher.send_chunk",
               AsyncMock(return_value=True)), \
         patch("platform_v8.services.proxy.gateway.session_dispatcher.send_close",
               AsyncMock(return_value=True)), \
         patch("platform_v8.services.proxy.gateway._create_workload_for_session",
               AsyncMock()), \
         patch("platform_v8.services.proxy.gateway._bill_and_cleanup",
               AsyncMock()):

        # ── 2. 客户开 session ──
        sid, wid = await pg.open_session(
            client_id="acct_42",
            target_host="example.com",
            target_port=443,
            use_tls=True,
            initial_data=b"GET / HTTP/1.1\r\n",
        )
        assert sid
        assert wid == "worker_e2e_1"
        # 进表
        sess = pg._sessions[sid]
        assert not sess.closed
        assert sess.bytes_up == len(b"GET / HTTP/1.1\r\n")  # initial 计入
        assert sid in pg._node_sessions["worker_e2e_1"]

        # ── 3. 客户继续上行数据 ──
        ok = await pg.forward_to_node(sid, b"Host: example.com\r\n\r\n")
        assert ok
        assert sess.bytes_up == len(b"GET / HTTP/1.1\r\n") + len(b"Host: example.com\r\n\r\n")
        assert sess.seq_to_node == 1  # 第一次 forward

        # ── 4. 节点回数据 (模拟 ws 收到 tunnel_chunk) ──
        resp_b64 = base64.b64encode(b"HTTP/1.1 200 OK\r\n\r\n<html></html>").decode()
        await pg.on_node_chunk(sid, resp_b64, seq=1)
        assert sess.bytes_down == len(b"HTTP/1.1 200 OK\r\n\r\n<html></html>")

        # ── 5. 客户读下行 ──
        data = await pg.read_from_node(sid, timeout=1.0)
        assert data == b"HTTP/1.1 200 OK\r\n\r\n<html></html>"

        # ── 6. 关 session ──
        await pg.close_session(sid, reason="client_close")
        assert sess.closed
        assert sess.close_reason == "client_close"


@pytest.mark.asyncio
async def test_e2e_open_no_node_available(_enable_hidden_business):
    """没在线节点 · open_session 抛 no_available_node"""
    with patch("platform_v8.services.proxy.gateway.pick_worker",
               AsyncMock(return_value=None)):
        with pytest.raises(RuntimeError, match="no_available_node"):
            await pg.open_session(
                client_id="acct_42",
                target_host="example.com",
                target_port=443,
            )


@pytest.mark.asyncio
async def test_e2e_target_denied_by_allowlist(_enable_hidden_business):
    """目标在黑名单 · open_session 抛 target_denied"""
    with patch("platform_v8.services.proxy.gateway.is_target_allowed",
               return_value=(False, "banned_by_admin")):
        with pytest.raises(RuntimeError, match="target_denied"):
            await pg.open_session(
                client_id="acct_42",
                target_host="banned.com",
                target_port=80,
            )


@pytest.mark.asyncio
async def test_e2e_forward_after_close_returns_false(_enable_hidden_business):
    """session 已关 · forward_to_node 返 False"""
    with patch("platform_v8.services.proxy.gateway.pick_worker",
               AsyncMock(return_value="worker_e2e_2")), \
         patch("platform_v8.services.proxy.gateway.session_dispatcher.open_tunnel",
               AsyncMock(return_value=True)), \
         patch("platform_v8.services.proxy.gateway.session_dispatcher.send_close",
               AsyncMock(return_value=True)), \
         patch("platform_v8.services.proxy.gateway._create_workload_for_session",
               AsyncMock()), \
         patch("platform_v8.services.proxy.gateway._bill_and_cleanup",
               AsyncMock()):
        sid, _ = await pg.open_session(
            client_id="acct_42",
            target_host="example.com",
            target_port=443,
        )
        await pg.close_session(sid)

        ok = await pg.forward_to_node(sid, b"too late")
        assert ok is False


@pytest.mark.asyncio
async def test_e2e_node_offline_at_open_cleans_up(_enable_hidden_business):
    """open 时节点突然掉线 (session_dispatcher.open_tunnel 返 False)
    → 清理 _sessions 不残留 + 抛 worker_offline_at_open
    """
    with patch("platform_v8.services.proxy.gateway.pick_worker",
               AsyncMock(return_value="worker_offline")), \
         patch("platform_v8.services.proxy.gateway.session_dispatcher.open_tunnel",
               AsyncMock(return_value=False)):
        with pytest.raises(RuntimeError, match="worker_offline_at_open"):
            await pg.open_session(
                client_id="acct_42",
                target_host="example.com",
                target_port=443,
            )
        # 清理 ok
        assert len(pg._sessions) == 0
        assert "worker_offline" not in pg._node_sessions or \
               len(pg._node_sessions.get("worker_offline", set())) == 0


# ════════════════════════════════════════════════════════════════
# admin · stats / blacklist
# ════════════════════════════════════════════════════════════════
def test_blacklist_add_remove_list():
    """admin blacklist 增 / 删 / 列"""
    assert pg.blacklist_list() == []
    pg.blacklist_add("worker_bad")
    pg.blacklist_add("worker_evil")
    assert set(pg.blacklist_list()) == {"worker_bad", "worker_evil"}
    pg.blacklist_remove("worker_bad")
    assert pg.blacklist_list() == ["worker_evil"]


def test_stats_initially_zero():
    """无 session 时 stats 全 0"""
    with patch("platform_v8.services.proxy.gateway.broker.get_online_worker_ids",
               return_value=[]):
        s = pg.stats()
        assert s["active_sessions"] == 0
        assert s["bytes_up_total"] == 0
        assert s["online_nodes_total"] == 0


@pytest.mark.asyncio
async def test_stats_reflects_active_session(_enable_hidden_business):
    """开 session 后 stats 计数 +1"""
    with patch("platform_v8.services.proxy.gateway.pick_worker",
               AsyncMock(return_value="worker_e2e_3")), \
         patch("platform_v8.services.proxy.gateway.session_dispatcher.open_tunnel",
               AsyncMock(return_value=True)), \
         patch("platform_v8.services.proxy.gateway._create_workload_for_session",
               AsyncMock()), \
         patch("platform_v8.services.proxy.gateway.broker.get_online_worker_ids",
               return_value=["worker_e2e_3"]):
        await pg.open_session(
            client_id="acct_42",
            target_host="example.com",
            target_port=443,
            initial_data=b"hello",
        )
        s = pg.stats()
        assert s["active_sessions"] == 1
        assert s["bytes_up_total"] == len(b"hello")
        assert "worker_e2e_3" in s["sessions_per_node"]


# ════════════════════════════════════════════════════════════════
# admin · is_target_allowed
# ════════════════════════════════════════════════════════════════
def test_is_target_allowed_default():
    """白名单默认 · localhost / 内网 IP 一律拒 (返 (ok, reason))"""
    ok1, _ = pg.is_target_allowed("example.com")
    ok2, _ = pg.is_target_allowed("api.openai.com")
    assert ok1 and ok2
    # 内网拒
    for bad in ("localhost", "127.0.0.1", "192.168.1.1", "10.0.0.1"):
        ok, _ = pg.is_target_allowed(bad)
        assert not ok, f"{bad} 不应允许"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
