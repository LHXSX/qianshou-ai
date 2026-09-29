"""
api/v8/geo.py · GEO 监测 客户 API (W2-8)

路由前缀 /api/v8/geo
  POST /brands                   创建品牌
  GET  /brands                   列我的品牌
  PATCH /brands/{brand_id}       改品牌
  DELETE /brands/{brand_id}      删品牌
  POST /orders                   创建监测订单 → workload
  GET  /orders                   列我的订单
  GET  /orders/{wl_id}/observations  · 拿 raw 观察数据
  GET  /orders/{wl_id}/report?period=daily/weekly · 拿聚合报表

注: 实际报表 endpoint 简化版 · P2 接更复杂的统计聚合
"""
from __future__ import annotations
import logging
from datetime import date, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

# 客户 GEO API · 登录用户即可管理自己的品牌/订单（按 customer_id 隔离）
# 平台级配置仍走 /api/v8/admin/geo
from platform_v8.api.deps import get_session, get_current_account
from platform_v8.services.geo import brands as brands_svc
from platform_v8.services.geo import orders as orders_svc
from platform_v8.services.geo.orders import GeoOrderError
from platform_v8.services.geo.schemas import (
    GeoBrand, GeoBrandCreate, GeoBrandUpdate,
    GeoOrderCreate, GeoOrderSummary, GeoObservation,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/geo", tags=["geo"])


# ════════════════════════════════════════════════════════════════
# 品牌库
# ════════════════════════════════════════════════════════════════
@router.post("/brands", response_model=GeoBrand)
def create_brand(
    body: GeoBrandCreate,
    s: Session = Depends(get_session),
    acct=Depends(get_current_account),
) -> GeoBrand:
    try:
        return brands_svc.create_brand(s, customer_id=acct.id, data=body)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/brands", response_model=list[GeoBrand])
def list_brands(
    s: Session = Depends(get_session),
    acct=Depends(get_current_account),
) -> list[GeoBrand]:
    return brands_svc.list_brands(s, customer_id=acct.id)


@router.patch("/brands/{brand_id}", response_model=GeoBrand)
def update_brand(
    brand_id: int,
    body: GeoBrandUpdate,
    s: Session = Depends(get_session),
    acct=Depends(get_current_account),
) -> GeoBrand:
    b = brands_svc.update_brand(s, brand_id, customer_id=acct.id, data=body)
    if b is None:
        raise HTTPException(status_code=404, detail=f"品牌 {brand_id} 不存在")
    return b


@router.delete("/brands/{brand_id}")
def delete_brand(
    brand_id: int,
    s: Session = Depends(get_session),
    acct=Depends(get_current_account),
) -> dict:
    ok = brands_svc.delete_brand(s, brand_id, customer_id=acct.id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"品牌 {brand_id} 不存在")
    return {"ok": True}


# ════════════════════════════════════════════════════════════════
# 订单 (= workload)
# ════════════════════════════════════════════════════════════════
@router.post("/orders")
def create_order(
    body: GeoOrderCreate,
    s: Session = Depends(get_session),
    acct=Depends(get_current_account),
) -> dict:
    try:
        wl = orders_svc.create_geo_order(s, customer_id=acct.id, data=body)
        return {
            "workload_id": wl.id,
            "name": wl.name,
            "status": wl.status.value,
            "total_shards": wl.total_shards,
            "budget_edg": str(wl.budget),
        }
    except GeoOrderError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("geo.create_order · err=%s", exc)
        raise HTTPException(status_code=500, detail=f"内部错误: {exc}")


@router.get("/orders", response_model=list[GeoOrderSummary])
def list_orders(
    limit: int = 50,
    s: Session = Depends(get_session),
    acct=Depends(get_current_account),
) -> list[GeoOrderSummary]:
    return orders_svc.list_orders(s, customer_id=acct.id, limit=min(limit, 200))


# ════════════════════════════════════════════════════════════════
# 观察数据 + 报表
# ════════════════════════════════════════════════════════════════
@router.get("/orders/{workload_id}/observations", response_model=list[GeoObservation])
def list_order_observations(
    workload_id: str,
    s: Session = Depends(get_session),
    acct=Depends(get_current_account),
) -> list[GeoObservation]:
    """拿订单的所有 raw 观察数据 · 校验所有权"""
    # 校验所有权
    _check_workload_owned(s, workload_id, acct.id)
    
    rows = s.execute(
        text(
            "SELECT o.id, o.workload_id, o.shard_id, o.brand_id, b.brand_name, "
            "       o.keyword, o.llm_code, o.observed_at, "
            "       o.mention_count, o.rank_position, o.sentiment, o.recommended, "
            "       o.competitors, o.raw_excerpt "
            "FROM we_geo_observations o "
            "JOIN we_geo_brands b ON b.id = o.brand_id "
            "WHERE o.workload_id = :wid "
            "ORDER BY o.observed_at DESC LIMIT 1000"
        ),
        {"wid": workload_id},
    ).mappings().all()
    
    import json
    out: list[GeoObservation] = []
    for r in rows:
        comp = r["competitors"]
        if isinstance(comp, str):
            comp = json.loads(comp)
        out.append(GeoObservation(
            id=r["id"],
            workload_id=str(r["workload_id"]),
            shard_id=str(r["shard_id"]),
            brand_id=r["brand_id"],
            brand_name=r["brand_name"],
            keyword=r["keyword"],
            llm_code=r["llm_code"],
            observed_at=r["observed_at"],
            mention_count=r["mention_count"] or 0,
            rank_position=r["rank_position"],
            sentiment=float(r["sentiment"]) if r["sentiment"] is not None else None,
            recommended=bool(r["recommended"]),
            competitors=comp or [],
            raw_excerpt=r["raw_excerpt"],
        ))
    return out


@router.get("/orders/{workload_id}/report")
def get_order_report(
    workload_id: str,
    period: Literal["daily", "weekly", "monthly"] = "daily",
    s: Session = Depends(get_session),
    acct=Depends(get_current_account),
) -> dict:
    """订单聚合报表 (按 LLM 分组 + 按时间桶分组)
    
    MVP: 简单聚合 · 不分时间桶 · 只按 LLM 分
    P2: 完整时序聚合
    """
    _check_workload_owned(s, workload_id, acct.id)
    
    rows = s.execute(
        text(
            "SELECT llm_code, "
            "       COUNT(*) AS sample_count, "
            "       SUM(mention_count) AS mention_total, "
            "       AVG(rank_position) AS avg_rank, "
            "       AVG(sentiment) AS avg_sentiment, "
            "       SUM(CASE WHEN recommended THEN 1 ELSE 0 END) AS recommended_count "
            "FROM we_geo_observations "
            "WHERE workload_id = :wid "
            "GROUP BY llm_code"
        ),
        {"wid": workload_id},
    ).mappings().all()
    
    llm_breakdown: dict[str, dict] = {}
    total_mention = 0
    total_samples = 0
    total_recommended = 0
    sentiments: list[float] = []
    
    for r in rows:
        llm = r["llm_code"]
        mention = int(r["mention_total"] or 0)
        samples = int(r["sample_count"] or 0)
        rec = int(r["recommended_count"] or 0)
        avg_sent = float(r["avg_sentiment"]) if r["avg_sentiment"] is not None else None
        avg_rank = float(r["avg_rank"]) if r["avg_rank"] is not None else None
        
        llm_breakdown[llm] = {
            "sample_count": samples,
            "mention_total": mention,
            "avg_rank": avg_rank,
            "avg_sentiment": avg_sent,
            "recommended_count": rec,
            "recommended_pct": (rec * 100.0 / samples) if samples > 0 else 0.0,
        }
        total_mention += mention
        total_samples += samples
        total_recommended += rec
        if avg_sent is not None:
            sentiments.append(avg_sent)
    
    return {
        "workload_id": workload_id,
        "period": period,
        "summary": {
            "total_samples": total_samples,
            "total_mentions": total_mention,
            "total_recommended": total_recommended,
            "avg_sentiment": (sum(sentiments) / len(sentiments)) if sentiments else None,
            "llm_coverage_pct": (len(llm_breakdown) / 6.0) * 100,
        },
        "llm_breakdown": llm_breakdown,
    }


# ════════════════════════════════════════════════════════════════
# 2026-05-28 · 新增 · 前端 dashboard 摘要 + LLM 选项
# ════════════════════════════════════════════════════════════════
@router.get("/llm_codes")
def list_available_llm(
    s: Session = Depends(get_session),
    acct=Depends(get_current_account),
):
    """客户下单时选 LLM · 只返 enabled 的 · 不暴露 secret"""
    rows = s.execute(
        text("""
            SELECT llm_code, display_name, avg_latency_ms, rate_limit_per_min
            FROM we_geo_llm_configs
            WHERE enabled = TRUE
            ORDER BY llm_code
        """)
    ).fetchall()
    return {
        "items": [
            {"llm_code": r[0], "display_name": r[1],
             "avg_latency_ms": r[2], "rate_limit_per_min": r[3]}
            for r in rows
        ]
    }


@router.get("/reports/summary")
def my_reports_summary(
    brand_id: int | None = None,
    days: int = 30,
    s: Session = Depends(get_session),
    acct=Depends(get_current_account),
):
    """
    客户 GEO dashboard 摘要 (跨所有订单聚合)
    
    返:
      - total_brands / total_orders / total_observations (近 N 天)
      - total_mentions / avg_sentiment / recommended_rate
      - llm_covered (实际跑过几个 LLM)
    """
    cid = int(acct.id)
    days = max(1, min(int(days), 365))
    
    total_brands = s.execute(
        text("SELECT COUNT(*) FROM we_geo_brands WHERE customer_id = :cid"),
        {"cid": cid},
    ).scalar() or 0
    
    total_orders = s.execute(
        text("SELECT COUNT(*) FROM we_workloads WHERE owner_id = :cid AND task_type = 'geo_query'"),
        {"cid": cid},
    ).scalar() or 0
    
    # observations 聚合 · brand_id 是 optional 过滤
    brand_filter = f" AND o.brand_id = {int(brand_id)}" if brand_id else ""
    obs = s.execute(
        text(f"""
            SELECT
                COUNT(*) AS total_obs,
                COALESCE(SUM(o.mention_count), 0) AS total_mentions,
                AVG(o.sentiment) AS avg_sentiment,
                SUM(CASE WHEN o.recommended THEN 1 ELSE 0 END) AS rec_count,
                COUNT(DISTINCT o.llm_code) AS llm_covered
            FROM we_geo_observations o
            JOIN we_geo_brands b ON o.brand_id = b.id
            WHERE b.customer_id = :cid
              AND o.observed_at >= NOW() - INTERVAL '{days} days'
              {brand_filter}
        """),
        {"cid": cid},
    ).fetchone()
    
    total_obs = int(obs[0] or 0) if obs else 0
    total_mentions = int(obs[1] or 0) if obs else 0
    avg_sentiment = float(obs[2]) if obs and obs[2] is not None else None
    rec_count = int(obs[3] or 0) if obs else 0
    llm_covered = int(obs[4] or 0) if obs else 0
    rec_rate = (rec_count / total_obs) if total_obs > 0 else 0.0
    
    return {
        "ok": True,
        "period_days": days,
        "total_brands": total_brands,
        "total_orders": total_orders,
        "total_observations": total_obs,
        "total_mentions": total_mentions,
        "avg_sentiment": round(avg_sentiment, 3) if avg_sentiment is not None else None,
        "recommended_count": rec_count,
        "recommended_rate": round(rec_rate, 4),
        "llm_covered": llm_covered,
        "llm_total": 6,
    }


# ════════════════════════════════════════════════════════════════
# helpers
# ════════════════════════════════════════════════════════════════
def _check_workload_owned(s: Session, workload_id: str, customer_id: int) -> None:
    """校验 workload 属于 customer · 不属于报 403"""
    row = s.execute(
        text("SELECT owner_id FROM we_workloads WHERE id = :wid"),
        {"wid": workload_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="workload 不存在")
    if int(row[0]) != int(customer_id):
        raise HTTPException(status_code=403, detail="无权访问此 workload")
