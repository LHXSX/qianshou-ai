"""
Dashboard 聚合指标

设计要点:
  - 给 admin 前端 一目了然的指标
  - 用 SQL 聚合查 · 不 cache (实时数据)
  - 后续可以加 Redis cache TTL 60s · 抗高 QPS
"""
from __future__ import annotations
from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from platform_v8.storage.repo import (
    accounts_t, workloads_t, workers_t, shards_t, ledger_t,
)


def get_dashboard(s: Session) -> dict:
    """全平台关键指标"""
    now = datetime.utcnow()
    day_ago = now - timedelta(days=1)

    # 账号统计
    total_accounts = s.execute(select(func.count()).select_from(accounts_t)).scalar_one()
    by_role = {
        r.role: r.cnt for r in s.execute(
            select(accounts_t.c.role, func.count().label("cnt")).group_by(accounts_t.c.role)
        ).all()
    }

    # 任务统计
    total_workloads = s.execute(select(func.count()).select_from(workloads_t)).scalar_one()
    by_status = {
        r.status: r.cnt for r in s.execute(
            select(workloads_t.c.status, func.count().label("cnt"))
            .group_by(workloads_t.c.status)
        ).all()
    }
    workloads_24h = s.execute(
        select(func.count()).where(workloads_t.c.created_at >= day_ago)
    ).scalar_one()

    # 节点统计
    total_workers = s.execute(select(func.count()).select_from(workers_t)).scalar_one()
    online_workers = s.execute(
        select(func.count()).where(workers_t.c.status.in_(["ONLINE", "BUSY"]))
        .where(workers_t.c.last_seen >= now - timedelta(seconds=60))
    ).scalar_one()

    # 经济统计
    total_volume = s.execute(
        select(func.coalesce(func.sum(ledger_t.c.amount), 0))
        .where(ledger_t.c.type == "REWARD")
    ).scalar_one()
    volume_24h = s.execute(
        select(func.coalesce(func.sum(ledger_t.c.amount), 0))
        .where(ledger_t.c.type == "REWARD")
        .where(ledger_t.c.created_at >= day_ago)
    ).scalar_one()

    # shard 完成统计
    total_shards = s.execute(select(func.count()).select_from(shards_t)).scalar_one()
    done_shards = s.execute(
        select(func.count()).where(shards_t.c.status == "DONE")
    ).scalar_one()

    return {
        "timestamp": now.isoformat() + "Z",
        "accounts": {
            "total": total_accounts,
            "by_role": by_role,
        },
        "workloads": {
            "total": total_workloads,
            "by_status": by_status,
            "last_24h": workloads_24h,
        },
        "workers": {
            "total": total_workers,
            "online_now": online_workers,
        },
        "shards": {
            "total": total_shards,
            "done": done_shards,
        },
        "economy": {
            "total_volume": str(total_volume),
            "volume_24h": str(volume_24h),
            "currency": "CNY",
        },
    }
