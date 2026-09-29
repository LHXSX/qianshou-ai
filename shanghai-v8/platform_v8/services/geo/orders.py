"""
GEO 监测 · 订单创建 (W2-4)

设计:
  - 一个 GEO 订单 = 一个统一 workload (task_type=geo_query · mode=PULL)
  - 一个 shard = 一次 LLM 查询 (brand × keyword × llm)
  - 不走 lifecycle.start 标准 slice 流程 · 因为 GEO 需要在 create 时就显式 build N 个 shard
  - workload 状态直接 CREATED → RUNNING (跳过 PLANNED · 因为 shard 已 build)
  - 节点 PullRequest 抢 shard 后自动跑 geo_query.py 脚本

跟标准 lifecycle.start 区别:
  - 标准: workload → lifecycle.start → slicer → N shards (slicer 内决定切法)
  - GEO:  workload → geo orders.create_geo_order → N shards (直接 build · 因为业务知道精确切法)
  - 都用统一 we_workloads/we_shards 表 · 都走 ledger (统一 reward)

MVP 说明:
  - LLM api_key 直接存 spec.params · admin 可见 · 后续 P2 用 augmenter hook 改 (lease 时注入)
"""
from __future__ import annotations
import itertools
import logging
import os
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.core import (
    Shard, ShardMode, ShardStatus, Workload, WorkloadSpec, WorkloadStatus,
    Runtime, TaskKind, AuditAction,
)
from platform_v8.storage.repo import (
    WorkloadRepo, ShardRepo, AuditRepo,
)
from platform_v8.services.economy import balance as balance_svc
from platform_v8.services.economy import ledger as ledger_svc

from . import brands as brands_svc
from .schemas import GeoOrderCreate, GeoOrderSummary

logger = logging.getLogger(__name__)


class GeoOrderError(Exception):
    pass


# ════════════════════════════════════════════════════════════════
# 1. 创建订单 → workload + N shards
# ════════════════════════════════════════════════════════════════
def create_geo_order(
    s: Session, *,
    customer_id: int,
    data: GeoOrderCreate,
) -> Workload:
    """创建 GEO 监测订单 · 返 Workload
    
    流程:
      1. 校验 brand 属于 customer
      2. 校验 llm_codes 都 enabled · 拿 endpoint/auth
      3. 算 total_queries + budget
      4. 检查余额 + escrow_hold
      5. 创建 workload (mode=PULL · status=CREATED)
      6. build N shards 一次性写入 (跳过 lifecycle.slice · 业务自己切)
      7. workload → RUNNING (节点 PullRequest 抢)
      8. 写审计
    """
    # 1. 校验 brand
    brand = brands_svc.get_brand(s, data.brand_id, customer_id=customer_id)
    if brand is None:
        raise GeoOrderError(f"品牌 {data.brand_id} 不存在或不属于您")
    
    # 2. 校验 LLM (取 enabled 的)
    llm_configs = _load_llm_configs(s, data.llm_codes)
    missing = set(data.llm_codes) - set(llm_configs.keys())
    if missing:
        raise GeoOrderError(f"LLM 不可用: {sorted(missing)}")
    
    # 3. 算总量 + 预算
    total_queries = len(data.keywords) * len(data.llm_codes)
    if total_queries == 0:
        raise GeoOrderError("keywords / llm_codes 不能为空")
    if total_queries > 500:
        raise GeoOrderError(f"单订单不超过 500 query (当前 {total_queries})")
    
    total_budget = (data.unit_price_edg * Decimal(total_queries)).quantize(Decimal("0.0001"))
    
    # 4. 余额检查 + escrow_hold
    if total_budget > 0:
        bal = balance_svc.get_balance(s, customer_id)
        if bal < total_budget:
            raise GeoOrderError(
                f"余额不足 (当前 {bal} · 需要 {total_budget})"
            )
        ledger_svc.escrow_hold(
            s, account_id=customer_id, amount=total_budget,
            workload_id=None,  # workload 还没建 · 先 escrow · 后面 update
            note=f"GEO 监测预算 · {brand.brand_name} × {total_queries} query",
        )
    
    # 5. 创建 workload
    wl_id = str(uuid.uuid4())
    wl_name = data.name or f"GEO 监测 · {brand.brand_name} ({total_queries} query)"
    
    spec = WorkloadSpec(
        kind=TaskKind.DATA_PROCESSING,
        task_type="geo_query",
        runtime=Runtime.PYTHON3,
        code_url=_resolve_geo_query_script_url(),
        input_kind="params_only",
        params={
            "brand_id": brand.id,
            "brand_name": brand.brand_name,
            "brand_aliases": brand.brand_aliases,
            "category": brand.category,
            # LLM 端点 · 节点端 geo_query.py 用
            # 注意: api_key 也在这里 (MVP 简化 · 后续 P2 改 lease-time 注入)
            "llm_endpoints": {
                code: {
                    "endpoint": cfg["api_endpoint"],
                    "auth_type": cfg["auth_type"],
                    "api_key": _resolve_secret(cfg["auth_secret_ref"]),
                }
                for code, cfg in llm_configs.items()
            },
        },
        timeout_s=180,  # 单 LLM 调用 ≤ 3min
        max_shards=total_queries,
    )
    
    wl = Workload(
        id=wl_id,
        owner_id=customer_id,
        name=wl_name,
        status=WorkloadStatus.CREATED,
        spec=spec,
        budget=total_budget,
        total_shards=total_queries,
        created_at=datetime.utcnow(),
    )
    WorkloadRepo.create(s, wl)
    
    # 6. 一次性 build N shards (跳过 slicer)
    shards: list[Shard] = []
    for idx, (keyword, llm_code) in enumerate(
        itertools.product(data.keywords, data.llm_codes)
    ):
        shards.append(Shard(
            workload_id=wl_id,
            index=idx,
            total=total_queries,
            status=ShardStatus.PENDING,
            mode=ShardMode.PULL,
            input_ref="",
            metadata={
                "params": {
                    "keyword": keyword,
                    "llm_code": llm_code,
                },
                # GEO 业务标识 · aggregator hook 看到这个就跑 nlp_analyze
                "business": "geo",
            },
        ))
    ShardRepo.create_batch(s, shards)
    
    # 7. workload → RUNNING (节点抢)
    WorkloadRepo.update_status(
        s, wl_id, WorkloadStatus.RUNNING,
        total_shards=total_queries,
        started_at=datetime.utcnow(),
    )
    
    # 8. 审计
    try:
        AuditRepo.write(
            s,
            action="geo.order.created",
            actor_account_id=customer_id,
            actor_kind="customer",
            target_kind="workload",
            target_id=wl_id,
            detail={
                "brand_id": brand.id,
                "brand_name": brand.brand_name,
                "keyword_count": len(data.keywords),
                "llm_count": len(data.llm_codes),
                "total_queries": total_queries,
                "total_budget_edg": str(total_budget),
            },
        )
    except Exception as exc:
        logger.warning("geo.order.created · audit fail (silent): %s", exc)
    
    logger.info("geo.create_order · customer=%s brand=%s queries=%d budget=%s wl=%s",
                customer_id, brand.brand_name, total_queries, total_budget, wl_id)
    
    return wl


# ════════════════════════════════════════════════════════════════
# 2. 查订单概览 (列表 + 详情)
# ════════════════════════════════════════════════════════════════
def list_orders(
    s: Session, *,
    customer_id: int,
    limit: int = 50,
) -> list[GeoOrderSummary]:
    """列客户的 GEO 订单 (按时间倒序)"""
    rows = s.execute(
        text(
            "SELECT w.id, w.name, w.status, w.budget, w.spent, w.created_at, w.completed_at, "
            "       w.spec, w.total_shards, w.completed_shards "
            "FROM we_workloads w "
            "WHERE w.owner_id = :cid "
            "  AND (w.spec->>'task_type') = 'geo_query' "
            "ORDER BY w.created_at DESC LIMIT :limit"
        ),
        {"cid": customer_id, "limit": limit},
    ).mappings().all()
    
    out: list[GeoOrderSummary] = []
    for r in rows:
        spec = r["spec"]
        if isinstance(spec, str):
            import json
            spec = json.loads(spec)
        params = spec.get("params") or {}
        out.append(GeoOrderSummary(
            workload_id=str(r["id"]),
            brand_id=int(params.get("brand_id", 0)),
            brand_name=str(params.get("brand_name", "")),
            name=r["name"] or "",
            keywords=[],  # 列表页不返 keywords (大 · 详情才返)
            llm_codes=list(params.get("llm_endpoints", {}).keys()),
            total_queries=r["total_shards"] or 0,
            completed_queries=r["completed_shards"] or 0,
            status=r["status"],
            unit_price_edg=Decimal("0"),  # MVP: spec 没存 unit_price · 算 budget/total
            total_budget_edg=Decimal(str(r["budget"] or 0)),
            spent_edg=Decimal(str(r["spent"] or 0)),
            created_at=r["created_at"],
            completed_at=r["completed_at"],
        ))
    return out


# ════════════════════════════════════════════════════════════════
# helpers
# ════════════════════════════════════════════════════════════════
def _load_llm_configs(s: Session, llm_codes: list[str]) -> dict[str, dict[str, Any]]:
    """从 we_geo_llm_configs 取 N 个 LLM 的配置 (只取 enabled=true)"""
    rows = s.execute(
        text(
            "SELECT llm_code, display_name, api_endpoint, auth_type, auth_secret_ref, "
            "       rate_limit_per_min, avg_latency_ms "
            "FROM we_geo_llm_configs "
            "WHERE llm_code = ANY(:codes) AND enabled = TRUE"
        ),
        {"codes": llm_codes},
    ).mappings().all()
    return {r["llm_code"]: dict(r) for r in rows}


def _resolve_secret(secret_ref: str) -> str:
    """从 env / vault 解析 secret 值
    
    MVP: 只从 env · P2 接 vault / aws secrets manager
    """
    if not secret_ref:
        return ""
    val = os.environ.get(secret_ref, "")
    if not val:
        logger.warning("geo._resolve_secret · env %s 未设置 · 节点端 LLM 调用会失败",
                       secret_ref)
    return val


def _resolve_geo_query_script_url() -> str:
    """节点端拉 geo_query.py 脚本的 URL
    
    复用 platform_v8 的 /api/v8/scripts/{task_type}.py 路由 (节点 executor 已支持)
    """
    base = os.environ.get("V8_PUBLIC_BASE_URL", "")
    if base:
        return f"{base.rstrip('/')}/api/v8/scripts/geo_query.py"
    # 默认相对路径 · 让节点端用 server_url 拼
    return "/api/v8/scripts/geo_query.py"
