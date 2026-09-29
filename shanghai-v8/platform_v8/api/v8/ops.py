"""
Ops HTTP router · /api/v8/ops/*

这是**所有 v8 router 的模板** · 后续 auth/workloads/workers 等都按这个模式:
  1. 顶部 from .. import (service / schema)
  2. 创建 APIRouter (带 prefix + tags)
  3. 每个 endpoint:
     - 函数签名声明 response_model
     - 调 service 函数 (router 不写业务)
     - 失败抛 HTTPException
  4. 文件底部 export router 给 api/app.py 挂
"""
from __future__ import annotations
from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session, get_admin_account
from platform_v8.core import Account
from platform_v8.services.ops import health as health_svc
from platform_v8.services.ops import dashboard as dashboard_svc

router = APIRouter(prefix="/api/v8/ops", tags=["ops"])


@router.get("/health", summary="K8s liveness · 不查依赖")
def liveness():
    """轻量健康检查 (进程是否还活着 · 不查 DB · 给 k8s liveness probe)"""
    return health_svc.liveness()


@router.get("/ready", summary="K8s readiness · 查 DB + Redis")
def readiness(response: Response):
    """完整健康检查 · 任何依赖挂返 503 (给 k8s readiness probe)"""
    rep = health_svc.readiness_dict()
    if rep["status"] == "error":
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return rep


@router.get("/version", summary="返回 v8 版本号")
def version_info():
    from platform_v8 import __version__
    return {"version": __version__, "name": "platform_v8"}


@router.get("/dashboard", summary="admin 后台聚合指标")
def dashboard_endpoint(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    return {"ok": True, "data": dashboard_svc.get_dashboard(session)}


# ── 以下为管理员前端兼容端点（前端路径不变，baseURL 改成 /api/v8 后自动匹配）──


@router.get("/dashboard/system-stats", summary="管理员仪表盘 — 系统统计")
def dashboard_system_stats(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """兼容 v1 /api/v1/dashboard/system-stats"""
    from platform_v8.storage.repo import accounts_t, workers_t, workloads_t, ledger_t

    # 节点统计（从 we_workers 查）
    total_nodes = session.execute(
        select(func.count()).select_from(workers_t)
    ).scalar_one()
    online_nodes = session.execute(
        select(func.count()).select_from(workers_t)
        .where(workers_t.c.status == "online")
    ).scalar_one()

    # 用户统计
    total_users = session.execute(
        select(func.count()).select_from(accounts_t)
    ).scalar_one()
    active_users = session.execute(
        select(func.count()).select_from(accounts_t).where(accounts_t.c.status == "active")
    ).scalar_one()

    # 任务统计
    total_tasks = session.execute(
        select(func.count()).select_from(workloads_t)
    ).scalar_one()
    completed_tasks = session.execute(
        select(func.count()).select_from(workloads_t)
        .where(workloads_t.c.status == "DONE")
    ).scalar_one()
    processing_tasks = session.execute(
        select(func.count()).select_from(workloads_t)
        .where(workloads_t.c.status == "RUNNING")
    ).scalar_one()
    pending_tasks = session.execute(
        select(func.count()).select_from(workloads_t)
        .where(workloads_t.c.status == "PENDING")
    ).scalar_one()
    failed_tasks = session.execute(
        select(func.count()).select_from(workloads_t)
        .where(workloads_t.c.status == "FAILED")
    ).scalar_one()

    # 经济统计
    total_rewards = float(session.execute(
        select(func.coalesce(func.sum(ledger_t.c.amount), 0))
        .where(ledger_t.c.type == "REWARD")
    ).scalar_one())
    platform_earnings = float(session.execute(
        select(func.coalesce(func.sum(ledger_t.c.amount), 0))
        .where(ledger_t.c.type == "PLATFORM_FEE")
    ).scalar_one())
    total_supply = 1_000_000.0
    circulating_supply = float(session.execute(
        select(func.coalesce(func.sum(accounts_t.c.balance), 0))
    ).scalar_one())

    return {
        "total_nodes": total_nodes,
        "online_nodes": online_nodes,
        "total_users": total_users,
        "active_users": active_users,
        "total_tasks": total_tasks,
        "completed_tasks": completed_tasks,
        "processing_tasks": processing_tasks,
        "pending_tasks": pending_tasks,
        "failed_tasks": failed_tasks,
        "total_rewards": total_rewards,
        "platform_earnings": platform_earnings,
        "total_supply": total_supply,
        "circulating_supply": circulating_supply,
    }


@router.get("/dashboard/recent-tasks", summary="管理员仪表盘 — 最近任务")
def dashboard_recent_tasks(
    limit: int = 10,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """从 we_workloads 拉最近任务 · 兼容老 admin /dashboard/recent-tasks"""
    from sqlalchemy import text
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
    return [
        {
            "id": str(r.id), "name": r.name, "type": r.type,
            "status": r.status, "priority": r.priority,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.get("/dashboard/active-nodes", summary="管理员仪表盘 — 活跃节点")
def dashboard_active_nodes(
    limit: int = 20,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """兼容 v1 /api/v1/dashboard/active-nodes — 从 we_workers 表读取"""
    from platform_v8.storage.repo import workers_t
    rows = session.execute(
        select(workers_t).where(workers_t.c.status == "ONLINE")
        .order_by(workers_t.c.last_seen.desc().nullslast())
        .limit(limit)
    ).fetchall()
    return [
        {
            "id": str(r.id),
            "name": r.name,
            "platform": getattr(r, "platform", "unknown"),
            "status": "online",
            "last_heartbeat": r.last_seen.isoformat() if r.last_seen else None,
            "load_rate": float(getattr(r, "load", 0) or 0),
        }
        for r in rows
    ]


@router.get("/dashboard/top-performers", summary="管理员仪表盘 — 最佳节点")
def dashboard_top_performers(
    limit: int = 5,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """兼容 v1 /api/v1/dashboard/top-performers"""
    from platform_v8.storage.repo import workers_t
    rows = session.execute(
        select(workers_t).order_by(workers_t.c.completed_tasks.desc().nullslast())
        .limit(limit)
    ).fetchall()
    return [
        {
            "id": str(r.id),
            "name": r.name,
            "completed_tasks": r.completed_tasks or 0,
            "total_rewards": float(r.total_rewards or 0),
        }
        for r in rows
    ]


@router.get("/dashboard/task-distribution", summary="管理员仪表盘 — 任务分布")
def dashboard_task_distribution(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """兼容 v1 /api/v1/dashboard/task-distribution"""
    from platform_v8.storage.repo import workloads_t
    # we_workloads 没有 type 列，返回空（后续从 spec 解析）
    return []


@router.get("/dashboard/node-distribution", summary="管理员仪表盘 — 节点分布")
def dashboard_node_distribution(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """兼容 v1 /api/v1/dashboard/node-distribution — 从 we_workers 表读取"""
    from platform_v8.storage.repo import workers_t

    # by status
    status_rows = session.execute(
        select(workers_t.c.status, func.count().label("cnt"))
        .group_by(workers_t.c.status)
    ).fetchall()
    by_status = [{"name": r.status or "unknown", "value": r.cnt} for r in status_rows]

    return {
        "by_status": by_status,
        "by_platform": [],
        "by_tier": [],
    }


@router.get("/dashboard/", summary="管理员仪表盘 — 全量概览")
def dashboard_overview(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """兼容 v1 /api/v1/dashboard/"""
    stats = dashboard_system_stats(session=session, _admin=_admin)
    recent = dashboard_recent_tasks(limit=10, session=session, _admin=_admin)
    active = dashboard_active_nodes(limit=20, session=session, _admin=_admin)
    task_dist = dashboard_task_distribution(session=session, _admin=_admin)
    node_dist = dashboard_node_distribution(session=session, _admin=_admin)
    return {
        "stats": stats,
        "recent_tasks": recent,
        "active_nodes": active,
        "task_distribution": task_dist,
        "node_distribution": node_dist,
    }


# 重新打开文件，从末尾开始追加新 router
# WARNING: 下面 router 跟上面的 ops router 分开 ── 给管理员前端用（/api/v8/dashboard/*, /api/v8/nodes/*）



@router.get("/nodes", summary="管理员节点列表")
def list_all_nodes(
    status: str = "",
    limit: int = 200,
    offset: int = 0,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """兼容 v1 /api/v1/nodes — 从 we_workers 表读取"""
    from platform_v8.storage.repo import workers_t

    stmt = select(workers_t).order_by(workers_t.c.last_seen.desc().nullslast())
    if status:
        stmt = stmt.where(workers_t.c.status == status.upper())
    rows = session.execute(stmt.offset(offset).limit(limit)).fetchall()

    result = []
    for r in rows:
        stat = (r.status or "").lower()
        result.append({
            "id": r.id,
            "name": r.name,
            "owner_id": r.owner_id,
            "status": (r.status or "").lower(),
            "load_rate": float(getattr(r, "load", 0) or 0),
            "capability_score": r.capability_score or 0,
            "reputation": r.reputation or 0.0,
            "client_version": r.client_version or "",
            "last_heartbeat": r.last_seen.isoformat() if r.last_seen else None,
            "created_at": r.registered_at.isoformat() if r.registered_at else None,
            "current_cpu_usage": 0,
            "current_memory_usage": 0,
            "current_gpu_usage": 0,
            "cpu_cores": 0,
            "memory_gb": 0,
            "gpu_count": 0,
            "platform": "",
            "hostname": r.name,
            "os": "",
            "os_version": "",
            "owner_username": "",
            "owner_email": "",
        })
    return result


@router.get("/nodes/my-devices", summary="用户设备列表")
def get_my_devices(
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """兼容 v1 /api/v1/nodes/my-devices"""
    from platform_v8.storage.repo import workers_t, accounts_t
    rows = session.execute(
        select(workers_t, accounts_t.c.username, accounts_t.c.email)
        .outerjoin(accounts_t, workers_t.c.owner_id == accounts_t.c.id)
        .order_by(workers_t.c.last_seen.desc().nullslast())
    ).fetchall()
    result = []
    for r in rows:
        result.append({
            "id": r.id,
            "name": r.name,
            "owner_id": r.owner_id,
            "status": (r.status or "").lower(),
            "load_rate": float(getattr(r, "load", 0) or 0),
            "client_version": r.client_version or "",
            "last_heartbeat": r.last_seen.isoformat() if r.last_seen else None,
            "owner_username": r.username or "",
            "owner_email": r.email or "",
        })
    return result


@router.get("/nodes/{node_id}", summary="管理员节点详情")
def get_node_detail(
    node_id: str,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """兼容 v1 /api/v1/nodes/{id}"""
    from platform_v8.storage.repo import workers_t
    row = session.execute(
        select(workers_t).where(workers_t.c.id == node_id)
    ).one_or_none()
    if not row:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="node not found")
    return {
        "id": row.id,
        "name": row.name,
        "owner_id": row.owner_id,
        "status": row.status,
        "load_rate": row.load_rate or 0.0,
        "capability_score": row.capability_score or 0,
        "reputation_score": row.reputation or 0.0,
        "client_version": row.client_version or "",
        "last_heartbeat": row.last_seen.isoformat() if row.last_seen else None,
        "created_at": row.registered_at.isoformat() if row.registered_at else None,
    }


@router.put("/nodes/{node_id}", summary="管理员更新节点")
def update_node(
    node_id: str,
    body: dict,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """兼容 v1 PUT /api/v1/nodes/{id}"""
    from platform_v8.storage.repo import workers_t
    from sqlalchemy import update
    data = {k: v for k, v in body.items() if k in ("status", "name")}
    if data:
        session.execute(
            update(workers_t).where(workers_t.c.id == node_id).values(**data)
        )
        session.commit()
    return {"ok": True}


@router.delete("/nodes/{node_id}", summary="管理员删除节点")
def delete_node(
    node_id: str,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """兼容 v1 DELETE /api/v1/nodes/{id}"""
    from platform_v8.storage.repo import workers_t
    from sqlalchemy import delete
    session.execute(delete(workers_t).where(workers_t.c.id == node_id))
    session.commit()
    return {"ok": True}
