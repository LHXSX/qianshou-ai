#!/usr/bin/env python3
"""pdf_to_text — PDF 提取文字 (企业级 · 2026-06-07 S5 升级)

支持:
  - multi_file (EC_INPUT_DIR 多个 PDF 批处理)
  - single_file (stdin binary 或 EC_INPUT_DIR 1 个)
  - inline (params.pdf_b64)
  - 加密 PDF 检测 (params.password 可选)
  - PyMuPDF 主路径 + pdfplumber fallback
  - 完整文字 vs 预览 (params.preview_chars · 默认 0 = 完整)
  - 元数据 (标题/作者/创建时间/页数)
  - 单文件失败不阻断整批

参数 (EC_PARAMS):
  preview_chars   int   每页文本截断(0 = 完整 · 默认 0 · 企业默认完整提取)
  include_text    bool  是否含 text 字段(false = 仅 metadata + 字数 · 用于隐私场景)
  password        str   加密 PDF 密码
  page_range      str   提取页范围 · 如 "1-10" / "1,3,5" (默认全部)
  extract_tables  bool  pdfplumber 表格提取 (实验性 · 默认 false)
"""
import base64
import json
import os
import sys
import time
from io import BytesIO

# 节点下载器当前只会下载本脚本，不能依赖同目录辅助文件。开发环境优先复用
# pdf_preflight；独立执行时使用下面完全内嵌的兼容实现。
try:
    from pdf_preflight import inspect_pdf
except ModuleNotFoundError:
    class _InlinePreflight:
        def __init__(self, **values):
            self.__dict__.update(values)

        def to_dict(self):
            return dict(self.__dict__)

    def inspect_pdf(
        pdf_bytes: bytes,
        *,
        password: str = "",
        text_density_threshold: float = 24.0,
        sample_pages: int = 3,
    ):
        try:
            import fitz  # type: ignore
        except ImportError as exc:
            raise RuntimeError("PDF 预检需要 PyMuPDF (fitz)") from exc
        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        except Exception as exc:
            raise ValueError(f"无法解析 PDF: {exc}") from exc
        try:
            encrypted = bool(doc.needs_pass)
            if encrypted and (not password or not doc.authenticate(password)):
                raise ValueError("PDF 已加密，需提供有效 password")
            total_pages = len(doc)
            if total_pages <= 0:
                raise ValueError("PDF 不含可处理页面")
            count = min(total_pages, max(1, sample_pages))
            indexes = sorted({round(i * (total_pages - 1) / max(1, count - 1)) for i in range(count)})
            chars = sum(len((doc[i].get_text() or "").strip()) for i in indexes)
            density = chars / len(indexes)
            route = "text" if density >= text_density_threshold else "ocr"
            return _InlinePreflight(
                total_pages=total_pages,
                sampled_pages=len(indexes),
                text_chars=chars,
                chars_per_page=round(density, 2),
                encrypted=encrypted,
                route=route,
                reason=(
                    f"抽样文本密度 {density:.1f} 字/页，优先文本层提取"
                    if route == "text" else f"抽样文本密度 {density:.1f} 字/页，转 PP-OCRv6"
                ),
            )
        finally:
            doc.close()


MAX_PAGES_PER_TASK = 200
MAX_OUTPUT_CHARS = 5_000_000


def _apply_slice_meta(params: dict, *, total_pages: int | None = None) -> dict:
    """兼容现有页码切片字段，并将本片范围转为已有 page_range。"""
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
        # 新 slicer 明确写 page_index_base=0（0-index + 右开区间）；历史任务
        # 没有该标记，按旧的 1-index + 闭区间兼容，避免重跑时页范围变化。
        if int(meta.get("page_index_base", 1)) == 0:
            merged["page_range"] = f"{int(start) + 1}-{int(end)}"
        else:
            merged["page_range"] = f"{int(start)}-{int(end)}"
        return merged
    if total_pages and meta.get("page_pct_start") is not None and meta.get("page_pct_end") is not None:
        # 兼容老 workload 的百分比分片。真实总页数只在节点拿到文件后可知。
        import math
        pct_start = max(0.0, min(1.0, float(meta["page_pct_start"])))
        pct_end = max(pct_start, min(1.0, float(meta["page_pct_end"])))
        start_page = max(0, math.floor(total_pages * pct_start))
        end_page = min(total_pages, math.ceil(total_pages * pct_end))
        if end_page > start_page:
            merged["page_range"] = f"{start_page + 1}-{end_page}"
    return merged


def _parse_page_range(range_str: str, total_pages: int) -> list:
    """解析 '1-10' / '1,3,5' / '1-3,7' 为 0-indexed list"""
    if not range_str:
        return list(range(min(total_pages, MAX_PAGES_PER_TASK)))
    pages = set()
    for part in str(range_str).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            try:
                a, b = part.split("-", 1)
                a, b = int(a), int(b)
                pages.update(range(max(1, a) - 1, min(total_pages, b)))
            except ValueError:
                continue
        else:
            try:
                pages.add(int(part) - 1)
            except ValueError:
                continue
    return sorted(p for p in pages if 0 <= p < total_pages)[:MAX_PAGES_PER_TASK]


def _build_paddle_ocr(language: str):
    """构造 PaddleOCR，兼容 2.x / 3.x；3.x 关闭可选预处理以降本机冷启动成本。"""
    import inspect
    # PaddlePaddle 3.3.x 在 Windows CPU + oneDNN/PIR 下会因
    # ArrayAttribute<DoubleAttribute> 转换未实现而崩溃。PaddleX 可能覆盖
    # FLAGS_use_mkldnn，因此环境开关和构造参数需要同时关闭。
    os.environ.setdefault("FLAGS_use_mkldnn", "0")
    os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")
    from paddleocr import PaddleOCR  # type: ignore

    lang = {"ch": "ch", "zh": "ch", "en": "en"}.get(language or "ch", language or "ch")
    try:
        sig_params = set(inspect.signature(PaddleOCR.__init__).parameters)
    except (TypeError, ValueError):
        sig_params = set()

    kwargs: dict = {"lang": lang}
    # 3.x：关文档方向/矫正/行方向，避免默认加载一堆重模型；与 pp-ocrv6 demo 对齐。
    for key, value in (
        ("use_doc_orientation_classify", False),
        ("use_doc_unwarping", False),
        ("use_textline_orientation", False),
        ("enable_mkldnn", False),
        ("show_log", False),
        ("use_angle_cls", False),
    ):
        if key in sig_params or key == "enable_mkldnn":
            kwargs[key] = value
    try:
        return PaddleOCR(**kwargs)
    except (TypeError, ValueError):
        try:
            return PaddleOCR(lang=lang, enable_mkldnn=False)
        except (TypeError, ValueError):
            return PaddleOCR(lang=lang)


def _ocr_lines_from_result(raw) -> list[str]:
    """从 predict()/ocr() 返回值抽取文本行，兼容 2.x 与 3.x。"""
    lines: list[str] = []
    # 3.x predict → list[OCRResult]，优先 rec_texts
    for res in raw or []:
        texts = None
        try:
            texts = res["rec_texts"]
        except Exception:
            data = getattr(res, "json", None)
            if isinstance(data, dict):
                payload = data.get("res", data)
                if isinstance(payload, dict):
                    texts = payload.get("rec_texts")
        if texts is not None:
            lines.extend(str(t) for t in texts if t)
            continue
        # 2.x ocr → [[ [box, (text, conf)], ... ]] 或退化后的单页结构
        if isinstance(res, (list, tuple)):
            for item in res:
                try:
                    lines.append(str(item[1][0]))
                except (IndexError, TypeError, KeyError):
                    continue
    return lines


def _ocr_pages(pdf_bytes: bytes, selected: list[int], password: str, language: str) -> list[dict]:
    """按页渲染并调用 PP-OCRv6/PaddleOCR。

    节点未装 OCR runtime 时明确抛错，让调度器重派给具备 ``ocr`` tier 的节点；
    不把扫描件伪装成空文本成功。

    注意：PaddleOCR 3.x 的 ``ocr(img, cls=True)`` 会 TypeError（predict 不认 cls），
    必须走 ``predict()``，必要时再回落无 cls 的 ``ocr()``。
    """
    try:
        import fitz  # type: ignore
        import numpy as np  # type: ignore
        from paddleocr import PaddleOCR  # noqa: F401  # type: ignore
    except ImportError as exc:
        raise RuntimeError("扫描 PDF 需要 PP-OCRv6 runtime（paddleocr + pymupdf）") from exc

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        if doc.needs_pass and (not password or not doc.authenticate(password)):
            raise ValueError("PDF 已加密，需提供有效 password")
        ocr = _build_paddle_ocr(language)
        pages: list[dict] = []
        for index in selected:
            pix = doc[index].get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            try:
                image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            except Exception as exc:
                raise RuntimeError(f"OCR 图像转换失败: {exc}") from exc
            raw = None
            if hasattr(ocr, "predict"):
                try:
                    raw = ocr.predict(image)
                except Exception as predict_err:
                    sys.stderr.write(
                        f"[pdf_to_text] PaddleOCR.predict() 失败 · 回退 ocr(): "
                        f"{type(predict_err).__name__}: {predict_err}\n"
                    )
                    sys.stderr.flush()
            if raw is None:
                # 绝不要传 cls=True：3.x 的 ocr() 只是 predict 别名，会炸。
                raw = ocr.ocr(image)
            text = "\n".join(_ocr_lines_from_result(raw))
            pages.append({"page": index + 1, "chars": len(text), "text": text})
        return pages
    finally:
        doc.close()


def _process_one(pdf_bytes: bytes, p: dict, filename: str = "") -> dict:
    """处理单个 PDF · 返结构化结果 · raise 给上层 catch"""
    preview = int(p.get("preview_chars") or 0)
    include_text = p.get("include_text", True)
    password = p.get("password") or ""
    page_range = p.get("page_range") or ""

    text_pages = []
    total_chars = 0
    meta: dict = {}
    backend = "unknown"

    # 自动路由：文本层密度足够则本地提取；扫描件或文本层空则走 PP-OCRv6。
    mode = str(p.get("mode") or p.get("engine") or "auto").lower()
    preflight = inspect_pdf(pdf_bytes, password=password)
    route = "ocr" if mode in {"ocr", "pp_ocrv6"} else "text"
    if mode == "auto":
        route = preflight.route
    p = _apply_slice_meta(p, total_pages=preflight.total_pages)
    page_range = p.get("page_range") or ""

    if route == "ocr":
        selected = _parse_page_range(page_range or p.get("page_range", ""), preflight.total_pages)
        text_pages = _ocr_pages(pdf_bytes, selected, password, str(p.get("language") or "ch"))
        total_chars = sum(int(x["chars"]) for x in text_pages)
        return {
            "filename": filename or "input.pdf",
            "pages_total": preflight.total_pages,
            "pages_extracted": len(text_pages),
            "total_chars": total_chars,
            "metadata": {},
            "text_pages": text_pages,
            "backend": "PP-OCRv6",
            "route": "ocr",
            "preflight": preflight.to_dict(),
        }

    # 优先 PyMuPDF
    try:
        import fitz  # type: ignore
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        # 加密处理
        if doc.needs_pass:
            if not password or not doc.authenticate(password):
                doc.close()
                raise ValueError("PDF 已加密 · 需 params.password" if not password else "PDF 密码错误")
        # 元数据
        meta = dict(doc.metadata or {})
        total_pages = len(doc)
        selected = _parse_page_range(page_range, total_pages)
        for i in selected:
            try:
                t = doc[i].get_text() or ""
            except Exception as exc:
                t = f"[页 {i+1} 提取失败: {exc}]"
            chars = len(t)
            total_chars += chars
            entry = {"page": i + 1, "chars": chars}
            if include_text:
                entry["text"] = t[:preview] if preview > 0 else t[:MAX_OUTPUT_CHARS]
            text_pages.append(entry)
        doc.close()
        backend = "PyMuPDF"
    except ImportError:
        # fallback pdfplumber
        try:
            import pdfplumber  # type: ignore
            with pdfplumber.open(BytesIO(pdf_bytes), password=password or None) as pdf:
                meta = dict(pdf.metadata or {})
                total_pages = len(pdf.pages)
                selected = _parse_page_range(page_range, total_pages)
                for i in selected:
                    try:
                        t = pdf.pages[i].extract_text() or ""
                    except Exception as exc:
                        t = f"[页 {i+1} 提取失败: {exc}]"
                    chars = len(t)
                    total_chars += chars
                    entry = {"page": i + 1, "chars": chars}
                    if include_text:
                        entry["text"] = t[:preview] if preview > 0 else t[:MAX_OUTPUT_CHARS]
                    text_pages.append(entry)
            backend = "pdfplumber"
        except ImportError:
            raise ImportError("节点缺 PyMuPDF 或 pdfplumber · pip install PyMuPDF pdfplumber")

    return {
        "filename": filename or "input.pdf",
        "pages_total": total_pages,
        "pages_extracted": len(text_pages),
        "total_chars": total_chars,
        "metadata": {
            "title": str(meta.get("title", "") or meta.get("Title", "")),
            "author": str(meta.get("author", "") or meta.get("Author", "")),
            "subject": str(meta.get("subject", "") or meta.get("Subject", "")),
            "creator": str(meta.get("creator", "") or meta.get("Creator", "")),
            "producer": str(meta.get("producer", "") or meta.get("Producer", "")),
        },
        "text_pages": text_pages,
        "backend": backend,
        "route": "text",
        "preflight": preflight.to_dict(),
    }


def _read_input(p: dict) -> list:
    """返回 [(filename, bytes), ...] · 支持 multi_file / single_file / inline / stdin"""
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    input_kind = os.environ.get("EC_INPUT_KIND", "")

    if input_kind == "multi_file" and input_dir and os.path.isdir(input_dir):
        out = []
        for fname in sorted(os.listdir(input_dir)):
            fp = os.path.join(input_dir, fname)
            if os.path.isfile(fp) and fname.lower().endswith(".pdf"):
                with open(fp, "rb") as fh:
                    out.append((fname, fh.read()))
        return out

    # single_file: EC_INPUT_DIR 取第一个,或 stdin
    if input_dir and os.path.isdir(input_dir):
        for fname in os.listdir(input_dir):
            fp = os.path.join(input_dir, fname)
            if os.path.isfile(fp):
                with open(fp, "rb") as fh:
                    return [(fname, fh.read())]

    if p.get("pdf_b64"):
        return [("inline.pdf", base64.b64decode(p["pdf_b64"]))]

    # stdin fallback
    try:
        raw = sys.stdin.buffer.read()
    except Exception:
        raw = b""
    if not raw:
        return []
    # 可能是 JSON 包裹
    if raw[:1] in (b"{", b"["):
        try:
            obj = json.loads(raw.decode("utf-8"))
            if isinstance(obj, dict) and obj.get("pdf_b64"):
                return [("inline.pdf", base64.b64decode(obj["pdf_b64"]))]
        except Exception:
            pass
    return [("stdin.pdf", raw)]


def main():
    t0 = time.time()
    try:
        p = json.loads(os.environ.get("EC_PARAMS", "{}")) or {}
    except Exception:
        p = {}

    inputs = _read_input(p)
    if not inputs:
        print(json.dumps({
            "status": "failed", "task_type": "pdf_to_text",
            "error": "无输入 PDF · 检查 EC_INPUT_DIR / params.pdf_b64 / stdin",
            "summary_text": "❌ 没拿到 PDF 数据",
        }, ensure_ascii=False))
        return 1

    results = []
    errors = []
    grand_total_chars = 0
    grand_total_pages = 0

    for fname, pdf_bytes in inputs:
        if not pdf_bytes or len(pdf_bytes) < 100:
            errors.append({"filename": fname, "error": "数据过小或为空"})
            continue
        try:
            r = _process_one(pdf_bytes, p, fname)
            results.append(r)
            grand_total_chars += r["total_chars"]
            grand_total_pages += r["pages_extracted"]
        except Exception as exc:
            errors.append({"filename": fname, "error": str(exc)})

    elapsed_ms = int((time.time() - t0) * 1000)
    ok_n = len(results)
    status = "ok" if ok_n > 0 else "failed"

    summary_text = "✓ {ok}/{tot} PDF · {pages} 页 · {chars:,} 字 · {ms}ms".format(
        ok=ok_n, tot=len(inputs), pages=grand_total_pages,
        chars=grand_total_chars, ms=elapsed_ms,
    )
    if errors:
        summary_text += " · ⚠️ {} 失败".format(len(errors))

    result_text = "\n\n".join(
        page.get("text", "")
        for result in results
        for page in result.get("text_pages", [])
        if page.get("text")
    )[:MAX_OUTPUT_CHARS]
    print(json.dumps({
        "status": status,
        "contract_version": "1",
        "task_type": "pdf_to_text",
        "elapsed_ms": elapsed_ms,
        "results": results,
        "result_text": result_text,
        "errors": errors,
        "summary": {
            "files_total": len(inputs),
            "files_ok": ok_n,
            "files_failed": len(errors),
            "pages_extracted": grand_total_pages,
            "total_chars": grand_total_chars,
        },
        "summary_text": summary_text,
    }, ensure_ascii=False))
    return 0 if ok_n > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
