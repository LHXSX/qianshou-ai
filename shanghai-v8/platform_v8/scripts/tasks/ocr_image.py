#!/usr/bin/env python3
"""ocr_image — 图片 OCR(企业级 · 2026-06-10 阅卷升级)

阅卷流水线第一段:一摞照片/扫描件 → 文字(带页码,直接喂 case_digest)。

升级:
  - 多照片批处理(EC_INPUT_DIR · 每张照片 = 一页)· 配合 files_chunked 多节点并行
  - 输出带【第N页:文件名】标记 → 下游 case_digest 据此做页码定位
  - 图像预处理提准:EXIF 自动纠偏 + 转灰度 + 对比度增强(可关)
  - 置信度过滤 + 低置信/疑似手写自动标「(待核)」(不瞎编)
  - 优先 PaddleOCR · 兜底 Tesseract
  - 单图(stdin/base64)向后兼容

参数 (EC_PARAMS):
  lang             str   ch/en/japan...(默认 ch)
  min_confidence   float 行级置信度过滤(默认 0.5)
  review_threshold float 单页平均置信度低于此 → 整页标「(待核)」(默认 0.75)
  preprocess       bool  图像预处理(默认 true)
  page_start       int   起始页号(多节点分片时由切片器传入·默认 1)
  return_lines     bool  是否回每行明细(默认 false · 大批量省体积)
"""
import base64
import json
import os
import sys
import time
from io import BytesIO


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _read_images(p: dict) -> list:
    """返 [(filename, bytes), ...]"""
    d = os.environ.get("EC_INPUT_DIR", "")
    if d and os.path.isdir(d):
        out = []
        for fn in sorted(os.listdir(d)):
            fp = os.path.join(d, fn)
            if os.path.isfile(fp) and fn.lower().endswith(
                    (".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp")):
                with open(fp, "rb") as fh:
                    out.append((fn, fh.read()))
        if out:
            return out
    if p.get("image_b64"):
        return [("image", base64.b64decode(p["image_b64"]))]
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
                return [("image", base64.b64decode(obj["image_b64"]))]
        except Exception:
            pass
    return [("image", raw)]


def _preprocess(img, enable: bool):
    """EXIF 纠偏 + 灰度 + 对比度增强(提印刷体准率)"""
    from PIL import Image, ImageOps
    img = img.convert("RGB")
    if not enable:
        return img
    try:
        img = ImageOps.exif_transpose(img)   # 按拍摄方向纠正
    except Exception:
        pass
    try:
        g = ImageOps.grayscale(img)
        g = ImageOps.autocontrast(g, cutoff=1)
        return g.convert("RGB")
    except Exception:
        return img


def _make_engine(lang: str):
    """返 (ocr_fn, backend) · ocr_fn(img)->[(text,conf)] · 缺库抛 ImportError

    兼容 PaddleOCR 2.x 与 3.x:
      · 3.x 去掉了 show_log · use_angle_cls→use_textline_orientation · .ocr()→.predict()
        (节点 ocr venv 普遍是 paddleocr 3.x · 旧写法会 ValueError: Unknown argument: show_log)
      · 按 __init__ 签名探测可用参数 · 调用优先 .predict() · 回落 .ocr()
    """
    try:
        from paddleocr import PaddleOCR
        import numpy as np
        import inspect

        try:
            sig_params = set(inspect.signature(PaddleOCR.__init__).parameters)
        except (TypeError, ValueError):
            sig_params = set()

        kwargs = {"lang": lang}
        # 文本行方向分类:3.x 用 use_textline_orientation · 2.x 用 use_angle_cls
        if "use_textline_orientation" in sig_params:
            kwargs["use_textline_orientation"] = True
        elif "use_angle_cls" in sig_params or not sig_params:
            kwargs["use_angle_cls"] = True
        # show_log 仅 2.x 支持 · 3.x 传了会 ValueError
        if "show_log" in sig_params:
            kwargs["show_log"] = False
        try:
            eng = PaddleOCR(**kwargs)
        except (ValueError, TypeError):
            # 极端兜底:只给 lang(任何版本都认)
            eng = PaddleOCR(lang=lang)

        def _from_predict(res_list):
            """3.x: predict 返回 list[OCRResult] · 每个含 rec_texts / rec_scores"""
            out = []
            for res in (res_list or []):
                texts = scores = None
                try:
                    texts = res["rec_texts"]
                    scores = res["rec_scores"]
                except Exception:
                    data = getattr(res, "json", None)
                    if isinstance(data, dict):
                        r = data.get("res", data)
                        texts = r.get("rec_texts")
                        scores = r.get("rec_scores")
                if texts is None:
                    continue
                scores = scores or [1.0] * len(texts)
                for t, c in zip(texts, scores):
                    if t:
                        out.append((t, float(c)))
            return out

        def _from_ocr(r):
            """2.x: ocr 返回 [[ [box,(text,conf)], ... ]]"""
            out = []
            page = (r[0] if r and r[0] else []) or []
            for line in page:
                try:
                    out.append((line[1][0], float(line[1][1])))
                except (IndexError, TypeError):
                    continue
            return out

        def _fn(img):
            arr = np.array(img)
            predict_err = None
            if hasattr(eng, "predict"):
                try:
                    return _from_predict(eng.predict(arr))
                except Exception as exc:
                    # 2026-06-11 · 不再静默 · stderr 留下 predict 异常便于诊断
                    import traceback as _tb
                    predict_err = exc
                    sys.stderr.write(
                        "[ocr_image] PaddleOCR.predict() 失败 · 回退 ocr(): "
                        f"{type(exc).__name__}: {exc}\n"
                        + _tb.format_exc() + "\n"
                    )
                    sys.stderr.flush()
            try:
                return _from_ocr(eng.ocr(arr))
            except Exception as exc:
                import traceback as _tb
                sys.stderr.write(
                    "[ocr_image] PaddleOCR.ocr() 也失败:\n"
                    + _tb.format_exc()
                )
                if predict_err is not None:
                    sys.stderr.write(
                        f"\n[ocr_image] 顺带的 predict() 异常: {type(predict_err).__name__}: {predict_err}\n"
                    )
                sys.stderr.flush()
                raise
        return _fn, "PaddleOCR"
    except ImportError:
        import pytesseract

        def _fn(img):
            txt = pytesseract.image_to_string(
                img, lang="chi_sim+eng" if lang == "ch" else lang)
            return [(l.strip(), 1.0) for l in txt.splitlines() if l.strip()]
        return _fn, "Tesseract"


def _normalize_lang(lang: str) -> str:
    """企业端 / 常见别名 → PaddleOCR lang。"""
    raw = (lang or "ch").strip().lower()
    aliases = {
        "zh": "ch",
        "zh-cn": "ch",
        "chinese": "ch",
        "cn": "ch",
        "ja": "japan",
        "jp": "japan",
        "japanese": "japan",
        "ko": "korean",
        "kr": "korean",
        "hangul": "korean",
        "english": "en",
    }
    return aliases.get(raw, raw or "ch")


def main():
    t0 = time.time()
    p = _params()
    imgs = _read_images(p)
    if not imgs:
        print(json.dumps({"status": "failed", "task_type": "ocr_image",
                          "error": "无输入图片", "summary_text": "❌ 无图片"}, ensure_ascii=False))
        return 1

    try:
        from PIL import Image  # noqa
    except ImportError as exc:
        print(json.dumps({"status": "failed", "task_type": "ocr_image",
                          "error": f"节点缺 Pillow: {exc}",
                          "summary_text": "❌ pip install Pillow"}, ensure_ascii=False))
        return 1
    lang = _normalize_lang(str(p.get("lang", "ch")))
    try:
        ocr_fn, backend = _make_engine(lang)
    except ImportError:
        print(json.dumps({"status": "failed", "task_type": "ocr_image",
                          "error": "节点缺 PaddleOCR/Tesseract",
                          "summary_text": "❌ pip install paddleocr 或装 tesseract"}, ensure_ascii=False))
        return 1

    from PIL import Image
    min_conf = float(p.get("min_confidence", 0.5))
    review_th = float(p.get("review_threshold", 0.75))
    preprocess = p.get("preprocess", True)
    page_start = int(p.get("page_start", 1))
    return_lines = p.get("return_lines", False)

    pages = []
    page_texts = []   # 带【第N页】标记的合并文本
    errors = []
    grand_chars = 0
    review_pages = 0
    for idx, (fname, data) in enumerate(imgs):
        page_no = page_start + idx
        try:
            img = _preprocess(Image.open(BytesIO(data)), preprocess)
            lines = ocr_fn(img)
            kept = [(t, c) for (t, c) in lines if c >= min_conf]
            avg_conf = round(sum(c for _, c in kept) / max(1, len(kept)), 3) if kept else 0.0
            need_review = bool(kept) and avg_conf < review_th
            if need_review:
                review_pages += 1
            text = "\n".join(t for t, _ in kept)
            marker = f"【第{page_no}页:{fname}】" + ("(待核·疑似手写或模糊)" if need_review else "")
            page_texts.append(f"{marker}\n{text}")
            grand_chars += len(text)
            pg = {"page": page_no, "filename": fname, "chars": len(text),
                  "lines": len(kept), "avg_confidence": avg_conf, "need_review": need_review}
            if return_lines:
                pg["line_detail"] = [{"text": t, "confidence": round(c, 3)} for t, c in kept]
            pages.append(pg)
        except Exception as exc:
            errors.append({"page": page_no, "filename": fname, "error": str(exc)[:200]})

    if not pages:
        print(json.dumps({"status": "failed", "task_type": "ocr_image",
                          "error": "所有图片 OCR 失败", "errors": errors,
                          "summary_text": "❌ 全失败"}, ensure_ascii=False))
        return 1

    combined = "\n\n".join(page_texts)

    # 写全量文本到 EC_OUTPUT_DIR(供下游 case_digest 直接读)
    out_dir = os.environ.get("EC_OUTPUT_DIR", "")
    output_path = None
    if out_dir and os.path.isdir(out_dir):
        output_path = os.path.join(out_dir, "ocr_text.txt")
        try:
            with open(output_path, "w", encoding="utf-8") as fh:
                fh.write(combined)
        except Exception:
            output_path = None

    elapsed = int((time.time() - t0) * 1000)
    print(json.dumps({
        "status": "ok", "schema_version": "v1", "task_type": "ocr_image",
        "elapsed_ms": elapsed,
        "summary": {
            "pages": len(pages), "pages_failed": len(errors),
            "total_chars": grand_chars, "review_pages": review_pages,
            "language": lang, "backend": backend,
            "avg_confidence": round(sum(pg["avg_confidence"] for pg in pages) / max(1, len(pages)), 3),
            "output_path": output_path,
        },
        "result_text": combined,   # 带【第N页】标记 · 可直接喂 case_digest
        "pages": pages,
        "errors": errors,
        "summary_text": (
            f"✅ OCR {len(pages)} 页 · {grand_chars:,} 字 · {backend}\n"
            + (f"⚠️ {review_pages} 页待人工复核(疑似手写/模糊)\n" if review_pages else "")
            + f"⏱ {elapsed}ms"
        ),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
