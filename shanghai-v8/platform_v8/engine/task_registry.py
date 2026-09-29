"""
Task type 中央注册表 · 整套调度链路的"宪法"

设计要点 (考虑全链路):
  1. 每个 task_type 注册一个 TaskTypeSpec
     · 接受哪些 input_kind (inline / single_file / multi_file / archive / ...)
     · 用哪个 slicer (single / lines_chunked / files_chunked / ...)
     · 用哪个 aggregator (inline_concat / zip_files / ffmpeg_concat / ...)
     · 需要哪些节点能力 (runtimes / software / memory / gpu)
  2. submit_workload → 查表验证 input_kind 合法
  3. planner.slice → 调对应 slicer
  4. planner.schedule → 按 requirements 过滤 worker
  5. aggregator → 调对应 aggregator
  6. 没注册的 task_type → 回退 default (lines_chunked + lines_merge)

加新业务: 改这一个文件即可 · 不动 planner / aggregator / executor
"""
from __future__ import annotations
import logging
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any, Literal, Tuple

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════
# TaskMode · task 调度模式 (W0-4 · 2026-05-26 新增)
#
# 区分 3 种调度法:
#   ONESHOT · 现有 53 task · workload → N shards → planner+broker push → 单次结果
#   SESSION · IP 代理池 / CDN / RPC · 长连 TunnelOpen · 双向 pipe
#   PULL    · 爬虫子系统 · 节点 HTTP poll · lease+complete · 不走 ws push
#
# 主要用途:
#   - planner 看 mode 决定调度路径 (ONESHOT 走 broker · SESSION 走 session_dispatcher · PULL 不走 planner)
#   - admin UI 按 mode 分组展示
# ═══════════════════════════════════════════════════════════════
class TaskMode(str, Enum):
    ONESHOT = "oneshot"   # 现有 53 task · workload + shards
    SESSION = "session"   # 长连隧道 (IP 代理 / CDN)
    PULL = "pull"         # HTTP poll (爬虫子系统)


# ═══════════════════════════════════════════════════════════════
# 协议类型
# ═══════════════════════════════════════════════════════════════
InputKind = Literal[
    "inline",         # spec.inline_input 直接喂 stdin · 小文本 < 1MB
    "single_file",    # spec.input_ref OSS URL · fetch 后喂 stdin
    "multi_file",     # spec.input_refs 多个 URL · fetch 到临时目录传文件夹
    "archive",        # spec.input_ref zip/tar URL · fetch + 解压 · 传文件夹
    "stream",         # spec.input_ref m3u8/直播流 · 流式拉取
    "params_only",    # 无文件 · 只 spec.params (适合 pi_compute / monte_carlo)
]

SlicerName = Literal[
    "single",                  # 永远 1 片 · 整个输入给一个 worker
    "lines_chunked",           # 按行均分 N 份
    "files_chunked",           # 按文件均分 N 份 (multi_file)
    "archive_files_chunked",   # 解压后按文件均分 (archive)
    "pages_chunked",           # 按 PDF 页均分
    "duration_chunked",        # 按视频/音频时长均分
    "samples_chunked",         # 按 sample 数均分 (monte_carlo)
    "frames_chunked",          # 按帧均分 (blender_render)
    "prompts_chunked",         # 按 prompts 数均分 (llm batch)
    "video_hybrid",            # 视频压缩 · 体积装箱 + 超大时长切
]

AggregatorName = Literal[
    "artifact_reference", # Metadata only: exact server-issued immutable reference, no byte materialization.
    "inline_concat",      # 一片直接返 · 多片拼字符串 (现在的默认)
    "lines_merge",        # 合并 N 个 inline JSON 的 result_lines
    "numeric_sum",        # 数值加总 + 算 mean/var (monte_carlo)
    "zip_files",          # 打包 N 个 OSS 文件夹 → 1 个 zip URL
    "ffmpeg_concat",      # ffmpeg concat N 个视频段 → 1 个视频 URL
    "ordered_concat",     # 按 index 排序拼接 (PDF 分页)
    "frames_to_video",    # ffmpeg N 段帧 PNG → mp4
    "manifest_only",      # 合并 N 个 JSON metadata 表
    "video_outputs",      # 同源时长段 concat + 多源 zip
]


# ═══════════════════════════════════════════════════════════════
# Executor · 节点执行器优先选择 (2026-06-11 RFC · 节点执行层重构)
#
# 引擎只声明"推荐路径" · 节点按自身能力 + supported_executors 兜底回退:
#   NATIVE  · 节点本机内置/已装的 native binary(如 ffmpeg / libvips / poppler /
#             tesseract / curl) · tokio::process 直调 · 不进 Python 解释器
#   ONNX    · 节点用 ort crate 直接跑 ONNX 模型(如 RapidOCR / bge embedding /
#             CLIP image_caption) · 离线 · 不依赖 Python 生态
#   HTTP    · 节点用 reqwest 调平台公开 API(如 /api/v1/chat/completions ·
#             /api/v1/embeddings · 白名单 crawl) · 节点只是中继
#   PYTHON3 · 老路径 · code_url 拉脚本 + venv 跑 (现状默认 · 兜底)
#
# 兼容保证:
#   - 老节点(8.1.x)拿到 spec.executor 字段会 ignore · 维持 python3 路径
#   - 新节点(8.2.x+)拿到 preferred_executor 后 · 没装/不支持则 fallback python3
#   - 所有 task 必须保留 platform_v8/scripts/tasks/*.py 作为 PYTHON3 兜底
# ═══════════════════════════════════════════════════════════════
class Executor(str, Enum):
    NATIVE  = "native"     # ffmpeg / libvips / poppler / tesseract / curl 直调
    ONNX    = "onnx"       # ort crate 直推 ONNX 模型
    HTTP    = "http"       # 节点 reqwest 调平台 API (crawl/llm)
    PYTHON3 = "python3"    # 老路径 · 兜底


# ═══════════════════════════════════════════════════════════════
# 算力归属 (compute origin) · 2026-09-18 · 加法字段 · 向后兼容
#
# 记录「这次任务真正在哪出算力」· 供调度器 / UI / 计费 一眼区分:
#   "node"           节点自己出算力 (本地模型 / 本地二进制 / 本地 CPU·GPU 重算)
#   "platform_relay" 节点不出算力 · 只是把请求转给平台云端服务 (平台代调)
#
# 只加标记 · 不参与 planner 过滤 · 不参与路由 · 不参与计费口径。
# 老客户端 (8.x) 拿到新字段会 ignore · 完全向后兼容。
# ═══════════════════════════════════════════════════════════════
COMPUTE_ORIGIN_NODE = "node"                      # 节点出算力 (默认 · 与历史行为一致)
COMPUTE_ORIGIN_PLATFORM_RELAY = "platform_relay"  # 平台代调 · 节点零算力
COMPUTE_ORIGIN_VALUES = (COMPUTE_ORIGIN_NODE, COMPUTE_ORIGIN_PLATFORM_RELAY)


# ═══════════════════════════════════════════════════════════════
# TaskTypeSpec · 每个 task_type 一条记录
# ═══════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class TaskTypeSpec:
    task_type: str
    category: str                                            # "text"/"image"/"video"/"doc"/"compute"/"ai"
    description: str

    # ── 协议 ──
    accepted_input_kinds: Tuple[InputKind, ...]
    default_input_kind: InputKind

    # ── 引擎策略 ──
    slicer: SlicerName
    aggregator: AggregatorName

    # ── 节点要求 (planner 过滤用) ──
    runtimes: Tuple[str, ...] = ("python3",)
    required_software: Tuple[str, ...] = ()                  # ["pillow", "ffmpeg", "blender", "local_llm"]
    min_memory_mb: int = 0
    requires_gpu: bool = False

    # ── 切片约束 ──
    default_max_shards: int = 1                              # 用户没指定时切几片
    max_shards_limit: int = 1                                # 这种 task 最多能切几片

    # ── 调度模式 (W0-4 · 2026-05-26 · default ONESHOT 向后兼容现有 53 task) ──
    # ONESHOT · workload + shards · planner + broker push (现有)
    # SESSION · 长连隧道 · session_dispatcher (IP 代理池 / CDN)
    # PULL    · HTTP poll · 不走 planner (爬虫子系统)
    mode: TaskMode = TaskMode.ONESHOT

    # ── 运行时 tier 路由 (V8.1 · 2026-05-27 · 客户端按此选 venv 跑) ──
    # required_tier · 节点必须装好这个 venv 才能跑此 task
    #   "" (默认) → 自动从 required_software 推断 · 见 infer_tier_for_software()
    #   "ocr" → 强制 venvs/ocr/bin/python (即使 required_software 也指别处)
    # fallback_tiers · 主 tier 没装时降级试这些 (按顺序)
    #   ("lite",) → ocr 没装时试 lite venv (大概率失败 · 给个能跑的兜底)
    # 老客户端 (8.0.x) 拿到这两字段会 ignore · 完全向后兼容
    required_tier: str = ""
    fallback_tiers: Tuple[str, ...] = ()

    # ── 节点执行器优先路径 (V8.2 · 2026-06-11 · RFC 节点执行层重构) ──
    # executor · 推荐执行路径 · 节点没装/不支持时 fallback python3 (老脚本)
    #   PYTHON3 (默认) → code_url 拉脚本 + venv 跑 (现状)
    #   NATIVE → tokio::process 直调 native binary (ffmpeg / libvips / poppler / ...)
    #   ONNX → ort crate 直推 ONNX 模型 (RapidOCR / bge / CLIP)
    #   HTTP → 节点 reqwest 调平台 API (crawl/llm)
    # native_binary · executor=NATIVE 时指明该走哪个 binary (按 logical name · 节点
    #   到 tier_root(tier)/bin/<native_binary> 或内置 resources/bin/<native_binary> 找)
    #   例: "ffmpeg" → ~/.qianshou/runtime/tiers/ffmpeg/bin/ffmpeg
    #       "tesseract" → src-tauri/resources/ocr/tesseract/tesseract (内置)
    # onnx_model · executor=ONNX 时指明走哪个 ONNX 模型 (按 logical name · 节点拉
    #   manifest 下发的 OnnxModelSpec 找)
    #   例: "rapid_ocr_v1" → ~/.qianshou/runtime/onnx/rapid_ocr_v1/{det,rec,cls}.onnx
    # 老节点(8.1.x)拿到这三字段会 ignore · 完全向后兼容 · 维持 PYTHON3 路径
    executor: Executor = Executor.PYTHON3
    native_binary: str = ""
    onnx_model: str = ""

    # settlement / batch (result verifier + slicers)
    settlement_policy: str = "artifact"  # LAN QA: accept非法; artifact可验收下载
    batch_semantics: str = "none"

    # ── 压缩包声明（runtime_contract 聚合）──
    archive_formats: Tuple[str, ...] = ()

    # 每片最多文件数；0=不限制（可合并）
    max_files_per_shard: int = 0

    # Reviewed local adapters have an exact input and output contract. Legacy
    # nodes and the old automatic batch-input expansion must not widen it.
    exact_input_kinds: bool = False
    requires_verified_adapter: bool = False
    adapter_capability_id: str = ""
    adapter_output_kind: str = ""
    approved_adapter_digest: str = ""
    # Code-reviewed policy identifiers are pinned in the independent contract
    # review digest. A seller cannot supply or switch these at submission.
    adapter_input_contract: str = ""
    adapter_result_strategy: str = ""
    # Media bytes must be checked by a separate trusted verifier; Shanghai's
    # existing artifact verifier streams bytes and is not an acceptable path.
    external_artifact_verifier_required: bool = False
    # Platform-owned provider binding. This never grants a seller publication
    # access to the task and requires a separate trusted-worker admission gate.
    official_provider_id: str = ""
    # Reviewed, UI-safe parameters for a generic task form. A missing schema
    # never licenses the client to guess fields for a params-only task.
    parameter_schema: dict[str, Any] = field(default_factory=dict)
    inline_input_form: dict[str, Any] = field(default_factory=dict)
    # For buyer-confirmed results this is a shape check, never a semantic
    # success claim. The immutable reviewed definition pins its exact bytes.
    adapter_output_schema: dict[str, Any] = field(default_factory=dict)
    # Opt-in bounded QuickJS file ABI, included in the reviewed digest only when present.
    adapter_file_schema: dict[str, Any] = field(default_factory=dict)


    # ── 算力归属 (2026-09-18 · 加法字段 · 见文件顶部 COMPUTE_ORIGIN_* 常量) ──
    # compute_origin · 这个 task_type 真正在哪出算力
    #   "node"           → 节点自己算 (默认值 · 等价于历史行为 · 老 spec 无需改)
    #   "platform_relay" → 节点零算力 · 把请求转给平台云端服务 (平台代调)
    # 说明: 这是声明字段 · planner 不读它 · 不改变路由与计费。
    compute_origin: str = COMPUTE_ORIGIN_NODE
    # compute_origin_note · 给下游/UI 的人类可读说明 · 不影响任何逻辑
    compute_origin_note: str = ""
    requires_official_media_profile: bool = False

# ═══════════════════════════════════════════════════════════════
# 默认 · 没注册的 task_type 用这个 (保持兼容)
# ═══════════════════════════════════════════════════════════════
# 广场未显式注册的脚本也允许 multi_file / archive 上传；切片由 planner
# 在 multi_file→files_chunked、archive→archive_files_chunked 时覆盖。
DEFAULT_SPEC = TaskTypeSpec(
    task_type="__default__",
    category="text",
    description="默认 · 支持单文件/多文件/压缩包 · 未注册任务兜底",
    accepted_input_kinds=("inline", "single_file", "multi_file", "archive"),
    default_input_kind="single_file",
    slicer="single",
    aggregator="inline_concat",
    max_shards_limit=10,
)


def _ensure_batch_inputs(spec: TaskTypeSpec) -> TaskTypeSpec:
    """所有任务统一接受 multi_file / archive（保留原有 kinds 与顺序）。"""
    if spec.exact_input_kinds or spec.requires_official_media_profile:
        return spec
    kinds = tuple(
        dict.fromkeys(
            (*spec.accepted_input_kinds, "multi_file", "archive"),
        )
    )
    if kinds == spec.accepted_input_kinds:
        return spec
    return replace(spec, accepted_input_kinds=kinds)


# ═══════════════════════════════════════════════════════════════
# 注册表 (现有 52 脚本逐步覆盖 · 先放代表性的)
# ═══════════════════════════════════════════════════════════════
_TASKS: list[TaskTypeSpec] = [
    # Official provider uses the same workload/lease/artifact/CNY path as other
    # tasks. Quote and submit remain closed until a trusted Guangzhou worker,
    # configured server price and independent static-image verifier are live.
    TaskTypeSpec(
        task_type="image.generate", category="image",
        description="官方出图：输入文字，生成一张经过独立验收的 PNG 图片",
        accepted_input_kinds=("inline",), default_input_kind="inline",
        slicer="single", aggregator="inline_concat", runtimes=("python3",),
        required_software=(), max_shards_limit=1, default_max_shards=1,
        executor=Executor.HTTP, settlement_policy="semantic",
        exact_input_kinds=True, adapter_capability_id="image.generate",
        adapter_output_kind="artifact_ref",
        adapter_input_contract="official-image-prompt.v1",
        adapter_result_strategy="external-media.v1",
        external_artifact_verifier_required=True,
        official_provider_id="qianshou:official-image-generation-v1",
        parameter_schema={
            "type": "object", "required": ["output_format"],
            "additionalProperties": False,
            "properties": {"output_format": {"type": "string", "enum": ["png"],
                                             "title": "输出格式"}},
        },
        inline_input_form={"type": "string", "minLength": 1,
                           "maxLength": 16384,
                           "contentMediaType": "application/json",
                           "title": "出图文字与尺寸",
                           "contentSchema": {
                               "type": "object",
                               "required": ["prompt", "model", "size"],
                               "additionalProperties": False,
                               "properties": {
                                   "prompt": {"type": "string", "minLength": 1,
                                              "maxLength": 8000, "title": "想画什么？"},
                                   "model": {"const": "grok-4.6"},
                                   "size": {"const": "1280x720"},
                               },
                           }},
    ),
    # Local adapter candidate. This is deliberately absent from the public
    # developer allowlist and is refused at intake until an external, trusted
    # media verifier exists. Registering its shape cannot publish it.
    TaskTypeSpec(
        task_type="bar_chart_svg_v1", category="video",
        description="受限柱状图 SVG 动效，生成单个 GIF 或 H.264 MP4",
        accepted_input_kinds=("inline",), default_input_kind="inline",
        slicer="single", aggregator="inline_concat",
        runtimes=("python3",), required_software=(),
        default_max_shards=1, max_shards_limit=1,
        settlement_policy="quarantine",
        exact_input_kinds=True,
        requires_verified_adapter=True,
        adapter_capability_id="video.render",
        adapter_output_kind="artifact_ref",
        adapter_input_contract="bar-chart-svg-order.v1",
        adapter_result_strategy="external-media.v1",
        external_artifact_verifier_required=True,
        parameter_schema={
            "type": "object", "required": ["output_format"],
            "additionalProperties": False,
            "properties": {"output_format": {"type": "string", "enum": ["gif", "mp4"],
                                             "title": "输出格式"}},
        },
        inline_input_form={"type": "string", "minLength": 1, "maxLength": 16384,
                           "contentMediaType": "application/json", "title": "柱状图配方 JSON"},
    ),
    # A second, non-media example of the same reviewed adapter path. Its
    # publication still requires an independently signed sample-execution
    # receipt; registering a deterministic result checker does not approve a
    # seller package or make it dispatchable.
    TaskTypeSpec(
        task_type="text_reverse_v1", category="text",
        description="将内联文字反转并输出 JSON",
        accepted_input_kinds=("inline",), default_input_kind="inline",
        slicer="single", aggregator="inline_concat",
        runtimes=("python3",), required_software=(),
        default_max_shards=1, max_shards_limit=1,
        settlement_policy="semantic", exact_input_kinds=True,
        requires_verified_adapter=True,
        adapter_capability_id="qianshou.text-reverse.v1",
        adapter_output_kind="inline_json",
        adapter_input_contract="inline-text-reverse.v1",
        adapter_result_strategy="inline-text-reverse.v1",
        inline_input_form={"type": "string", "minLength": 1, "maxLength": 16384,
                           "contentMediaType": "application/json", "title": "待反转文字 JSON"},
    ),
    # ── H3 视频生成（节点调本机四档适配器）────────────────────────
    # 与 llm_chat 同类：脚本用 urllib 调节点本机的 H3 适配器（默认 127.0.0.1:8790），
    # 不做本地重计算。required_software 必须为空，否则会把所有节点过滤掉 → 永远 WAITING。
    TaskTypeSpec(
        task_type="h3_runtime", category="ai",
        description="MiniMax H3 四档文/图生视频（节点本地适配器出片，5s/10s）",
        accepted_input_kinds=("inline", "params_only"),
        default_input_kind="inline",
        slicer="single", aggregator="inline_concat",
        runtimes=("python3",),
        required_software=(),
        required_tier="lite",
        min_memory_mb=8192,
        requires_gpu=True,
        default_max_shards=1, max_shards_limit=1,
        executor=Executor.HTTP,
    ),
    TaskTypeSpec(
        task_type="film_node_capabilities_v1", category="compute",
        description="H3 node read-only capability inventory; no model load or generation",
        accepted_input_kinds=("inline",), default_input_kind="inline",
        slicer="single", aggregator="inline_concat", runtimes=("python3",),
        max_shards_limit=1, executor=Executor.PYTHON3, settlement_policy="artifact",
    ),
    TaskTypeSpec(
        task_type="qianshou_film_media", category="video",
        description="受控 Film normal4 媒体验收（仅服务端授权）",
        accepted_input_kinds=("inline",), default_input_kind="inline",
        slicer="single", aggregator="inline_concat", runtimes=("python3",),
        max_shards_limit=1, executor=Executor.PYTHON3, settlement_policy="semantic",
    ),
    # ── A. 文本类 (lines_chunked) ──────────────────────────────
    TaskTypeSpec(
        task_type="dedup_lines", category="text",
        description="去除重复行 · 输出唯一行 + 重复统计",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="single",  # MVP: 先不切 · 整文件给 1 个节点 (跨片去重需要 round 2)
        aggregator="inline_concat",
        max_shards_limit=1,
    ),
    TaskTypeSpec(
        task_type="word_count", category="text",
        description="词频统计",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="lines_chunked",
        aggregator="lines_merge",
        max_shards_limit=10,
        parameter_schema={
            "type": "object", "required": [], "additionalProperties": False,
            "properties": {"top_n": {"type": "integer", "minimum": 1,
                                     "maximum": 1000, "default": 100,
                                     "title": "显示词数"}},
        },
    ),
    TaskTypeSpec(
        task_type="json_filter", category="text",
        description="JSON 行过滤 (jq-like)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="lines_chunked",
        aggregator="lines_merge",
        max_shards_limit=10,
    ),

    # ── B. 编码/哈希 (single 不切 · 单文件够快) ─────────────────
    TaskTypeSpec(
        task_type="base64_encode", category="encoding",
        description="Base64 编码",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="inline",
        slicer="single", aggregator="inline_concat",
    ),
    TaskTypeSpec(
        task_type="hash_batch", category="encoding",
        description="批量哈希 (SHA256 / MD5 / SHA1)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="lines_chunked", aggregator="lines_merge",
        max_shards_limit=10,
    ),
    # 2026-06-01 · 补注册 · 之前走 __default__(single 不切片)→ 大输入不并行
    TaskTypeSpec(
        task_type="md5_batch", category="encoding",
        description="批量 MD5 校验码",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="lines_chunked", aggregator="lines_merge",
        max_shards_limit=10,
    ),
    TaskTypeSpec(
        task_type="crc32_batch", category="encoding",
        description="批量 CRC32 快速校验码",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="lines_chunked", aggregator="lines_merge",
        max_shards_limit=10,
    ),
    TaskTypeSpec(
        task_type="line_count", category="text",
        description="行数/字数统计(总行/空行/非空)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="lines_chunked", aggregator="lines_merge",
        max_shards_limit=10,
    ),
    # 2026-05-26 · 补 5 个基础文本/编码 task · 之前漏注册走 __default__ 兜底
    TaskTypeSpec(
        task_type="json_validate", category="text",
        description="JSON 语法批量校验 + 统计",
        accepted_input_kinds=("inline", "single_file", "multi_file"),
        default_input_kind="single_file",
        slicer="lines_chunked", aggregator="lines_merge",
        max_shards_limit=10,
    ),
    TaskTypeSpec(
        task_type="text_diff", category="text",
        description="文本差异比对 (unified diff)",
        accepted_input_kinds=("multi_file", "archive"),
        default_input_kind="multi_file",
        batch_semantics="exact_set",
        slicer="single", aggregator="inline_concat",
        max_files_per_shard=2,
    ),
    TaskTypeSpec(
        task_type="text_extract", category="text",
        description="提取邮箱/手机/URL/IP/身份证 (基础 PII)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="lines_chunked", aggregator="lines_merge",
        max_shards_limit=10,
    ),
    TaskTypeSpec(
        task_type="text_sort", category="text",
        description="文本行排序 (字典/数字/反向/去重)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="single", aggregator="inline_concat",
    ),
    TaskTypeSpec(
        task_type="url_parse", category="text",
        description="URL 批量解析 (scheme/host/path/query)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="lines_chunked", aggregator="lines_merge",
        max_shards_limit=10,
    ),

    # 2026-06-06 · 补注册纯 stdlib 文本/编码工具脚本 (此前走 __default__ 兜底)
    # 全用最保守 single + inline_concat (整输入给一个节点·脚本自处理·不依赖切片假设·零改废风险)
    # 仅补对称已注册同类、input 约定一致、无外部依赖的;业务脚本(GEO/广告/爬虫)不在此
    TaskTypeSpec(
        task_type="base64_decode", category="encoding",
        description="Base64 解码 (对称 base64_encode)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="inline",
        slicer="single", aggregator="inline_concat",
    ),
    TaskTypeSpec(
        task_type="text_replace", category="text",
        description="文本批量替换 (字面/正则·EC_PARAMS 配)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="single", aggregator="inline_concat",
    ),
    TaskTypeSpec(
        task_type="text_split", category="text",
        description="文本切分 (按行/分隔符)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="single", aggregator="inline_concat",
    ),
    TaskTypeSpec(
        task_type="regex_extract", category="text",
        description="正则批量提取 (EC_PARAMS.pattern)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="single", aggregator="inline_concat",
    ),
    TaskTypeSpec(
        task_type="text_mask", category="text",
        description="文本脱敏 (邮箱/手机/卡号等打码)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="single", aggregator="inline_concat",
    ),
    TaskTypeSpec(
        task_type="csv_to_json", category="text",
        description="CSV/TSV → JSON 行转换",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="single", aggregator="inline_concat",
        settlement_policy="artifact",
    ),

    # ── C. 图像 单图 (single 不切) ─────────────────────────────
    # Python scripts currently own the stable stdin/result contracts used by
    # manifest_only/zip_files. Native libvips output is artifact-based and must
    # not be selected until artifact aggregation is wired end-to-end.
    TaskTypeSpec(
        task_type="image_info", category="image",
        description="图片元信息提取",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="multi_file",
        slicer="files_chunked", aggregator="manifest_only",
        max_shards_limit=20,
        required_software=("pillow",),
        executor=Executor.PYTHON3,
    ),

    # ── D. 图像 批量 (files_chunked / archive_files_chunked) ──
    TaskTypeSpec(
        task_type="image_resize", category="image",
        description="批量图片缩放",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="multi_file",
        slicer="files_chunked", aggregator="zip_files",
        max_shards_limit=20,
        required_software=("pillow",),
        executor=Executor.PYTHON3,
    ),
    TaskTypeSpec(
        task_type="image_compress", category="image",
        description="批量图片压缩",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="multi_file",
        slicer="files_chunked", aggregator="zip_files",
        max_shards_limit=20,
        required_software=("pillow",),
        executor=Executor.PYTHON3,
    ),
    TaskTypeSpec(
        task_type="image_convert", category="image",
        description="批量图片格式转换",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="multi_file",
        slicer="files_chunked", aggregator="zip_files",
        max_shards_limit=20,
        required_software=("pillow",),
        executor=Executor.PYTHON3,
    ),
    TaskTypeSpec(
        task_type="image_thumbnail", category="image",
        description="批量生成缩略图",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="multi_file",
        slicer="files_chunked", aggregator="zip_files",
        max_shards_limit=20,
        required_software=("pillow",),
        executor=Executor.PYTHON3,
    ),

    # ── E. 音视频 ────────────────────────────────────────────
    # video_compress: 单文件时长切 / 多文件体积装箱+超大再切 · video_outputs 聚合
    # video_info / thumbnail: 多文件按体积 files_chunked（与图片批处理对齐）
    TaskTypeSpec(
        task_type="video_info", category="video",
        description="视频元信息 (支持批量 / ZIP)",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="multi_file",
        slicer="files_chunked", aggregator="manifest_only",
        max_shards_limit=20,
        required_software=("ffmpeg",),
        executor=Executor.PYTHON3,
    ),
    TaskTypeSpec(
        task_type="video_thumbnail", category="video",
        description="视频抽帧缩略图 (支持批量 / ZIP)",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="multi_file",
        slicer="files_chunked", aggregator="zip_files",
        max_shards_limit=20,
        required_software=("ffmpeg",),
        executor=Executor.PYTHON3,
    ),
    TaskTypeSpec(
        task_type="video_compress", category="video",
        description="视频压缩 (多文件体积均衡 / 超大按时段并行)",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="single_file",
        slicer="video_hybrid", aggregator="video_outputs",
        required_software=("ffmpeg",),
        min_memory_mb=2048,
        max_shards_limit=10,
        executor=Executor.PYTHON3,
    ),
    TaskTypeSpec(
        task_type="video_view", category="video",
        description="视频播放/互动 (保留接口 · 未接入平台 API)",
        accepted_input_kinds=("single_file", "params_only"),
        default_input_kind="params_only",
        slicer="single", aggregator="manifest_only",
        max_shards_limit=1,
        executor=Executor.PYTHON3,
    ),
    TaskTypeSpec(
        task_type="video_repurpose", category="video",
        description="视频二次创作 (保留接口 · 单设备)",
        accepted_input_kinds=("single_file", "params_only"),
        default_input_kind="params_only",
        slicer="single", aggregator="inline_concat",
        max_shards_limit=1,
        required_software=("ffmpeg",),
        executor=Executor.PYTHON3,
    ),
    TaskTypeSpec(
        task_type="audio_extract", category="video",
        description="从视频提取音频",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="single_file",
        slicer="files_chunked", aggregator="zip_files",
        max_shards_limit=20,
        required_software=("ffmpeg",),
        # PYTHON3: 无音轨可清晰报错；NATIVE 直调 ffmpeg 会 exit 234 且 stderr 难读
        executor=Executor.PYTHON3,
    ),
    TaskTypeSpec(
        task_type="audio_transcode", category="video",
        description="音频转码",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="single_file",
        slicer="files_chunked", aggregator="zip_files",
        required_software=("ffmpeg",),
        max_shards_limit=20,
        executor=Executor.PYTHON3,
    ),
    TaskTypeSpec(
        task_type="whisper_transcribe", category="ai",
        description="语音转文字 (Whisper)",
        accepted_input_kinds=("single_file",),
        default_input_kind="single_file",
        slicer="duration_chunked", aggregator="ordered_concat",
        required_software=("ffmpeg", "whisper"),
        min_memory_mb=4096, requires_gpu=False,  # CPU 也能跑 (慢)
        max_shards_limit=4,
        executor=Executor.NATIVE, native_binary="whisper-cli",  # whisper.cpp 自带二进制
    ),

    # ── F. 文档/OCR (pages_chunked) ──────────────────────────
    # 2026-06-11 RFC: PDF 元信息/提文用 poppler native(pdftotext/pdfinfo)· OCR 用 RapidOCR ONNX
    TaskTypeSpec(
        task_type="pdf_info", category="doc",
        description="PDF 元信息",
        accepted_input_kinds=("single_file",),
        default_input_kind="single_file",
        slicer="single", aggregator="manifest_only",
        required_software=("pymupdf",),
        executor=Executor.NATIVE, native_binary="pdfinfo",
    ),
    TaskTypeSpec(
        task_type="pdf_to_text", category="doc",
        description="PDF 提取文字 (按页并行)",
        accepted_input_kinds=("single_file",),
        default_input_kind="single_file",
        slicer="pages_chunked", aggregator="ordered_concat",
        required_software=("pymupdf",),
        max_shards_limit=20,
        executor=Executor.NATIVE, native_binary="pdftotext",
    ),
    TaskTypeSpec(
        task_type="word_to_text", category="doc",
        description="Word(.doc/.docx) 转纯文本（word-to-text-v2）",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="multi_file",
        slicer="files_chunked", aggregator="manifest_only",
        required_software=(),
        max_shards_limit=20,
        settlement_policy="artifact",
    ),
    TaskTypeSpec(
        task_type="pdf_ocr", category="doc",
        description="PDF OCR (按页并行)",
        accepted_input_kinds=("single_file",),
        default_input_kind="single_file",
        slicer="pages_chunked", aggregator="ordered_concat",
        required_software=("pymupdf",),
        min_memory_mb=2048,
        max_shards_limit=10,
        # eco-client / LAN：优先 python3 + ocr tier（ONNX 节点另走 rapid_ocr）
        required_tier="ocr", fallback_tiers=("vision-ai", "lite"),
        executor=Executor.PYTHON3,
        settlement_policy="artifact",
    ),
    TaskTypeSpec(
        task_type="ocr_image", category="doc",
        description="图片 OCR",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="single_file",
        slicer="files_chunked", aggregator="manifest_only",
        # OCR 实跑在 ocr venv tier(内含 paddleocr/tesseract)· 不能用 host software 硬过滤:
        # 节点 capabilities.software 不上报 paddleocr(它在 tier venv 里),硬过滤会误杀全部
        # ocr-tier 节点 → 整个 workload 派不下去。改用 tier 路由(required_tier=ocr)。
        required_software=(),
        required_tier="ocr", fallback_tiers=("vision-ai", "lite"),
        max_shards_limit=10,
        # 2026-06-11 RFC: 节点优先 RapidOCR ONNX(ort 直推 · 离线 · 60MB 模型 · 比 PaddleOCR 准)·
        # 没装 onnx tier 的老节点 fallback 到老 ocr venv 的 PaddleOCR python 路径
        executor=Executor.ONNX, onnx_model="rapid_ocr_v1",
    ),
    # 2026-06-10 · 律所垂直 · 合同审查闭环(pdf_to_text/pdf_ocr → contract_review → excel_export)
    TaskTypeSpec(
        task_type="contract_review", category="doc",
        description="合同智能审查(要素抽取+风险标记+汇总)· 律所垂直",
        accepted_input_kinds=("inline", "single_file", "multi_file"),
        default_input_kind="multi_file",
        slicer="files_chunked", aggregator="manifest_only",
        # LLM 走 urllib 调平台 HTTP API + openpyxl 出表是脚本内 optional · 不挡节点
        required_software=(),
        max_shards_limit=10,
    ),
    TaskTypeSpec(
        task_type="excel_export", category="doc",
        description="结构化数据 → Excel(.xlsx) 报告 · 全行业复用交付层",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="inline",
        slicer="single", aggregator="inline_concat",
        required_software=("openpyxl",),
    ),
    TaskTypeSpec(
        task_type="case_digest", category="doc",
        description="智能阅卷/案卷提炼(自定义标签+时间线+证据+争议)· 律所垂直",
        accepted_input_kinds=("inline", "single_file", "multi_file"),
        default_input_kind="single_file",
        # 单卷整体 map-reduce(脚本内自分块)· 不在引擎层切片(跨块汇总需全局视角)
        slicer="single", aggregator="inline_concat",
        # openpyxl 在脚本里 try/except 已 graceful · 不挡节点(没装则只出 JSON 不出 Excel)
        required_software=(),
        max_shards_limit=1,
    ),


    # 2026-08-02 · 平台级混合包编排 (Recipe 分流 · 分片级 task_type)
    TaskTypeSpec(
        task_type="package_digest", category="doc",
        description="混合材料包编排(拆包→分类→原子技能并行→保序聚合)· 平台原语",
        accepted_input_kinds=("archive", "multi_file", "single_file"),
        default_input_kind="archive",
        slicer="package_recipe", aggregator="package_merge",
        required_software=(),
        max_shards_limit=100,
    ),
    # 律所别名 · submit 层会规范化为 package_digest + params.recipe=law_materials
    TaskTypeSpec(
        task_type="material_digest", category="doc",
        description="[alias] → package_digest / law_materials",
        accepted_input_kinds=("archive", "multi_file", "single_file"),
        default_input_kind="archive",
        slicer="package_recipe", aggregator="package_merge",
        required_software=(),
        max_shards_limit=100,
    ),
    TaskTypeSpec(
        task_type="docx_to_text", category="doc",
        description="Word(.docx) 提取纯文本",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="single_file",
        slicer="files_chunked", aggregator="manifest_only",
        required_software=(),
        max_shards_limit=20,
    ),
    TaskTypeSpec(
        task_type="plain_text_read", category="doc",
        description="纯文本材料直读",
        accepted_input_kinds=("single_file", "multi_file", "inline", "archive"),
        default_input_kind="single_file",
        slicer="files_chunked", aggregator="manifest_only",
        required_software=(),
        max_shards_limit=50,
    ),
    TaskTypeSpec(
        task_type="sheet_to_text", category="doc",
        description="Excel/CSV 转文本",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="single_file",
        slicer="files_chunked", aggregator="manifest_only",
        required_software=(),
        max_shards_limit=20,
    ),

    # ── G. 科学计算 (samples_chunked + numeric_sum) ───────────
    TaskTypeSpec(
        task_type="pi_compute", category="compute",
        description="π 估算 (Monte Carlo)",
        accepted_input_kinds=("params_only",),
        default_input_kind="params_only",
        slicer="samples_chunked", aggregator="numeric_sum",
        max_shards_limit=10,
    ),
    TaskTypeSpec(
        task_type="monte_carlo", category="compute",
        description="Monte Carlo 通用计算",
        accepted_input_kinds=("params_only", "inline"),
        default_input_kind="params_only",
        slicer="samples_chunked", aggregator="numeric_sum",
        max_shards_limit=10,
    ),
    TaskTypeSpec(
        task_type="fft_compute", category="compute",
        description="快速傅里叶变换",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="single", aggregator="inline_concat",
        required_software=("numpy",),
    ),
    TaskTypeSpec(
        task_type="onnx_infer", category="compute",
        description="ONNX 模型推理",
        accepted_input_kinds=("multi_file",),
        default_input_kind="multi_file",
        slicer="files_chunked", aggregator="manifest_only",
        required_software=("onnxruntime",),
        max_shards_limit=10,
    ),

    # ── H. 3D 渲染 (frames_chunked + frames_to_video) ────────
    TaskTypeSpec(
        task_type="blender_render", category="render",
        description="Blender 渲染 (按帧并行)",
        accepted_input_kinds=("single_file",),
        default_input_kind="single_file",
        slicer="frames_chunked", aggregator="frames_to_video",
        required_software=("blender",),
        min_memory_mb=8192, requires_gpu=True,
        max_shards_limit=20,
    ),

    # ── I. LLM (prompts_chunked) ─────────────────────────────
    # 2026-06-11 RFC: 平台 API 中继类用 HTTP executor(节点 reqwest 直调 · 不开 Python)
    TaskTypeSpec(
        task_type="llm_chat", category="ai",
        description="LLM 对话 (单 prompt 或批量)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="inline",
        slicer="prompts_chunked", aggregator="manifest_only",
        # 2026-06-03 修正: llm_chat.py 实际是 urllib 调平台 HTTP API (/api/v1/chat/completions),
        # 不依赖本地 ollama。要求 ("ollama",) 会把所有节点过滤掉 (无人声明 ollama) → 永远 WAITING。
        # 真实要求 = python3 + 出网,无需特殊 tier。
        required_software=(),
        max_shards_limit=10,
        executor=Executor.HTTP,
    # 2026-09-18 · 算力归属标记 (加法字段 · 不改 required_software / 路由 / 计费)
    # llm_chat 的脚本是 urllib 打平台自己的 /api/v1/chat/completions · 节点零算力。
    # 必须与 local_llm_chat (节点真跑本地模型) 一眼可区分 · 避免"节点产出"假象。
    compute_origin=COMPUTE_ORIGIN_PLATFORM_RELAY,
    compute_origin_note="平台代调 · 节点只转发 HTTP 请求到平台云端 LLM",
    ),
    # 节点本机 LLM · 不走平台云 API · 客户端 task_type=local_llm_chat → run_llm_infer
    TaskTypeSpec(
        task_type="local_llm_chat", category="ai",
        description="本地大模型对话 (llama.cpp · 派到装有指定模型的节点)",
        accepted_input_kinds=("inline", "params_only"),
        default_input_kind="inline",
        slicer="single", aggregator="manifest_only",
        required_software=("local_llm",),
        max_shards_limit=1,
        executor=Executor.PYTHON3,  # 客户端硬路由 local_llm_chat→llm_infer，不拉脚本
    # 2026-09-18 · 与上一条 llm_chat 对照的算力归属标记 (节点真出算力)
    compute_origin=COMPUTE_ORIGIN_NODE,
    compute_origin_note="节点本地出算力 · llama.cpp 在节点上跑指定模型",
    ),
    # 音频转写（纯 whisper.cpp；Ollama/llama.cpp 方案已废弃）
    TaskTypeSpec(
        task_type="audio_transcribe_refine", category="ai",
        description="音频智能转写 (whisper.cpp · SRT/对话文本)",
        accepted_input_kinds=("single_file",),
        default_input_kind="single_file",
        slicer="single", aggregator="zip_files",
        required_software=("whisper", "ffmpeg"),
        min_memory_mb=4096,
        max_shards_limit=1,
        executor=Executor.PYTHON3,
    ),
    TaskTypeSpec(
        task_type="llm_classify", category="ai",
        description="批量文本分类",
        accepted_input_kinds=("params_only", "inline"),
        default_input_kind="params_only",
        slicer="prompts_chunked", aggregator="manifest_only",
        required_software=(),
        max_shards_limit=10,
    ),
    TaskTypeSpec(
        task_type="llm_extract", category="ai",
        description="批量结构化信息抽取",
        accepted_input_kinds=("params_only", "inline"),
        default_input_kind="params_only",
        slicer="prompts_chunked", aggregator="manifest_only",
        required_software=(),
        max_shards_limit=10,
    ),
    TaskTypeSpec(
        task_type="llm_translate", category="ai",
        description="批量文本翻译",
        accepted_input_kinds=("params_only", "inline"),
        default_input_kind="params_only",
        slicer="prompts_chunked", aggregator="manifest_only",
        required_software=(),
        max_shards_limit=10,
    ),
    TaskTypeSpec(
        task_type="llm_summarize", category="ai",
        description="LLM 摘要",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="inline",
        slicer="single", aggregator="inline_concat",
        # 2026-06-03 修正: llm_summarize.py 是纯 stdlib 本地 extractive,无任何外部依赖
        # 保持 PYTHON3 · 是纯本地 extractive · 没有 native/onnx 优化空间
        required_software=(),
    ),
    TaskTypeSpec(
        task_type="embedding", category="ai",
        description="向量化 (embedding)",
        accepted_input_kinds=("inline", "single_file"),
        default_input_kind="single_file",
        slicer="lines_chunked", aggregator="lines_merge",
        # 2026-06-03 修正: embedding.py 用 urllib 调平台 /api/v1/embeddings,不依赖本地 transformers。
        # 真实要求 = python3 + 出网 (且后端需启用 embeddings endpoint)。
        required_software=(),
        max_shards_limit=10,
        # 现状已是 HTTP API · 节点 reqwest 中继更快
        # 未来可切 ONNX bge-small 直推(离线 · 0 API 费用)· 优先级 P2
        executor=Executor.HTTP,
    ),
    TaskTypeSpec(
        task_type="image_caption", category="ai",
        description="图片智能分析 (Moondream 0.5B 本地视觉模型 · 对齐 RAG/png)",
        accepted_input_kinds=("single_file", "multi_file", "archive"),
        default_input_kind="single_file",
        slicer="files_chunked", aggregator="zip_files",
        # 独立 moondream tier；不复用 llama.cpp / Ollama 能力字段。
        required_software=("moondream2", "pillow"),
        required_tier="moondream",
        min_memory_mb=2048,
        requires_gpu=False,
        max_shards_limit=8,
        executor=Executor.PYTHON3,
    ),
    # 视频解析 · 对齐 RAG/mp4（ffmpeg 抽音/抽帧 + Whisper + 本地 LLM 文本/视觉）
    TaskTypeSpec(
        task_type="video_analyze", category="ai",
        description="视频智能解析 (抽音转写 + 抽帧识图 + 事情经过 · 对齐 RAG/mp4)",
        accepted_input_kinds=("single_file",),
        default_input_kind="single_file",
        slicer="single", aggregator="zip_files",
        required_software=("faster_whisper", "ffmpeg", "local_llm"),
        min_memory_mb=4096,
        max_shards_limit=1,
        executor=Executor.PYTHON3,
    ),

    # Media generation metadata only. Actual modes/tier/seconds come from an
    # official immutable profile, never this legacy fixed-five-second label.
    TaskTypeSpec(
        task_type="image_generate", category="image",
        description="图像生成（官方 profile 元数据；正式媒体执行与计费尚未接通）",
        accepted_input_kinds=("params_only",), default_input_kind="params_only",
        slicer="single", aggregator="manifest_only", min_memory_mb=8192,
        requires_gpu=True, max_shards_limit=1, executor=Executor.HTTP,
        requires_official_media_profile=True,
    ),
    TaskTypeSpec(
        task_type="video_generate", category="video",
        description="视频生成（官方 profile 元数据；正式媒体执行与计费尚未接通）",
        accepted_input_kinds=("params_only",),
        default_input_kind="params_only",
        slicer="single",
        aggregator="inline_concat",
        runtimes=("python3",),
        # 必须为空: planner 用 required_software 过滤节点，填了会排除所有节点 → 永远 WAITING
        required_software=(),
        required_tier="lite",
        min_memory_mb=8192,
        requires_gpu=True,
        default_max_shards=1,
        max_shards_limit=1,
        executor=Executor.HTTP,
        settlement_policy="artifact",
        requires_official_media_profile=True,
    ),

    # ── J. 公开数据采集 (2026-05-24 · crawl tier · 全 URL 经白名单审核) ────
    #
    # 设计原则:
    #   - 所有 URL 必须在 crawl_url_whitelist 表里 (services/crawl/whitelist.py)
    #   - submit 阶段后端校验白名单 · 节点脚本兜底再校验 (双层防御)
    #   - 节点端遵守 robots.txt + 限速 (脚本里实现) + 标准 UA
    #   - 仅采集公开页面 · 严禁登录态/付费内容/个人隐私
    # 2026-06-11 RFC: 爬虫类用 HTTP executor(节点 reqwest 抓 + 平台白名单中继 · 不开 Python)
    # crawl_url_fetch / crawl_batch_fetch: 单纯 HTTP 抓 → HTTP executor
    # crawl_url_extract: 还需 selectolax/readability 抽取 → 保留 PYTHON3(节点本地解析,免后端负载)
    TaskTypeSpec(
        task_type="crawl_url_fetch", category="crawl",
        description="单 URL 抓取 · 返回 HTML/文本/元数据",
        accepted_input_kinds=("params_only",),
        default_input_kind="params_only",
        slicer="single", aggregator="inline_concat",
        required_software=("requests", "selectolax"),
        max_shards_limit=1,
        executor=Executor.HTTP,
    ),
    TaskTypeSpec(
        task_type="crawl_url_extract", category="crawl",
        description="单 URL 抓取 + 结构化抽取 (CSS selector / readability)",
        accepted_input_kinds=("params_only",),
        default_input_kind="params_only",
        slicer="single", aggregator="inline_concat",
        required_software=("requests", "selectolax", "readability"),
        max_shards_limit=1,
    ),
    TaskTypeSpec(
        task_type="crawl_batch_fetch", category="crawl",
        description="多 URL 批量抓取 · 按 URL 数均分到多节点并行",
        accepted_input_kinds=("params_only",),
        default_input_kind="params_only",
        slicer="prompts_chunked", aggregator="manifest_only",
        required_software=("requests", "selectolax"),
        max_shards_limit=10,
        executor=Executor.HTTP,
    ),
    TaskTypeSpec(
        task_type="url_check", category="crawl",
        description="批量 URL 可用性检查",
        accepted_input_kinds=("params_only", "inline"),
        default_input_kind="params_only",
        slicer="prompts_chunked", aggregator="manifest_only",
        required_software=(),
        max_shards_limit=10,
    ),
    TaskTypeSpec(
        task_type="price_monitor", category="crawl",
        description="批量商品价格监控",
        accepted_input_kinds=("params_only",),
        default_input_kind="params_only",
        slicer="prompts_chunked", aggregator="manifest_only",
        required_software=(),
        max_shards_limit=10,
    ),
    TaskTypeSpec(
        task_type="stock_monitor", category="crawl",
        description="批量商品库存监控",
        accepted_input_kinds=("params_only",),
        default_input_kind="params_only",
        slicer="prompts_chunked", aggregator="manifest_only",
        required_software=(),
        max_shards_limit=10,
    ),
]


# ═══════════════════════════════════════════════════════════════
# V8.1 · 软件 → tier 映射 · 客户端 venv 路由的"宪法"
# ═══════════════════════════════════════════════════════════════
# 维护原则:
#   1. 一个软件只属于一个 tier (避免选择困难)
#   2. tier 名跟 bundles.py 的 /runtime/manifest.tiers 完全对齐
#   3. 加新软件就改这一处 · 不改 53+ 个 TaskTypeSpec
SOFTWARE_TO_TIER: dict[str, str] = {
    # lite tier · 基础包 (客户端首次启动自动装)
    "pillow":      "lite",
    "PIL":         "lite",
    "numpy":       "lite",
    "onnxruntime": "lite",
    "pymupdf":     "lite",
    "PyMuPDF":     "lite",
    "fitz":        "lite",
    "pdfplumber":  "lite",
    "requests":    "lite",
    "openpyxl":    "lite",
    # ocr tier · PaddleOCR + tesseract
    "paddleocr":   "ocr",
    "paddlepaddle":"ocr",
    "pytesseract": "ocr",
    # speech tier · 语音转文字 (Python faster-whisper；native whisper-cli 不走此 tier)
    "faster_whisper": "speech",
    "faster-whisper": "speech",
    "openai-whisper": "speech",
    # "whisper" = whisper.cpp 能力标签 · 不映射 speech venv（见 audio_transcribe_refine）
    # vision-ai tier · 大模型推理
    "transformers": "vision-ai",
    "torch":        "vision-ai",
    "torchvision":  "vision-ai",
    "safetensors":  "vision-ai",
    # moondream tier · 独立视觉描述运行时
    "moondream2":   "moondream",
    # crawl tier · 公开数据采集 (HTML 解析)
    "selectolax":   "crawl",
    "readability":  "crawl",
    "readability-lxml": "crawl",
    # ffmpeg tier · 静态二进制 (不走 pip)
    "ffmpeg":       "ffmpeg",
    "ffprobe":      "ffmpeg",
    # render tier · 系统命令探测
    "blender":      "render",
}

# tier 优先级 (数字小 = 优先级高)
# 当 task 同时需要多个 tier 时 · 用优先级高的作为 required_tier
# 设计直觉: 重的 tier 优先 (包含的依赖范围广 · 大概率也装了基础包)
_TIER_PRIORITY = {
    "moondream": 1,
    "vision-ai": 2,
    "speech":    3,
    "ocr":       4,
    "crawl":     5,
    "render":    6,
    "ffmpeg":    7,
    "lite":      8,
}


def infer_tier_for_software(software: Tuple[str, ...]) -> Tuple[str, Tuple[str, ...]]:
    """从 required_software 推断 (required_tier, fallback_tiers)

    返回: (主 tier, 兜底 tier 列表)
        主 tier "" 表示不需要任何特殊 tier (纯 stdlib · 任何 venv 跑)
        兜底 tier 列表给客户端 try 顺序

    例:
        ("paddleocr", "pillow")        → ("ocr", ("lite",))     # ocr 优先 · lite 兜底
        ("faster_whisper", "ffmpeg")   → ("speech", ("ffmpeg",))
        ("pillow",)                    → ("lite", ())
        ()                             → ("", ())               # 纯 stdlib
        ("local_llm",)                 → ("", ())               # 能力类 · 不在 tier 映射
        ("ollama",)                    → ("", ())               # 过渡别名
    """
    if not software:
        return "", ()
    tiers_needed: set[str] = set()
    for sw in software:
        tier = SOFTWARE_TO_TIER.get(sw)
        if tier:
            tiers_needed.add(tier)
    if not tiers_needed:
        return "", ()
    ordered = sorted(tiers_needed, key=lambda t: _TIER_PRIORITY.get(t, 99))
    return ordered[0], tuple(ordered[1:])


def resolve_tier_routing(spec: TaskTypeSpec) -> Tuple[str, Tuple[str, ...]]:
    """计算 task 最终的 (required_tier, fallback_tiers)

    优先级:
        1. spec.required_tier 显式指定 → 直接用 (+ spec.fallback_tiers)
        2. spec.required_software 自动推断 → 从 SOFTWARE_TO_TIER 算
        3. 都没 → ("", ()) · 纯 stdlib · 任何 venv 跑
    """
    if spec.required_tier:
        return spec.required_tier, spec.fallback_tiers
    return infer_tier_for_software(spec.required_software)


# ═══════════════════════════════════════════════════════════════
# 查询接口
# ═══════════════════════════════════════════════════════════════
TASK_REGISTRY: dict[str, TaskTypeSpec] = {
    t.task_type: _ensure_batch_inputs(t) for t in _TASKS
}
BUILTIN_TASK_TYPES = frozenset(TASK_REGISTRY)


def get_spec(task_type: str) -> TaskTypeSpec:
    """查 task_type · 没注册返默认 (保持兼容)"""
    found = TASK_REGISTRY.get(task_type)
    if found is not None and found.adapter_input_contract != "__blocked__":
        return found
    # One process may receive an existing workload before it has served any
    # catalog or quote request. Load its reviewed definition from the database
    # instead of silently treating it as an unreviewed default/script task.
    if not isinstance(task_type, str) or not task_type or task_type in BUILTIN_TASK_TYPES:
        return found or DEFAULT_SPEC

    def blocked_spec() -> TaskTypeSpec:
        if found is not None:
            return found
        blocked = TaskTypeSpec(
            task_type=task_type, category="other",
            description="接单技能未完成可信审核，禁止执行",
            accepted_input_kinds=("inline",), default_input_kind="inline",
            slicer="single", aggregator="inline_concat",
            settlement_policy="quarantine", exact_input_kinds=True,
            requires_verified_adapter=True,
            adapter_input_contract="__blocked__",
        )
        register_dynamic(blocked)
        return TASK_REGISTRY[task_type]

    try:
        from sqlalchemy import select
        from platform_v8.storage import db
        from platform_v8.storage.repo import task_adapter_publications_t
        from platform_v8.services.workers.task_adapter_publications import callable_task_spec
        with db.session_scope() as session:
            reviewed = callable_task_spec(session, task_type)
            if reviewed is not None:
                return reviewed
            exists = session.execute(select(task_adapter_publications_t.c.id).where(
                task_adapter_publications_t.c.task_type == task_type).limit(1)).scalar_one_or_none()
    except RuntimeError as exc:
        # Unit processes may not have initialized a database. Production DB
        # failures during dispatch are handled by the caller; do not infer an
        # approved adapter from an unavailable database.
        if str(exc).startswith("DB 未初始化"):
            return found or DEFAULT_SPEC
        return blocked_spec()
    except Exception:
        logger.exception("task_registry · reviewed task lookup failed")
        return blocked_spec()
    if exists is None:
        return found or DEFAULT_SPEC
    return blocked_spec()


def list_specs() -> list[TaskTypeSpec]:
    """所有已注册 task · 给 /api/v8/scripts 等接口列举用

    2026-05-28 fix · 之前返 _TASKS 只见 hardcode · 看不到 register_dynamic 注册的
                     · 改返 TASK_REGISTRY.values() · 含 hardcode + dynamic (v2 skill_loader 等)
    """
    return list(TASK_REGISTRY.values())


def list_by_category(category: str) -> list[TaskTypeSpec]:
    # 2026-05-28 · 改 TASK_REGISTRY 同 list_specs · 含 dynamic 注册
    return [t for t in TASK_REGISTRY.values() if t.category == category]


def all_categories() -> list[str]:
    # 2026-05-28 · 改 TASK_REGISTRY 同 list_specs · 含 dynamic 注册
    return sorted({t.category for t in TASK_REGISTRY.values()})


def list_by_mode(mode: TaskMode) -> list[TaskTypeSpec]:
    """W0-4 · 按调度模式查 task 列表 (admin UI 分组用)"""
    return [t for t in TASK_REGISTRY.values() if t.mode == mode]


def list_by_executor(executor: Executor) -> list[TaskTypeSpec]:
    """V8.2 · 按 executor 查 task 列表 (planner / admin UI 分组用)"""
    return [t for t in TASK_REGISTRY.values() if t.executor == executor]


def required_native_binaries() -> set[str]:
    """V8.2 · 所有 executor=NATIVE 的 task 引用过的 native binary 集合

    给后端 manifest 决定该下发哪些 BinarySpec / SystemBinarySpec 用 ·
    供节点 installer 按需拉到 ~/.qianshou/runtime/tiers/<tier>/bin/
    """
    return {
        t.native_binary for t in TASK_REGISTRY.values()
        if t.executor == Executor.NATIVE and t.native_binary
    }


def required_onnx_models() -> set[str]:
    """V8.2 · 所有 executor=ONNX 的 task 引用过的 ONNX 模型集合

    给后端 manifest 决定该下发哪些 OnnxModelSpec 用 ·
    供节点拉到 ~/.qianshou/runtime/onnx/<model>/ + 用 ort crate 直推
    """
    return {
        t.onnx_model for t in TASK_REGISTRY.values()
        if t.executor == Executor.ONNX and t.onnx_model
    }


def compute_origin_of(task_type: str) -> str:
    """查 task_type 的算力归属 · 未注册回落 "node" (与历史行为一致)

    给 API 序列化 / UI / 计费对账用 · 只读 · 不改变任何路由行为。
    """
    spec = TASK_REGISTRY.get(task_type)
    if spec is None:
        return COMPUTE_ORIGIN_NODE
    origin = getattr(spec, "compute_origin", COMPUTE_ORIGIN_NODE)
    return origin if origin in COMPUTE_ORIGIN_VALUES else COMPUTE_ORIGIN_NODE


def compute_origin_fields(spec: "TaskTypeSpec") -> dict:
    """算力归属的两个加法字段 · 供 API 列表接口展开 (老消费方 ignore 即可)

    只返回新增字段名 · 不改动任何既有字段 · 保证向后兼容。
    """
    origin = getattr(spec, "compute_origin", COMPUTE_ORIGIN_NODE)
    if origin not in COMPUTE_ORIGIN_VALUES:
        origin = COMPUTE_ORIGIN_NODE
    return {
        "compute_origin": origin,
        "compute_origin_note": getattr(spec, "compute_origin_note", "") or "",
    }


def executor_summary() -> dict[str, int]:
    """V8.2 · executor 分布快照 (admin /status 用)"""
    from collections import Counter
    c = Counter(t.executor.value for t in TASK_REGISTRY.values())
    return dict(c)


def register_dynamic(
    spec: TaskTypeSpec,
    *,
    preserve_static_sharding: bool = False,
) -> None:
    """W0-4 · 业务模块启动时注册新 task_type (SESSION/PULL 模式常用)

    调用示例 (services/proxy/registry.py):
        task_registry.register_dynamic(TaskTypeSpec(
            task_type="ip_proxy",
            category="system",
            description="IP 代理池会话 (平台自营)",
            accepted_input_kinds=("params_only",),
            default_input_kind="params_only",
            slicer="single", aggregator="inline_concat",  # SESSION 不走 slice/aggregate
            mode=TaskMode.SESSION,
        ))
    """
    if spec.task_type in TASK_REGISTRY and preserve_static_sharding:
        existing = TASK_REGISTRY[spec.task_type]
        # 技能包 manifest 可能仍是旧版合同，也可能声明了脚本尚未实现的
        # 批量输入。中央注册表中的输入/切片/聚合合同经过端到端验证，
        # 对已注册任务始终作为调度真源；manifest 只补描述、tier 等信息。
        spec = replace(
            spec,
            accepted_input_kinds=existing.accepted_input_kinds,
            default_input_kind=existing.default_input_kind,
            slicer=existing.slicer,
            aggregator=existing.aggregator,
            max_shards_limit=existing.max_shards_limit,
            settlement_policy=existing.settlement_policy,
            exact_input_kinds=existing.exact_input_kinds,
            requires_verified_adapter=existing.requires_verified_adapter,
            adapter_capability_id=existing.adapter_capability_id,
            adapter_output_kind=existing.adapter_output_kind,
            approved_adapter_digest=existing.approved_adapter_digest,
            adapter_input_contract=existing.adapter_input_contract,
            adapter_result_strategy=existing.adapter_result_strategy,
            parameter_schema=existing.parameter_schema,
            inline_input_form=existing.inline_input_form,
            adapter_output_schema=existing.adapter_output_schema,
            external_artifact_verifier_required=existing.external_artifact_verifier_required,
            adapter_file_schema=existing.adapter_file_schema,
            official_provider_id=getattr(existing, "official_provider_id", ""),
        )

    spec = _ensure_batch_inputs(spec)

    if spec.task_type in TASK_REGISTRY:
        existing = TASK_REGISTRY[spec.task_type]
        if existing == spec:
            return  # 幂等 · 重复调用不告警
        logger.warning("task_registry · task_type=%s 被重复注册 · 后注册覆盖", spec.task_type)

    TASK_REGISTRY[spec.task_type] = spec
    logger.info("task_registry · 动态注册 · task_type=%s mode=%s",
                spec.task_type, spec.mode.value)


# Developer publication is a separate permission from engine registration.
# Reviewed 2026-09-08: published marketplace workload types intersected with
# explicit ONESHOT specs. New/internal registrations do not become public.
DEVELOPER_TASK_TYPES = frozenset({
    "image.generate",
    "video_generate",
    "audio_extract",
    "audio_transcode",
    "audio_transcribe_refine",
    "base64_decode",
    "base64_encode",
    "blender_render",
    "case_digest",
    "contract_review",
    "crawl_batch_fetch",
    "crawl_url_extract",
    "crawl_url_fetch",
    "crc32_batch",
    "csv_to_json",
    "dedup_lines",
    "embedding",
    "excel_export",
    "fft_compute",
    "hash_batch",
    "image_caption",
    "image_compress",
    "image_convert",
    "image_info",
    "image_resize",
    "image_thumbnail",
    "json_filter",
    "json_validate",
    "line_count",
    "llm_chat",
    "llm_classify",
    "llm_extract",
    "llm_summarize",
    "llm_translate",
    "local_llm_chat",
    "md5_batch",
    "monte_carlo",
    "ocr_image",
    "onnx_infer",
    "pdf_info",
    "pdf_ocr",
    "pdf_to_text",
    "pi_compute",
    "price_monitor",
    "regex_extract",
    "stock_monitor",
    "text_diff",
    "text_extract",
    "text_mask",
    "text_replace",
    "text_sort",
    "text_split",
    "url_check",
    "url_parse",
    "video_analyze",
    "video_compress",
    "video_info",
    "video_thumbnail",
    "whisper_transcribe",
    "word_count",
    "word_to_text",
})


def get_developer_spec(task_type: str) -> TaskTypeSpec | None:
    """Strict public registration lookup; never fall back to DEFAULT_SPEC."""
    if not isinstance(task_type, str) or task_type not in DEVELOPER_TASK_TYPES:
        return None
    spec = TASK_REGISTRY.get(task_type)
    if spec is None or spec.mode != TaskMode.ONESHOT:
        return None
    # An official provider is explicitly curated here and still has live
    # admission at quote, submit and result verification. Other external
    # verifier candidates cannot inherit this public developer route.
    if spec.external_artifact_verifier_required and not spec.official_provider_id:
        return None
    if spec.requires_verified_adapter and not spec.approved_adapter_digest and not spec.official_provider_id:
        return None
    if not any(kind != "stream" for kind in spec.accepted_input_kinds):
        return None
    return spec


def list_developer_specs() -> list[TaskTypeSpec]:
    """Stable public catalog; a missing/disabled spec is not advertised."""
    return [
        spec for task_type in sorted(DEVELOPER_TASK_TYPES)
        if (spec := get_developer_spec(task_type)) is not None
    ]



def input_file_limits(spec) -> dict[str, int]:
    """Catalog mirror of existing input/shard validation; 0 means unbounded."""
    minimum, maximum, exact = _cardinality_bounds(spec)
    per_shard = int(getattr(spec, "max_files_per_shard", 0) or 0)
    if per_shard <= 0:
        per_shard = int(_MAX_FILES_PER_SHARD.get(str(spec.task_type), 0) or 0)
    return {
        "min_input_files": int(exact if exact is not None else minimum or 0),
        "max_input_files": int(exact if exact is not None else maximum or 0),
        "max_files_per_shard": per_shard,
    }


def archive_7z_runtime_ready() -> bool:
    try:
        import py7zr  # noqa: F401
        return True
    except Exception:
        return False

# --- input cardinality / shard capacity (hotpatch 2026-08-17) ---

class InputCardinalityError(ValueError):
    """提交/解压时输入文件数量不满足合同。"""


class ShardCapacityError(ValueError):
    """分片容量不足以容纳全部输入文件。"""


# task_type → (min, max, exact); 0/None = unconstrained
_INPUT_CARDINALITY: dict[str, tuple[int | None, int | None, int | None]] = {
    "text_diff": (None, None, 2),
    "docx_to_text": (1, 20, None),
    "word_to_text": (1, 20, None),
}

# 0 = 不限制每片文件数（可合并）
_MAX_FILES_PER_SHARD: dict[str, int] = {
    "docx_to_text": 1,
    "word_to_text": 1,
    "audio_transcribe_refine": 1,
    "video_analyze": 1,
    "image_caption": 1,
    "text_diff": 2,
}


def _cardinality_bounds(spec) -> tuple[int | None, int | None, int | None]:
    exact = int(getattr(spec, "exact_input_files", 0) or 0) or None
    mn = int(getattr(spec, "min_input_files", 0) or 0) or None
    mx = int(getattr(spec, "max_input_files", 0) or 0) or None
    if exact is None and mn is None and mx is None:
        return _INPUT_CARDINALITY.get(str(getattr(spec, "task_type", "") or ""), (None, None, None))
    return (mn, mx, exact)


def validate_input_file_count(
    spec,
    count: int,
    *,
    source: str = "",
    archive_package: bool = False,
) -> int:
    """校验可知的提交文件数；archive_package=True 表示提交时只计 1 个压缩包。"""
    count = int(count or 0)
    task = str(getattr(spec, "task_type", "") or "")
    label = source or "input"
    if archive_package:
        if count < 1:
            raise InputCardinalityError(f"{task} 需要 1 个压缩包（{label}={count}）")
        return count
    mn, mx, exact = _cardinality_bounds(spec)
    if exact is not None and count != int(exact):
        raise InputCardinalityError(f"{task} 需要恰好 {exact} 个文件（{label}={count}）")
    if mn is not None and count < int(mn):
        raise InputCardinalityError(f"{task} 至少需要 {mn} 个文件（{label}={count}）")
    if mx is not None and count > int(mx):
        raise InputCardinalityError(f"{task} 最多允许 {mx} 个文件（{label}={count}）")
    if count < 0:
        raise InputCardinalityError(f"{task} 文件数非法（{label}={count}）")
    return count


def validate_file_shard_capacity(spec, file_count: int, max_shards: int) -> int:
    """返回容纳全部文件所需最少分片数；超出 max_shards 则抛 ShardCapacityError。"""
    import math

    file_count = int(file_count or 0)
    max_shards = max(1, int(max_shards or 1))
    per = int(getattr(spec, "max_files_per_shard", 0) or 0)
    if per <= 0:
        per = int(_MAX_FILES_PER_SHARD.get(str(getattr(spec, "task_type", "") or ""), 0) or 0)
    if per <= 0 or file_count <= 0:
        return 1
    required = int(math.ceil(file_count / float(per)))
    if required > max_shards:
        task = str(getattr(spec, "task_type", "") or "")
        raise ShardCapacityError(
            f"{task} 至少需要 {required} 个分片才能容纳 {file_count} 个文件（当前 max_shards={max_shards}）"
        )
    return required
