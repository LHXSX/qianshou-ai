"""
W3-D1 · services/proxy/gateway.py 跟统一引擎接轨单测

覆盖:
  1. _create_workload_for_session · client_id 不是 int → 不 hit DB · skip
  2. _create_workload_for_session · 正常 → 调 WorkloadRepo.create + ShardRepo.create_batch
     · workload.status=RUNNING · shard.status=LEASED · shard.mode=SESSION
  3. _close_workload_for_session · success → mark_done + update_status(DONE) + add_spent
  4. _close_workload_for_session · error → mark_failed + update_status(FAILED)
  5. workloads_t 含 spent 列 (v8_012 引入)

跑法:
  PYTHONPATH=... pytest platform_v8/tests/services/test_proxy_engine_hook.py -v
"""
from __future__ import annotations
import asyncio
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.proxy import gateway as pg
from platform_v8.services.proxy.gateway import (
    ProxySession, _create_workload_for_session, _close_workload_for_session,
)


# ──── helpers ────
def _make_sess(client_id: str = "42", worker_id: str = "w1") -> ProxySession:
    return ProxySession(
        session_id="sid_abc123",
        worker_id=worker_id,
        client_id=client_id,
        target_host="example.com",
        target_port=443,
        use_tls=True,
        started_at=time.time() - 5,
    )


# ════════════════════════════════════════════════════════════════
# 1 · client_id 不是 int → 不 hit DB
# ════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_create_workload_skips_when_non_int_client():
    sess = _make_sess(client_id="api_key_foo")  # 不是数字

    with patch("platform_v8.storage.db.session_scope") as mock_scope:
        await _create_workload_for_session(sess, est_reward_edg=0.001)
        # client_id 不是 int · _sync 早返 · 不该 hit DB
        mock_scope.assert_not_called()


# ════════════════════════════════════════════════════════════════
# 2 · 正常 · WorkloadRepo.create + ShardRepo.create_batch 被调
# ════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_create_workload_normal_path_calls_repos():
    sess = _make_sess(client_id="42", worker_id="worker_xyz")

    captured = {}

    def fake_create(s, workload):
        captured["workload"] = workload
        return workload

    def fake_create_batch(s, shards):
        captured["shards"] = shards
        return shards

    # mock session_scope context manager
    fake_session = MagicMock()
    mock_scope = MagicMock()
    mock_scope.__enter__.return_value = fake_session
    mock_scope.__exit__.return_value = None

    with patch("platform_v8.storage.db.session_scope", return_value=mock_scope), \
         patch("platform_v8.storage.repo.WorkloadRepo.create", side_effect=fake_create), \
         patch("platform_v8.storage.repo.ShardRepo.create_batch", side_effect=fake_create_batch):
        await _create_workload_for_session(sess, est_reward_edg=0.001)

    # 验证 WorkloadRepo.create 被调 · workload 字段正确
    assert "workload" in captured, "WorkloadRepo.create 没被调"
    wl = captured["workload"]
    assert wl.id == sess.session_id
    assert wl.owner_id == 42  # int 转成功
    from platform_v8.core import WorkloadStatus
    assert wl.status == WorkloadStatus.RUNNING  # SESSION 业务直接 RUNNING
    assert wl.total_shards == 1
    assert wl.spec.task_type == "ip_proxy"
    assert wl.spec.params["target_host"] == "example.com"
    assert wl.spec.params["target_port"] == 443
    assert wl.spec.params["use_tls"] is True

    # 验证 ShardRepo.create_batch 被调 · shard 字段正确
    assert "shards" in captured, "ShardRepo.create_batch 没被调"
    shs = captured["shards"]
    assert len(shs) == 1
    sh = shs[0]
    from platform_v8.core import ShardStatus, ShardMode
    assert sh.workload_id == sess.session_id
    assert sh.status == ShardStatus.LEASED  # 节点已派 · 跳 PENDING/DISPATCHED/RUNNING
    assert sh.mode == ShardMode.SESSION
    assert sh.worker_id == "worker_xyz"
    assert sh.metadata["business"] == "proxy"
    assert sh.metadata["session_id"] == sess.session_id
    assert sh.metadata["target"] == "example.com:443"


# ════════════════════════════════════════════════════════════════
# 3 · close · success · mark_done + update_status(DONE) + add_spent
# ════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_close_workload_success_path():
    sess = _make_sess(client_id="42")

    captured = {"shards_done": [], "shards_failed": [], "wl_status": None, "spent": None}

    # mock ShardRepo.by_workload 返 1 个 shard
    from platform_v8.core import Shard, ShardStatus, ShardMode
    fake_shard = Shard(
        id="shard_xyz",
        workload_id=sess.session_id,
        index=0, total=1,
        status=ShardStatus.LEASED,
        mode=ShardMode.SESSION,
        worker_id=sess.worker_id,
    )

    def fake_by_workload(s, wid):
        return [fake_shard]

    def fake_mark_done(s, sid, **kwargs):
        captured["shards_done"].append((sid, kwargs))
        return True

    def fake_mark_failed(s, sid, **kwargs):
        captured["shards_failed"].append((sid, kwargs))
        return True

    def fake_update_status(s, wid, status, **kwargs):
        captured["wl_status"] = (wid, status, kwargs)
        return True

    def fake_add_spent(s, wid, delta):
        captured["spent"] = (wid, delta)
        return True

    fake_session = MagicMock()
    mock_scope = MagicMock()
    mock_scope.__enter__.return_value = fake_session
    mock_scope.__exit__.return_value = None

    with patch("platform_v8.storage.db.session_scope", return_value=mock_scope), \
         patch("platform_v8.storage.repo.ShardRepo.by_workload", side_effect=fake_by_workload), \
         patch("platform_v8.storage.repo.ShardRepo.mark_done", side_effect=fake_mark_done), \
         patch("platform_v8.storage.repo.ShardRepo.mark_failed", side_effect=fake_mark_failed), \
         patch("platform_v8.storage.repo.WorkloadRepo.update_status", side_effect=fake_update_status), \
         patch("platform_v8.storage.repo.WorkloadRepo.add_spent", side_effect=fake_add_spent):
        await _close_workload_for_session(
            sess, revenue_edg=0.005, reason="client_close", error="",
        )

    # mark_done 被调 1 次
    assert len(captured["shards_done"]) == 1
    assert captured["shards_done"][0][0] == "shard_xyz"
    # mark_failed 不被调
    assert len(captured["shards_failed"]) == 0
    # workload → DONE
    from platform_v8.core import WorkloadStatus
    assert captured["wl_status"] is not None
    wid, status, kwargs = captured["wl_status"]
    assert wid == sess.session_id
    assert status == WorkloadStatus.DONE
    assert kwargs["completed_shards"] == 1
    assert kwargs["failed_shards"] == 0
    # spent 累加
    assert captured["spent"] is not None
    wid_s, delta = captured["spent"]
    assert wid_s == sess.session_id
    assert float(delta) == pytest.approx(0.005)


# ════════════════════════════════════════════════════════════════
# 4 · close · error · mark_failed + update_status(FAILED)
# ════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_close_workload_error_path():
    sess = _make_sess(client_id="42")

    captured = {"shards_done": [], "shards_failed": [], "wl_status": None, "spent": None}

    from platform_v8.core import Shard, ShardStatus, ShardMode
    fake_shard = Shard(
        id="shard_xyz",
        workload_id=sess.session_id,
        index=0, total=1,
        status=ShardStatus.LEASED,
        mode=ShardMode.SESSION,
        worker_id=sess.worker_id,
    )

    def fake_by_workload(s, wid):
        return [fake_shard]

    def fake_mark_done(s, sid, **kwargs):
        captured["shards_done"].append(sid)
        return True

    def fake_mark_failed(s, sid, **kwargs):
        captured["shards_failed"].append((sid, kwargs.get("error", "")))
        return True

    def fake_update_status(s, wid, status, **kwargs):
        captured["wl_status"] = (wid, status, kwargs)
        return True

    def fake_add_spent(s, wid, delta):
        captured["spent"] = (wid, delta)
        return True

    fake_session = MagicMock()
    mock_scope = MagicMock()
    mock_scope.__enter__.return_value = fake_session
    mock_scope.__exit__.return_value = None

    with patch("platform_v8.storage.db.session_scope", return_value=mock_scope), \
         patch("platform_v8.storage.repo.ShardRepo.by_workload", side_effect=fake_by_workload), \
         patch("platform_v8.storage.repo.ShardRepo.mark_done", side_effect=fake_mark_done), \
         patch("platform_v8.storage.repo.ShardRepo.mark_failed", side_effect=fake_mark_failed), \
         patch("platform_v8.storage.repo.WorkloadRepo.update_status", side_effect=fake_update_status), \
         patch("platform_v8.storage.repo.WorkloadRepo.add_spent", side_effect=fake_add_spent):
        await _close_workload_for_session(
            sess, revenue_edg=0.0, reason="worker_offline", error="target_unreachable",
        )

    # mark_failed 被调 1 次
    assert len(captured["shards_failed"]) == 1
    assert captured["shards_failed"][0][0] == "shard_xyz"
    assert "target_unreachable" in captured["shards_failed"][0][1]
    # mark_done 不被调
    assert len(captured["shards_done"]) == 0
    # workload → FAILED
    from platform_v8.core import WorkloadStatus
    assert captured["wl_status"] is not None
    wid, status, kwargs = captured["wl_status"]
    assert status == WorkloadStatus.FAILED
    assert kwargs["failed_shards"] == 1
    assert kwargs["completed_shards"] == 0
    assert "target_unreachable" in kwargs["error"]
    # revenue=0 · spent 不该被调
    assert captured["spent"] is None


# ════════════════════════════════════════════════════════════════
# 5 · workloads_t 有 spent 列 (v8_012)
# ════════════════════════════════════════════════════════════════
def test_workloads_table_has_spent_column():
    from platform_v8.storage.repo import workloads_t
    cols = [c.name for c in workloads_t.columns]
    assert "spent" in cols, "v8_012 没把 spent 列加进 workloads_t · 业务会报 PG 列不存在"
    assert "budget" in cols  # 老字段不能丢


# ════════════════════════════════════════════════════════════════
# 6 · Workload dataclass 有 spent 字段
# ════════════════════════════════════════════════════════════════
def test_workload_dataclass_has_spent_field():
    from platform_v8.core import Workload
    from decimal import Decimal
    wl = Workload()
    assert hasattr(wl, "spent")
    assert wl.spent == Decimal("0")


# ════════════════════════════════════════════════════════════════
# 7 · WorkloadRepo.add_spent 存在
# ════════════════════════════════════════════════════════════════
def test_workload_repo_has_add_spent():
    from platform_v8.storage.repo import WorkloadRepo
    assert callable(getattr(WorkloadRepo, "add_spent", None)), \
        "WorkloadRepo.add_spent 缺失 · W3 session close 累加靠它"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
