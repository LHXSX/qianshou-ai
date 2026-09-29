#!/usr/bin/env python3
"""base64_encode — 批量 Base64 编码。

输入优先级:
  1. EC_INPUT_DIR（multi_file / archive · 节点把文件下到临时目录）
  2. stdin JSON · lines / params.lines
  3. stdin 纯文本 · 按行
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
from pathlib import Path


def _lines_from_dir(input_dir: str) -> list[str]:
    lines: list[str] = []
    root = Path(input_dir)
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.name.startswith("."):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        lines.extend(l for l in text.splitlines() if l)
    return lines


def _lines_from_stdin(raw: str) -> list[str]:
    txt = raw.lstrip()
    if txt.startswith("{") or txt.startswith("["):
        obj = json.loads(raw)
        lines = obj.get("lines") or (obj.get("params") or {}).get("lines") or []
        return [str(x) for x in lines if str(x)]
    return [l for l in raw.splitlines() if l]


def main() -> int:
    t0 = time.time()
    try:
        input_dir = os.environ.get("EC_INPUT_DIR", "").strip()
        if input_dir and os.path.isdir(input_dir):
            lines = _lines_from_dir(input_dir)
        else:
            try:
                raw = sys.stdin.read()
            except Exception as e:
                print(json.dumps({"status": "failed", "error": f"stdin:{e}"}))
                return 1
            lines = _lines_from_stdin(raw)

        results = [
            {"value": l, "base64": base64.b64encode(l.encode()).decode()}
            for l in lines
        ]
        elapsed = int((time.time() - t0) * 1000)
        out_bytes = sum(len(r["base64"]) for r in results)
        print(json.dumps({
            "status": "ok",
            "schema_version": "v1",
            "task_type": "base64_encode",
            "elapsed_ms": elapsed,
            "summary": {
                "items": len(lines),
                "input_bytes": sum(len(l) for l in lines),
                "output_bytes": out_bytes,
            },
            "result": results,
            "summary_text": (
                f"✅ Base64 编码完成\n"
                f"⚡ 用时 {elapsed}ms\n"
                f"📥 输入 {len(lines)} 项\n"
                f"📤 编码后总字节 {out_bytes}"
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed",
            "task_type": "base64_encode",
            "error": str(e),
        }))
        return 1


if __name__ == "__main__":
    sys.exit(main())
