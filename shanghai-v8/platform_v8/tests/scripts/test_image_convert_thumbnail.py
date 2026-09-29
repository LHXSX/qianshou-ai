"""S5 · image_convert + image_thumbnail 企业级升级单测 (2026-06-07)"""
from __future__ import annotations
import base64
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


def _gen_png(w=400, h=300, mode="RGB", color=(120, 50, 200)):
    from PIL import Image
    img = Image.new(mode, (w, h), color)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _gen_rgba(w=400, h=400):
    from PIL import Image
    img = Image.new("RGBA", (w, h), (255, 0, 0, 100))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _run(script: str, stdin: bytes, params: Optional[dict] = None) -> dict:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params)
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script)],
        input=stdin, capture_output=True, env=env, timeout=20,
    )
    return json.loads(proc.stdout.decode("utf-8").strip().split("\n")[-1])


# ══════════════════════════════════════════════════════════════
# image_convert
# ══════════════════════════════════════════════════════════════

def test_convert_png_to_jpeg():
    out = _run("image_convert.py", _gen_png(), params={"format": "JPEG"})
    assert out["status"] == "ok"
    assert out["results"][0]["output_format"] == "JPEG"


def test_convert_png_to_webp():
    out = _run("image_convert.py", _gen_png(), params={"format": "WEBP", "quality": 80})
    assert out["status"] == "ok"
    assert out["results"][0]["output_format"] == "WEBP"
    assert out["results"][0]["quality"] == 80


def test_convert_rgba_to_jpeg_with_background():
    """RGBA → JPEG · 透明用 background 合成"""
    out = _run("image_convert.py", _gen_rgba(),
               params={"format": "JPEG", "background": "#000000"})
    assert out["status"] == "ok"
    img_bytes = base64.b64decode(next(iter(out["result_images_b64"].values())))
    from PIL import Image
    out_img = Image.open(BytesIO(img_bytes))
    assert out_img.format == "JPEG"
    assert out_img.mode == "RGB"


def test_convert_invalid_format_fails():
    out = _run("image_convert.py", _gen_png(), params={"format": "GIF"})
    assert out["status"] == "failed"


def test_convert_strip_exif_default():
    out = _run("image_convert.py", _gen_png(), params={"format": "JPEG"})
    assert out["status"] == "ok"
    assert out["results"][0]["exif_stripped"] is True


# ══════════════════════════════════════════════════════════════
# image_thumbnail
# ══════════════════════════════════════════════════════════════

def test_thumb_single_size():
    out = _run("image_thumbnail.py", _gen_png(800, 600), params={"size": 200})
    assert out["status"] == "ok"
    assert out["results"][0]["thumbnail_count"] == 1
    thumb = out["results"][0]["thumbnails"][0]
    assert thumb["size_target"] == 200
    # 800x600 保比例 -> max 200 -> 200x150
    assert thumb["size_real"] == [200, 150]


def test_thumb_multi_sizes_responsive():
    """电商响应式 · 一图三档"""
    out = _run("image_thumbnail.py", _gen_png(1200, 900),
               params={"sizes": [200, 400, 800], "format": "WEBP"})
    assert out["status"] == "ok"
    assert out["results"][0]["thumbnail_count"] == 3
    sizes = [t["size_target"] for t in out["results"][0]["thumbnails"]]
    assert sizes == [200, 400, 800]
    # 3 个文件都在 result_images_b64
    assert len(out["result_images_b64"]) == 3


def test_thumb_square_crop_center():
    """方形裁剪 · 头像场景"""
    out = _run("image_thumbnail.py", _gen_png(800, 400),
               params={"size": 200, "square": True, "format": "PNG"})
    assert out["status"] == "ok"
    assert out["results"][0]["square"] is True
    thumb = out["results"][0]["thumbnails"][0]
    assert thumb["size_real"] == [200, 200]  # 严格方形


def test_thumb_default_webp():
    """默认 WebP 格式"""
    out = _run("image_thumbnail.py", _gen_png(), params={"size": 100})
    assert out["status"] == "ok"
    assert out["results"][0]["output_format"] == "WEBP"
    fname = next(iter(out["result_images_b64"].keys()))
    assert fname.endswith(".webp")


def test_thumb_sizes_dedup_and_clamp():
    """sizes 去重 + 最多 8 档"""
    out = _run("image_thumbnail.py", _gen_png(400, 300),
               params={"sizes": [100, 200, 100, 200, 300]})
    assert out["status"] == "ok"
    # 去重后 3 档
    assert out["results"][0]["thumbnail_count"] == 3


def test_thumb_quality_clamp():
    out = _run("image_thumbnail.py", _gen_png(),
               params={"size": 100, "quality": 200})
    assert out["status"] == "ok"
    assert out["results"][0]["quality"] == 100


def test_thumb_empty_stdin_fails():
    out = _run("image_thumbnail.py", b"")
    assert out["status"] == "failed"
