"""
Worker · 工作节点 (算力提供者)

替代: sv_nodes + sv_agent_node_map
"""
from __future__ import annotations
from dataclasses import dataclass, field, fields
from datetime import datetime
from typing import Any

from .enums import WorkerStatus


@dataclass
class WorkerCapabilities:
    """节点硬件 + 软件能力 (从 client.hello 帧上报)"""
    cpu_cores: int = 0
    memory_gb: float = 0.0
    gpu_count: int = 0
    gpu_model: str = ""
    vram_mb: int = 0
    free_vram_mb: int = 0
    media_profiles: list[dict[str, Any]] = field(default_factory=list)
    max_media_concurrent: int = 0
    media_available_seconds: int = 0
    accelerators: list[str] = field(default_factory=list)  # ['cuda', 'metal', 'rocm']
    runtimes: list[str] = field(default_factory=list)      # ['python3', 'node', 'ollama']
    installed_skills: list[str] = field(default_factory=list)
    installed_apps: list = field(default_factory=list)      # [{slug,name,version}] 商店已装应用
    os: str = ""                                            # 'macos' / 'linux' / 'windows'
    arch: str = ""                                          # 'x86_64' / 'aarch64'
    tier: str = "basic"                                     # 'basic' / 'pro' / 'enterprise'
    # 2026-05-18 · v8 节点 v8_ws.collect_capabilities 扩展字段
    # 上报真实硬件 (cpu_brand, total_memory_mb 等) · 让企业端节点详情完整
    cpu_brand: str = ""                                     # 'Apple M4' / 'Intel i9-13900' / ...
    cpu_threads: int = 0                                    # 逻辑核心 (>= cpu_cores)
    total_memory_mb: int = 0                                # 真实内存 (MB · 比 memory_gb 精确)
    total_disk_mb: int = 0                                  # 本机磁盘总容量 (MB)
    free_disk_mb: int = 0                                   # 本机磁盘可用空间 (MB)
    hostname: str = ""                                      # 'Mac-mini.local'
    device_name: str = ""                                   # 跟 hostname 通常相同
    os_name: str = ""                                       # 'Darwin' / 'Linux' / 'Windows'
    os_version: str = ""                                    # '26.4.1' / '22.04' / ...
    kernel_version: str = ""                                # '25.4.0' / ...
    software: list[str] = field(default_factory=list)       # ['ffmpeg','pillow','blender','ollama','pymupdf',...] · planner 匹配用
    runtime_tiers: list[str] = field(default_factory=list)  # ['lite','ocr','ffmpeg',...] · 已装 venv tier · required_tier 硬过滤用
    provided_capabilities: list = field(default_factory=list)  # [{name,version,health,provider}] · V2 硬匹配
    # task-adapters.v1: exact locally self-tested task/input/output contracts.
    # The protocol token is required before the planner treats this as a hard gate.
    verified_task_adapters: list = field(default_factory=list)
    # 2026-05-18 · benchmark 探针 (节点端 benchmark.rs 启动跑 ~3s)
    bench_cpu_mb_per_sec: float = 0.0                       # SHA256 50MB 吞吐
    bench_memory_gb_per_sec: float = 0.0                    # 内存 256MB 顺序写
    bench_disk_mb_per_sec: float = 0.0                      # 磁盘 100MB 写
    bench_capability_score: float = 0.0                     # 综合 0-100
    # 2026-05-19 · 垂类能力广告 (专利 09 配套 · capability-aware routing)
    specialty: list[str] = field(default_factory=list)      # ['photo-edit','ocr','legal'] · 节点声明的垂类专项
    equipped_models: list[str] = field(default_factory=list) # ['sam-vit-b','lama','gfpgan-v1.4'] · 已装模型
    model_health: dict = field(default_factory=dict)        # {'sam-vit-b':'loaded','lama':'ready'} · 模型健康
    ram_gb: float = 0.0                                     # 节点上报的可用 RAM (GB) · 调度门槛用
    # 算力调节 (客户端「算力调节」滑杆 · 0=暂停 / 100=全速)
    throttle_pct: int = 100
    contribute_mode: str = "active"                         # active / paused / throttled (capabilities.mode)
    review_only: bool = False                               # server-owned independent audit identity
    # 2026-06-11 · V8.2 RFC 节点执行层重构 · 节点支持的非 Python 执行器列表
    # 新节点(8.2.x+)hello 上报 ['native', 'onnx', 'http'] 中的子集 · 老节点上报为空
    # planner 用此做软偏好排序: 支持 task.executor 的节点排前 · 不支持的也保留(走 python3 兜底)
    # native_binaries: 节点真正可调的 native binary 列表(执行 NATIVE 任务必须含 task.native_binary)
    # onnx_models: 节点已装的 ONNX 模型列表(执行 ONNX 任务必须含 task.onnx_model)
    supported_executors: list[str] = field(default_factory=list)  # ['native','onnx','http']
    native_binaries: list[str] = field(default_factory=list)      # ['ffmpeg','vips','pdftotext','tesseract']
    onnx_models: list[str] = field(default_factory=list)          # ['rapid_ocr_v1','clip_vit_b32_v1']
    # 本地 LLM（llama.cpp · 客户端探测上报；过渡期双写 ollama_*）
    llm_backend: str = ""                                     # 'llama_cpp' / '' 
    llm_models: list[str] = field(default_factory=list)       # ['qwen2.5-7b-instruct', ...]
    ollama_models: list[str] = field(default_factory=list)    # 过渡双写 = llm_models
    ai_runtime_ready: bool = False                            # 本机 llama-server 是否在线
    # WebSocket 协商元数据保存在现有 capabilities JSON，不新增 worker 表列。
    client_build: str = ""
    protocol_capabilities: list[str] = field(default_factory=list)
    protocol_legacy: bool = True
    protocol_profile: str = "legacy_inline"
    protocol_profile_observations: list[str] = field(default_factory=list)

    @classmethod
    def from_stored(cls, caps: dict | None) -> "WorkerCapabilities":
        """JSON / Redis 还原：只取当前 dataclass 已声明字段，忽略客户端多报的键。"""
        raw = caps or {}
        allowed = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in raw.items() if k in allowed})


@dataclass
class Worker:
    id: str                                     # uuid (client 持久化生成)
    owner_id: int                               # 关联 Account.id
    name: str                                   # 节点显示名
    status: WorkerStatus = WorkerStatus.OFFLINE
    capabilities: WorkerCapabilities = field(default_factory=WorkerCapabilities)
    load: float = 0.0                           # 0.0-1.0 当前负载
    active_shards: int = 0                      # 在跑的 shard 数
    reputation: float = 0.5                     # 信誉分 0.0-1.0
    capability_score: float = 0.0               # 综合能力分 (调度打分用)
    last_seen: datetime | None = None           # 最后 hb 时间
    registered_at: datetime = field(default_factory=datetime.utcnow)
    client_version: str = ""
    # 2026-05-25 NCE P2/P3 · 节点能力评估字段 (默认值 = backfill 兜底 · 老代码零回归)
    hw_tier: str = "B"                          # 硬件等级 S/A/B/C/D
    hw_score: float = 50.0                      # 硬件评分 0-100
    rep_main: int = 60                          # 主信誉分 0-100 (4 子分调和平均)
    rep_stability: int = 60                     # 信誉子分: 稳定性
    rep_correctness: int = 60                   # 信誉子分: 正确性
    rep_speed: int = 60                         # 信誉子分: 速度
    rep_resource: int = 60                      # 信誉子分: 资源诚信
    onboarding_status: str = "active"           # active / probation / banned / small_pool
    disabled_until: datetime | None = None       # 临时禁止上线截止时间
    disabled_at: datetime | None = None
    disabled_by: int | None = None
    disabled_reason: str = ""

    @property
    def is_online(self) -> bool:
        return self.status in (WorkerStatus.ONLINE, WorkerStatus.BUSY)

    @property
    def is_idle(self) -> bool:
        return self.status == WorkerStatus.ONLINE and self.load < 0.8

    @property
    def is_temporarily_disabled(self) -> bool:
        if self.disabled_until is None:
            return False
        now = (
            datetime.now(self.disabled_until.tzinfo)
            if self.disabled_until.tzinfo is not None
            else datetime.utcnow()
        )
        return self.disabled_until > now
