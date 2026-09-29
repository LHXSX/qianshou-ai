"""
结算业务 · withdraw + daily report

设计要点 (考虑全链路):
  1. withdraw_request: 用户提现 (复用 ledger_svc.withdraw · 加业务校验)
  2. daily_report: 当日汇总 (统计平台收入/节点收入/任务数) → 写 we_kv
  3. 跟 link 4 ledger 模块互补 · link 4 是"动钱" · 这里是"算汇总"
"""
from __future__ import annotations
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session
from sqlalchemy import select, func, and_

from platform_v8.core import LedgerType, AuditAction
from platform_v8.storage.repo import LedgerRepo, AuditRepo, ledger_t, kv_t
from platform_v8.services.economy import ledger as ledger_svc

logger = logging.getLogger(__name__)


class WithdrawError(Exception):
    pass


@dataclass
class WithdrawInput:
    account_id: int
    amount: Decimal
    note: str = ""
    trace_id: str | None = None


def request_withdraw(s: Session, inp: WithdrawInput) -> dict:
    """
    用户提现请求

    校验:
      - amount > 0
      - balance >= amount (ledger_svc.withdraw 内部检查)
      - 限额 (单日 / 单笔 · 这里先简化)
    """
    if inp.amount <= 0:
        raise WithdrawError("提现金额必须 > 0")

    idem = f"withdraw:{inp.account_id}:{uuid.uuid4().hex}"
    try:
        entry = ledger_svc.withdraw(
            s,
            account_id=inp.account_id,
            amount=inp.amount,
            idempotent_key=idem,
            note=inp.note or "用户提现",
        )
    except ValueError as exc:
        raise WithdrawError(str(exc))

    AuditRepo.write(
        s,
        action="withdraw.request",
        actor_account_id=inp.account_id,
        actor_kind="user",
        target_kind="ledger",
        target_id=entry.id,
        trace_id=inp.trace_id,
        detail={"amount": str(inp.amount)},
    )

    logger.info("settlement.withdraw · account=%s amount=%s", inp.account_id, inp.amount)
    return {
        "ledger_id": entry.id,
        "account_id": inp.account_id,
        "amount": str(inp.amount),
        "idempotent_key": idem,
    }


# ════════════════════════════════════════════════════════════════════
# daily_report · 按天汇总 ledger
# ════════════════════════════════════════════════════════════════════
def generate_daily_report(s: Session, day: date) -> dict:
    """
    生成某天的汇总报告 · 写入 we_kv (key = daily_report:YYYY-MM-DD)

    汇总指标:
      - 当日总成交 (workload reward 总和)
      - 平台手续费 (PLATFORM_FEE 总和 · 链路 6 后扩)
      - 各类型 ledger 计数 + 金额
      - top N worker_owner (按 reward 排序 · 链路 6 后扩)
    """
    start = datetime.combine(day, datetime.min.time())
    end = datetime.combine(day, datetime.max.time())

    rows = s.execute(
        select(ledger_t.c.type,
               func.count().label("cnt"),
               func.coalesce(func.sum(ledger_t.c.amount), 0).label("total"))
        .where(and_(ledger_t.c.created_at >= start,
                    ledger_t.c.created_at <= end))
        .group_by(ledger_t.c.type)
    ).all()

    by_type: dict[str, dict[str, Any]] = {}
    for r in rows:
        by_type[r.type] = {"count": r.cnt, "total": str(r.total)}

    reward_total = sum(
        Decimal(by_type[k]["total"]) for k in by_type if k == LedgerType.REWARD.value
    )
    refund_total = sum(
        Decimal(by_type[k]["total"]) for k in by_type if k == LedgerType.REFUND.value
    )

    report = {
        "date": day.isoformat(),
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "by_type": by_type,
        "reward_total": str(reward_total),
        "refund_total": str(refund_total),
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }

    # 写入 we_kv
    key = f"daily_report:{day.isoformat()}"
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert
    from sqlalchemy import insert as core_insert

    # 简化的 upsert: 先删再插
    s.execute(kv_t.delete().where(kv_t.c.k == key))
    s.execute(core_insert(kv_t).values(k=key, v=report, updated_at=datetime.utcnow()))

    logger.info("settlement.daily_report · day=%s rewards=%s refunds=%s",
                day.isoformat(), reward_total, refund_total)
    return report


def get_daily_report(s: Session, day: date) -> dict | None:
    """读已生成的报告"""
    key = f"daily_report:{day.isoformat()}"
    row = s.execute(select(kv_t).where(kv_t.c.k == key)).one_or_none()
    if row is None:
        return None
    v = row.v
    if isinstance(v, str):
        import json
        v = json.loads(v)
    return v
