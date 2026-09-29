"""runtime_contract 单元测试 · 无 DB"""
from __future__ import annotations

import pytest

from platform_v8 import runtime_contract as rc


def test_contract_id_non_empty() -> None:
    assert rc.CONTRACT_ID
    assert "DeveloperTaskRepo" in rc.REQUIRED_REPO_ATTRS
    assert "touch_progress" in rc.REQUIRED_SHARD_REPO_METHODS
    assert "reclaim_active_if_unchanged" in rc.REQUIRED_SHARD_REPO_METHODS
    assert {
        "soft_reclaim_dispatched_horizon_s",
        "soft_reclaim_running_horizon_s",
    }.issubset(rc.REQUIRED_EFFECTIVE_TASK_ATTRS)


def test_assert_runtime_contract_passes_on_current_tree() -> None:
    report = rc.assert_runtime_contract(check_app_import=False)
    assert report["ok"] is True
    assert report["contract_id"] == rc.CONTRACT_ID
    assert "action" in report["leader_job_params"]
    assert "workload_id" in report["leader_job_params"]


def test_assert_detects_missing_repo_attr(monkeypatch: pytest.MonkeyPatch) -> None:
    from platform_v8.storage import repo

    monkeypatch.setattr(rc, "REQUIRED_REPO_ATTRS", ("DeveloperTaskRepo",))
    monkeypatch.delattr(repo, "DeveloperTaskRepo", raising=True)

    with pytest.raises(rc.RuntimeContractError, match="DeveloperTaskRepo"):
        rc.assert_runtime_contract(check_app_import=False)


def test_assert_detects_contract_id_mismatch(monkeypatch: pytest.MonkeyPatch) -> None:
    from platform_v8.storage import repo

    monkeypatch.setattr(repo, "RUNTIME_CONTRACT_ID", "wrong-id")
    with pytest.raises(rc.RuntimeContractError, match="RUNTIME_CONTRACT_ID"):
        rc.assert_runtime_contract(check_app_import=False)


def test_assert_detects_missing_reclaim_policy_method(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from platform_v8.storage.repo import ShardRepo

    monkeypatch.delattr(ShardRepo, "touch_progress", raising=True)
    with pytest.raises(
        rc.RuntimeContractError,
        match="reclaim-policy requires touch_progress",
    ):
        rc.assert_runtime_contract(check_app_import=False)


def test_realtime_redispatch_attrs_are_required() -> None:
    """app.py 的 shard.completed 订阅依赖这几个属性 · 必须在必需清单里。"""
    for name in (
        "on_shard_completed_redispatch",
        "select_steal_candidates",
        "select_race_candidates",
    ):
        assert name in rc.REQUIRED_LIFECYCLE_ATTRS


def test_assert_detects_missing_realtime_redispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """回归 2026-08-10 事故: lifecycle 缺实时重派入口时 preflight 必须失败,
    而不是等到运行期在事件回调里静默 AttributeError。"""
    from platform_v8.engine import lifecycle

    monkeypatch.delattr(lifecycle, "on_shard_completed_redispatch", raising=True)
    with pytest.raises(rc.RuntimeContractError, match="on_shard_completed_redispatch"):
        rc.assert_runtime_contract(check_app_import=False)


def test_assert_rejects_declared_7z_without_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from types import SimpleNamespace
    from platform_v8.engine import task_registry

    monkeypatch.setattr(
        task_registry,
        "list_specs",
        lambda: [SimpleNamespace(archive_formats=("zip", "7z"))],
    )
    monkeypatch.setattr(
        task_registry,
        "archive_7z_runtime_ready",
        lambda: False,
    )

    with pytest.raises(rc.RuntimeContractError, match="py7zr"):
        rc.assert_runtime_contract(check_app_import=False)
