#!/usr/bin/env python3
"""video_thumbnail — 视频抽帧缩略图 (企业级 · 2026-06-07 S5 升级)

模式:
  single    单帧 at_second
  grid      9 宫格预览 (3x3 时间均匀采样)
  list      自定义时间点 at_seconds=[1,5,10]
  evenly    时间均匀采样 n 张 (count=5 = 0%/25%/50%/75%/100%)

参数 (EC_PARAMS):
  mode           str        single / grid / list / evenly (默认 single)
  at_second      float      single 模式时间 (默认 1.0)
  at_seconds     list[float] list 模式时间点
  count          int        evenly / grid 模式张数 (默认 9 grid · 5 evenly)
  width          int        每帧宽度 (默认 320)
  format         str        JPEG / WEBP (默认 WEBP · 体积更小)
  quality        int        1-100 (默认 80)
  grid_cols      int        grid 模式列数 (默认 3 · cols=3 rows=3 = 9 宫格)
  timeout_s      int        ffmpeg 单次超时 (默认 60)
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time


_VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".avi", ".flv", ".webm", ".ts", ".m4v")


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _selected_input_files(input_dir: str) -> tuple[list[tuple[str, str]], int]:
    paths: list[tuple[str, str]] = []
    for root, dirs, names in os.walk(input_dir):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(root, name)
            if name.lower().endswith(_VIDEO_EXTS) and os.path.isfile(path):
                paths.append((os.path.relpath(path, input_dir), path))
    selected = paths
    try:
        meta = json.loads(os.environ.get("EC_SLICE_META", "") or "{}")
        if isinstance(meta.get("file_indices"), list):
            idxs = [int(i) for i in meta["file_indices"]]
            selected = [paths[i] for i in idxs if 0 <= i < len(paths)]
        elif "file_idx_start" in meta:
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


def _fail(msg: str, exc=None, hint: str = ""):
    out = {
        "status": "failed", "task_type": "video_thumbnail",
        "error": str(exc) if exc else msg,
        "summary_text": "❌ " + msg,
    }
    if hint:
        out["hint"] = hint
    print(json.dumps(out, ensure_ascii=False))
    return 1


def _ffmpeg_bin() -> str:
    """优先 EC_FFMPEG · EC_TIER_BINARIES_JSON · PATH · imageio_ffmpeg 包内二进制。"""
    env = (os.environ.get("EC_FFMPEG") or "").strip()
    if env and os.path.isfile(env) and os.access(env, os.X_OK):
        return env
    raw = (os.environ.get("EC_TIER_BINARIES_JSON") or "").strip()
    if raw:
        try:
            m = json.loads(raw)
            p = (m.get("ffmpeg") or "").strip()
            if p and os.path.isfile(p) and os.access(p, os.X_OK):
                return p
        except Exception:
            pass
    which = shutil.which("ffmpeg")
    if which:
        return which
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    except Exception:
        pass
    raise FileNotFoundError(
        "节点缺 ffmpeg · 请安装 ffmpeg tier (imageio-ffmpeg) 或系统 ffmpeg"
    )


def _ffprobe_bin():
    """与 ffmpeg 同目录的 ffprobe · 或 PATH。找不到则 None（时长回退 0）。"""
    raw = (os.environ.get("EC_TIER_BINARIES_JSON") or "").strip()
    if raw:
        try:
            m = json.loads(raw)
            p = (m.get("ffprobe") or "").strip()
            if p and os.path.isfile(p) and os.access(p, os.X_OK):
                return p
        except Exception:
            pass
    which = shutil.which("ffprobe")
    if which:
        return which
    try:
        ff = _ffmpeg_bin()
        sibling = os.path.join(os.path.dirname(ff), "ffprobe")
        if os.path.isfile(sibling) and os.access(sibling, os.X_OK):
            return sibling
    except Exception:
        pass
    return None


def _get_duration(video_path: str, timeout: int = 8) -> float:
    """用 ffprobe 取视频时长(秒)· 失败返 0"""
    fp = _ffprobe_bin()
    if not fp:
        return 0.0
    try:
        r = subprocess.run(
            [fp, "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", video_path],
            capture_output=True, text=True, timeout=timeout,
        )
        return float((r.stdout or "0").strip() or 0)
    except Exception:
        return 0.0


def _extract_frame(video_path: str, at_sec: float, width: int, fmt: str,
                   quality: int, timeout: int) -> bytes:
    """单帧抽取 · 返图片 bytes"""
    ffmpeg = _ffmpeg_bin()
    suffix = ".webp" if fmt == "WEBP" else ".jpg"
    out_path = tempfile.mktemp(suffix=suffix)
    cmd = [
        ffmpeg, "-hide_banner", "-y",
        "-ss", str(max(0, at_sec)),
        "-i", video_path,
        "-vframes", "1",
        "-vf", f"scale={width}:-2",
    ]
    if fmt == "JPEG":
        cmd += ["-q:v", str(max(2, 32 - int(quality / 4)))]  # ffmpeg q 越小越好
    else:  # WEBP
        cmd += ["-c:v", "libwebp", "-quality", str(quality)]
    cmd.append(out_path)
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"抽帧超时 ({timeout}s @ {at_sec}s)")
    if r.returncode != 0 or not os.path.exists(out_path):
        stderr = (r.stderr or b"").decode("utf-8", errors="replace")[-200:]
        raise RuntimeError(f"ffmpeg 失败 @ {at_sec}s: {stderr}")
    with open(out_path, "rb") as fh:
        data = fh.read()
    try:
        os.unlink(out_path)
    except Exception:
        pass
    return data


def _build_grid(frame_bytes_list: list, cols: int, width_each: int) -> bytes:
    """把多帧拼成网格 (用 PIL)"""
    try:
        from PIL import Image
    except ImportError:
        raise ImportError("grid 模式需 Pillow · pip install Pillow")
    from io import BytesIO
    imgs = [Image.open(BytesIO(b)) for b in frame_bytes_list]
    rows = (len(imgs) + cols - 1) // cols
    # 统一缩到 width_each
    resized = []
    for im in imgs:
        ratio = width_each / im.width
        new_h = max(1, int(im.height * ratio))
        resized.append(im.resize((width_each, new_h), Image.LANCZOS))
    cell_h = max(im.height for im in resized)
    canvas = Image.new("RGB", (width_each * cols, cell_h * rows), (0, 0, 0))
    for i, im in enumerate(resized):
        r, c = i // cols, i % cols
        canvas.paste(im, (c * width_each, r * cell_h))
    buf = BytesIO()
    canvas.save(buf, format="JPEG", quality=85, optimize=True)
    return buf.getvalue()


def _thumb_one(video_path: str, fname: str, p: dict) -> tuple[dict, dict]:
    """返 (result_images_b64, meta_summary_piece)。"""
    mode = (p.get("mode") or "single").lower()
    fmt = (p.get("format") or "JPEG").upper()
    if fmt == "JPG":
        fmt = "JPEG"
    if fmt not in ("JPEG", "WEBP"):
        fmt = "JPEG"
    width = int(p.get("width") or 320)
    quality = max(1, min(100, int(p.get("quality") or 80)))
    timeout_s = int(p.get("timeout_s") or 60)

    duration = _get_duration(video_path, timeout=8)
    timepoints: list = []
    if mode == "single":
        at = float(p.get("at_second", 1.0))
        if duration > 0:
            at = min(max(0.0, at), max(0.0, duration - 0.05))
        else:
            at = max(0.0, at)
        timepoints = [at]
    elif mode == "list":
        ats = p.get("at_seconds") or []
        timepoints = [max(0, float(t)) for t in ats][:30] or [1.0]
    elif mode == "evenly":
        n = max(1, min(30, int(p.get("count") or 5)))
        if duration <= 0:
            timepoints = [float(i) for i in range(1, n + 1)]
        else:
            timepoints = [
                duration * i / (n - 1) if n > 1 else duration / 2
                for i in range(n)
            ]
    elif mode == "grid":
        n = max(1, min(36, int(p.get("count") or 9)))
        if duration <= 0:
            timepoints = [float(i + 1) for i in range(n)]
        else:
            timepoints = [
                duration * i / max(1, n - 1) if n > 1 else duration / 2
                for i in range(n)
            ]
    else:
        raise ValueError(f"未知 mode={mode}")

    frames: list = []
    errors: list = []
    for at in timepoints:
        try:
            data = _extract_frame(video_path, at, width, fmt, quality, timeout_s)
            frames.append((at, data))
        except Exception as exc:
            errors.append({"filename": fname, "at_second": at, "error": str(exc)[:200]})

    if not frames:
        raise RuntimeError(f"{fname}: 所有抽帧失败 {errors[:2]}")

    result_images_b64: dict = {}
    base = fname.rsplit(".", 1)[0] if "." in fname else fname
    base = base.replace("/", "_")
    ext = {"JPEG": "jpg", "WEBP": "webp"}[fmt]

    if mode == "grid":
        cols = max(1, min(6, int(p.get("grid_cols") or 3)))
        grid_bytes = _build_grid([data for _, data in frames], cols, width)
        result_images_b64[f"{base}_grid.jpg"] = base64.b64encode(grid_bytes).decode("ascii")
    else:
        for i, (at, data) in enumerate(frames):
            name = (
                f"{base}_thumb.{ext}" if mode == "single"
                else f"{base}_frame{i+1:02d}_{int(at)}s.{ext}"
            )
            result_images_b64[name] = base64.b64encode(data).decode("ascii")

    meta = {
        "filename": fname,
        "mode": mode,
        "video_duration_sec": round(duration, 2),
        "frames_extracted": len(frames),
        "frames_failed": len(errors),
        "width": width,
        "format": fmt,
        "output_bytes": sum(len(d) for _, d in frames),
        "errors": errors,
        "frames": [
            {
                "index": i + 1,
                "at_second": round(at, 2),
                "bytes": len(d),
                "sha256": hashlib.sha256(d).hexdigest()[:16],
            }
            for i, (at, d) in enumerate(frames)
        ],
    }
    return result_images_b64, meta


def main():
    t0 = time.time()
    p = _params()

    try:
        os.environ["EC_FFMPEG"] = _ffmpeg_bin()
    except FileNotFoundError as exc:
        return _fail(str(exc), hint="apt install ffmpeg / brew install ffmpeg · 或安装 imageio-ffmpeg tier")

    input_dir = os.environ.get("EC_INPUT_DIR", "")
    batch_items: list[tuple[str, str]] = []
    if input_dir and os.path.isdir(input_dir):
        selected, discovered = _selected_input_files(input_dir)
        if discovered == 0:
            return _fail("EC_INPUT_DIR 无视频")
        if not selected:
            # 空分片 · 合法
            print(json.dumps({
                "status": "ok",
                "schema_version": "v1",
                "task_type": "video_thumbnail",
                "elapsed_ms": int((time.time() - t0) * 1000),
                "result_images_b64": {},
                "results": [],
                "summary": {"total_files": 0, "success": 0, "discovered_files": discovered},
                "summary_text": "空分片 · 无需处理",
            }, ensure_ascii=False))
            return 0
        batch_items = selected

    if batch_items:
        all_images: dict = {}
        results = []
        errors = []
        for fname, path in batch_items:
            try:
                imgs, meta = _thumb_one(path, fname, p)
                all_images.update(imgs)
                results.append(meta)
            except Exception as exc:
                errors.append({"filename": fname, "error": str(exc)[:300]})
        ok_n = len(results)
        if ok_n == 0 and errors:
            return _fail("所有视频抽帧失败", hint=json.dumps(errors[:3], ensure_ascii=False))
        elapsed_ms = int((time.time() - t0) * 1000)
        print(json.dumps({
            "status": "ok",
            "schema_version": "v1",
            "task_type": "video_thumbnail",
            "elapsed_ms": elapsed_ms,
            "result_images_b64": all_images,
            "results": results,
            "errors": errors,
            "summary": {
                "total_files": len(batch_items),
                "success": ok_n,
                "failed": len(errors),
                "frames_extracted": sum(r.get("frames_extracted", 0) for r in results),
                "output_bytes": sum(r.get("output_bytes", 0) for r in results),
            },
            "summary_text": f"✅ 缩略图 {ok_n}/{len(batch_items)} 视频 · {len(all_images)} 张 · {elapsed_ms}ms",
        }, ensure_ascii=False))
        return 0

    # 单文件 · stdin / 单目录首文件
    video_bytes = b""
    fname = "video"
    if input_dir and os.path.isdir(input_dir):
        for f in sorted(os.listdir(input_dir)):
            fp = os.path.join(input_dir, f)
            if os.path.isfile(fp):
                with open(fp, "rb") as fh:
                    video_bytes = fh.read()
                fname = f
                break
    if not video_bytes:
        try:
            raw = sys.stdin.buffer.read()
        except Exception:
            raw = b""
        if raw[:1] in (b"{", b"["):
            try:
                obj = json.loads(raw.decode("utf-8"))
                if isinstance(obj, dict):
                    if obj.get("video_b64"):
                        video_bytes = base64.b64decode(obj["video_b64"])
                    if obj.get("params"):
                        p.update(obj["params"])
            except Exception:
                pass
        if not video_bytes and raw:
            video_bytes = raw
    if not video_bytes:
        return _fail("无视频输入 · 检查 stdin / EC_INPUT_DIR / params.video_b64")
    if len(video_bytes) < 1024:
        return _fail("视频数据过小")

    inp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    inp.write(video_bytes)
    inp.close()
    try:
        imgs, meta = _thumb_one(inp.name, fname, p)
        elapsed_ms = int((time.time() - t0) * 1000)
        out = {
            "status": "ok",
            "schema_version": "v1",
            "task_type": "video_thumbnail",
            "elapsed_ms": elapsed_ms,
            "result_images_b64": imgs,
            "results": [meta],
            "summary": {
                **{k: meta[k] for k in (
                    "mode", "video_duration_sec", "frames_extracted",
                    "frames_failed", "width", "format", "output_bytes",
                )},
                "input_bytes": len(video_bytes),
            },
            "errors": meta.get("errors") or [],
            "frames": meta.get("frames") or [],
            "summary_text": "✅ {mode} · {n} 帧 · {w}px · {sz}KB · {ms}ms".format(
                mode=meta["mode"], n=meta["frames_extracted"], w=meta["width"],
                sz=meta["output_bytes"] // 1024, ms=elapsed_ms,
            ),
        }
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as exc:
        return _fail(str(exc))
    finally:
        try:
            os.unlink(inp.name)
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
