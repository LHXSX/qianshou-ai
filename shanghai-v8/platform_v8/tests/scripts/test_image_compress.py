"""S5 · image_compress 企业级升级单测 (2026-06-07)"""
from __future__ import annotations
import json
import os
import subprocess
import sys
from io import BytesIO
from pathlib import Path
from typing import Optional

import pytest


def _has_pil():
    try:
        import PIL  # noqa
        return True
    except ImportError:
        return False


pytestmark = pytest.mark.skipif(not _has_pil(), reason="PIL not installed")
SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"


def _gen_png(w=400, h=300, color=(120, 50, 200)):
    from PIL import Image
    img = Image.new("RGB", (w, h), color)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _run(stdin: bytes, params: Optional[dict] = None) -> dict:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params)
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "image_compress.py")],
        input=stdin, capture_output=True, env=env, timeout=20,
    )
    return json.loads(proc.stdout.decode("utf-8").strip().split("\n")[-1])


def test_jpeg_basic():
    """JPEG 压缩工作即可 (具体比例随图片性质 · 不强卡 < 1.0)"""
    out = _run(_gen_png(), params={"quality": 85, "format": "JPEG"})
    assert out["status"] == "ok"
    assert out["results"][0]["output_format"] == "JPEG"
    assert out["results"][0]["quality"] == 85
    assert out["results"][0]["output_bytes"] > 0
    assert "JPEG" in out["results"][0].get("output_format", "")


def test_jpeg_low_quality_smaller():
    """低 quality 应比高 quality 更小 (相对性能 · 不强卡绝对值)"""
    high = _run(_gen_png(800, 600), params={"quality": 95, "format": "JPEG"})
    low = _run(_gen_png(800, 600), params={"quality": 30, "format": "JPEG"})
    assert high["status"] == "ok" and low["status"] == "ok"
    # 同图 q=30 一定比 q=95 小(若不成立 = 压缩算法有问题)
    assert low["results"][0]["output_bytes"] < high["results"][0]["output_bytes"]


def test_webp_format():
    out = _run(_gen_png(), params={"format": "WEBP", "quality": 80})
    assert out["status"] == "ok"
    assert out["results"][0]["output_format"] == "WEBP"
    fnames = list(out["result_images_b64"].keys())
    assert fnames[0].endswith(".webp")


def test_png_palette_optimize():
    """PNG 输出 · palette 优化"""
    out = _run(_gen_png(), params={"format": "PNG", "png_palette": True})
    assert out["status"] == "ok"
    assert out["results"][0]["output_format"] == "PNG"


def test_quality_clamp_low():
    out = _run(_gen_png(), params={"quality": 0})
    assert out["status"] == "ok"
    assert out["results"][0]["quality"] == 1


def test_quality_clamp_high():
    out = _run(_gen_png(), params={"quality": 200})
    assert out["status"] == "ok"
    assert out["results"][0]["quality"] == 100


def test_invalid_format_fails():
    out = _run(_gen_png(), params={"format": "GIF"})
    assert out["status"] == "failed"


def test_auto_keeps_webp_format():
    """AUTO · WebP 输入保持 WEBP · 且体积不放大"""
    from PIL import Image
    img = Image.new("RGB", (120, 80), (10, 20, 30))
    buf = BytesIO()
    img.save(buf, format="WEBP", quality=50, method=6)
    raw = buf.getvalue()
    out = _run(raw, params={"quality": 85})  # default AUTO
    assert out["status"] == "ok"
    r = out["results"][0]
    assert r["output_format"] == "WEBP" or r.get("kept_original")
    assert r["output_bytes"] <= r["input_bytes"]


def test_never_enlarges_when_forced_jpeg_on_webp():
    """即使强制 JPEG · 若变大则回传原图"""
    from PIL import Image
    img = Image.new("RGB", (80, 60), (200, 100, 50))
    buf = BytesIO()
    img.save(buf, format="WEBP", quality=40, method=6)
    raw = buf.getvalue()
    out = _run(raw, params={"quality": 95, "format": "JPEG"})
    assert out["status"] == "ok"
    r = out["results"][0]
    assert r["output_bytes"] <= r["input_bytes"]


def test_strip_exif_default():
    out = _run(_gen_png(), params={"format": "JPEG"})
    assert out["status"] == "ok"
    assert out["results"][0]["exif_stripped"] is True
