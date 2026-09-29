#!/usr/bin/env python3
"""image_thumbnail.py — 缩略图 (企业级 · 2026-06-07 S5 升级)

电商必备:
  - **多尺寸响应式输出** (一张原图生成 [200, 400, 800] 三档缩略图)
  - **square 方形裁剪** (头像/卡片缩略图常用)
  - WebP 输出 (相比 JPEG 减体积 30%+)
  - quality / EXIF strip / background

参数 (EC_PARAMS):
  size           int        单尺寸最长边 (与 sizes 互斥 · 默认 200)
  sizes          list[int]  多尺寸响应式 · [200,400,800]
  square         bool       方形裁剪 (默认 false · 保比例)
  format         str        WEBP/JPEG/PNG (默认 WEBP · 体积小)
  quality        int        1-100 (默认 80)
  strip_exif     bool       (默认 true)
  background     str        透明合成 (默认 #FFFFFF)
  fit            str        square 时 · crop_center / fit (默认 crop_center)
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
    return {"size": int(os.environ.get("THUMB_SIZE", "200"))}


def _fail(msg, exc=None):
    print(json.dumps({
        "status": "failed", "contract_version": "1", "task_type": "image_thumbnail",
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


def _square_crop_center(img, size: int):
    """中心方形裁剪 + 缩到 size"""
    from PIL import Image
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    return img.resize((size, size), Image.LANCZOS)


def _make_thumb(img, p: dict, size: int):
    """单尺寸缩略图 · 返 (out_img, real_w, real_h)"""
    from PIL import Image
    if p.get("square"):
        # 方形裁剪
        if (p.get("fit") or "crop_center").lower() == "crop_center":
            out = _square_crop_center(img.copy(), size)
        else:
            # 等比缩到 size × size 内 + 白底填充
            base = img.copy()
            base.thumbnail((size, size), Image.LANCZOS)
            bg_color = p.get("background") or "#FFFFFF"
            out = Image.new("RGB" if base.mode != "RGBA" else "RGBA",
                            (size, size),
                            bg_color if base.mode != "RGBA" else (255, 255, 255, 0))
            offset = ((size - base.width) // 2, (size - base.height) // 2)
            if base.mode == "RGBA":
                out.paste(base, offset, base)
            else:
                out.paste(base, offset)
    else:
        out = img.copy()
        out.thumbnail((size, size), Image.LANCZOS)
    return out, out.width, out.height


def _save_thumb(img_thumb, fmt: str, quality: int, p: dict, base_name: str, size: int) -> tuple:
    """保存缩略图 · 返 (filename, bytes)"""
    from PIL import Image
    needs_rgb = fmt in ("JPEG",)
    if needs_rgb and img_thumb.mode in ("RGBA", "P", "LA"):
        bg_color = p.get("background") or "#FFFFFF"
        bg = Image.new("RGB", img_thumb.size, bg_color)
        if img_thumb.mode == "P":
            img_thumb = img_thumb.convert("RGBA")
        bg.paste(img_thumb, mask=img_thumb.split()[-1] if img_thumb.mode in ("RGBA", "LA") else None)
        img_thumb = bg

    save_kwargs: dict = {}
    if fmt == "JPEG":
        save_kwargs.update({"quality": quality, "optimize": True, "progressive": True})
    elif fmt == "WEBP":
        save_kwargs.update({"quality": quality, "method": 6})
    elif fmt == "PNG":
        save_kwargs["optimize"] = True

    if not p.get("strip_exif", True) and fmt in ("JPEG", "WEBP"):
        exif = img_thumb.info.get("exif")
        if exif:
            save_kwargs["exif"] = exif

    buf = BytesIO()
    img_thumb.save(buf, fmt, **save_kwargs)
    ext = "jpg" if fmt == "JPEG" else fmt.lower()
    sq = "_sq" if p.get("square") else ""
    out_fname = "{base}_thumb{sq}_{s}.{ext}".format(base=base_name, sq=sq, s=size, ext=ext)
    return out_fname, buf.getvalue()


def _process_one(raw: bytes, p: dict, base_name: str) -> dict:
    """单文件 · 支持多尺寸响应式输出"""
    from PIL import Image
    img = Image.open(BytesIO(raw))
    in_w, in_h, in_fmt = img.width, img.height, img.format or "PNG"

    # 多尺寸 vs 单尺寸
    sizes = p.get("sizes")
    if sizes and isinstance(sizes, list):
        try:
            sizes = sorted(set(int(s) for s in sizes if int(s) > 0))[:8]  # 最多 8 档
        except (ValueError, TypeError):
            sizes = [int(p.get("size") or 200)]
    else:
        sizes = [int(p.get("size") or 200)]

    fmt = (p.get("format") or "WEBP").upper()  # 默认 WebP · 体积小
    if fmt == "JPG":
        fmt = "JPEG"
    if fmt not in ("JPEG", "PNG", "WEBP"):
        fmt = "WEBP"
    quality = max(1, min(100, int(p.get("quality") or 80)))

    thumbs: list = []
    total_out = 0
    for size in sizes:
        thumb_img, real_w, real_h = _make_thumb(img, p, size)
        out_fname, out_bytes = _save_thumb(thumb_img, fmt, quality, p, base_name, size)
        thumbs.append({
            "filename": out_fname,
            "size_target": size,
            "size_real": [real_w, real_h],
            "bytes": len(out_bytes),
            "_bytes_raw": out_bytes,
        })
        total_out += len(out_bytes)

    return {
        "_thumbs": thumbs,
        "filename": base_name,
        "input_size": [in_w, in_h],
        "input_bytes": len(raw),
        "input_format": in_fmt,
        "output_format": fmt,
        "square": bool(p.get("square")),
        "quality": quality,
        "total_output_bytes": total_out,
        "thumbnail_count": len(thumbs),
        "sha256_input": hashlib.sha256(raw).hexdigest()[:16],
    }


def _run_multi_file(t0: float, p: dict) -> int:
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if not input_dir or not os.path.isdir(input_dir):
        return _fail("multi_file 模式但 EC_INPUT_DIR 不存在")
    try:
        from PIL import Image  # noqa
    except ImportError:
        return _fail("节点缺 Pillow")
    files, discovered = _selected_input_files(input_dir)
    if discovered == 0:
        return _fail("EC_INPUT_DIR 无图片")
    if not files:
        print(json.dumps({
            "status": "ok", "contract_version": "1", "task_type": "image_thumbnail",
            "elapsed_ms": int((time.time() - t0) * 1000),
            "result_images_b64": {}, "results": [], "errors": [],
            "summary": {"total_files": 0, "success": 0, "failed": 0,
                        "total_thumbnails": 0, "total_bytes_in": 0,
                        "total_bytes_out": 0},
            "summary_text": "空分片 · 无需处理",
        }, ensure_ascii=False))
        return 0

    result_images_b64: dict = {}
    results: list = []
    errors: list = []
    total_in = 0
    total_out = 0
    total_thumbs = 0
    for fname, fpath in files:
        try:
            raw = open(fpath, "rb").read()
            safe_name = fname.replace(os.sep, "__")
            base = safe_name.split("-", 1)[1] if ("-" in safe_name and safe_name.split("-", 1)[0].isdigit()) else safe_name
            base = base.rsplit(".", 1)[0] if "." in base else base
            r = _process_one(raw, p, base)
            for thumb in r["_thumbs"]:
                result_images_b64[thumb["filename"]] = base64.b64encode(thumb.pop("_bytes_raw")).decode("ascii")
            thumbs_meta = r.pop("_thumbs")
            r["thumbnails"] = thumbs_meta
            results.append(r)
            total_in += r["input_bytes"]
            total_out += r["total_output_bytes"]
            total_thumbs += r["thumbnail_count"]
        except Exception as exc:
            errors.append({"filename": fname, "error": str(exc)})
            results.append({"filename": fname, "error": str(exc)})

    elapsed_ms = int((time.time() - t0) * 1000)
    ok_n = len([r for r in results if "error" not in r])
    print(json.dumps({
        "status": "ok" if ok_n > 0 else "failed",
        "contract_version": "1", "task_type": "image_thumbnail",
        "elapsed_ms": elapsed_ms,
        "result_images_b64": result_images_b64,
        "results": results, "errors": errors,
        "summary": {
            "total_files": len(files), "success": ok_n,
            "failed": len(files) - ok_n,
            "total_thumbnails": total_thumbs,
            "total_bytes_in": total_in, "total_bytes_out": total_out,
        },
        "summary_text": "✓ {ok}/{tot} 张图 → {th} 缩略图 · {ms}ms".format(
            ok=ok_n, tot=len(files), th=total_thumbs, ms=elapsed_ms,
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
        from PIL import Image  # noqa
    except ImportError:
        return _fail("节点缺 Pillow")

    try:
        r = _process_one(raw, p, _input_filename())
        result_images_b64: dict = {}
        for thumb in r["_thumbs"]:
            result_images_b64[thumb["filename"]] = base64.b64encode(thumb.pop("_bytes_raw")).decode("ascii")
        thumbs_meta = r.pop("_thumbs")
        r["thumbnails"] = thumbs_meta

        elapsed_ms = int((time.time() - t0) * 1000)
        sizes_str = ",".join(str(t["size_target"]) for t in thumbs_meta)
        print(json.dumps({
            "status": "ok", "contract_version": "1", "task_type": "image_thumbnail",
            "elapsed_ms": elapsed_ms,
            "result_images_b64": result_images_b64,
            "results": [r],
            "summary": {
                "total_files": 1,
                "total_thumbnails": r["thumbnail_count"],
                "total_bytes_in": r["input_bytes"],
                "total_bytes_out": r["total_output_bytes"],
            },
            "summary_text": "✓ {iw}x{ih} → {n} 缩略图 [{s}] · {ms}ms".format(
                iw=r["input_size"][0], ih=r["input_size"][1],
                n=r["thumbnail_count"], s=sizes_str, ms=elapsed_ms,
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        return _fail("处理失败", e)


if __name__ == "__main__":
    sys.exit(main())
