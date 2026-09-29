"""
W1-3/W1-6 · engine/pull_dispatcher.py 单测

覆盖:
  1. install/uninstall 注册到 frame_router
  2. assign_pull 调 ShardRepo.lease_pending_pull · 转 ShardAssignPayload
  3. assign_pull · ShardRepo 返空 (PENDING 池空) · 返空 list
  4. _on_pull_request handler 收 PullRequest · 发 PullAssign 给 worker
  5. _on_pull_request · push 失败时释放 lease

跑法:
  PYTHONPATH=... pytest platform_v8/tests/engine/test_pull_dispatcher.py -v
"""
from __future__ import annotations
import asyncio
import json
import sys
import uuid
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.core import Shard, ShardMode, ShardStatus, Workload, WorkloadSpec
from platform_v8.core.enums import WorkloadStatus, Runtime
from platform_v8.engine import frame_router, pull_dispatcher
from platform_v8.protocol import ws_schema as wsp
from platform_v8.services import oss_provider


# ─────────── helpers ───────────
def _mk_shard(workload_id: str, idx: int = 0, mode: ShardMode = ShardMode.PULL) -> Shard:
    return Shard(
        id=str(uuid.uuid4()),
        workload_id=workload_id,
        index=idx,
        total=3,
        status=ShardStatus.LEASED,
        mode=mode,
        input_ref="",
        attempts=1,
        max_attempts=3,
        metadata={"params": {"url": f"https://example.com/{idx}"}},
    )


def _mk_workload(wid: str = None, owner_id: int = 100,
                 task_type: str = "crawl_url_fetch", budget: float = 1.0) -> Workload:
    return Workload(
        id=wid or str(uuid.uuid4()),
        owner_id=owner_id,
        name="测试 crawl",
        status=WorkloadStatus.RUNNING,
        spec=WorkloadSpec(
            task_type=task_type,
            runtime=Runtime.PYTHON3,
            code_url="https://example.com/crawl.py",
            input_kind="params_only",
            params={"global_setting": "x"},
            timeout_s=300,
        ),
        budget=budget,
        created_at=datetime.utcnow(),
    )


@pytest.fixture(autouse=True)
def _clean_router(monkeypatch):
    class _Provider:
        def presign_get(self, key, *, expires):
            return {"url": f"https://oss.example.test/{key}?signed=1"}

    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Provider())
    frame_router.clear_all()
    pull_dispatcher._installed = False
    yield
    frame_router.clear_all()
    pull_dispatcher._installed = False


# ─────────── 用例 1 · install 注册 handler ───────────
def test_install_registers_pull_handler():
    assert "pull_request" not in frame_router.list_handlers()
    pull_dispatcher.install()
    assert "pull_request" in frame_router.list_handlers()


# ─────────── 用例 2 · install 幂等 ───────────
def test_install_idempotent():
    pull_dispatcher.install()
    pull_dispatcher.install()
    pull_dispatcher.install()
    assert frame_router.list_handlers().count("pull_request") == 1


# ─────────── 用例 3 · uninstall 清掉 ───────────
def test_uninstall_clears():
    pull_dispatcher.install()
    pull_dispatcher.uninstall()
    assert "pull_request" not in frame_router.list_handlers()


# ─────────── 用例 4 · assign_pull · 有 PENDING shard ───────────
def test_assign_pull_returns_payloads():
    """ShardRepo 返 2 个 shard · assign_pull 应转成 2 个 ShardAssignPayload"""
    wl = _mk_workload()
    shards = [_mk_shard(wl.id, idx=i) for i in range(2)]

    # mock 全套 DB 操作
    mock_repo_lease = MagicMock(return_value=shards)
    mock_wl_by_id = MagicMock(return_value=wl)
    mock_acc_by_id = MagicMock(return_value=MagicMock(username="test_user", avatar_url=""))
    mock_release = MagicMock(return_value=True)

    with patch("platform_v8.engine.pull_dispatcher.ShardRepo", create=True) as _mock_repo, \
         patch("platform_v8.engine.pull_dispatcher.WorkloadRepo", create=True) as _mock_wl, \
         patch("platform_v8.engine.pull_dispatcher.AccountRepo", create=True) as _mock_acc, \
         patch("platform_v8.engine.pull_dispatcher.db_mod", create=True) as _mock_db:
        # 上面 patch 不会生效因为 pull_dispatcher 是用 from ... import 形式 in-function
        # 真实方案: patch import 源头
        pass

    # 真实 patch 方式 (in-function import)
    with patch("platform_v8.storage.repo.ShardRepo.lease_pending_pull", mock_repo_lease), \
         patch("platform_v8.storage.repo.WorkloadRepo.by_id", mock_wl_by_id), \
         patch("platform_v8.storage.repo.AccountRepo.by_id", mock_acc_by_id), \
         patch("platform_v8.storage.repo.ShardRepo.release_lease", mock_release):
        # session_scope 也要 mock (避免连 DB)
        from contextlib import contextmanager

        @contextmanager
        def _fake_scope():
            yield MagicMock()  # 假 session

        with patch("platform_v8.storage.db.session_scope", _fake_scope):
            result = asyncio.run(pull_dispatcher.assign_pull(
                worker_id="worker-1", max_count=5,
            ))

    assert len(result) == 2
    assert all(isinstance(p, wsp.ShardAssignPayload) for p in result)
    assert result[0].task_type == "crawl_url_fetch"
    assert result[0].workload_id == wl.id
    assert result[0].requester_name == "test_user"
    # reward = budget/total · budget=1.0 total=3 → ~0.333
    assert abs(result[0].reward - 1.0 / 3) < 1e-6
    lease_call = mock_repo_lease.call_args.kwargs
    assert lease_call["lease_seconds"] is None
    assert lease_call["lease_seconds_for"](shards[0]) == 345


# ─────────── 用例 5 · assign_pull · 空池返空 ───────────
def test_assign_pull_empty_pool_returns_empty():
    from contextlib import contextmanager

    @contextmanager
    def _fake_scope():
        yield MagicMock()

    with patch("platform_v8.storage.repo.ShardRepo.lease_pending_pull",
               MagicMock(return_value=[])), \
         patch("platform_v8.storage.db.session_scope", _fake_scope):
        result = asyncio.run(pull_dispatcher.assign_pull(
            worker_id="w", max_count=3,
        ))
    assert result == []


# ─────────── 用例 6 · _on_pull_request handler · 收 frame 发 PullAssign ───────────
def test_on_pull_request_sends_pull_assign():
    """模拟 ws 收到 PullRequest · 调 _on_pull_request · 验证发了 PullAssign 帧"""
    captured = {}

    async def fake_push(worker_id, frame_text, **kwargs):
        captured["worker_id"] = worker_id
        captured["frame"] = json.loads(frame_text)
        captured["source"] = kwargs.get("source")
        return True

    wl = _mk_workload()
    shards = [_mk_shard(wl.id, idx=0)]
    fake_payloads = [pull_dispatcher._shard_to_assign_payload(shards[0], wl, requester_name="u")]

    async def fake_assign(*, worker_id, max_count, task_type_filter, lease_seconds=120):
        return fake_payloads

    from contextlib import contextmanager

    @contextmanager
    def _fake_scope():
        yield MagicMock()

    confirmed: list[tuple[int, int]] = []

    def _confirm(_s, _sid, *, expected_worker_id, expected_attempt, lease_seconds):
        confirmed.append((expected_attempt, lease_seconds))
        return True

    with patch("platform_v8.engine.pull_dispatcher.assign_pull",
               new=AsyncMock(side_effect=fake_assign)), \
         patch("platform_v8.engine.broker.push_to_worker",
               new=AsyncMock(side_effect=fake_push)), \
         patch("platform_v8.storage.db.session_scope", _fake_scope), \
         patch("platform_v8.storage.repo.ShardRepo.confirm_lease_start",
               new=MagicMock(side_effect=_confirm)):
        req = wsp.PullRequest(payload=wsp.PullRequestPayload(
            max_count=3, task_type_filter=["crawl_url_fetch"],
        ))
        asyncio.run(pull_dispatcher._on_pull_request(req, "worker-x", 100))

    assert captured["worker_id"] == "worker-x"
    assert captured["source"] == "pull"
    f = captured["frame"]
    assert f["type"] == "pull_assign"
    assert len(f["payload"]["shards"]) == 1
    assert f["payload"]["shards"][0]["workload_id"] == wl.id
    assert confirmed == [(shards[0].attempts, 345)]


# ─────────── 用例 7 · _on_pull_request · push 失败时释放 lease ───────────
def test_on_pull_request_release_lease_on_push_fail():
    """节点掉线 · push PullAssign 失败 · 应释放所有 lease 回 PENDING"""
    wl = _mk_workload()
    shards = [_mk_shard(wl.id, idx=i) for i in range(2)]
    fake_payloads = [
        pull_dispatcher._shard_to_assign_payload(sh, wl, requester_name="u")
        for sh in shards
    ]

    released: list = []

    def fake_release(s, shard_id, *, expected_worker_id=None):
        released.append((shard_id, expected_worker_id))
        return True

    from contextlib import contextmanager

    @contextmanager
    def _fake_scope():
        yield MagicMock()

    async def fake_assign(*, worker_id, max_count, task_type_filter, lease_seconds=120):
        return fake_payloads

    with patch("platform_v8.engine.pull_dispatcher.assign_pull",
               new=AsyncMock(side_effect=fake_assign)), \
         patch("platform_v8.engine.broker.push_to_worker",
               new=AsyncMock(return_value=False)), \
         patch("platform_v8.storage.repo.ShardRepo.release_lease",
               new=MagicMock(side_effect=fake_release)), \
         patch("platform_v8.storage.db.session_scope", _fake_scope):
        req = wsp.PullRequest(payload=wsp.PullRequestPayload(max_count=2))
        asyncio.run(pull_dispatcher._on_pull_request(req, "worker-offline", 100))

    # 应释放 2 个 lease
    assert len(released) == 2
    assert all(wid == "worker-offline" for _, wid in released)


# ─────────── 用例 8 · _on_pull_request · max_count 硬上限 ───────────
def test_on_pull_request_clamps_max_count():
    """节点要 999 个 · server 应限制到 10"""
    captured_max = {}

    async def fake_assign(*, worker_id, max_count, task_type_filter, lease_seconds=120):
        captured_max["max_count"] = max_count
        return []

    with patch("platform_v8.engine.pull_dispatcher.assign_pull",
               new=AsyncMock(side_effect=fake_assign)), \
         patch("platform_v8.engine.broker.push_to_worker",
               new=AsyncMock(return_value=True)):
        req = wsp.PullRequest(payload=wsp.PullRequestPayload(max_count=999))
        asyncio.run(pull_dispatcher._on_pull_request(req, "w", 0))

    assert captured_max["max_count"] == 10


# ─────────── 用例 9 · _shard_to_assign_payload · 字段映射 ───────────
def test_shard_to_assign_payload_full_mapping():
    wl = _mk_workload(task_type="geo_query", budget=3.0)
    sh = _mk_shard(wl.id, idx=2)
    sh.total = 3
    sh.input_ref = "v8/account-100/input/key"
    sh.metadata = {
        "input_kind": "single_file",
        "input_refs": [
            "v8/account-100/input/a",
            "uploads/tenant_100/task_x/b",
        ],
        "slice_meta": {"page": 5},
        "params": {"query": "test"},
    }

    payload = pull_dispatcher._shard_to_assign_payload(
        sh, wl, requester_name="u1", created_at_ms=1234567890,
    )

    assert payload.shard_id == sh.id
    assert payload.workload_id == wl.id
    assert payload.index == 2
    assert payload.total == 3
    assert payload.task_type == "geo_query"
    assert payload.runtime == "python3"
    assert payload.input_ref.startswith("https://")
    assert all(ref.startswith("https://") for ref in payload.input_refs)
    assert payload.slice_meta == {"page": 5}
    assert payload.params == {"query": "test"}
    assert payload.reward == 1.0  # 3.0 / 3
    assert payload.requester_name == "u1"
    assert payload.created_at_ms == 1234567890


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
