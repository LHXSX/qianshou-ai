"""生态运营台 · OpenAPI / 套餐 / 配额 聚合查询（admin）。"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session


def _pct_delta(cur: float, prev: float) -> float | None:
    if prev <= 0:
        return None if cur <= 0 else 100.0
    return round((cur - prev) / prev * 100.0, 1)


def openapi_dashboard(
    s: Session,
    *,
    day: Optional[date] = None,
    app_id: Optional[int] = None,
) -> dict[str, Any]:
    """OpenAPI 运营首页：指标卡 + 近期调用 + 套餐销售 + 配额告警。"""
    day = day or datetime.utcnow().date()
    day_start = datetime.combine(day, datetime.min.time())
    day_end = day_start + timedelta(days=1)
    prev_start = day_start - timedelta(days=1)
    week_start = day_end - timedelta(days=7)
    prev_week_start = week_start - timedelta(days=7)

    app_filter = " AND u.app_id = :app_id" if app_id else ""
    params: dict[str, Any] = {
        "d0": day_start,
        "d1": day_end,
        "p0": prev_start,
        "w0": week_start,
        "pw0": prev_week_start,
    }
    if app_id:
        params["app_id"] = app_id

    calls_today = int(s.execute(text(f"""
        SELECT COUNT(*) FROM we_api_usage u
         WHERE u.created_at >= :d0 AND u.created_at < :d1{app_filter}
    """), params).scalar() or 0)
    calls_yesterday = int(s.execute(text(f"""
        SELECT COUNT(*) FROM we_api_usage u
         WHERE u.created_at >= :p0 AND u.created_at < :d0{app_filter}
    """), params).scalar() or 0)
    calls_7d = int(s.execute(text(f"""
        SELECT COUNT(*) FROM we_api_usage u
         WHERE u.created_at >= :w0 AND u.created_at < :d1{app_filter}
    """), params).scalar() or 0)
    calls_prev_7d = int(s.execute(text(f"""
        SELECT COUNT(*) FROM we_api_usage u
         WHERE u.created_at >= :pw0 AND u.created_at < :w0{app_filter}
    """), params).scalar() or 0)

    active_keys = int(s.execute(text("""
        SELECT COUNT(*) FROM we_api_keys WHERE revoked = false
    """)).scalar() or 0)
    keys_created_today = int(s.execute(text("""
        SELECT COUNT(*) FROM we_api_keys
         WHERE created_at >= :d0 AND created_at < :d1
    """), params).scalar() or 0)
    keys_created_yesterday = int(s.execute(text("""
        SELECT COUNT(*) FROM we_api_keys
         WHERE created_at >= :p0 AND created_at < :d0
    """), params).scalar() or 0)

    rev_params = {"w0": week_start, "d1": day_end, "pw0": prev_week_start}
    revenue_7d = Decimal(str(s.execute(text("""
        SELECT COALESCE(SUM(price_edg), 0) FROM we_api_pack_orders
         WHERE created_at >= :w0 AND created_at < :d1
    """), rev_params).scalar() or 0))
    revenue_prev_7d = Decimal(str(s.execute(text("""
        SELECT COALESCE(SUM(price_edg), 0) FROM we_api_pack_orders
         WHERE created_at >= :pw0 AND created_at < :w0
    """), rev_params).scalar() or 0))

    recent = list_usage(s, limit=8, app_id=app_id)
    packs = pack_sales(s)
    alerts = quota_alerts(s, threshold=20, limit=20)

    apps = [
        dict(r)
        for r in s.execute(text("""
            SELECT id, name, slug FROM we_apps
             WHERE status = 'published' AND task_type IS NOT NULL
             ORDER BY name ASC LIMIT 200
        """)).mappings().all()
    ]

    return {
        "ok": True,
        "day": day.isoformat(),
        "metrics": {
            "calls_today": calls_today,
            "calls_today_delta_pct": _pct_delta(calls_today, calls_yesterday),
            "calls_7d": calls_7d,
            "calls_7d_delta_pct": _pct_delta(calls_7d, calls_prev_7d),
            "active_keys": active_keys,
            # 无「活跃」历史快照 · 用新建 Key 日环比作趋势参考
            "active_keys_delta_pct": _pct_delta(
                keys_created_today, keys_created_yesterday
            ),
            "pack_revenue_7d_edg": float(revenue_7d),
            "pack_revenue_7d_delta_pct": _pct_delta(
                float(revenue_7d), float(revenue_prev_7d)
            ),
        },
        "recent_calls": recent,
        "pack_sales": packs,
        "quota_alerts": alerts,
        "quota_alert_count": len(alerts),
        "apps": apps,
    }


def list_usage(
    s: Session,
    *,
    limit: int = 50,
    offset: int = 0,
    app_id: Optional[int] = None,
    status: Optional[str] = None,
) -> list[dict[str, Any]]:
    clauses = ["1=1"]
    params: dict[str, Any] = {"lim": limit, "off": offset}
    if app_id:
        clauses.append("u.app_id = :app_id")
        params["app_id"] = app_id
    if status:
        clauses.append("u.status = :st")
        params["st"] = status
    where = " AND ".join(clauses)
    rows = s.execute(text(f"""
        SELECT u.id, u.workload_id, u.status, u.created_at,
               a.name AS app_name, a.slug AS app_slug,
               acc.username AS account_name, acc.id AS account_id,
               k.key_prefix,
               w.elapsed_ms
          FROM we_api_usage u
          LEFT JOIN we_apps a ON a.id = u.app_id
          LEFT JOIN we_accounts acc ON acc.id = u.account_id
          LEFT JOIN we_api_keys k ON k.id = u.key_id
          LEFT JOIN we_workloads w ON w.id = u.workload_id
         WHERE {where}
         ORDER BY u.created_at DESC
         LIMIT :lim OFFSET :off
    """), params).mappings().all()
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        d["workload_id"] = str(d["workload_id"]) if d.get("workload_id") else None
        d["created_at"] = d["created_at"].isoformat() if d.get("created_at") else None
        ms = d.pop("elapsed_ms", None)
        d["elapsed_ms"] = int(ms) if ms is not None else None
        out.append(d)
    return out


def pack_sales(s: Session) -> list[dict[str, Any]]:
    rows = s.execute(text("""
        SELECT p.id, p.name, p.calls, p.price_edg, p.active, p.once_per_account,
               COALESCE(COUNT(o.id), 0) AS sold_count,
               COALESCE(SUM(o.price_edg), 0) AS revenue_edg
          FROM we_api_packs p
          LEFT JOIN we_api_pack_orders o ON o.pack_id = p.id
         GROUP BY p.id
         ORDER BY revenue_edg DESC, p.id ASC
    """)).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["price_edg"] = float(d["price_edg"] or 0)
        d["revenue_edg"] = float(d["revenue_edg"] or 0)
        d["sold_count"] = int(d["sold_count"] or 0)
        out.append(d)
    return out


def list_pack_orders(s: Session, *, limit: int = 50, offset: int = 0) -> list[dict]:
    rows = s.execute(text("""
        SELECT o.id, o.calls, o.price_edg, o.author_share_edg, o.created_at,
               p.name AS pack_name, acc.username AS account_name, acc.id AS account_id
          FROM we_api_pack_orders o
          JOIN we_api_packs p ON p.id = o.pack_id
          LEFT JOIN we_accounts acc ON acc.id = o.account_id
         ORDER BY o.created_at DESC
         LIMIT :lim OFFSET :off
    """), {"lim": limit, "off": offset}).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["price_edg"] = float(d["price_edg"] or 0)
        d["author_share_edg"] = float(d["author_share_edg"] or 0)
        d["created_at"] = d["created_at"].isoformat() if d.get("created_at") else None
        out.append(d)
    return out


def list_keys(s: Session, *, limit: int = 100, offset: int = 0) -> list[dict]:
    rows = s.execute(text("""
        SELECT k.id, k.name, k.key_prefix, k.revoked, k.created_at, k.expires_at,
               k.last_used_at, acc.username AS account_name, acc.id AS account_id
          FROM we_api_keys k
          LEFT JOIN we_accounts acc ON acc.id = k.account_id
         ORDER BY k.created_at DESC
         LIMIT :lim OFFSET :off
    """), {"lim": limit, "off": offset}).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        for k in ("created_at", "expires_at", "last_used_at"):
            if d.get(k):
                d[k] = d[k].isoformat()
        out.append(d)
    return out


def quota_alerts(s: Session, *, threshold: int = 20, limit: int = 50) -> list[dict]:
    """OpenAPI 套餐剩余调用次数（we_api_quotas），非大模型 token 配额。"""
    return list_quotas(s, threshold=threshold, limit=limit)


def list_quotas(
    s: Session,
    *,
    threshold: Optional[int] = 20,
    limit: int = 50,
    account_q: Optional[str] = None,
    app_id: Optional[int] = None,
) -> list[dict]:
    clauses = ["1=1"]
    params: dict[str, Any] = {"lim": limit}
    if threshold is not None:
        clauses.append("q.remaining <= :th")
        params["th"] = threshold
    if app_id:
        clauses.append("q.app_id = :app_id")
        params["app_id"] = app_id
    if account_q:
        clauses.append("(acc.username ILIKE :aq OR CAST(acc.id AS TEXT) = :aq_exact)")
        params["aq"] = f"%{account_q}%"
        params["aq_exact"] = account_q
    where = " AND ".join(clauses)
    rows = s.execute(text(f"""
        SELECT q.account_id, q.app_id, q.remaining, q.total_purchased, q.updated_at,
               acc.username AS account_name,
               a.name AS app_name, a.slug AS app_slug
          FROM we_api_quotas q
          LEFT JOIN we_accounts acc ON acc.id = q.account_id
          LEFT JOIN we_apps a ON a.id = q.app_id
         WHERE {where}
         ORDER BY q.remaining ASC, q.updated_at DESC
         LIMIT :lim
    """), params).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        if d.get("updated_at"):
            d["updated_at"] = d["updated_at"].isoformat()
        total = int(d.get("total_purchased") or 0)
        rem = int(d.get("remaining") or 0)
        d["used"] = max(0, total - rem)
        d["used_pct"] = round((d["used"] / total) * 100, 1) if total > 0 else 0.0
        out.append(d)
    return out


def admin_revoke_key(s: Session, *, key_id: int, actor_id: int | None = None) -> dict:
    row = s.execute(text("""
        SELECT id, account_id, key_prefix, revoked FROM we_api_keys WHERE id = :id
    """), {"id": key_id}).mappings().first()
    if not row:
        raise ValueError("key 不存在")
    if row["revoked"]:
        return {"ok": True, "revoked": key_id, "already": True}
    s.execute(text("""
        UPDATE we_api_keys SET revoked = true, revoked_at = NOW() WHERE id = :id
    """), {"id": key_id})
    from platform_v8.storage.repo import AuditRepo

    AuditRepo.write(
        s,
        action="eco.api_key.revoke",
        actor_account_id=actor_id,
        actor_kind="admin",
        target_kind="api_key",
        target_id=str(key_id),
        detail={
            "key_prefix": row["key_prefix"],
            "account_id": int(row["account_id"]),
        },
    )
    return {"ok": True, "revoked": key_id, "key_prefix": row["key_prefix"]}


def call_stats_series(s: Session, *, days: int = 14, app_id: Optional[int] = None) -> dict:
    params: dict[str, Any] = {"days": days}
    app_filter = ""
    if app_id:
        app_filter = " AND app_id = :app_id"
        params["app_id"] = app_id
    rows = s.execute(text(f"""
        SELECT date_trunc('day', created_at)::date AS d, COUNT(*) AS n,
               COUNT(*) FILTER (WHERE status = 'failed') AS failed,
               COUNT(*) FILTER (WHERE status IN ('done','submitted')) AS okish
          FROM we_api_usage
         WHERE created_at >= NOW() - (:days * INTERVAL '1 day'){app_filter}
         GROUP BY 1
         ORDER BY 1 ASC
    """), params).mappings().all()
    return {
        "ok": True,
        "series": [
            {
                "date": r["d"].isoformat(),
                "calls": int(r["n"] or 0),
                "failed": int(r["failed"] or 0),
            }
            for r in rows
        ],
    }


def funds_summary(s: Session) -> dict:
    """套餐收入 + 作者分成粗览（开放平台通道）。"""
    row = s.execute(text("""
        SELECT COALESCE(SUM(price_edg), 0) AS gross,
               COALESCE(SUM(author_share_edg), 0) AS author,
               COUNT(*) AS orders
          FROM we_api_pack_orders
         WHERE created_at >= NOW() - INTERVAL '30 days'
    """)).mappings().first()
    gross = Decimal(str(row["gross"] or 0))
    author = Decimal(str(row["author"] or 0))
    return {
        "ok": True,
        "days": 30,
        "orders": int(row["orders"] or 0),
        "gross_edg": float(gross),
        "author_share_edg": float(author),
        "platform_share_edg": float(gross - author),
    }


def home_workbench(s: Session) -> dict[str, Any]:
    """运营总后台首页：一屏聚合待审/调用/告警/资金。"""
    from platform_v8.services.marketplace import apps as apps_svc

    day = datetime.utcnow().date()
    day_start = datetime.combine(day, datetime.min.time())
    day_end = day_start + timedelta(days=1)

    dash = openapi_dashboard(s, day=day)
    metrics = dash.get("metrics") or {}
    failed_today = int(s.execute(text("""
        SELECT COUNT(*) FROM we_api_usage
         WHERE created_at >= :d0 AND created_at < :d1 AND status = 'failed'
    """), {"d0": day_start, "d1": day_end}).scalar() or 0)

    pub = int(s.execute(text(
        "SELECT COUNT(*) FROM we_apps WHERE status = 'published'"
    )).scalar() or 0)
    review_n = int(s.execute(text(
        "SELECT COUNT(*) FROM we_apps WHERE status = 'review'"
    )).scalar() or 0)

    review = apps_svc.list_review_queue(s, limit=8)
    series = call_stats_series(s, days=7)
    funds = funds_summary(s)
    orders = list_pack_orders(s, limit=5)

    return {
        "ok": True,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "day": day.isoformat(),
        "metrics": {
            **metrics,
            "failed_calls_today": failed_today,
            "apps_published": pub,
            "apps_review": review_n,
            "quota_alert_count": dash.get("quota_alert_count", 0),
        },
        "review_queue": review.get("items") or [],
        "recent_calls": dash.get("recent_calls") or [],
        "quota_alerts": (dash.get("quota_alerts") or [])[:5],
        "series_7d": series.get("series") or [],
        "funds": funds,
        "recent_orders": orders,
        "pack_sales_top": (dash.get("pack_sales") or [])[:5],
    }
