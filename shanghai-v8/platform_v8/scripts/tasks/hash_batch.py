#!/usr/bin/env python3
"""
hash_batch.py — 批量哈希校验（SHA256 / MD5 / SHA1）
适配千手引擎 run_script 协议 (EC_PARAMS + EC_INPUT_DIR + stdin fallback)

输入优先级:
  1. EC_INPUT_DIR（按文件名排序 · 文件间强制换行，避免粘行）
  2. EC_PARAMS.inline_input / text / lines
  3. stdin JSON · lines / params.lines
  4. stdin 纯文本 · 按行

EC_PARAMS.algorithm: sha256 | md5 | sha1（默认 sha256）
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path


def _algo_name(params: dict) -> str:
    raw = str(params.get("algorithm") or params.get("algo") or "sha256").strip().lower()
    if raw in ("sha256", "sha-256"):
        return "sha256"
    if raw in ("md5",):
        return "md5"
    if raw in ("sha1", "sha-1"):
        return "sha1"
    return "sha256"


def _digest(algo: str, text: str) -> str:
    data = text.encode("utf-8")
    if algo == "md5":
        return hashlib.md5(data).hexdigest()
    if algo == "sha1":
        return hashlib.sha1(data).hexdigest()
    return hashlib.sha256(data).hexdigest()


def _lines_from_dir(input_dir: str) -> list[str]:
    lines: list[str] = []
    root = Path(input_dir)
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.name.startswith("."):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        # 文件末尾无换行时补上，避免与下一文件首行粘连
        if text and not text.endswith("\n"):
            text += "\n"
        lines.extend(l for l in text.splitlines() if l.strip())
    return lines


def _lines_from_text(text: str) -> list[str]:
    txt = (text or "").lstrip()
    if txt.startswith("{") or txt.startswith("["):
        obj = json.loads(text)
        if isinstance(obj, list):
            return [str(x) for x in obj if str(x).strip()]
        lines = obj.get("lines") or (obj.get("params") or {}).get("lines") or []
        if lines:
            return [str(x) for x in lines if str(x).strip()]
        nested = obj.get("text") or obj.get("inline_input") or ""
        return [l for l in str(nested).splitlines() if l.strip()]
    return [l for l in (text or "").splitlines() if l.strip()]


def main() -> int:
    t0 = time.time()
    params = {}
    try:
        params = json.loads(os.environ.get("EC_PARAMS", "{}") or "{}")
    except Exception:
        params = {}
    if not isinstance(params, dict):
        params = {}

    algo = _algo_name(params)
    lines: list[str] = []

    input_dir = os.environ.get("EC_INPUT_DIR", "").strip()
    if input_dir and os.path.isdir(input_dir):
        lines = _lines_from_dir(input_dir)
    elif params.get("lines"):
        lines = [str(x) for x in params["lines"] if str(x).strip()]
    elif params.get("inline_input") or params.get("text"):
        lines = _lines_from_text(str(params.get("text") or params.get("inline_input") or ""))
    else:
        try:
            raw = sys.stdin.read()
        except Exception:
            raw = ""
        lines = _lines_from_text(raw)

    results = []
    for line in lines:
        digest = _digest(algo, line)
        results.append({
            "input": line,
            "algorithm": algo,
            "hash": digest,
            # 兼容旧预览字段
            "sha256_prefix": digest[:16] if algo == "sha256" else digest[:16],
        })

    result_lines = [f"{r['hash']}\t{r['input']}" for r in results]
    elapsed = int((time.time() - t0) * 1000)
    output = {
        "status": "ok",
        "task_type": "hash_batch",
        "schema_version": "v1",
        "input_lines": len(lines),
        "results": results,
        "result": results,
        "result_lines": result_lines,
        "elapsed_ms": elapsed,
        "summary": {
            "total": len(lines),
            "ok": len(results),
            "algorithm": algo,
        },
        "summary_text": f"✅ 批量哈希完成 ({algo})\n⚡ 用时 {elapsed}ms\n📥 处理 {len(lines)} 行",
    }
    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
