"""RunSession：关联 workload + 主动 settle（不改引擎）。"""
from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import insert, select, update
from sqlalchemy.orm import Session

from platform_v8.services.marketplace import apps as apps_svc
from platform_v8.services.marketplace import billing as billing_svc
from platform_v8.services.marketplace import lending as lending_svc
from platform_v8.storage.repo import apps_t, app_sessions_t, installs_t, workloads_t

logger = logging.getLogger(__name__)


class SessionError(Exception):
    pass


def _row(m) -> dict[str, Any]:
    d = dict(m)
    for k, v in list(d.items()):
        if isinstance(v, Decimal):
            d[k] = float(v)
        elif isinstance(v, datetime):
            d[k] = v.isoformat()
        elif isinstance(v, UUID):
            d[k] = str(v)
    return d


def create_session(
    s: Session,
    *,
    slug: str,
    user_id: int,
    exec_mode: str = "local",
    input_ref: str | None = None,
    name: str | None = None,
    budget: float | None = None,
    meta: dict | None = None,
) -> dict[str, Any]:
    mode = (exec_mode or "local").lower()
    if mode not in ("local", "edge", "deep_link"):
        raise SessionError("exec_mode 须为 local|edge|deep_link")

    # 确保已安装（one_time/monthly 在 install 扣款；per_use 安装免费）
    try:
        apps_svc.ensure_monthly_subscription(s, slug, user_id)
    except apps_svc.MarketplaceError as exc:
        raise SessionError(str(exc)) from exc
    app = apps_svc.get_by_slug(s, slug)
    pricing = str(app.get("pricing_model") or "free").lower()
    if pricing == "monthly":
        # ensure_monthly_subscription 已续费或确认有效；再防御性检查一次
        from platform_v8.storage.repo import installs_t
        from sqlalchemy import select as _select

        inst = s.execute(
            _select(installs_t).where(
                installs_t.c.app_id == app["id"],
                installs_t.c.user_id == user_id,
            )
        ).mappings().first()
        if not apps_svc.subscription_active(inst):
            raise SessionError("月订阅已过期，请先续费")

    s.execute(
        insert(app_sessions_t).values(
            app_id=app["id"],
            user_id=user_id,
            exec_mode=mode,
            status="created",
            input_ref=input_ref,
            name=name or f"{app.get('name')} run",
            budget=Decimal(str(budget or 0)),
            meta=meta or {},
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
    )
    s.flush()
    row = s.execute(
        select(app_sessions_t)
        .where(app_sessions_t.c.app_id == app["id"], app_sessions_t.c.user_id == user_id)
        .order_by(app_sessions_t.c.id.desc())
        .limit(1)
    ).mappings().first()
    if not row:
        raise SessionError("创建 session 失败")
    apps_svc.mark_used(s, slug, user_id)
    out = _row(row)
    out["app"] = app
    out["run_hint"] = apps_svc.build_run_hint(app)
    out["workload_submit_path"] = "/api/v8/workloads"
    out["session_id"] = out["id"]
    return out


def get_session(s: Session, session_id: int, *, user_id: int | None = None) -> dict[str, Any]:
    row = s.execute(
        select(app_sessions_t).where(app_sessions_t.c.id == session_id)
    ).mappings().first()
    if not row:
        raise SessionError("session 不存在")
    if user_id is not None and int(row["user_id"]) != int(user_id):
        raise SessionError("无权访问该 session")
    out = _row(row)
    out["session_id"] = out["id"]
    slug = s.execute(select(apps_t.c.slug).where(apps_t.c.id == row["app_id"])).scalar()
    if slug:
        try:
            out["app"] = apps_svc.get_by_slug(s, str(slug), include_unpublished=True)
        except apps_svc.AppNotFound:
            out["app"] = {"id": row["app_id"], "slug": slug}
    return out


def bind_workload(
    s: Session, session_id: int, *, user_id: int, workload_id: str,
) -> dict[str, Any]:
    sess = get_session(s, session_id, user_id=user_id)
    if sess["status"] in ("settled", "canceled"):
        raise SessionError(f"session 已结束: {sess['status']}")
    s.execute(
        update(app_sessions_t)
        .where(app_sessions_t.c.id == session_id)
        .values(
            workload_id=str(workload_id),
            status="running",
            updated_at=datetime.utcnow(),
        )
    )
    s.flush()
    return get_session(s, session_id, user_id=user_id)


def cancel_session(s: Session, session_id: int, *, user_id: int) -> dict[str, Any]:
    sess = get_session(s, session_id, user_id=user_id)
    if sess["status"] == "settled":
        return sess
    s.execute(
        update(app_sessions_t)
        .where(app_sessions_t.c.id == session_id)
        .values(status="canceled", updated_at=datetime.utcnow())
    )
    s.flush()
    return get_session(s, session_id, user_id=user_id)


def _workload_status(s: Session, workload_id: str | None) -> str | None:
    if not workload_id:
        return None
    row = s.execute(
        select(workloads_t.c.status).where(workloads_t.c.id == str(workload_id))
    ).scalar()
    return str(row) if row else None


def settle_session(s: Session, session_id: int, *, user_id: int | None = None) -> dict[str, Any]:
    """
    主动结算：
    - per_use：workload DONE 后扣应用费
    - edge：按 shard 时长写出借收益 + ledger
    - 幂等：重复 settle 不双扣
    """
    sess = get_session(s, session_id, user_id=user_id)
    if sess["status"] == "settled":
        return {**sess, "already_settled": True, "ok": True}

    if sess["status"] == "canceled":
        raise SessionError("已取消的 session 不可结算")

    app = sess.get("app")
    if not app:
        raise SessionError("session 缺少应用信息")
    pricing = str(app.get("pricing_model") or "free").lower()
    wl_status = _workload_status(s, sess.get("workload_id"))

    terminal_ok = False
    terminal_fail = False
    if not sess.get("workload_id"):
        # 仅 deep_link 允许无 workload 直接结算；local/edge 必须先 bind
        if sess.get("exec_mode") == "deep_link":
            terminal_ok = True
        else:
            return {
                **sess,
                "ok": False,
                "pending": True,
                "message": "请先绑定 workload_id",
            }
    else:
        st = (wl_status or "").upper()
        terminal_ok = st in ("DONE", "COMPLETED", "SUCCESS")
        terminal_fail = st in ("FAILED", "CANCELED", "CANCELLED", "ERROR")

    if sess.get("workload_id") and not terminal_ok and not terminal_fail:
        return {
            **sess,
            "ok": False,
            "pending": True,
            "workload_status": wl_status,
            "message": "workload 尚未结束",
        }

    app_charged = Decimal("0")
    edge_info: dict[str, Any] = {"settled_shards": 0, "gross": 0.0}

    if not terminal_fail:
        if pricing == "per_use":
            price = Decimal(str(app.get("price") or 0))
            trials = int(app.get("free_trials") or 0)
            use_count = s.execute(
                select(installs_t.c.use_count).where(
                    installs_t.c.app_id == app["id"],
                    installs_t.c.user_id == sess["user_id"],
                )
            ).scalar() or 0
            if price > 0 and int(use_count) > trials:
                try:
                    charged = billing_svc.charge_per_use_session(
                        s,
                        user_id=int(sess["user_id"]),
                        app=app,
                        session_id=int(session_id),
                    )
                    app_charged = Decimal(str(charged["charged"]))
                except billing_svc.BillingError as exc:
                    raise SessionError(str(exc)) from exc

        if sess.get("exec_mode") == "edge" and sess.get("workload_id"):
            edge_info = lending_svc.settle_workload_shards(
                s, workload_id=str(sess["workload_id"]),
            )

    meta = dict(sess.get("meta") or {})
    meta.update({
        "workload_status": wl_status,
        "pre_settle_status": "failed" if terminal_fail else "done",
        "lending": edge_info,
    })
    s.execute(
        update(app_sessions_t)
        .where(app_sessions_t.c.id == session_id)
        .values(
            status="settled",
            app_charged=app_charged,
            edge_charged=Decimal(str(edge_info.get("gross") or 0)),
            settled_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
            meta=meta,
        )
    )
    s.flush()
    out = get_session(s, session_id, user_id=user_id)
    out["ok"] = True
    out["app_charged"] = float(app_charged)
    out["lending"] = edge_info
    return out


def list_billing_me(s: Session, user_id: int, *, limit: int = 50) -> dict[str, Any]:
    rows = s.execute(
        select(app_sessions_t)
        .where(app_sessions_t.c.user_id == user_id)
        .order_by(app_sessions_t.c.created_at.desc())
        .limit(limit)
    ).mappings().all()
    items = []
    for r in rows:
        d = _row(r)
        slug = s.execute(select(apps_t.c.slug).where(apps_t.c.id == r["app_id"])).scalar()
        d["app_slug"] = slug
        d["session_id"] = d["id"]
        items.append(d)
    return {"items": items, "total": len(items)}
