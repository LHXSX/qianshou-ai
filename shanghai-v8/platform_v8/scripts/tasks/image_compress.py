#!/usr/bin/env python3
"""image_compress.py — 图片纯压缩 (企业级 · 2026-06-07 S5 升级)

不缩尺寸 · 专注压缩 · 多格式 (JPEG/WEBP/PNG) · 默认剥 EXIF。

参数 (EC_PARAMS / stdin.params):
  quality        int   1-100 (默认 85 · 企业级)
  format         str   AUTO / JPEG / WEBP / PNG (默认 AUTO · 按输入格式选择)
  progressive    bool  JPEG progressive 默认 true
  strip_exif     bool  剥相机/位置 EXIF (默认 true · 商业安全)
  png_palette    bool  PNG 转 palette 模式大幅减体积 (默认 true for PNG · 透明 PNG 慎用)
  webp_lossless  bool  WebP 无损 (默认 false · 配合 quality 用)
"""
import base64, hashlib, json, os, sys, time
from io import BytesIO


def _params():
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try: return json.loads(raw) or {}
        except Exception: pass
    return {"quality": int(os.environ.get("QUALITY", "85"))}


def _fail(msg, exc=None):
    print(json.dumps({"status":"failed","contract_version":"1","task_type":"image_compress",
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
    return stem.rsplit(".", 1)[0] if "." in stem else stem


def _processing_receipt(outputs_by_file: list[list[str]]) -> dict:
    """Bind deterministic image outputs to the server-issued shard inputs."""
    path = os.environ.get("EC_INPUT_MANIFEST", "")
    if not path:
        return {}
    try:
        manifest = json.loads(open(path, "rb").read())
        entries = manifest.get("entries")
        if not isinstance(entries, list) or len(entries) != len(outputs_by_file):
            return {}
        for entry in entries:
            entry.setdefault("object_key", "")
            entry.setdefault("fetch_ref", "")
            entry.setdefault("sha256", "")
            entry.setdefault("content_type", "application/octet-stream")
            entry.setdefault("selector", {})
        digest = hashlib.sha256(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        return {
            "schema": "processing_receipt.v1",
            "input_manifest_sha256": digest,
            "items": [{
                "input_id": str(entry["id"]),
                "status": "succeeded",
                "outputs": [{"name": name} for name in sorted(outputs)],
            } for entry, outputs in zip(entries, outputs_by_file)],
        }
    except (OSError, TypeError, ValueError, json.JSONDecodeError, KeyError):
        return {}


_IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff", ".heic")
_SKIP_NAMES = {"input_manifest.v1.json", "ec_input", "ec_params.json"}


def _looks_like_image(path: str) -> bool:
    name = os.path.basename(path).lower()
    if name in _SKIP_NAMES or name.startswith("."):
        return False
    if name.endswith(_IMG_EXTS):
        return True
    # Extensionless fallout (manifest historically named input-0): sniff magic.
    try:
        with open(path, "rb") as f:
            head = f.read(16)
    except OSError:
        return False
    if head.startswith(b"\x89PNG\r\n\x1a\n") or head.startswith(b"\xff\xd8\xff"):
        return True
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return True
    if head[:6] in (b"GIF87a", b"GIF89a") or head[:2] == b"BM":
        return True
    return False


def _selected_input_files(input_dir: str) -> tuple[list[tuple[str, str]], int]:
    paths: list[tuple[str, str]] = []
    # Prefer explicit EC_INPUT (sidecar primary) even when EC_INPUT_DIR is set.
    pin = (os.environ.get("EC_INPUT") or "").strip()
    if pin and os.path.isfile(pin) and _looks_like_image(pin):
        rel = os.path.relpath(pin, input_dir) if pin.startswith(input_dir.rstrip("/") + os.sep) or pin.startswith(input_dir.rstrip("\\") + "\\") else os.path.basename(pin)
        paths.append((rel, pin))
        return paths, 1
    for root, dirs, names in os.walk(input_dir):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(root, name)
            if os.path.isfile(path) and _looks_like_image(path):
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
    """企业级压缩 · 多格式 · EXIF 默认剥 · PNG palette · WebP method=6

    默认 format=AUTO: 按输入格式选编码器 (WEBP→WEBP / JPEG→JPEG / 其它→WEBP),
    避免把已高度压缩的 WebP 强转 JPEG q85 导致体积变大。
    若压缩结果不小于原图, 原样回传 (保证「压缩」语义不增体积)。
    """
    from PIL import Image
    img = Image.open(BytesIO(raw))
    in_w, in_h, in_fmt = img.width, img.height, (img.format or "PNG").upper()
    if in_fmt == "JPG":
        in_fmt = "JPEG"
    # 注意: 不能用 `or 85`,quality=0 会被当 None 处理
    _q_raw = p.get("quality")
    q = max(1, min(100, int(_q_raw) if _q_raw is not None else 85))
    out_fmt = (p.get("format") or "AUTO").upper()
    if out_fmt in ("JPG",):
        out_fmt = "JPEG"
    if out_fmt in ("", "AUTO", "SAME", "KEEP"):
        if in_fmt == "JPEG":
            out_fmt = "JPEG"
        elif in_fmt == "WEBP":
            out_fmt = "WEBP"
        elif in_fmt == "PNG":
            # PNG 通常很大 · 默认转 WEBP 才能真正「压缩」
            out_fmt = "WEBP"
        else:
            out_fmt = "WEBP"
    if out_fmt not in ("JPEG", "WEBP", "PNG"):
        raise ValueError(f"不支持的输出格式: {out_fmt} · 仅 JPEG/WEBP/PNG/AUTO")

    strip_exif = p.get("strip_exif", True)
    needs_rgb = out_fmt in ("JPEG",)

    # 透明合成(JPEG 不支持透明)
    work = img
    if needs_rgb and work.mode in ("RGBA", "P", "LA"):
        bg_color = p.get("background") or "#FFFFFF"
        from PIL import Image as _Im
        bg = _Im.new("RGB", work.size, bg_color)
        if work.mode == "P":
            work = work.convert("RGBA")
        bg.paste(work, mask=work.split()[-1] if work.mode in ("RGBA", "LA") else None)
        work = bg

    save_kwargs: dict = {}
    if out_fmt == "JPEG":
        save_kwargs.update({
            "quality": q,
            "optimize": True,
            "progressive": bool(p.get("progressive", True)),
        })
    elif out_fmt == "WEBP":
        save_kwargs.update({"quality": q, "method": 6})
        if p.get("webp_lossless"):
            save_kwargs["lossless"] = True
    elif out_fmt == "PNG":
        save_kwargs["optimize"] = True
        # palette 大幅减体积(< 256 色更佳)
        if p.get("png_palette", True) and work.mode != "P":
            try:
                work = work.convert("P", palette=Image.ADAPTIVE, colors=256)
            except Exception:
                pass

    # EXIF (剥默认)
    if not strip_exif and out_fmt in ("JPEG", "WEBP"):
        exif_bytes = work.info.get("exif")
        if exif_bytes:
            save_kwargs["exif"] = exif_bytes

    buf = BytesIO()
    work.save(buf, out_fmt, **save_kwargs)
    out = buf.getvalue()
    kept_original = False
    # 压缩不应放大: 结果更大则回传原文件
    if len(out) >= len(raw):
        out = raw
        out_fmt = in_fmt if in_fmt in ("JPEG", "WEBP", "PNG", "BMP", "GIF", "TIFF") else "PNG"
        kept_original = True
    compression = round(len(out) / len(raw), 3) if raw else 0.0
    ext = "jpg" if out_fmt == "JPEG" else out_fmt.lower()
    suffix = "orig" if kept_original else f"q{q}"
    out_fname = "{base}_{suffix}.{ext}".format(base=base_name, suffix=suffix, ext=ext)
    return {
        "_out_fname": out_fname,
        "_out_b64": base64.b64encode(out).decode("ascii"),
        "filename": out_fname,
        "input_size": [in_w, in_h], "output_size": [in_w, in_h],
        "input_bytes": len(raw), "output_bytes": len(out),
        "input_format": in_fmt, "output_format": out_fmt, "quality": q,
        "compression": compression,
        "kept_original": kept_original,
        "exif_stripped": strip_exif and not kept_original,
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
            "status": "ok", "contract_version": "1", "task_type": "image_compress",
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
    outputs_by_file: list[list[str]] = []
    for fname, fpath in files:
        try:
            raw = open(fpath, "rb").read()
            safe_name = fname.replace(os.sep, "__")
            base = safe_name.split("-", 1)[1] if ("-" in safe_name and safe_name.split("-", 1)[0].isdigit()) else safe_name
            base = base.rsplit(".", 1)[0] if "." in base else base
            r = _process_one(raw, p, base)
            result_images_b64[r["_out_fname"]] = r.pop("_out_b64")
            outputs_by_file.append([r["_out_fname"]])
            r.pop("_out_fname", None)
            results.append(r)
            total_in += r["input_bytes"]
            total_out += r["output_bytes"]
        except Exception as exc:
            errors.append({"filename": fname, "error": str(exc)})
            results.append({"filename": fname, "error": str(exc)})
            outputs_by_file.append([])
    elapsed_ms = int((time.time() - t0) * 1000)
    ok_n = len([r for r in results if "error" not in r])
    compression_avg = round(total_out / total_in, 3) if total_in else 0.0
    report = {
        # Automatic settlement requires every server-issued input to have a
        # bound output. Partial batches remain a failed shard until their
        # proportional-settlement contract is implemented.
        "status": "ok" if ok_n == len(files) else "failed",
        "contract_version": "1",
        "task_type": "image_compress",
        "elapsed_ms": elapsed_ms,
        "result_images_b64": result_images_b64,
        "processing_receipt": _processing_receipt(outputs_by_file) if ok_n == len(files) else {},
        "results": results,
        "errors": errors,
        "summary": {
            "total_files": len(files), "success": ok_n,
            "failed": len(files) - ok_n,
            "total_bytes_in": total_in, "total_bytes_out": total_out,
            "compression_avg": compression_avg,
        },
        "summary_text": "✓ {ok}/{tot} 张图 · q={q} · 体积比 {pct}% · {ms}ms".format(
            ok=ok_n, tot=len(files), q=int(p.get("quality") or 85),
            pct=round(compression_avg * 100, 1), ms=elapsed_ms,
        ),
    }
    print(json.dumps(report, ensure_ascii=False))
    return 0 if ok_n > 0 else 1


def main():
    t0 = time.time()
    p = _params()

    # 2026-05-23 B2 · multi_file 模式
    if os.path.isdir(os.environ.get("EC_INPUT_DIR", "")):
        return _run_multi_file(t0, p)

    try: raw = sys.stdin.buffer.read()
    except Exception as e: return _fail("stdin 读失败", e)
    if not raw: return _fail("stdin 为空")

    if raw[:1] in (b"{", b"["):
        try:
            obj = json.loads(raw.decode("utf-8"))
            if isinstance(obj, dict) and obj.get("image_b64"):
                raw = base64.b64decode(obj["image_b64"])
                if obj.get("params"): p.update(obj["params"])
        except Exception: pass

    try:
        from PIL import Image  # noqa: F401
    except ImportError: return _fail("节点缺 Pillow")

    try:
        r = _process_one(raw, p, _input_filename())
        out_fname = r.pop("_out_fname")
        out_b64 = r.pop("_out_b64")
        elapsed_ms = int((time.time() - t0) * 1000)
        report = {
            "status": "ok", "contract_version": "1", "task_type": "image_compress",
            "elapsed_ms": elapsed_ms,
            "result_images_b64": {out_fname: out_b64},
            "results": [r],
            "summary": {
                "total_files": 1, "total_bytes_in": r["input_bytes"],
                "total_bytes_out": r["output_bytes"], "compression_avg": r["compression"],
            },
            "summary_text": "✓ {iw}x{ih} {inf} → {outf} q{q} · 体积比 {pct}% · {ms}ms".format(
                iw=r["input_size"][0], ih=r["input_size"][1], inf=r["input_format"],
                outf=r["output_format"], q=r["quality"], pct=round(r["compression"] * 100, 1), ms=elapsed_ms,
            ),
        }
        print(json.dumps(report, ensure_ascii=False))
        return 0
    except Exception as e: return _fail("处理失败", e)


if __name__ == "__main__": sys.exit(main())
