"""运行时配套契约 (方案 B)

防止「只覆盖单个巨石文件」导致:
  - repo 缺类 → ImportError 整站挂
  - lifecycle / gateway / effective_task 签名不一致 → 任务卡 CREATED

CONTRACT_ID 必须与下列模块中的 RUNTIME_CONTRACT_ID 一致:
  - platform_v8.storage.repo
  - platform_v8.engine.lifecycle
  - platform_v8.engine.gateway
  - platform_v8.engine.effective_task

部署前请跑: scripts/ops/preflight_platform_v8.sh
"""
from __future__ import annotations

import inspect
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Bump this whenever engine/storage 跨文件契约变更；四文件需同步改 RUNTIME_CONTRACT_ID
CONTRACT_ID = "2026-08-13.delivery-evidence"

# developer / workloads 启动路径强依赖的 Repo 导出
REQUIRED_REPO_ATTRS: tuple[str, ...] = (
    "AccountRepo",
    "ApiKeyRepo",
    "AuditRepo",
    "DeveloperTaskRepo",
    "WorkloadRepo",
    "ShardRepo",
    "ResultVerificationRepo",
    "VerifierCircuitRepo",
    "LedgerRepo",
    "WorkerRepo",
    "AssignmentDeliveryRepo",
)

REQUIRED_SHARD_REPO_METHODS: tuple[str, ...] = (
    "touch_progress",
    "reclaim_active_if_unchanged",
    "begin_verification",
    "complete_verification",
    "fail_verification",
)

REQUIRED_RESULT_VERIFICATION_REPO_METHODS: tuple[str, ...] = (
    "claim_due_retries",
    "schedule_retry",
    "defer_retry",
    "mark_succeeded",
    "mark_failed",
)

REQUIRED_ASSIGNMENT_DELIVERY_REPO_METHODS: tuple[str, ...] = (
    "record_after_send",
    "get_current_for_connection",
    "has_unambiguous_current_delivery",
    "attempt_history_for_shard_worker",
    "cleanup_connection",
)

REQUIRED_OSS_PROVIDER_METHODS: tuple[str, ...] = (
    "iter_object",
    "write_stream",
    "copy_object",
)

REQUIRED_EFFECTIVE_TASK_ATTRS: tuple[str, ...] = (
    "soft_reclaim_dispatched_horizon_s",
    "soft_reclaim_running_horizon_s",
)

REQUIRED_LIFECYCLE_ATTRS: tuple[str, ...] = (
    "start",
    "init_engine",
    "_leader_job_dispatch",
    # api/app.py 的 shard.completed 订阅直接调它；缺失时事件回调只会静默
    # AttributeError（被 except 吞掉），残留 PENDING 退化成等 30s sweeper。
    # 2026-08-10 曾因文件级错配丢失 7 天未被发现，故列为必需。
    "on_shard_completed_redispatch",
    "select_steal_candidates",
    "select_race_candidates",
)

REQUIRED_GATEWAY_ATTRS: tuple[str, ...] = (
    "register_leader_job_handler",
    "publish_leader_job",
)


class RuntimeContractError(RuntimeError):
    """配套校验失败 · 应 fail-fast，避免半残调度扣钱。"""


def _require_attr(mod: Any, name: str, *, where: str) -> Any:
    if not hasattr(mod, name):
        raise RuntimeContractError(f"runtime_contract · {where} 缺少 {name}")
    return getattr(mod, name)


def _check_module_contract_id(mod: Any, *, where: str) -> None:
    got = getattr(mod, "RUNTIME_CONTRACT_ID", None)
    if got is None:
        raise RuntimeContractError(
            f"runtime_contract · {where} 未声明 RUNTIME_CONTRACT_ID "
            f"(期望 {CONTRACT_ID})"
        )
    if got != CONTRACT_ID:
        raise RuntimeContractError(
            f"runtime_contract · {where} RUNTIME_CONTRACT_ID={got!r} "
            f"!= 期望 {CONTRACT_ID!r} · 疑似文件级错配覆盖"
        )


def assert_runtime_contract(*, check_app_import: bool = False) -> dict[str, Any]:
    """校验 storage/engine 配套。失败抛 RuntimeContractError。

    check_app_import=True 时额外 import FastAPI app（部署 preflight 用，较慢）。
    """
    from platform_v8.engine import effective_task, gateway, lifecycle, task_registry
    from platform_v8.services.oss_provider import OSSProvider
    from platform_v8.storage import repo

    _check_module_contract_id(repo, where="storage.repo")
    _check_module_contract_id(lifecycle, where="engine.lifecycle")
    _check_module_contract_id(gateway, where="engine.gateway")
    _check_module_contract_id(effective_task, where="engine.effective_task")

    for name in REQUIRED_REPO_ATTRS:
        _require_attr(repo, name, where="storage.repo")

    shard_repo = _require_attr(repo, "ShardRepo", where="storage.repo")
    for name in REQUIRED_SHARD_REPO_METHODS:
        _require_attr(
            shard_repo,
            name,
            where=f"storage.repo.ShardRepo (reclaim-policy requires {name})",
        )

    verification_repo = _require_attr(
        repo, "ResultVerificationRepo", where="storage.repo"
    )
    for name in REQUIRED_RESULT_VERIFICATION_REPO_METHODS:
        _require_attr(
            verification_repo,
            name,
            where=(
                "storage.repo.ResultVerificationRepo "
                f"(settlement-safety requires {name})"
            ),
        )

    delivery_repo = _require_attr(
        repo, "AssignmentDeliveryRepo", where="storage.repo",
    )
    for name in REQUIRED_ASSIGNMENT_DELIVERY_REPO_METHODS:
        _require_attr(
            delivery_repo,
            name,
            where=(
                "storage.repo.AssignmentDeliveryRepo "
                f"(delivery-evidence requires {name})"
            ),
        )

    for name in REQUIRED_OSS_PROVIDER_METHODS:
        _require_attr(
            OSSProvider,
            name,
            where=(
                "services.oss_provider.OSSProvider "
                f"(legacy-normalizer requires {name})"
            ),
        )

    for name in REQUIRED_EFFECTIVE_TASK_ATTRS:
        _require_attr(
            effective_task,
            name,
            where=f"engine.effective_task (reclaim-policy requires {name})",
        )

    for name in REQUIRED_LIFECYCLE_ATTRS:
        _require_attr(lifecycle, name, where="engine.lifecycle")

    for name in REQUIRED_GATEWAY_ATTRS:
        _require_attr(gateway, name, where="engine.gateway")

    # gateway 以 3 参回调 leader job；lifecycle 处理器必须能接 (action, wid, payload?)
    dispatch = lifecycle._leader_job_dispatch
    params = list(inspect.signature(dispatch).parameters.values())
    if len(params) < 2:
        raise RuntimeContractError(
            "runtime_contract · lifecycle._leader_job_dispatch 参数过少 "
            f"(got {len(params)}, need >=2)"
        )
    archive_formats = sorted({
        archive_format
        for spec in task_registry.list_specs()
        for archive_format in spec.archive_formats
    })
    if (
        "7z" in archive_formats
        and not task_registry.archive_7z_runtime_ready()
    ):
        raise RuntimeContractError(
            "runtime_contract · registry 声明 7z，但 py7zr 运行时不可用"
        )

    report: dict[str, Any] = {
        "ok": True,
        "contract_id": CONTRACT_ID,
        "repo_attrs": list(REQUIRED_REPO_ATTRS),
        "shard_repo_methods": list(REQUIRED_SHARD_REPO_METHODS),
        "result_verification_repo_methods": list(
            REQUIRED_RESULT_VERIFICATION_REPO_METHODS
        ),
        "assignment_delivery_repo_methods": list(
            REQUIRED_ASSIGNMENT_DELIVERY_REPO_METHODS
        ),
        "oss_provider_methods": list(REQUIRED_OSS_PROVIDER_METHODS),
        "effective_task_attrs": list(REQUIRED_EFFECTIVE_TASK_ATTRS),
        "leader_job_params": [p.name for p in params],
        "archive_formats": archive_formats,
    }

    if check_app_import:
        # 完整加载路由（含 developer）· 部署脚本用
        from platform_v8.api.app import app  # noqa: F401

        report["app_import"] = True

    logger.info(
        "runtime_contract · OK id=%s leader_job_params=%s",
        CONTRACT_ID,
        report["leader_job_params"],
    )
    return report


def main() -> None:
    import json
    import sys

    try:
        full = "--full" in sys.argv
        report = assert_runtime_contract(check_app_import=full)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
