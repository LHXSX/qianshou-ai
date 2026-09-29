#!/usr/bin/env python3
"""word_to_text — Word(.doc/.docx) 转纯文本（word-to-text-v2 官方脚本）

合并 doc_to_text + docx_to_text：优先 python-docx / document.xml；
旧 .doc 走 antiword / catdoc / soffice。每片恰好 1 个 Word 文件。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

_WORD_EXTS = (".doc", ".docx")


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _list_word_files(input_dir: str) -> list[str]:
    return [
        fn for fn in sorted(os.listdir(input_dir))
        if fn != "input_manifest.v1.json"
        and os.path.isfile(os.path.join(input_dir, fn))
        and fn.lower().endswith(_WORD_EXTS)
    ]


def _read_input() -> list[tuple[str, bytes]]:
    d = os.environ.get("EC_INPUT_DIR", "")
    if d and os.path.isdir(d):
        files = _list_word_files(d)
        if not files:
            raise ValueError(
                f"word_to_text 未找到 .doc/.docx 文件，目录={sorted(os.listdir(d))}"
            )
        out = []
        for fn in files:
            with open(os.path.join(d, fn), "rb") as fh:
                out.append((fn, fh.read()))
        return out
    name = str(_params().get("input_name") or "stdin.docx")
    return [(name, sys.stdin.buffer.read())]


def _extract_python_docx(data: bytes) -> str:
    from docx import Document
    doc = Document(BytesIO(data))
    return "\n".join(p.text for p in doc.paragraphs if p.text).strip()


def _extract_docx_xml(data: bytes) -> str:
    with zipfile.ZipFile(BytesIO(data)) as zf:
        xml = zf.read("word/document.xml")
    root = ET.fromstring(xml)
    texts: list[str] = []
    for node in root.iter():
        if node.tag.endswith("}t") and node.text:
            texts.append(node.text)
        if node.tag.endswith("}tab"):
            texts.append("\t")
        if node.tag.endswith("}br") or node.tag.endswith("}cr"):
            texts.append("\n")
        if node.tag.endswith("}p"):
            texts.append("\n")
    raw = "".join(texts)
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


def _run_tool(cmd: list[str], data: bytes, timeout: int = 120) -> str:
    with tempfile.TemporaryDirectory(prefix="word_to_text_") as td:
        src = Path(td) / "input.doc"
        src.write_bytes(data)
        proc = subprocess.run(
            cmd + [str(src)],
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        out = (proc.stdout or b"").decode("utf-8", errors="replace").strip()
        if proc.returncode == 0 and out:
            return out
        err = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(err or f"{cmd[0]} failed rc={proc.returncode}")


def _via_soffice(data: bytes) -> str:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise RuntimeError("soffice_not_found")
    with tempfile.TemporaryDirectory(prefix="word_to_text_lo_") as td:
        src = Path(td) / "input.doc"
        src.write_bytes(data)
        proc = subprocess.run(
            [soffice, "--headless", "--convert-to", "docx", "--outdir", td, str(src)],
            capture_output=True,
            timeout=180,
            check=False,
        )
        docx = Path(td) / "input.docx"
        if not docx.is_file():
            err = (proc.stderr or proc.stdout or b"").decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"soffice_convert_failed: {err}")
        return _extract_docx_xml(docx.read_bytes())


def _extract_docx(data: bytes) -> tuple[str, str]:
    try:
        return _extract_python_docx(data), "python-docx"
    except Exception:
        return _extract_docx_xml(data), "xml"


def _extract_doc(data: bytes) -> tuple[str, str]:
    errors: list[str] = []
    for name, which, builder in (
        ("antiword", "antiword", lambda: _run_tool(["antiword", "-w", "0"], data)),
        ("catdoc", "catdoc", lambda: _run_tool(["catdoc", "-w"], data)),
        ("soffice", "soffice", lambda: _via_soffice(data)),
    ):
        if which != "soffice" and not shutil.which(which):
            errors.append(f"{name}:not_found")
            continue
        try:
            text = builder()
            if text:
                return text, name
            errors.append(f"{name}:empty")
        except Exception as exc:
            errors.append(f"{name}:{exc}")
    raise RuntimeError("; ".join(errors) or "doc_extract_failed")


def main() -> int:
    t0 = time.time()
    try:
        items = _read_input()
    except ValueError as exc:
        print(json.dumps({
            "status": "failed",
            "task_type": "word_to_text",
            "error": str(exc),
            "summary_text": f"❌ {exc}",
        }, ensure_ascii=False))
        return 1

    results = []
    texts = []
    errors = []
    for filename, data in items:
        if not data:
            errors.append({"filename": filename, "error": "empty_input"})
            continue
        lower = filename.lower()
        try:
            if lower.endswith(".docx") or data[:2] == b"PK":
                text, backend = _extract_docx(data)
            else:
                text, backend = _extract_doc(data)
            results.append({
                "filename": filename,
                "backend": backend,
                "chars": len(text),
                "result_text": text,
            })
            texts.append(f"===== {filename} =====\n{text}")
        except Exception as exc:
            errors.append({"filename": filename, "error": str(exc)})

    if not results:
        print(json.dumps({
            "status": "failed",
            "task_type": "word_to_text",
            "error": "全部文件解析失败",
            "errors": errors,
            "summary_text": "❌ 全部文件解析失败",
        }, ensure_ascii=False))
        return 1

    merged = "\n\n".join(texts)
    print(json.dumps({
        "status": "ok",
        "schema_version": "v1",
        "task_type": "word_to_text",
        "results": results,
        "errors": errors,
        "result_text": merged,
        "elapsed_ms": int((time.time() - t0) * 1000),
        "summary": {
            "file_count": len(results),
            "error_count": len(errors),
            "chars": len(merged),
        },
        "summary_text": f"✅ {len(results)} 个文件 · {len(merged)} 字",
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
