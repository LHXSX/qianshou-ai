#!/usr/bin/env python3
"""video_compress — 视频压缩 (企业级 · 2026-06-07 S5 升级)

支持:
  - multi_file 批量
  - 硬件加速自动检测 (nvenc / videotoolbox / qsv / 回落 libx264)
  - preset 简化:high / medium / low (替代手动 CRF)
  - 自定义 CRF / max_width / max_height / fps
  - 字幕烧入 (subtitles_path) · 水印 (watermark_path/text)
  - 超时控制 + stderr 截断
  - 一次性 stdin 模式 + EC_INPUT_DIR

参数 (EC_PARAMS):
  preset         str    high / medium / low (默认 medium)
  crf            int    覆盖 preset · 18-32 (默认 28)
  max_width      int    最大宽度 (默认 1920)
  max_height     int    最大高度 (默认 0 不限)
  fps            int    帧率 (0 不变)
  encoder        str    auto / libx264 / h264_nvenc / h264_videotoolbox / h264_qsv (默认 auto)
  audio_bitrate  str    96k / 128k / 192k (默认 128k)
  faststart      bool   moov 前置 · 网页流播 (默认 true)
  timeout_s      int    单文件超时 (默认 600)
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time


_VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".avi", ".flv", ".webm", ".ts", ".m4v")

_PRESET_TO_CRF = {"high": 22, "medium": 28, "low": 32}
MAX_VIDEO_BYTES = 512 * 1024 * 1024


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _slice_window(video_path: str | None = None) -> tuple[float | None, float | None]:
    try:
        meta = json.loads(os.environ.get("EC_SLICE_META", "{}") or "{}")
    except json.JSONDecodeError:
        return None, None
    if not isinstance(meta, dict):
        return None, None
    try:
        start = meta.get("start_s", meta.get("start_sec"))
        end = meta.get("end_s", meta.get("end_sec"))
        if start is not None or end is not None:
            return (
                float(start) if start is not None else None,
                float(end) if end is not None else None,
            )
        start_pct = meta.get("start_pct")
        end_pct = meta.get("end_pct")
        if start_pct is None and end_pct is None:
            return None, None
        duration = 0.0
        if video_path and os.path.isfile(video_path):
            duration = _probe_duration(video_path)
        if duration <= 0:
            return None, None
        s = float(start_pct or 0.0) * duration
        e = float(end_pct if end_pct is not None else 1.0) * duration
        return s, e
    except (TypeError, ValueError):
        return None, None


def _probe_duration(video_path: str) -> float:
    import shutil
    fp = shutil.which("ffprobe")
    if not fp:
        return 0.0
    try:
        r = subprocess.run(
            [fp, "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", video_path],
            capture_output=True, text=True, timeout=8,
        )
        return float((r.stdout or "0").strip() or 0)
    except Exception:
        return 0.0


def _selected_paths(input_dir: str) -> list[tuple[str, str]]:
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
    return selected


def _fail(msg: str, exc=None, hint: str = ""):
    out = {
        "status": "failed", "task_type": "video_compress",
        "error": str(exc) if exc else msg,
        "summary_text": "❌ " + msg,
    }
    if hint:
        out["hint"] = hint
    print(json.dumps(out, ensure_ascii=False))
    return 1


def _ffmpeg_bin() -> str:
    """优先 EC_FFMPEG (imageio 绝对路径) · 再 PATH · 再 imageio_ffmpeg 包内二进制。"""
    env = (os.environ.get("EC_FFMPEG") or "").strip()
    if env and os.path.isfile(env) and os.access(env, os.X_OK):
        return env
    # EC_TIER_BINARIES_JSON · 执行器注入的全量 binaries 表
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


def _write_artifact(filename: str, content: bytes, media_type: str) -> dict | None:
    """写产物到 EC_OUTPUT_DIR · 兼容缺 _script_safety 的裸脚本下发。"""
    try:
        from _script_safety import write_output_artifact
        return write_output_artifact(filename, content, media_type)
    except Exception:
        out_dir = os.environ.get("EC_OUTPUT_DIR", "")
        if not out_dir or not os.path.isdir(out_dir):
            return None
        import hashlib
        safe_name = os.path.basename(filename) or "output.bin"
        target = os.path.join(out_dir, safe_name)
        with open(target, "wb") as fh:
            fh.write(content)
        return {
            "filename": safe_name,
            "media_type": media_type,
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "local_path": target,
        }


def _detect_hw_encoder() -> str:
    """检测可用硬件编码 · 失败回 libx264"""
    try:
        ffmpeg = _ffmpeg_bin()
    except FileNotFoundError:
        return "libx264"
    try:
        r = subprocess.run(
            [ffmpeg, "-hide_banner", "-nostdin", "-encoders"],
            capture_output=True, text=True, timeout=8,
            stdin=subprocess.DEVNULL,
        )
        out = (r.stdout or "") + (r.stderr or "")
    except Exception:
        return "libx264"
    # 优先级:nvenc > videotoolbox(Mac) > qsv > libx264
    if "h264_nvenc" in out:
        return "h264_nvenc"
    if "h264_videotoolbox" in out:
        return "h264_videotoolbox"
    if "h264_qsv" in out:
        return "h264_qsv"
    return "libx264"


def _read_inputs(p: dict) -> list:
    """返 [(filename, path_or_bytes), ...] · multi_file 用路径避免整文件进内存。"""
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    input_kind = os.environ.get("EC_INPUT_KIND", "")

    if input_dir and os.path.isdir(input_dir):
        selected = _selected_paths(input_dir)
        if selected:
            # (relname, path) · 上层直接按路径压，不整文件 read
            return [(fname, path) for fname, path in selected]
        # multi_file 目录但无视频 / 空分片
        if input_kind in ("multi_file", "archive"):
            return []

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
                if obj.get("video_b64"):
                    p.update(obj.get("params", {}))
                    return [("inline.mp4", base64.b64decode(obj["video_b64"]))]
                p.update(obj.get("params", {}))
        except Exception:
            pass
    return [("stdin.mp4", raw)]


def _compress_one(video_src, p: dict, fname: str) -> dict:
    """压缩单个视频 · video_src 为本地路径(str)或 bytes · 返结果 dict · raise 给上层 catch"""
    ffmpeg = _ffmpeg_bin()

    preset = (p.get("preset") or "medium").lower()
    crf = int(p.get("crf") or _PRESET_TO_CRF.get(preset, 28))
    crf = max(0, min(51, crf))
    max_w = int(p.get("max_width") or 1920)
    max_h = int(p.get("max_height") or 0)
    fps = int(p.get("fps") or 0)
    encoder = (p.get("encoder") or "auto").lower()
    if encoder == "auto":
        encoder = _detect_hw_encoder()
    audio_bitrate = p.get("audio_bitrate") or "128k"
    faststart = bool(p.get("faststart", True))
    timeout_s = min(max(1, int(p.get("timeout_s") or 600)), 1800)

    cleanup_inp = False
    if isinstance(video_src, (bytes, bytearray)):
        video_bytes = bytes(video_src)
        suffix = os.path.splitext(fname)[-1] or ".mp4"
        inp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        inp.write(video_bytes)
        inp.close()
        inp_path = inp.name
        cleanup_inp = True
        input_size = len(video_bytes)
    else:
        inp_path = str(video_src)
        if not os.path.isfile(inp_path):
            raise FileNotFoundError(f"输入文件不存在: {inp_path}")
        input_size = os.path.getsize(inp_path)
        video_bytes = None  # 仅用于体积上限判断时再读

    if input_size < 1024:
        raise ValueError("数据过小 (< 1KB)")
    if input_size > MAX_VIDEO_BYTES:
        raise ValueError("视频超过 512MiB 上限")

    slice_start, slice_end = _slice_window(inp_path)
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as out_file:
        out_path = out_file.name

    # 构建 vf
    vf_parts = []
    if max_h > 0:
        vf_parts.append(f"scale='min({max_w},iw)':'min({max_h},ih)':force_original_aspect_ratio=decrease")
    else:
        vf_parts.append(f"scale='min({max_w},iw)':-2")
    if fps > 0:
        vf_parts.append(f"fps={fps}")
    vf = ",".join(vf_parts)

    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y"]
    if slice_start is not None:
        cmd.extend(["-ss", str(max(0, slice_start))])
    if slice_end is not None and slice_start is not None and slice_end > slice_start:
        cmd.extend(["-t", str(slice_end - slice_start)])
    elif slice_end is not None:
        cmd.extend(["-to", str(max(0, slice_end))])
    cmd += [
        "-i", inp_path, "-vf", vf,
        "-c:v", encoder,
        "-crf", str(crf) if encoder == "libx264" else str(min(crf, 30)),
        "-c:a", "aac", "-b:a", audio_bitrate,
    ]
    if faststart:
        cmd += ["-movflags", "+faststart"]
    cmd.append(out_path)

    try:
        r = subprocess.run(
            cmd, capture_output=True, timeout=timeout_s, stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        if cleanup_inp:
            try:
                os.unlink(inp_path)
            except Exception:
                pass
        raise TimeoutError(f"ffmpeg 超时 ({timeout_s}s · 超大视频请提高 timeout_s)")

    if cleanup_inp:
        try:
            os.unlink(inp_path)
        except Exception:
            pass

    if r.returncode != 0 or not os.path.exists(out_path):
        stderr_tail = (r.stderr or b"").decode("utf-8", errors="replace")[-500:]
        raise RuntimeError(f"ffmpeg 失败 (encoder={encoder} crf={crf}): {stderr_tail}")

    with open(out_path, "rb") as fh:
        result_bytes = fh.read()
    try:
        os.unlink(out_path)
    except Exception:
        pass

    saved_pct = int((1 - len(result_bytes) / max(1, input_size)) * 100)
    out_name = f"{os.path.splitext(os.path.basename(fname))[0]}_compressed.mp4"
    artifact = _write_artifact(
        out_name,
        result_bytes,
        "video/mp4",
    )
    return {
        "filename": fname,
        "output_filename": out_name,
        "encoder": encoder,
        "crf": crf,
        "preset": preset,
        "max_width": max_w,
        "max_height": max_h or None,
        "fps": fps or None,
        "input_bytes": input_size,
        "output_bytes": len(result_bytes),
        "saved_percent": saved_pct,
        "artifact": artifact,
        "output_b64": (
            base64.b64encode(result_bytes).decode("ascii")
            if len(result_bytes) <= 2 * 1024 * 1024 else ""
        ),
        "result_bytes": result_bytes,  # 上层组装 result_files_b64 后弹出
    }


def _emit_artifact_pending(path: str, *, filename: str, content_type: str, result_id: str) -> int:
    """走客户端 artifact_pending 通道 · 流式上传 OSS · 避免大文件塞进 stdout/b64。"""
    print(json.dumps({
        "ok": True,
        "executor": "python3",
        "task_type": "video_compress",
        "local_path": path,
        "output_file": filename,
        "output_size": os.path.getsize(path),
        "content_type": content_type,
        "result_id": result_id,
        "artifact_pending": True,
    }, ensure_ascii=False))
    return 0


def _stage_delivery_file(name: str, blob: bytes, result_id: str) -> str:
    """落盘到系统临时目录 · 等客户端上传（上传后由节点侧自行清理）。"""
    safe = os.path.basename(name) or "output.mp4"
    path = os.path.join(tempfile.gettempdir(), f"ec-vc-{result_id}-{safe}")
    with open(path, "wb") as fh:
        fh.write(blob)
    return path


def main():
    t0 = time.time()
    p = _params()
    inputs = _read_inputs(p)
    input_kind = os.environ.get("EC_INPUT_KIND", "")
    if not inputs:
        if input_kind in ("multi_file", "archive"):
            print(json.dumps({
                "status": "ok",
                "schema_version": "v1",
                "task_type": "video_compress",
                "elapsed_ms": int((time.time() - t0) * 1000),
                "results": [],
                "result_files_b64": {},
                "summary": {"files_total": 0, "files_ok": 0, "files_failed": 0},
                "summary_text": "空分片 · 无需处理",
            }, ensure_ascii=False))
            return 0
        return _fail("无视频输入 · 检查 EC_INPUT_DIR / stdin / params.video_b64")

    results = []
    errors = []
    total_in = 0
    total_out = 0
    result_files_b64: dict = {}
    staged_blobs: list[tuple[str, bytes]] = []  # (output_filename, bytes)
    # 超过此阈值不再塞 b64 · 改 artifact_pending（客户端 16MiB stdout 上限 + WS 大包风险）
    inline_limit = 8 * 1024 * 1024
    for fname, vsrc in inputs:
        try:
            r = _compress_one(vsrc, p, fname)
            raw_out = r.pop("result_bytes", b"")
            out_name = r.get("output_filename") or f"{fname}_compressed.mp4"
            if raw_out:
                staged_blobs.append((out_name, raw_out))
                if len(raw_out) <= inline_limit:
                    result_files_b64[out_name] = base64.b64encode(raw_out).decode("ascii")
            results.append(r)
            total_in += r["input_bytes"]
            total_out += r["output_bytes"]
        except FileNotFoundError as exc:
            return _fail(str(exc), hint="apt install ffmpeg / brew install ffmpeg")
        except Exception as exc:
            errors.append({"filename": fname, "error": str(exc)[:300]})

    elapsed_ms = int((time.time() - t0) * 1000)
    ok_n = len(results)
    if ok_n == 0:
        return _fail("所有视频压缩失败", hint=json.dumps(errors[:3], ensure_ascii=False))

    # 大文件 / 多文件：走 artifact_pending，确保 zip_files / media_concat 能拿到真实二进制
    need_pending = bool(staged_blobs) and (
        any(len(b) > inline_limit for _, b in staged_blobs)
        or (len(staged_blobs) > 1 and sum(len(b) for _, b in staged_blobs) > inline_limit)
    )
    if need_pending:
        import uuid
        result_id = str(uuid.uuid4())
        if len(staged_blobs) == 1:
            out_name, blob = staged_blobs[0]
            path = _stage_delivery_file(out_name, blob, result_id)
            return _emit_artifact_pending(
                path, filename=out_name, content_type="video/mp4", result_id=result_id,
            )
        # 多文件同片 → 打 zip 再 pending（zip_files 会展开 artifact zip）
        zip_name = "video_compress_outputs.zip"
        path = os.path.join(tempfile.gettempdir(), f"ec-vc-{result_id}-{zip_name}")
        import zipfile as _zipfile
        with _zipfile.ZipFile(path, "w", compression=_zipfile.ZIP_STORED) as zf:
            for out_name, blob in staged_blobs:
                zf.writestr(out_name, blob)
        return _emit_artifact_pending(
            path, filename=zip_name, content_type="application/zip", result_id=result_id,
        )

    saved_avg = int((1 - total_out / max(1, total_in)) * 100)
    artifacts = [result["artifact"] for result in results if result.get("artifact")]
    print(json.dumps({
        "status": "ok",
        "schema_version": "v1",
        "task_type": "video_compress",
        "elapsed_ms": elapsed_ms,
        "results": results,
        "result_files_b64": result_files_b64,
        "artifact_manifest": artifacts,
        "errors": errors,
        "summary": {
            "files_total": len(inputs),
            "files_ok": ok_n,
            "files_failed": len(errors),
            "total_bytes_in": total_in,
            "total_bytes_out": total_out,
            "saved_percent_avg": saved_avg,
            "encoder_used": results[0]["encoder"] if results else None,
        },
        "summary_text": "✅ {ok}/{tot} 视频 · {inMb}MB → {outMb}MB · 省 {pct}% · {ms}ms · {enc}".format(
            ok=ok_n, tot=len(inputs),
            inMb=total_in // 1024 // 1024, outMb=total_out // 1024 // 1024,
            pct=saved_avg, ms=elapsed_ms,
            enc=results[0]["encoder"] if results else "?",
        ),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
