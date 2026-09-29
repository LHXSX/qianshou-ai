#!/usr/bin/env python3
"""图片智能分析 · 本机 Moondream2 视觉识图/OCR/场景梳理

模型只从 EC_MOONDREAM_MODEL_DIR 指向的本地固定快照加载，禁止联网。
推理优先 Photon，失败时自动降级 Transformers。
params.outputs 可多选: txt / json / story（默认全选）。
协议：EC_PARAMS + EC_INPUT_DIR / stdin · 输出 result_files_b64。
"""
from __future__ import annotations

import base64
import importlib.util
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

MAX_IMAGE_BYTES = 64 * 1024 * 1024
DEFAULT_OUTPUTS = ("txt", "json", "story")
DEFAULT_MODEL = "moondream2"
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif")


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "") or "{}"
    try:
        p = json.loads(raw)
        return p if isinstance(p, dict) else {}
    except Exception:
        return {}


def _fail(msg: str, exc: Exception | None = None, **extra) -> int:
    out = {
        "status": "failed",
        "contract_version": "1",
        "task_type": "image_caption",
        "error": msg,
        "elapsed_ms": 0,
        "summary_text": f"❌ {msg}",
    }
    if exc is not None:
        out["detail"] = f"{type(exc).__name__}: {exc}"
    out.update(extra)
    print(json.dumps(out, ensure_ascii=False))
    return 1


def _detect_device(requested: str) -> str:
    """兼容旧 BLIP 路径 / 单测 · 本机 LLM 识图不依赖此值。"""
    if requested and requested != "auto":
        return requested
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch, "mps") and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"



def _as_bool(v, default: bool = True) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    s = str(v).strip().lower()
    if s in ("0", "false", "no", "off", ""):
        return False
    if s in ("1", "true", "yes", "on"):
        return True
    return default


def _parse_outputs(p: dict) -> set[str]:
    alias = {
        "txt": "txt",
        "text": "txt",
        "report": "txt",
        "分析": "txt",
        "报告": "txt",
        "json": "json",
        "structured": "json",
        "story": "story",
        "scene": "story",
        "场景": "story",
        "场景梳理": "story",
    }
    raw = p.get("outputs")
    if raw is None:
        raw = p.get("result_types")
    items: list = []
    if isinstance(raw, str):
        items = [x.strip() for x in raw.replace("|", ",").split(",") if x.strip()]
    elif isinstance(raw, (list, tuple)):
        items = list(raw)
    elif isinstance(raw, dict):
        items = [k for k, v in raw.items() if _as_bool(v, False)]
    out: set[str] = set()
    for it in items:
        key = alias.get(str(it).strip().lower()) or alias.get(str(it).strip())
        if key:
            out.add(key)
    if not out:
        out = set(DEFAULT_OUTPUTS)
    return out


def _read_images(p: dict) -> list[tuple[str, bytes]]:
    """返 [(filename, bytes), ...] · 支持 EC_INPUT_DIR / stdin / image_b64。

    archive_files_chunked 每片解同一 ZIP，再用 EC_SLICE_META 指定本片文件区间；
    区间为空时置 params._empty_archive_slice，由 main 报 ok 空分片。
    """
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if input_dir and os.path.isdir(input_dir):
        paths: list[tuple[str, str]] = []
        for root, dirs, files in os.walk(input_dir):
            dirs.sort()
            for fname in sorted(files):
                if fname.lower().endswith(IMAGE_EXTS):
                    fp = os.path.join(root, fname)
                    paths.append((os.path.relpath(fp, input_dir), fp))
        selected = paths
        try:
            meta = json.loads(os.environ.get("EC_SLICE_META", "") or "{}")
            if paths and isinstance(meta.get("file_indices"), list):
                indices = [int(i) for i in meta["file_indices"]]
                selected = [paths[i] for i in indices if 0 <= i < len(paths)]
            elif paths and "file_idx_start" in meta:
                start = max(0, min(len(paths), int(meta["file_idx_start"])))
                end = max(start, min(len(paths), int(meta["file_idx_end"])))
                selected = paths[start:end]
            elif paths and "file_idx_pct_start" in meta:
                start = max(
                    0,
                    min(
                        len(paths),
                        int(len(paths) * float(meta["file_idx_pct_start"])),
                    ),
                )
                pct_end = float(meta.get("file_idx_pct_end", 1.0))
                end = len(paths) if pct_end >= 1.0 else int(len(paths) * pct_end)
                end = max(start, min(len(paths), end))
                selected = paths[start:end]
        except (TypeError, ValueError, json.JSONDecodeError):
            selected = paths
        if paths and not selected:
            p["_empty_archive_slice"] = True
        out = []
        for rel_name, fp in selected:
            with open(fp, "rb") as fh:
                out.append((rel_name, fh.read()))
        return out

    if p.get("image_b64"):
        return [("inline.jpg", base64.b64decode(p["image_b64"]))]

    try:
        raw = sys.stdin.buffer.read()
    except Exception:
        raw = b""
    if not raw:
        return []
    if raw[:1] in (b"{", b"["):
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict) and obj.get("image_b64"):
                if obj.get("params"):
                    p.update(obj["params"])
                return [("inline.jpg", base64.b64decode(obj["image_b64"]))]
        except Exception:
            pass
    return [("stdin.jpg", raw)]


# 单测 / 旧名兼容
_read_inputs = _read_images


def _create_adapter(model_dir: str, device: str):
    """加载同目录 adapter；兼容脚本直接执行和 pytest 动态加载。"""
    try:
        from _moondream_adapter import create_moondream_adapter
    except ImportError:
        adapter_path = Path(__file__).with_name("_moondream_adapter.py")
        spec = importlib.util.spec_from_file_location(
            "_image_caption_moondream_adapter", adapter_path
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("无法加载 _moondream_adapter.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        create_moondream_adapter = module.create_moondream_adapter
    return create_moondream_adapter(model_dir=model_dir, device=device)


def _requested_model(p: dict) -> str:
    for key in ("ollama_model", "vision_model", "model"):
        if key in p:
            return str(p.get(key) or "").strip()
    return ""


def _resolve_model_request(p: dict) -> tuple[str, str]:
    requested = _requested_model(p)
    normalized = requested.lower()
    if normalized in {"", "auto", "moondream2", "vikhyatk/moondream2"}:
        return DEFAULT_MODEL, requested
    raise ValueError("unsupported_legacy_model")


def _strip_fence(raw: str) -> str:
    raw = raw.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, flags=re.I)
    return m.group(1).strip() if m else raw


def _preprocess(src_bytes: bytes, max_side: int = 1536) -> tuple[bytes, int, int]:
    """缩放过长边 · 输出 JPEG bytes + 宽高。缺 pillow 时原样回传。"""
    try:
        from io import BytesIO
        from PIL import Image
    except ImportError:
        return src_bytes, 0, 0

    img = Image.open(BytesIO(src_bytes))
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    elif img.mode == "L":
        img = img.convert("RGB")
    w, h = img.size
    longest = max(w, h)
    if longest > max_side > 0:
        scale = max_side / float(longest)
        new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
        img = img.resize(new_size, Image.Resampling.LANCZOS)
        w, h = new_size
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=92, optimize=True)
    return buf.getvalue(), w, h


def _empty_analysis(source: str, width: int, height: int) -> dict:
    return {
        "source": source,
        "width": width,
        "height": height,
        "caption": "",
        "ocr_text": "",
        "objects": [],
        "people": [],
        "scene": "",
        "details": [],
        "uncertainties": [],
        "analysis_notes": "",
        "raw_model_output": "",
    }


def _parse_analysis_json(raw: str, source: str, width: int, height: int) -> dict:
    cleaned = _strip_fence(raw)
    data = None
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", cleaned)
        if m:
            try:
                data = json.loads(m.group(0))
            except json.JSONDecodeError:
                data = None
    if not isinstance(data, dict):
        a = _empty_analysis(source, width, height)
        a["caption"] = cleaned[:2000]
        a["raw_model_output"] = raw
        return a

    def _list(key: str) -> list[str]:
        val = data.get(key) or []
        if isinstance(val, str):
            return [val.strip()] if val.strip() else []
        if isinstance(val, list):
            return [str(x).strip() for x in val if str(x).strip()]
        return []

    return {
        "source": source,
        "width": width,
        "height": height,
        "caption": str(data.get("caption") or "").strip(),
        "ocr_text": str(data.get("ocr_text") or "").strip(),
        "objects": _list("objects"),
        "people": _list("people"),
        "scene": str(data.get("scene") or "").strip(),
        "details": _list("details"),
        "uncertainties": _list("uncertainties"),
        "analysis_notes": str(data.get("analysis_notes") or "").strip(),
        "raw_model_output": raw,
    }


def _split_list_answer(text: str) -> list[str]:
    cleaned = (text or "").strip()
    if not cleaned:
        return []
    # 常见：逗号/分号/换行枚举
    parts = re.split(r"[\n;]|,\s*", cleaned)
    out: list[str] = []
    for part in parts:
        item = part.strip(" \t-•*")
        if not item:
            continue
        # 去掉 "1. xxx" 前缀
        item = re.sub(r"^\d+[\).\]]\s*", "", item).strip()
        if item and item.lower() not in {"none", "n/a", "no", "nothing"}:
            out.append(item)
    return out[:12]


def _vision_analyze(
    image_bytes: bytes,
    source: str,
    width: int,
    height: int,
    adapter,
    domain_hint: str,
) -> dict:
    """0.5B 跟不动长 JSON 约束；改成 caption + 若干短英文问句。"""
    hint = domain_hint.strip()
    raw_chunks: list[str] = []

    if hasattr(adapter, "caption"):
        caption = adapter.caption(image_bytes).strip()
    else:
        caption = adapter.query(
            image_bytes, "Describe this image in one sentence."
        ).strip()
    raw_chunks.append(f"caption: {caption}")

    objects_raw = adapter.query(
        image_bytes, "List the main objects in the image, comma-separated."
    ).strip()
    raw_chunks.append(f"objects: {objects_raw}")

    people_raw = adapter.query(
        image_bytes,
        "Are there any people? If yes, briefly describe each; otherwise say none.",
    ).strip()
    raw_chunks.append(f"people: {people_raw}")

    scene = adapter.query(
        image_bytes,
        "What is the scene type and atmosphere? One short sentence.",
    ).strip()
    raw_chunks.append(f"scene: {scene}")

    ocr_text = adapter.query(
        image_bytes,
        "Is there any readable text? If yes, quote it exactly; otherwise say none.",
    ).strip()
    ocr_l = ocr_text.lower()
    if (
        not ocr_text
        or ocr_l in {"none", "no", "n/a", "nothing", "no text", "no readable text"}
        or "no readable text" in ocr_l
        or "no text" in ocr_l
        or ocr_l.startswith("no,")
        or ocr_l.startswith("none")
    ):
        ocr_text = ""
    raw_chunks.append(f"ocr: {ocr_text or '(none)'}")

    details_raw = adapter.query(
        image_bytes, "Name 2-4 notable visual details, comma-separated."
    ).strip()
    raw_chunks.append(f"details: {details_raw}")

    if hint:
        notes = adapter.query(
            image_bytes,
            f"In 2 short sentences, describe the image with focus on: {hint}",
        ).strip()
    else:
        notes = adapter.query(
            image_bytes, "In 2 short sentences, summarize what this image shows."
        ).strip()
    raw_chunks.append(f"notes: {notes}")

    people = _split_list_answer(people_raw)
    if len(people) == 1 and people[0].lower().startswith("none"):
        people = []

    return {
        "source": source,
        "width": width,
        "height": height,
        "caption": caption,
        "ocr_text": ocr_text,
        "objects": _split_list_answer(objects_raw),
        "people": people,
        "scene": scene,
        "details": _split_list_answer(details_raw),
        "uncertainties": [],
        "analysis_notes": notes,
        "raw_model_output": "\n".join(raw_chunks),
    }


def _refine_analysis(
    analysis: dict,
    adapter,
    domain_hint: str,
    image_bytes: bytes,
) -> dict:
    hint = domain_hint.strip() or "general image"
    draft = {
        "caption": analysis.get("caption") or "",
        "ocr_text": analysis.get("ocr_text") or "",
        "objects": analysis.get("objects") or [],
        "people": analysis.get("people") or [],
        "scene": analysis.get("scene") or "",
        "details": analysis.get("details") or [],
        "uncertainties": analysis.get("uncertainties") or [],
        "analysis_notes": analysis.get("analysis_notes") or "",
    }
    prompt = f"""You are an image-analysis editor. Below is a draft JSON. Fix errors, fill gaps, keep terminology consistent.
Rules:
- Do not invent content that is not in the image
- For OCR, only fix obvious typos; keep [?] when unclear
- Output JSON only, same fields as the draft
- Domain hint: {hint}

Draft:
{json.dumps(draft, ensure_ascii=False, indent=2)}
"""
    try:
        raw = adapter.query(image_bytes, prompt)
        refined = _parse_analysis_json(
            raw,
            source=str(analysis.get("source") or ""),
            width=int(analysis.get("width") or 0),
            height=int(analysis.get("height") or 0),
        )
        if not refined.get("analysis_notes") and analysis.get("analysis_notes"):
            refined["analysis_notes"] = analysis["analysis_notes"]
        return refined
    except Exception:
        return analysis


def _summarize_story(
    analysis: dict, adapter, domain_hint: str, image_bytes: bytes
) -> str:
    """用已有字段拼故事；0.5B 不适合再吃一整份 JSON 指令。"""
    del adapter, domain_hint, image_bytes  # 保留签名兼容调用方
    caption = analysis.get("caption") or "（无）"
    scene = analysis.get("scene") or "（无）"
    objects = analysis.get("objects") or []
    people = analysis.get("people") or []
    details = analysis.get("details") or []
    ocr = analysis.get("ocr_text") or ""
    notes = analysis.get("analysis_notes") or ""
    lines = [
        "## 一句话概述",
        caption,
        "",
        "## 画面构成",
        f"场景：{scene}",
        "人物：" + ("；".join(people) if people else "无明显人物"),
        "物体：" + ("；".join(objects) if objects else "（无）"),
        "",
        "## 图中文字",
        ocr if ocr else "无明显文字",
        "",
        "## 氛围与可能语境",
        notes if notes else caption,
        "",
        "## 关键细节",
        ("；".join(details) if details else "（无）"),
    ]
    return "\n".join(lines)


def _to_report_txt(analysis: dict) -> str:
    lines: list[str] = [
        f"# 图片分析：{analysis.get('source') or ''}",
        f"尺寸：{analysis.get('width') or 0}x{analysis.get('height') or 0}",
        "",
        "## 概述",
        analysis.get("caption") or "（无）",
        "",
        "## 场景",
        analysis.get("scene") or "（无）",
        "",
        "## OCR 文字",
        analysis.get("ocr_text") or "（无可见文字）",
        "",
        "## 人物",
    ]
    people = analysis.get("people") or []
    if people:
        lines.extend(f"- {p}" for p in people)
    else:
        lines.append("- （无）")
    lines += ["", "## 物体/元素"]
    objects = analysis.get("objects") or []
    if objects:
        lines.extend(f"- {o}" for o in objects)
    else:
        lines.append("- （无）")
    lines += ["", "## 细节"]
    details = analysis.get("details") or []
    if details:
        lines.extend(f"- {d}" for d in details)
    else:
        lines.append("- （无）")
    lines += ["", "## 不确定点"]
    uncertainties = analysis.get("uncertainties") or []
    if uncertainties:
        lines.extend(f"- {u}" for u in uncertainties)
    else:
        lines.append("- （无）")
    if analysis.get("analysis_notes"):
        lines += ["", "## 分析笔记", str(analysis["analysis_notes"])]
    return "\n".join(lines).strip() + "\n"


def _analyze_one(
    fname: str,
    raw: bytes,
    p: dict,
    adapter,
) -> dict:
    max_side = int(p.get("max_side") or 1536)
    prepared, width, height = _preprocess(raw, max_side=max_side)
    domain_hint = str(p.get("domain_hint") or "")
    use_refine = _as_bool(p.get("use_refine", True), True)

    analysis = _vision_analyze(
        prepared,
        source=os.path.basename(fname),
        width=width,
        height=height,
        adapter=adapter,
        domain_hint=domain_hint,
    )
    analysis["source"] = os.path.basename(fname)

    if use_refine:
        analysis = _refine_analysis(
            analysis,
            adapter=adapter,
            domain_hint=domain_hint,
            image_bytes=prepared,
        )
        analysis["source"] = os.path.basename(fname)

    story = ""
    outputs = _parse_outputs(p)
    if "story" in outputs:
        story = _summarize_story(analysis, adapter, domain_hint, prepared)

    return {
        "analysis": analysis,
        "story": story,
        "outputs": outputs,
    }


def main() -> int:
    t0 = time.time()
    p = _params()
    images = _read_images(p)
    if not images:
        if p.pop("_empty_archive_slice", False):
            print(
                json.dumps(
                    {
                        "status": "ok",
                        "contract_version": "1",
                        "schema_version": "v1",
                        "task_type": "image_caption",
                        "elapsed_ms": int((time.time() - t0) * 1000),
                        "summary": {
                            "files_total": 0,
                            "files_ok": 0,
                            "files_failed": 0,
                        },
                        "results": [],
                        "errors": [],
                        "summary_text": "空分片 · 无需处理",
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        return _fail("无图片输入 · 检查 EC_INPUT_DIR / stdin / params.image_b64")

    for fname, data in images:
        if not data:
            return _fail(f"图片数据为空: {fname}")
        if len(data) > MAX_IMAGE_BYTES:
            return _fail(f"单图超过 64MiB 上限: {fname}")

    outputs = _parse_outputs(p)
    try:
        model, _ = _resolve_model_request(p)
    except ValueError:
        return _fail(
            "unsupported_legacy_model",
            requested_model=_requested_model(p),
        )

    model_dir = os.environ.get("EC_MOONDREAM_MODEL_DIR", "").strip()
    try:
        adapter = _create_adapter(
            model_dir=model_dir,
            device=str(p.get("device") or "auto"),
        )
    except Exception as exc:
        return _fail(
            "Moondream2 本地模型加载失败",
            exc,
            model=model,
            model_dir=model_dir,
        )

    files: dict[str, str] = {}
    results: list[dict] = []
    stories: list[str] = []

    try:
        for fname, data in images:
            try:
                packed = _analyze_one(fname, data, p, adapter)
            except Exception as exc:
                return _fail(f"识图失败: {fname}", exc)

            analysis = packed["analysis"]
            story = packed["story"]
            stem = os.path.splitext(os.path.basename(fname))[0] or "image"

            if "txt" in outputs:
                report = _to_report_txt(analysis)
                files[f"{stem}.txt"] = base64.b64encode(report.encode("utf-8")).decode("ascii")
            if "json" in outputs:
                files[f"{stem}.json"] = base64.b64encode(
                    json.dumps(analysis, ensure_ascii=False, indent=2).encode("utf-8")
                ).decode("ascii")
            if "story" in outputs:
                files[f"{stem}.story.txt"] = base64.b64encode(
                    (story or "").encode("utf-8")
                ).decode("ascii")
                if story:
                    stories.append(story)

            results.append(
                {
                    "filename": fname,
                    "caption": analysis.get("caption") or "",
                    "width": analysis.get("width") or 0,
                    "height": analysis.get("height") or 0,
                    "outputs": sorted(outputs),
                    "backend": adapter.backend,
                    "device": adapter.device,
                    "model_revision": adapter.model_revision,
                }
            )
    finally:
        adapter.close()

    # 始终附带一片汇总 JSON，方便企业端预览
    summary_meta = {
        "llm_model": model,
        "ollama_model": model,  # 旧字段兼容
        "llm_backend": adapter.backend,
        "backend": adapter.backend,
        "device": adapter.device,
        "model_revision": adapter.model_revision,
        "outputs": sorted(outputs),
        "total_files": len(images),
        "results": results,
    }
    files["_batch_summary.json"] = base64.b64encode(
        json.dumps(summary_meta, ensure_ascii=False, indent=2).encode("utf-8")
    ).decode("ascii")

    labels = []
    if "txt" in outputs:
        labels.append("分析报告")
    if "json" in outputs:
        labels.append("结构化JSON")
    if "story" in outputs:
        labels.append("场景梳理")

    elapsed_ms = int((time.time() - t0) * 1000)
    first_cap = (results[0].get("caption") or "") if results else ""
    report = {
        "status": "ok",
        "contract_version": "1",
        "task_type": "image_caption",
        "elapsed_ms": elapsed_ms,
        "result_files_b64": files,
        "results": results,
        "summary": {
            "total_files": len(images),
            "llm_model": model,
            "ollama_model": model,
            "backend": adapter.backend,
            "device": adapter.device,
            "model_revision": adapter.model_revision,
            "outputs": sorted(outputs),
            "caption_preview": first_cap[:200],
        },
        "summary_text": (
            f"✓ 视觉识图 {model}/{adapter.backend} · {len(images)} 张 · 产出 {'+'.join(labels) or 'JSON'}"
            + f" · {elapsed_ms}ms"
            + (f" · {first_cap[:80]}" if first_cap else "")
        ),
    }
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
