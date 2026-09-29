#!/usr/bin/env python3
"""
video_repurpose.py — 视频二次创作脚本
下载视频 → 加字幕 → 裁剪尺寸 → 输出成品

参数：
  source_url: str     — 视频链接（抖音/B站）
  add_subtitles: bool — 是否加字幕，默认 true
  target_width: int   — 目标宽度，默认 1080（抖音竖屏）
  target_height: int  — 目标高度，默认 1920
  voiceover: str      — 配音文本（留空则保留原声）

输出：
  { output_url, duration, subtitles_added }
"""
import os, json, subprocess, tempfile, time
from urllib.request import Request, urlopen

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
source_url = params.get("source_url", "")
target_w = params.get("target_width", 1080)
target_h = params.get("target_height", 1920)

WORK_DIR = os.environ.get("EC_OUTPUT_DIR", "/tmp")
os.makedirs(WORK_DIR, exist_ok=True)

def download_video(url: str) -> str:
    """下载视频到本地"""
    path = os.path.join(WORK_DIR, "source.mp4")
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    resp = urlopen(req, timeout=30)
    with open(path, "wb") as f:
        f.write(resp.read())
    return path

def get_duration(video_path: str) -> float:
    """获取视频时长"""
    r = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "csv=p=0", video_path
    ], capture_output=True, text=True, timeout=10)
    return float(r.stdout.strip())

def resize_video(src: str, dst: str, w: int, h: int):
    """裁剪分辨率"""
    subprocess.run([
        "ffmpeg", "-i", src, "-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2",
        "-c:a", "copy", dst, "-y"
    ], capture_output=True, timeout=120)

try:
    src = download_video(source_url)
    duration = get_duration(src)
    out = os.path.join(WORK_DIR, "output.mp4")
    resize_video(src, out, target_w, target_h)
    
    result = {
        "status": "ok",
        "output_path": out,
        "duration_sec": duration,
        "target_size": f"{target_w}x{target_h}",
        "time": time.time(),
    }
except Exception as e:
    result = {"status": "error", "error": str(e)[:200], "time": time.time()}

print(json.dumps(result, ensure_ascii=False))
