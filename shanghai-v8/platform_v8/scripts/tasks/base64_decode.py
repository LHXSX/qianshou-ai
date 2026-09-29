#!/usr/bin/env python3
"""base64_decode — 批量 Base64 解码。

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

        ok, fail = 0, 0
        results = []
        for l in lines:
            try:
                results.append({
                    "value": l,
                    "decoded": base64.b64decode(l).decode("utf-8", "replace"),
                })
                ok += 1
            except Exception:
                results.append({"value": l, "error": "invalid base64"})
                fail += 1

        elapsed = int((time.time() - t0) * 1000)
        print(json.dumps({
            "status": "ok",
            "schema_version": "v1",
            "task_type": "base64_decode",
            "elapsed_ms": elapsed,
            "summary": {"items": len(lines), "success": ok, "failed": fail},
            "result": results,
            "summary_text": (
                f"✅ Base64 解码完成\n"
                f"⚡ 用时 {elapsed}ms\n"
                f"📥 输入 {len(lines)} 项\n"
                f"✓ 成功 {ok} · ✗ 失败 {fail}"
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed",
            "task_type": "base64_decode",
            "error": str(e),
        }))
        return 1


if __name__ == "__main__":
    sys.exit(main())
