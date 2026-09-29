#!/usr/bin/env python3
"""docx_to_text — 从 .docx 提取纯文本 (律所/混合包原子技能)

优先 python-docx; 否则 zip+document.xml 去标签兜底.
"""
import json
import os
import re
import sys
import time
import zipfile
from io import BytesIO
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
        files = [
            fn for fn in sorted(os.listdir(d))
            if fn != "input_manifest.v1.json"
            and os.path.isfile(os.path.join(d, fn))
        ]
        if len(files) != 1 or not files[0].lower().endswith(".docx"):
            raise ValueError(
                f"docx_to_text 每片必须恰好包含 1 个 .docx 文件，实际文件={files}"
            )
        with open(os.path.join(d, files[0]), "rb") as fh:
            return fh.read()
    return sys.stdin.buffer.read()


def _extract_python_docx(data: bytes) -> str:
    from docx import Document
    doc = Document(BytesIO(data))
    return "\n".join(p.text for p in doc.paragraphs if p.text).strip()


def _extract_xml(data: bytes) -> str:
    with zipfile.ZipFile(BytesIO(data)) as zf:
        xml = zf.read("word/document.xml")
    root = ET.fromstring(xml)
    texts = []
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


def main() -> int:
    t0 = time.time()
    try:
        data = _read_bytes()
    except ValueError as exc:
        print(json.dumps({
            "status": "error",
            "error": f"input_contract_failed: {exc}",
            "result_text": "",
        }, ensure_ascii=False))
        return 1
    if not data:
        print(json.dumps({"status": "error", "error": "empty_input", "result_text": ""}, ensure_ascii=False))
        return 1
    text = ""
    backend = "xml"
    try:
        text = _extract_python_docx(data)
        backend = "python-docx"
    except Exception:
        try:
            text = _extract_xml(data)
        except Exception as exc:
            print(json.dumps({
                "status": "error",
                "error": f"docx_parse_failed: {exc}",
                "result_text": "",
            }, ensure_ascii=False))
            return 1
    print(json.dumps({
        "status": "ok",
        "schema_version": "v1",
        "task_type": "docx_to_text",
        "backend": backend,
        "result_text": text,
        "elapsed_ms": int((time.time() - t0) * 1000),
        "summary": {"chars": len(text)},
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
