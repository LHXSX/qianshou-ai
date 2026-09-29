"""
Shard · 分片 (一个 workload 可切多个 shard · 派给不同 worker 并行跑)

替代: sv_subtasks + sv_v2_subtasks
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
import uuid

from .enums import ShardStatus, ShardMode


@dataclass
class Shard:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    workload_id: str = ""                       # 反向引用
    index: int = 0                              # 在 workload 内的序号 (0-based)
    total: int = 1                              # workload 总分片数
    status: ShardStatus = ShardStatus.PENDING
    worker_id: str | None = None                # 派给哪个 worker (None = 未派)
    input_ref: str = ""                         # 这一片的输入引用
    output_ref: str | None = None               # worker 提交的结果引用
    attempts: int = 0                           # 已尝试次数 (失败重试用) · 派发触达，语义不变
    max_attempts: int = 10                      # 换机/重派上限 (默认 10) · 只约束 exec_attempts
    dispatch_attempts: int | None = None        # W-05 · 派发触达；准入拒收/租约回退/投递失败只加这里
    exec_attempts: int | None = None            # W-05 · 真实开跑次数；NULL = 从未开跑
    score: float = 0.0                          # 调度时的打分
    predicted_latency_ms: float | None = None
    predicted_cost: float | None = None
    error: str = ""
    dispatched_at: datetime | None = None
    started_at: datetime | None = None
    progress_at: datetime | None = None              # 最近一次可信进度/心跳落库时间
    completed_at: datetime | None = None
    elapsed_ms: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    # ── W1 (2026-05-26) · 统一引擎 · 调度模式 + PULL 模式 lease 字段 ──
    mode: ShardMode = ShardMode.ONESHOT          # 默认 oneshot 向后兼容现有 53 task
    lease_by_node: str | None = None             # PULL 模式 · 哪个节点 lease 走的 (worker_id)
    lease_expires_at: datetime | None = None     # PULL 模式 · lease 过期时刻 · 超时未跑则回 PENDING

    @property
    def is_terminal(self) -> bool:
        return self.status in (
            ShardStatus.DONE,
            ShardStatus.FAILED,
            ShardStatus.CANCELLED,
        )

    def exec_attempts_used(self) -> int:
        """How many real starts count against `max_attempts`. NULL means none."""
        return int(self.exec_attempts or 0)

    @property
    def can_retry(self) -> bool:
        return self.status == ShardStatus.FAILED and self.exec_attempts_used() < self.max_attempts
