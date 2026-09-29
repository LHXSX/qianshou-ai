"""
api/v8/admin_proxy.py · IP 代理池 admin API (W3-D3 · 2026-05-26)

路由前缀 /api/v8/admin/proxy
  GET  /stats                  当前活跃 session 数 + 总流量 + 在线节点
  GET  /sessions               近 N 条 session 审计记 (we_proxy_sessions)
  GET  /sessions/active        当前内存中活跃 session (含目标 + 客户 + 节点)
  GET  /blacklist              节点黑名单
  POST /blacklist/{worker_id}  加节点入黑名单 (admin 禁用)
  DELETE /blacklist/{worker_id} 移除节点黑名单
  GET  /revenue                平台 proxy 业务收入 (近 N 天)

注: 节点 0 补贴 (隐蔽业务) · 收入字段是平台净收
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session, get_admin_account
from platform_v8.core import Account
from platform_v8.services.proxy import gateway as pg

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/admin/proxy", tags=["admin-proxy"])


# ════════════════════════════════════════════════════════════════
# 全局状态
# ════════════════════════════════════════════════════════════════
@router.get("/stats")
def get_stats(_admin: Account = Depends(get_admin_account)) -> dict:
    """当前 proxy 状态 · 全局指标"""
    return pg.stats()


# ════════════════════════════════════════════════════════════════
# Session 列表 (内存中活跃)
# ════════════════════════════════════════════════════════════════
@router.get("/sessions/active")
def list_active_sessions(_admin: Account = Depends(get_admin_account)) -> list[dict]:
    """当前内存中活跃 session (实时 · 含目标 + 客户 + 节点)"""
    out: list[dict] = []
    import time as _t
    now = _t.time()
    for sid, sess in pg._sessions.items():
        if sess.closed:
            continue
        out.append({
            "session_id": sid,
            "client_id": sess.client_id,
            "worker_id": sess.worker_id,
            "target_host": sess.target_host,
            "target_port": sess.target_port,
            "use_tls": sess.use_tls,
            "bytes_up": sess.bytes_up,
            "bytes_down": sess.bytes_down,
            "started_at": sess.started_at,
            "duration_s": round(now - sess.started_at, 1),
            "idle_s": round(now - sess.last_active_at, 1),
        })
    out.sort(key=lambda r: r["started_at"], reverse=True)
    return out


# ════════════════════════════════════════════════════════════════
# Session 审计 (历史 · we_proxy_sessions 表)
# ════════════════════════════════════════════════════════════════
@router.get("/sessions")
def list_sessions_history(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    client_id: Optional[str] = None,
    worker_id: Optional[str] = None,
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """近 N 条 session 审计 (we_proxy_sessions 表) · 用于排查"""
    where = []
    params: dict = {"limit": limit, "offset": offset}
    if client_id:
        where.append("client_id = :client_id")
        params["client_id"] = client_id
    if worker_id:
        where.append("worker_id = :worker_id")
        params["worker_id"] = worker_id
    where_clause = ("WHERE " + " AND ".join(where)) if where else ""

    rows = s.execute(text(
        f"SELECT session_id, client_id, worker_id, target_host, target_port, "
        f"       bytes_up, bytes_down, duration_s, reason, error, "
        f"       started_at, closed_at "
        f"FROM we_proxy_sessions {where_clause} "
        f"ORDER BY closed_at DESC LIMIT :limit OFFSET :offset"
    ), params).mappings().all()

    total_row = s.execute(
        text(f"SELECT COUNT(*) AS c FROM we_proxy_sessions {where_clause}"),
        {k: v for k, v in params.items() if k not in ("limit", "offset")},
    ).first()
    total = int(total_row[0]) if total_row else 0

    items: list[dict] = []
    for r in rows:
        items.append({
            "session_id": r["session_id"],
            "client_id": r["client_id"],
            "worker_id": r["worker_id"],
            "target_host": r["target_host"],
            "target_port": r["target_port"],
            "bytes_up": r["bytes_up"],
            "bytes_down": r["bytes_down"],
            "duration_s": r["duration_s"],
            "reason": r["reason"],
            "error": r["error"],
            "started_at": r["started_at"].isoformat() if r["started_at"] else None,
            "closed_at": r["closed_at"].isoformat() if r["closed_at"] else None,
        })
    return {"items": items, "total": total}


# ════════════════════════════════════════════════════════════════
# 黑名单
# ════════════════════════════════════════════════════════════════
@router.get("/blacklist")
def get_blacklist(_admin: Account = Depends(get_admin_account)) -> dict:
    return {"workers": pg.blacklist_list()}


@router.post("/blacklist/{worker_id}")
def add_to_blacklist(
    worker_id: str,
    _admin: Account = Depends(get_admin_account),
) -> dict:
    if not worker_id:
        raise HTTPException(status_code=400, detail="worker_id required")
    pg.blacklist_add(worker_id)
    return {"ok": True, "workers": pg.blacklist_list()}


@router.delete("/blacklist/{worker_id}")
def remove_from_blacklist(
    worker_id: str,
    _admin: Account = Depends(get_admin_account),
) -> dict:
    pg.blacklist_remove(worker_id)
    return {"ok": True, "workers": pg.blacklist_list()}


# ════════════════════════════════════════════════════════════════
# 收入 (we_platform_revenue 表 · proxy_revenue 业务线)
# ════════════════════════════════════════════════════════════════
@router.get("/revenue")
def get_revenue(
    days: int = Query(7, ge=1, le=365),
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """近 N 天 proxy 业务平台收入 (按天)"""
    # we_proxy_sessions 是 session 维度 · 实时算法: SUM(bytes) * 单价
    # MVP 直接从审计表算 · 不依赖 we_platform_revenue (那是 ledger 累计)
    rows = s.execute(text(
        "SELECT DATE(closed_at) AS day, "
        "       COUNT(*) AS sessions, "
        "       SUM(bytes_up) AS bytes_up, "
        "       SUM(bytes_down) AS bytes_down, "
        "       SUM(duration_s) AS duration_s "
        "FROM we_proxy_sessions "
        "WHERE closed_at >= NOW() - INTERVAL :days DAY "
        "GROUP BY DATE(closed_at) "
        "ORDER BY day DESC"
    ), {"days": days}).mappings().all()

    days_out: list[dict] = []
    total_sessions = 0
    total_bytes = 0
    for r in rows:
        bup = int(r["bytes_up"] or 0)
        bdn = int(r["bytes_down"] or 0)
        days_out.append({
            "day": r["day"].isoformat() if r["day"] else None,
            "sessions": int(r["sessions"] or 0),
            "bytes_up": bup,
            "bytes_down": bdn,
            "bytes_total": bup + bdn,
            "duration_s": int(r["duration_s"] or 0),
        })
        total_sessions += int(r["sessions"] or 0)
        total_bytes += bup + bdn

    return {
        "days": days_out,
        "summary": {
            "total_sessions": total_sessions,
            "total_bytes": total_bytes,
            "days_range": days,
        },
    }


# ════════════════════════════════════════════════════════════════
# W5-phase2 · ledger 三方分账报表
# ════════════════════════════════════════════════════════════════
@router.get("/ledger")
def get_proxy_ledger(
    days: int = Query(7, ge=1, le=90),
    limit: int = Query(200, ge=1, le=2000),
    _admin: Account = Depends(get_admin_account),
    s: Session = Depends(get_session),
) -> dict:
    """近 N 天 proxy 业务 ledger 三方分账明细 + 汇总

    数据源: we_ledger WHERE workload_id LIKE 'proxy_%'
    返:
      - by_type: 按类型汇总 (ESCROW_HOLD 客户扣 / REWARD 节点拿 / PLATFORM_FEE 平台抽)
      - days: 按天分桶
      - recent: 近 N 条明细 (含 account / type / amount / workload_id)
    """
    # 1. 按类型汇总
    by_type_rows = s.execute(text(
        "SELECT type, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total "
        "FROM we_ledger "
        "WHERE workload_id LIKE 'proxy_%' "
        "  AND created_at >= NOW() - (:days::int * INTERVAL '1 day') "
        "GROUP BY type "
        "ORDER BY type"
    ), {"days": days}).mappings().all()

    by_type: dict = {}
    for r in by_type_rows:
        by_type[r["type"]] = {
            "count": int(r["n"] or 0),
            "total": float(r["total"] or 0),
        }

    # 2. 按天汇总 (按 type 拆列)
    by_day_rows = s.execute(text(
        "SELECT DATE(created_at) AS day, type, "
        "       COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total "
        "FROM we_ledger "
        "WHERE workload_id LIKE 'proxy_%' "
        "  AND created_at >= NOW() - (:days::int * INTERVAL '1 day') "
        "GROUP BY DATE(created_at), type "
        "ORDER BY day DESC, type"
    ), {"days": days}).mappings().all()

    days_map: dict = {}
    for r in by_day_rows:
        day_key = r["day"].isoformat() if r["day"] else "unknown"
        if day_key not in days_map:
            days_map[day_key] = {"day": day_key, "by_type": {}}
        days_map[day_key]["by_type"][r["type"]] = {
            "count": int(r["n"] or 0),
            "total": float(r["total"] or 0),
        }
    days_list = sorted(days_map.values(), key=lambda x: x["day"], reverse=True)

    # 3. 近 N 条明细
    recent_rows = s.execute(text(
        "SELECT l.id, l.account_id, l.type, l.amount, l.workload_id, "
        "       l.shard_id, l.note, l.created_at, a.username "
        "FROM we_ledger l "
        "LEFT JOIN we_accounts a ON a.id = l.account_id "
        "WHERE l.workload_id LIKE 'proxy_%' "
        "ORDER BY l.created_at DESC "
        "LIMIT :lim"
    ), {"lim": limit}).mappings().all()

    recent: list = []
    for r in recent_rows:
        recent.append({
            "id": r["id"],
            "account_id": int(r["account_id"] or 0),
            "username": r["username"] or "",
            "type": r["type"],
            "amount": float(r["amount"] or 0),
            "workload_id": r["workload_id"],
            "shard_id": r["shard_id"],
            "note": r["note"] or "",
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        })

    return {
        "by_type": by_type,
        "days": days_list,
        "recent": recent,
        "config": {
            "platform_fee_pct": float(pg.PROXY_PLATFORM_FEE_PCT),
            "platform_account_id": pg.PROXY_PLATFORM_ACCOUNT_ID,
            "min_client_balance": float(pg.PROXY_MIN_CLIENT_BALANCE),
        },
    }
