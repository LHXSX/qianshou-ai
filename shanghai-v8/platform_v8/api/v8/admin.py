"""
Admin HTTP router · /api/v8/admin/*

设计要点 (考虑全链路):
  - 全 endpoint 强制 admin (Depends(get_admin_account))
  - 列表类: accounts / workloads / workers / audit / ledger
  - 操作类: 充值 / 改 role / 暂停账号 (后续扩)
"""
from __future__ import annotations
import logging
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File
from pydantic import BaseModel, Field
from sqlalchemy import select, func, desc
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session, get_admin_account
from platform_v8.core import Account, AccountStatus, AccountRole
from platform_v8.protocol.http_schema import AccountOut, WorkerOut, WorkloadOut
from platform_v8.storage.repo import (
    AccountRepo, WorkerRepo, WorkloadRepo, LedgerRepo, AuditRepo,
    accounts_t, workers_t, workloads_t, ledger_t, audit_t,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/admin", tags=["admin"])


# ════════════════════════════════════════════════════════════════════
# 账号管理
# ════════════════════════════════════════════════════════════════════
@router.get("/accounts", summary="列所有账号 (含余额)")
def list_accounts(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
    role: str | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    stmt = select(accounts_t).order_by(accounts_t.c.created_at.desc()).limit(limit).offset(offset)
    if role:
        stmt = stmt.where(accounts_t.c.role == role)
    if status:
        stmt = stmt.where(accounts_t.c.status == status)
    rows = session.execute(stmt).all()
    items = []
    for r in rows:
        items.append({
            "id": r.id,
            "username": r.username,
            "email": r.email,
            "role": r.role,
            "status": r.status,
            "balance": str(r.balance),
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "last_login_at": r.last_login_at.isoformat() if r.last_login_at else None,
        })
    total = session.execute(select(func.count()).select_from(accounts_t)).scalar_one()
    return {"ok": True, "items": items, "total": total, "limit": limit, "offset": offset}


class UpdateAccountRequest(BaseModel):
    role: str | None = Field(default=None, examples=["personal", "enterprise", "admin"])
    status: str | None = Field(default=None, examples=["active", "suspended"])


@router.put("/accounts/{account_id}", summary="改 role / status (admin 后台动作)")
def update_account(
    account_id: int,
    body: UpdateAccountRequest,
    session: Session = Depends(get_session),
    admin: Account = Depends(get_admin_account),
):
    if account_id == admin.id:
        raise HTTPException(status_code=400, detail="不能修改自己 (防误操作)")

    acc = AccountRepo.by_id(session, account_id)
    if acc is None:
        raise HTTPException(status_code=404, detail="账号不存在")

    if body.role is not None:
        if body.role not in [r.value for r in AccountRole]:
            raise HTTPException(status_code=400, detail=f"role 不合法 (合法: {[r.value for r in AccountRole]})")
        from sqlalchemy import update as _update
        session.execute(
            _update(accounts_t).where(accounts_t.c.id == account_id).values(role=body.role)
        )

    if body.status is not None:
        if body.status not in [s.value for s in AccountStatus]:
            raise HTTPException(status_code=400, detail=f"status 不合法")
        AccountRepo.update_status(session, account_id, AccountStatus(body.status))

    AuditRepo.write(
        session,
        action="admin.update_account",
        actor_account_id=admin.id,
        actor_kind="admin",
        target_kind="account",
        target_id=str(account_id),
        detail={"role": body.role, "status": body.status},
    )

    updated = AccountRepo.by_id(session, account_id)
    return AccountOut.model_validate(updated)


# ════════════════════════════════════════════════════════════════════
# 任务管理
# ════════════════════════════════════════════════════════════════════
@router.get("/workloads", summary="列所有任务 (跨用户)")
def list_all_workloads(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
    status: str | None = Query(default=None),
    owner_id: int | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    stmt = select(workloads_t).order_by(workloads_t.c.created_at.desc()).limit(limit).offset(offset)
    if status:
        stmt = stmt.where(workloads_t.c.status == status)
    if owner_id is not None:
        stmt = stmt.where(workloads_t.c.owner_id == owner_id)
    rows = session.execute(stmt).all()
    items = []
    for r in rows:
        items.append({
            "id": r.id,
            "owner_id": r.owner_id,
            "name": r.name,
            "status": r.status,
            "progress": r.progress,
            "total_shards": r.total_shards,
            "completed_shards": r.completed_shards,
            "budget": str(r.budget),
            "created_at": r.created_at.isoformat() if r.created_at else None,
        })
    return {"ok": True, "items": items, "limit": limit, "offset": offset}


# ════════════════════════════════════════════════════════════════════
# 节点管理
# ════════════════════════════════════════════════════════════════════
@router.get("/workers", summary="列所有 worker (跨用户)")
def list_all_workers(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
    status: str | None = Query(default=None),
    owner_id: int | None = Query(default=None),
):
    stmt = select(workers_t).order_by(workers_t.c.registered_at.desc())
    if status:
        stmt = stmt.where(workers_t.c.status == status)
    if owner_id is not None:
        stmt = stmt.where(workers_t.c.owner_id == owner_id)
    rows = session.execute(stmt).all()
    items = []
    for r in rows:
        caps = r.capabilities if isinstance(r.capabilities, dict) else {}
        _mem_gb = float(caps.get("memory_gb") or 0)
        if _mem_gb <= 0 and caps.get("total_memory_mb"):
            _mem_gb = round(int(caps["total_memory_mb"]) / 1024.0, 2)
        items.append({
            "id": r.id,
            "owner_id": r.owner_id,
            "name": r.name,
            "status": r.status,
            "load": r.load,
            "active_shards": r.active_shards,
            "last_seen": r.last_seen.isoformat() if r.last_seen else None,
            "client_version": r.client_version,
            # 2026-06-02 · 补端能力/信誉/分级 (DB 有数据 · Schema 有定义 · 之前漏塞)
            "capabilities": caps,
            "memory_gb": _mem_gb,
            "gpu_count": int(caps.get("gpu_count") or 0),
            "gpu_model": str(caps.get("gpu_model") or ""),
            "software": caps.get("software") or [],
            "reputation": r.reputation,
            "capability_score": r.capability_score,
            "hw_tier": getattr(r, "hw_tier", None),
            "hw_score": getattr(r, "hw_score", None),
        })
    return {"ok": True, "items": items}


# ════════════════════════════════════════════════════════════════════
# 审计日志
# ════════════════════════════════════════════════════════════════════
@router.get("/audit", summary="审计日志 (含过滤)")
def list_audit(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
    action: str | None = Query(default=None, description="按 action 过滤"),
    actor_account_id: int | None = Query(default=None),
    target_kind: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
):
    stmt = select(audit_t).order_by(audit_t.c.created_at.desc()).limit(limit)
    if action:
        stmt = stmt.where(audit_t.c.action == action)
    if actor_account_id is not None:
        stmt = stmt.where(audit_t.c.actor_account_id == actor_account_id)
    if target_kind:
        stmt = stmt.where(audit_t.c.target_kind == target_kind)
    rows = session.execute(stmt).all()
    items = []
    for r in rows:
        items.append({
            "id": r.id,
            "actor_account_id": r.actor_account_id,
            "actor_kind": r.actor_kind,
            "action": r.action,
            "target_kind": r.target_kind,
            "target_id": r.target_id,
            "ip": r.ip,
            "detail": r.detail,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        })
    return {"ok": True, "items": items}


# ════════════════════════════════════════════════════════════════════
# 全平台账本
# ════════════════════════════════════════════════════════════════════
@router.get("/ledger", summary="全平台 ledger 流水 (跨用户)")
def list_all_ledger(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
    type: str | None = Query(default=None),
    account_id: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
):
    stmt = select(ledger_t).order_by(ledger_t.c.created_at.desc()).limit(limit)
    if type:
        stmt = stmt.where(ledger_t.c.type == type)
    if account_id is not None:
        stmt = stmt.where(ledger_t.c.account_id == account_id)
    rows = session.execute(stmt).all()
    items = []
    for r in rows:
        items.append({
            "id": r.id,
            "account_id": r.account_id,
            "type": r.type,
            "amount": str(r.amount),
            "currency": r.currency,
            "workload_id": r.workload_id,
            "note": r.note,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        })
    return {"ok": True, "items": items}


# ════════════════════════════════════════════════════════════════════
# 2026-05-18 · admin-portal 兼容 alias (映射 /admin/users → /admin/accounts)
# ════════════════════════════════════════════════════════════════════
from pydantic import BaseModel, Field as _Field


class AdminCreateUserReq(BaseModel):
    username: str
    email: str = ""
    password: str
    role: str = "personal"  # personal/enterprise/channel/admin


class AdminAdjustBalanceReq(BaseModel):
    amount: float = _Field(description="正数充值 · 负数扣款")
    note: str = ""
    reason: str = ""
    type: str = "deposit"


@router.get("/users", summary="admin-portal alias · 列账号 (等价 /accounts)")
def list_users_alias(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    include_deleted: bool = Query(default=False, description="是否显示软删账号"),
):
    """admin-portal 调 /admin/users · 默认过滤 status=deleted · 附带 node/task/earnings 统计"""
    from sqlalchemy import text as _t
    stmt = select(accounts_t).order_by(accounts_t.c.created_at.desc()).limit(limit).offset(offset)
    if not include_deleted:
        stmt = stmt.where(accounts_t.c.status != "deleted")
    rows = session.execute(stmt).all()
    items = []
    for r in rows:
        # 节点数 (we_workers)
        node_count = session.execute(_t("SELECT COUNT(*) FROM we_workers WHERE owner_id = :uid"),
                                    {"uid": r.id}).scalar() or 0
        # 完成任务数 (we_workloads · status=DONE)
        task_count = session.execute(_t(
            "SELECT COUNT(*) FROM we_workloads WHERE owner_id = :uid AND status = 'DONE'"
        ), {"uid": r.id}).scalar() or 0
        # 累计收入 (REWARD 求和)
        earnings = session.execute(_t(
            "SELECT COALESCE(SUM(amount), 0) FROM we_ledger WHERE account_id = :uid AND type = 'REWARD'"
        ), {"uid": r.id}).scalar() or 0
        items.append({
            "id": r.id,
            "username": r.username,
            "email": r.email,
            "role": r.role,
            "status": r.status,
            "balance": float(r.balance) if r.balance is not None else 0.0,
            "node_count": int(node_count),
            "completed_tasks": int(task_count),
            "total_earnings": float(earnings),
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "last_login_at": r.last_login_at.isoformat() if r.last_login_at else None,
        })
    total = session.execute(select(func.count()).select_from(accounts_t)).scalar_one()
    return {"ok": True, "items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/users", summary="admin 创建用户 (复用 register)")
def admin_create_user(
    req: AdminCreateUserReq,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    from platform_v8.storage.repo import accounts_t
    from sqlalchemy import insert
    import bcrypt
    h = bcrypt.hashpw(req.password.encode(), bcrypt.gensalt(rounds=12)).decode()
    r = session.execute(
        insert(accounts_t).values(
            username=req.username,
            email=req.email or f"{req.username}@local",
            password_hash=h,
            role="personal",
            status="active",
            balance=0,
        ).returning(accounts_t.c.id)
    ).fetchone()
    session.commit()
    return {
        "ok": True,
        "user": {
            "id": r.id if r else None,
            "username": req.username,
            "role": "user",
            "email": req.email or "",
        }
    }


@router.patch("/users/{user_id}/role", summary="改用户角色 (alias /accounts)")
def patch_user_role(
    user_id: int,
    body: dict,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """内嵌实现 · 改 we_accounts.role"""
    new_role = body.get("role")
    if not new_role or new_role not in ("personal", "enterprise", "channel", "admin"):
        raise HTTPException(status_code=400, detail=f"无效 role: {new_role}")
    from sqlalchemy import text as _t
    try:
        session.execute(_t("UPDATE we_accounts SET role = :r WHERE id = :uid"),
                       {"r": new_role, "uid": user_id})
        session.commit()
        return {"ok": True, "user_id": user_id, "role": new_role}
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/users/{user_id}", summary="改用户信息 (alias)")
def patch_user(
    user_id: int,
    body: dict,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """内嵌 · 改 role/status/email"""
    from sqlalchemy import text as _t
    sets = []
    params: dict = {"uid": user_id}
    for k in ("role", "status", "email"):
        if k in body and body[k] is not None:
            sets.append(f"{k} = :{k}")
            params[k] = body[k]
    if not sets:
        return {"ok": True, "user_id": user_id, "changed": []}
    try:
        session.execute(_t(f"UPDATE we_accounts SET {', '.join(sets)} WHERE id = :uid"), params)
        session.commit()
        changed = [k for k in params if k != "uid"]
        return {"ok": True, "user_id": user_id, "changed": changed}
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/users/{user_id}/balance/adjust", summary="调整余额 (调用 economy)")
def adjust_balance(
    user_id: int,
    req: AdminAdjustBalanceReq,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """正数充值 · 负数扣款 · 直接写 ledger + 改 balance"""
    from sqlalchemy import text as _t
    note = req.note or f"admin 调整 (by aid={_admin.id})"
    try:
        session.execute(_t("UPDATE we_accounts SET balance = balance + :amt WHERE id = :uid"),
                       {"amt": req.amount, "uid": user_id})
        # idempotent_key + metadata 都 NOT NULL · 必须填
        import uuid as _u
        session.execute(_t("""
            INSERT INTO we_ledger (id, account_id, type, amount, currency,
                                   idempotent_key, note, metadata, created_at)
            VALUES (gen_random_uuid(), :uid, 'ADMIN_ADJUST', :amt, 'EDG',
                    :idk, :note, '{}'::jsonb, NOW())
        """), {"uid": user_id, "amt": req.amount, "note": note, "idk": _u.uuid4().hex})
        session.commit()
        return {"ok": True, "user_id": user_id, "amount": req.amount, "note": note}
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/users/{user_id}", summary="删用户 (软删 · 改 status=deleted)")
def delete_user(
    user_id: int,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    if user_id == _admin.id:
        raise HTTPException(status_code=400, detail="不能删自己")
    from sqlalchemy import text as _t
    try:
        session.execute(_t("UPDATE we_accounts SET status = 'deleted' WHERE id = :uid"),
                       {"uid": user_id})
        session.commit()
        return {"ok": True, "user_id": user_id, "status": "deleted"}
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=str(e))



# ════════════════════════════════════════════════════════════════════
# 2026-05-18 · /admin/economy/overview · 三方分润总览 (移植自 super_engine_v2 + v8 reputation)
# ════════════════════════════════════════════════════════════════════
@router.get("/economy/overview", summary="经济总览 · GMV / 节点收益 / 平台收入 / 信誉排名")
def economy_overview(
    days: int = Query(default=30, ge=1, le=365, description="统计天数"),
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """
    管理员经济总览 (admin-portal "经济总览" 页用)

    返回:
        period_days: 统计周期
        gmv:        总流水 (escrow_hold 累计)
        node_revenue:    节点累计 reward (= client_pool 总和)
        platform_revenue: 平台收入 (= platform_pool · 给 admin 的 REWARD)
        channel_revenue: 渠道分润 (如有渠道账号)
        workload_count: 任务数
        active_nodes: 在线节点数
        top_nodes:   信誉排名 TOP 10 (节点 + reputation + 任务量)
        top_earners: 节点收入排名 TOP 10 (owner_id + 累计 EDG)
    """
    from sqlalchemy import text as _t
    from datetime import datetime, timedelta
    import os as _os

    platform_id = int(_os.environ.get("V8_PLATFORM_ACCOUNT_ID", "1"))
    channel_id = int(_os.environ.get("V8_CHANNEL_ACCOUNT_ID", "0"))
    cutoff = datetime.utcnow() - timedelta(days=days)

    # GMV = ESCROW_HOLD 绝对值 (负数 · 锁的钱)
    gmv = session.execute(_t("""
        SELECT COALESCE(SUM(-amount), 0)::float FROM we_ledger
        WHERE type='ESCROW_HOLD' AND created_at >= :cutoff
    """), {"cutoff": cutoff}).scalar() or 0.0

    # 节点 reward (排除给平台/渠道 admin 账号的 REWARD)
    node_revenue = session.execute(_t("""
        SELECT COALESCE(SUM(amount), 0)::float FROM we_ledger
        WHERE type='REWARD' AND created_at >= :cutoff
        AND account_id NOT IN (:platform_id, :channel_id)
    """), {"cutoff": cutoff, "platform_id": platform_id, "channel_id": channel_id}).scalar() or 0.0

    # 平台收入 (给平台账号的 REWARD · idempotent_key 含 platform 也行)
    platform_revenue = session.execute(_t("""
        SELECT COALESCE(SUM(amount), 0)::float FROM we_ledger
        WHERE type='REWARD' AND account_id = :pid AND created_at >= :cutoff
    """), {"pid": platform_id, "cutoff": cutoff}).scalar() or 0.0

    # 渠道收入
    channel_revenue = session.execute(_t("""
        SELECT COALESCE(SUM(amount), 0)::float FROM we_ledger
        WHERE type='REWARD' AND account_id = :cid AND created_at >= :cutoff
    """), {"cid": channel_id, "cutoff": cutoff}).scalar() or 0.0 if channel_id else 0.0

    workload_count = session.execute(_t("""
        SELECT COUNT(*) FROM we_workloads WHERE created_at >= :cutoff
    """), {"cutoff": cutoff}).scalar() or 0

    active_nodes = session.execute(_t("""
        SELECT COUNT(*) FROM we_workers WHERE status='ONLINE'
    """)).scalar() or 0

    # 信誉排名 TOP 10 (节点 · 优先 ONLINE · 按 reputation 降序)
    top_nodes_rows = session.execute(_t("""
        SELECT w.id, w.name, w.owner_id, w.reputation, w.status,
               (SELECT COUNT(*) FROM we_shards s WHERE s.worker_id=w.id AND s.status='DONE') AS done_shards
        FROM we_workers w
        ORDER BY w.reputation DESC, done_shards DESC LIMIT 10
    """)).fetchall()
    top_nodes = [{
        "worker_id": str(r.id), "name": r.name, "owner_id": r.owner_id,
        "reputation": round(float(r.reputation or 0), 4),
        "status": r.status, "done_shards": int(r.done_shards or 0),
    } for r in top_nodes_rows]

    # 节点收入排名 TOP 10 (按 owner_id 聚合 reward · 排除平台/渠道)
    top_earners_rows = session.execute(_t("""
        SELECT a.id, a.username, a.role, COALESCE(SUM(l.amount), 0)::float AS total
        FROM we_accounts a
        JOIN we_ledger l ON l.account_id=a.id
        WHERE l.type='REWARD' AND l.created_at >= :cutoff
          AND a.id NOT IN (:platform_id, :channel_id)
        GROUP BY a.id, a.username, a.role
        ORDER BY total DESC LIMIT 10
    """), {"cutoff": cutoff, "platform_id": platform_id, "channel_id": channel_id}).fetchall()
    top_earners = [{
        "account_id": r.id, "username": r.username, "role": r.role,
        "total_revenue": round(float(r.total or 0), 4),
    } for r in top_earners_rows]

    return {
        "ok": True,
        "period_days": days,
        "gmv": round(gmv, 4),
        "node_revenue": round(node_revenue, 4),
        "platform_revenue": round(platform_revenue, 4),
        "channel_revenue": round(channel_revenue, 4),
        "workload_count": int(workload_count),
        "active_nodes": int(active_nodes),
        "top_nodes": top_nodes,
        "top_earners": top_earners,
        "config": {
            "platform_account_id": platform_id,
            "channel_account_id": channel_id,
            "client_ratio": float(_os.environ.get("V8_SETTLEMENT_CLIENT_RATIO", "0.65")),
            "platform_ratio": float(_os.environ.get("V8_SETTLEMENT_PLATFORM_RATIO", "0.30")),
            "channel_ratio": float(_os.environ.get("V8_SETTLEMENT_CHANNEL_RATIO", "0.05")),
        },
    }

# ═══════════════════════════════════════════════
# venv tarball 上传 (Windows构建用)
# ═══════════════════════════════════════════════
@router.post('/upload-venv')
async def upload_venv(
    tier: str = Query(...),
    file: UploadFile = File(...),
    _admin: Account = Depends(get_admin_account),
):
    import os, shutil
    d = '/opt/edge/venv_uploads'
    os.makedirs(d, exist_ok=True)
    dest = os.path.join(d, f'{tier}.tar.gz')
    with open(dest, 'wb') as f:
        shutil.copyfileobj(file.file, f)
    s = os.path.getsize(dest)
    return {'ok': True, 'tier': tier, 'size_mb': round(s/1024/1024,1)}

@router.post('/upload-venv-b64')
async def upload_venv_b64(
    request: Request,
    _admin: Account = Depends(get_admin_account),
):
    import os
    import base64 as _b64
    body = await request.json()
    tier = body.get('tier','')
    data = _b64.b64decode(body.get('data_b64',''))
    d = '/opt/edge/venv_uploads'
    os.makedirs(d, exist_ok=True)
    dest = os.path.join(d, f'{tier}.tar.gz')
    with open(dest, 'wb') as f:
        f.write(data)
    s = os.path.getsize(dest)
    logger.info(f"upload-venv-b64 · tier={tier} size={s/1024/1024:.1f}MB")
    return {'ok': True, 'tier': tier, 'size_mb': round(s/1024/1024,1)}
