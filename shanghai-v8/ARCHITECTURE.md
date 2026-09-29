# 千手 v8 算力平台 · 架构文档

> 2026-05-18 · 一次会话内完成的架构改造 + super_engine_v2 移植

> 历史设计记录。下文的阶段完成标记、示例路径与路线图反映撰写时的状态，不代表本次公开候选、现网服务或图像／视频商业链路已经验收；当前状态以本目录 README 和实际测试回执为准。

## 目录

1. [整体架构](#1-整体架构)
2. [核心数据流](#2-核心数据流)
3. [task_registry · 调度宪法](#3-task_registry--调度宪法)
4. [输入协议 (6 种 input_kind)](#4-输入协议)
5. [Slicer · 切片策略](#5-slicer--切片策略)
6. [Aggregator · 合并策略](#6-aggregator--合并策略)
7. [Planner · 调度与节点匹配](#7-planner--调度与节点匹配)
8. [Economy · 三方分润](#8-economy--三方分润)
9. [Verifier · 信誉与反作弊](#9-verifier--信誉与反作弊)
10. [节点端协议](#10-节点端协议)
11. [前端三层](#11-前端三层)
12. [如何加新业务类型](#12-如何加新业务类型)
13. [演进路线](#13-演进路线)

---

## 1. 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│ 前端 · enterprise-client (Tauri/Web)                             │
│   NewTaskPage → jszip 预览 → upload-url 拿 OSS presign           │
│   ResultPreviewModal → 智能信息卡 (zip/image/video)              │
└──────────────────────────────────────────────────────────────────┘
                           │ HTTP /api/v8/*
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│ Backend · platform_v8 (host python uvicorn)                      │
│   api/v8/         REST endpoints                                 │
│   services/       业务层 (auth/workloads/economy/files)          │
│   engine/         调度引擎                                       │
│     ├ task_registry    所有 task_type 的"宪法表"                 │
│     ├ slicers/         按 task 切 N 片                           │
│     ├ planner          按 requirements 过滤节点                  │
│     ├ broker           ws 推 shard_assign                        │
│     └ aggregator       全片完成后合并 + reward                   │
│   storage/        PostgreSQL we_* 表 + Redis cache               │
└──────────────────────────────────────────────────────────────────┘
                           │ WebSocket
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│ 节点 · client-v3 (Rust + Tauri)                                  │
│   v8_ws         双向长连 · 上报 capabilities · 接 shard          │
│   executor      按 input_kind 准备输入 · 跑脚本 · 回报           │
│   capabilities  探测 ffmpeg/pillow/blender/ollama                │
└──────────────────────────────────────────────────────────────────┘
                           │ subprocess + stdin
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│ Scripts · backend/scripts/tasks/*.py (52 个)                     │
│   stdin = 输入数据 (single_file 模式)                            │
│   env  = EC_INPUT_KIND / EC_INPUT_DIR / EC_PARAMS / EC_SLICE_META│
│   stdout = JSON 结果 (含 result_lines / result_images_b64)       │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心数据流

```
用户提交任务
  ↓
api/v8/workloads POST
  ↓
services/workloads/submit  ← 验余额 + escrow_hold + 推断 input_kind
  ↓
DB: we_workloads (status=CREATED)
  ↓
engine/lifecycle.start
  ↓
engine/slicers/{strategy}.slice  ← 按 task_registry 切 N shard
  ↓
DB: we_shards (status=PENDING · metadata 含 slice_meta/input_refs)
  ↓
engine/planner.schedule  ← 按 task_registry.required_software 过滤节点
  ↓
engine/broker.dispatch  ← 通过 ws 推 shard_assign 帧
  ↓ (节点 fetch input · 跑脚本 · 回报)
ws/worker shard_result  ← 节点报结果
  ↓
engine/aggregator.on_shard_done  ← reputation +SUCCESS · ShardRepo.mark_done
  ↓ (全片完成时)
engine/aggregator._maybe_finalize_workload
  ↓
engine/aggregators/{strategy}.aggregate  ← 合并 (inline_concat / zip_files / ...)
  ↓ (zip_files 会真上传 OSS · 返回 download URL)
services/economy/split.compute_split  ← 三方分润 (节点 65% · 平台 35%)
  ↓
ledger 写 N 条 REWARD (节点 / 平台 / 渠道)
  ↓
DB: we_workloads (status=DONE · result.output_ref = ZIP URL or inline JSON)
  ↓
ws/events broadcast workload.done  ← 前端实时刷新
```

---

## 3. task_registry · 调度宪法

📄 `platform_v8/engine/task_registry.py`

每个 task_type 一条 `TaskTypeSpec` 记录, 字段:

| 字段 | 含义 | 例 |
|---|---|---|
| `task_type` | 标识 | `image_resize` |
| `category` | 大类 | `image` |
| `accepted_input_kinds` | 接受的输入形态 | `("single_file","multi_file","archive")` |
| `default_input_kind` | 默认 | `multi_file` |
| `slicer` | 切片策略名 | `files_chunked` |
| `aggregator` | 合并策略名 | `zip_files` |
| `required_software` | 节点必须装的软件 | `("pillow",)` |
| `min_memory_mb` | 内存下限 | `0` |
| `requires_gpu` | 是否要 GPU | `False` |
| `default_max_shards` | 默认切几片 | `1` |
| `max_shards_limit` | 这种 task 最多能切几片 | `20` |

**已注册的 28 个 task_type** (按 category):

- **text** (3): dedup_lines, word_count, json_filter
- **encoding** (2): base64_encode, hash_batch
- **image** (5): image_info, image_resize, image_compress, image_convert, image_thumbnail
- **video** (5): video_info, video_compress, audio_extract, audio_transcode, whisper_transcribe (ai)
- **doc** (4): pdf_info, pdf_to_text, pdf_ocr, ocr_image
- **compute** (4): pi_compute, monte_carlo, fft_compute, onnx_infer
- **render** (1): blender_render
- **ai** (3): llm_chat, llm_summarize, embedding

---

## 4. 输入协议

📄 `platform_v8/core/workload.py` · `WorkloadSpec`

| input_kind | 用 | 字段 | 节点端处理 |
|---|---|---|---|
| `inline` | 小文本 | `inline_input: str` | 直接喂 stdin |
| `single_file` | 单文件 | `input_ref: OSS URL` | fetch → stdin |
| `multi_file` | 批量文件 | `input_refs: list[URL]` | 下载到 EC_INPUT_DIR |
| `archive` | zip 压缩包 | `input_ref: zip URL` | 下载 + 解压 → EC_INPUT_DIR |
| `stream` | 大视频流 | `input_ref: m3u8` | (MVP 未实现) |
| `params_only` | 无文件 | (仅 params) | 不喂 stdin |

**自动推断** (前端 NewTaskPage):
- 0 文件 → `params_only`
- 1 个 zip/tar → `archive`
- 1 个其它 → `single_file`
- N 个 → `multi_file`

---

## 5. Slicer · 切片策略

📄 `platform_v8/engine/slicers/`

| Slicer | 用于 task_type | 切片规则 | 每片元数据 |
|---|---|---|---|
| `single` | image_info / video_info / 默认 | 永远 1 片 | 整 input |
| `files_chunked` | image_resize multi_file | 按 input_refs 均分 | `input_refs[i:j]` |
| `archive_files_chunked` | image_resize archive | 按文件序号百分比 | `slice_meta.file_idx_pct_*` |
| `pages_chunked` | pdf_to_text / pdf_ocr | 按 PDF 页范围 | `slice_meta.page_*` |
| `duration_chunked` | video_compress / whisper | 按时段百分比 | `slice_meta.start_pct/end_pct` |

**派发优先级** (`slicers/__init__.py`):
1. `input_kind=archive` → 强制 `archive_files_chunked`
2. `input_kind=single_file` + slicer in (pages/duration/frames) → 用该 slicer
3. 其它 → 用 `task_registry.slicer`

---

## 6. Aggregator · 合并策略

📄 `platform_v8/engine/aggregators/`

| Aggregator | 用于 | 输入 | 输出 |
|---|---|---|---|
| `inline_concat` | 默认 / 单片 | shards | output_ref 字符串 |
| `lines_merge` | word_count / hash_batch 多片 | N 个 JSON | 合并 result_lines |
| `ordered_concat` | pdf_to_text / whisper | 按 index 排序拼 | 顺序文本 |
| `numeric_sum` | monte_carlo / pi_compute | N 个数值 | 加总 + mean/min/max |
| `zip_files` | image_resize / image_compress | N 个 result_images_b64 | **ZIP 上传 OSS · 返 URL** |
| `manifest_only` | image_info / pdf_info | N 个 metadata | 合并 results 数组 |

---

## 7. Planner · 调度与节点匹配

📄 `platform_v8/engine/planner.py` · `_filter_by_requirements`

按 `task_registry.required_software / min_memory_mb / requires_gpu` 过滤候选 worker:

```python
candidates = [
    w for w in online_workers
    if needed_software.issubset(set(w.capabilities.software))
    and (w.capabilities.total_memory_mb >= min_memory_mb or min_memory_mb == 0)
    and (w.capabilities.gpu_count >= 1 if requires_gpu else True)
]
```

不匹配的节点不派 · 没节点匹配 → workload 进 `WAITING_FOR_WORKERS` 等装好软件的节点上线再 auto-resubmit。

**节点 capabilities 来源**: `client-v3/src-tauri/src/comm/v8_ws.rs::collect_capabilities`
探测命令:
- 命令行: `which ffmpeg / blender / ollama / convert / unzip / git`
- Python 模块: `python3 -c "import PIL/numpy/fitz/paddleocr/onnxruntime/whisper/..."`

---

## 8. Economy · 三方分润

📄 `platform_v8/services/economy/split.py` (移植自 `super_engine_v2/economy/settlement.py`)

```
workload.budget = GMV
  ↓
client_pool   = GMV × 65%  → 节点 owners (按贡献二次分配)
platform_pool = GMV × 30%  → 平台账号 (admin)
channel_pool  = GMV ×  5%  → 渠道账号 (无配置时并入平台)
```

**节点二次分配** (按贡献权重):
```
weight = shard_count × quality × reputation × risk
own_share = client_pool × (own_weight / sum_weights)
```

**配置** (env):
```bash
V8_SETTLEMENT_CLIENT_RATIO=0.65
V8_SETTLEMENT_PLATFORM_RATIO=0.30
V8_SETTLEMENT_CHANNEL_RATIO=0.05
V8_PLATFORM_ACCOUNT_ID=1     # 默认 admin
V8_CHANNEL_ACCOUNT_ID=0      # 0=没渠道 · 5% 并入平台
```

**Ledger 写入** (`engine/aggregator._finalize_done`):
- 节点 owner 拿 65% → `REWARD` (idempotent_suffix=`node-{owner_id}`)
- 平台账号拿 35% → `REWARD` (idempotent_suffix=`platform`)
- 渠道账号拿 5% → `REWARD` (idempotent_suffix=`channel`) [可选]

---

## 9. Verifier · 信誉与反作弊

📄 `platform_v8/services/economy/reputation.py` · `anti_cheat.py`

### 信誉 (EMA)

每个节点 `we_workers.reputation` (0.0-1.0, 默认 0.5)

事件 → 目标分:
- `SUCCESS` → 1.0 · 平滑提升
- `FAILURE` → 0.4
- `TIMEOUT` → 0.5
- `MISMATCH` → 0.0 (硬罚 ×0.5)
- `BENCHMARK_FAIL` → 0.0 (硬罚 ×0.4)
- `MANUAL_BAN` → 0

EMA 公式: `new = 0.25 × target + 0.75 × current`

3 次 SUCCESS 后: `0.5 → 0.625 → 0.72 → 0.79`

### 反作弊 (多数派比对)

📄 `services/economy/anti_cheat.py` (框架已 · 未接 dispatcher 冗余派发)

启用需:
1. `WorkloadSpec.redundancy_factor: int = 1` 字段
2. `lifecycle.start` 按 N 冗余派发 (1 shard → N 副本派不同节点)
3. `aggregator._maybe_finalize_workload` 调 `anti_cheat.evaluate_redundant_results`
4. settlement 跳过 cheating_nodes 的 reward · 给 honest_nodes 加 reputation

---

## 10. 节点端协议

📄 `client-v3/src-tauri/src/comm/v8_ws.rs` · `task/executor.rs`

### Shard 帧 (server → client)
```typescript
ShardAssignPayload {
  shard_id, workload_id, index, total,
  task_type, runtime, code_url,
  input_kind,           // "single_file" / "multi_file" / "archive" / "inline" / "params_only"
  input_ref,            // 主 URL (single_file / archive)
  input_refs,           // 多 URL (multi_file)
  inline_input,         // inline 内容
  slice_meta,           // 切片元数据 (page 范围 / 时段)
  params,
  timeout_s, reward,
}
```

### Executor 准备输入
按 `input_kind` 选 fetch 策略:
- `single_file`: GET input_ref → stdin
- `multi_file`: 下载所有 input_refs 到临时目录 → `EC_INPUT_DIR`
- `archive`: 下载 input_ref + 解压 → `EC_INPUT_DIR`
- `params_only`: 不喂 stdin

### 暴露给脚本的 env vars
- `EC_INPUT_KIND` = 输入类型
- `EC_INPUT_REF` = 主 URL (single_file)
- `EC_INPUT_DIR` = 临时目录 (multi_file / archive)
- `EC_PARAMS` = JSON · 用户参数
- `EC_SLICE_META` = JSON · 切片元数据

---

## 11. 前端三层

### Layer 1 (jszip 智能预览)
📄 `enterprise-client/src/pages/NewTaskPage.vue::analyzeArchive`

用户拖 zip → jszip 本地解析 → 显示:
- 文件数 · 总大小 · 类型分布
- 样例文件名
- 是否匹配任务类型 (不匹配警告)

### Layer 2 (自动 input_kind)
📄 `NewTaskPage.vue::submitTask`

```typescript
if (dlUrls.length === 1 && isArchive(name)) input_kind = "archive"
else if (dlUrls.length === 1) input_kind = "single_file"
else if (dlUrls.length > 1)  input_kind = "multi_file"
else input_kind = "params_only"
```

### Layer 3 (ResultPreviewModal 智能信息卡)
📄 `enterprise-client/src/components/ResultPreviewModal.vue`

- ZIP 输出 → 信息卡 (源/进度/参数/明细 + 下载)
- inline JSON → 摘要/原文双视图
- 图片 → IMG 预览
- 其它 → 普通下载

---

## 12. 如何加新业务类型

**3 步加新 task_type** (不动 engine / executor / aggregator):

### 步骤 1: 写脚本
`backend/scripts/tasks/your_task.py`

```python
#!/usr/bin/env python3
"""your_task — 业务描述"""
import json, os, sys

def main() -> int:
    input_kind = os.environ.get("EC_INPUT_KIND", "single_file")
    params = json.loads(os.environ.get("EC_PARAMS", "{}"))

    if input_kind == "single_file":
        raw = sys.stdin.buffer.read()
        # 处理 raw...
    elif input_kind in ("multi_file", "archive"):
        input_dir = os.environ.get("EC_INPUT_DIR", "")
        for fname in sorted(os.listdir(input_dir)):
            # 处理每个文件...
            pass

    print(json.dumps({
        "status": "ok",
        "schema_version": "v1",
        "task_type": "your_task",
        "summary": {...},
        "result_lines": [...],  # 或 result_images_b64: {...}
    }, ensure_ascii=False))
    return 0

if __name__ == "__main__": sys.exit(main())
```

### 步骤 2: 注册 task_registry
`platform_v8/engine/task_registry.py` · `_TASKS` 加一条:

```python
TaskTypeSpec(
    task_type="your_task",
    category="text",  # or image/video/doc/compute/ai/render
    description="业务描述",
    accepted_input_kinds=("inline", "single_file", "multi_file"),
    default_input_kind="single_file",
    slicer="single",          # 或 files_chunked / pages_chunked / ...
    aggregator="inline_concat", # 或 zip_files / numeric_sum / ...
    required_software=("numpy",),  # 节点需装的 python 模块或命令
    min_memory_mb=0,
    max_shards_limit=10,
),
```

### 步骤 3: (可选) 前端业务化
`enterprise-client/src/composables/useScenarios.ts` · 加 BizTask 包装

---

## 13. 演进路线

### 已完成 (本次会话)
- ✅ Phase 1-8 架构改造 (input_kind / slicer / aggregator / planner)
- ✅ P0 三方分润
- ✅ P1 reputation EMA
- ✅ P1 anti_cheat 框架

### 短期 (业务上线必做)
- ⏳ dispatcher 冗余派发 (启用 anti_cheat)
- ⏳ LedgerType 区分 PLATFORM_REVENUE / CHANNEL_REVENUE / NODE_REWARD (财务报表)
- ⏳ admin 经济总览页 (GMV/平台收入/节点信誉排名)
- ⏳ 视频 / PDF 真实业务跑通 (需节点装 ffmpeg / PyMuPDF)

### 中期 (规模化)
- ⏳ verifier/benchmark (探针检测慢节点)
- ⏳ multi_objective scheduler (成本/延迟/质量权衡)
- ⏳ Docker / WASM runtime (强隔离)
- ⏳ Kafka dispatcher (替代 ws 长连)
- ⏳ Temporal workflows (长任务编排)

### 远期
- ⏳ tensor_parallel / model_parallel slicer (大模型分布式推理)
- ⏳ OpenTelemetry + Prometheus 全链路追踪
- ⏳ 多 region 调度 (网络延迟感知)
