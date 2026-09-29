#!/usr/bin/env python3
"""json_validate — 批量 JSON / JSONL 语法验证 + 结构统计。"""
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse


def depth(obj, lvl=0):
    if isinstance(obj, dict):
        return max([depth(v, lvl + 1) for v in obj.values()] or [lvl])
    if isinstance(obj, list):
        return max([depth(v, lvl + 1) for v in obj] or [lvl])
    return lvl


def _read_inputs() -> list[tuple[str, str, bool]]:
    """返回 (文件名, 文本, 是否 JSONL)；multi/archive 从 EC_INPUT_DIR 读取。"""
    input_dir = os.environ.get("EC_INPUT_DIR", "").strip()
    if input_dir and os.path.isdir(input_dir):
        docs = []
        for path in sorted(Path(input_dir).rglob("*")):
            if not path.is_file() or path.suffix.lower() not in {".json", ".jsonl"}:
                continue
            docs.append((
                path.name,
                path.read_text(encoding="utf-8-sig", errors="replace"),
                path.suffix.lower() == ".jsonl",
            ))
        return docs

    raw = sys.stdin.read()
    input_ref = os.environ.get("EC_INPUT_REF", "").strip()
    name = unquote(Path(urlparse(input_ref).path).name) if input_ref else "stdin"
    is_jsonl = name.lower().endswith(".jsonl")
    if not input_ref and not is_jsonl:
        try:
            json.loads(raw)
        except json.JSONDecodeError:
            # inline/stdin 没有文件后缀时，多个非空行按历史 JSONL 契约处理。
            is_jsonl = len([line for line in raw.splitlines() if line.strip()]) > 1
    return [(name or "stdin", raw, is_jsonl)]


def _validate(text: str, filename: str, line_no: int | None = None) -> dict:
    row = {
        "filename": filename,
        "size": len(text.encode("utf-8")),
    }
    if line_no is not None:
        row["line"] = line_no
    try:
        obj = json.loads(text)
        row["valid"] = True
        row["type"] = type(obj).__name__
        row["depth"] = depth(obj)
        if isinstance(obj, dict):
            row["keys"] = len(obj)
        if isinstance(obj, list):
            row["items"] = len(obj)
    except json.JSONDecodeError as exc:
        row["valid"] = False
        row["error"] = f"line {exc.lineno} col {exc.colno}: {exc.msg}"
    return row


def main():
    t0 = time.time()
    try:
        inputs = _read_inputs()
        results = []
        for filename, text, is_jsonl in inputs:
            if is_jsonl:
                for line_no, line in enumerate(text.splitlines(), start=1):
                    if line.strip():
                        results.append(_validate(line, filename, line_no))
            elif text.strip():
                # 普通 .json 必须整份校验，不能把格式化后的多行 JSON 拆坏。
                results.append(_validate(text, filename))

        ok = sum(1 for row in results if row.get("valid"))
        fail = len(results) - ok
        max_depth = max((row.get("depth", 0) for row in results), default=0)
        elapsed = int((time.time() - t0) * 1000)
        print(json.dumps({
            "status": "ok",
            "schema_version": "v1",
            "task_type": "json_validate",
            "elapsed_ms": elapsed,
            "summary": {
                "files_total": len(inputs),
                "total": len(results),
                "valid": ok,
                "invalid": fail,
                "max_depth": max_depth,
            },
            "result": results,
            "result_lines": [
                json.dumps(row, ensure_ascii=False) for row in results
            ],
            "summary_text": (
                f"✅ JSON 验证完成\n📄 文件 {len(inputs)} 个 · 检查 {len(results)} 项\n"
                f"✓ 合法 {ok} · ✗ 不合法 {fail}\n📊 最深嵌套 {max_depth} 层"
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({
            "status": "failed",
            "task_type": "json_validate",
            "error": str(exc),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
