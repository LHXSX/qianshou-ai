"""业务 Capability 注册表（P7）。

应用只声明 Capability，不感知 venv / pip / 系统路径。
首期冻结 3 个 MVP；OCR / 语音 / GPU 等能力待框架稳定后再加。

兼容层：
  - 老节点只报 software / runtime_tiers → 本模块推断 Capability
  - 新节点可直接报 provided_capabilities
  - planner 双读：未映射的 software 仍按原硬过滤
"""
from __future__ import annotations

from typing import Any, Iterable

CAPABILITY_API = "1"

# 健康态白名单（节点广告 / 模块状态）
HEALTHY_STATES = frozenset({"healthy", "ok", "ready", "loaded", "available", "warm", ""})

# 冻结目录 · 改这里等于改客户端契约
CAPABILITIES: dict[str, dict[str, str]] = {
    "doc.pdf.probe": {
        "version": "1.0.0",
        "title": "PDF 元信息",
        "description": "探测 PDF 页数、体积、加密与标题",
        "repair_tier": "lite",
    },
    "doc.pdf.text": {
        "version": "1.0.0",
        "title": "PDF 文本",
        "description": "从 PDF 提取文本与元信息",
        "repair_tier": "lite",
    },
    "doc.office.text": {
        "version": "1.0.0",
        "title": "Office 文本",
        "description": "从 Word（doc/docx）提取纯文本",
        "repair_tier": "lite",
    },
    "doc.ocr": {
        "version": "1.0.0",
        "title": "文档 OCR",
        "description": "图片 / PDF 扫描件 OCR（params.op=image|pdf）",
        "repair_tier": "lite",
    },
    "media.probe": {
        "version": "1.0.0",
        "title": "媒体探测",
        "description": "探测音视频封装、时长与编码信息",
        "repair_tier": "ffmpeg",
    },
    "media.transform": {
        "version": "1.0.0",
        "title": "媒体变换",
        "description": "视频压缩 / 抽帧 / 音频提取 / 音频转码（params.op）",
        "repair_tier": "ffmpeg",
    },
    "data.table.read": {
        "version": "1.0.0",
        "title": "表格读取",
        "description": "读取 CSV / 表格并转为 JSON（多文件批处理）",
        "repair_tier": "lite",
    },
    "data.json": {
        "version": "1.0.0",
        "title": "JSON 处理",
        "description": "JSON/JSONL 校验与过滤（params.op=validate|filter）",
        "repair_tier": "lite",
    },
    "text.stats": {
        "version": "1.0.0",
        "title": "文本统计",
        "description": "词频 / 行数统计（params.op=word_count|line_count）",
        "repair_tier": "lite",
    },
    "text.lines": {
        "version": "1.0.0",
        "title": "文本行处理",
        "description": "去重 / 排序 / 切分 / 替换（params.op）",
        "repair_tier": "lite",
    },
    "text.extract": {
        "version": "1.0.0",
        "title": "文本抽取",
        "description": "PII/正则/脱敏/URL 解析（params.op）",
        "repair_tier": "lite",
    },
    "text.diff": {
        "version": "1.0.0",
        "title": "文本比对",
        "description": "双文件 unified diff + 相似度",
        "repair_tier": "lite",
    },
    "net.http.fetch": {
        "version": "1.0.0",
        "title": "HTTP 抓取",
        "description": "白名单域名网页抓取（params.op=fetch|batch）",
        "repair_tier": "lite",
    },
    "net.http.extract": {
        "version": "1.0.0",
        "title": "HTTP 结构化抽取",
        "description": "抓取后 CSS/正文/meta/links 抽取",
        "repair_tier": "lite",
    },
    "net.http.check": {
        "version": "1.0.0",
        "title": "URL 可用性",
        "description": "批量 HEAD 检查状态码与延迟（白名单）",
        "repair_tier": "lite",
    },
    "net.http.monitor": {
        "version": "1.0.0",
        "title": "页面监控",
        "description": "价格/库存监控（params.op=price|stock · 白名单）",
        "repair_tier": "lite",
    },
    "math.pi": {
        "version": "1.0.0",
        "title": "高精度 π",
        "description": "Chudnovsky 算法高精度圆周率（params.digits）",
        "repair_tier": "lite",
    },
    "math.monte_carlo": {
        "version": "1.0.0",
        "title": "蒙特卡洛模拟",
        "description": "π/积分/期权/随机游走/骰子（params.op · samples）",
        "repair_tier": "lite",
    },
    "signal.fft": {
        "version": "1.0.0",
        "title": "FFT 频谱",
        "description": "一维实数快速傅里叶变换",
        "repair_tier": "lite",
    },
    "codec.base64": {
        "version": "1.0.0",
        "title": "Base64 编解码",
        "description": "文本/文件 Base64 编码与解码（params.op=encode|decode）",
        "repair_tier": "lite",
    },
    "crypto.hash": {
        "version": "1.0.0",
        "title": "文件哈希",
        "description": "按文件计算 SHA256/SHA1/MD5/CRC32 完整摘要（params.algorithm）",
        "repair_tier": "lite",
    },
    "crypto.pow": {
        "version": "1.0.0",
        "title": "哈希前缀碰撞",
        "description": "SHA256 前缀零 PoW（params.target_zeros）",
        "repair_tier": "lite",
    },
    "ai.text": {
        "version": "1.0.0",
        "title": "本机文本大模型",
        "description": "Qwen 文本槽：对话/翻译/分类/抽取/摘要/向量（params.op）",
        "repair_tier": "lite",
    },
    "ai.speech": {
        "version": "1.0.0",
        "title": "本机语音转写",
        "description": "Whisper 语音槽：音频/视频转写（params.op=transcribe）",
        "repair_tier": "lite",
    },
    "ai.vision": {
        "version": "1.0.0",
        "title": "本机图像理解",
        "description": "Moondream 视觉槽：图片描述（params.op=caption）",
        "repair_tier": "lite",
    },
    "ai.video": {
        "version": "1.0.0",
        "title": "本机视频智能解析",
        "description": "Whisper+Moondream+Qwen 管线视频解析（params.op=analyze）",
        "repair_tier": "lite",
    },
    "ai.video.h3": {
        "version": "1.0.0",
        "title": "本机 H3 视频生成",
        "description": "MiniMax H3 四档文/图生视频（qs_new4|qs_new8|qs_base12|qs_base28）",
        "repair_tier": "lite",
    },
    "image.probe": {
        "version": "1.0.0",
        "title": "图片探测",
        "description": "探测图片尺寸、格式与基础元信息",
        "repair_tier": "lite",
    },
    "image.transform": {
        "version": "1.0.0",
        "title": "图片变换",
        "description": "缩放 / 压缩 / 格式转换 / 缩略图（params.op）",
        "repair_tier": "lite",
    },
}

# software → 业务 Capability（仅 MVP；未列出的 software 仍走原 planner 硬过滤）
SOFTWARE_TO_CAPABILITY: dict[str, str] = {
    "pymupdf": "doc.pdf.text",
    "PyMuPDF": "doc.pdf.text",
    "fitz": "doc.pdf.text",
    "pdfplumber": "doc.pdf.text",
    "pdftotext": "doc.pdf.text",
    "pdfinfo": "doc.pdf.probe",
    "python-docx": "doc.office.text",
    "docx": "doc.office.text",
    "rapidocr": "doc.ocr",
    "rapidocr_onnxruntime": "doc.ocr",
    "tesseract": "doc.ocr",
    "ffmpeg": "media.probe",
    "ffprobe": "media.probe",
    "openpyxl": "data.table.read",
    "pillow": "image.transform",
    "PIL": "image.transform",
    "vips": "image.transform",
    "vipsheader": "image.probe",
}

# 已装 Runtime tier → 可提供的 Capability（与 bundles.py manifest.tiers 对齐）
TIER_TO_CAPABILITIES: dict[str, tuple[str, ...]] = {
    "lite": (
        "doc.pdf.probe",
        "doc.pdf.text",
        "doc.office.text",
        "doc.ocr",
        "data.table.read",
        "data.json",
        "text.stats",
        "text.lines",
        "text.extract",
        "text.diff",
        "image.probe",
        "image.transform",
        "net.http.fetch",
        "net.http.extract",
        "net.http.check",
        "net.http.monitor",
        "math.pi",
        "math.monte_carlo",
        "signal.fft",
        "codec.base64",
        "crypto.hash",
        "crypto.pow",
        "ai.text",
        "ai.speech",
        "ai.vision",
        "ai.video",
        "ai.video.h3",
    ),
    "ffmpeg": ("media.probe", "media.transform"),
}

# task_type → 声明式所需 Capability（优先于单纯 software 映射）
TASK_TYPE_REQUIRED_CAPS: dict[str, tuple[str, ...]] = {
    "image_info": ("image.probe",),
    "image_resize": ("image.transform",),
    "image_compress": ("image.transform",),
    "image_convert": ("image.transform",),
    "image_thumbnail": ("image.transform",),
    "video_info": ("media.probe",),
    "video_compress": ("media.transform",),
    "video_thumbnail": ("media.transform",),
    "audio_extract": ("media.transform",),
    "audio_transcode": ("media.transform",),
    "pdf_info": ("doc.pdf.probe",),
    "pdf_to_text": ("doc.pdf.text",),
    "word_to_text": ("doc.office.text",),
    "doc_to_text": ("doc.office.text",),
    "docx_to_text": ("doc.office.text",),
    "ocr_image": ("doc.ocr",),
    "pdf_ocr": ("doc.ocr",),
    "word_count": ("text.stats",),
    "line_count": ("text.stats",),
    "dedup_lines": ("text.lines",),
    "text_sort": ("text.lines",),
    "text_split": ("text.lines",),
    "text_replace": ("text.lines",),
    "text_extract": ("text.extract",),
    "regex_extract": ("text.extract",),
    "text_mask": ("text.extract",),
    "url_parse": ("text.extract",),
    "text_diff": ("text.diff",),
    "json_validate": ("data.json",),
    "json_filter": ("data.json",),
    "csv_to_json": ("data.table.read",),
    "crawl_url_fetch": ("net.http.fetch",),
    "crawl_batch_fetch": ("net.http.fetch",),
    "crawl_url_extract": ("net.http.extract",),
    "url_check": ("net.http.check",),
    "price_monitor": ("net.http.monitor",),
    "stock_monitor": ("net.http.monitor",),
    "pi_compute": ("math.pi",),
    "monte_carlo": ("math.monte_carlo",),
    "fft_compute": ("signal.fft",),
    "base64_encode": ("codec.base64",),
    "base64_decode": ("codec.base64",),
    "hash_batch": ("crypto.hash",),
    "md5_batch": ("crypto.hash",),
    "crc32_batch": ("crypto.hash",),
    "hash_collision_search": ("crypto.pow",),
    "llm_chat": ("ai.text",),
    "llm_translate": ("ai.text",),
    "llm_classify": ("ai.text",),
    "llm_extract": ("ai.text",),
    "llm_summarize": ("ai.text",),
    "local_llm_chat": ("ai.text",),
    "embedding": ("ai.text",),
    "audio_transcribe_refine": ("ai.speech",),
    "image_caption": ("ai.vision",),
    "video_analyze": ("ai.video",),
    "h3_runtime": ("ai.video.h3",),
}

MVP_NAMES = tuple(CAPABILITIES.keys())


def catalog() -> list[dict[str, str]]:
    return [{"name": name, **meta} for name, meta in CAPABILITIES.items()]


def infer_from_software(software: Iterable[str] | None) -> set[str]:
    out: set[str] = set()
    for sw in software or []:
        cap = SOFTWARE_TO_CAPABILITY.get(str(sw))
        if cap:
            out.add(cap)
    return out


def infer_from_tiers(tiers: Iterable[str] | None) -> set[str]:
    out: set[str] = set()
    for t in tiers or []:
        out.update(TIER_TO_CAPABILITIES.get(str(t), ()))
    return out


def _as_dict(cap: Any) -> dict:
    if cap is None:
        return {}
    if isinstance(cap, dict):
        return cap
    if hasattr(cap, "__dict__"):
        return dict(cap.__dict__)
    return {}


def advertised_names(cap: Any, *, hard_provided_only: bool = False) -> set[str]:
    """节点当前对外提供的 Capability 名。

    优先读 provided_capabilities（新客户端）；同时用 software / runtime_tiers 推断，
    以便老节点在双读期也能命中。

    hard_provided_only=True（R7 V2 硬匹配）：只接受 provided_capabilities 且 health 健康；
    忽略 software/tier 推断，避免「装了 Python」被当成满足 V2。
    """
    raw = _as_dict(cap)
    names: set[str] = set()
    provided = raw.get("provided_capabilities") or []
    if isinstance(provided, list):
        for item in provided:
            if isinstance(item, str) and item in CAPABILITIES:
                names.add(item)
                continue
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "")
            if name not in CAPABILITIES:
                continue
            health = str(item.get("health") or "healthy").lower()
            if health in ("quarantined", "revoked", "disabled"):
                continue
            if health in HEALTHY_STATES:
                names.add(name)
    if hard_provided_only:
        return names
    names |= infer_from_software(raw.get("software") or raw.get("runtimes") or [])
    names |= infer_from_tiers(raw.get("runtime_tiers") or [])
    return names


def worker_matches_v2_capabilities(
    cap: Any,
    required: Iterable[dict[str, str] | str] | None,
) -> bool:
    """R7：V2 硬匹配。缺任一 Capability 或仅靠 software 推断 → False。"""
    need: list[str] = []
    for item in required or []:
        if isinstance(item, str):
            need.append(item)
        elif isinstance(item, dict) and item.get("name"):
            need.append(str(item["name"]))
    if not need:
        return True
    have = advertised_names(cap, hard_provided_only=True)
    return set(need).issubset(have)


def split_software_requirements(required_software: Iterable[str] | None) -> tuple[set[str], set[str]]:
    """把 required_software 拆成（未映射 software，MVP Capability）。

    未映射部分必须继续用 software 硬过滤，避免 whisper 等被 media.probe 误替代。
    """
    unmapped: set[str] = set()
    caps: set[str] = set()
    for sw in required_software or []:
        mapped = SOFTWARE_TO_CAPABILITY.get(str(sw))
        if mapped:
            caps.add(mapped)
        else:
            unmapped.add(str(sw))
    return unmapped, caps


def resolve_required(spec: Any) -> list[dict[str, str]]:
    """task spec → 所需 MVP Capability 列表（含 version）。"""
    task_type = str(getattr(spec, "task_type", "") or "")
    if task_type in TASK_TYPE_REQUIRED_CAPS:
        return [
            {"name": name, "version": CAPABILITIES[name]["version"]}
            for name in TASK_TYPE_REQUIRED_CAPS[task_type]
            if name in CAPABILITIES
        ]
    software = getattr(spec, "required_software", None) or ()
    _unmapped, caps = split_software_requirements(software)
    out = []
    for name in MVP_NAMES:
        if name in caps:
            out.append({"name": name, "version": CAPABILITIES[name]["version"]})
    return out


def normalize_capability_list(
    raw: Any,
    *,
    default_version: str | None = None,
) -> list[dict[str, str]]:
    """作者/manifest 声明 → [{name, version}]；未知名丢弃；保序去重。"""
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw[:16]:
        name = ""
        ver = ""
        if isinstance(item, str):
            name = item.strip()
        elif isinstance(item, dict):
            name = str(item.get("name") or "").strip()
            ver = str(item.get("version") or "").strip()
        if not name or name in seen:
            continue
        if name not in CAPABILITIES:
            continue
        seen.add(name)
        if not ver:
            ver = default_version or CAPABILITIES[name]["version"]
        out.append({"name": name, "version": ver[:64]})
    return out


def author_declared_capabilities(app: dict[str, Any] | None) -> list[dict[str, str]]:
    """从 app / display_meta / runtime 读取作者声明的 Capability（已规范化）。"""
    if not app:
        return []
    meta = app.get("display_meta") if isinstance(app.get("display_meta"), dict) else {}
    runtime = app.get("runtime") if isinstance(app.get("runtime"), dict) else {}
    raw = (
        app.get("required_capabilities")
        or meta.get("required_capabilities")
        or runtime.get("required_capabilities")
        or app.get("requiresCapabilities")
        or meta.get("requiresCapabilities")
    )
    return normalize_capability_list(raw)


def validate_author_capabilities_for_v2(
    caps: list[dict[str, str]] | None,
    *,
    require_non_empty: bool = True,
) -> list[dict[str, str]]:
    """声明式 V2：caps 必须 ⊆ 官方 MVP；默认非空。非法则抛 ValueError。"""
    unknown: list[str] = []
    for item in caps or []:
        if isinstance(item, str):
            name = item.strip()
        elif isinstance(item, dict):
            name = str(item.get("name") or "").strip()
        else:
            continue
        if name and name not in CAPABILITIES:
            unknown.append(name)
    if unknown:
        raise ValueError(
            "不支持的 Capability（仅官方 MVP）: " + ", ".join(unknown[:8])
        )
    cleaned = normalize_capability_list(caps or [])
    if require_non_empty and not cleaned:
        raise ValueError("runtime_v2 应用必须声明至少 1 个官方 Capability")
    return cleaned


def worker_matches_requirements(cap: Any, required_software: Iterable[str] | None) -> bool:
    """双读：未映射 software 必须具备；已映射 software 可用 software 或 Capability 满足。"""
    needed = [str(s) for s in (required_software or []) if s]
    if not needed:
        return True
    raw = _as_dict(cap)
    worker_sw = set(raw.get("software") or [])
    if not worker_sw:
        worker_sw = set(raw.get("runtimes") or [])
    unmapped, need_caps = split_software_requirements(needed)
    if unmapped and not unmapped.issubset(worker_sw):
        return False
    if not need_caps:
        return True
    mapped_sw = {s for s in needed if s in SOFTWARE_TO_CAPABILITY}
    if mapped_sw.issubset(worker_sw):
        return True
    return need_caps.issubset(advertised_names(cap))


def repair_tiers_for(missing: Iterable[str]) -> list[str]:
    seen: list[str] = []
    for name in missing:
        tier = CAPABILITIES.get(name, {}).get("repair_tier")
        if tier and tier not in seen:
            seen.append(tier)
    return seen
