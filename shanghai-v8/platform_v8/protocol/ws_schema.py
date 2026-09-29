"""
WebSocket 协议 schema · v8 worker 通道唯一协议

设计要点 (考虑全链路):
  1. 所有帧用 pydantic Discriminated Union · 自动 dispatch
  2. 显式版本: 所有帧带 v="8.0" · 后续协议演进时 (8.1/9.0) 自动识别
  3. 统一 envelope: {"type": "...", "v": "...", "payload": {...}}
  4. Rust 客户端可对照此文件实现 (注释里给 Rust 等价定义)
  5. 链路 3 实现: hello/welcome/auth/auth_ok/hb/hb_ack/err
     链路 5 扩展: shard_assign/shard_progress/shard_result/shard_cancel

服务器 ← 客户端: hello, auth, hb, shard_result (链路 5), shard_progress (链路 5)
服务器 → 客户端: welcome, auth_ok, hb_ack, shard_assign (链路 5), shard_cancel (链路 5), err
"""
from __future__ import annotations
from typing import Annotated, Any, Literal, Union
from datetime import datetime
import re

from pydantic import (
    BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator, model_serializer,
)


# 协议版本 · 服务器和客户端必须一致 (主版本号匹配)
PROTOCOL_VERSION = "8.0"
SUBPROTOCOL = "edgecompute.v8"


# ════════════════════════════════════════════════════════════════════
# 基类: 所有帧共享 v + type
# ════════════════════════════════════════════════════════════════════
class FrameBase(BaseModel):
    """WS 帧基类"""
    model_config = ConfigDict(extra="forbid")
    v: str = PROTOCOL_VERSION


# ════════════════════════════════════════════════════════════════════
# 1. hello (客户端 → 服务器 · 连接首帧)
# ════════════════════════════════════════════════════════════════════
class HelloPayload(BaseModel):
    client_version: str                                 # e.g. "8.0.0"
    os: str = ""                                        # 'macos'/'linux'/'windows'
    arch: str = ""                                      # 'x86_64'/'aarch64'
    worker_id: str | None = None                        # 已注册过的 worker_id (重连时带)
    capabilities: dict[str, Any] = Field(default_factory=dict)  # cpu/mem/gpu/runtimes
    client_build: str | None = Field(default=None, max_length=128)
    protocol_capabilities: list[str] | None = Field(default=None, max_length=32)

    @field_validator("client_build")
    @classmethod
    def _normalize_client_build(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None

    @field_validator("protocol_capabilities")
    @classmethod
    def _normalize_protocol_capabilities(
        cls, value: list[str] | None,
    ) -> list[str] | None:
        if value is None:
            return None
        normalized: list[str] = []
        for raw in value:
            capability = raw.strip().lower()
            if not capability:
                continue
            if len(capability) > 64:
                raise ValueError("protocol capability exceeds 64 characters")
            if not re.fullmatch(r"[a-z0-9][a-z0-9._:/-]*", capability):
                raise ValueError("invalid protocol capability")
            if capability not in normalized:
                normalized.append(capability)
        return normalized


class Hello(FrameBase):
    type: Literal["hello"] = "hello"
    payload: HelloPayload


# ════════════════════════════════════════════════════════════════════
# 2. welcome (服务器 → 客户端 · 协议协商)
# ════════════════════════════════════════════════════════════════════
class WelcomePayload(BaseModel):
    server_version: str = "8.0.0"
    proto_version: str = PROTOCOL_VERSION
    server_clock: str                                   # ISO timestamp
    min_client_version: str = "8.0.0"
    auth_timeout_s: int = 10
    hb_interval_s: int = 15
    hb_timeout_s: int = 45


class Welcome(FrameBase):
    type: Literal["welcome"] = "welcome"
    payload: WelcomePayload


# ════════════════════════════════════════════════════════════════════
# 3. auth (客户端 → 服务器 · 鉴权)
# ════════════════════════════════════════════════════════════════════
class AuthPayload(BaseModel):
    access_token: str                                   # JWT (link 2 issued)
    name: str = ""                                      # worker 显示名


class Auth(FrameBase):
    type: Literal["auth"] = "auth"
    payload: AuthPayload


# ════════════════════════════════════════════════════════════════════
# 4. auth_ok (服务器 → 客户端 · 鉴权成功)
# ════════════════════════════════════════════════════════════════════
class AuthOkPayload(BaseModel):
    worker_id: str                                      # 服务器分配 / 确认的 worker_id
    owner_id: int
    welcome_back: bool = False                          # True = 已注册过的节点重连
    server_clock: str
    connection_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class AuthOk(FrameBase):
    type: Literal["auth_ok"] = "auth_ok"
    payload: AuthOkPayload


class OrderAdapterChallengeResultPayload(BaseModel):
    """Hashes only. The authenticated worker identity comes from this WS session."""
    model_config = ConfigDict(extra="forbid")
    challenge_nonce: str = Field(min_length=36, max_length=36)
    input_digest: str = Field(min_length=71, max_length=71)
    output_digest: str = Field(min_length=71, max_length=71)
    runtime_digest: str = Field(min_length=71, max_length=71)
    artifact_digest: str = Field(min_length=71, max_length=71)

    @field_validator("input_digest", "output_digest", "runtime_digest", "artifact_digest")
    @classmethod
    def _sha256(cls, value: str) -> str:
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
            raise ValueError("invalid digest")
        return value

    @field_validator("challenge_nonce")
    @classmethod
    def _nonce(cls, value: str) -> str:
        from uuid import UUID
        try:
            if str(UUID(value)) != value:
                raise ValueError("non-canonical nonce")
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid nonce") from exc
        return value


class OrderAdapterChallengeResult(FrameBase):
    type: Literal["order_adapter_challenge_result"] = "order_adapter_challenge_result"
    payload: OrderAdapterChallengeResultPayload


class NativeH3DeviceKeyProofPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    challenge_id: str = Field(min_length=36, max_length=36, pattern=r"^[0-9a-f-]+$")
    signature: str = Field(min_length=86, max_length=86, pattern=r"^[A-Za-z0-9_-]+$")


class NativeH3DeviceKeyProof(FrameBase):
    type: Literal["native_h3_device_key_proof"] = "native_h3_device_key_proof"
    payload: NativeH3DeviceKeyProofPayload


class NativeH3DeviceConfigProof(FrameBase):
    type: Literal["native_h3_device_config_proof"] = "native_h3_device_config_proof"
    v: Literal["8.0"] = "8.0"
    payload: NativeH3DeviceKeyProofPayload


class NativeH3DevicePresencePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    challenge_nonce: str = Field(min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]+$")
    signature: str = Field(min_length=86, max_length=86, pattern=r"^[A-Za-z0-9_-]+$")


class NativeH3DevicePresence(FrameBase):
    type: Literal["native_h3_device_presence"] = "native_h3_device_presence"
    payload: NativeH3DevicePresencePayload


class NativeH3AdapterUpdatePayload(BaseModel):
    """Bounded metadata; source/approval/device proof are independently read by the service."""
    model_config = ConfigDict(extra="forbid", strict=True)
    request_id: str = Field(min_length=36, max_length=36,
        pattern=r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$")
    adapters: list[dict[str, Any]] = Field(max_length=16)

    @model_validator(mode="after")
    def _bounded_metadata(self):
        if len(_json.dumps(self.model_dump(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 32768:
            raise ValueError("native adapter metadata exceeds 32 KiB")
        return self


class NativeH3AdapterUpdate(FrameBase):
    type: Literal["native_h3_adapter_update"] = "native_h3_adapter_update"
    v: Literal["8.0"] = "8.0"
    payload: NativeH3AdapterUpdatePayload


# ════════════════════════════════════════════════════════════════════
# 5. hb (客户端 → 服务器 · 心跳)
# ════════════════════════════════════════════════════════════════════
class HbPayload(BaseModel):
    load: float = 0.0                                   # 0.0 - 1.0 当前负载
    active_shards: int = 0                              # 在跑的 shard 数
    # 2026-05-21 P0-2 · 节能档位 + 模式 · 让 planner 排除暂停节点
    throttle_pct: int | None = None                     # 0-100 · None = 旧客户端未上报
    mode: str | None = None                             # running / paused / battery / scheduled / sleeping
    extra: dict[str, Any] = Field(default_factory=dict)


class Hb(FrameBase):
    type: Literal["hb"] = "hb"
    payload: HbPayload = Field(default_factory=HbPayload)


# ════════════════════════════════════════════════════════════════════
# 6. hb_ack (服务器 → 客户端 · 心跳确认)
# ════════════════════════════════════════════════════════════════════
class HbAckPayload(BaseModel):
    server_clock: str
    server_load: float = 0.0                            # 平台繁忙程度 (做客户端 backoff 参考)


class HbAck(FrameBase):
    type: Literal["hb_ack"] = "hb_ack"
    payload: HbAckPayload


# ════════════════════════════════════════════════════════════════════
# 7. err (服务器 → 客户端 · 任意阶段错误)
# ════════════════════════════════════════════════════════════════════
class ErrPayload(BaseModel):
    code: int                                           # 错误码 (4-digit · 第一位 1=protocol 2=auth 3=quota 4=task)
    message: str
    fatal: bool = False                                 # True = 连接将关闭


class Err(FrameBase):
    type: Literal["err"] = "err"
    payload: ErrPayload


# ════════════════════════════════════════════════════════════════════
# 链路 5 · 任务派发帧 (server → client)
# ════════════════════════════════════════════════════════════════════
class ShardAssignPayload(BaseModel):
    shard_id: str
    workload_id: str
    # Account owning this workload, independently checked against the signed
    # result-upload issuance before any external media bytes are written.
    account_id: int = 0
    attempt: int = 0
    index: int = 0
    total: int = 1
    task_type: str                                      # 'base64_encode' / 'script' / ...
    runtime: str = "python3"                            # 'python3' / 'node' / 'bash' / 'shell'
    code_url: str = ""
    # 2026-08 · 脚本完整性：节点下载后必须校验（空串 = 老服务端兼容，客户端打 warn）
    code_sha256: str = ""
    # 2026-05-18 · 扩展 input 协议
    input_kind: str = "single_file"                     # 节点端按此选 fetch 策略
    input_ref: str = ""                                 # 主 URL
    input_refs: list[str] = Field(default_factory=list) # 多 URL (multi_file)
    input_manifest: dict[str, Any] = Field(default_factory=dict)
    # Exact frozen source/object metadata. Read credentials are issued separately for the current lease.
    file_contract: dict[str, Any] | None = None
    # Authenticated server-owned native v2 attempt identity; never a buyer parameter.
    native_device_lease: dict[str, Any] | None = None
    inline_input: str | None = None
    slice_meta: dict[str, Any] = Field(default_factory=dict)  # 切片元数据 (page 范围 / 时段 / ...)
    params: dict[str, Any] = Field(default_factory=dict)
    verification_policy: Literal["semantic", "artifact", "quarantine"] = "quarantine"
    timeout_s: int = 300
    reward: float = 0.0                                 # 完成这一片的奖励
    deadline: str | None = None                         # ISO timestamp
    # 2026-05-21 · UI 展示用 (谁发的 / 任务叫什么)
    # client 透传到 task_phase 事件 · 算力驾舱卡片显示
    workload_name: str = ""                             # workload.name (e.g. "提取 100 张图 OCR")
    requester_name: str = ""                            # account.username
    requester_avatar: str = ""                          # account.avatar_url (可空)
    created_at_ms: int = 0                              # workload.created_at 毫秒时间戳
    # 2026-05-27 V8.1 · 客户端运行时 tier 路由
    # 节点 v8.1.0+ 用此字段选 venvs/<required_tier>/bin/python 跑脚本
    # 老 8.0.x 客户端忽略此字段 · 仍用打包 cpython · 完全向后兼容
    # 来源: task_registry.resolve_tier_routing(spec) · 由 bundles.task_routing 同源
    required_tier: str = ""                             # "ocr" / "speech" / "vision-ai" / "lite" / ""
    fallback_tiers: list[str] = Field(default_factory=list)  # 主 tier 没装时降级试

    # 2026-06-11 V8.2 RFC · 节点执行层重构 · 推荐执行器(老节点 ignore · 走 PYTHON3)
    # 来源: task_registry.TaskTypeSpec.executor + native_binary + onnx_model
    # native_args 服务端预渲染(含 {input}/{output}/{tempdir} 占位符 · 客户端只在这 3 个位置替换)
    executor: str = ""                                  # "native" / "onnx" / "http" / "python3" / ""
    native_binary: str = ""                             # "ffmpeg" / "vips" / "pdftotext" / ...
    native_args: list[str] = Field(default_factory=list)  # ["-i","{input}","-c:v","libx264","{output}"]
    onnx_model: str = ""                                # "rapid_ocr_v1" / "clip_vit_b32_v1" / ...
    # artifact.v1 · 结果上传租约 (HMAC · 老客户端 ignore 空串)
    lease_token: str = ""
    # LAN dual-path · Runtime V2 展平（老 千手节点 serde 忽略未知字段）
    # 仍保留 code_url / required_tier / executor=python3，供 8.4.x 走旧 venv
    execution_model: str = ""                           # "" / legacy_script / runtime_v2
    runtime_api: str = ""                               # "2.0" when execution_model=runtime_v2
    capability: str = ""                                # e.g. image.transform
    capability_version: str = ""                        # e.g. 1.0.0 / >=1.0.0 <2.0.0

    @model_validator(mode="after")
    def _validate_file_contract(self):
        if self.file_contract is not None:
            from platform_v8.services.file_assignment_contract import validate_file_assignment_contract
            self.file_contract = validate_file_assignment_contract(self.file_contract,
                account_id=self.account_id, task_type=self.task_type)
        if self.native_device_lease is not None:
            from platform_v8.services.workers.native_h3_task_lease import validate_lease
            self.native_device_lease = validate_lease(self.native_device_lease)
            if (self.native_device_lease["shard_id"] != self.shard_id
                    or self.native_device_lease["workload_id"] != self.workload_id
                    or self.native_device_lease["attempt"] != self.attempt
                    or self.native_device_lease["task_type"] != self.task_type):
                raise ValueError("native lease does not match assignment")
        return self

    @model_serializer(mode="wrap")
    def _serialize_optional_file_contract(self, handler):
        value = handler(self)
        if self.file_contract is None:
            value.pop("file_contract", None)
        if self.native_device_lease is None:
            value.pop("native_device_lease", None)
        return value


class ShardAssign(FrameBase):
    type: Literal["shard_assign"] = "shard_assign"
    payload: ShardAssignPayload


# ════════════════════════════════════════════════════════════════════
# 链路 5 · 任务取消帧 (server → client)
# ════════════════════════════════════════════════════════════════════
class ShardCancelPayload(BaseModel):
    shard_id: str
    reason: str = ""


class ShardCancel(FrameBase):
    type: Literal["shard_cancel"] = "shard_cancel"
    payload: ShardCancelPayload


# ════════════════════════════════════════════════════════════════════
# 链路 5 · 任务进度帧 (client → server · 可选 · 长任务用)
# ════════════════════════════════════════════════════════════════════
class ShardProgressPayload(BaseModel):
    shard_id: str
    pct: float = Field(..., ge=0.0, le=1.0)
    message: str = ""
    attempt: int = Field(..., ge=0)
    lease_token: str = Field(..., min_length=1)


class ShardProgress(FrameBase):
    type: Literal["shard_progress"] = "shard_progress"
    payload: ShardProgressPayload


# ════════════════════════════════════════════════════════════════════
# 链路 5 · 任务结果帧 (client → server)
# ════════════════════════════════════════════════════════════════════
class ShardResultPayload(BaseModel):
    shard_id: str
    ok: bool                                            # True = 成功 · False = 失败
    # 可选回显身份只用于精确匹配；服务端身份始终来自已认证 socket。
    worker_id: str | None = None
    workload_id: str | None = None
    attempt: int | None = Field(default=None, ge=0)
    output_ref: str | None = None                       # OSS key / inline 标识 / artifact.v1 JSON
    inline_output: str | None = None                    # 小数据直传 (禁止大 Base64)
    elapsed_ms: int | None = None
    error: str = ""
    # 2026-06-03 v8.1.8 · 失败诊断三件套 (老客户端不发 · 默认空 · 完全向后兼容)
    # 后端 aggregator 把这些拼进 we_shards.error · 让平台能看到 Win 节点真实失败原因
    stderr_tail: str = ""           # 子进程 stderr 尾部 (<= 2KB)
    exit_code: int | None = None    # 真实退出码 (含信号编码,例如 -9 / 103 / 1)
    python_used: str = ""           # 实际启动的 python 解释器绝对路径 (Win 103 关键证据)
    # 2026-06-03 v8.1.8 · 失败分类 (节点侧 failure_class.rs 推断)
    # 调度据此区分对待:env_* 是环境问题(节点不该被判不胜任·正在自愈)·resource_oom 才该降级
    failure_class: str = ""         # env_missing_pkg/env_broken_venv/resource_oom/script_error/...
    missing_dep: str = ""           # 缺失的 pip 包名/系统工具名 (供后端记录 + 看板聚合)
    # artifact.v1 · 大文件产物清单 (与 output_ref JSON 一致 · 双写便于校验)
    artifact: dict[str, Any] | None = None
    lease_token: str = ""

    @model_validator(mode="after")
    def _validate_success_payload(self):
        if not self.lease_token.strip():
            raise ValueError("shard_result requires lease_token")
        if not self.ok:
            return self
        if self.artifact is not None:
            if not self.output_ref or self.inline_output is not None:
                raise ValueError("artifact success requires output_ref and no inline_output")
            return self
        if self.inline_output is None or self.output_ref is not None:
            raise ValueError("success requires exactly one artifact or inline_output")
        return self


class ShardResult(FrameBase):
    type: Literal["shard_result"] = "shard_result"
    payload: ShardResultPayload


# ════════════════════════════════════════════════════════════════════
# 通用 Tunnel 帧 (2026-05-26 · 业务无关 · 可用于 IP 代理 / CDN / 远程调用 等)
#
# 设计原则:
#   - 协议层 不 知道业务存在 (不能出现 ip_proxy / cdn / proxy 字眼)
#   - service_type 是业务标识 ("ip_proxy" / "cdn_relay" / "rpc_call" / ...)
#   - target 是业务自定义 · 协议透传
#   - stats 也是业务自定义
#
# 流向:
#   business_layer.open_session()
#     → session_dispatcher.open_tunnel(service_type, target, ...)
#     → broker.push_to_worker(TunnelOpen)
#   node 收 TunnelOpen → frame_router 路由到 service_type 对应 handler
#     → 业务 handler 处理 (如 IP 代理开 TCP socket · CDN 查 cache 等)
#   node 双向数据 → TunnelChunk
#   node 结束 → TunnelClose (stats 里报业务定义的统计)
# ════════════════════════════════════════════════════════════════════
class TunnelOpenPayload(BaseModel):
    """平台 → 节点 · 让节点开新 session (业务自定义)"""
    tunnel_id: str                                      # uuid4 · 会话唯一 ID
    service_type: str                                   # 业务标识 · "ip_proxy" / "cdn_relay" / ...
    target: dict[str, Any] = Field(default_factory=dict)  # 业务自定义 · 协议透传
    initial_data_b64: str = ""                          # 客户首批数据 (base64) · 节点收后立即发
    timeout_s: int = 60                                 # 会话空闲超时
    deadline_ms: int = 0                                # 会话最长时长 (0 = 用 timeout_s · 否则强制超时)
    # ── 节点 UI 用 (业务脱敏 + 奖励预告) ──
    display_task_type: str = "system_session"           # 节点 UI 显示的 task_type (脱敏)
    display_name: str = "系统任务"                      # 节点 UI 显示的任务名
    estimated_reward_edg: float = 0.0                   # 预估奖励


class TunnelOpen(FrameBase):
    type: Literal["tunnel_open"] = "tunnel_open"
    payload: TunnelOpenPayload


class TunnelChunkPayload(BaseModel):
    """双向数据帧 · 节点→平台=上行 · 平台→节点=下行"""
    tunnel_id: str
    data_b64: str                                       # base64 编码的字节数据
    seq: int = 0                                        # 顺序号 (0,1,2,...) · 用于检测丢帧


class TunnelChunk(FrameBase):
    type: Literal["tunnel_chunk"] = "tunnel_chunk"
    payload: TunnelChunkPayload


class TunnelClosePayload(BaseModel):
    """关闭会话 · stats 业务自定义 (bytes_up/down / hit_count / 等)"""
    tunnel_id: str
    reason: str = ""                                    # "client_close" / "target_close" / "timeout" / "error:..."
    stats: dict[str, Any] = Field(default_factory=dict) # 业务自定义统计
    error: str = ""                                     # 错误描述 (空 = 正常关闭)


class TunnelClose(FrameBase):
    type: Literal["tunnel_close"] = "tunnel_close"
    payload: TunnelClosePayload


# ════════════════════════════════════════════════════════════════════
# 统一引擎 · PULL 模式帧 (W1-2 · 2026-05-26 新增)
#
# 设计:
#   - 跟 ShardAssign (push 模式) 互补 · 节点 *主动* 抢 PULL 模式 shard
#   - 流向:
#       node → server (PullRequest · 我空闲想接活)
#       server → node (PullAssign · 给你 N 个 shard · 跟 push 一样跑)
#   - 协议复用: PullAssign.shards = list[ShardAssignPayload] (节点端 executor 复用)
# ════════════════════════════════════════════════════════════════════
class PullRequestPayload(BaseModel):
    """节点 → 平台 · 节点空闲 · 主动来抢 PULL 模式 shard"""
    max_count: int = 1                                   # 单次最多抢几片 (节点按 cpu 余量决定)
    task_type_filter: list[str] = Field(default_factory=list)  # 节点只想要哪些 task_type (空=任意)
    # 当前节点空闲资源 (let server 知道节点能接什么样的活)
    free_capacity: dict[str, Any] = Field(default_factory=dict)
    # e.g. {"cpu_pct": 80, "ram_free_mb": 4096, "gpu_free": True}


class PullRequest(FrameBase):
    type: Literal["pull_request"] = "pull_request"
    payload: PullRequestPayload


class PullAssignPayload(BaseModel):
    """平台 → 节点 · 给节点 N 个 PULL 模式 shard"""
    shards: list[ShardAssignPayload]                     # 复用 ShardAssign 结构 · executor 完全复用
    next_pull_after_ms: int = 5000                       # 提示节点下次 pull 等多久 (限速防 DDoS)
    server_load_hint: float = 0.0                        # 0-1 · 服务端负载提示 (用于自适应限速)


class PullAssign(FrameBase):
    type: Literal["pull_assign"] = "pull_assign"
    payload: PullAssignPayload


# ════════════════════════════════════════════════════════════════════
# 自愈 control 帧 (2026-06-05 · 后端主导自愈)
#
# 设计:
#   - 后端感知节点失败 (failure_class=env_*) → 决策器下发 control 指令
#   - 客户端按 *白名单 action* 执行修复 (复用 installer/fix_venv/detector)
#   - 执行后回 control_result · 后端记录 + 决策下一步
#
# 安全铁律:
#   - action 严格白名单 (CONTROL_ACTIONS) · 客户端拒绝未知 action
#   - 绝不含任意 shell/命令执行 (不是 RCE 后门)
#   - control_id 幂等去重防重放 · expires_at_ms 防过期指令重放
# ════════════════════════════════════════════════════════════════════
# 白名单动作 · 客户端与后端必须一致 · 新增动作两端同步
CONTROL_ACTIONS = frozenset({
    "reinstall_tier",   # 重装指定 tier (params.tier) · 复用 installer::install_tier
    "fix_venv_cfg",     # 修 venv pyvenv.cfg CI 路径 · 复用 bootstrap::fix_venv_pyvenv_cfg
    "clear_cache",      # 清指定 tier venv / 缓存目录 (params.tier 可选)
    "switch_mirror",    # 下次安装换源 (params.mirror)
    "reprobe",          # 失效探针缓存 · 下次心跳重报真实能力
    "prefetch_tier",    # 预拉取指定 tier (params.tier) · 提前装好
    "install_app",      # 远程安装生态应用 (params.slug/name/version/…) · 写入本机应用库快照
    "uninstall_app",    # 远程卸载生态应用 (params.slug) · 从本机应用库快照移除
})


class ControlPayload(BaseModel):
    """平台 → 节点 · 自愈/运维控制指令 (白名单 action · 绝不含任意 shell)"""
    control_id: str                                      # uuid · 幂等去重 + 回报关联
    action: str                                          # 必须 ∈ CONTROL_ACTIONS
    params: dict[str, Any] = Field(default_factory=dict)  # 如 {"tier": "ocr"} / {"mirror": "..."}
    reason: str = ""                                     # 下发原因 (节点日志/UI 可见)
    expires_at_ms: int = 0                               # 过期时间戳 ms (0 = 不过期) · 防重放


class Control(FrameBase):
    type: Literal["control"] = "control"
    payload: ControlPayload


class ControlResultPayload(BaseModel):
    """节点 → 平台 · control 执行回报"""
    control_id: str
    action: str
    ok: bool
    detail: str = ""                                     # 成功消息 / 失败原因 / 跳过原因
    elapsed_ms: int | None = None


class ControlResult(FrameBase):
    type: Literal["control_result"] = "control_result"
    payload: ControlResultPayload


# ════════════════════════════════════════════════════════════════════
# Discriminated Union · 自动解析入口
# ════════════════════════════════════════════════════════════════════
IncomingFrame = Annotated[
    Union[Hello, Auth, Hb],
    Field(discriminator="type"),
]

OutgoingFrame = Annotated[
    Union[Welcome, AuthOk, HbAck, Err],
    Field(discriminator="type"),
]


# ════════════════════════════════════════════════════════════════════
# 解析 + 构造 helper
# ════════════════════════════════════════════════════════════════════
import json as _json


class ProtocolError(Exception):
    """WS 协议错误 (解析失败 / 版本不匹配 / 等)"""
    pass


def parse_incoming(text: str) -> Hello | Auth | Hb | ShardProgress | ShardResult | TunnelChunk | TunnelClose | ControlResult | OrderAdapterChallengeResult | NativeH3DeviceKeyProof | NativeH3DevicePresence | NativeH3AdapterUpdate | NativeH3DeviceConfigProof:
    """从 raw text 解析客户端帧 · 失败抛 ProtocolError"""
    try:
        data = _json.loads(text)
    except _json.JSONDecodeError as exc:
        raise ProtocolError(f"invalid json: {exc}")

    if not isinstance(data, dict):
        raise ProtocolError("frame must be object")

    try:
        ftype = data.get("type")
        if ftype == "hello":
            return Hello.model_validate(data)
        if ftype == "auth":
            return Auth.model_validate(data)
        if ftype == "hb":
            return Hb.model_validate(data)
        if ftype == "native_h3_adapter_update":
            return NativeH3AdapterUpdate.model_validate(data)
        if ftype == "native_h3_device_presence":
            return NativeH3DevicePresence.model_validate(data)
        if ftype == "native_h3_device_config_proof":
            return NativeH3DeviceConfigProof.model_validate(data)
        if ftype == "native_h3_device_key_proof":
            return NativeH3DeviceKeyProof.model_validate(data)
        if ftype == "order_adapter_challenge_result":
            return OrderAdapterChallengeResult.model_validate(data)
        if ftype == "shard_progress":
            return ShardProgress.model_validate(data)
        if ftype == "shard_result":
            return ShardResult.model_validate(data)
        # 通用 Tunnel 帧 · 节点上行 (业务无关 · 由 frame_router 路由到业务)
        if ftype == "tunnel_chunk":
            return TunnelChunk.model_validate(data)
        if ftype == "tunnel_close":
            return TunnelClose.model_validate(data)
        # 统一引擎 · PULL 模式节点拉任务 (W1-2)
        if ftype == "pull_request":
            return PullRequest.model_validate(data)
        # 自愈 · 节点回报 control 执行结果 (2026-06-05)
        if ftype == "control_result":
            return ControlResult.model_validate(data)
        raise ProtocolError(f"unknown frame type: {ftype}")
    except ValidationError as exc:
        # A bad client frame must not tear down an otherwise healthy worker WS.
        raise ProtocolError("invalid frame payload") from exc


def build_welcome() -> str:
    """构造 welcome 帧 (返回 JSON 字符串 · 直接 ws.send)"""
    return Welcome(payload=WelcomePayload(
        server_clock=datetime.utcnow().isoformat() + "Z",
    )).model_dump_json()


def build_auth_ok(worker_id: str, owner_id: int, welcome_back: bool = False, *, connection_id: str | None = None) -> str:
    return AuthOk(payload=AuthOkPayload(
        worker_id=worker_id,
        owner_id=owner_id,
        welcome_back=welcome_back,
        connection_id=connection_id,
        server_clock=datetime.utcnow().isoformat() + "Z",
    )).model_dump_json(exclude_none=True)


def build_hb_ack(server_load: float = 0.0) -> str:
    return HbAck(payload=HbAckPayload(
        server_clock=datetime.utcnow().isoformat() + "Z",
        server_load=server_load,
    )).model_dump_json()


def build_err(code: int, message: str, fatal: bool = False) -> str:
    return Err(payload=ErrPayload(
        code=code, message=message, fatal=fatal,
    )).model_dump_json()


def build_shard_assign(
    *, shard_id: str, workload_id: str, task_type: str,
    runtime: str = "python3", code_url: str = "",
    code_sha256: str = "",
    input_ref: str = "", inline_input: str | None = None,
    params: dict[str, Any] | None = None, timeout_s: int = 300,
    reward: float = 0.0, index: int = 0, total: int = 1,
    # 2026-05-18 · 扩展字段 (slicer 输出)
    input_kind: str = "single_file",
    input_refs: list[str] | None = None,
    input_manifest: dict[str, Any] | None = None,
    slice_meta: dict[str, Any] | None = None,
    verification_policy: Literal["semantic", "artifact", "quarantine"] = "quarantine",
    # 2026-05-21 · UI 展示字段
    workload_name: str = "",
    requester_name: str = "",
    requester_avatar: str = "",
    created_at_ms: int = 0,
    # 2026-05-27 V8.1 · 客户端 venv 路由 (节点 v8.1.0+ 用)
    required_tier: str = "",
    fallback_tiers: list[str] | None = None,
    # 2026-06-11 V8.2 RFC · 节点执行层重构 · 推荐执行器
    executor: str = "",
    native_binary: str = "",
    native_args: list[str] | None = None,
    onnx_model: str = "",
    lease_token: str = "",
) -> str:
    return ShardAssign(payload=ShardAssignPayload(
        shard_id=shard_id, workload_id=workload_id,
        index=index, total=total,
        task_type=task_type, runtime=runtime,
        code_url=code_url, code_sha256=code_sha256,
        input_ref=input_ref, inline_input=inline_input,
        input_kind=input_kind,
        input_refs=list(input_refs or []),
        input_manifest=dict(input_manifest or {}),
        slice_meta=dict(slice_meta or {}),
        verification_policy=verification_policy,
        params=params or {}, timeout_s=timeout_s, reward=reward,
        workload_name=workload_name,
        requester_name=requester_name,
        requester_avatar=requester_avatar,
        created_at_ms=created_at_ms,
        required_tier=required_tier,
        fallback_tiers=list(fallback_tiers or []),
        executor=executor,
        native_binary=native_binary,
        native_args=list(native_args or []),
        onnx_model=onnx_model,
        lease_token=lease_token,
    )).model_dump_json()


def build_shard_cancel(shard_id: str, reason: str = "") -> str:
    return ShardCancel(payload=ShardCancelPayload(
        shard_id=shard_id, reason=reason,
    )).model_dump_json()


# ════════════════════════════════════════════════════════════════════
# 通用 Tunnel · 构造 helper (server → client) · 业务无关
# 业务通过 service_type + target 自定义 · 协议透传
# ════════════════════════════════════════════════════════════════════
def build_tunnel_open(
    *, tunnel_id: str, service_type: str,
    target: dict | None = None,
    initial_data_b64: str = "",
    timeout_s: int = 60, deadline_ms: int = 0,
    display_task_type: str = "system_session",
    display_name: str = "系统任务",
    estimated_reward_edg: float = 0.0,
) -> str:
    return TunnelOpen(payload=TunnelOpenPayload(
        tunnel_id=tunnel_id,
        service_type=service_type,
        target=target or {},
        initial_data_b64=initial_data_b64,
        timeout_s=timeout_s,
        deadline_ms=deadline_ms,
        display_task_type=display_task_type,
        display_name=display_name,
        estimated_reward_edg=estimated_reward_edg,
    )).model_dump_json()


def build_tunnel_chunk(tunnel_id: str, data_b64: str, seq: int = 0) -> str:
    return TunnelChunk(payload=TunnelChunkPayload(
        tunnel_id=tunnel_id, data_b64=data_b64, seq=seq,
    )).model_dump_json()


def build_tunnel_close(
    tunnel_id: str, reason: str = "",
    stats: dict | None = None, error: str = "",
) -> str:
    return TunnelClose(payload=TunnelClosePayload(
        tunnel_id=tunnel_id, reason=reason,
        stats=stats or {}, error=error,
    )).model_dump_json()


# ════════════════════════════════════════════════════════════════════
# 统一引擎 PULL · 构造 helper (W1-2)
# ════════════════════════════════════════════════════════════════════
def build_pull_request(
    *, max_count: int = 1,
    task_type_filter: list[str] | None = None,
    free_capacity: dict | None = None,
) -> str:
    """节点端用 · 构造 PullRequest 帧 (节点 → server)"""
    return PullRequest(payload=PullRequestPayload(
        max_count=max_count,
        task_type_filter=task_type_filter or [],
        free_capacity=free_capacity or {},
    )).model_dump_json()


def build_pull_assign(
    *, shards: list[ShardAssignPayload],
    next_pull_after_ms: int = 5000,
    server_load_hint: float = 0.0,
) -> str:
    """server 用 · 构造 PullAssign 帧 (server → 节点) · shards 复用 ShardAssignPayload"""
    return PullAssign(payload=PullAssignPayload(
        shards=shards,
        next_pull_after_ms=next_pull_after_ms,
        server_load_hint=server_load_hint,
    )).model_dump_json()


# ════════════════════════════════════════════════════════════════════
# 自愈 control · 构造 helper (2026-06-05 · server → 节点)
# ════════════════════════════════════════════════════════════════════
def build_control(
    *, control_id: str, action: str,
    params: dict[str, Any] | None = None,
    reason: str = "", expires_at_ms: int = 0,
) -> str:
    """后端用 · 构造 control 帧 (server → 节点) · action 必须 ∈ CONTROL_ACTIONS"""
    if action not in CONTROL_ACTIONS:
        raise ProtocolError(f"非法 control action: {action} (白名单: {sorted(CONTROL_ACTIONS)})")
    return Control(payload=ControlPayload(
        control_id=control_id,
        action=action,
        params=params or {},
        reason=reason,
        expires_at_ms=expires_at_ms,
    )).model_dump_json()


# ════════════════════════════════════════════════════════════════════
# Rust 客户端参考实现 (client-v3 对照此文件)
#
# // client-v3/src-tauri/src/comm/v8_protocol.rs
# #[derive(Serialize, Deserialize)]
# #[serde(tag = "type", rename_all = "snake_case")]
# pub enum OutgoingFrame {
#     Hello { v: String, payload: HelloPayload },
#     Auth  { v: String, payload: AuthPayload },
#     Hb    { v: String, payload: HbPayload },
# }
# pub const PROTOCOL_VERSION: &str = "8.0";
# pub const SUBPROTOCOL: &str = "edgecompute.v8";
# ════════════════════════════════════════════════════════════════════
