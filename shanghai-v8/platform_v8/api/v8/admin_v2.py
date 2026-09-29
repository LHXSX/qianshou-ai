"""
Admin v2 API · 全套管理员 endpoint

设计要点:
  - 所有接口 require admin 角色 (get_admin_account)
  - 写操作自动记入 we_audit
  - 配置类持久化到 we_kv
  - 复用已有 services: economy/split/ledger/reputation/capability_match
"""
from __future__ import annotations
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Body
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.core import Account

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/admin/v2", tags=["admin-v2"])


# ════════════════════════════════════════════════════════════════════
# 工具: 角色守卫 + 审计写入
# ════════════════════════════════════════════════════════════════════
def require_admin(current: Account = Depends(get_current_account)) -> Account:
    """强制 admin 角色"""
    # current.role 是 AccountRole enum; 用 is_admin 属性更稳
    role_str = getattr(current.role, "value", str(current.role)).lower()
    if not (getattr(current, "is_admin", False) or role_str in ("admin", "super_admin", "accountrole.admin")):
        raise HTTPException(status_code=403, detail=f"需要管理员权限 (current role: {role_str})")
    return current


def write_audit(
    session: Session, *, actor: Account, action: str,
    target_kind: str = "", target_id: str = "",
    detail: dict | None = None,
) -> None:
    """统一审计日志写入"""
    session.execute(text("""
        INSERT INTO we_audit (id, actor_account_id, actor_kind, action, target_kind, target_id, detail, created_at)
        VALUES (gen_random_uuid(), :uid, 'admin', :action, :tkind, :tid, :detail, NOW())
    """), {
        "uid": actor.id, "action": action,
        "tkind": target_kind, "tid": str(target_id),
        "detail": __import__("json").dumps(detail or {}, default=str, ensure_ascii=False),
    })


def kv_get(session: Session, key: str, default: Any = None) -> Any:
    r = session.execute(text("SELECT v FROM we_kv WHERE k = :k"), {"k": key}).first()
    return r[0] if r else default


def kv_set(session: Session, key: str, value: Any) -> None:
    import json
    session.execute(text("""
        INSERT INTO we_kv (k, v, updated_at) VALUES (:k, CAST(:v AS jsonb), NOW())
        ON CONFLICT (k) DO UPDATE SET v = CAST(:v AS jsonb), updated_at = NOW()
    """), {"k": key, "v": json.dumps(value, default=str, ensure_ascii=False)})


# ════════════════════════════════════════════════════════════════════
# ① 平台总览 Dashboard
# ════════════════════════════════════════════════════════════════════
@router.get("/dashboard")
def admin_dashboard(
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """6 大 KPI + 24h 趋势 + 告警"""
    now = datetime.now(timezone.utc)
    day_ago = now - timedelta(days=1)

    # 6 KPI
    kpi = session.execute(text("""
        SELECT
            (SELECT COUNT(*) FROM we_workers) AS nodes_total,
            (SELECT COUNT(*) FROM we_workers WHERE status IN ('ONLINE','BUSY')) AS nodes_online,
            (SELECT COUNT(*) FROM we_accounts WHERE status='active') AS users,
            (SELECT COUNT(*) FROM we_workloads WHERE created_at >= :day_ago) AS tasks_24h,
            (SELECT COALESCE(SUM(amount), 0) FROM we_ledger WHERE created_at >= :day_ago AND amount > 0) AS revenue_24h,
            (SELECT COUNT(*) FROM we_models) AS models_total
    """), {"day_ago": day_ago}).mappings().first()

    # 待处理告警 (卡住 workload + 低信誉节点)
    alerts = []
    stuck = session.execute(text("""
        SELECT id, name, status, created_at
        FROM we_workloads
        WHERE status IN ('CREATED', 'PLANNED', 'RUNNING')
          AND created_at < NOW() - interval '5 minutes'
        ORDER BY created_at LIMIT 5
    """)).mappings().all()
    for w in stuck:
        alerts.append({
            "level": "warn", "kind": "stuck_workload",
            "message": f"任务 {w['name']} 已卡 {int((now - w['created_at']).total_seconds() / 60)} 分钟",
            "ref_id": str(w["id"]),
        })

    bad_workers = session.execute(text("""
        SELECT id, name, reputation FROM we_workers
        WHERE reputation < 0.3 AND status IN ('ONLINE','BUSY')
        ORDER BY reputation LIMIT 5
    """)).mappings().all()
    for w in bad_workers:
        alerts.append({
            "level": "error", "kind": "low_reputation",
            "message": f"节点 {w['name']} 信誉过低 ({w['reputation']:.2f})",
            "ref_id": str(w["id"]),
        })

    # 24h 收入趋势 (按小时)
    revenue_trend = session.execute(text("""
        SELECT
            DATE_TRUNC('hour', created_at) AS hour,
            COALESCE(SUM(amount), 0) AS amount,
            COUNT(*) AS count
        FROM we_ledger
        WHERE created_at >= :day_ago AND amount > 0
        GROUP BY hour ORDER BY hour
    """), {"day_ago": day_ago}).mappings().all()

    return {
        "ok": True,
        "kpi": {
            "nodes_total": int(kpi["nodes_total"] or 0),
            "nodes_online": int(kpi["nodes_online"] or 0),
            "users": int(kpi["users"] or 0),
            "tasks_24h": int(kpi["tasks_24h"] or 0),
            "revenue_24h": float(kpi["revenue_24h"] or 0),
            "models_total": int(kpi["models_total"] or 0),
            "alerts": len(alerts),
        },
        "alerts": alerts,
        "revenue_trend": [{
            "hour": r["hour"].isoformat() if r["hour"] else None,
            "amount": float(r["amount"]),
            "count": int(r["count"]),
        } for r in revenue_trend],
        "generated_at": now.isoformat(),
    }


# ════════════════════════════════════════════════════════════════════
# ② 用户管理 CRUD + 状态机
# ════════════════════════════════════════════════════════════════════
@router.get("/users")
def list_users(
    status: str = Query("all"),
    role: str = Query("all"),
    q: str = Query(""),
    page: int = Query(1, ge=1),
    size: int = Query(20, le=100),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """用户列表 + 过滤 + 分页"""
    where_parts = ["1=1"]
    params: dict[str, Any] = {"size": size, "offset": (page - 1) * size}

    if status != "all":
        where_parts.append("status = :status")
        params["status"] = status
    if role != "all":
        where_parts.append("role = :role")
        params["role"] = role
    if q:
        where_parts.append("(LOWER(username) LIKE :q OR LOWER(email) LIKE :q)")
        params["q"] = f"%{q.lower()}%"

    where = " AND ".join(where_parts)

    total = session.execute(
        text(f"SELECT COUNT(*) FROM we_accounts WHERE {where}"), params
    ).scalar() or 0

    rows = session.execute(text(f"""
        SELECT
            a.id, a.username, a.email, a.role, a.status, a.balance,
            a.created_at, a.last_login_at,
            (SELECT COUNT(*) FROM we_workers WHERE owner_id = a.id) AS node_count,
            (SELECT COALESCE(SUM(amount), 0) FROM we_ledger WHERE account_id = a.id AND amount > 0) AS total_earned
        FROM we_accounts a
        WHERE {where}
        ORDER BY a.id DESC
        LIMIT :size OFFSET :offset
    """), params).mappings().all()

    return {
        "ok": True, "total": int(total), "page": page, "size": size,
        "users": [{
            "id": r["id"],
            "username": r["username"],
            "email": r["email"],
            "role": r["role"],
            "status": r["status"],
            "balance": float(r["balance"] or 0),
            "node_count": int(r["node_count"]),
            "total_earned": float(r["total_earned"]),
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "last_login_at": r["last_login_at"].isoformat() if r["last_login_at"] else None,
        } for r in rows],
    }


@router.get("/users/stats")
def users_stats(
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """用户状态分布 (用于 Tab counts)"""
    by_status = session.execute(text("""
        SELECT status, COUNT(*) AS n FROM we_accounts GROUP BY status
    """)).mappings().all()
    by_role = session.execute(text("""
        SELECT role, COUNT(*) AS n FROM we_accounts GROUP BY role
    """)).mappings().all()
    return {
        "ok": True,
        "by_status": {r["status"]: int(r["n"]) for r in by_status},
        "by_role": {r["role"]: int(r["n"]) for r in by_role},
        "total": sum(int(r["n"]) for r in by_status),
    }


@router.post("/users/{user_id}/recharge")
def recharge(
    user_id: int,
    body: dict = Body(...),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """手动充值"""
    amount = Decimal(str(body.get("amount", 0)))
    reason = body.get("reason", "")
    if amount <= 0:
        raise HTTPException(400, "金额必须 > 0")
    if not reason:
        raise HTTPException(400, "必填理由")

    # 检查用户存在
    user = session.execute(text("SELECT id, balance FROM we_accounts WHERE id = :uid"),
                           {"uid": user_id}).mappings().first()
    if not user:
        raise HTTPException(404, "用户不存在")

    # 写 ledger + 更新 balance
    import json
    session.execute(text("""
        INSERT INTO we_ledger (id, account_id, type, amount, currency, note, metadata, idempotent_key, created_at)
        VALUES (gen_random_uuid(), :uid, 'DEPOSIT', :amt, 'CNY', :note,
                CAST(:meta AS jsonb), :ikey, NOW())
    """), {
        "uid": user_id, "amt": amount,
        "note": f"管理员充值: {reason}",
        "meta": json.dumps({"admin_id": current.id, "reason": reason}),
        "ikey": f"admin-recharge-{uuid4()}",
    })
    session.execute(text("UPDATE we_accounts SET balance = balance + :amt WHERE id = :uid"),
                    {"amt": amount, "uid": user_id})

    write_audit(session, actor=current, action="user.recharge",
                target_kind="user", target_id=str(user_id),
                detail={"amount": float(amount), "reason": reason})
    return {"ok": True, "new_balance": float(user["balance"] + amount)}


@router.post("/users/{user_id}/deduct")
def deduct(
    user_id: int, body: dict = Body(...),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """手动扣款"""
    amount = Decimal(str(body.get("amount", 0)))
    reason = body.get("reason", "")
    if amount <= 0: raise HTTPException(400, "金额 > 0")
    if not reason: raise HTTPException(400, "必填理由")

    user = session.execute(text("SELECT balance FROM we_accounts WHERE id = :uid"),
                           {"uid": user_id}).mappings().first()
    if not user: raise HTTPException(404, "用户不存在")
    if float(user["balance"]) < float(amount):
        raise HTTPException(400, f"余额不足 (当前 {user['balance']})")

    import json
    session.execute(text("""
        INSERT INTO we_ledger (id, account_id, type, amount, currency, note, metadata, idempotent_key, created_at)
        VALUES (gen_random_uuid(), :uid, 'WITHDRAW', :amt, 'CNY', :note,
                CAST(:meta AS jsonb), :ikey, NOW())
    """), {
        "uid": user_id, "amt": -amount,
        "note": f"管理员扣款: {reason}",
        "meta": json.dumps({"admin_id": current.id, "reason": reason}),
        "ikey": f"admin-deduct-{uuid4()}",
    })
    session.execute(text("UPDATE we_accounts SET balance = balance - :amt WHERE id = :uid"),
                    {"amt": amount, "uid": user_id})

    write_audit(session, actor=current, action="user.deduct",
                target_kind="user", target_id=str(user_id),
                detail={"amount": float(amount), "reason": reason})
    return {"ok": True, "new_balance": float(user["balance"]) - float(amount)}


@router.post("/users/{user_id}/status")
def change_user_status(
    user_id: int, body: dict = Body(...),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """改用户状态 (normal/warning/sandbox/banned/deleted)"""
    new_status = body.get("status", "")
    reason = body.get("reason", "")
    if new_status not in ("active", "warning", "sandbox", "banned", "deleted"):
        raise HTTPException(400, "无效状态")
    if not reason: raise HTTPException(400, "必填理由")

    session.execute(text("UPDATE we_accounts SET status = :s WHERE id = :uid"),
                    {"s": new_status, "uid": user_id})
    write_audit(session, actor=current, action=f"user.status.{new_status}",
                target_kind="user", target_id=str(user_id),
                detail={"reason": reason, "new_status": new_status})
    return {"ok": True, "status": new_status}


@router.post("/users/{user_id}/role")
def change_user_role(
    user_id: int, body: dict = Body(...),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """改用户角色"""
    role = body.get("role", "")
    if role not in ("personal", "enterprise", "admin", "user"):
        raise HTTPException(400, "无效角色")
    session.execute(text("UPDATE we_accounts SET role = :r WHERE id = :uid"),
                    {"r": role, "uid": user_id})
    write_audit(session, actor=current, action="user.role_change",
                target_kind="user", target_id=str(user_id), detail={"role": role})
    return {"ok": True, "role": role}


# ════════════════════════════════════════════════════════════════════
# ③ 经济中枢 (分润 + 定价 + 风险池)
# ════════════════════════════════════════════════════════════════════
DEFAULT_SPLIT = {"node": 70, "platform": 20, "risk_pool": 10}
DEFAULT_PRICING = {
    "sd-txt2img": 3.0, "sd-img2img": 3.0, "sam-segment": 0.5,
    "lama-erase": 1.0, "gfpgan-restore": 2.0, "esrgan-upscale": 1.5,
    "whisper-stt": 0.1, "kolors-txt2img": 5.0,
}
DEFAULT_LEVELS = {"basic": 1.0, "bronze": 1.1, "silver": 1.2, "gold": 1.3, "diamond": 1.5}
DEFAULT_WITHDRAW = {"min": 100, "fee_pct": 2, "daily_cap": 10000, "auto_approve_under": 100}


@router.get("/economy/rules")
def get_economy_rules(
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """获取全平台经济规则"""
    return {
        "ok": True,
        "split": kv_get(session, "economy:split", DEFAULT_SPLIT),
        "pricing": kv_get(session, "economy:pricing", DEFAULT_PRICING),
        "levels": kv_get(session, "economy:levels", DEFAULT_LEVELS),
        "withdraw": kv_get(session, "economy:withdraw", DEFAULT_WITHDRAW),
    }


@router.put("/economy/rules")
def update_economy_rules(
    body: dict = Body(...),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """一键更新规则 (split/pricing/levels/withdraw 任选)"""
    changed = []
    for key in ("split", "pricing", "levels", "withdraw"):
        if key in body:
            # split 校验 100%
            if key == "split":
                v = body[key]
                total = sum(v.values())
                if abs(total - 100) > 0.01:
                    raise HTTPException(400, f"分润总和必须 = 100% (当前 {total})")
            kv_set(session, f"economy:{key}", body[key])
            changed.append(key)

    write_audit(session, actor=current, action="economy.rules.update",
                detail={"changed": changed, "new_values": {k: body[k] for k in changed}})
    return {"ok": True, "changed": changed}


@router.get("/economy/overview")
def economy_overview(
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """经济中心总览 KPI"""
    now = datetime.now(timezone.utc)
    day_ago = now - timedelta(days=1)

    r = session.execute(text("""
        SELECT
            (SELECT COALESCE(SUM(amount), 0) FROM we_ledger WHERE amount > 0) AS total_in,
            (SELECT COALESCE(SUM(-amount), 0) FROM we_ledger WHERE amount < 0) AS total_out,
            (SELECT COALESCE(SUM(amount), 0) FROM we_ledger WHERE created_at >= :day_ago AND amount > 0) AS day_in,
            (SELECT COALESCE(SUM(balance), 0) FROM we_accounts) AS user_holdings,
            (SELECT COUNT(*) FROM we_ledger WHERE created_at >= :day_ago) AS day_txn
    """), {"day_ago": day_ago}).mappings().first()

    return {
        "ok": True,
        "total_in": float(r["total_in"]),
        "total_out": float(r["total_out"]),
        "day_in": float(r["day_in"]),
        "user_holdings": float(r["user_holdings"]),
        "day_txn_count": int(r["day_txn"]),
        "risk_pool": float(kv_get(session, "economy:risk_pool_balance", 0)),
    }


# ════════════════════════════════════════════════════════════════════
# ④ 全域钱包 (平台账本)
# ════════════════════════════════════════════════════════════════════
@router.get("/wallet/balance-sheet")
def balance_sheet(
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """平台账本资产负债表"""
    now = datetime.now(timezone.utc)
    day_ago = now - timedelta(days=1)

    r = session.execute(text("""
        SELECT
            (SELECT COALESCE(SUM(balance), 0) FROM we_accounts) AS user_holdings,
            (SELECT COALESCE(SUM(amount), 0) FROM we_ledger WHERE amount > 0 AND type IN ('REWARD','EARN')) AS settled,
            (SELECT COALESCE(SUM(-amount), 0) FROM we_ledger WHERE type = 'ESCROW_HOLD') AS escrow_hold,
            (SELECT COALESCE(SUM(amount), 0) FROM we_ledger WHERE created_at >= :day_ago AND amount > 0) AS day_in,
            (SELECT COALESCE(SUM(-amount), 0) FROM we_ledger WHERE created_at >= :day_ago AND amount < 0) AS day_out
    """), {"day_ago": day_ago}).mappings().first()

    return {
        "ok": True,
        "user_holdings": float(r["user_holdings"]),
        "settled_rewards": float(r["settled"]),
        "escrow_hold": float(r["escrow_hold"]),
        "day_in": float(r["day_in"]),
        "day_out": float(r["day_out"]),
        "risk_pool": float(kv_get(session, "economy:risk_pool_balance", 0)),
    }


@router.get("/wallet/users")
def all_user_wallets(
    sort: str = "balance",
    page: int = Query(1, ge=1),
    size: int = Query(50, le=200),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """全平台用户钱包列表"""
    order = "balance DESC" if sort == "balance" else "created_at DESC"
    offset = (page - 1) * size
    total = session.execute(text("SELECT COUNT(*) FROM we_accounts")).scalar() or 0
    rows = session.execute(text(f"""
        SELECT id, username, role, balance, last_login_at
        FROM we_accounts ORDER BY {order} LIMIT :size OFFSET :offset
    """), {"size": size, "offset": offset}).mappings().all()
    return {
        "ok": True, "total": int(total), "page": page, "size": size,
        "items": [{
            "id": r["id"], "username": r["username"], "role": r["role"],
            "balance": float(r["balance"] or 0),
            "last_login_at": r["last_login_at"].isoformat() if r["last_login_at"] else None,
        } for r in rows],
    }


@router.get("/wallet/transactions")
def all_transactions(
    type: str = "all", q: str = "",
    page: int = Query(1, ge=1), size: int = Query(50, le=200),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """全平台流水"""
    where = ["1=1"]
    params: dict = {"size": size, "offset": (page - 1) * size}
    if type != "all":
        where.append("type = :type")
        params["type"] = type
    if q:
        where.append("(note ILIKE :q OR CAST(account_id AS TEXT) = :q2)")
        params["q"] = f"%{q}%"
        params["q2"] = q

    w = " AND ".join(where)
    total = session.execute(text(f"SELECT COUNT(*) FROM we_ledger WHERE {w}"), params).scalar() or 0
    rows = session.execute(text(f"""
        SELECT l.id, l.account_id, a.username, l.type, l.amount, l.currency,
               l.note, l.created_at, l.workload_id
        FROM we_ledger l
        LEFT JOIN we_accounts a ON a.id = l.account_id
        WHERE {w}
        ORDER BY l.created_at DESC
        LIMIT :size OFFSET :offset
    """), params).mappings().all()
    return {
        "ok": True, "total": int(total), "page": page, "size": size,
        "items": [{
            "id": str(r["id"]), "account_id": r["account_id"], "username": r["username"],
            "type": r["type"], "amount": float(r["amount"]), "currency": r["currency"],
            "note": r["note"], "workload_id": str(r["workload_id"]) if r["workload_id"] else None,
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        } for r in rows],
    }


# ════════════════════════════════════════════════════════════════════
# ⑤ 日报中心 (从 we_kv 读 daily_report)
# ════════════════════════════════════════════════════════════════════
@router.get("/daily-report")
def list_daily_reports(
    days: int = Query(30, le=365),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """近 N 天的日报列表"""
    rows = session.execute(text("""
        SELECT k, v FROM we_kv
        WHERE k LIKE 'daily_report:%'
        ORDER BY k DESC LIMIT :limit
    """), {"limit": days}).mappings().all()
    return {
        "ok": True,
        "items": [{
            "date": r["k"].replace("daily_report:", ""),
            "data": r["v"],
        } for r in rows],
    }


# ════════════════════════════════════════════════════════════════════
# ⑥ 调度大盘 + 步骤追踪
# ════════════════════════════════════════════════════════════════════
@router.get("/dispatch/load")
def dispatch_load(
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """调度引擎实时负荷 (全字段都真分桶 · 大屏直接消费 · 无需前端 random 补估)"""
    now = datetime.now(timezone.utc)

    # 单次扫表 · 一次 SQL 出全部分桶 (8 个 status FILTER + 时长统计)
    r = session.execute(text("""
        SELECT
            COUNT(*) FILTER (WHERE status = 'CREATED') AS created,
            COUNT(*) FILTER (WHERE status = 'PLANNED') AS planned,
            COUNT(*) FILTER (WHERE status IN ('CREATED','PLANNED')) AS in_queue,
            COUNT(*) FILTER (WHERE status = 'RUNNING') AS in_flight,
            COUNT(*) FILTER (WHERE status = 'WAITING_FOR_WORKERS') AS waiting,
            COUNT(*) FILTER (WHERE status = 'DONE' AND completed_at >= NOW() - interval '1 hour') AS done_1h,
            COUNT(*) FILTER (WHERE status = 'FAILED' AND completed_at >= NOW() - interval '1 hour') AS failed_1h,
            COUNT(*) FILTER (WHERE status = 'CANCELLED' AND completed_at >= NOW() - interval '1 hour') AS cancelled_1h,
            COUNT(*) FILTER (WHERE status IN ('CREATED','PLANNED','RUNNING') AND created_at < NOW() - interval '5 minutes') AS stuck,
            -- 真平均吞吐: 1h 完成数 / 60 = 每分钟完成数 (无 random 噪声)
            COUNT(*) FILTER (WHERE status = 'DONE' AND completed_at >= NOW() - interval '1 hour') / 60.0 AS throughput_per_min,
            -- 真平均时长 (ms): 1h 内 DONE 的 started→completed 间距均值
            COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000) FILTER (
                WHERE status = 'DONE' AND completed_at >= NOW() - interval '1 hour'
                  AND started_at IS NOT NULL AND completed_at IS NOT NULL
            ), 0)::int AS avg_dur_ms_1h
        FROM we_workloads
    """)).mappings().first()

    online_workers = session.execute(text(
        "SELECT COUNT(*) FROM we_workers WHERE status IN ('ONLINE','BUSY')"
    )).scalar() or 0

    # 最近 30 条完成 / 失败 / 运行中 任务 · 含真 dur_ms · 给任务瀑布用
    recent = session.execute(text("""
        SELECT
            w.id, w.name, w.status, w.owner_id,
            a.username AS owner_name,
            w.created_at, w.started_at, w.completed_at,
            CASE
                WHEN w.completed_at IS NOT NULL AND w.started_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (w.completed_at - w.started_at)) * 1000
                WHEN w.started_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (NOW() - w.started_at)) * 1000
                ELSE NULL
            END::int AS dur_ms
        FROM we_workloads w
        LEFT JOIN we_accounts a ON a.id = w.owner_id
        WHERE w.status IN ('DONE','FAILED','RUNNING')
        ORDER BY COALESCE(w.completed_at, w.started_at, w.created_at) DESC
        LIMIT 30
    """)).mappings().all()

    return {
        "ok": True,
        "online_workers": int(online_workers),
        # 真分桶 (前端不再 random 拆)
        "created": int(r["created"]),
        "planned": int(r["planned"]),
        "in_queue": int(r["in_queue"]),
        "in_flight": int(r["in_flight"]),
        "waiting": int(r["waiting"]),
        "done_1h": int(r["done_1h"]),
        "failed_1h": int(r["failed_1h"]),
        "cancelled_1h": int(r["cancelled_1h"]),
        "stuck": int(r["stuck"]),
        # 真吞吐 + 真时长
        "throughput_per_min": round(float(r["throughput_per_min"]), 2),
        "avg_dur_ms_1h": int(r["avg_dur_ms_1h"]),
        # 任务瀑布 · 真数据
        "recent": [
            {
                "id": str(it["id"]),
                "name": it["name"],
                "status": it["status"],
                "owner_name": it["owner_name"] or "unknown",
                "dur_ms": int(it["dur_ms"]) if it["dur_ms"] is not None else None,
                "started_at": it["started_at"].isoformat() if it["started_at"] else None,
                "completed_at": it["completed_at"].isoformat() if it["completed_at"] else None,
            }
            for it in recent
        ],
        "ts": now.isoformat(),
    }


@router.get("/dispatch/stuck")
def stuck_workloads(
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """卡住的 workload 列表"""
    rows = session.execute(text("""
        SELECT id, name, status, owner_id, created_at, started_at,
               EXTRACT(EPOCH FROM (NOW() - created_at))::int AS waited_sec
        FROM we_workloads
        WHERE status IN ('CREATED', 'PLANNED', 'RUNNING', 'WAITING_FOR_WORKERS')
          AND created_at < NOW() - interval '2 minutes'
        ORDER BY created_at LIMIT 50
    """)).mappings().all()
    return {
        "ok": True,
        "items": [{
            "id": str(r["id"]), "name": r["name"], "status": r["status"],
            "owner_id": r["owner_id"],
            "waited_seconds": int(r["waited_sec"]),
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        } for r in rows],
    }


@router.get("/workloads/{workload_id}/timeline")
def workload_timeline(
    workload_id: str,
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """单 workload 完整步骤时间轴 (从 we_audit + we_shards 综合)"""
    # workload 主信息
    w = session.execute(text("""
        SELECT w.*, a.username
        FROM we_workloads w
        LEFT JOIN we_accounts a ON a.id = w.owner_id
        WHERE w.id = :wid
    """), {"wid": workload_id}).mappings().first()
    if not w:
        raise HTTPException(404, "workload 不存在")

    # 所有 shards
    shards = session.execute(text("""
        SELECT s.*, worker.name AS worker_name
        FROM we_shards s
        LEFT JOIN we_workers worker ON worker.id = s.worker_id
        WHERE s.workload_id = :wid
        ORDER BY s.index
    """), {"wid": workload_id}).mappings().all()

    # we_audit 中此 workload 相关的事件
    events = session.execute(text("""
        SELECT * FROM we_audit
        WHERE target_id = :wid AND target_kind IN ('workload', 'shard')
        ORDER BY created_at
    """), {"wid": workload_id}).mappings().all()

    return {
        "ok": True,
        "workload": {
            "id": str(w["id"]), "name": w["name"], "status": w["status"],
            "owner_id": w["owner_id"], "owner": w["username"],
            "spec": w["spec"], "budget": float(w["budget"]),
            "created_at": w["created_at"].isoformat() if w["created_at"] else None,
            "started_at": w["started_at"].isoformat() if w["started_at"] else None,
            "completed_at": w["completed_at"].isoformat() if w["completed_at"] else None,
        },
        "shards": [{
            "id": str(s["id"]), "index": s["index"], "status": s["status"],
            "worker_id": str(s["worker_id"]) if s["worker_id"] else None,
            "worker_name": s["worker_name"], "attempts": s["attempts"],
            "elapsed_ms": s["elapsed_ms"], "error": s["error"],
            "dispatched_at": s["dispatched_at"].isoformat() if s["dispatched_at"] else None,
            "completed_at": s["completed_at"].isoformat() if s["completed_at"] else None,
        } for s in shards],
        "events": [{
            "ts": e["created_at"].isoformat(),
            "action": e["action"], "actor": e["actor_account_id"],
            "detail": e["detail"],
        } for e in events],
    }


# ════════════════════════════════════════════════════════════════════
# ⑦ 节点池
# ════════════════════════════════════════════════════════════════════
@router.get("/workers")
def list_all_workers(
    status: str = "all", q: str = "",
    page: int = Query(1, ge=1), size: int = Query(50, le=200),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    where = ["1=1"]
    params: dict = {"size": size, "offset": (page - 1) * size}
    if status != "all":
        where.append("LOWER(w.status) = :status")
        params["status"] = status.lower()
    if q:
        where.append("(LOWER(w.name) ILIKE :q OR CAST(w.id AS TEXT) ILIKE :q)")
        params["q"] = f"%{q.lower()}%"
    w = " AND ".join(where)

    total = session.execute(text(f"SELECT COUNT(*) FROM we_workers w WHERE {w}"), params).scalar() or 0
    rows = session.execute(text(f"""
        SELECT w.id, w.name, w.owner_id, w.status, w.capabilities,
               w.load, w.reputation, w.capability_score, w.last_seen,
               a.username AS owner_name
        FROM we_workers w
        LEFT JOIN we_accounts a ON a.id = w.owner_id
        WHERE {w}
        ORDER BY w.status, w.reputation DESC
        LIMIT :size OFFSET :offset
    """), params).mappings().all()
    return {
        "ok": True, "total": int(total), "page": page, "size": size,
        "items": [{
            "id": str(r["id"]), "name": r["name"],
            "owner_id": r["owner_id"], "owner_name": r["owner_name"],
            "status": r["status"].lower(),
            "capabilities": r["capabilities"] or {},
            "load_pct": round(float(r["load"] or 0) * 100, 1),
            "reputation": round(float(r["reputation"] or 0.5), 3),
            "capability_score": round(float(r["capability_score"] or 0), 1),
            "last_seen": r["last_seen"].isoformat() if r["last_seen"] else None,
        } for r in rows],
    }


@router.patch("/workers/{worker_id}/reputation")
def adjust_reputation(
    worker_id: str, body: dict = Body(...),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """手动调节点信誉"""
    new_rep = float(body.get("reputation", 0.5))
    reason = body.get("reason", "")
    if not 0 <= new_rep <= 1: raise HTTPException(400, "rep 必须 0-1")
    if not reason: raise HTTPException(400, "必填理由")

    session.execute(text("UPDATE we_workers SET reputation = :r WHERE id = :wid"),
                    {"r": new_rep, "wid": worker_id})
    write_audit(session, actor=current, action="worker.reputation_adjust",
                target_kind="worker", target_id=worker_id,
                detail={"new_reputation": new_rep, "reason": reason})
    return {"ok": True, "reputation": new_rep}


# ════════════════════════════════════════════════════════════════════
# ⑧ AI 神经中枢
# ════════════════════════════════════════════════════════════════════
@router.get("/ai/health")
def ai_health(
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """AI Pipeline 健康度 (从 we_audit AI 相关条目聚合)"""
    now = datetime.now(timezone.utc)
    day_ago = now - timedelta(days=1)

    # 从 audit 查 AI 调用
    ai_calls = session.execute(text("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE action LIKE 'ai_pipeline_done%') AS done,
            COUNT(*) FILTER (WHERE action LIKE 'ai_pipeline_%degraded%') AS degraded,
            COUNT(*) FILTER (WHERE action = 'ai_pipeline_severe_degraded') AS severe
        FROM we_audit
        WHERE action LIKE 'ai_pipeline%' AND created_at >= :day_ago
    """), {"day_ago": day_ago}).mappings().first()

    return {
        "ok": True,
        "calls_24h": int(ai_calls["total"] or 0),
        "done_24h": int(ai_calls["done"] or 0),
        "degraded_24h": int(ai_calls["degraded"] or 0),
        "severe_24h": int(ai_calls["severe"] or 0),
        "success_rate": round(int(ai_calls["done"] or 0) / max(int(ai_calls["total"] or 1), 1) * 100, 1),
    }


@router.get("/ai/prompts")
def get_ai_prompts(
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """获取系统提示词"""
    return {
        "ok": True,
        "system_prompt": kv_get(session, "ai:system_prompt",
                                "你是无极问道 AI,一个分布式算力网络的智能调度官..."),
        "industries": kv_get(session, "ai:industries", {
            "photography": {"name": "摄影", "terms": [], "flows": [], "qa": []},
            "ecommerce": {"name": "电商", "terms": [], "flows": [], "qa": []},
        }),
    }


@router.put("/ai/prompts")
def update_ai_prompts(
    body: dict = Body(...),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """更新系统提示词"""
    changed = []
    if "system_prompt" in body:
        kv_set(session, "ai:system_prompt", body["system_prompt"])
        changed.append("system_prompt")
    if "industries" in body:
        kv_set(session, "ai:industries", body["industries"])
        changed.append("industries")
    write_audit(session, actor=current, action="ai.prompts.update",
                detail={"changed": changed})
    return {"ok": True, "changed": changed}


@router.get("/ai/params")
def get_ai_params(
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """获取 LLM 参数"""
    return {
        "ok": True,
        "params": kv_get(session, "ai:params", {
            "model": "deepseek-v3", "temperature": 0.7, "top_p": 0.9,
            "max_tokens": 4096, "timeout": 30, "retry": 3,
            "fallback": "single_node",
        }),
    }


@router.put("/ai/params")
def update_ai_params(
    body: dict = Body(...),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    kv_set(session, "ai:params", body)
    write_audit(session, actor=current, action="ai.params.update", detail=body)
    return {"ok": True}


# ════════════════════════════════════════════════════════════════════
# ⑨ 审计日志
# ════════════════════════════════════════════════════════════════════
@router.get("/audit")
def list_audit(
    actor: str = "", action: str = "", target_kind: str = "",
    page: int = Query(1, ge=1), size: int = Query(50, le=200),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    where = ["1=1"]
    params: dict = {"size": size, "offset": (page - 1) * size}
    if actor:
        where.append("CAST(actor_account_id AS TEXT) = :actor OR actor_kind = :actor")
        params["actor"] = actor
    if action:
        where.append("action ILIKE :action")
        params["action"] = f"%{action}%"
    if target_kind:
        where.append("target_kind = :tkind")
        params["tkind"] = target_kind
    w = " AND ".join(where)

    total = session.execute(text(f"SELECT COUNT(*) FROM we_audit WHERE {w}"), params).scalar() or 0
    rows = session.execute(text(f"""
        SELECT au.*, a.username
        FROM we_audit au
        LEFT JOIN we_accounts a ON a.id = au.actor_account_id
        WHERE {w}
        ORDER BY au.created_at DESC
        LIMIT :size OFFSET :offset
    """), params).mappings().all()
    return {
        "ok": True, "total": int(total), "page": page, "size": size,
        "items": [{
            "id": str(r["id"]),
            "actor_id": r["actor_account_id"], "actor_name": r["username"], "actor_kind": r["actor_kind"],
            "action": r["action"],
            "target_kind": r["target_kind"], "target_id": r["target_id"],
            "detail": r["detail"], "ip": r["ip"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        } for r in rows],
    }


# ════════════════════════════════════════════════════════════════════
# ⑩ 训练数据
# ════════════════════════════════════════════════════════════════════
@router.get("/training/stats")
def training_stats(
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    """训练数据统计"""
    import os
    from pathlib import Path

    training_dir = Path("/opt/edge/data/training/raw")
    files: list[dict] = []
    if training_dir.exists():
        for f in sorted(training_dir.glob("*.jsonl"), reverse=True)[:30]:
            try:
                with open(f) as fp:
                    lines = sum(1 for _ in fp)
                files.append({
                    "date": f.stem, "lines": lines,
                    "size_kb": round(f.stat().st_size / 1024, 1),
                })
            except Exception:
                pass

    total_lines = sum(f["lines"] for f in files)
    return {
        "ok": True,
        "files": files,
        "total_interactions": total_lines,
    }
