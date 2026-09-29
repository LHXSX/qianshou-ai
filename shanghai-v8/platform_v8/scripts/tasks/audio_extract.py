#!/usr/bin/env python3
"""audio_extract — 从视频提取音频 (MP3/AAC) · 需 ffmpeg。

支持:
  - EC_INPUT_DIR 多文件 / 单文件
  - stdin 二进制 / {video_b64, params}
  - 无音轨时返回明确中文错误 (不再甩 ffmpeg exit 234 长日志)
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
_VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".avi", ".flv", ".webm", ".m4v", ".ts")


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
    """True=有音轨 · False=无音轨 · None=无法探测(继续尝试 ffmpeg)。"""
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
        return "视频没有音轨，无法提取音频（请换带声音的视频）"
    if "Invalid data found" in s:
        return "无法识别的视频/音频文件"
    # 截断长 banner
    lines = [ln for ln in s.strip().splitlines() if ln.strip()]
    tail = "\n".join(lines[-8:]) if lines else s[-300:]
    return f"提取失败: {tail}"


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


def _extract_one(video_path: str, p: dict, base_name: str) -> dict:
    ffmpeg = _ffmpeg_bin()
    has_a = _has_audio_stream(video_path)
    if has_a is False:
        raise ValueError("视频没有音轨，无法提取音频（请换带声音的视频）")

    fmt = (p.get("format") or "mp3").lower()
    if fmt not in {"mp3", "aac", "m4a"}:
        raise ValueError("format 仅支持 mp3/aac/m4a")
    bitrate = str(p.get("bitrate") or "192k")
    if bitrate not in {"96k", "128k", "192k", "256k"}:
        bitrate = "192k"
    start, end = _slice_window()

    suffix = ".mp3" if fmt == "mp3" else ".m4a"
    out = tempfile.mktemp(suffix=suffix)
    try:
        cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
        if start is not None:
            cmd += ["-ss", str(max(0.0, start))]
        if end is not None and start is not None and end > start:
            cmd += ["-t", str(end - start)]
        codec = "libmp3lame" if fmt == "mp3" else "aac"
        # -map 0:a:0 明确只取第一条音轨 · 无音轨时立刻失败
        cmd += [
            "-i", video_path,
            "-vn", "-map", "0:a:0",
            "-acodec", codec, "-b:a", bitrate,
            out,
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=300)
        if result.returncode != 0 or not os.path.isfile(out) or os.path.getsize(out) == 0:
            err = (result.stderr or b"").decode("utf-8", errors="replace")
            raise RuntimeError(_friendly_ffmpeg_error(err))
        with open(out, "rb") as fh:
            audio_bytes = fh.read()
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass

    out_name = f"{base_name}.{fmt if fmt != 'm4a' else 'm4a'}"
    ctype = f"audio/{'mpeg' if fmt == 'mp3' else 'mp4'}"
    artifact = _write_artifact(out_name, audio_bytes, ctype)
    return {
        "filename": out_name,
        "format": fmt,
        "bitrate": bitrate,
        "output_bytes": len(audio_bytes),
        "artifact": artifact,
        "content_type": ctype,
        "_bytes": audio_bytes,
        "audio_b64": base64.b64encode(audio_bytes).decode() if len(audio_bytes) <= 2 * 1024 * 1024 else "",
    }


def _fail(msg: str, *, failure_class: str = "") -> int:
    out = {
        "status": "failed",
        "contract_version": "1",
        "task_type": "audio_extract",
        "error": msg,
        "summary_text": "❌ " + msg,
    }
    if failure_class:
        out["failure_class"] = failure_class
    print(json.dumps(out, ensure_ascii=False))
    return 1


def _collect_inputs() -> list[tuple[str, str]]:
    """[(rel_name, abs_path), ...]"""
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if input_dir and os.path.isdir(input_dir):
        paths: list[tuple[str, str]] = []
        for root, dirs, names in os.walk(input_dir):
            dirs.sort()
            for name in sorted(names):
                path = os.path.join(root, name)
                if name.lower().endswith(_VIDEO_EXTS) and os.path.isfile(path):
                    paths.append((os.path.relpath(path, input_dir), path))
        if paths:
            return paths
        # 无扩展名匹配时 · 取第一个普通文件
        for root, dirs, names in os.walk(input_dir):
            for name in sorted(names):
                path = os.path.join(root, name)
                if os.path.isfile(path):
                    return [(os.path.relpath(path, input_dir), path)]
        return []

    raw = sys.stdin.buffer.read()
    if not raw:
        return []
    video_bytes = raw
    if raw[:1] in (b"{", b"["):
        try:
            obj = json.loads(raw)
            video_bytes = base64.b64decode(obj.get("video_b64", "") or "")
            if obj.get("params"):
                os.environ["EC_PARAMS"] = json.dumps({**_params(), **obj["params"]})
        except Exception:
            pass
    if not video_bytes:
        return []
    if len(video_bytes) > MAX_INPUT_BYTES:
        raise ValueError("视频超过 512MiB 上限")
    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    tmp.write(video_bytes)
    tmp.close()
    return [("input.mp4", tmp.name)]


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
            return _fail("无视频输入")

        # stdin 临时文件需要清理
        for name, path in items:
            if name == "input.mp4" and path.startswith(tempfile.gettempdir()):
                tmp_owned.append(path)

        results = []
        errors = []
        artifacts = []
        for rel, path in items:
            base = os.path.splitext(os.path.basename(rel))[0] or "audio"
            try:
                if os.path.getsize(path) > MAX_INPUT_BYTES:
                    raise ValueError("视频超过 512MiB 上限")
                r = _extract_one(path, p, base)
                results.append(r)
                if r.get("artifact"):
                    artifacts.append(r["artifact"])
            except Exception as exc:
                errors.append({"filename": rel, "error": str(exc)})

        if not results:
            msg = errors[0]["error"] if errors else "提取失败"
            return _fail(msg)

        elapsed = int((time.time() - t0) * 1000)
        first = results[0]
        INLINE_RAW_LIMIT = 8 * 1024 * 1024
        total_raw = sum(len(r.get("_bytes") or b"") for r in results)
        meta_results = [
            {k: v for k, v in r.items() if k not in ("audio_b64", "artifact", "_bytes", "file_b64")}
            for r in results
        ]

        if total_raw > INLINE_RAW_LIMIT:
            staging = tempfile.mkdtemp(prefix="ec-audio-extract-")
            written: list[tuple[str, str, str]] = []
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
                    "task_type": "audio_extract",
                    "results": meta_results,
                    "summary_text": f"✅ 音频提取 {len(results)}/{len(items)} · {first.get('format')} @ {first.get('bitrate')}",
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
                "task_type": "audio_extract",
                "results": meta_results,
                "summary_text": f"✅ 音频提取 {len(results)}/{len(items)} · {first.get('format')} @ {first.get('bitrate')}",
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
            "task_type": "audio_extract",
            "elapsed_ms": elapsed,
            "summary": {
                "total_files": len(items),
                "success": len(results),
                "failed": len(errors),
                "format": first.get("format"),
                "bitrate": first.get("bitrate"),
                "output_bytes": sum(r.get("output_bytes", 0) for r in results),
            },
            "results": meta_results,
            "errors": errors,
            "result_files_b64": files_b64,
            "artifact_manifest": artifacts,
            "result_audio_b64": first.get("audio_b64") or "",
            "summary_text": f"✅ 音频提取 {len(results)}/{len(items)} · {first.get('format')} @ {first.get('bitrate')}",
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
