#!/usr/bin/env python3
"""audio_transcode — 音频格式转换 / 重采样 / 改码率 · 需 ffmpeg。

支持:
  - EC_INPUT_DIR / stdin
  - 切片窗口 EC_SLICE_META start/end
  - 无音轨时明确报错
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time


MAX_INPUT_BYTES = 512 * 1024 * 1024
CODECS = {
    "mp3": "libmp3lame",
    "aac": "aac",
    "ogg": "libvorbis",
    "flac": "flac",
    "wav": "pcm_s16le",
    "m4a": "aac",
}
_AUDIO_EXTS = (".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wma")
_VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v")


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _slice_window() -> tuple[float | None, float | None]:
    try:
        meta = json.loads(os.environ.get("EC_SLICE_META", "{}") or "{}")
        start = meta.get("start_s", meta.get("start_sec"))
        end = meta.get("end_s", meta.get("end_sec"))
        return float(start) if start is not None else None, float(end) if end is not None else None
    except (ValueError, TypeError, json.JSONDecodeError):
        return None, None


def _ffmpeg_bin() -> str:
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
    raise FileNotFoundError("节点缺 ffmpeg")


def _ffprobe_bin() -> str | None:
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


def _has_audio_stream(path: str) -> bool | None:
    fp = _ffprobe_bin()
    if not fp:
        return None
    try:
        r = subprocess.run(
            [
                fp, "-v", "error", "-select_streams", "a",
                "-show_entries", "stream=index", "-of", "csv=p=0", path,
            ],
            capture_output=True, text=True, timeout=30,
        )
        return bool((r.stdout or "").strip())
    except Exception:
        return None


def _friendly_ffmpeg_error(stderr: str) -> str:
    s = stderr or ""
    if (
        "does not contain any stream" in s
        or "Output file does not contain any stream" in s
        or "matches no streams" in s
        or "Stream map '' matches no streams" in s
    ):
        return "输入没有音轨，无法转码（请上传音频文件或带声音的视频）"
    if "Invalid data found" in s:
        return "无法识别的音频/视频文件"
    lines = [ln for ln in s.strip().splitlines() if ln.strip()]
    tail = "\n".join(lines[-8:]) if lines else s[-300:]
    return f"转码失败: {tail}"


def _write_artifact(filename: str, content: bytes, media_type: str) -> dict | None:
    try:
        from _script_safety import write_output_artifact
        return write_output_artifact(filename, content, media_type)
    except Exception:
        out_dir = os.environ.get("EC_OUTPUT_DIR", "")
        if not out_dir or not os.path.isdir(out_dir):
            return None
        safe = os.path.basename(filename) or "output.bin"
        target = os.path.join(out_dir, safe)
        with open(target, "wb") as fh:
            fh.write(content)
        return {
            "schema": "artifact.v1",
            "filename": safe,
            "size_bytes": len(content),
            "content_type": media_type,
            "local_path": target,
        }


def _media_type(fmt: str) -> str:
    return {
        "mp3": "audio/mpeg",
        "aac": "audio/aac",
        "m4a": "audio/mp4",
        "ogg": "audio/ogg",
        "flac": "audio/flac",
        "wav": "audio/wav",
    }.get(fmt, "application/octet-stream")


def _transcode_one(src_path: str, p: dict, base_name: str) -> dict:
    ffmpeg = _ffmpeg_bin()
    has_a = _has_audio_stream(src_path)
    if has_a is False:
        raise ValueError("输入没有音轨，无法转码（请上传音频文件或带声音的视频）")

    target_fmt = str(p.get("format") or "mp3").lower()
    if target_fmt not in CODECS:
        raise ValueError(f"不支持 format: {target_fmt}")
    bitrate = str(p.get("bitrate") or "128k")
    if bitrate not in {"96k", "128k", "192k", "256k"}:
        bitrate = "128k"
    sample_rate = min(max(int(p.get("sample_rate") or 44100), 8000), 96000)
    start, end = _slice_window()

    out = tempfile.mktemp(suffix=f".{target_fmt}")
    try:
        cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
        if start is not None:
            cmd += ["-ss", str(max(0.0, start))]
        if end is not None and start is not None and end > start:
            cmd += ["-t", str(end - start)]
        cmd += [
            "-i", src_path,
            "-vn", "-map", "0:a:0",
            "-acodec", CODECS[target_fmt],
            "-b:a", bitrate,
            "-ar", str(sample_rate),
            out,
        ]
        # wav / flac 不需要 bitrate
        if target_fmt in {"wav", "flac"}:
            cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
            if start is not None:
                cmd += ["-ss", str(max(0.0, start))]
            if end is not None and start is not None and end > start:
                cmd += ["-t", str(end - start)]
            cmd += [
                "-i", src_path, "-vn", "-map", "0:a:0",
                "-acodec", CODECS[target_fmt], "-ar", str(sample_rate), out,
            ]
        result = subprocess.run(cmd, capture_output=True, timeout=300)
        if result.returncode != 0 or not os.path.isfile(out) or os.path.getsize(out) == 0:
            err = (result.stderr or b"").decode("utf-8", errors="replace")
            raise RuntimeError(_friendly_ffmpeg_error(err))
        with open(out, "rb") as fh:
            result_bytes = fh.read()
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass

    out_name = f"{base_name}.{target_fmt}"
    artifact = _write_artifact(out_name, result_bytes, _media_type(target_fmt))
    return {
        "filename": out_name,
        "target_format": target_fmt,
        "bitrate": bitrate,
        "sample_rate": sample_rate,
        "output_bytes": len(result_bytes),
        "artifact": artifact,
        "content_type": _media_type(target_fmt),
        # 仅小文件才走 stdout base64；大文件改 artifact_pending，避免客户端 16MB 截断
        "_bytes": result_bytes,
        "audio_b64": base64.b64encode(result_bytes).decode() if len(result_bytes) <= 2 * 1024 * 1024 else "",
    }


def _fail(msg: str, *, failure_class: str = "") -> int:
    out = {
        "status": "failed",
        "contract_version": "1",
        "task_type": "audio_transcode",
        "error": msg,
        "summary_text": "❌ " + msg,
    }
    if failure_class:
        out["failure_class"] = failure_class
    print(json.dumps(out, ensure_ascii=False))
    return 1


def _collect_inputs() -> list[tuple[str, str]]:
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if input_dir and os.path.isdir(input_dir):
        paths: list[tuple[str, str]] = []
        exts = _AUDIO_EXTS + _VIDEO_EXTS
        for root, dirs, names in os.walk(input_dir):
            dirs.sort()
            for name in sorted(names):
                path = os.path.join(root, name)
                if name.lower().endswith(exts) and os.path.isfile(path):
                    paths.append((os.path.relpath(path, input_dir), path))
        if paths:
            return paths
        for root, dirs, names in os.walk(input_dir):
            for name in sorted(names):
                path = os.path.join(root, name)
                if os.path.isfile(path):
                    return [(os.path.relpath(path, input_dir), path)]
        return []

    raw = sys.stdin.buffer.read()
    if not raw:
        return []
    audio_bytes = raw
    if raw[:1] in (b"{", b"["):
        try:
            obj = json.loads(raw)
            audio_bytes = base64.b64decode(obj.get("audio_b64", "") or "")
            if obj.get("params"):
                os.environ["EC_PARAMS"] = json.dumps({**_params(), **obj["params"]})
        except Exception:
            pass
    if not audio_bytes:
        return []
    if len(audio_bytes) > MAX_INPUT_BYTES:
        raise ValueError("音频超过 512MiB 上限")
    tmp = tempfile.NamedTemporaryFile(suffix=".bin", delete=False)
    tmp.write(audio_bytes)
    tmp.close()
    return [("input.bin", tmp.name)]


def main() -> int:
    t0 = time.time()
    tmp_owned: list[str] = []
    try:
        try:
            _ffmpeg_bin()
        except FileNotFoundError:
            return _fail("节点缺 ffmpeg", failure_class="env_missing_tool")

        p = _params()
        items = _collect_inputs()
        if not items:
            return _fail("无音频输入")

        for name, path in items:
            if name == "input.bin" and path.startswith(tempfile.gettempdir()):
                tmp_owned.append(path)

        # duration_chunked 通常每片一个文件段 · 取全部处理
        results = []
        errors = []
        artifacts = []
        for rel, path in items:
            base = os.path.splitext(os.path.basename(rel))[0] or "audio"
            try:
                if os.path.getsize(path) > MAX_INPUT_BYTES:
                    raise ValueError("音频超过 512MiB 上限")
                r = _transcode_one(path, p, base)
                results.append(r)
                if r.get("artifact"):
                    artifacts.append(r["artifact"])
            except Exception as exc:
                errors.append({"filename": rel, "error": str(exc)})

        if not results:
            msg = errors[0]["error"] if errors else "转码失败"
            return _fail(msg)

        elapsed = int((time.time() - t0) * 1000)
        first = results[0]
        # 客户端 stdout 上限 16MB；base64 膨胀约 4/3，原始合计超过 ~8MB 就走 artifact 直传
        INLINE_RAW_LIMIT = 8 * 1024 * 1024
        total_raw = sum(len(r.get("_bytes") or b"") for r in results)
        meta_results = [
            {k: v for k, v in r.items() if k not in ("audio_b64", "artifact", "_bytes", "file_b64")}
            for r in results
        ]

        if total_raw > INLINE_RAW_LIMIT:
            # 落盘后由客户端 artifact_pending 流式上传 · 不要在 finally 里删
            staging = tempfile.mkdtemp(prefix="ec-audio-transcode-")
            written: list[tuple[str, str, str]] = []  # fname, path, content_type
            for r in results:
                raw = r.get("_bytes") or b""
                fname = os.path.basename(r.get("filename") or "audio.bin")
                path = os.path.join(staging, fname)
                with open(path, "wb") as fh:
                    fh.write(raw)
                written.append((fname, path, r.get("content_type") or "application/octet-stream"))

            if len(written) == 1:
                fname, path, ctype = written[0]
                print(json.dumps({
                    "artifact_pending": True,
                    "local_path": path,
                    "filename": fname,
                    "content_type": ctype,
                    "output_size": os.path.getsize(path),
                    "task_type": "audio_transcode",
                    "results": meta_results,
                    "summary_text": (
                        f"✅ 音频转码 {len(results)}/{len(items)} · "
                        f"{first.get('target_format')} @ {first.get('bitrate')}"
                    ),
                }, ensure_ascii=False))
                return 0

            import zipfile as _zipfile
            zip_path = os.path.join(staging, "audio_outputs.zip")
            with _zipfile.ZipFile(zip_path, "w", compression=_zipfile.ZIP_STORED) as zf:
                for fname, path, _ctype in written:
                    zf.write(path, arcname=fname)
            print(json.dumps({
                "artifact_pending": True,
                "local_path": zip_path,
                "filename": "audio_outputs.zip",
                "content_type": "application/zip",
                "output_size": os.path.getsize(zip_path),
                "task_type": "audio_transcode",
                "results": meta_results,
                "summary_text": (
                    f"✅ 音频转码 {len(results)}/{len(items)} · "
                    f"{first.get('target_format')} @ {first.get('bitrate')}"
                ),
            }, ensure_ascii=False))
            return 0

        files_b64 = {
            r["filename"]: base64.b64encode(r["_bytes"]).decode("ascii")
            for r in results
            if r.get("filename") and r.get("_bytes")
        }
        report = {
            "status": "ok",
            "contract_version": "1",
            "task_type": "audio_transcode",
            "elapsed_ms": elapsed,
            "summary": {
                "total_files": len(items),
                "success": len(results),
                "failed": len(errors),
                "target_format": first.get("target_format"),
                "bitrate": first.get("bitrate"),
                "sample_rate": first.get("sample_rate"),
                "output_bytes": sum(r.get("output_bytes", 0) for r in results),
            },
            "results": meta_results,
            "errors": errors,
            "result_files_b64": files_b64,
            "artifact_manifest": artifacts,
            "result_audio_b64": first.get("audio_b64") or "",
            "summary_text": (
                f"✅ 音频转码 {len(results)}/{len(items)} · "
                f"{first.get('target_format')} @ {first.get('bitrate')}"
            ),
        }
        if len(artifacts) == 1 and artifacts[0]:
            report["artifact"] = artifacts[0]
        print(json.dumps(report, ensure_ascii=False))
        return 0
    except Exception as exc:
        return _fail(str(exc))
    finally:
        for path in tmp_owned:
            try:
                os.unlink(path)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
