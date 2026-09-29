"""
GEO 监测 · DTO + API schema (W2-2)

业务 schema (vs 协议层 ws_schema):
  - 客户提订单 → GeoOrderCreate
  - 客户拉报表 → GeoReport
  - admin 配 LLM → GeoLLMConfigUpdate
"""
from __future__ import annotations
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator


# ════════════════════════════════════════════════════════════════
# LLM 配置 (admin · 6 LLM)
# ════════════════════════════════════════════════════════════════
class GeoLLMConfig(BaseModel):
    id: int
    llm_code: str
    display_name: str
    api_endpoint: str
    auth_type: str
    auth_secret_ref: str
    rate_limit_per_min: int
    avg_latency_ms: int
    enabled: bool
    metadata: dict = Field(default_factory=dict)


class GeoLLMConfigUpdate(BaseModel):
    """admin 改 LLM 配置 (不改 llm_code)"""
    display_name: str | None = None
    api_endpoint: str | None = None
    auth_type: str | None = None
    auth_secret_ref: str | None = None
    rate_limit_per_min: int | None = Field(None, ge=1, le=10000)
    enabled: bool | None = None


# ════════════════════════════════════════════════════════════════
# 品牌库
# ════════════════════════════════════════════════════════════════
class GeoBrand(BaseModel):
    id: int
    customer_id: int
    brand_name: str
    brand_aliases: list[str] = Field(default_factory=list)
    category: str | None = None
    metadata: dict = Field(default_factory=dict)
    created_at: datetime


class GeoBrandCreate(BaseModel):
    brand_name: str = Field(..., min_length=1, max_length=128)
    brand_aliases: list[str] = Field(default_factory=list, max_length=20)
    category: str | None = Field(None, max_length=64)
    metadata: dict = Field(default_factory=dict)


class GeoBrandUpdate(BaseModel):
    brand_aliases: list[str] | None = None
    category: str | None = None
    metadata: dict | None = None


# ════════════════════════════════════════════════════════════════
# 监测订单 (= 1 个 workload)
# ════════════════════════════════════════════════════════════════
class GeoOrderCreate(BaseModel):
    """客户创建监测订单 · server 转成 workload(task_type=geo_query · mode=PULL)"""
    brand_id: int
    keywords: list[str] = Field(..., min_length=1, max_length=50,
                                 description="监测关键词列表 (≤ 50)")
    llm_codes: list[str] = Field(..., min_length=1, max_length=6,
                                  description="LLM 列表 · 子集 of 6")
    name: str | None = Field(None, max_length=128,
                              description="订单名 (空则自动生成)")
    unit_price_edg: Decimal = Field(Decimal("0.01"), ge=Decimal("0.001"), le=Decimal("100"),
                                     description="单次查询单价 EDG")
    platform_fee_pct: Decimal = Field(Decimal("30"), ge=Decimal("0"), le=Decimal("90"),
                                       description="平台抽成 % (default 30%)")

    @field_validator("keywords", "llm_codes")
    @classmethod
    def _strip_empty(cls, v: list[str]) -> list[str]:
        return [s.strip() for s in v if s and s.strip()]


class GeoOrderSummary(BaseModel):
    """订单概览 (列表 + 详情共用)"""
    workload_id: str                       # = we_workloads.id
    brand_id: int
    brand_name: str
    name: str
    keywords: list[str]
    llm_codes: list[str]
    total_queries: int                     # = len(keywords) × len(llm_codes)
    completed_queries: int                 # = 已 done 的 shard 数
    status: str                            # workload.status (CREATED/RUNNING/DONE/...)
    unit_price_edg: Decimal
    total_budget_edg: Decimal              # = unit_price × total_queries
    spent_edg: Decimal                     # = 已结算 (含进度)
    created_at: datetime
    completed_at: datetime | None


# ════════════════════════════════════════════════════════════════
# 观察数据 (raw)
# ════════════════════════════════════════════════════════════════
class GeoObservation(BaseModel):
    id: int
    workload_id: str
    shard_id: str
    brand_id: int
    brand_name: str | None = None          # 反查填充 (前端展示用)
    keyword: str
    llm_code: str
    observed_at: datetime
    mention_count: int = 0
    rank_position: int | None = None
    sentiment: float | None = None          # -1.0 ~ 1.0
    recommended: bool = False
    competitors: list[str] = Field(default_factory=list)
    raw_excerpt: str | None = None


# ════════════════════════════════════════════════════════════════
# 报表 (聚合)
# ════════════════════════════════════════════════════════════════
class GeoReportPoint(BaseModel):
    """时序数据点 · 一天/小时/周一个"""
    date: date | datetime
    mention_total: int = 0
    avg_rank: float | None = None
    avg_sentiment: float | None = None
    recommended_count: int = 0
    sample_count: int = 0


class GeoReport(BaseModel):
    brand_id: int
    brand_name: str
    period: Literal["daily", "weekly", "monthly"]
    start_date: date
    end_date: date
    llm_breakdown: dict[str, list[GeoReportPoint]] = Field(default_factory=dict)
    summary: dict = Field(default_factory=dict)
    # summary 含 {total_mentions, avg_sentiment, top_competitors, llm_coverage_pct}
