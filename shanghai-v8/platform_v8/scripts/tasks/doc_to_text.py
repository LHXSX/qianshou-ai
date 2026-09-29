#!/usr/bin/env python3
"""doc_to_text — 从旧版 .doc 提取纯文本 (律所/混合包原子技能)

优先级:
  1) antiword
  2) catdoc
  3) soffice --headless 转 docx 后再抽文本
都失败返回明确 error（禁止静默 skip）。
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


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _read_bytes() -> bytes:
    d = os.environ.get("EC_INPUT_DIR", "")
    if d and os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            if fn.lower().endswith(".doc") and not fn.lower().endswith(".docx"):
                with open(os.path.join(d, fn), "rb") as fh:
                    return fh.read()
        # 兜底：目录里任意二进制
        for fn in sorted(os.listdir(d)):
            p = os.path.join(d, fn)
            if os.path.isfile(p):
                with open(p, "rb") as fh:
                    return fh.read()
    return sys.stdin.buffer.read()


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
    with tempfile.TemporaryDirectory(prefix="doc_to_text_") as td:
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
    with tempfile.TemporaryDirectory(prefix="doc_to_text_lo_") as td:
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


def main() -> int:
    t0 = time.time()
    data = _read_bytes()
    if not data:
        print(json.dumps({"status": "error", "error": "empty_input", "result_text": ""}, ensure_ascii=False))
        return 1

    errors: list[str] = []
    text = ""
    backend = ""

    for name, which, builder in (
        ("antiword", "antiword", lambda: _run_tool(["antiword", "-w", "0"], data)),
        ("catdoc", "catdoc", lambda: _run_tool(["catdoc", "-w"], data)),
    ):
        if not shutil.which(which):
            errors.append(f"{name}_not_found")
            continue
        try:
            text = builder()
            backend = name
            break
        except Exception as exc:
            errors.append(f"{name}:{exc}")

    if not text:
        try:
            text = _via_soffice(data)
            backend = "soffice"
        except Exception as exc:
            errors.append(f"soffice:{exc}")

    if not text:
        print(json.dumps({
            "status": "error",
            "error": "doc_extract_failed: " + "; ".join(errors[:4]),
            "result_text": "",
            "backends_tried": errors,
        }, ensure_ascii=False))
        return 1

    elapsed_ms = int((time.time() - t0) * 1000)
    print(json.dumps({
        "status": "ok",
        "task_type": "doc_to_text",
        "backend": backend,
        "result_text": text,
        "text": text,
        "chars": len(text),
        "elapsed_ms": elapsed_ms,
        "params_echo": {k: _params().get(k) for k in ("lang",) if k in _params()},
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
