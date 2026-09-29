"""S5 · 企业级 image_resize 单测 (2026-06-07)
覆盖:
  - 基础 resize
  - WebP 转换 + quality
  - 水印 (文字 + 不同位置 + 透明度)
  - EXIF strip (商业默认)
  - fit: contain / cover / fill
  - background 色 (透明 PNG → JPEG)
  - 错误回路 (空输入)
"""
from __future__ import annotations
import base64
import json
import subprocess
import sys
from io import BytesIO
from pathlib import Path
from typing import Optional

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"


def _has_pil():
    try:
        import PIL  # noqa
        return True
    except ImportError:
        return False


pytestmark = pytest.mark.skipif(not _has_pil(), reason="PIL/Pillow not installed")


def _gen_png(w=200, h=200, mode="RGB", color=(255, 0, 0)):
    """生成测试 PNG bytes"""
    from PIL import Image
    img = Image.new(mode, (w, h), color)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _gen_png_with_alpha(w=200, h=200):
    """生成带 alpha 通道的 PNG (RGBA)"""
    from PIL import Image
    img = Image.new("RGBA", (w, h), (255, 0, 0, 128))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _run(stdin_bytes: bytes, params: Optional[dict] = None) -> dict:
    """跑 image_resize · stdin 二进制 + EC_PARAMS env"""
    import os
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params)
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "image_resize.py")],
        input=stdin_bytes,
        capture_output=True, env=env, timeout=20,
    )
    if proc.returncode != 0:
        # 让测试看到 stderr
        print("STDERR:", proc.stderr.decode("utf-8", errors="replace")[:500])
    last_line = proc.stdout.decode("utf-8").strip().split("\n")[-1]
    return json.loads(last_line)


def test_basic_resize():
    out = _run(_gen_png(400, 300), params={"width": 200})
    assert out["status"] == "ok"
    assert out["results"][0]["output_size"] == [200, 150]  # 保持长宽比 4:3


def test_explicit_height_keep_aspect():
    """width + height 都给 · 默认 contain 等比"""
    out = _run(_gen_png(400, 200), params={"width": 300, "height": 300})
    assert out["status"] == "ok"
    # contain 取最小比 0.75 → 300x150
    assert out["results"][0]["output_size"] == [300, 150]


def test_fit_cover():
    """fit=cover 取最大比"""
    out = _run(_gen_png(400, 200), params={"width": 300, "height": 300, "fit": "cover"})
    assert out["status"] == "ok"
    # cover 取最大比 1.5 → 600x300
    assert out["results"][0]["output_size"] == [600, 300]


def test_fit_fill_no_aspect():
    """keep_aspect=false 直接 fill"""
    out = _run(_gen_png(400, 200),
               params={"width": 100, "height": 100, "keep_aspect": False})
    assert out["status"] == "ok"
    assert out["results"][0]["output_size"] == [100, 100]


def test_webp_quality():
    """WebP 输出 + quality 85"""
    out = _run(_gen_png(400, 300, color=(128, 64, 200)),
               params={"width": 200, "format": "webp", "quality": 85})
    assert out["status"] == "ok"
    assert out["results"][0]["output_format"] == "WEBP"
    assert out["results"][0]["quality"] == 85
    # filename 后缀 .webp
    fnames = list(out["result_images_b64"].keys())
    assert fnames[0].endswith(".webp")


def test_alpha_to_jpeg_with_background():
    """RGBA PNG → JPEG · 用指定背景色合成"""
    out = _run(_gen_png_with_alpha(200, 200),
               params={"width": 100, "format": "JPEG", "background": "#000000"})
    assert out["status"] == "ok"
    # 解码输出图验证 mode
    img_b64 = next(iter(out["result_images_b64"].values()))
    img_bytes = base64.b64decode(img_b64)
    from PIL import Image
    out_img = Image.open(BytesIO(img_bytes))
    assert out_img.format == "JPEG"
    assert out_img.mode == "RGB"  # 透明已被合成


def test_watermark_applied():
    """水印 · 输出图与无水印对比应不同"""
    base = _gen_png(400, 400, color=(200, 200, 200))
    no_wm = _run(base, params={"width": 200, "format": "PNG"})
    with_wm = _run(base, params={
        "width": 200, "format": "PNG",
        "watermark_text": "千手测试",
        "watermark_pos": "bottom_right",
        "watermark_opacity": 0.6,
    })
    assert no_wm["status"] == "ok" and with_wm["status"] == "ok"
    assert with_wm["results"][0]["watermarked"] is True
    # sha 不同 → 水印生效
    assert no_wm["results"][0]["sha256_output"] != with_wm["results"][0]["sha256_output"]


def test_strip_exif_default():
    """默认 strip_exif=True · 商业安全"""
    out = _run(_gen_png(200, 200), params={"width": 100, "format": "JPEG"})
    assert out["status"] == "ok"
    assert out["results"][0]["exif_stripped"] is True


def test_keep_metadata_overrides_strip():
    """显式 keep_metadata=True 时不剥 EXIF"""
    out = _run(_gen_png(200, 200),
               params={"width": 100, "format": "JPEG",
                       "strip_exif": False, "keep_metadata": True})
    assert out["status"] == "ok"
    assert out["results"][0]["exif_stripped"] is False


def test_quality_clamped():
    """quality 越界自动 clamp"""
    out = _run(_gen_png(200, 200),
               params={"width": 100, "format": "JPEG", "quality": 200})
    assert out["status"] == "ok"
    assert out["results"][0]["quality"] == 100  # clamp 到 100


def test_empty_stdin_fails():
    """空输入 · 友好失败 · 非崩溃"""
    out = _run(b"", params={"width": 100})
    assert out["status"] == "failed"
    assert "stdin 为空" in out.get("error", "") or "stdin 为空" in out.get("summary_text", "")


def test_corrupt_input_fails():
    """非图片字节 · 友好失败"""
    out = _run(b"\x00\x01\x02 not an image", params={"width": 100})
    assert out["status"] == "failed"
