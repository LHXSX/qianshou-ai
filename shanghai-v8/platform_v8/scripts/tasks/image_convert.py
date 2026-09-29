#!/usr/bin/env python3
"""image_convert.py — 格式转换 (企业级 · 2026-06-07 S5 升级)

支持:
  - multi_file 批量
  - 多目标格式 JPEG/PNG/WEBP/AVIF
  - quality 参数 · EXIF strip (默认 · 商业安全)
  - 透明 PNG → JPEG 时 background 色合成
  - JPEG progressive · PNG palette · WebP method=6

参数 (EC_PARAMS):
  format         str   目标格式 (默认 PNG)
  quality        int   1-100 (JPEG/WEBP · 默认 85)
  strip_exif     bool  默认 true
  background     str   透明合成色 (默认 #FFFFFF)
  progressive    bool  JPEG progressive (默认 true)
  png_palette    bool  PNG palette 减体积 (默认 false · 转换场景一般不损质)
  webp_lossless  bool  WebP 无损 (默认 false)
"""
import base64
import hashlib
import json
import os
import sys
import time
from io import BytesIO


def _params():
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {"format": os.environ.get("FORMAT", "PNG")}


def _fail(msg, exc=None):
    print(json.dumps({
        "status": "failed", "contract_version": "1", "task_type": "image_convert",
        "error": str(exc) if exc else msg, "summary_text": "❌ " + msg,
    }, ensure_ascii=False))
    return 1


def _input_filename():
    ref = os.environ.get("EC_INPUT_REF", "")
    if not ref:
        return "image"
    stem = ref.split("?")[0].rsplit("/", 1)[-1]
    try:
        from urllib.parse import unquote
        stem = unquote(stem)
    except Exception:
        pass
    return stem.rsplit(".", 1)[0] if "." in stem else stem


_IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff", ".heic")
_ALLOWED_FMT = {"JPEG", "PNG", "WEBP", "AVIF", "BMP", "TIFF"}


def _selected_input_files(input_dir: str) -> tuple[list[tuple[str, str]], int]:
    paths: list[tuple[str, str]] = []
    for root, dirs, names in os.walk(input_dir):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(root, name)
            if name.lower().endswith(_IMG_EXTS) and os.path.isfile(path):
                paths.append((os.path.relpath(path, input_dir), path))
    selected = paths
    try:
        meta = json.loads(os.environ.get("EC_SLICE_META", "") or "{}")
        if "file_idx_start" in meta:
            start = max(0, min(len(paths), int(meta["file_idx_start"])))
            end = max(start, min(len(paths), int(meta["file_idx_end"])))
            selected = paths[start:end]
        elif "file_idx_pct_start" in meta:
            start = max(0, min(len(paths), int(len(paths) * float(meta["file_idx_pct_start"]))))
            pct_end = float(meta.get("file_idx_pct_end", 1.0))
            end = len(paths) if pct_end >= 1 else int(len(paths) * pct_end)
            selected = paths[start:max(start, min(len(paths), end))]
    except (TypeError, ValueError, json.JSONDecodeError):
        selected = paths
    return selected, len(paths)


def _process_one(raw: bytes, p: dict, base_name: str) -> dict:
    """单文件转换 · 企业级配置"""
    from PIL import Image
    img = Image.open(BytesIO(raw))
    in_w, in_h, in_fmt = img.width, img.height, img.format or "PNG"

    fmt = (p.get("format") or "PNG").upper()
    if fmt == "JPG":
        fmt = "JPEG"
    if fmt not in _ALLOWED_FMT:
        raise ValueError(f"不支持的输出格式: {fmt} · 仅 {sorted(_ALLOWED_FMT)}")

    # 透明合成 (转 JPEG/BMP 时需要)
    needs_rgb = fmt in ("JPEG", "BMP")
    if needs_rgb and img.mode in ("RGBA", "P", "LA"):
        bg_color = p.get("background") or "#FFFFFF"
        from PIL import Image as _Im
        bg = _Im.new("RGB", img.size, bg_color)
        if img.mode == "P":
            img = img.convert("RGBA")
        bg.paste(img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None)
        img = bg

    # 保存选项
    quality = max(1, min(100, int(p.get("quality") or 85)))
    save_kwargs: dict = {}
    if fmt == "JPEG":
        save_kwargs.update({
            "quality": quality,
            "optimize": True,
            "progressive": bool(p.get("progressive", True)),
        })
    elif fmt == "WEBP":
        save_kwargs.update({"quality": quality, "method": 6})
        if p.get("webp_lossless"):
            save_kwargs["lossless"] = True
    elif fmt == "PNG":
        save_kwargs["optimize"] = True
        if p.get("png_palette", False) and img.mode != "P":
            try:
                img = img.convert("P", palette=Image.ADAPTIVE, colors=256)
            except Exception:
                pass

    # EXIF
    strip_exif = p.get("strip_exif", True)
    if not strip_exif and fmt in ("JPEG", "WEBP"):
        exif_bytes = img.info.get("exif")
        if exif_bytes:
            save_kwargs["exif"] = exif_bytes

    buf = BytesIO()
    img.save(buf, fmt, **save_kwargs)
    out = buf.getvalue()
    ext = "jpg" if fmt == "JPEG" else fmt.lower()
    out_fname = "{base}.{ext}".format(base=base_name, ext=ext)
    return {
        "_out_fname": out_fname,
        "_out_b64": base64.b64encode(out).decode("ascii"),
        "filename": out_fname,
        "input_size": [in_w, in_h], "output_size": [in_w, in_h],
        "input_bytes": len(raw), "output_bytes": len(out),
        "input_format": in_fmt, "output_format": fmt,
        "quality": quality if fmt in ("JPEG", "WEBP") else None,
        "exif_stripped": strip_exif,
        "compression": round(len(out) / len(raw), 3) if raw else 0.0,
        "sha256_input": hashlib.sha256(raw).hexdigest()[:16],
        "sha256_output": hashlib.sha256(out).hexdigest()[:16],
    }


def _run_multi_file(t0: float, p: dict) -> int:
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if not input_dir or not os.path.isdir(input_dir):
        return _fail("multi_file 模式但 EC_INPUT_DIR 不存在")
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        return _fail("节点缺 Pillow")
    files, discovered = _selected_input_files(input_dir)
    if discovered == 0:
        return _fail("EC_INPUT_DIR 无图片")
    if not files:
        print(json.dumps({
            "status": "ok", "contract_version": "1", "task_type": "image_convert",
            "elapsed_ms": int((time.time() - t0) * 1000),
            "result_images_b64": {}, "results": [], "errors": [],
            "summary": {"total_files": 0, "success": 0, "failed": 0,
                        "total_bytes_in": 0, "total_bytes_out": 0},
            "summary_text": "空分片 · 无需处理",
        }, ensure_ascii=False))
        return 0

    result_images_b64: dict = {}
    results: list = []
    errors: list = []
    total_in = 0
    total_out = 0
    for fname, fpath in files:
        try:
            raw = open(fpath, "rb").read()
            safe_name = fname.replace(os.sep, "__")
            base = safe_name.split("-", 1)[1] if ("-" in safe_name and safe_name.split("-", 1)[0].isdigit()) else safe_name
            base = base.rsplit(".", 1)[0] if "." in base else base
            r = _process_one(raw, p, base)
            result_images_b64[r["_out_fname"]] = r.pop("_out_b64")
            r.pop("_out_fname", None)
            results.append(r)
            total_in += r["input_bytes"]
            total_out += r["output_bytes"]
        except Exception as exc:
            errors.append({"filename": fname, "error": str(exc)})
            results.append({"filename": fname, "error": str(exc)})

    elapsed_ms = int((time.time() - t0) * 1000)
    ok_n = len([r for r in results if "error" not in r])
    fmt = (p.get("format") or "PNG").upper()
    if fmt == "JPG":
        fmt = "JPEG"
    print(json.dumps({
        "status": "ok" if ok_n > 0 else "failed",
        "contract_version": "1", "task_type": "image_convert",
        "elapsed_ms": elapsed_ms,
        "result_images_b64": result_images_b64,
        "results": results, "errors": errors,
        "summary": {
            "total_files": len(files), "success": ok_n,
            "failed": len(files) - ok_n,
            "total_bytes_in": total_in, "total_bytes_out": total_out,
        },
        "summary_text": "✓ {ok}/{tot} → {fmt} · {ms}ms".format(
            ok=ok_n, tot=len(files), fmt=fmt, ms=elapsed_ms,
        ),
    }, ensure_ascii=False))
    return 0 if ok_n > 0 else 1


def main():
    t0 = time.time()
    p = _params()
    if os.path.isdir(os.environ.get("EC_INPUT_DIR", "")):
        return _run_multi_file(t0, p)

    try:
        raw = sys.stdin.buffer.read()
    except Exception as e:
        return _fail("stdin 读失败", e)
    if not raw:
        return _fail("stdin 为空")

    if raw[:1] in (b"{", b"["):
        try:
            obj = json.loads(raw.decode("utf-8"))
            if isinstance(obj, dict) and obj.get("image_b64"):
                raw = base64.b64decode(obj["image_b64"])
                if obj.get("params"):
                    p.update(obj["params"])
        except Exception:
            pass

    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        return _fail("节点缺 Pillow")

    try:
        r = _process_one(raw, p, _input_filename())
        out_fname = r.pop("_out_fname")
        out_b64 = r.pop("_out_b64")
        elapsed_ms = int((time.time() - t0) * 1000)
        print(json.dumps({
            "status": "ok", "contract_version": "1", "task_type": "image_convert",
            "elapsed_ms": elapsed_ms,
            "result_images_b64": {out_fname: out_b64},
            "results": [r],
            "summary": {
                "total_files": 1, "total_bytes_in": r["input_bytes"],
                "total_bytes_out": r["output_bytes"],
                "compression_avg": r["compression"],
            },
            "summary_text": "✓ {iw}x{ih} {inf} → {of} · {ms}ms".format(
                iw=r["input_size"][0], ih=r["input_size"][1],
                inf=r["input_format"], of=r["output_format"], ms=elapsed_ms,
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        return _fail("处理失败", e)


if __name__ == "__main__":
    sys.exit(main())
