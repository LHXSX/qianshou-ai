"""
W0-7 · services/proxy/registry.py 集成单测

覆盖:
  1. install() 后 · frame_router 有 tunnel_chunk/close handler
  2. install() 后 · task_registry 有 ip_proxy task_type (SESSION mode)
  3. install() 幂等 · 重复调不报错
  4. uninstall() 清干净
  5. install() 后端到端: 模拟 ws 收到 tunnel_chunk → frame_router → gateway.on_node_chunk

跑法:
  PYTHONPATH=... pytest platform_v8/tests/services/test_proxy_registry.py -v
"""
from __future__ import annotations
import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.engine import frame_router, task_registry
from platform_v8.engine.task_registry import TaskMode
from platform_v8.protocol import ws_schema as wsp


@pytest.fixture(autouse=True)
def _clean_state():
    """每个用例清干净 · 防注册泄漏"""
    # 清 frame_router
    frame_router.clear_all()
    # 清 task_registry ip_proxy
    task_registry.TASK_REGISTRY.pop("ip_proxy", None)
    # 清 registry _installed flag
    from platform_v8.services.proxy import registry as preg
    preg._installed = False
    yield
    frame_router.clear_all()
    task_registry.TASK_REGISTRY.pop("ip_proxy", None)
    preg._installed = False


# ─────────── 用例 1 · install() 后 frame_router 有 handler ───────────
def test_install_registers_frame_handlers():
    from platform_v8.services.proxy import registry as preg
    preg.install()

    handlers = frame_router.list_handlers()
    assert "tunnel_chunk" in handlers
    assert "tunnel_close" in handlers


# ─────────── 用例 2 · install() 后 task_registry 有 ip_proxy ───────────
def test_install_registers_task_type():
    from platform_v8.services.proxy import registry as preg
    preg.install()

    spec = task_registry.get_spec("ip_proxy")
    assert spec.task_type == "ip_proxy"
    assert spec.mode == TaskMode.SESSION
    assert spec.category == "system"


# ─────────── 用例 3 · install() 幂等 ───────────
def test_install_idempotent():
    from platform_v8.services.proxy import registry as preg
    preg.install()
    preg.install()  # 第二次不该报错 · 不重复注册
    preg.install()

    # frame_router 仍然只 1 个 handler (不重复)
    handlers = frame_router.list_handlers()
    assert handlers.count("tunnel_chunk") == 1


# ─────────── 用例 4 · uninstall() 清干净 ───────────
def test_uninstall_clears():
    from platform_v8.services.proxy import registry as preg
    preg.install()
    preg.uninstall()

    handlers = frame_router.list_handlers()
    assert "tunnel_chunk" not in handlers
    assert "tunnel_close" not in handlers
    assert task_registry.get_spec("ip_proxy") is task_registry.DEFAULT_SPEC


# ─────────── 用例 5 · 端到端 · tunnel_chunk 帧 → frame_router → gateway ───────────
def test_end_to_end_tunnel_chunk_routing():
    """模拟 ws.py 收到 tunnel_chunk 帧后 · 走 frame_router.dispatch 到 gateway.on_node_chunk"""
    from platform_v8.services.proxy import registry as preg
    preg.install()

    captured = {}

    async def fake_on_node_chunk(tunnel_id, data_b64, *, seq=0):
        captured["tunnel_id"] = tunnel_id
        captured["data_b64"] = data_b64
        captured["seq"] = seq

    # mock gateway.on_node_chunk
    with patch("platform_v8.services.proxy.gateway.on_node_chunk",
               new=AsyncMock(side_effect=fake_on_node_chunk)):
        # 模拟 ws.py 收到 tunnel_chunk
        frame = wsp.TunnelChunk(payload=wsp.TunnelChunkPayload(
            tunnel_id="tid-abc",
            data_b64="aGVsbG8=",
            seq=42,
        ))
        result = asyncio.run(frame_router.dispatch(frame, "worker-1", 100))

    assert result is True
    assert captured == {"tunnel_id": "tid-abc", "data_b64": "aGVsbG8=", "seq": 42}


# ─────────── 用例 6 · 端到端 · tunnel_close 帧 → frame_router → gateway ───────────
def test_end_to_end_tunnel_close_routing():
    from platform_v8.services.proxy import registry as preg
    preg.install()

    captured = {}

    async def fake_on_node_close(tunnel_id, *, reason, bytes_up, bytes_down, error):
        captured["tunnel_id"] = tunnel_id
        captured["reason"] = reason
        captured["bytes_up"] = bytes_up
        captured["bytes_down"] = bytes_down
        captured["error"] = error

    with patch("platform_v8.services.proxy.gateway.on_node_close",
               new=AsyncMock(side_effect=fake_on_node_close)):
        frame = wsp.TunnelClose(payload=wsp.TunnelClosePayload(
            tunnel_id="tid-xyz",
            reason="client_close",
            stats={"bytes_up": 1024, "bytes_down": 2048},
            error="",
        ))
        result = asyncio.run(frame_router.dispatch(frame, "worker-1", 100))

    assert result is True
    assert captured["tunnel_id"] == "tid-xyz"
    assert captured["reason"] == "client_close"
    assert captured["bytes_up"] == 1024
    assert captured["bytes_down"] == 2048


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
