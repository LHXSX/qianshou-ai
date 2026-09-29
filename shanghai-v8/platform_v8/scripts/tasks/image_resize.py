#!/usr/bin/env python3
"""
image_resize.py — 图片缩放 (企业级 · 2026-06-07 S5 升级)

输入 (stdin · binary):
  PNG / JPG / WEBP 等 PIL 支持的图片字节流
  ── 或 JSON: {"image_b64":"...", "params":{"width":800,"height":600}}

参数 (EC_PARAMS / stdin.params):
  width            int     目标宽度(必填或与 height 至少一个)
  height           int     目标高度(0 = 按比例)
  format           str     输出格式: JPEG/PNG/WEBP/AVIF(空 = 保持原格式)
  quality          int     1-100 · JPEG/WEBP 质量(默认 85 · 企业级)
  fit              str     裁剪方式 · contain / cover / fill (默认 contain)
  keep_aspect      bool    是否保持长宽比(默认 true · 与 fit 共存)
  strip_exif       bool    清除 EXIF/相机/位置信息(默认 true · 商业默认安全)
  keep_metadata    bool    保留元数据(覆盖 strip_exif · 默认 false)
  watermark_text   str     文字水印内容(空 = 不加 · 支持中文)
  watermark_pos    str     水印位置 · bottom_right / bottom_left / center 等 (默认 bottom_right)
  watermark_opacity float  水印透明度 0-1 (默认 0.4)
  background       str     透明 PNG 转 JPEG 时的背景色 (默认 #FFFFFF)
  progressive      bool    JPEG progressive 编码 (默认 true · 网页加载更快)

输出 (stdout · JSON · 对齐 zip_files 聚合器契约):
  {
    "status": "ok",
    "contract_version": "1",
    "task_type": "image_resize",
    "elapsed_ms": int,
    "result_images_b64": {              ← zip_files 聚合器解这个字段
      "<filename>": "<base64>"
    },
    "results": [{...每个文件元数据...}],
    "summary": {...合并后数字...},
    "summary_text": "✓ 1920x1080 PNG → 800x450 PNG · 减小 75%"
  }
"""
import base64
import hashlib
import json
import os
import sys
import time
from io import BytesIO
from typing import Optional


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {
        "width": int(os.environ.get("WIDTH", "800")),
        "height": int(os.environ.get("HEIGHT", "0")) or None,
        "format": os.environ.get("FORMAT", ""),
    }


def _fail(msg, exc=None):
    out = {
        "status": "failed",
        "contract_version": "1",
        "task_type": "image_resize",
        "error": str(exc) if exc else msg,
        "summary_text": "❌ " + msg,
    }
    print(json.dumps(out, ensure_ascii=False))
    return 1


def _input_filename() -> str:
    """从 EC_INPUT_REF (OSS URL) 取末段当原始文件名 · URL decode"""
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


def _compute_target_size(in_w: int, in_h: int, p: dict) -> tuple[int, int]:
    """根据 width/height/fit 计算最终尺寸"""
    target_w = int(p.get("width") or 0)
    target_h = int(p.get("height") or 0)
    keep_aspect = p.get("keep_aspect", True)
    fit = (p.get("fit") or "contain").lower()

    if not target_w and not target_h:
        return in_w, in_h  # 没设尺寸 = 不缩放

    if target_w and target_h and not keep_aspect:
        return target_w, target_h  # fill 模式

    # 至少一个尺寸 + 保持长宽比
    if target_w and target_h:
        ratio_w = target_w / in_w
        ratio_h = target_h / in_h
        if fit == "cover":
            ratio = max(ratio_w, ratio_h)  # 填满,可能溢出(需后续裁剪)
        else:  # contain (默认)
            ratio = min(ratio_w, ratio_h)
        return max(1, int(in_w * ratio)), max(1, int(in_h * ratio))
    if target_w:
        ratio = target_w / in_w
        return target_w, max(1, int(in_h * ratio))
    # only target_h
    ratio = target_h / in_h
    return max(1, int(in_w * ratio)), target_h


def _apply_watermark(img, p: dict):
    """企业级水印 · 文字 RGBA · 抗锯齿 · 多位置"""
    text = (p.get("watermark_text") or "").strip()
    if not text:
        return img
    from PIL import Image, ImageDraw, ImageFont
    opacity = max(0.0, min(1.0, float(p.get("watermark_opacity", 0.4))))
    pos = (p.get("watermark_pos") or "bottom_right").lower()

    # 保证 RGBA 才能合成透明文字
    base = img.convert("RGBA") if img.mode != "RGBA" else img.copy()
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # 字号: 短边的 4%(在 12-72 之间)
    font_size = max(12, min(72, int(min(base.size) * 0.04)))
    font = None
    for font_path in (
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "C:\\Windows\\Fonts\\msyh.ttc",
        "C:\\Windows\\Fonts\\simhei.ttf",
    ):
        try:
            font = ImageFont.truetype(font_path, font_size)
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()

    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    except Exception:
        tw, th = font_size * len(text), font_size

    margin = max(8, font_size // 2)
    if pos == "top_left":
        x, y = margin, margin
    elif pos == "top_right":
        x, y = base.size[0] - tw - margin, margin
    elif pos == "bottom_left":
        x, y = margin, base.size[1] - th - margin
    elif pos == "center":
        x, y = (base.size[0] - tw) // 2, (base.size[1] - th) // 2
    else:  # bottom_right(默认)
        x, y = base.size[0] - tw - margin, base.size[1] - th - margin

    alpha = int(255 * opacity)
    # 双层(描边 + 主字)增强可读性
    draw.text((x + 1, y + 1), text, font=font, fill=(0, 0, 0, alpha))
    draw.text((x, y), text, font=font, fill=(255, 255, 255, alpha))
    return Image.alpha_composite(base, overlay)


def _process_one(raw: bytes, p: dict, base_name: str) -> dict:
    """处理单张图 · 企业级:水印 + EXIF 清理 + quality + fit + 多格式
    
    raise 给上层 catch · 让 multi_file 模式可以记 per-file error 而不中断整批
    """
    from PIL import Image

    img = Image.open(BytesIO(raw))
    in_w, in_h = img.width, img.height
    in_fmt = img.format or "PNG"

    new_w, new_h = _compute_target_size(in_w, in_h, p)
    if (new_w, new_h) != (in_w, in_h):
        out_img = img.resize((new_w, new_h), Image.LANCZOS)
    else:
        out_img = img

    # 输出格式 + 模式转换 (RGBA → RGB 用 background)
    out_fmt = (p.get("format") or in_fmt).upper()
    if out_fmt == "JPG":
        out_fmt = "JPEG"
    needs_rgb = out_fmt in ("JPEG", "BMP")
    if needs_rgb and out_img.mode in ("RGBA", "P", "LA"):
        bg_color = p.get("background") or "#FFFFFF"
        from PIL import Image as _Im
        bg = _Im.new("RGB", out_img.size, bg_color)
        if out_img.mode == "P":
            out_img = out_img.convert("RGBA")
        bg.paste(out_img, mask=out_img.split()[-1] if out_img.mode in ("RGBA", "LA") else None)
        out_img = bg

    # 水印
    if p.get("watermark_text"):
        out_img = _apply_watermark(out_img, p)
        if needs_rgb and out_img.mode == "RGBA":
            from PIL import Image as _Im
            bg_color = p.get("background") or "#FFFFFF"
            bg = _Im.new("RGB", out_img.size, bg_color)
            bg.paste(out_img, mask=out_img.split()[3])
            out_img = bg

    # 保存选项 (企业级 quality + EXIF 控制)
    save_kwargs: dict = {}
    quality = int(p.get("quality") or 85)
    quality = max(1, min(100, quality))
    if out_fmt in ("JPEG", "WEBP"):
        save_kwargs["quality"] = quality
    if out_fmt == "JPEG":
        save_kwargs["progressive"] = bool(p.get("progressive", True))
        save_kwargs["optimize"] = True
    if out_fmt == "WEBP":
        save_kwargs["method"] = 6  # 最高压缩(慢但小)
    if out_fmt == "PNG":
        save_kwargs["optimize"] = True

    # EXIF 处理 (默认 strip · 商业安全)
    strip_exif = p.get("strip_exif", True)
    keep_metadata = p.get("keep_metadata", False)
    if keep_metadata and not strip_exif:
        # 保留 EXIF (含相机/地理位置 · 商业一般不要)
        try:
            exif = img.info.get("exif")
            if exif and out_fmt in ("JPEG", "WEBP"):
                save_kwargs["exif"] = exif
        except Exception:
            pass
    # strip_exif=True 时 · 不传 exif 参数即等于清除

    buf = BytesIO()
    out_img.save(buf, format=out_fmt, **save_kwargs)
    out_bytes = buf.getvalue()

    sha_in = hashlib.sha256(raw).hexdigest()[:16]
    sha_out = hashlib.sha256(out_bytes).hexdigest()[:16]
    compression = round(len(out_bytes) / len(raw), 3) if raw else 0.0

    ext = "jpg" if out_fmt == "JPEG" else out_fmt.lower()
    out_fname = "{base}_resized_{w}x{h}.{ext}".format(
        base=base_name, w=new_w, h=new_h, ext=ext,
    )
    return {
        "_out_fname": out_fname,
        "_out_b64": base64.b64encode(out_bytes).decode("ascii"),
        "filename": out_fname,
        "input_size": [in_w, in_h],
        "output_size": [new_w, new_h],
        "input_bytes": len(raw),
        "output_bytes": len(out_bytes),
        "input_format": in_fmt,
        "output_format": out_fmt,
        "compression": compression,
        "quality": quality if out_fmt in ("JPEG", "WEBP") else None,
        "watermarked": bool(p.get("watermark_text")),
        "exif_stripped": strip_exif and not keep_metadata,
        "sha256_input": sha_in,
        "sha256_output": sha_out,
    }


def _run_multi_file(t0: float, p: dict) -> int:
    """multi_file 模式 · 从 EC_INPUT_DIR 读 N 张图"""
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if not input_dir or not os.path.isdir(input_dir):
        return _fail("multi_file 模式但 EC_INPUT_DIR 不存在或不是目录")

    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        return _fail("节点缺 Pillow · pip install Pillow")

    files, discovered = _selected_input_files(input_dir)
    if discovered == 0:
        return _fail("EC_INPUT_DIR 无图片文件 · 支持扩展名 " + ",".join(_IMG_EXTS))
    if not files:
        print(json.dumps({
            "status": "ok", "contract_version": "1", "task_type": "image_resize",
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
            # base_name 用 executor 加的 "NNN-原文件名" 中的 "原文件名" · 去扩展名
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
    compression_avg = round(total_out / total_in, 3) if total_in else 0.0
    report = {
        "status": "ok" if ok_n > 0 else "failed",
        "contract_version": "1",
        "task_type": "image_resize",
        "elapsed_ms": elapsed_ms,
        "result_images_b64": result_images_b64,
        "results": results,
        "errors": errors,
        "summary": {
            "total_files": len(files),
            "success": ok_n,
            "failed": len(files) - ok_n,
            "total_bytes_in": total_in,
            "total_bytes_out": total_out,
            "compression_avg": compression_avg,
        },
        "summary_text": "✓ {ok}/{tot} 张图 · {ms}ms · 平均压缩率 {pct}%".format(
            ok=ok_n, tot=len(files), ms=elapsed_ms,
            pct=round((1 - compression_avg) * 100, 1),
        ),
    }
    print(json.dumps(report, ensure_ascii=False))
    return 0 if ok_n > 0 else 1


def _sniff_non_image(raw: bytes):
    """识别常见非图片魔数 · 给用户可读错误 (避免只报 cannot identify)。"""
    if len(raw) >= 12 and raw[4:8] == b"ftyp":
        return "输入是视频/容器文件 (MP4/MOV 等) · 图片改尺寸请上传 JPG/PNG/WEBP"
    if raw[:4] == b"RIFF" and len(raw) >= 12 and raw[8:12] != b"WEBP":
        return "输入是 RIFF 非 WebP (可能是 AVI/WAV) · 请上传图片"
    if raw[:3] == b"ID3" or raw[:2] == b"\xff\xfb":
        return "输入像是音频文件 · 请上传图片"
    if raw.lstrip()[:1] in (b"{", b"<"):
        return "输入像是 JSON/HTML 文本 · 不是图片字节 (下载可能失败)"
    return None


def main():
    t0 = time.time()
    p = _params()

    # 2026-05-23 P0-B1 · multi_file 模式 · 从 EC_INPUT_DIR 读 N 张图
    if os.path.isdir(os.environ.get("EC_INPUT_DIR", "")):
        return _run_multi_file(t0, p)

    # single_file / inline · 原 stdin 流程
    try:
        raw = sys.stdin.buffer.read()
    except Exception as exc:
        return _fail("stdin 读失败", exc)
    if not raw:
        return _fail("stdin 为空 · 节点未传图片数据")

    sniff = _sniff_non_image(raw)
    if sniff:
        return _fail(sniff)

    # 兼容 JSON 包装 {image_b64, params}
    if raw[:1] in (b"{", b"["):
        try:
            obj = json.loads(raw.decode("utf-8"))
            if isinstance(obj, dict) and obj.get("image_b64"):
                raw = base64.b64decode(obj["image_b64"])
                if obj.get("params"):
                    p.update(obj["params"])
                sniff = _sniff_non_image(raw)
                if sniff:
                    return _fail(sniff)
        except Exception:
            pass

    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        return _fail("节点缺 Pillow · pip install Pillow")

    try:
        r = _process_one(raw, p, _input_filename())
        out_fname = r.pop("_out_fname")
        out_b64 = r.pop("_out_b64")
        elapsed_ms = int((time.time() - t0) * 1000)
        reduce_pct = round((1 - r["compression"]) * 100, 1)
        report = {
            "status": "ok",
            "contract_version": "1",
            "task_type": "image_resize",
            "elapsed_ms": elapsed_ms,
            "result_images_b64": {out_fname: out_b64},
            "results": [r],
            "summary": {
                "total_files": 1,
                "total_bytes_in": r["input_bytes"],
                "total_bytes_out": r["output_bytes"],
                "compression_avg": r["compression"],
            },
            "summary_text": "✓ {iw}x{ih} {inf} → {ow}x{oh} {of} · {dir_} {pct}% · {ms}ms".format(
                iw=r["input_size"][0], ih=r["input_size"][1], inf=r["input_format"],
                ow=r["output_size"][0], oh=r["output_size"][1], of=r["output_format"],
                dir_="减小" if reduce_pct > 0 else "增大",
                pct=abs(reduce_pct), ms=elapsed_ms,
            ),
        }
        print(json.dumps(report, ensure_ascii=False))
        return 0

    except Exception as exc:
        msg = str(exc)
        if "cannot identify" in msg.lower():
            return _fail(
                "无法识别为图片 · 请上传 JPG/PNG/WEBP 等 "
                f"(当前: {_input_filename()})",
                exc,
            )
        return _fail("处理失败", exc)


if __name__ == "__main__":
    sys.exit(main())
