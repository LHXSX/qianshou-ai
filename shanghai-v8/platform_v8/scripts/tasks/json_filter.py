#!/usr/bin/env python3
"""json_filter — JSONL 过滤 + 投影 + 排序 (企业级 · 2026-06-07 S5 升级)

新增:
  - 多条件 (AND / OR)
  - nested key (`user.email` · `items.0.name`)
  - 排序 sort_by + limit / offset
  - EC_PARAMS 统一(env 兼容保留)

参数 (EC_PARAMS · 优先于 ENV):
  filters     list   条件数组 · 关系由 logic 决定
                     每条: {key, op, value}
                     op: == != in contains gt gte lt lte regex exists not_exists
  logic       str    AND (默认) / OR
  project     list   投影字段(支持 nested)
  sort_by     str    排序字段(支持 nested) · 加 "-" 前缀降序
  limit       int    保留前 N 条 (默认 0 = 不限)
  offset      int    跳过前 N 条 (默认 0)

环境变量(向后兼容老 agent · 仅 single filter):
  FILTER_KEY / FILTER_OP / FILTER_VALUE / PROJECT
"""
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _get_nested(obj: Any, key: str):
    """取嵌套字段 'user.email' / 'items.0.name'"""
    if not key:
        return None
    cur = obj
    for part in key.split("."):
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return cur


def _match_one(value, op: str, expected: Any) -> bool:
    """单条件匹配"""
    op = (op or "").lower()
    if op == "exists":
        return value is not None
    if op == "not_exists":
        return value is None
    if value is None:
        return False
    if op == "==":
        return str(value) == str(expected)
    if op == "!=":
        return str(value) != str(expected)
    if op == "in":  # value 在 expected 列表/字符串里
        return value in expected if isinstance(expected, (list, tuple)) else str(value) in str(expected)
    if op == "contains":  # value 字符串包含 expected
        return str(expected) in str(value)
    if op == "regex":
        try:
            return bool(re.search(str(expected), str(value)))
        except re.error:
            return False
    try:
        v = float(value)
        e = float(expected)
        if op == "gt":  return v > e
        if op == "gte": return v >= e
        if op == "lt":  return v < e
        if op == "lte": return v <= e
    except (ValueError, TypeError):
        return False
    return True  # 未知 op = 透传


def _apply_filters(obj: dict, filters: list, logic: str) -> bool:
    """多条件 · AND/OR"""
    if not filters:
        return True
    results = []
    for f in filters:
        key = f.get("key", "")
        op = f.get("op", "")
        expected = f.get("value")
        actual = _get_nested(obj, key)
        results.append(_match_one(actual, op, expected))
    if logic.upper() == "OR":
        return any(results)
    return all(results)


def _project(obj: dict, fields: list) -> dict:
    """投影 · 支持 nested key · 输出顶层用最后一段做 key"""
    if not fields:
        return obj
    out = {}
    for f in fields:
        v = _get_nested(obj, f)
        # 顶层用最后一段
        top_key = f.split(".")[-1]
        out[top_key] = v
    return out


def _legacy_filters_from_env() -> list:
    """向后兼容 · 老 agent 用 ENV"""
    key = os.environ.get("FILTER_KEY", "").strip()
    op = os.environ.get("FILTER_OP", "").strip()
    val = os.environ.get("FILTER_VALUE", "")
    if not (key and op):
        return []
    return [{"key": key, "op": op, "value": val}]


def _read_inputs() -> tuple[list[tuple[str, str]], int]:
    """读取 stdin 或 EC_INPUT_DIR，返回 [(文件名, 文本)] 与总字节数。"""
    input_dir = os.environ.get("EC_INPUT_DIR", "").strip()
    if input_dir and os.path.isdir(input_dir):
        docs: list[tuple[str, str]] = []
        total_bytes = 0
        for path in sorted(Path(input_dir).rglob("*")):
            if not path.is_file() or path.suffix.lower() not in {".json", ".jsonl"}:
                continue
            raw = path.read_bytes()
            total_bytes += len(raw)
            docs.append((path.name, raw.decode("utf-8-sig", errors="replace")))
        return docs, total_bytes

    raw = sys.stdin.buffer.read()
    return [("stdin", raw.decode("utf-8-sig", errors="replace"))], len(raw)


def _parse_records(text: str) -> tuple[list[dict], int, int]:
    """兼容标准 JSON 数组/对象和 JSONL，返回记录、输入数、错误数。"""
    stripped = text.strip()
    if not stripped:
        return [], 0, 0
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError:
        records: list[dict] = []
        input_count = 0
        bad_count = 0
        for line in text.splitlines():
            if not line.strip():
                continue
            input_count += 1
            try:
                item = json.loads(line)
            except Exception:
                bad_count += 1
                continue
            if isinstance(item, dict):
                records.append(item)
            else:
                bad_count += 1
        return records, input_count, bad_count

    if isinstance(value, dict):
        return [value], 1, 0
    if isinstance(value, list):
        records = [item for item in value if isinstance(item, dict)]
        return records, len(value), len(value) - len(records)
    return [], 1, 1


def main() -> int:
    t0 = time.perf_counter()
    p = _params()

    # filters: 优先 EC_PARAMS · 否则 ENV
    filters = p.get("filters") or _legacy_filters_from_env()
    logic = (p.get("logic") or "AND").upper()
    project = p.get("project")
    if project is None:
        # 兼容老 ENV PROJECT
        env_proj = [s.strip() for s in os.environ.get("PROJECT", "").split(",") if s.strip()]
        project = env_proj
    sort_by = p.get("sort_by", "")
    limit = min(max(0, int(p.get("limit") or 0)), 100_000)
    offset = int(p.get("offset") or 0)

    documents, input_bytes = _read_inputs()
    if input_bytes > 50 * 1024 * 1024:
        print(json.dumps({
            "status": "failed", "task_type": "json_filter", "contract_version": "1",
            "error": "输入超过 50MiB 上限",
        }, ensure_ascii=False))
        return 1

    in_count = 0
    matched_count = 0
    bad_count = 0
    matched_objs: list = []
    for _, text in documents:
        records, doc_count, doc_bad = _parse_records(text)
        in_count += doc_count
        bad_count += doc_bad
        for obj in records:
            if not _apply_filters(obj, filters, logic):
                continue
            matched_count += 1
            if len(matched_objs) >= 100_000:
                break
            matched_objs.append(obj)

    # 排序
    if sort_by:
        reverse = sort_by.startswith("-")
        key_str = sort_by.lstrip("-")
        def _sk(o):
            v = _get_nested(o, key_str)
            if v is None:
                return (1, 0)
            try:
                return (0, float(v))
            except (ValueError, TypeError):
                return (0, str(v))
        matched_objs.sort(key=_sk, reverse=reverse)

    # 分页
    sliced = matched_objs[offset: (offset + limit) if limit > 0 else len(matched_objs)]

    # 投影
    if project:
        sliced = [_project(o, project) for o in sliced]

    result_lines = [json.dumps(o, ensure_ascii=False) for o in sliced]

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    summary = {
        "input_bytes": input_bytes,
        "input_files": len(documents),
        "input_rows": in_count,
        "matched_rows": matched_count,
        "returned_rows": len(sliced),
        "parse_errors": bad_count,
        "filters": filters,
        "logic": logic,
        "projection": project or [],
        "sort_by": sort_by or None,
        "limit": limit, "offset": offset,
    }
    print(json.dumps({
        "status": "ok", "schema_version": "v1", "task_type": "json_filter",
        "elapsed_ms": elapsed_ms,
        "summary": summary,
        "result_lines": result_lines,
        "duplicate_groups": [],
        "summary_text": (
            f"✅ JSON 过滤 · 输入 {in_count} · 匹配 {matched_count} · "
            f"返回 {len(sliced)} · 错 {bad_count} · {elapsed_ms}ms"
        ),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
