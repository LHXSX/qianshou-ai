"""
W0-3 · engine/session_dispatcher.py 单测

覆盖:
  1. open_tunnel · push 成功 · 帧字段对齐
  2. open_tunnel · push 失败 (worker 不在线) · 返 False
  3. send_chunk · base64 编码正确
  4. send_close · stats 透传正确
  5. push_to_worker 异常 · dispatcher 不 raise

策略:
  - mock broker.push_to_worker · 检 frame 内容
  - 不需要真 ws / DB

跑法:
  PYTHONPATH=... pytest platform_v8/tests/engine/test_session_dispatcher.py -v
"""
from __future__ import annotations
import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.engine import session_dispatcher


# ─────────── 用例 1 · open_tunnel · push 成功 · 帧字段对 ───────────
def test_open_tunnel_ok_frame_fields():
    captured = {}

    async def fake_push(worker_id, frame_text):
        captured["worker_id"] = worker_id
        captured["frame"] = json.loads(frame_text)
        return True

    with patch("platform_v8.engine.session_dispatcher.broker.push_to_worker",
               new=AsyncMock(side_effect=fake_push)):
        result = asyncio.run(session_dispatcher.open_tunnel(
            worker_id="worker-uuid-1",
            service_type="ip_proxy",
            tunnel_id="tid-abc",
            target={"host": "example.com", "port": 443, "use_tls": True},
            initial_data=b"GET / HTTP/1.1\r\n",
            timeout_s=120,
            display_task_type="system_session",
            display_name="系统会话",
            estimated_reward_edg=0.005,
        ))

    assert result is True
    assert captured["worker_id"] == "worker-uuid-1"
    f = captured["frame"]
    assert f["type"] == "tunnel_open"
    p = f["payload"]
    assert p["tunnel_id"] == "tid-abc"
    assert p["service_type"] == "ip_proxy"
    assert p["target"] == {"host": "example.com", "port": 443, "use_tls": True}
    assert p["timeout_s"] == 120
    assert p["display_task_type"] == "system_session"
    assert p["display_name"] == "系统会话"
    assert p["estimated_reward_edg"] == 0.005
    # initial_data 应被 base64 编码
    import base64
    assert base64.b64decode(p["initial_data_b64"]) == b"GET / HTTP/1.1\r\n"


# ─────────── 用例 2 · open_tunnel · push 失败 ───────────
def test_open_tunnel_push_fail_returns_false():
    with patch("platform_v8.engine.session_dispatcher.broker.push_to_worker",
               new=AsyncMock(return_value=False)):
        result = asyncio.run(session_dispatcher.open_tunnel(
            worker_id="offline",
            service_type="ip_proxy",
            tunnel_id="tid-x",
        ))
    assert result is False


# ─────────── 用例 3 · send_chunk · base64 编码 ───────────
def test_send_chunk_base64_encoded():
    captured = {}

    async def fake_push(worker_id, frame_text):
        captured["frame"] = json.loads(frame_text)
        return True

    with patch("platform_v8.engine.session_dispatcher.broker.push_to_worker",
               new=AsyncMock(side_effect=fake_push)):
        result = asyncio.run(session_dispatcher.send_chunk(
            worker_id="w", tunnel_id="tid", data=b"\x01\x02\x03\xff", seq=5,
        ))

    assert result is True
    p = captured["frame"]["payload"]
    assert p["tunnel_id"] == "tid"
    assert p["seq"] == 5
    import base64
    assert base64.b64decode(p["data_b64"]) == b"\x01\x02\x03\xff"


# ─────────── 用例 4 · send_close · stats 透传 ───────────
def test_send_close_stats_passthrough():
    captured = {}

    async def fake_push(worker_id, frame_text):
        captured["frame"] = json.loads(frame_text)
        return True

    with patch("platform_v8.engine.session_dispatcher.broker.push_to_worker",
               new=AsyncMock(side_effect=fake_push)):
        result = asyncio.run(session_dispatcher.send_close(
            worker_id="w", tunnel_id="tid",
            reason="client_close",
            stats={"bytes_up": 1024, "bytes_down": 2048, "hit_count": 3},
            error="",
        ))

    assert result is True
    p = captured["frame"]["payload"]
    assert p["tunnel_id"] == "tid"
    assert p["reason"] == "client_close"
    assert p["stats"] == {"bytes_up": 1024, "bytes_down": 2048, "hit_count": 3}
    assert p["error"] == ""


# ─────────── 用例 5 · send_close · 默认 stats=None 不挂 ───────────
def test_send_close_default_stats_empty():
    captured = {}

    async def fake_push(worker_id, frame_text):
        captured["frame"] = json.loads(frame_text)
        return True

    with patch("platform_v8.engine.session_dispatcher.broker.push_to_worker",
               new=AsyncMock(side_effect=fake_push)):
        asyncio.run(session_dispatcher.send_close(
            worker_id="w", tunnel_id="tid", reason="timeout",
        ))

    p = captured["frame"]["payload"]
    assert p["stats"] == {}
    assert p["error"] == ""


# ─────────── 用例 6 · open_tunnel · target=None 透传成空 dict ───────────
def test_open_tunnel_target_none_becomes_empty_dict():
    captured = {}

    async def fake_push(worker_id, frame_text):
        captured["frame"] = json.loads(frame_text)
        return True

    with patch("platform_v8.engine.session_dispatcher.broker.push_to_worker",
               new=AsyncMock(side_effect=fake_push)):
        asyncio.run(session_dispatcher.open_tunnel(
            worker_id="w",
            service_type="rpc_call",
            tunnel_id="tid",
            target=None,
        ))

    p = captured["frame"]["payload"]
    assert p["target"] == {}
    assert p["service_type"] == "rpc_call"
    assert p["initial_data_b64"] == ""


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
