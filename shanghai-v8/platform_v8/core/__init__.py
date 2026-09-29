"""
Core · 平台 v8 核心 entity (纯数据 · 无外部依赖)

5 大 entity + 所有 enum · 全平台共用。
"""
from .enums import (
    WorkloadStatus,
    ShardStatus,
    ShardMode,
    WorkerStatus,
    AccountRole,
    AccountStatus,
    LedgerType,
    TaskKind,
    Runtime,
    AuditAction,
)
from .account import Account
from .worker import Worker, WorkerCapabilities
from .workload import Workload, WorkloadSpec, WorkloadResult
from .shard import Shard
from .ledger import LedgerEntry
from .assignment_delivery import AssignmentDelivery

__all__ = [
    # entity
    "Account",
    "Worker",
    "WorkerCapabilities",
    "Workload",
    "WorkloadSpec",
    "WorkloadResult",
    "Shard",
    "LedgerEntry",
    "AssignmentDelivery",
    # enums
    "WorkloadStatus",
    "ShardStatus",
    "ShardMode",
    "WorkerStatus",
    "AccountRole",
    "AccountStatus",
    "LedgerType",
    "TaskKind",
    "Runtime",
    "AuditAction",
]
