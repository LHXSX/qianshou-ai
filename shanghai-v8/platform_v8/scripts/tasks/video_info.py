#!/usr/bin/env python3
"""video_info — 读视频元数据 (时长/分辨率/编码/码率)

支持:
  - stdin / 单文件
  - EC_INPUT_DIR 批处理 + EC_SLICE_META 文件区间 (multi_file / archive)
输出 results[] · manifest_only 聚合
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from fractions import Fraction

_VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".avi", ".flv", ".webm", ".ts", ".m4v")
_SKIP_NAMES = {"input_manifest.v1.json", "ec_input", "ec_params.json"}


def _ffprobe():
    import shutil
    return shutil.which("ffprobe")


def _fail(msg, exc=None):
    print(json.dumps({
        "status": "failed", "contract_version": "1", "task_type": "video_info",
        "error": str(exc) if exc else msg, "summary_text": "❌ " + msg,
    }, ensure_ascii=False))
    return 1


def _looks_like_video(path: str) -> bool:
    name = os.path.basename(path).lower()
    if name in _SKIP_NAMES or name.startswith("."):
        return False
    if name.endswith(_VIDEO_EXTS):
        return True
    try:
        with open(path, "rb") as f:
            head = f.read(12)
    except OSError:
        return False
    # ISO BMFF (mp4/mov/m4v) or EBML (mkv/webm) / RIFF AVI
    if len(head) >= 8 and head[4:8] in (b"ftyp", b"moov", b"mdat"):
        return True
    if head.startswith(b"\x1a\x45\xdf\xa3") or head[:4] == b"RIFF":
        return True
    return False


def _selected_input_files(input_dir: str) -> tuple[list[tuple[str, str]], int]:
    paths: list[tuple[str, str]] = []
    pin = (os.environ.get("EC_INPUT") or "").strip()
    if pin and os.path.isfile(pin) and _looks_like_video(pin):
        rel = os.path.relpath(pin, input_dir) if pin.startswith(input_dir.rstrip("/") + os.sep) or pin.startswith(input_dir.rstrip("\\") + "\\") else os.path.basename(pin)
        paths.append((rel, pin))
        return paths, 1
    for root, dirs, names in os.walk(input_dir):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(root, name)
            if os.path.isfile(path) and _looks_like_video(path):
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


def _probe_path(path: str, nbytes: int | None = None) -> dict:
    if nbytes is None:
        nbytes = os.path.getsize(path)
    summary = None
    fp = _ffprobe()
    if fp:
        try:
            r = subprocess.run(
                [fp, "-v", "quiet", "-print_format", "json",
                 "-show_format", "-show_streams", path],
                capture_output=True, text=True, timeout=30,
            )
            if r.returncode == 0:
                meta = json.loads(r.stdout)
                fmt = meta.get("format", {})
                streams = meta.get("streams", [])
                v = next((s for s in streams if s.get("codec_type") == "video"), {})
                a = next((s for s in streams if s.get("codec_type") == "audio"), {})
                rfr = v.get("r_frame_rate", "0/1")
                try:
                    fps = float(Fraction(rfr))
                except (ValueError, ZeroDivisionError):
                    fps = 0
                summary = {
                    "duration_s": float(fmt.get("duration", 0) or 0),
                    "size_bytes": int(fmt.get("size", nbytes) or nbytes),
                    "bit_rate_kbps": int(int(fmt.get("bit_rate", 0) or 0) / 1000),
                    "container": fmt.get("format_name", ""),
                    "video": {
                        "codec": v.get("codec_name", ""),
                        "width": v.get("width"),
                        "height": v.get("height"),
                        "fps": round(float(fps), 2),
                        "pix_fmt": v.get("pix_fmt", ""),
                    },
                    "audio": {
                        "codec": a.get("codec_name", ""),
                        "channels": a.get("channels"),
                        "sample_rate": a.get("sample_rate", ""),
                    },
                    "probe": "ffprobe",
                }
        except Exception:
            summary = None

    if summary is None:
        import imageio_ffmpeg
        rd = imageio_ffmpeg.read_frames(path)
        meta = next(rd)
        try:
            rd.close()
        except Exception:
            pass
        size = meta.get("size") or (0, 0)
        dur = float(meta.get("duration") or 0)
        summary = {
            "duration_s": round(dur, 3),
            "size_bytes": nbytes,
            "bit_rate_kbps": int(nbytes * 8 / 1000 / dur) if dur > 0 else 0,
            "container": "",
            "video": {
                "codec": meta.get("codec", ""),
                "width": size[0],
                "height": size[1],
                "fps": round(float(meta.get("fps") or 0), 2),
                "pix_fmt": meta.get("pix_fmt", ""),
            },
            "audio": {
                "codec": meta.get("audio_codec", ""),
                "channels": None,
                "sample_rate": "",
            },
            "probe": "imageio-ffmpeg",
        }
    return summary


def _probe_bytes(raw: bytes, filename: str = "video.mp4") -> dict:
    suffix = os.path.splitext(filename)[-1] or ".mp4"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(raw)
        tmp = f.name
    try:
        info = _probe_path(tmp, len(raw))
        info["filename"] = filename
        return info
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _run_batch(t0: float, input_dir: str) -> int:
    files, discovered = _selected_input_files(input_dir)
    if discovered == 0:
        return _fail("EC_INPUT_DIR 无视频")
    results = []
    errors = []
    for filename, path in files:
        try:
            info = _probe_path(path)
            info["filename"] = filename
            results.append(info)
        except Exception as exc:
            errors.append({"filename": filename, "error": str(exc)[:300]})
    ok_n = len(results)
    report = {
        "status": "ok" if ok_n > 0 or not files else "failed",
        "contract_version": "1",
        "schema_version": "v1",
        "task_type": "video_info",
        "elapsed_ms": int((time.time() - t0) * 1000),
        "results": results,
        "errors": errors,
        "summary": {
            "total_files": len(files),
            "success": ok_n,
            "failed": len(errors),
            "discovered_files": discovered,
        },
        "summary_text": (
            "空分片 · 无需处理" if not files
            else f"视频信息识别完成 · 成功 {ok_n}/{len(files)}"
        ),
    }
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["status"] == "ok" else 1


def main():
    t0 = time.time()
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if input_dir and os.path.isdir(input_dir):
        return _run_batch(t0, input_dir)

    try:
        raw = sys.stdin.buffer.read()
    except Exception as e:
        return _fail("stdin 读失败", e)
    if not raw:
        return _fail("stdin 为空")

    try:
        summary = _probe_bytes(raw, "stdin.mp4")
        sv = summary["video"]
        sa = summary["audio"]
        elapsed = int((time.time() - t0) * 1000)
        print(json.dumps({
            "status": "ok",
            "schema_version": "v1",
            "contract_version": "1",
            "task_type": "video_info",
            "elapsed_ms": elapsed,
            "results": [summary],
            "summary": summary,
            "summary_text": (
                f"✅ 视频信息读取\n⏱️ 时长: {summary['duration_s']:.1f}s\n"
                f"📐 分辨率: {sv['width']}×{sv['height']}\n"
                f"🎬 编码: {sv['codec']} / 帧率 {sv['fps']:.1f}fps\n"
                f"🔊 音频: {sa['codec']}\n📊 码率: {summary['bit_rate_kbps']} kbps"
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        return _fail("处理失败", e)


if __name__ == "__main__":
    sys.exit(main())
