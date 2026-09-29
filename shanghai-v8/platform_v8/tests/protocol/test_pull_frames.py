"""
W1-2 · 协议 PullRequest / PullAssign 帧单测

覆盖:
  1. PullRequest 构造 + parse · 字段对齐
  2. PullAssign 构造 (含 ShardAssignPayload list) · 字段对齐
  3. parse_incoming 识别 pull_request
  4. PullRequest 默认值 (task_type_filter 空 / free_capacity 空)
  5. PullAssign 多 shard 列表序列化

跑法:
  PYTHONPATH=... pytest platform_v8/tests/protocol/test_pull_frames.py -v
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.protocol import ws_schema as wsp


# ─────────── 用例 1 · PullRequest 构造 + parse ───────────
def test_pull_request_build_and_parse():
    text = wsp.build_pull_request(
        max_count=3,
        task_type_filter=["crawl_url_fetch", "geo_query"],
        free_capacity={"cpu_pct": 80, "ram_free_mb": 4096},
    )
    data = json.loads(text)
    assert data["type"] == "pull_request"
    assert data["v"] == "8.0"
    p = data["payload"]
    assert p["max_count"] == 3
    assert p["task_type_filter"] == ["crawl_url_fetch", "geo_query"]
    assert p["free_capacity"] == {"cpu_pct": 80, "ram_free_mb": 4096}

    # parse 回来
    parsed = wsp.parse_incoming(text)
    assert isinstance(parsed, wsp.PullRequest)
    assert parsed.payload.max_count == 3
    assert parsed.payload.task_type_filter == ["crawl_url_fetch", "geo_query"]


# ─────────── 用例 2 · PullRequest 默认值 ───────────
def test_pull_request_defaults():
    text = wsp.build_pull_request()  # 全用默认
    data = json.loads(text)
    p = data["payload"]
    assert p["max_count"] == 1
    assert p["task_type_filter"] == []
    assert p["free_capacity"] == {}


# ─────────── 用例 3 · PullAssign 构造 (含 shards 列表) ───────────
def test_pull_assign_with_shards():
    shard_payloads = [
        wsp.ShardAssignPayload(
            shard_id=f"sh-{i}", workload_id="wl-1",
            index=i, total=3, task_type="crawl_url_fetch",
            input_kind="params_only",
            params={"url": f"https://example.com/{i}"},
            reward=0.05,
        )
        for i in range(3)
    ]
    text = wsp.build_pull_assign(
        shards=shard_payloads,
        next_pull_after_ms=10000,
        server_load_hint=0.7,
    )
    data = json.loads(text)
    assert data["type"] == "pull_assign"
    p = data["payload"]
    assert len(p["shards"]) == 3
    assert p["shards"][0]["shard_id"] == "sh-0"
    assert p["shards"][2]["index"] == 2
    assert p["next_pull_after_ms"] == 10000
    assert p["server_load_hint"] == 0.7


# ─────────── 用例 4 · PullAssign 空 shards (允许 · server 没活给) ───────────
def test_pull_assign_empty_shards():
    text = wsp.build_pull_assign(shards=[], next_pull_after_ms=30000)
    data = json.loads(text)
    p = data["payload"]
    assert p["shards"] == []
    assert p["next_pull_after_ms"] == 30000


# ─────────── 用例 5 · parse_incoming 不识别 pull_assign (出站帧) ───────────
def test_parse_pull_assign_not_incoming():
    """PullAssign 是 server → node · 不应进 parse_incoming"""
    text = wsp.build_pull_assign(shards=[])
    with pytest.raises(wsp.ProtocolError, match="unknown frame type"):
        wsp.parse_incoming(text)


# ─────────── 用例 6 · ShardAssignPayload 在 PullAssign 内字段完整 ───────────
def test_pull_assign_shard_payload_full_fields():
    """验证 ShardAssignPayload 所有字段都能在 PullAssign 里正常带出"""
    sp = wsp.ShardAssignPayload(
        shard_id="s1", workload_id="w1",
        index=0, total=1,
        task_type="geo_query",
        runtime="python3",
        code_url="https://example.com/geo.py",
        input_kind="params_only",
        params={"brand": "Apple", "keyword": "phone", "llm": "kimi"},
        timeout_s=120,
        reward=0.01,
        workload_name="GEO 监测 · Apple 品牌",
        requester_name="geo_customer_1",
    )
    text = wsp.build_pull_assign(shards=[sp])
    data = json.loads(text)
    s = data["payload"]["shards"][0]
    assert s["task_type"] == "geo_query"
    assert s["code_url"] == "https://example.com/geo.py"
    assert s["params"]["brand"] == "Apple"
    assert s["workload_name"] == "GEO 监测 · Apple 品牌"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
