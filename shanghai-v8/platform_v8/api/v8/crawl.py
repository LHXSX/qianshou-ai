"""
数据采集 · 公开 + 客户 endpoints · /api/v8/crawl/*

公开 (节点用):
  GET  /datasources          列已发布数据源
  POST /node/consent         节点同意书 + 启用
  POST /pull                 节点 pull 子任务
  POST /complete             节点上报完成
  POST /fail                 节点报失败

客户 (登录):
  GET  /recipes              浏览全部上架配方
  POST /orders/quote         询价
  POST /orders               下单
  GET  /orders               我的订单列表
  GET  /orders/{id}          订单详情 + 进度
  POST /orders/{id}/cancel   取消订单
  GET  /orders/{id}/result   拿结果索引
"""
from __future__ import annotations
import logging
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

# 2026-06-05 双层可见性:爬虫"客户下单口"为管理员私有(收 admin);节点消费口(/node/* /pull /complete /fail)保持
from platform_v8.api.deps import get_session, get_current_account, get_admin_account
from platform_v8.services.crawl.dispatch import (
    complete_subtask,
    fail_subtask,
    pull_subtasks,
)
from platform_v8.services.crawl.orders import (
    cancel_order,
    compute_quote,
    create_order,
)
from platform_v8.services.crawl.schemas import (
    CompleteIn,
    DataSourceOut,
    FailIn,
    NodeConsentIn,
    OrderIn,
    OrderOut,
    OrderProgressOut,
    OrderQuoteIn,
    OrderQuoteOut,
    PullIn,
    PullOut,
    RecipeOut,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/crawl", tags=["crawl"])


# ════════════════════════════════════════════════════════════════════
# 公开 · 节点用
# ════════════════════════════════════════════════════════════════════
@router.get("/datasources", response_model=list[DataSourceOut])
def list_published_datasources(
    category: Optional[str] = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    sql = "SELECT * FROM we_crawl_datasources WHERE is_published = TRUE"
    params = {}
    if category:
        sql += " AND category = :cat"
        params["cat"] = category
    sql += " ORDER BY title"
    return [dict(r) for r in session.execute(text(sql), params).mappings().all()]


@router.post("/node/consent", response_model=dict)
def post_node_consent(
    body: NodeConsentIn,
    session: Session = Depends(get_session),
    acct=Depends(get_current_account),
) -> dict:
    # 校验 node 归属
    worker_owner = session.execute(
        text("SELECT owner_id FROM we_workers WHERE id = CAST(:id AS uuid)"),
        {"id": body.node_id},
    ).scalar()
    if worker_owner is None:
        raise HTTPException(status_code=404, detail="节点不存在")
    if worker_owner != acct.id:
        raise HTTPException(status_code=403, detail="非本人节点")

    session.execute(
        text(
            "INSERT INTO we_crawl_node_consent "
            "(node_id, account_id, consent_text_hash, max_concurrency, is_active) "
            "VALUES (CAST(:nid AS uuid), :aid, :hash, :mc, TRUE) "
            "ON CONFLICT (node_id) DO UPDATE SET "
            "  consent_text_hash = EXCLUDED.consent_text_hash, "
            "  max_concurrency = EXCLUDED.max_concurrency, "
            "  is_active = TRUE, "
            "  consented_at = NOW()"
        ),
        {
            "nid": body.node_id, "aid": acct.id,
            "hash": body.consent_text_hash,
            "mc": body.max_concurrency,
        },
    )
    session.commit()
    return {"ok": True, "node_id": body.node_id}


@router.post("/pull", response_model=PullOut)
def post_pull(
    body: PullIn,
    session: Session = Depends(get_session),
) -> PullOut:
    return pull_subtasks(session, pull_in=body)


@router.post("/complete", response_model=dict)
def post_complete(
    body: CompleteIn,
    session: Session = Depends(get_session),
) -> dict:
    try:
        return complete_subtask(session, complete_in=body)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/fail", response_model=dict)
def post_fail(
    body: FailIn,
    session: Session = Depends(get_session),
) -> dict:
    try:
        return fail_subtask(session, fail_in=body)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ════════════════════════════════════════════════════════════════════
# 客户 · 登录用
# ════════════════════════════════════════════════════════════════════
@router.get("/recipes", response_model=list[RecipeOut])
def list_active_recipes(
    datasource_id: Optional[int] = None,
    category: Optional[str] = None,
    session: Session = Depends(get_session),
    _admin=Depends(get_admin_account),
) -> list[dict]:
    sql = (
        "SELECT r.* FROM we_crawl_recipes r "
        "JOIN we_crawl_datasources d ON d.id = r.datasource_id "
        "WHERE r.is_active = TRUE AND d.is_published = TRUE"
    )
    params = {}
    if datasource_id:
        sql += " AND r.datasource_id = :dsid"
        params["dsid"] = datasource_id
    if category:
        sql += " AND d.category = :cat"
        params["cat"] = category
    sql += " ORDER BY r.unit_price_edg"
    return [dict(r) for r in session.execute(text(sql), params).mappings().all()]


@router.post("/orders/quote", response_model=OrderQuoteOut)
def post_quote(
    body: OrderQuoteIn,
    session: Session = Depends(get_session),
    _acct=Depends(get_admin_account),
) -> OrderQuoteOut:
    price = session.execute(
        text("SELECT unit_price_edg FROM we_crawl_recipes "
             "WHERE id = :id AND is_active = TRUE"),
        {"id": body.recipe_id},
    ).scalar()
    if price is None:
        raise HTTPException(status_code=404, detail="配方不存在或已下架")
    return compute_quote(
        recipe_id=body.recipe_id,
        unit_price_edg=Decimal(str(price)),
        total_count=body.total_count,
        verify_level=body.verify_level,
        priority=body.priority,
    )


@router.post("/orders", response_model=dict)
def post_order(
    body: OrderIn,
    session: Session = Depends(get_session),
    acct=Depends(get_admin_account),
) -> dict:
    try:
        return create_order(session, customer_id=acct.id, order_in=body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/orders", response_model=list[OrderOut])
def list_my_orders(
    session: Session = Depends(get_session),
    acct=Depends(get_admin_account),
) -> list[dict]:
    rows = session.execute(
        text(
            "SELECT * FROM we_crawl_orders "
            "WHERE customer_id = :cid ORDER BY created_at DESC LIMIT 100"
        ),
        {"cid": acct.id},
    ).mappings().all()
    return [dict(r) for r in rows]


@router.get("/orders/{order_id}", response_model=OrderProgressOut)
def get_order_progress(
    order_id: int,
    session: Session = Depends(get_session),
    acct=Depends(get_admin_account),
) -> dict:
    # 校验所有权
    own = session.execute(
        text("SELECT customer_id FROM we_crawl_orders WHERE id = :id"),
        {"id": order_id},
    ).scalar()
    if own is None:
        raise HTTPException(status_code=404, detail="订单不存在")
    if own != acct.id:
        raise HTTPException(status_code=403, detail="无权查看")
    row = session.execute(
        text("SELECT * FROM we_crawl_order_progress WHERE order_id = :id"),
        {"id": order_id},
    ).mappings().first()
    if not row:
        return {
            "order_id": order_id, "status": "unknown",
            "total_count": 0, "completed_count": 0, "failed_count": 0,
            "pending_count": 0, "leased_count": 0,
            "pending_verify_count": 0, "percent_done": 0.0,
        }
    return dict(row)


@router.post("/orders/{order_id}/cancel", response_model=dict)
def post_cancel(
    order_id: int,
    session: Session = Depends(get_session),
    acct=Depends(get_admin_account),
) -> dict:
    try:
        return cancel_order(session, order_id=order_id, customer_id=acct.id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/orders/{order_id}/result", response_model=dict)
def get_order_result(
    order_id: int,
    session: Session = Depends(get_session),
    acct=Depends(get_admin_account),
) -> dict:
    row = session.execute(
        text(
            "SELECT customer_id, status, result_oss_url "
            "FROM we_crawl_orders WHERE id = :id"
        ),
        {"id": order_id},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="订单不存在")
    if row["customer_id"] != acct.id:
        raise HTTPException(status_code=403, detail="无权查看")
    if row["status"] != "done":
        raise HTTPException(
            status_code=400,
            detail=f"订单状态 {row['status']} · 未完成",
        )
    return {
        "ok": True, "order_id": order_id,
        "result_oss_url": row["result_oss_url"],
    }
