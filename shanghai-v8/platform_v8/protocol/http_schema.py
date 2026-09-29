"""
HTTP 协议 schema · 全平台 endpoint 共享 pydantic 模型

设计要点 (考虑全链路):
  1. 所有 Request/Response model 都在这里 · 不散在各 router 文件
  2. 共享的"出参" (e.g. AccountOut) 一份定义 · 多处复用
  3. 客户端可直接对照这文件生成 TypeScript / Rust 类型
  4. 字段命名 snake_case · 跟 Python convention 一致
  5. 显式 example · 自动生成 /docs Swagger UI 更好用
"""
from __future__ import annotations
import dataclasses as _dc
import copy as _copy
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal
from pydantic import BaseModel, EmailStr, Field, ConfigDict, field_validator, model_validator
from platform_v8.protocol.media_profile import MediaInput


def _dataclass_to_dict(v: Any) -> Any:
    """通用 helper · 自动把 dataclass 转 dict (pydantic 验证器用)

    解决 core/*.py 里的 dataclass 字段 (WorkerCapabilities/WorkloadSpec/...)
    被嵌入 Out model 时需要自动序列化的问题。
    """
    if v is None or isinstance(v, dict):
        return v
    if _dc.is_dataclass(v):
        return _dc.asdict(v)
    return v


def _to_str(v: Any) -> Any:
    """通用 helper · 把 UUID / 其他对象转字符串 (pydantic 验证器用)

    Postgres UUID 列返 UUID 对象 · pydantic str 字段不接受 · 需要转换。
    sqlite 用 String 存 · 返 str · 无需转换 (但 _to_str 也兼容)。
    """
    if v is None or isinstance(v, str):
        return v
    return str(v)


# ════════════════════════════════════════════════════════════════════
# 通用响应包装 (统一)
# ════════════════════════════════════════════════════════════════════
class ErrorResponse(BaseModel):
    """统一错误响应 (跟 api/app.py 的 exception_handler 对应)"""
    ok: bool = False
    code: str = Field(..., examples=["http_400", "validation_error"])
    message: str
    trace_id: str | None = None


# ════════════════════════════════════════════════════════════════════
# Account · 用户账号
# ════════════════════════════════════════════════════════════════════
class AccountOut(BaseModel):
    """用户公开信息 (脱敏 · 不含 password_hash)"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    email: str
    role: str = Field(..., examples=["personal", "enterprise", "channel", "admin"])
    status: str = Field(..., examples=["active", "suspended", "deleted"])
    balance: Decimal = Field(default=Decimal("0"))
    created_at: datetime
    last_login_at: datetime | None = None

    @field_validator("role", "status", mode="before")
    @classmethod
    def _enum_to_str(cls, v):
        return v.value if hasattr(v, "value") else v


# ── 注册 ─────────────────────────────────────────────
class RegisterRequest(BaseModel):
    username: str | None = Field(default=None, min_length=1, max_length=64,
                                 description="可选 · 不填从 email 自动生成",
                                 examples=["chatuser"])
    password: str = Field(..., min_length=6, max_length=128,
                          examples=["Test-2026!"])
    email: EmailStr | None = Field(default=None,
                                   description="可选 · 不填用 <username>@local 占位",
                                   examples=["chat@x.com"])
    # 企业控制台 (/wq) 传 company=enterprise → 落库 enterprise；其它端不传则仍 personal。
    # 绝不接受 admin 等提权值。
    company: str | None = Field(default=None, max_length=64,
                                description="可选 · enterprise 表示企业控制台自助注册")
    remember_me: bool = False

    @field_validator("username", mode="before")
    @classmethod
    def _username_fallback(cls, v, info):
        if not v or not str(v).strip():
            email = info.data.get("email")
            if email:
                return str(email).split("@")[0]
            import secrets, string
            return "user_" + "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(6))
        return str(v).strip()


# ── 登录 ─────────────────────────────────────────────
class LoginRequest(BaseModel):
    username: str = Field(..., description="用户名 或 邮箱",
                          examples=["chatuser"])
    password: str = Field(..., examples=["Test-2026!"])
    remember_me: bool = False


class LoginTotpRequest(BaseModel):
    challenge_token: str = Field(..., min_length=20, max_length=4096)
    code: str = Field(..., pattern=r"^\d{6}$")
    trust_device: bool = False
    remember_me: bool | None = None


class SessionTrustRequest(BaseModel):
    duration: Literal["7d", "30d", "90d", "permanent"]
    current_password: str = Field(..., min_length=1, max_length=128)
    code: str = Field(..., pattern=r"^\d{6}$")


class TokenPair(BaseModel):
    """JWT 双 token (access 短 + refresh 长)"""
    access_token: str
    refresh_token: str | None = None
    token_type: str = "Bearer"
    expires_in: int = Field(..., description="access_token 有效秒数",
                            examples=[900])


class LoginResponse(BaseModel):
    """登录成功响应"""
    ok: bool = True
    tokens: TokenPair
    account: AccountOut


# ── /me ──────────────────────────────────────────────
class MeResponse(BaseModel):
    """当前登录用户信息"""
    ok: bool = True
    account: AccountOut


# ── refresh ──────────────────────────────────────────
class RefreshRequest(BaseModel):
    refresh_token: str | None = None


class RefreshResponse(BaseModel):
    ok: bool = True
    tokens: TokenPair


# ════════════════════════════════════════════════════════════════════
# Worker · 节点 (链路 3 用 · 这里先定义 · 后续会扩)
# ════════════════════════════════════════════════════════════════════
class WorkerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    owner_id: int
    name: str
    status: str
    capabilities: dict[str, Any] = Field(default_factory=dict)
    load: float = 0.0
    active_shards: int = 0
    last_seen: datetime | None = None
    registered_at: datetime
    client_version: str = ""
    capability_score: float = 0.0
    reputation: float = 0.5
    disabled_until: datetime | None = None
    disabled_at: datetime | None = None
    disabled_by: int | None = None
    disabled_reason: str = ""
    # 硬件展平字段（由 @field_validator 从 capabilities 填充）
    cpu_cores: int = 0
    memory_gb: float = 0.0
    gpu_count: int = 0
    gpu_model: str = ""

    @field_validator("id", mode="before")
    @classmethod
    def _id_to_str(cls, v):
        return _to_str(v)

    @field_validator("status", mode="before")
    @classmethod
    def _status_to_str(cls, v):
        return v.value if hasattr(v, "value") else v

    @field_validator("capabilities", mode="before")
    @classmethod
    def _caps_to_dict(cls, v):
        return _dataclass_to_dict(v)

    @model_validator(mode="after")
    def _fill_hardware(self):
        """model_validate 后从 capabilities 反哺硬件展平字段"""
        caps = self.capabilities or {}
        if not isinstance(caps, dict):
            return self
        if self.cpu_cores == 0:
            self.cpu_cores = int(caps.get("cpu_cores") or caps.get("cpu_count") or 0)
        if self.memory_gb == 0.0:
            mem_mb = int(caps.get("total_memory_mb", 0) or 0)
            self.memory_gb = round(mem_mb / 1024, 1) if mem_mb else float(caps.get("memory_gb", 0))
        if self.gpu_count == 0:
            self.gpu_count = caps.get("gpu_count", 0)
        if not self.gpu_model:
            self.gpu_model = caps.get("gpu_model", "")
        return self


# ════════════════════════════════════════════════════════════════════
# Workload · 任务 (链路 4 用 · 这里先定义 · 后续会扩)
# ════════════════════════════════════════════════════════════════════
class WorkloadSpecIn(BaseModel):
    """提交任务时 spec 字段"""

    @model_validator(mode="before")
    @classmethod
    def reject_unverified_plugin_dispatch(cls, value: Any) -> Any:
        # Pydantic ignores unknown top-level fields by default. Reject the raw
        # input before a plugin_id/release_id could be silently stripped and
        # the remaining task interpreted as an ordinary legacy workload.
        from platform_v8.services.marketplace.execution_model import requests_plugin_dispatch
        if requests_plugin_dispatch(value):
            raise ValueError("插件执行尚未开放：缺少经审核的版本、机主授权与节点绑定")
        return value

    kind: str = "DATA_PROCESSING"
    task_type: str = Field(..., examples=["base64_encode"])
    runtime: str = "python3"
    code_url: str = ""
    # 2026-05-18 · 扩展 input 协议
    # input_kind 空 = backend 自动推断 (有 inline → inline · 有 input_refs → multi_file · 否则 single_file)
    input_kind: str = Field(default="", examples=["inline", "single_file", "multi_file", "archive", "stream", "params_only"])
    input_ref: str = ""
    input_refs: list[str] = Field(default_factory=list)
    inline_input: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    media_input: MediaInput | None = None
    max_shards: int = Field(default=1, ge=1, le=100)
    verification_policy: Literal["semantic", "artifact", "quarantine"] | None = Field(
        default=None,
        description="只读策略提示；必须与 task registry 一致，调用方不能提权覆盖",
    )
    # 2026-07-31 · 显式关闭自动拉满分片上限（否则 pydantic 丢掉该字段 → 永远 auto_shard=true）
    auto_shard: bool = Field(
        default=True,
        description="true=按 task max_shards_limit 拉满；false=尊重调用方 max_shards",
    )
    # 2026-05-18 · 冗余派发 (anti_cheat 多数派比对)
    redundancy_factor: int = Field(default=1, ge=1, le=5,
        description="同一片派给 N 个不同节点 · finalize 时多数派比对 · >=2 启用 anti_cheat")
    timeout_s: int = Field(default=300, ge=1, le=3600)
    requirements: dict[str, Any] = Field(default_factory=dict)
    # LAN dual-path · Runtime V2；空=由 params.execution_model 决定；老客户端可忽略
    execution_model: str = ""


class SubmitWorkloadRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    spec: WorkloadSpecIn
    budget: Decimal = Field(default=Decimal("0"), ge=0)
    quote_token: str | None = Field(default=None, max_length=4096)
    request_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")


class WorkloadOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    owner_id: int
    name: str
    spec: dict[str, Any]
    status: str
    progress: float = 0.0
    total_shards: int = 0
    completed_shards: int = 0
    failed_shards: int = 0
    result: dict[str, Any] | None = None
    budget: Decimal
    error: str = ""
    created_at: datetime
    completed_at: datetime | None = None

    @field_validator("id", mode="before")
    @classmethod
    def _id_to_str(cls, v):
        return _to_str(v)

    @field_validator("status", mode="before")
    @classmethod
    def _status_to_str(cls, v):
        return v.value if hasattr(v, "value") else v

    @field_validator("spec", "result", mode="before")
    @classmethod
    def _dc_to_dict(cls, v):
        return _dataclass_to_dict(v)

    @field_validator("spec", mode="after")
    @classmethod
    def _redact_film_task_credentials(cls, value):
        # HTTP output only. The engine's stored spec and WS worker assignment
        # must retain their task-scoped credentials and execution context.
        params = value.get("params")
        eco = params.get("eco_app") if isinstance(params, dict) else None
        if not isinstance(eco, dict) or eco.get("id") != "qianshou-film":
            return value
        public = _copy.deepcopy(value)
        public["params"].pop("api_key", None)
        public["params"].pop("_media_execution", None)
        return public
