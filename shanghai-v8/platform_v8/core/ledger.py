"""
Ledger · 账本 (escrow + transactions + settlements 三合一)

替代: sv_escrow + sv_transactions + sv_settlements + sv_node_reward
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any
import uuid

from .enums import LedgerType


@dataclass
class LedgerEntry:
    """
    账本一条 (append-only · 不修改 · 不删除)

    所有钱的流动都是一条 LedgerEntry · 通过 idempotent_key 防重复写。
    """
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    account_id: int = 0                         # 哪个账号的钱在动
    type: LedgerType = LedgerType.ESCROW_HOLD
    amount: Decimal = field(default_factory=lambda: Decimal("0"))  # 正数 = 入账 · 负数 = 出账
    currency: str = "CNY"
    workload_id: str | None = None              # 关联任务 (可能 None)
    shard_id: str | None = None                 # 关联分片 (可能 None)
    # QS-19 · 契约 ledger.beneficiary；可空 = 旧行/未点名。不进 idempotent_key。
    basis: str | None = None                    # node_compute | platform_llm_forward | platform_relay | none
    worker_id: str | None = None                # 实际干活的节点；平台抽成/渠道分润为 None
    idempotent_key: str = ""                    # 防重复键 (e.g. "escrow:workload_id")
    note: str = ""                              # 人类可读说明
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=datetime.utcnow)

    @property
    def is_debit(self) -> bool:
        """是否扣账 (出账)"""
        return self.amount < 0

    @property
    def is_credit(self) -> bool:
        """是否入账"""
        return self.amount > 0
