"""
Workload · 任务 (主表)

替代: sv_tasks + sv_v2_jobs + sv_task_jobs
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any
import uuid

from .enums import WorkloadStatus, TaskKind, Runtime


@dataclass
class WorkloadSpec:
    """任务规格 · 提交时定义 · 之后不变"""
    kind: TaskKind = TaskKind.DATA_PROCESSING
    task_type: str = ""                         # 业务类型 (e.g. 'image_resize')
    runtime: Runtime = Runtime.PYTHON3
    code_url: str = ""                          # 代码 URL (或空 → inline_input only)

    # ── 输入数据 (2026-05-18 扩展 · 配合 task_registry.InputKind) ──
    # input_kind 决定哪个字段被用 · 没指定时根据 task_type 推断 (查 task_registry)
    #   inline       → inline_input (str)
    #   single_file  → input_ref (1 个 OSS URL)
    #   multi_file   → input_refs (N 个 OSS URL)
    #   archive      → input_ref (1 个 zip/tar URL)
    #   stream       → input_ref (m3u8 URL)
    #   params_only  → 都不读 · 只用 params
    input_kind: str = ""                        # InputKind · 空 = 自动推断
    input_ref: str = ""                         # 主 URL (single_file / archive / stream)
    input_refs: list[str] = field(default_factory=list)  # 多 URL (multi_file)
    inline_input: str | None = None             # inline 内容

    params: dict[str, Any] = field(default_factory=dict)
    media_input: dict[str, Any] | None = None
    media_profile: dict[str, Any] = field(default_factory=dict)  # server-resolved immutable execution terms
    max_shards: int = 1                         # 最多切几片 (受 task_registry.max_shards_limit 约束)
    # Registry-resolved settlement gate.  Submitters cannot override it.
    verification_policy: str = "quarantine"     # semantic / artifact / quarantine
    # 2026-05-18 · 冗余派发 (anti_cheat)
    # redundancy_factor=1 表示不冗余 (默认) · >=2 表示同片派 N 个节点 · finalize 时多数派比对
    # 高敏感任务设 3 (典型: 关键业务 / 高额预算 / 抽样审计)
    redundancy_factor: int = 1
    timeout_s: int = 300
    requirements: dict[str, Any] = field(default_factory=dict)  # min_cpu/min_mem/etc
    # R7 · Runtime 执行模型（legacy_script | runtime_v2）；空=legacy
    execution_model: str = ""


@dataclass
class WorkloadResult:
    """任务结果 · 聚合后产生"""
    output_ref: str = ""                        # 结果数据引用
    inline_output: str | None = None
    summary: str = ""
    elapsed_ms: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Workload:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    owner_id: int = 0
    name: str = ""
    spec: WorkloadSpec = field(default_factory=WorkloadSpec)
    status: WorkloadStatus = WorkloadStatus.CREATED
    progress: float = 0.0                       # 0.0 - 1.0
    total_shards: int = 0
    completed_shards: int = 0
    failed_shards: int = 0
    result: WorkloadResult | None = None
    budget: Decimal = field(default_factory=lambda: Decimal("0"))
    # v8_012 (2026-05-26) · 累加结算 · session 业务每次 close 累加 · oneshot 业务任务结束写一次
    # admin/客户/business 都用 budget - spent 算余额
    spent: Decimal = field(default_factory=lambda: Decimal("0"))
    error: str = ""
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
    started_at: datetime | None = None
    completed_at: datetime | None = None

    @property
    def is_terminal(self) -> bool:
        return self.status in (
            WorkloadStatus.DONE,
            WorkloadStatus.QUARANTINED,
            WorkloadStatus.FAILED,
            WorkloadStatus.CANCELLED,
        )

    @property
    def is_waiting(self) -> bool:
        return self.status == WorkloadStatus.WAITING_FOR_WORKERS
