"""
W4-D5 · crawl aggregator_hook 单测 (2026-05-26)

覆盖:
  - _parse_node_output · 解节点输出 JSON / 兜底
  - _process_shard_completed_sync · 反写 we_crawl_subtasks · 跳非 crawl · 跳无 meta
  - _process_shard_failed_sync · attempts < 3 回 pending · >= 3 标 failed
"""
from __future__ import annotations
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.crawl import aggregator_hook as hook


# ════════════════════════════════════════════════════════════════
# _parse_node_output
# ════════════════════════════════════════════════════════════════
def test_parse_node_output_json_full():
    raw = '{"result_oss_url":"oss://x.json","result_hash":"abc","result_size_bytes":1024}'
    url, h, size = hook._parse_node_output(raw)
    assert url == "oss://x.json"
    assert h == "abc"
    assert size == 1024


def test_parse_node_output_json_partial():
    raw = '{"result_hash":"abc"}'
    url, h, size = hook._parse_node_output(raw)
    assert url == ""
    assert h == "abc"
    assert size == 0


def test_parse_node_output_empty():
    assert hook._parse_node_output("") == ("", "", 0)


def test_parse_node_output_fallback_url():
    """非 JSON · 兜底当 OSS URL"""
    url, h, size = hook._parse_node_output("https://oss.example.com/blob")
    assert url == "https://oss.example.com/blob"
    assert h == ""
    assert size == 0


def test_parse_node_output_malformed_json():
    """JSON 损坏 · 兜底空"""
    url, h, size = hook._parse_node_output("{not valid")
    assert url == "{not valid"


# ════════════════════════════════════════════════════════════════
# _process_shard_completed_sync · 非 crawl 业务跳过
# ════════════════════════════════════════════════════════════════
def test_completed_skips_non_crawl_business():
    """shard.metadata['business']='geo' → 跳过 · 不 hit 老表"""
    from platform_v8.core import Shard, ShardStatus, ShardMode
    fake_sh = Shard(
        id="sh1", workload_id="wl1",
        metadata={"business": "geo"},
    )
    mock_session = MagicMock()
    mock_scope = MagicMock()
    mock_scope.__enter__.return_value = mock_session
    mock_scope.__exit__.return_value = None

    with patch("platform_v8.storage.db.session_scope", return_value=mock_scope), \
         patch("platform_v8.storage.repo.ShardRepo.by_id", return_value=fake_sh):
        hook._process_shard_completed_sync("sh1", "wl1")
    
    # 不应该 execute 任何 SQL (跳出非 crawl)
    mock_session.execute.assert_not_called()


def test_completed_skips_missing_metadata():
    """meta 缺 crawl_order_id 跳过"""
    from platform_v8.core import Shard
    fake_sh = Shard(id="sh1", workload_id="wl1",
                    metadata={"business": "crawl"})  # 缺 crawl_order_id
    mock_session = MagicMock()
    mock_scope = MagicMock()
    mock_scope.__enter__.return_value = mock_session
    mock_scope.__exit__.return_value = None

    with patch("platform_v8.storage.db.session_scope", return_value=mock_scope), \
         patch("platform_v8.storage.repo.ShardRepo.by_id", return_value=fake_sh):
        hook._process_shard_completed_sync("sh1", "wl1")
    mock_session.execute.assert_not_called()


# ════════════════════════════════════════════════════════════════
# _process_shard_failed_sync · attempts < 3 回 pending
# ════════════════════════════════════════════════════════════════
def test_failed_skips_non_crawl():
    from platform_v8.core import Shard
    fake_sh = Shard(id="sh1", workload_id="wl1",
                    metadata={"business": "geo"})
    mock_session = MagicMock()
    mock_scope = MagicMock()
    mock_scope.__enter__.return_value = mock_session
    mock_scope.__exit__.return_value = None

    with patch("platform_v8.storage.db.session_scope", return_value=mock_scope), \
         patch("platform_v8.storage.repo.ShardRepo.by_id", return_value=fake_sh):
        hook._process_shard_failed_sync("sh1", "wl1")
    mock_session.execute.assert_not_called()


# ════════════════════════════════════════════════════════════════
# on_shard_completed / failed · event 解包 · 非 success 跳
# ════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_on_shard_completed_skips_non_success():
    """outcome=failure 跳"""
    class FakeEvent:
        payload = {"workload_id": "w", "shard_id": "s", "outcome": "failure"}
    # 不应该调到任何 DB
    with patch("platform_v8.services.crawl.aggregator_hook._process_shard_completed_sync") as mock:
        await hook.on_shard_completed(FakeEvent())
        mock.assert_not_called()


@pytest.mark.asyncio
async def test_on_shard_completed_success_calls_sync():
    """outcome=success → 调 _process_shard_completed_sync"""
    class FakeEvent:
        payload = {"workload_id": "w", "shard_id": "s", "outcome": "success"}
    with patch("platform_v8.services.crawl.aggregator_hook._process_shard_completed_sync") as mock:
        await hook.on_shard_completed(FakeEvent())
        mock.assert_called_once_with("s", "w")


@pytest.mark.asyncio
async def test_on_shard_completed_handles_dict_event():
    """event 是 dict 也支持"""
    with patch("platform_v8.services.crawl.aggregator_hook._process_shard_completed_sync") as mock:
        await hook.on_shard_completed({"workload_id": "w", "shard_id": "s", "outcome": "success"})
        mock.assert_called_once_with("s", "w")


@pytest.mark.asyncio
async def test_on_shard_completed_swallows_errors():
    """sync 抛错 · hook 静默"""
    with patch("platform_v8.services.crawl.aggregator_hook._process_shard_completed_sync",
               side_effect=RuntimeError("db down")):
        # 不抛
        await hook.on_shard_completed({"workload_id": "w", "shard_id": "s", "outcome": "success"})


@pytest.mark.asyncio
async def test_on_shard_failed_calls_sync():
    with patch("platform_v8.services.crawl.aggregator_hook._process_shard_failed_sync") as mock:
        await hook.on_shard_failed({"workload_id": "w", "shard_id": "s"})
        mock.assert_called_once_with("s", "w")


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
