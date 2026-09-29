"""
api/v8/admin_geo.py · GEO 监测 admin API (W2-8)

路由前缀 /api/v8/admin/geo
  GET  /llm_configs              列 6 LLM 配置
  PATCH /llm_configs/{llm_code}  改 LLM 配置 (endpoint/auth/enable/rate_limit)
  GET  /orders                   admin 看全部 GEO 订单 (跨客户)
  GET  /observations/stats       平台维度观察数据统计

注: 不实现 LLM 配置 DELETE (因为是预置)
"""
from __future__ import annotations
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session, get_admin_account
from platform_v8.core import Account
from platform_v8.services.geo.schemas import GeoLLMConfig, GeoLLMConfigUpdate

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/admin/geo", tags=["admin-geo"])


# ════════════════════════════════════════════════════════════════
# LLM 配置 (6 LLM)
# ════════════════════════════════════════════════════════════════
@router.get("/llm_configs", response_model=list[GeoLLMConfig])
def list_llm_configs(
    s: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
) -> list[GeoLLMConfig]:
    rows = s.execute(
        text(
            "SELECT id, llm_code, display_name, api_endpoint, auth_type, "
            "       auth_secret_ref, rate_limit_per_min, avg_latency_ms, "
            "       enabled, metadata "
            "FROM we_geo_llm_configs "
            "ORDER BY llm_code"
        )
    ).mappings().all()
    
    import json
    out: list[GeoLLMConfig] = []
    for r in rows:
        md = r["metadata"]
        if isinstance(md, str):
            md = json.loads(md)
        out.append(GeoLLMConfig(
            id=r["id"],
            llm_code=r["llm_code"],
            display_name=r["display_name"],
            api_endpoint=r["api_endpoint"],
            auth_type=r["auth_type"],
            auth_secret_ref=r["auth_secret_ref"],
            rate_limit_per_min=r["rate_limit_per_min"],
            avg_latency_ms=r["avg_latency_ms"],
            enabled=r["enabled"],
            metadata=md or {},
        ))
    return out


@router.patch("/llm_configs/{llm_code}", response_model=GeoLLMConfig)
def update_llm_config(
    llm_code: str,
    body: GeoLLMConfigUpdate,
    s: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
) -> GeoLLMConfig:
    """admin 改 LLM 配置 (display_name/endpoint/auth_type/secret_ref/rate_limit/enabled)
    
    不允许改 llm_code (主键)
    """
    updates: list[str] = []
    params: dict = {"llm_code": llm_code}
    fields_map = {
        "display_name": body.display_name,
        "api_endpoint": body.api_endpoint,
        "auth_type": body.auth_type,
        "auth_secret_ref": body.auth_secret_ref,
        "rate_limit_per_min": body.rate_limit_per_min,
        "enabled": body.enabled,
    }
    for col, val in fields_map.items():
        if val is not None:
            updates.append(f"{col} = :{col}")
            params[col] = val
    
    if not updates:
        # 没改 · 直接返当前
        return _get_one_llm_config(s, llm_code)
    
    updates.append("updated_at = NOW()")
    s.execute(
        text(
            f"UPDATE we_geo_llm_configs SET {', '.join(updates)} "
            "WHERE llm_code = :llm_code"
        ),
        params,
    )
    s.commit()
    
    cfg = _get_one_llm_config(s, llm_code)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"LLM {llm_code} 不存在")
    return cfg


def _get_one_llm_config(s: Session, llm_code: str) -> GeoLLMConfig | None:
    row = s.execute(
        text(
            "SELECT id, llm_code, display_name, api_endpoint, auth_type, "
            "       auth_secret_ref, rate_limit_per_min, avg_latency_ms, "
            "       enabled, metadata "
            "FROM we_geo_llm_configs WHERE llm_code = :llm_code"
        ),
        {"llm_code": llm_code},
    ).mappings().first()
    if not row:
        return None
    import json
    md = row["metadata"]
    if isinstance(md, str):
        md = json.loads(md)
    return GeoLLMConfig(
        id=row["id"],
        llm_code=row["llm_code"],
        display_name=row["display_name"],
        api_endpoint=row["api_endpoint"],
        auth_type=row["auth_type"],
        auth_secret_ref=row["auth_secret_ref"],
        rate_limit_per_min=row["rate_limit_per_min"],
        avg_latency_ms=row["avg_latency_ms"],
        enabled=row["enabled"],
        metadata=md or {},
    )


# ════════════════════════════════════════════════════════════════
# admin 看全部 GEO 订单 (跨客户)
# ════════════════════════════════════════════════════════════════
@router.get("/orders")
def admin_list_orders(
    limit: int = 100,
    status: str | None = None,
    s: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
) -> dict:
    where = ["(w.spec->>'task_type') = 'geo_query'"]
    params: dict = {"limit": min(limit, 500)}
    if status:
        where.append("w.status = :status")
        params["status"] = status
    
    rows = s.execute(
        text(
            "SELECT w.id, w.name, w.status, w.owner_id, a.username AS owner_name, "
            "       w.budget, w.spent, w.created_at, w.completed_at, "
            "       w.total_shards, w.completed_shards "
            "FROM we_workloads w "
            "LEFT JOIN we_accounts a ON a.id = w.owner_id "
            f"WHERE {' AND '.join(where)} "
            "ORDER BY w.created_at DESC LIMIT :limit"
        ),
        params,
    ).mappings().all()
    
    items = [
        {
            "workload_id": str(r["id"]),
            "name": r["name"],
            "status": r["status"],
            "owner_id": r["owner_id"],
            "owner_name": r["owner_name"],
            "budget": float(r["budget"] or 0),
            "spent": float(r["spent"] or 0),
            "total_shards": r["total_shards"] or 0,
            "completed_shards": r["completed_shards"] or 0,
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "completed_at": r["completed_at"].isoformat() if r["completed_at"] else None,
        }
        for r in rows
    ]
    return {"items": items, "total": len(items)}


# ════════════════════════════════════════════════════════════════
# 平台观察数据统计
# ════════════════════════════════════════════════════════════════
@router.get("/observations/stats")
def observations_stats(
    s: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
) -> dict:
    """平台维度统计 · 各 LLM 总查询数 / 总提及数 / 客户数"""
    rows = s.execute(
        text(
            "SELECT llm_code, "
            "       COUNT(*) AS sample_count, "
            "       SUM(mention_count) AS mention_total, "
            "       COUNT(DISTINCT brand_id) AS brand_count "
            "FROM we_geo_observations "
            "GROUP BY llm_code "
            "ORDER BY sample_count DESC"
        )
    ).mappings().all()
    
    total = s.execute(
        text("SELECT COUNT(*) FROM we_geo_observations")
    ).scalar() or 0
    
    brand_total = s.execute(
        text("SELECT COUNT(*) FROM we_geo_brands")
    ).scalar() or 0
    
    customer_total = s.execute(
        text("SELECT COUNT(DISTINCT customer_id) FROM we_geo_brands")
    ).scalar() or 0
    
    return {
        "total_observations": total,
        "total_brands": brand_total,
        "total_customers": customer_total,
        "by_llm": [
            {
                "llm_code": r["llm_code"],
                "sample_count": r["sample_count"],
                "mention_total": int(r["mention_total"] or 0),
                "brand_count": r["brand_count"],
            }
            for r in rows
        ],
    }
