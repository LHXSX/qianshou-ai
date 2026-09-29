"""
管理员前端路由 — /api/v8/*

设计原则:
  · 全部使用 v8 表 (we_workloads / we_shards / we_workers / we_accounts / we_ledger / we_audit)
  · 不再访问任何 sv_* 老表
  · 所有路由都需要 admin 身份 (get_admin_account 依赖注入)
"""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func, text, update, delete, insert
from sqlalchemy.orm import Session
import json
import bcrypt

from platform_v8.api.deps import get_session, get_admin_account
from platform_v8.core import Account
from platform_v8.storage.repo import accounts_t, workers_t, workloads_t, ledger_t
from platform_v8.services.workloads.cancel import CancelError, cancel_workload as cancel_workload_service

router = APIRouter(prefix="/api/v8", tags=["admin-fe"])


# ═══════════════════════════ Dashboard ═══════════════════════════

@router.get("/dashboard/system-stats", summary="管理员仪表盘 — 系统统计")
def dashboard_system_stats(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    total_nodes = session.execute(select(func.count()).select_from(workers_t)).scalar_one()
    online_nodes = session.execute(select(func.count()).select_from(workers_t).where(workers_t.c.status == "ONLINE")).scalar_one()
    total_users = session.execute(select(func.count()).select_from(accounts_t)).scalar_one()
    active_users = session.execute(select(func.count()).select_from(accounts_t).where(accounts_t.c.status == "active")).scalar_one()
    total_tasks = session.execute(select(func.count()).select_from(workloads_t)).scalar_one()
    completed_tasks = session.execute(select(func.count()).select_from(workloads_t).where(workloads_t.c.status == "DONE")).scalar_one()
    processing_tasks = session.execute(select(func.count()).select_from(workloads_t).where(workloads_t.c.status == "RUNNING")).scalar_one()
    pending_tasks = session.execute(select(func.count()).select_from(workloads_t).where(workloads_t.c.status == "PENDING")).scalar_one()
    failed_tasks = session.execute(select(func.count()).select_from(workloads_t).where(workloads_t.c.status == "FAILED")).scalar_one()
    total_rewards = float(session.execute(select(func.coalesce(func.sum(ledger_t.c.amount), 0)).where(ledger_t.c.type == "REWARD")).scalar_one())
    platform_earnings = float(session.execute(select(func.coalesce(func.sum(ledger_t.c.amount), 0)).where(ledger_t.c.type == "PLATFORM_FEE")).scalar_one())
    circulating_supply = float(session.execute(select(func.coalesce(func.sum(accounts_t.c.balance), 0))).scalar_one())
    return {
        "total_nodes": total_nodes, "online_nodes": online_nodes,
        "total_users": total_users, "active_users": active_users,
        "total_tasks": total_tasks, "completed_tasks": completed_tasks,
        "processing_tasks": processing_tasks, "pending_tasks": pending_tasks,
        "failed_tasks": failed_tasks,
        "total_rewards": total_rewards, "platform_earnings": platform_earnings,
        "total_supply": 1_000_000.0, "circulating_supply": circulating_supply,
    }


@router.get("/dashboard/recent-tasks", summary="管理员仪表盘 — 最近任务")
def dashboard_recent_tasks(
    limit: int = 10,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    rows = session.execute(text("""
        SELECT id, name,
               (spec->>'task_type') AS type,
               status,
               (spec->>'priority') AS priority,
               created_at
          FROM we_workloads
         ORDER BY created_at DESC
         LIMIT :lim
    """), {"lim": limit}).fetchall()
    return [{
        "id": str(r.id), "name": r.name, "type": r.type,
        "status": r.status, "priority": r.priority,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows]


@router.get("/dashboard/", summary="管理员仪表盘 — 全量概览")
def dashboard_overview(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    stats = dashboard_system_stats(session=session, _admin=_admin)
    recent = dashboard_recent_tasks(limit=10, session=session, _admin=_admin)
    return {"stats": stats, "recent_tasks": recent, "active_nodes": [], "task_distribution": [], "node_distribution": {"by_status": [], "by_platform": [], "by_tier": []}}


# ═══════════════════════════ Nodes (we_workers) ═══════════════════════════

@router.get("/nodes/", summary="管理员节点列表（兼容尾斜杠）")
def list_all_nodes_slash(
    status: str = "", limit: int = 200, offset: int = 0,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    return list_all_nodes(status=status, limit=limit, offset=offset, session=session, _admin=_admin)


@router.get("/nodes", summary="管理员节点列表")
def list_all_nodes(
    status: str = "", limit: int = 200, offset: int = 0,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    sql = """SELECT w.id, w.name, w.owner_id, w.status, w.capabilities, w.load,
                    w.active_shards, w.reputation, w.capability_score,
                    w.last_seen, w.registered_at, w.client_version,
                    a.username, a.email
             FROM we_workers w
             LEFT JOIN we_accounts a ON w.owner_id = a.id
             ORDER BY w.last_seen DESC NULLS LAST"""
    params: dict = {}
    if status:
        sql += " WHERE w.status = :status"
        params["status"] = status.upper()
    sql += f" LIMIT {int(limit)} OFFSET {int(offset)}"
    rows = session.execute(text(sql), params).fetchall()
    result = []
    for r in rows:
        caps_raw = r.capabilities or {}
        if isinstance(caps_raw, str):
            try: caps = json.loads(caps_raw)
            except Exception: caps = {}
        elif isinstance(caps_raw, dict):
            caps = caps_raw
        else:
            caps = {}
        result.append({
            "id": str(r.id), "name": r.name, "owner_id": r.owner_id,
            "status": (r.status or "").lower(),
            "load_rate": float(getattr(r, "load", 0) or 0),
            "capability_score": r.capability_score or 0,
            "reputation": r.reputation or 0.0, "client_version": r.client_version or "",
            "last_heartbeat": r.last_seen.isoformat() if r.last_seen else None,
            "created_at": r.registered_at.isoformat() if r.registered_at else None,
            "current_cpu_usage": 0, "current_memory_usage": 0, "current_gpu_usage": 0,
            "capabilities": caps,
            "cpu_cores": caps.get("cpu_cores", 0),
            "memory_gb": round(int(caps.get("total_memory_mb", 0) or 0) / 1024, 0),
            "gpu_count": caps.get("gpu_count", 0),
            "gpu_model": caps.get("gpu_model", ""),
            "hostname": r.name, "os": caps.get("os", ""), "os_version": caps.get("os_version", ""),
            "owner_username": r.username or "", "owner_email": r.email or "",
            "capability_level": caps.get("tier", "basic"), "tier": caps.get("tier", "basic"),
        })
    return result


@router.get("/nodes/my-devices", summary="用户设备列表")
def get_my_devices(
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    rows = session.execute(
        select(workers_t, accounts_t.c.username, accounts_t.c.email)
        .outerjoin(accounts_t, workers_t.c.owner_id == accounts_t.c.id)
        .order_by(workers_t.c.last_seen.desc().nullslast())
    ).fetchall()
    return [{
        "id": str(r.id), "name": r.name, "owner_id": r.owner_id,
        "status": (r.status or "").lower(),
        "load_rate": float(getattr(r, "load", 0) or 0),
        "client_version": r.client_version or "",
        "last_heartbeat": r.last_seen.isoformat() if r.last_seen else None,
        "owner_username": r.username or "", "owner_email": r.email or "",
    } for r in rows]


@router.get("/nodes/{node_id}", summary="管理员节点详情")
def get_node_detail(
    node_id: str,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    row = session.execute(select(workers_t).where(workers_t.c.id == node_id)).one_or_none()
    if not row: raise HTTPException(status_code=404, detail="node not found")
    return {
        "id": str(row.id), "name": row.name, "owner_id": row.owner_id,
        "status": (row.status or "").lower(),
        "load_rate": float(getattr(row, "load", 0) or 0),
        "capability_score": row.capability_score or 0,
        "reputation_score": row.reputation or 0.0,
        "client_version": row.client_version or "",
        "last_heartbeat": row.last_seen.isoformat() if row.last_seen else None,
        "created_at": row.registered_at.isoformat() if row.registered_at else None,
    }


@router.put("/nodes/{node_id}", summary="更新节点")
def update_node(
    node_id: str, body: dict,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    data = {k: v for k, v in body.items() if k in ("status", "name")}
    if data:
        session.execute(update(workers_t).where(workers_t.c.id == node_id).values(**data))
        session.commit()
    return {"ok": True}


@router.delete("/nodes/{node_id}", summary="删除节点")
def delete_node(
    node_id: str,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    session.execute(delete(workers_t).where(workers_t.c.id == node_id))
    session.commit()
    return {"ok": True}


# ═══════════════════════════ Tasks (we_workloads + we_shards) ═══════════════════════════

@router.get("/tasks", summary="管理员任务列表 (we_workloads)")
def list_all_tasks(
    skip: int = 0, limit: int = 20, status: str | None = None,
    owner_id: int | None = None,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    sql = """SELECT w.id, w.name,
                    (w.spec->>'task_type') AS type,
                    (w.spec->>'priority') AS priority,
                    w.status, w.budget, w.progress,
                    w.total_shards, w.completed_shards, w.failed_shards,
                    w.owner_id, a.username AS owner_name,
                    w.created_at, w.updated_at, w.started_at, w.completed_at
             FROM we_workloads w
             LEFT JOIN we_accounts a ON a.id = w.owner_id
             WHERE 1=1 """
    params: dict = {"lim": limit, "off": skip}
    if status:
        sql += " AND w.status = :status"
        params["status"] = status
    if owner_id is not None:
        sql += " AND w.owner_id = :owner_id"
        params["owner_id"] = owner_id
    sql += " ORDER BY w.created_at DESC LIMIT :lim OFFSET :off"
    rows = session.execute(text(sql), params).fetchall()
    return [{
        "id": str(r.id), "name": r.name, "type": r.type, "status": r.status,
        "priority": r.priority, "budget": float(r.budget or 0),
        "progress": float(r.progress or 0),
        "total_shards": r.total_shards, "completed_shards": r.completed_shards,
        "failed_shards": r.failed_shards,
        "owner_id": r.owner_id, "owner_name": r.owner_name,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
    } for r in rows]


@router.get("/tasks/{task_id}", summary="任务详情 (we_workloads)")
def get_task_detail(
    task_id: str,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    row = session.execute(text("""
        SELECT w.*, a.username AS owner_name
        FROM we_workloads w
        LEFT JOIN we_accounts a ON a.id = w.owner_id
        WHERE w.id = :id
    """), {"id": task_id}).one_or_none()
    if not row:
        raise HTTPException(404, "task not found")
    d = dict(row._mapping)
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
        elif hasattr(v, "hex"):
            d[k] = str(v)
    return d


@router.get("/tasks/{task_id}/pipeline", summary="任务流水线 (we_shards)")
def get_task_pipeline(
    task_id: str,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    rows = session.execute(text("""
        SELECT s.id, s.status, s.worker_id, s.index, s.total,
               s.dispatched_at, s.started_at, s.completed_at,
               s.elapsed_ms, s.error, s.output_ref,
               w.name AS worker_name
        FROM we_shards s
        LEFT JOIN we_workers w ON w.id = s.worker_id
        WHERE s.workload_id = :tid
        ORDER BY s.index
    """), {"tid": task_id}).fetchall()
    return [{
        "id": str(r.id), "status": r.status,
        "worker_id": str(r.worker_id) if r.worker_id else None,
        "worker_name": r.worker_name,
        "index": r.index, "total": r.total,
        "dispatched_at": r.dispatched_at.isoformat() if r.dispatched_at else None,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
        "elapsed_ms": r.elapsed_ms, "error": r.error, "output_ref": r.output_ref,
    } for r in rows]


@router.put("/tasks/{task_id}", summary="更新任务")
def update_task(
    task_id: str, body: dict,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    allowed = {"name", "status"}
    sets = ", ".join(f"{k} = :{k}" for k in body if k in allowed)
    if sets:
        params = {k: v for k, v in body.items() if k in allowed}
        params["id"] = task_id
        session.execute(text(f"UPDATE we_workloads SET {sets}, updated_at = NOW() WHERE id = :id"), params)
        session.commit()
    return {"ok": True}


@router.delete("/tasks/{task_id}", summary="删除任务 (含分片)")
def delete_task(
    task_id: str,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    """ledger 用 ON DELETE SET NULL · 账本不丢"""
    session.execute(text("DELETE FROM we_shards WHERE workload_id = :tid"), {"tid": task_id})
    session.execute(text("DELETE FROM we_workloads WHERE id = :id"), {"id": task_id})
    session.commit()
    return {"ok": True}


@router.delete("/workloads/{workload_id}", summary="管理员取消任务 (软取消)")
def cancel_workload(
    workload_id: str,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    try:
        cancel_workload_service(
            session, workload_id, caller=_admin, reason="admin_cancel",
        )
        session.commit()
    except CancelError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True}


# ═══════════════════════════ Marketplace (任务市场 · we_workloads) ═══════════════════════════

@router.get("/marketplace/tasks", summary="任务市场 — 待领取任务")
def marketplace_tasks(
    limit: int = 20, all_status: bool = False,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    where = "" if all_status else " WHERE status IN ('CREATED', 'PENDING', 'WAITING_FOR_WORKERS')"
    rows = session.execute(text(f"""
        SELECT id, name,
               (spec->>'task_type') AS type,
               status,
               (spec->>'priority') AS priority,
               budget, created_at
          FROM we_workloads
          {where}
         ORDER BY created_at DESC
         LIMIT :lim
    """), {"lim": limit}).fetchall()
    return [{
        "id": str(r.id), "name": r.name, "type": r.type, "status": r.status,
        "priority": r.priority, "budget": float(r.budget or 0),
        "created_at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows]


@router.get("/marketplace/subtasks", summary="任务市场 — 分片列表")
def marketplace_subtasks(
    limit: int = 100,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    rows = session.execute(text("""
        SELECT s.id, s.workload_id AS task_id, w.name AS task_name,
               s.status, s.worker_id AS node_id,
               s.index, s.total,
               s.dispatched_at
          FROM we_shards s
          LEFT JOIN we_workloads w ON w.id = s.workload_id
         ORDER BY s.dispatched_at DESC NULLS LAST
         LIMIT :lim
    """), {"lim": limit}).fetchall()
    return [{
        "id": str(r.id), "task_id": str(r.task_id), "task_name": r.task_name,
        "status": r.status, "node_id": str(r.node_id) if r.node_id else None,
        "index": r.index, "total": r.total,
        "dispatched_at": r.dispatched_at.isoformat() if r.dispatched_at else None,
    } for r in rows]


# ═══════════════════════════ Users (we_accounts) ═══════════════════════════

@router.get("/users", summary="用户列表（别名）")
def list_users_alias(
    limit: int = 100, offset: int = 0,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    return list_users(limit=limit, offset=offset, session=session, _admin=_admin)


@router.get("/admin/users", summary="管理员用户列表")
def list_users(
    limit: int = 100, offset: int = 0,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    rows = session.execute(
        select(
            accounts_t.c.id, accounts_t.c.username, accounts_t.c.email,
            accounts_t.c.role, accounts_t.c.status, accounts_t.c.balance,
            accounts_t.c.created_at,
        ).order_by(accounts_t.c.id).limit(limit).offset(offset)
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r._mapping)
        if hasattr(d.get("role"), "value"):
            d["role"] = d["role"].value
        # 累计奖励 (从 we_ledger 求和)
        earned = session.execute(
            select(func.coalesce(func.sum(ledger_t.c.amount), 0))
            .where((ledger_t.c.account_id == r.id) & (ledger_t.c.type == "REWARD"))
        ).scalar_one()
        d["total_earnings"] = float(earned)
        d["created_at"] = d["created_at"].isoformat() if d.get("created_at") else None
        d["balance"] = float(d.get("balance") or 0)
        out.append(d)
    return out


@router.post("/admin/users", summary="管理员创建用户")
def create_user(
    body: dict,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    username = body.get("username", "")
    email = body.get("email", "")
    password = body.get("password")
    role = body.get("role", "personal")
    if not username or not email:
        raise HTTPException(400, "username/email required")
    if not isinstance(password, str) or len(password) < 12:
        raise HTTPException(400, "password must contain at least 12 characters")
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()
    r = session.execute(
        insert(accounts_t).values(
            username=username, email=email, password_hash=pw_hash,
            role=role, status="active", balance=0,
        ).returning(accounts_t.c.id)
    ).one_or_none()
    session.commit()
    return {"ok": True, "id": r.id if r else None}


@router.delete("/admin/users/{user_id}", summary="管理员删除用户")
def delete_user(
    user_id: int,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    session.execute(delete(accounts_t).where(accounts_t.c.id == user_id))
    session.commit()
    return {"ok": True}


@router.post("/admin/users/{user_id}/balance/adjust", summary="调整用户余额")
def adjust_balance(
    user_id: int, body: dict,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    amount = float(body.get("amount", 0))
    session.execute(
        update(accounts_t)
        .where(accounts_t.c.id == user_id)
        .values(balance=accounts_t.c.balance + amount)
    )
    # 落账本 (ADJUST 类型)
    import uuid
    session.execute(insert(ledger_t).values(
        id=str(uuid.uuid4()),
        account_id=user_id,
        type="ADJUST",
        amount=amount,
        currency="CNY",
        idempotent_key=f"admin-adjust-{user_id}-{uuid.uuid4()}",
        note=body.get("note", "admin adjust"),
        metadata={"actor": "admin"},
    ))
    session.commit()
    return {"ok": True}


@router.get("/users/{user_id}/transactions", summary="用户账本流水")
def user_transactions(
    user_id: int, limit: int = 50,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    rows = session.execute(text("""
        SELECT id, type, amount, currency, note, workload_id, shard_id, created_at
          FROM we_ledger
         WHERE account_id = :uid
         ORDER BY created_at DESC
         LIMIT :lim
    """), {"uid": user_id, "lim": limit}).fetchall()
    return [{
        "id": str(r.id), "type": r.type,
        "amount": float(r.amount or 0), "currency": r.currency,
        "description": r.note,
        "workload_id": str(r.workload_id) if r.workload_id else None,
        "shard_id": str(r.shard_id) if r.shard_id else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows]


# ═══════════════════════════ Economy (we_ledger) ═══════════════════════════

@router.get("/economy/stats", summary="经济统计")
def economy_stats(
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    total_transactions = session.execute(select(func.count()).select_from(ledger_t)).scalar_one()
    total_volume = float(session.execute(
        select(func.coalesce(func.sum(func.abs(ledger_t.c.amount)), 0))
    ).scalar_one())
    return {"total_transactions": total_transactions, "total_volume": total_volume}


@router.get("/economy/transactions", summary="平台账本流水")
def economy_transactions(
    limit: int = 50, offset: int = 0,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    rows = session.execute(text("""
        SELECT l.id, l.account_id AS user_id, l.type,
               l.amount, l.currency, l.note,
               l.workload_id, l.shard_id, l.created_at,
               a.username
          FROM we_ledger l
          LEFT JOIN we_accounts a ON a.id = l.account_id
         ORDER BY l.created_at DESC
         LIMIT :lim OFFSET :off
    """), {"lim": limit, "off": offset}).fetchall()
    return [{
        "id": str(r.id), "user_id": r.user_id, "username": r.username,
        "type": r.type, "amount": float(r.amount or 0), "currency": r.currency,
        "description": r.note,
        "workload_id": str(r.workload_id) if r.workload_id else None,
        "shard_id": str(r.shard_id) if r.shard_id else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows]


# ═══════════════════════════ Audit (we_audit) ═══════════════════════════

@router.get("/audit-logs", summary="审计日志")
def audit_logs(
    limit: int = 50, offset: int = 0,
    session: Session = Depends(get_session), _admin: Account = Depends(get_admin_account),
):
    rows = session.execute(text("""
        SELECT a.id, a.action,
               a.actor_account_id, a.actor_kind,
               acc.username AS actor_name,
               a.target_kind, a.target_id,
               a.detail, a.ip, a.user_agent, a.trace_id,
               a.created_at
          FROM we_audit a
          LEFT JOIN we_accounts acc ON acc.id = a.actor_account_id
         ORDER BY a.created_at DESC
         LIMIT :lim OFFSET :off
    """), {"lim": limit, "off": offset}).fetchall()
    return [{
        "id": str(r.id), "actor": r.actor_name or r.actor_kind,
        "actor_id": r.actor_account_id, "actor_kind": r.actor_kind,
        "action": r.action,
        "resource": f"{r.target_kind}:{r.target_id}" if r.target_kind else None,
        "detail": r.detail, "ip": r.ip, "user_agent": r.user_agent,
        "trace_id": r.trace_id,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows]
