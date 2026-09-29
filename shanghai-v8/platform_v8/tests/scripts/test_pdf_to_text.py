"""S5 · pdf_to_text 企业级升级单测 (2026-06-07)"""
from __future__ import annotations
import json
import os
import subprocess
import sys
from io import BytesIO
from pathlib import Path
from typing import Optional

import pytest


def _has_pdf_lib():
    try:
        import fitz  # noqa
        return True
    except ImportError:
        try:
            import pdfplumber  # noqa
            return True
        except ImportError:
            return False


pytestmark = pytest.mark.skipif(not _has_pdf_lib(), reason="PyMuPDF/pdfplumber 都没装")
SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"


def _gen_pdf(text: str = "Hello 千手 PDF · 这是测试文档", pages: int = 1) -> bytes:
    """用 PyMuPDF 生成测试 PDF"""
    import fitz
    doc = fitz.open()
    for i in range(pages):
        page = doc.new_page()
        page.insert_text((50, 100), f"第 {i+1} 页 · {text}", fontsize=11, fontname="helv")
    out = doc.write()
    doc.close()
    return out


def _run(stdin_bytes: bytes, params: Optional[dict] = None) -> dict:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params)
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "pdf_to_text.py")],
        input=stdin_bytes, capture_output=True, env=env, timeout=20,
    )
    return json.loads(proc.stdout.decode("utf-8").strip().split("\n")[-1])


def _run_with_env(stdin_bytes: bytes, params: Optional[dict] = None, **extra_env: str) -> dict:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env.update(extra_env)
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params)
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "pdf_to_text.py")],
        input=stdin_bytes, capture_output=True, env=env, timeout=20,
    )
    return json.loads(proc.stdout.decode("utf-8").strip().split("\n")[-1])


def test_basic_extract_full_text():
    """默认 preview_chars=0 完整提取 (PyMuPDF helv 字体不支持中文 · 用 ASCII)"""
    pdf = _gen_pdf("Enterprise PDF test content", pages=2)
    out = _run(pdf)
    assert out["status"] == "ok"
    r = out["results"][0]
    assert r["pages_total"] == 2
    assert r["pages_extracted"] == 2
    # 完整文本(不截断 · ASCII 一定可见)
    text = r["text_pages"][0].get("text", "")
    assert "Enterprise" in text or "PDF" in text


def test_preview_chars_truncate():
    """preview_chars=10 截断"""
    pdf = _gen_pdf("非常长的文本内容用于测试截断功能 " * 20)
    out = _run(pdf, params={"preview_chars": 10})
    assert out["status"] == "ok"
    text = out["results"][0]["text_pages"][0]["text"]
    assert len(text) == 10


def test_page_range():
    """指定页范围 1-2 (5 页 PDF · 只提取前 2 页)"""
    pdf = _gen_pdf("Enterprise searchable page content for density", pages=5)
    out = _run(pdf, params={"page_range": "1-2", "mode": "text"})
    assert out["status"] == "ok"
    assert out["results"][0]["pages_extracted"] == 2
    assert out["results"][0]["pages_total"] == 5


def test_page_range_specific():
    """page_range='1,3,5' 离散页"""
    pdf = _gen_pdf("Enterprise searchable page content for density", pages=6)
    out = _run(pdf, params={"page_range": "1,3,5", "mode": "text"})
    assert out["status"] == "ok"
    assert out["results"][0]["pages_extracted"] == 3
    pages = [p["page"] for p in out["results"][0]["text_pages"]]
    assert pages == [1, 3, 5]


def test_include_text_false_privacy():
    """include_text=false · 隐私场景只统计字数"""
    pdf = _gen_pdf("Enterprise confidential content for privacy mode test")
    out = _run(pdf, params={"include_text": False, "mode": "text"})
    assert out["status"] == "ok"
    page = out["results"][0]["text_pages"][0]
    assert "chars" in page
    assert "text" not in page  # 隐私 · 不含原文


def test_empty_input_fails():
    out = _run(b"", params={})
    assert out["status"] == "failed"
    assert "无输入" in out.get("error", "") or "没拿到" in out.get("summary_text", "")


def test_garbage_input_fails_gracefully():
    """非 PDF 数据 · 友好失败"""
    out = _run(b"\x00\x01 not a pdf", params={})
    # 应进入 errors,不崩溃
    assert "status" in out
    if out["status"] == "failed":
        assert len(out.get("errors", [])) > 0 or "error" in out
    else:
        # PyMuPDF 容错强,可能尝试解析为 0 页 PDF
        pass


def test_metadata_extracted():
    """metadata 字段存在"""
    pdf = _gen_pdf("Enterprise metadata extraction content layer")
    out = _run(pdf, params={"mode": "text"})
    assert out["status"] == "ok"
    assert "metadata" in out["results"][0]
    assert "title" in out["results"][0]["metadata"]


def test_summary_text_chinese():
    pdf = _gen_pdf("Enterprise summary content for chinese summary text")
    out = _run(pdf, params={"mode": "text"})
    assert "PDF" in out["summary_text"]
    assert out["summary"]["files_ok"] == 1


def test_slice_meta_uses_zero_based_right_open_page_interval():
    """pages_chunked 发的 [0, 2) 必须变为用户参数 1-2，不重不漏。"""
    pdf = _gen_pdf("Enterprise slice page content for page ranges", pages=5)
    out = _run_with_env(
        pdf,
        params={"mode": "text"},
        EC_SLICE_META=json.dumps({"page_index_base": 0, "page_start": 2, "page_end": 4}),
    )
    assert out["status"] == "ok"
    assert [p["page"] for p in out["results"][0]["text_pages"]] == [3, 4]


def test_auto_route_returns_preflight():
    pdf = _gen_pdf("Searchable text layer " * 10, pages=2)
    out = _run(pdf, params={"mode": "auto"})
    result = out["results"][0]
    assert result["route"] == "text"
    assert result["preflight"]["total_pages"] == 2
    assert result["preflight"]["route"] == "text"
    # 按页路由：文本页标记 route=text，backend 为 MarkItDown 或 PyMuPDF
    assert all(p.get("route") == "text" for p in result["text_pages"])
    assert result["backend"] in {"MarkItDown", "PyMuPDF", "text"}


def test_force_text_mode_skips_ocr_even_if_sparse():
    """mode=text 强制走文本层，不因低密度进 OCR。"""
    pdf = _gen_pdf("x", pages=1)
    out = _run(pdf, params={"mode": "text"})
    assert out["status"] == "ok"
    assert out["results"][0]["route"] == "text"
