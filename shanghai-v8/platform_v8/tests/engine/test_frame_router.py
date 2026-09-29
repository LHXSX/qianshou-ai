"""
W0-2 · engine/frame_router.py 单测

覆盖:
  1. 注册 + dispatch 正常路径
  2. 未注册帧 · dispatch 返 False
  3. handler 内部异常 · dispatch 不 raise · 主循环不挂
  4. CancelledError 透传 (asyncio 协作取消)
  5. 重复注册警告 + 后注册覆盖
  6. clear_all / unregister_handler / list_handlers

跑法:
  pytest platform_v8/tests/engine/test_frame_router.py -v
"""
from __future__ import annotations
import asyncio
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.engine import frame_router
from platform_v8.protocol import ws_schema as wsp


# ─────────── helpers ───────────
def _mk_tunnel_chunk_frame(tunnel_id: str = "tid-1", seq: int = 0):
    return wsp.TunnelChunk(payload=wsp.TunnelChunkPayload(
        tunnel_id=tunnel_id, data_b64="aGk=", seq=seq,
    ))


def _mk_tunnel_close_frame(tunnel_id: str = "tid-1"):
    return wsp.TunnelClose(payload=wsp.TunnelClosePayload(
        tunnel_id=tunnel_id, reason="client_close",
        stats={"bytes_up": 100, "bytes_down": 200},
    ))


@pytest.fixture(autouse=True)
def _clear_router():
    """每个用例前后清空注册表 · 避免状态泄漏"""
    frame_router.clear_all()
    yield
    frame_router.clear_all()


# ─────────── 用例 1 · 正常注册 + dispatch ───────────
def test_register_and_dispatch_ok():
    calls = []

    async def handler(frame, worker_id, owner_id):
        calls.append((frame.type, worker_id, owner_id))

    frame_router.register_handler("tunnel_chunk", handler)

    frame = _mk_tunnel_chunk_frame()
    result = asyncio.run(frame_router.dispatch(frame, "worker-1", 42))

    assert result is True
    assert len(calls) == 1
    assert calls[0] == ("tunnel_chunk", "worker-1", 42)


# ─────────── 用例 2 · 未注册 ───────────
def test_dispatch_unknown_frame_returns_false():
    async def handler(frame, worker_id, owner_id):
        pytest.fail("此 handler 不该被调")

    frame_router.register_handler("tunnel_chunk", handler)
    frame = _mk_tunnel_close_frame()  # tunnel_close 没注册
    result = asyncio.run(frame_router.dispatch(frame, "w", 0))
    assert result is False


# ─────────── 用例 3 · handler 抛异常 · 主循环不挂 ───────────
def test_handler_exception_silent():
    async def bad_handler(frame, worker_id, owner_id):
        raise RuntimeError("业务 bug · 不能炸主循环")

    frame_router.register_handler("tunnel_chunk", bad_handler)
    frame = _mk_tunnel_chunk_frame()

    # 关键: dispatch 不该 raise
    result = asyncio.run(frame_router.dispatch(frame, "w", 0))
    assert result is True  # 仍返 True (已经 dispatch 到业务)


# ─────────── 用例 4 · CancelledError 透传 ───────────
def test_cancelled_error_propagates():
    """asyncio 协作取消要透传 · 不能被吞 (否则任务 cancel 死锁)"""
    async def cancellable_handler(frame, worker_id, owner_id):
        raise asyncio.CancelledError()

    frame_router.register_handler("tunnel_chunk", cancellable_handler)
    frame = _mk_tunnel_chunk_frame()

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(frame_router.dispatch(frame, "w", 0))


# ─────────── 用例 5 · 重复注册 + 覆盖 ───────────
def test_duplicate_register_overrides(caplog):
    import logging
    caplog.set_level(logging.WARNING)
    calls = []

    async def h1(frame, worker_id, owner_id):
        calls.append("h1")

    async def h2(frame, worker_id, owner_id):
        calls.append("h2")

    frame_router.register_handler("tunnel_chunk", h1)
    frame_router.register_handler("tunnel_chunk", h2)  # 应警告 + 覆盖

    frame = _mk_tunnel_chunk_frame()
    asyncio.run(frame_router.dispatch(frame, "w", 0))

    assert calls == ["h2"]  # 用后注册的
    # 警告日志应包含 "tunnel_chunk"
    assert any("tunnel_chunk" in r.message and "重复" in r.message
               for r in caplog.records)


# ─────────── 用例 6 · list_handlers / unregister / clear_all ───────────
def test_list_and_unregister_and_clear():
    async def h(frame, worker_id, owner_id):
        pass

    frame_router.register_handler("tunnel_chunk", h)
    frame_router.register_handler("tunnel_close", h)
    assert sorted(frame_router.list_handlers()) == ["tunnel_chunk", "tunnel_close"]

    frame_router.unregister_handler("tunnel_chunk")
    assert frame_router.list_handlers() == ["tunnel_close"]

    frame_router.clear_all()
    assert frame_router.list_handlers() == []


# ─────────── 用例 7 · 多 frame type 路由分流 ───────────
def test_multi_frame_routing():
    """tunnel_chunk 和 tunnel_close 走不同 handler · 互不干扰"""
    chunk_count = [0]
    close_count = [0]

    async def on_chunk(frame, worker_id, owner_id):
        chunk_count[0] += 1

    async def on_close(frame, worker_id, owner_id):
        close_count[0] += 1

    frame_router.register_handler("tunnel_chunk", on_chunk)
    frame_router.register_handler("tunnel_close", on_close)

    async def _run():
        await frame_router.dispatch(_mk_tunnel_chunk_frame("a"), "w", 0)
        await frame_router.dispatch(_mk_tunnel_chunk_frame("b"), "w", 0)
        await frame_router.dispatch(_mk_tunnel_close_frame("a"), "w", 0)

    asyncio.run(_run())
    assert chunk_count[0] == 2
    assert close_count[0] == 1


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
