"""
数据采集 · admin endpoints · /api/v8/admin/crawl/*

仅平台运营 (acct.is_admin) 可调:
  CRUD /datasources             白名单数据源管理
  CRUD /recipes                 配方管理
  GET  /orders                  看全平台订单
  GET  /stats                   GMV/订单数/活跃节点聚合
"""
from __future__ import annotations
import json as _json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session, get_admin_account
from platform_v8.services.crawl.schemas import (
    DataSourceIn,
    DataSourceOut,
    DataSourcePatch,
    RecipeIn,
    RecipeOut,
    RecipePatch,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/admin/crawl", tags=["admin-crawl"])


# ════════════════════════════════════════════════════════════════════
# DataSources CRUD
# ════════════════════════════════════════════════════════════════════
@router.get("/datasources", response_model=list[DataSourceOut])
def list_ds(
    session: Session = Depends(get_session),
    _adm=Depends(get_admin_account),
) -> list[dict]:
    rows = session.execute(
        text("SELECT * FROM we_crawl_datasources ORDER BY created_at DESC")
    ).mappings().all()
    return [dict(r) for r in rows]


@router.post("/datasources", response_model=DataSourceOut)
def create_ds(
    body: DataSourceIn,
    session: Session = Depends(get_session),
    adm=Depends(get_admin_account),
) -> dict:
    try:
        row = session.execute(
            text(
                "INSERT INTO we_crawl_datasources "
                "(code, title, description, allowed_domain, robots_url, "
                " rate_limit_qps, license, category, tags, is_published, created_by) "
                "VALUES (:code, :title, :desc, :domain, :robots, "
                " :qps, :lic, :cat, :tags, :pub, :uid) "
                "RETURNING *"
            ),
            {
                "code": body.code, "title": body.title, "desc": body.description,
                "domain": body.allowed_domain, "robots": body.robots_url,
                "qps": body.rate_limit_qps, "lic": body.license,
                "cat": body.category, "tags": body.tags,
                "pub": body.is_published, "uid": adm.id,
            },
        ).mappings().first()
        session.commit()
        return dict(row)
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/datasources/{ds_id}", response_model=DataSourceOut)
def patch_ds(
    ds_id: int,
    body: DataSourcePatch,
    session: Session = Depends(get_session),
    _adm=Depends(get_admin_account),
) -> dict:
    sets, params = [], {"id": ds_id}
    for k, v in body.model_dump(exclude_unset=True).items():
        sets.append(f"{k} = :{k}")
        params[k] = v
    if not sets:
        raise HTTPException(status_code=400, detail="无更新字段")
    sql = f"UPDATE we_crawl_datasources SET {', '.join(sets)} WHERE id = :id RETURNING *"
    row = session.execute(text(sql), params).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="数据源不存在")
    session.commit()
    return dict(row)


@router.delete("/datasources/{ds_id}", response_model=dict)
def delete_ds(
    ds_id: int,
    session: Session = Depends(get_session),
    _adm=Depends(get_admin_account),
) -> dict:
    n = session.execute(
        text("DELETE FROM we_crawl_datasources WHERE id = :id"),
        {"id": ds_id},
    ).rowcount
    session.commit()
    return {"ok": True, "deleted": n}


# ════════════════════════════════════════════════════════════════════
# Recipes CRUD
# ════════════════════════════════════════════════════════════════════
@router.get("/recipes", response_model=list[RecipeOut])
def list_recipes(
    datasource_id: Optional[int] = None,
    session: Session = Depends(get_session),
    _adm=Depends(get_admin_account),
) -> list[dict]:
    sql = "SELECT * FROM we_crawl_recipes"
    params = {}
    if datasource_id:
        sql += " WHERE datasource_id = :dsid"
        params["dsid"] = datasource_id
    sql += " ORDER BY created_at DESC"
    return [dict(r) for r in session.execute(text(sql), params).mappings().all()]


@router.post("/recipes", response_model=RecipeOut)
def create_recipe(
    body: RecipeIn,
    session: Session = Depends(get_session),
    _adm=Depends(get_admin_account),
) -> dict:
    try:
        row = session.execute(
            text(
                "INSERT INTO we_crawl_recipes "
                "(datasource_id, code, title, url_template, method, headers_json, "
                " timeout_ms, params_schema, parser_type, parser_config, "
                " unit_price_edg, is_active) "
                "VALUES (:dsid, :code, :title, :url, :method, CAST(:headers AS jsonb), "
                " :timeout, CAST(:psch AS jsonb), :ptype, CAST(:pcfg AS jsonb), "
                " :price, :active) "
                "RETURNING *"
            ),
            {
                "dsid": body.datasource_id, "code": body.code, "title": body.title,
                "url": body.url_template, "method": body.method,
                "headers": _json.dumps(body.headers_json),
                "timeout": body.timeout_ms,
                "psch": _json.dumps([p.model_dump() for p in body.params_schema]),
                "ptype": body.parser_type,
                "pcfg": _json.dumps(body.parser_config),
                "price": body.unit_price_edg,
                "active": body.is_active,
            },
        ).mappings().first()
        session.commit()
        return dict(row)
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/recipes/{rid}", response_model=RecipeOut)
def patch_recipe(
    rid: int,
    body: RecipePatch,
    session: Session = Depends(get_session),
    _adm=Depends(get_admin_account),
) -> dict:
    sets, params = [], {"id": rid}
    for k, v in body.model_dump(exclude_unset=True).items():
        if k in ("headers_json", "parser_config"):
            sets.append(f"{k} = CAST(:{k} AS jsonb)")
            params[k] = _json.dumps(v)
        elif k == "params_schema":
            sets.append("params_schema = CAST(:psch AS jsonb)")
            params["psch"] = _json.dumps([
                p.model_dump() if hasattr(p, "model_dump") else p for p in v
            ])
        else:
            sets.append(f"{k} = :{k}")
            params[k] = v
    if not sets:
        raise HTTPException(status_code=400, detail="无更新字段")
    sql = f"UPDATE we_crawl_recipes SET {', '.join(sets)} WHERE id = :id RETURNING *"
    row = session.execute(text(sql), params).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="配方不存在")
    session.commit()
    return dict(row)


@router.delete("/recipes/{rid}", response_model=dict)
def delete_recipe(
    rid: int,
    session: Session = Depends(get_session),
    _adm=Depends(get_admin_account),
) -> dict:
    n = session.execute(
        text("DELETE FROM we_crawl_recipes WHERE id = :id"),
        {"id": rid},
    ).rowcount
    session.commit()
    return {"ok": True, "deleted": n}


# ════════════════════════════════════════════════════════════════════
# Orders (admin · 看全部)
# ════════════════════════════════════════════════════════════════════
@router.get("/orders", response_model=list[dict])
def list_all_orders(
    status: Optional[str] = None,
    customer_id: Optional[int] = None,
    limit: int = Query(100, le=500),
    session: Session = Depends(get_session),
    _adm=Depends(get_admin_account),
) -> list[dict]:
    sql = "SELECT * FROM we_crawl_orders WHERE 1=1"
    params: dict = {"lim": limit}
    if status:
        sql += " AND status = :st"
        params["st"] = status
    if customer_id:
        sql += " AND customer_id = :cid"
        params["cid"] = customer_id
    sql += " ORDER BY created_at DESC LIMIT :lim"
    return [dict(r) for r in session.execute(text(sql), params).mappings().all()]


# ════════════════════════════════════════════════════════════════════
# Stats · 平台聚合
# ════════════════════════════════════════════════════════════════════
@router.get("/stats", response_model=dict)
def get_stats(
    range_days: int = Query(7, ge=1, le=90),
    session: Session = Depends(get_session),
    _adm=Depends(get_admin_account),
) -> dict:
    overview = session.execute(
        text(
            "SELECT "
            "  COUNT(*) FILTER (WHERE status='running') AS running_orders, "
            "  COUNT(*) FILTER (WHERE status='done')    AS done_orders, "
            "  COALESCE(SUM(total_price_edg) FILTER (WHERE status IN ('done','running')), 0) AS gmv_edg "
            "FROM we_crawl_orders "
            "WHERE created_at >= NOW() - (:d || ' days')::INTERVAL"
        ),
        {"d": range_days},
    ).mappings().first() or {}

    pool = session.execute(
        text(
            "SELECT "
            "  COUNT(*) FILTER (WHERE status='pending')        AS pool_pending, "
            "  COUNT(*) FILTER (WHERE status='pending_verify') AS pool_pending_verify, "
            "  COUNT(*) FILTER (WHERE status='leased')         AS pool_leased "
            "FROM we_crawl_subtasks"
        ),
    ).mappings().first() or {}

    nodes = session.execute(
        text(
            "SELECT COUNT(DISTINCT node_id) AS active_nodes "
            "FROM we_crawl_node_consent WHERE is_active = TRUE"
        ),
    ).scalar() or 0

    payouts = session.execute(
        text(
            "SELECT COALESCE(SUM(amount_edg), 0) AS total_paid_edg, "
            "       COUNT(DISTINCT node_id) AS nodes_with_income "
            "FROM we_crawl_payouts "
            "WHERE paid_at >= NOW() - (:d || ' days')::INTERVAL"
        ),
        {"d": range_days},
    ).mappings().first() or {}

    return {
        "ok": True,
        "range_days": range_days,
        "orders": {k: int(v) if k != "gmv_edg" else str(v) for k, v in overview.items()},
        "pool": {k: int(v) for k, v in pool.items()},
        "active_nodes": int(nodes),
        "payouts": {
            "total_paid_edg": str(payouts.get("total_paid_edg") or 0),
            "nodes_with_income": int(payouts.get("nodes_with_income") or 0),
        },
    }


# ════════════════════════════════════════════════════════════════════
# W4 (2026-05-26) · Unified Engine 视图 · 看统一引擎里的 crawl workload+shards
# 跟 /stats 的老视角并列 · admin 可对照两边数据 (双写应保持一致)
# ════════════════════════════════════════════════════════════════════
@router.get("/unified/stats", response_model=dict)
def get_unified_stats(
    range_days: int = Query(7, ge=1, le=90),
    session: Session = Depends(get_session),
    _adm=Depends(get_admin_account),
) -> dict:
    """统一引擎视角 · crawl workload(mode=PULL) + shards 聚合

    用于诊断:
      - 双写一致性: 这里 workload 数应等于 we_crawl_orders 数 (W4 起)
      - 节点 lease: shards.LEASED 数应等于 we_crawl_subtasks.leased 数
      - 派发延迟: workload 创建 → shard 第一次 LEASED 的时差
    """
    wl = session.execute(text(
        "SELECT "
        "  COUNT(*) FILTER (WHERE w.status='RUNNING') AS running_workloads, "
        "  COUNT(*) FILTER (WHERE w.status='DONE')    AS done_workloads, "
        "  COUNT(*) FILTER (WHERE w.status='FAILED')  AS failed_workloads, "
        "  COALESCE(SUM(w.budget) FILTER (WHERE w.status IN ('RUNNING','DONE')), 0) AS budget_total, "
        "  COALESCE(SUM(w.spent), 0) AS spent_total "
        "FROM we_workloads w "
        "WHERE w.spec::jsonb @> CAST(:taskq AS JSONB) "
        "  AND w.created_at >= NOW() - (:d || ' days')::INTERVAL"
    ), {"d": range_days, "taskq": '{"task_type":"crawl_subtask"}'}).mappings().first() or {}

    sh = session.execute(text(
        "SELECT "
        "  COUNT(*) FILTER (WHERE s.status='PENDING') AS shard_pending, "
        "  COUNT(*) FILTER (WHERE s.status='LEASED')  AS shard_leased, "
        "  COUNT(*) FILTER (WHERE s.status='DONE')    AS shard_done, "
        "  COUNT(*) FILTER (WHERE s.status='FAILED')  AS shard_failed, "
        "  COUNT(DISTINCT s.lease_by_node) FILTER (WHERE s.status='LEASED') AS active_workers "
        "FROM we_shards s "
        "JOIN we_workloads w ON w.id = s.workload_id "
        "WHERE w.spec::jsonb @> CAST(:taskq AS JSONB) "
        "  AND w.created_at >= NOW() - (:d || ' days')::INTERVAL"
    ), {"d": range_days, "taskq": '{"task_type":"crawl_subtask"}'}).mappings().first() or {}

    return {
        "ok": True,
        "range_days": range_days,
        "workloads": {k: (str(v) if k.endswith("_total") else int(v))
                      for k, v in wl.items()},
        "shards": {k: int(v) for k, v in sh.items()},
        "_note": "若 workload 数 = we_crawl_orders.创建数 → W4 双写正常",
    }


@router.get("/unified/workloads", response_model=list[dict])
def list_unified_crawl_workloads(
    limit: int = Query(50, ge=1, le=500),
    status: Optional[str] = Query(None, regex="^(CREATED|RUNNING|DONE|FAILED|CANCELLED)$"),
    session: Session = Depends(get_session),
    _adm=Depends(get_admin_account),
) -> list[dict]:
    """统一引擎里的 crawl workload 列表 · admin 排查双写问题用"""
    where = ["w.spec::jsonb @> CAST(:taskq AS JSONB)"]
    params: dict = {"lim": limit, "taskq": '{"task_type":"crawl_subtask"}'}
    if status:
        where.append("w.status = :st")
        params["st"] = status
    rows = session.execute(text(
        "SELECT w.id, w.owner_id, w.name, w.status, w.total_shards, "
        "       w.completed_shards, w.failed_shards, w.budget, w.spent, "
        "       w.created_at, w.completed_at, "
        "       (w.spec::jsonb->'params'->>'crawl_order_id') AS crawl_order_id "
        "FROM we_workloads w "
        f"WHERE {' AND '.join(where)} "
        "ORDER BY w.created_at DESC LIMIT :lim"
    ), params).mappings().all()
    return [
        {
            "id": r["id"],
            "owner_id": r["owner_id"],
            "name": r["name"],
            "status": r["status"],
            "total_shards": int(r["total_shards"] or 0),
            "completed_shards": int(r["completed_shards"] or 0),
            "failed_shards": int(r["failed_shards"] or 0),
            "budget_edg": str(r["budget"] or 0),
            "spent_edg": str(r["spent"] or 0),
            "crawl_order_id": r["crawl_order_id"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "completed_at": r["completed_at"].isoformat() if r["completed_at"] else None,
        }
        for r in rows
    ]
