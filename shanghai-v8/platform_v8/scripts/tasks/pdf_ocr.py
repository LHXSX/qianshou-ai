#!/usr/bin/env python3
"""pdf_ocr — PDF 扫描件 OCR (企业级 · 2026-06-07 S5 升级)

支持:
  - multi_file 批量 (EC_INPUT_DIR)
  - stdin binary / inline base64 / EC_INPUT_DIR
  - 多语言 (中文/英文/日文 ...)
  - 置信度过滤 (min_confidence 默认 0.6 · 商业可信门槛)
  - page_range 选页
  - 加密 PDF (params.password)
  - 自适应 DPI: 默认 144（扫描件可读）· 差页升 200 重试（只重跑不达标页）
  - 单文件失败不阻断整批

参数 (EC_PARAMS):
  lang             str   ch/en/japan/korean/it/fr/german (默认 ch)
  min_confidence   float 行级置信度过滤 (默认 0.6)
  max_pages        int   单文件最大处理页 (默认 50 · 防巨 PDF)
  page_range       str   "1-10" / "1,3,5"
  dpi              int   起始/固定分辨率 (默认 144)
  dpi_policy       str   adaptive(默认) | fixed
  dpi_max          int   adaptive 上限 (默认 200)
  password         str   加密 PDF 密码
  use_angle_cls    bool  方向分类器(默认 true · 自动正回旋)
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time


MAX_PAGES_PER_TASK = 100
MAX_OUTPUT_CHARS = 5_000_000

# 自适应 DPI 阶梯。扫描件 96dpi 常漏字/错字；默认从 144 起（与本机 doc_helper 对齐）。
_DPI_FAST = 144
_DPI_STD = 144
_DPI_CARE = 200
# 页质量阈值（基于 RapidOCR 印刷体经验 · 偏召回：宁升档勿漏字）
_AVG_CONF_OK = 0.75
_LOW_CONF_RATIO_MAX = 0.40
_MIN_CHARS_SPARSE = 12
_SCRIPT_IMPL = "adaptive_dpi_v1"


def _apply_slice_meta(params: dict, *, total_pages: int | None = None) -> dict:
    """兼容 page_start/end 与 page_pct_* (package_digest 二次切片)。"""
    merged = dict(params)
    try:
        meta = json.loads(os.environ.get("EC_SLICE_META", "{}") or "{}")
    except json.JSONDecodeError:
        meta = {}
    if not isinstance(meta, dict) or merged.get("page_range"):
        return merged
    start = meta.get("page_start", meta.get("start_page"))
    end = meta.get("page_end", meta.get("end_page"))
    if start is not None and end is not None:
        if int(meta.get("page_index_base", 1)) == 0:
            merged["page_range"] = f"{int(start) + 1}-{int(end)}"
        else:
            merged["page_range"] = f"{int(start)}-{int(end)}"
        return merged
    if total_pages and meta.get("page_pct_start") is not None and meta.get("page_pct_end") is not None:
        import math
        pct_start = max(0.0, min(1.0, float(meta["page_pct_start"])))
        pct_end = max(pct_start, min(1.0, float(meta["page_pct_end"])))
        start_page = max(0, math.floor(total_pages * pct_start))
        end_page = min(total_pages, math.ceil(total_pages * pct_end))
        if end_page > start_page:
            merged["page_range"] = f"{start_page + 1}-{end_page}"
    return merged


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _fail(msg: str, exc=None, hint: str = ""):
    out = {
        "status": "failed", "task_type": "pdf_ocr",
        "error": str(exc) if exc else msg, "summary_text": "❌ " + msg,
    }
    if hint:
        out["hint"] = hint
    print(json.dumps(out, ensure_ascii=False))
    return 1


def _parse_page_range(range_str: str, total: int) -> list:
    if not range_str:
        return list(range(min(total, MAX_PAGES_PER_TASK)))
    pages = set()
    for part in str(range_str).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            try:
                a, b = part.split("-", 1)
                pages.update(range(max(1, int(a)) - 1, min(total, int(b))))
            except ValueError:
                continue
        else:
            try:
                pages.add(int(part) - 1)
            except ValueError:
                continue
    return sorted(p for p in pages if 0 <= p < total)[:MAX_PAGES_PER_TASK]


def _read_inputs(p: dict) -> list:
    """返 [(filename, bytes), ...]"""
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    input_kind = os.environ.get("EC_INPUT_KIND", "")

    if input_kind in ("multi_file", "archive") and input_dir and os.path.isdir(input_dir):
        out = []
        for fname in sorted(os.listdir(input_dir)):
            fp = os.path.join(input_dir, fname)
            if os.path.isfile(fp) and fname.lower().endswith(".pdf"):
                with open(fp, "rb") as fh:
                    out.append((fname, fh.read()))
        return out

    if input_dir and os.path.isdir(input_dir):
        for fname in os.listdir(input_dir):
            fp = os.path.join(input_dir, fname)
            if os.path.isfile(fp):
                with open(fp, "rb") as fh:
                    return [(fname, fh.read())]

    if p.get("pdf_b64"):
        return [("inline.pdf", base64.b64decode(p["pdf_b64"]))]

    try:
        raw = sys.stdin.buffer.read()
    except Exception:
        raw = b""
    if not raw:
        return []
    if raw[:1] in (b"{", b"["):
        try:
            obj = json.loads(raw.decode("utf-8"))
            if isinstance(obj, dict):
                if obj.get("pdf_b64"):
                    if obj.get("params"):
                        p.update(obj["params"])
                    return [("inline.pdf", base64.b64decode(obj["pdf_b64"]))]
        except Exception:
            pass
    return [("stdin.pdf", raw)]


def _normalize_lines(raw: object, backend: str) -> list:
    """
    把不同 OCR 引擎的输出统一成 [(bbox, text, conf), ...] 形式
      - RapidOCR (onnxruntime): [[bbox, text, conf], ...]
      - PaddleOCR:              r[0] = [[bbox, (text, conf)], ...]
    """
    out: list = []
    if not raw:
        return out
    if backend == "rapidocr":
        for line in raw:
            try:
                bbox, text, conf = line[0], line[1], float(line[2])
                out.append((bbox, text, conf))
            except (IndexError, TypeError, ValueError):
                continue
    else:  # paddleocr
        seq = raw[0] if isinstance(raw, list) and raw and isinstance(raw[0], list) else raw
        for line in (seq or []):
            try:
                bbox, t = line[0], line[1]
                text = t[0]
                conf = float(t[1])
                out.append((bbox, text, conf))
            except (IndexError, TypeError, ValueError):
                continue
    return out


def _normalize_paddle_predict(raw: object) -> list:
    """PaddleOCR 3.x predict() → [(bbox, text, confidence), ...]。"""
    out = []
    for item in (raw or []):
        data = item
        try:
            data = item["res"] if "res" in item else item
        except Exception:
            json_data = getattr(item, "json", None)
            if isinstance(json_data, dict):
                data = json_data.get("res", json_data)
        try:
            texts = data.get("rec_texts")
            scores = data.get("rec_scores")
            boxes = data.get("rec_polys")
            if boxes is None:
                boxes = data.get("rec_boxes")
        except AttributeError:
            continue
        texts = [] if texts is None else texts
        scores = [] if scores is None else scores
        boxes = [] if boxes is None else boxes
        for index, text in enumerate(texts):
            if not text:
                continue
            confidence = float(scores[index]) if index < len(scores) else 1.0
            bbox = boxes[index] if index < len(boxes) else []
            if hasattr(bbox, "tolist"):
                bbox = bbox.tolist()
            out.append((bbox, str(text), confidence))
    return out


def _dpi_ladder(p: dict) -> list[int]:
    """构建 DPI 阶梯 · adaptive 默认 144→200；fixed 仅一档。"""
    policy = str(p.get("dpi_policy") or "adaptive").strip().lower()
    try:
        base = int(p.get("dpi", _DPI_FAST))
    except (TypeError, ValueError):
        base = _DPI_FAST
    base = max(72, min(400, base))
    if policy in ("fixed", "off", "0", "false", "no"):
        return [base]
    try:
        dpi_max = int(p.get("dpi_max", _DPI_CARE))
    except (TypeError, ValueError):
        dpi_max = _DPI_CARE
    dpi_max = max(base, min(400, dpi_max))
    ladder = [base]
    for d in (_DPI_STD, _DPI_CARE):
        if base < d <= dpi_max and d not in ladder:
            ladder.append(d)
    return ladder


def page_needs_dpi_escalate(
    *,
    raw_lines: list,
    lines_filtered: list,
    min_conf: float,
) -> tuple[bool, str, dict]:
    """页质量判定：是否应用更高 DPI 重跑。

    规则（可单测）:
      1) 检出行为空 → 升档（可能渲染过糊）
      2) 平均置信度 < 0.75 → 升档
      3) 低于 min_conf 的行占比 > 40% → 升档
      4) 有检出但过滤后字数极少(<12) → 升档（疑似手写/噪声）
    """
    raw_n = len(raw_lines or [])
    confs = []
    for item in raw_lines or []:
        try:
            confs.append(float(item[2]))
        except (IndexError, TypeError, ValueError):
            continue
    avg_conf = (sum(confs) / len(confs)) if confs else 0.0
    low_n = sum(1 for c in confs if c < float(min_conf))
    low_ratio = (low_n / raw_n) if raw_n else 1.0
    chars = sum(len(str(l.get("text") or "")) for l in (lines_filtered or []))
    metrics = {
        "raw_lines": raw_n,
        "kept_lines": len(lines_filtered or []),
        "avg_conf": round(avg_conf, 3),
        "low_conf_ratio": round(low_ratio, 3),
        "chars": chars,
    }
    if raw_n == 0:
        return True, "no_detections", metrics
    if avg_conf < _AVG_CONF_OK:
        return True, "low_avg_conf", metrics
    if low_ratio > _LOW_CONF_RATIO_MAX:
        return True, "high_low_conf_ratio", metrics
    if chars < _MIN_CHARS_SPARSE and raw_n >= 2:
        return True, "sparse_text", metrics
    return False, "ok", metrics


def _run_ocr_on_image(img_np, ocr_engine, backend: str, p: dict) -> list:
    if backend.startswith("rapidocr"):
        r, _elapse = ocr_engine(img_np)
        return _normalize_lines(r, "rapidocr")
    if hasattr(ocr_engine, "predict"):
        return _normalize_paddle_predict(ocr_engine.predict(img_np))
    r = ocr_engine.ocr(img_np, cls=p.get("use_angle_cls", True))
    return _normalize_lines(r, "paddleocr")


def _render_page_np(doc, page_index: int, dpi: int, *, use_gray: bool):
    import fitz
    from PIL import Image
    import numpy as np

    zoom = max(1.0, min(4.0, float(dpi) / 72.0))
    mat = fitz.Matrix(zoom, zoom)
    if use_gray:
        pix = doc[page_index].get_pixmap(matrix=mat, colorspace=fitz.csGRAY, alpha=False)
        img = Image.frombytes("L", [pix.width, pix.height], pix.samples)
        img_np = np.array(img)
        if img_np.ndim == 2:
            img_np = np.stack([img_np, img_np, img_np], axis=-1)
    else:
        pix = doc[page_index].get_pixmap(matrix=mat, alpha=False)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        img_np = np.array(img)
    return img_np


def _ocr_one_pdf(pdf_bytes: bytes, p: dict, fname: str, ocr_engine, backend: str) -> dict:
    """单 PDF · 渲染每页 → OCR · 返结构化结果

    adaptive: 每页先低 DPI；质量不达标再升档（只重跑该页）。
    """
    import fitz

    lang = p.get("lang", "ch")
    min_conf = float(p.get("min_confidence", 0.6))
    max_pages = int(p.get("max_pages", 50))
    page_range = p.get("page_range") or ""
    password = p.get("password") or ""
    color_mode = str(p.get("colorspace") or p.get("color") or "rgb").strip().lower()
    use_gray = color_mode in ("gray", "grey", "l", "csgray")
    ladder = _dpi_ladder(p)
    policy = str(p.get("dpi_policy") or "adaptive").strip().lower()

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    if doc.needs_pass:
        if not password or not doc.authenticate(password):
            doc.close()
            raise ValueError("PDF 已加密 · 需 params.password" if not password else "PDF 密码错误")

    total = len(doc)
    if not page_range:
        p = _apply_slice_meta(p, total_pages=total)
        page_range = p.get("page_range") or ""
    selected = _parse_page_range(page_range, total)
    if page_range:
        selected = selected[:MAX_PAGES_PER_TASK]
    else:
        selected = selected[:max_pages]

    sys.stderr.write(
        f"[pdf_ocr] dpi_policy={policy} ladder={ladder} colorspace="
        f"{'gray' if use_gray else 'rgb'} pages={len(selected)}/{total} file={fname}\n"
    )
    pages: list = []
    total_chars = 0
    low_conf_count = 0
    escalate_pages = 0
    dpi_used_sum = 0

    for i in selected:
        try:
            best = None
            escalate_trace: list[str] = []
            for di, dpi in enumerate(ladder):
                img_np = _render_page_np(doc, i, dpi, use_gray=use_gray)
                raw_lines = _run_ocr_on_image(img_np, ocr_engine, backend, p)
                lines_filtered = []
                page_low = 0
                for bbox, text, conf in raw_lines:
                    if conf < min_conf:
                        page_low += 1
                        continue
                    lines_filtered.append({
                        "text": text,
                        "conf": round(conf, 3),
                        "bbox": [[int(x), int(y)] for x, y in bbox] if bbox else [],
                    })
                need, reason, metrics = page_needs_dpi_escalate(
                    raw_lines=raw_lines,
                    lines_filtered=lines_filtered,
                    min_conf=min_conf,
                )
                page_obj = {
                    "page": i + 1,
                    "lines": lines_filtered,
                    "chars": sum(len(l["text"]) for l in lines_filtered),
                    "raw_lines": len(raw_lines),
                    "low_conf_filtered": page_low,
                    "dpi": dpi,
                    "quality": metrics,
                    "escalate_reason": reason,
                }
                best = page_obj
                if not need or di == len(ladder) - 1:
                    if di > 0:
                        escalate_pages += 1
                        escalate_trace.append(f"{ladder[0]}→{dpi}:{reason}")
                    # 顶档仍差 → 标待核（手写/严重模糊）
                    if need and di == len(ladder) - 1 and reason != "ok":
                        page_obj["need_review"] = True
                        page_obj["review_reason"] = reason
                    break
                escalate_trace.append(f"{dpi}:{reason}")
                sys.stderr.write(
                    f"[pdf_ocr] escalate page={i + 1} dpi={dpi}→{ladder[di + 1]} reason={reason} "
                    f"avg_conf={metrics.get('avg_conf')} chars={metrics.get('chars')}\n"
                )
            assert best is not None
            if escalate_trace:
                best["dpi_trace"] = escalate_trace
            low_conf_count += int(best.get("low_conf_filtered") or 0)
            total_chars += int(best.get("chars") or 0)
            dpi_used_sum += int(best.get("dpi") or ladder[0])
            pages.append(best)
        except Exception as exc:
            pages.append({"page": i + 1, "error": str(exc)[:200], "dpi": ladder[0]})

    doc.close()
    full_text = "\n\n".join(
        "\n".join(l["text"] for l in (pg.get("lines") or []))
        for pg in pages if "lines" in pg
    )
    n_ok = max(1, sum(1 for pg in pages if "lines" in pg))
    primary_dpi = ladder[0]
    avg_dpi = round(dpi_used_sum / n_ok, 1) if pages else float(primary_dpi)

    return {
        "filename": fname,
        "pages_total": total,
        "pages_processed": len(pages),
        "pages_with_text": sum(1 for pg in pages if pg.get("chars", 0) > 0),
        "total_chars": total_chars,
        "low_confidence_lines": low_conf_count,
        "min_confidence": min_conf,
        "lang": lang,
        "dpi": primary_dpi,
        "dpi_policy": policy,
        "dpi_ladder": ladder,
        "dpi_avg": avg_dpi,
        "pages_escalated": escalate_pages,
        "colorspace": "gray" if use_gray else "rgb",
        "backend": backend,
        "script_impl": _SCRIPT_IMPL,
        "text": full_text,
        "pages": pages,
    }


def main():
    t0 = time.time()
    p = _apply_slice_meta(_params())

    inputs = _read_inputs(p)
    if not inputs:
        return _fail("无输入 PDF · 检查 EC_INPUT_DIR / params.pdf_b64 / stdin")

    try:
        import fitz  # noqa
        from PIL import Image  # noqa
        import numpy as np  # noqa
    except ImportError as exc:
        return _fail("节点缺 PyMuPDF/Pillow/numpy", exc,
                     hint="pip install PyMuPDF Pillow numpy")

    # 2026-06-12 V8.2: 主路径 RapidOCR (onnxruntime · 启动 62ms · 60MB 模型) ·
    # fallback PaddleOCR (老路径 · 1.5GB tier · 启动 1500ms+)
    lang = p.get("lang", "ch")
    ocr_engine = None
    backend = "unknown"

    # 尝试主路径 · RapidOCR
    # 优先 PP-OCRv6 small（~/.qianshou/runtime/onnx/rapid_ocr_v6/），缺失回落 v4
    try:
        from rapidocr_onnxruntime import RapidOCR
        kwargs = {}
        model_tag = "bundled"
        v6_dir = os.path.expanduser("~/.qianshou/runtime/onnx/rapid_ocr_v6")
        v4_dir = os.path.expanduser("~/.qianshou/runtime/onnx/rapid_ocr_v1")
        v6_det = os.path.join(v6_dir, "PP-OCRv6_det_small.onnx")
        v6_rec = os.path.join(v6_dir, "PP-OCRv6_rec_small.onnx")
        # v6 无独立 cls；复用 v4/v5 cls（若存在）
        v6_cls = os.path.join(v6_dir, "ch_ppocr_mobile_v2.0_cls_mobile.onnx")
        if not os.path.isfile(v6_cls):
            v6_cls = os.path.join(v4_dir, "ch_ppocr_mobile_v2.0_cls_mobile.onnx")
        if os.path.isfile(v6_det) and os.path.isfile(v6_rec):
            kwargs = {"det_model_path": v6_det, "rec_model_path": v6_rec}
            if os.path.isfile(v6_cls):
                kwargs["cls_model_path"] = v6_cls
            # v6 rec 字表在 onnx 内；套 v4 keys 会 IndexError: list index out of range
            model_tag = "PP-OCRv6-small"
        elif os.path.isdir(v4_dir):
            det = os.path.join(v4_dir, "ch_PP-OCRv4_det_mobile.onnx")
            cls = os.path.join(v4_dir, "ch_ppocr_mobile_v2.0_cls_mobile.onnx")
            rec = os.path.join(v4_dir, "ch_PP-OCRv4_rec_mobile.onnx")
            keys = os.path.join(v4_dir, "ppocr_keys_v1.txt")
            if all(os.path.isfile(x) for x in (det, cls, rec, keys)):
                kwargs = {
                    "det_model_path": det, "cls_model_path": cls,
                    "rec_model_path": rec, "rec_keys_path": keys,
                }
                model_tag = "PP-OCRv4-mobile"
        ocr_engine = RapidOCR(**kwargs)
        backend = f"rapidocr:{model_tag}"
        sys.stderr.write(f"[pdf_ocr] RapidOCR ready · {model_tag}\n")
    except ImportError:
        pass  # 尝试 fallback
    except Exception as exc:
        # init 失败 · 留警告 · 尝试 fallback
        sys.stderr.write(f"[pdf_ocr] RapidOCR init failed: {exc} · 尝试 PaddleOCR\n")

    # Fallback · PaddleOCR (老 tier · 1.5GB · 仅作向后兼容)
    if ocr_engine is None:
        try:
            import inspect
            from paddleocr import PaddleOCR
            try:
                init_params = set(inspect.signature(PaddleOCR.__init__).parameters)
            except (TypeError, ValueError):
                init_params = set()
            kwargs = {"lang": lang}
            for option in ("use_doc_orientation_classify", "use_doc_unwarping"):
                if option in init_params:
                    kwargs[option] = False
            if "use_textline_orientation" in init_params:
                kwargs["use_textline_orientation"] = p.get("use_angle_cls", True)
            elif "use_angle_cls" in init_params or not init_params:
                kwargs["use_angle_cls"] = p.get("use_angle_cls", True)
            if "show_log" in init_params:
                kwargs["show_log"] = False
            try:
                ocr_engine = PaddleOCR(**kwargs)
            except (TypeError, ValueError):
                ocr_engine = PaddleOCR(lang=lang)
            backend = "paddleocr"
        except ImportError as exc:
            return _fail(
                "节点既无 RapidOCR 也无 PaddleOCR",
                exc,
                hint="装其一即可: pip install rapidocr-onnxruntime (~60MB · 推荐) "
                     "或 pip install paddleocr paddlepaddle (~1.5GB)"
            )
        except Exception as exc:
            return _fail(
                f"PaddleOCR 初始化失败 (lang={lang})", exc,
                hint="支持: ch/en/japan/korean/it/fr/german/te/ta/ar/ru · "
                     "或换 RapidOCR: pip install rapidocr-onnxruntime"
            )

    results = []
    errors = []
    grand_chars = 0
    grand_pages = 0
    for fname, pdf_bytes in inputs:
        if len(pdf_bytes) < 100:
            errors.append({"filename": fname, "error": "数据过小或为空"})
            continue
        try:
            r = _ocr_one_pdf(pdf_bytes, p, fname, ocr_engine, backend)
            results.append(r)
            grand_chars += r["total_chars"]
            grand_pages += r["pages_processed"]
        except Exception as exc:
            errors.append({"filename": fname, "error": str(exc)[:300]})

    elapsed_ms = int((time.time() - t0) * 1000)
    ok_n = len(results)
    if ok_n == 0:
        return _fail("所有 PDF OCR 失败", hint=json.dumps(errors[:3], ensure_ascii=False))
    if grand_chars <= 0:
        return _fail(
            "OCR 未识别到文字（扫描件过糊或引擎/DPI 不足）",
            hint=json.dumps(errors[:3] or [{"total_chars": 0, "backend": backend}], ensure_ascii=False),
        )

    result_text = "\n\n".join(
        result.get("text", "")
        for result in results
        if result.get("text")
    )[:MAX_OUTPUT_CHARS]
    print(json.dumps({
        "status": "ok",
        "schema_version": "v1",
        "task_type": "pdf_ocr",
        "elapsed_ms": elapsed_ms,
        "results": results,
        "result_text": result_text,
        "errors": errors,
        "summary": {
            "files_total": len(inputs),
            "files_ok": ok_n,
            "files_failed": len(errors),
            "pages_processed": grand_pages,
            "total_chars": grand_chars,
            "lang": lang,
            "backend": f"{backend}+PyMuPDF",
            "dpi_policy": str(p.get("dpi_policy") or "adaptive"),
            "pages_escalated": sum(int(r.get("pages_escalated") or 0) for r in results),
            "script_impl": _SCRIPT_IMPL,
        },
        "summary_text": (
            "✅ {ok}/{tot} PDF · {pg} 页 · {ch:,} 字 · {ms}ms · {bk} · dpi={pol}".format(
                ok=ok_n, tot=len(inputs), pg=grand_pages,
                ch=grand_chars, ms=elapsed_ms, bk=backend,
                pol=str(p.get("dpi_policy") or "adaptive"),
            )
        ),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
