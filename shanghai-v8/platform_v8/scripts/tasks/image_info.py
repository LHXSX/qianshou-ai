#!/usr/bin/env python3
"""image_info.py — 元信息提取 (无 output_b64 · manifest_only 类型)"""
import hashlib, json, os, sys, time
from io import BytesIO

_IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff", ".heic")


def _fail(msg, exc=None):
    print(json.dumps({"status":"failed","contract_version":"1","task_type":"image_info",
        "error":str(exc) if exc else msg,"summary_text":"❌ "+msg}, ensure_ascii=False))
    return 1


def _input_filename():
    ref = os.environ.get("EC_INPUT_REF", "")
    if not ref: return "image"
    stem = ref.split("?")[0].rsplit("/", 1)[-1]
    try:
        from urllib.parse import unquote
        stem = unquote(stem)
    except Exception: pass
    return stem


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


def _inspect(raw: bytes, filename: str) -> tuple[dict, dict]:
    from PIL import Image
    from PIL.ExifTags import TAGS

    img = Image.open(BytesIO(raw))
    info = {
        "filename": filename,
        "format": img.format, "mode": img.mode,
        "width": img.width, "height": img.height,
        "is_animated": getattr(img, "is_animated", False),
        "n_frames": getattr(img, "n_frames", 1),
        "has_alpha": "A" in img.mode,
        "input_bytes": len(raw),
        "sha256_input": hashlib.sha256(raw).hexdigest()[:16],
    }
    exif = {}
    try:
        raw_exif = img._getexif() or {}
        for k, v in raw_exif.items():
            key = TAGS.get(k, k)
            if isinstance(v, (str, int, float)):
                exif[str(key)] = v
    except Exception:
        pass
    info["exif"] = exif
    return info, exif


def _run_batch(t0: float, input_dir: str) -> int:
    files, discovered = _selected_input_files(input_dir)
    if discovered == 0:
        return _fail("EC_INPUT_DIR 无图片")
    results = []
    errors = []
    total_bytes = 0
    exif_count = 0
    for filename, path in files:
        try:
            raw = open(path, "rb").read()
            info, exif = _inspect(raw, filename)
            results.append(info)
            total_bytes += len(raw)
            exif_count += len(exif)
        except Exception as exc:
            errors.append({"filename": filename, "error": str(exc)})
    ok_n = len(results)
    report = {
        "status": "ok" if ok_n > 0 or not files else "failed",
        "contract_version": "1", "task_type": "image_info",
        "elapsed_ms": int((time.time() - t0) * 1000),
        "results": results, "errors": errors,
        "summary": {
            "total_files": len(files), "success": ok_n,
            "failed": len(errors), "exif_count": exif_count,
            "input_bytes": total_bytes,
        },
        "summary_text": (
            "空分片 · 无需处理" if not files
            else f"图片信息识别完成 · 成功 {ok_n}/{len(files)}"
        ),
    }
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["status"] == "ok" else 1


def main():
    t0 = time.time()
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if input_dir and os.path.isdir(input_dir):
        try:
            import PIL  # noqa: F401
        except ImportError:
            return _fail("节点缺 Pillow")
        return _run_batch(t0, input_dir)

    try: raw = sys.stdin.buffer.read()
    except Exception as e: return _fail("stdin 读失败", e)
    if not raw: return _fail("stdin 为空")

    try:
        from PIL import Image
        from PIL.ExifTags import TAGS
    except ImportError: return _fail("节点缺 Pillow")

    try:
        info, exif = _inspect(raw, _input_filename())
        elapsed_ms = int((time.time() - t0) * 1000)
        report = {
            "status": "ok", "contract_version": "1", "task_type": "image_info",
            "elapsed_ms": elapsed_ms,
            "results": [info],
            "exif": exif,
            "summary": {"total_files": 1, "exif_count": len(exif), "input_bytes": len(raw)},
            "summary_text": "✓ {fn} · {w}x{h} {f} {m} · {b} bytes · {ec} EXIF".format(
                fn=info["filename"], w=info["width"], h=info["height"],
                f=info["format"], m=info["mode"], b=len(raw), ec=len(exif),
            ),
        }
        print(json.dumps(report, ensure_ascii=False))
        return 0
    except Exception as e: return _fail("处理失败", e)


if __name__ == "__main__": sys.exit(main())
