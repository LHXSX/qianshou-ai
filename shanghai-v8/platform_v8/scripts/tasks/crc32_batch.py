#!/usr/bin/env python3
"""crc32_batch — 批量计算 CRC32 校验码（每行一项内容）。

输入优先级:
  1. EC_INPUT_DIR（multi_file / archive）
  2. stdin JSON · lines / params.lines
  3. stdin 纯文本 · 按行
"""
from __future__ import annotations

import json
import os
import sys
import time
import zlib
from pathlib import Path


def _lines_from_dir(input_dir: str) -> list[str]:
    lines: list[str] = []
    root = Path(input_dir)
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.name.startswith("."):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if text and not text.endswith("\n"):
            text += "\n"
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
            {"value": l, "crc32": f"{zlib.crc32(l.encode()):08x}"}
            for l in lines
        ]
        result_lines = [f"{r['crc32']}\t{r['value']}" for r in results]
        elapsed = int((time.time() - t0) * 1000)
        total_bytes = sum(len(l) for l in lines)
        print(json.dumps({
            "status": "ok",
            "schema_version": "v1",
            "task_type": "crc32_batch",
            "elapsed_ms": elapsed,
            "summary": {
                "items": len(lines),
                "total_bytes": total_bytes,
                "algorithm": "crc32",
            },
            "result": results,
            "result_lines": result_lines,
            "summary_text": (
                f"✅ CRC32 批量计算完成\n"
                f"⚡ 用时 {elapsed}ms\n"
                f"📥 处理 {len(lines)} 项\n"
                f"💾 总字节 {total_bytes}"
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed",
            "task_type": "crc32_batch",
            "error": str(e),
        }))
        return 1


if __name__ == "__main__":
    sys.exit(main())
