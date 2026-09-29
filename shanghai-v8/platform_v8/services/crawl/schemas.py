"""
数据采集 · pydantic v2 schemas

按 4 个实体分组: DataSource / Recipe / Order / Subtask
每个实体 3 种变体: In (创建) · Patch (更新) · Out (返回)

node_id 在 schema 中用 str 表达 (UUID 字符串) · DB 层是真 UUID 类型
"""
from __future__ import annotations
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, ConfigDict


# ════════════════════════════════════════════════════════════════════
# DataSource
# ════════════════════════════════════════════════════════════════════
class DataSourceIn(BaseModel):
    code: str = Field(..., min_length=2, max_length=64)
    title: str = Field(..., min_length=2, max_length=200)
    description: str = ""
    allowed_domain: str = Field(..., min_length=3)
    robots_url: Optional[str] = None
    rate_limit_qps: Decimal = Decimal("1.0")
    license: str = ""
    category: str = "general"
    tags: list[str] = Field(default_factory=list)
    is_published: bool = False


class DataSourcePatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    allowed_domain: Optional[str] = None
    robots_url: Optional[str] = None
    rate_limit_qps: Optional[Decimal] = None
    license: Optional[str] = None
    category: Optional[str] = None
    tags: Optional[list[str]] = None
    is_published: Optional[bool] = None


class DataSourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str
    title: str
    description: str
    allowed_domain: str
    robots_url: Optional[str]
    rate_limit_qps: Decimal
    license: str
    category: str
    tags: list[str]
    is_published: bool
    created_at: datetime
    updated_at: datetime


# ════════════════════════════════════════════════════════════════════
# Recipe
# ════════════════════════════════════════════════════════════════════
ParserType = Literal["json", "json_path", "rss", "text_raw"]


class ParamSpec(BaseModel):
    name: str
    type: Literal["string", "int", "float", "bool"]
    required: bool = True
    default: Optional[Any] = None
    description: str = ""


class RecipeIn(BaseModel):
    datasource_id: int
    code: str = Field(..., min_length=2, max_length=64)
    title: str = Field(..., min_length=2, max_length=200)
    url_template: str = Field(..., min_length=8)
    method: Literal["GET", "POST"] = "GET"
    headers_json: dict[str, str] = Field(default_factory=dict)
    timeout_ms: int = Field(10000, ge=1000, le=60000)
    params_schema: list[ParamSpec] = Field(default_factory=list)
    parser_type: ParserType
    parser_config: dict[str, Any] = Field(default_factory=dict)
    unit_price_edg: Decimal = Decimal("0.01")
    is_active: bool = True


class RecipePatch(BaseModel):
    title: Optional[str] = None
    url_template: Optional[str] = None
    method: Optional[Literal["GET", "POST"]] = None
    headers_json: Optional[dict[str, str]] = None
    timeout_ms: Optional[int] = None
    params_schema: Optional[list[ParamSpec]] = None
    parser_type: Optional[ParserType] = None
    parser_config: Optional[dict[str, Any]] = None
    unit_price_edg: Optional[Decimal] = None
    is_active: Optional[bool] = None


class RecipeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    datasource_id: int
    code: str
    title: str
    url_template: str
    method: str
    headers_json: dict
    timeout_ms: int
    params_schema: list[dict]
    parser_type: str
    parser_config: dict
    unit_price_edg: Decimal
    is_active: bool
    created_at: datetime
    updated_at: datetime


# ════════════════════════════════════════════════════════════════════
# Order
# ════════════════════════════════════════════════════════════════════
class OrderQuoteIn(BaseModel):
    """下单前询价 · 输入预期参数即可估出总价"""
    recipe_id: int
    total_count: int = Field(..., ge=1, le=1_000_000)
    verify_level: Literal[1, 2] = 1
    priority: Literal[0, 1] = 0


class OrderQuoteOut(BaseModel):
    recipe_id: int
    total_count: int
    unit_price_edg: Decimal
    verify_multiplier: Decimal
    priority_multiplier: Decimal
    final_unit_price_edg: Decimal
    total_price_edg: Decimal
    platform_fee_pct: Decimal
    node_payout_per_subtask: Decimal


class OrderIn(BaseModel):
    recipe_id: int
    title: str = ""
    total_count: int = Field(..., ge=1, le=1_000_000)
    concurrency: int = Field(10, ge=1, le=10_000)
    verify_level: Literal[1, 2] = 1
    priority: Literal[0, 1] = 0
    params_oss_url: str = Field(..., min_length=10)
    webhook_url: Optional[str] = None
    consent_signature: str = Field(
        ..., min_length=16,
        description="客户勾选合规声明后前端算的 hash · 用于事后审计",
    )


class OrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    customer_id: int
    recipe_id: int
    title: str
    total_count: int
    concurrency: int
    verify_level: int
    priority: int
    unit_price_edg: Decimal
    total_price_edg: Decimal
    platform_fee_pct: Decimal
    status: str
    completed_count: int
    failed_count: int
    params_oss_url: str
    result_oss_url: Optional[str]
    webhook_url: Optional[str]
    created_at: datetime
    started_at: Optional[datetime]
    completed_at: Optional[datetime]


class OrderProgressOut(BaseModel):
    order_id: int
    status: str
    total_count: int
    completed_count: int
    failed_count: int
    pending_count: int
    leased_count: int
    pending_verify_count: int
    percent_done: float


# ════════════════════════════════════════════════════════════════════
# Subtask · 节点拉取/上报
# ════════════════════════════════════════════════════════════════════
class PullIn(BaseModel):
    node_id: str = Field(..., description="UUID 字符串")
    max_count: int = Field(1, ge=1, le=8)
    datasource_filter: Optional[int] = None


class SubtaskAssign(BaseModel):
    """节点 pull 返回的单条子任务规格 · 含执行所需全部信息"""
    subtask_id: int
    order_id: int
    recipe_id: int
    parser_type: str
    url_template: str
    method: str
    headers_json: dict
    timeout_ms: int
    parser_config: dict
    params_json: dict
    lease_expires_at: datetime
    is_verify_run: bool = False


class PullOut(BaseModel):
    assignments: list[SubtaskAssign]


class CompleteIn(BaseModel):
    subtask_id: int
    node_id: str
    result_oss_url: str
    result_hash: str
    result_size_bytes: int = 0


class FailIn(BaseModel):
    subtask_id: int
    node_id: str
    error_msg: str = ""


class NodeConsentIn(BaseModel):
    node_id: str
    consent_text_hash: str
    max_concurrency: int = Field(4, ge=1, le=32)


# ════════════════════════════════════════════════════════════════════
# 计费倍率常量 (与 spec §9 一致)
# ════════════════════════════════════════════════════════════════════
VERIFY_MULTIPLIER: dict[int, Decimal] = {
    1: Decimal("1.0"),
    2: Decimal("1.95"),  # 双跑 · 略低于 2x 让客户有动力升级
}
PRIORITY_MULTIPLIER: dict[int, Decimal] = {
    0: Decimal("1.0"),
    1: Decimal("2.0"),
}
DEFAULT_PLATFORM_FEE_PCT: Decimal = Decimal("15.00")
