#!/usr/bin/env python3
"""pdf_info — PDF 元数据 (页数/标题/作者/加密)"""
import base64
import json
import os
import sys
import time
from pathlib import Path


def _read_inputs() -> list[tuple[str, bytes]]:
    input_dir = os.environ.get("EC_INPUT_DIR", "").strip()
    if input_dir and os.path.isdir(input_dir):
        inputs = []
        for path in sorted(Path(input_dir).rglob("*")):
            if path.is_file() and path.suffix.lower() == ".pdf":
                inputs.append((path.name, path.read_bytes()))
        return inputs

    raw = sys.stdin.buffer.read()
    if raw[:1] in (b"{", b"["):
        try:
            wrapped = json.loads(raw)
            if isinstance(wrapped, dict) and wrapped.get("pdf_b64"):
                return [("inline.pdf", base64.b64decode(wrapped["pdf_b64"]))]
        except Exception:
            pass
    return [("input.pdf", raw)] if raw else []


def _inspect_pdf(filename: str, pdf_bytes: bytes) -> dict:
    import fitz

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        meta = doc.metadata or {}
        return {
            "filename": filename,
            "pages": len(doc),
            "title": meta.get("title", ""),
            "author": meta.get("author", ""),
            "subject": meta.get("subject", ""),
            "creator": meta.get("creator", ""),
            "producer": meta.get("producer", ""),
            "creation_date": meta.get("creationDate", ""),
            "modification_date": meta.get("modDate", ""),
            "is_encrypted": doc.is_encrypted,
            "is_pdf": True,
            "page_sizes": [
                {
                    "page": i + 1,
                    "width": page.rect.width,
                    "height": page.rect.height,
                }
                for i, page in enumerate(doc[:10])
            ],
            "size_bytes": len(pdf_bytes),
        }
    finally:
        doc.close()

def main():
    t0 = time.time()
    try:
        try:
            import fitz  # noqa: F401
        except ImportError:
            print(json.dumps({
                "status": "failed",
                "task_type": "pdf_info",
                "error": "节点缺 PyMuPDF",
            }, ensure_ascii=False))
            return 1

        inputs = _read_inputs()
        if not inputs:
            print(json.dumps({
                "status": "failed",
                "task_type": "pdf_info",
                "error": "无输入 PDF · 检查 EC_INPUT_DIR / stdin",
            }, ensure_ascii=False))
            return 1

        results = []
        errors = []
        for filename, pdf_bytes in inputs:
            try:
                if not pdf_bytes:
                    raise ValueError("PDF 数据为空")
                results.append(_inspect_pdf(filename, pdf_bytes))
            except Exception as exc:
                errors.append({"filename": filename, "error": str(exc)})

        elapsed = int((time.time() - t0) * 1000)
        if not results:
            print(json.dumps({
                "status": "failed",
                "task_type": "pdf_info",
                "elapsed_ms": elapsed,
                "error": "所有 PDF 信息读取失败",
                "errors": errors,
            }, ensure_ascii=False))
            return 1

        total_pages = sum(int(item["pages"]) for item in results)
        total_bytes = sum(int(item["size_bytes"]) for item in results)
        print(json.dumps({
            "status": "ok",
            "schema_version": "v1",
            "task_type": "pdf_info",
            "elapsed_ms": elapsed,
            "results": results,
            "errors": errors,
            "summary": {
                "files_total": len(inputs),
                "files_ok": len(results),
                "files_failed": len(errors),
                "pages": total_pages,
                "size_bytes": total_bytes,
            },
            "summary_text": (
                f"✅ PDF 信息读取完成\n"
                f"📄 成功 {len(results)}/{len(inputs)} 个 · 共 {total_pages} 页\n"
                f"💾 总大小 {total_bytes // 1024} KB"
                + (f"\n⚠️ 失败 {len(errors)} 个" if errors else "")
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({
            "status": "failed",
            "task_type": "pdf_info",
            "error": str(exc),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
