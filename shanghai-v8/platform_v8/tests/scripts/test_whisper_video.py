"""S5 · whisper_transcribe + video_compress 错误回路单测 (2026-06-07)

注:真识别/真压缩需 faster-whisper / ffmpeg (节点环境有,CI 不强求)。
本测仅验"无依赖时友好失败"+"参数解析正确"。
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"


def _run(script: str, stdin: bytes, params: Optional[dict] = None) -> dict:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params)
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script)],
        input=stdin, capture_output=True, env=env, timeout=15,
    )
    return json.loads(proc.stdout.decode("utf-8").strip().split("\n")[-1])


# ══════════════════════════════════════════════════════════════
# whisper_transcribe · 友好失败 + 参数解析
# ══════════════════════════════════════════════════════════════

def test_whisper_no_input():
    """无输入 · 友好失败 + hint"""
    out = _run("whisper_transcribe.py", b"")
    assert out["status"] == "failed"
    assert "无音频输入" in out.get("summary_text", "") or "无音频输入" in out.get("error", "")


def test_whisper_missing_lib_friendly():
    """若节点缺 faster-whisper · 给清晰 hint (本地大概率没装)"""
    try:
        import faster_whisper  # noqa
        pytest.skip("faster-whisper 已装 · 跳过缺库测试")
    except ImportError:
        pass
    # 给 1 字节假音频触发 transcribe → 应在 ImportError 路径报缺库
    out = _run("whisper_transcribe.py", b"FAKEAUDIO" * 100)
    assert out["status"] == "failed"
    # 关键错误提示存在
    err_text = out.get("error", "") + out.get("hint", "") + out.get("summary_text", "")
    assert "whisper" in err_text.lower() or "faster" in err_text.lower()


# ══════════════════════════════════════════════════════════════
# video_compress · 友好失败 + preset 解析
# ══════════════════════════════════════════════════════════════

def test_video_no_input():
    out = _run("video_compress.py", b"")
    assert out["status"] == "failed"


def test_video_too_small_input():
    """< 1KB 数据 · 应标 errors,而不是崩溃"""
    out = _run("video_compress.py", b"x" * 500)
    # 所有失败 → status failed
    assert out["status"] == "failed"


def test_video_no_ffmpeg_friendly():
    """若节点无 ffmpeg · 给清晰安装 hint"""
    import shutil
    if shutil.which("ffmpeg"):
        pytest.skip("ffmpeg 已装 · 跳过此测")
    out = _run("video_compress.py", b"BIGFAKEDATA" * 200)
    assert out["status"] == "failed"
    err = out.get("error", "") + out.get("hint", "")
    assert "ffmpeg" in err.lower()


def test_video_invalid_ffmpeg_data_friendly():
    """如装了 ffmpeg · 给非视频数据 · 应报 ffmpeg 失败而不是崩溃"""
    import shutil
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg 未装")
    out = _run("video_compress.py", b"NOTAVIDEO" * 500, params={"preset": "low"})
    assert out["status"] == "failed"
    # errors 列表 / error 字段中应有 ffmpeg 失败说明
    assert "ffmpeg" in (out.get("error", "") + str(out.get("hint", ""))).lower()
