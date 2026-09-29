"""
/api/v8/users/ · 节点客户端 (personal) 用
提供:
  GET /me            → AccountSummary (含 total_earnings + completed_tasks)
  GET /me/v3-history → 节点 shard 历史 (cmd/reward/elapsed)
  GET /me/v3-earnings → 收益趋势 (按天聚合)
"""
from __future__ import annotations
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func, text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session, get_current_account
from platform_v8.core import Account
from platform_v8.storage.repo import ledger_t, workloads_t, shards_t, workers_t

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/users", tags=["users"])


# ════════════════════════════════════════════════════════════════════
# GET /me · 节点客户端首页用
# ════════════════════════════════════════════════════════════════════
@router.get("/me", summary="当前用户概要 (含累计收益 + 完成任务数)")
def get_me(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    # total_earnings: REWARD 类型 ledger 加和
    total_earnings = session.execute(
        select(func.coalesce(func.sum(ledger_t.c.amount), 0))
        .where(ledger_t.c.account_id == current.id)
        .where(ledger_t.c.type == "REWARD")
    ).scalar() or 0

    # completed_tasks: 该用户 owner 的节点完成的 shard 数
    # 先找该用户所有 worker_id · 再数 DONE shard
    worker_ids = [
        r[0] for r in session.execute(
            select(workers_t.c.id).where(workers_t.c.owner_id == current.id)
        ).fetchall()
    ]
    if worker_ids:
        completed_tasks = session.execute(
            select(func.count())
            .select_from(shards_t)
            .where(shards_t.c.worker_id.in_(worker_ids))
            .where(shards_t.c.status == "DONE")
        ).scalar() or 0
    else:
        completed_tasks = 0

    return {
        "id": current.id,
        "username": current.username,
        "email": current.email,
        "balance": float(current.balance),
        "total_earnings": round(float(total_earnings), 4),
        "completed_tasks": int(completed_tasks),
        "status": current.status.value if hasattr(current.status, "value") else str(current.status),
    }


# ════════════════════════════════════════════════════════════════════
# GET /me/v3-history · 节点客户端 HistoryPage
# ════════════════════════════════════════════════════════════════════
@router.get("/me/v3-history", summary="节点 shard 执行历史")
def get_my_history(
    limit: int = Query(default=20, ge=1, le=200),
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    worker_ids = [
        r[0] for r in session.execute(
            select(workers_t.c.id).where(workers_t.c.owner_id == current.id)
        ).fetchall()
    ]
    if not worker_ids:
        return {"total": 0, "items": []}

    # 查 shards (最新 N 条)
    rows = session.execute(
        select(shards_t)
        .where(shards_t.c.worker_id.in_(worker_ids))
        .order_by(shards_t.c.completed_at.desc().nullslast(),
                  shards_t.c.dispatched_at.desc().nullslast())
        .limit(limit)
    ).fetchall()

    # 转 item 格式 (兼容 Rust AccountSummary / MyHistoryItem)
    items = []
    for r in rows:
        # 从 workload 拿 task_type
        wl = session.execute(
            select(workloads_t.c.spec).where(workloads_t.c.id == r.workload_id)
        ).fetchone()
        spec = wl.spec if wl else {}
        if isinstance(spec, str):
            import json
            spec = json.loads(spec)

        items.append({
            "task_id": str(r.id),
            "node_id": str(r.worker_id or ""),
            "owner_id": current.id,
            "cmd": spec.get("task_type", ""),
            "reward": float(r.score or 0),
            "assigned_at": str(r.dispatched_at or ""),
            "completed_at": str(r.completed_at or ""),
            "status": str(r.status or ""),
            "elapsed_ms": int(r.elapsed_ms or 0),
            "output": str(r.output_ref or "")[:500],
            "error": str(r.error or ""),
        })

    return {"total": len(items), "items": items}


# ════════════════════════════════════════════════════════════════════
# GET /me/v3-earnings · 收益趋势 (EarningsChart)
# ════════════════════════════════════════════════════════════════════
@router.get("/me/v3-earnings", summary="收益趋势 (按天聚合)")
def get_my_earnings(
    days: int = Query(default=7, ge=1, le=90),
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    cutoff = datetime.utcnow() - timedelta(days=days)

    rows = session.execute(text("""
        SELECT DATE(created_at) as d,
               COALESCE(SUM(amount), 0)::float as earnings,
               COUNT(*)::int as cnt
        FROM we_ledger
        WHERE account_id = :uid AND type = 'REWARD'
          AND created_at >= :cutoff
        GROUP BY DATE(created_at)
        ORDER BY d
    """), {"uid": current.id, "cutoff": cutoff}).fetchall()

    series = [{"date": str(r.d), "earnings": round(r.earnings, 4), "count": r.cnt} for r in rows]
    return {"days": days, "series": series}
