#!/usr/bin/env python3
"""field_stats — 字段统计/数据探查 (企业级 · 2026-06-07 S5 升级)

新增:
  - **header 行支持**(header=true 用首行列名)
  - **类型自动推断**(int/float/email/phone/date/url/id)
  - **质量评分**(null_ratio / unique_ratio / type_consistency_ratio)
  - **多 null 形式识别**(空 / NULL / null / N/A / NA / -)
  - **多 separator 自动嗅探**(| , \t ;)
  - **基数告警**(高 unique_ratio → 推断 ID;低 → 推断 enum)
  - **EC_PARAMS 统一**(ENV 兼容)

参数 (EC_PARAMS · ENV 兼容):
  separator        str    分隔符(默认自动嗅探)
  header           bool   首行作列名(默认 false)
  top_n            int    每字段 TopN (默认 10)
  null_markers     list   ["", "NULL", "null", "N/A", "NA", "-"]
  max_rows         int    最大处理行 (默认 1000000)
  emit_result_lines bool  返人类可读 result_lines (默认 true)
"""
import json
import os
import re
import sys
import time
from collections import Counter


_DEFAULT_NULLS = {"", "NULL", "null", "Null", "N/A", "NA", "n/a", "-", "--", "None", "none"}

_INT_RE = re.compile(r"^-?\d+$")
_FLOAT_RE = re.compile(r"^-?\d+\.\d+$|^-?\d+(?:\.\d+)?[eE][+-]?\d+$")
_EMAIL_RE = re.compile(r"^[\w.+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}$")
_PHONE_CN_RE = re.compile(r"^1[3-9]\d{9}$")
_DATE_RE = re.compile(r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{1,2}(?::\d{1,2})?)?Z?$")
_URL_RE = re.compile(r"^https?://[\w.-]+")
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _detect_type(v: str) -> str:
    """优先级:更具体 → 更通用 · phone/id_cn 先于 int"""
    if not v:
        return "null"
    # 更具体的数字模式先判
    if _PHONE_CN_RE.match(v):
        return "phone_cn"
    if len(v) == 18 and v[:17].isdigit() and (v[-1].isdigit() or v[-1] in "xX"):
        return "id_cn"
    if _UUID_RE.match(v):
        return "uuid"
    if _EMAIL_RE.match(v):
        return "email"
    if _DATE_RE.match(v):
        return "date"
    if _URL_RE.match(v):
        return "url"
    if _INT_RE.match(v):
        return "int"
    if _FLOAT_RE.match(v):
        return "float"
    return "string"


def _sniff_sep(sample: str) -> str:
    """简单嗅探:统计样本里 | , \\t ; 出现次数 · 取最多的"""
    counts = {sep: sample.count(sep) for sep in ["|", ",", "\t", ";"]}
    sep = max(counts, key=counts.get)
    if counts[sep] == 0:
        return "|"
    return sep


def _infer_column_kind(unique: int, total: int, types: dict) -> str:
    """根据基数 + 主导类型推断列性质"""
    if total == 0:
        return "empty"
    uniq_ratio = unique / total
    main_type = max(types, key=types.get) if types else "string"
    if uniq_ratio > 0.95 and main_type in ("int", "uuid", "id_cn", "string") and total > 10:
        return "id_or_key"  # 高基数 · 类 ID
    if uniq_ratio < 0.1 and total > 10:
        return "enum"  # 低基数 · 枚举
    if main_type in ("email", "phone_cn", "url"):
        return f"pii_{main_type}"
    if main_type == "date":
        return "datetime"
    if main_type in ("int", "float"):
        return "numeric"
    return "text"


def main() -> int:
    t0 = time.perf_counter()
    p = _params()

    raw = sys.stdin.buffer.read()
    text = raw.decode("utf-8", errors="replace")

    # 嗅探或指定 separator(EC_PARAMS > ENV > 自动)
    sep = p.get("separator") or os.environ.get("FIELD_SEP") or _sniff_sep(text[:4096])
    use_header = bool(p.get("header", False))
    top_n = max(1, min(100, int(p.get("top_n") or 10)))
    null_markers = set(p.get("null_markers") or _DEFAULT_NULLS)
    max_rows = max(1, int(p.get("max_rows") or 1_000_000))
    emit_result_lines = bool(p.get("emit_result_lines", True))

    raw_rows = [ln for ln in text.split("\n") if ln]
    truncated = False
    if len(raw_rows) > max_rows:
        raw_rows = raw_rows[:max_rows]
        truncated = True

    headers = []
    data_rows = raw_rows
    if use_header and raw_rows:
        headers = [h.strip() for h in raw_rows[0].split(sep)]
        data_rows = raw_rows[1:]

    total_rows = len(data_rows)
    unique_rows = len(set(data_rows))

    field_counters: list = []
    field_types: list = []
    null_counts: list = []

    for ln in data_rows:
        parts = ln.split(sep)
        for idx, val in enumerate(parts):
            while len(field_counters) <= idx:
                field_counters.append(Counter())
                field_types.append(Counter())
                null_counts.append(0)
            v = val.strip()
            if v in null_markers:
                null_counts[idx] += 1
                continue
            field_counters[idx][v] += 1
            field_types[idx][_detect_type(v)] += 1

    fields_report = []
    result_lines = []
    for idx, ctr in enumerate(field_counters):
        unique = len(ctr)
        nulls = null_counts[idx]
        non_null = sum(ctr.values())
        total_col = non_null + nulls
        types_d = dict(field_types[idx])
        main_type = max(types_d, key=types_d.get) if types_d else "null"
        type_consistency = (max(types_d.values()) / non_null) if non_null else 0
        kind = _infer_column_kind(unique, total_col, types_d)
        top = ctr.most_common(top_n)
        col_name = headers[idx] if idx < len(headers) else f"field_{idx}"
        fields_report.append({
            "field_index": idx,
            "name": col_name,
            "unique_values": unique,
            "null_count": nulls,
            "non_null_count": non_null,
            "null_ratio": round(nulls / max(1, total_col), 4),
            "unique_ratio": round(unique / max(1, non_null), 4) if non_null else 0,
            "main_type": main_type,
            "type_distribution": types_d,
            "type_consistency_ratio": round(type_consistency, 4),
            "inferred_kind": kind,
            "top": [{"value": v, "count": c} for v, c in top],
        })
        if emit_result_lines:
            result_lines.append(
                f"--- {col_name} (#{idx}) · type={main_type} kind={kind} · "
                f"unique={unique} null={nulls} ---"
            )
            for v, c in top:
                result_lines.append(f"  {c:>6d}  {v[:80]}")
            result_lines.append("")

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    summary = {
        "input_bytes": len(raw),
        "total_rows": total_rows,
        "unique_rows": unique_rows,
        "duplicate_rows": total_rows - unique_rows,
        "field_count": len(field_counters),
        "separator": sep,
        "header": use_header,
        "truncated": truncated,
        "max_rows": max_rows,
        "null_markers": sorted(null_markers),
    }

    parts_summary = []
    for f in fields_report[:20]:
        parts_summary.append(
            f"  {f['name']} ({f['inferred_kind']}/{f['main_type']}): "
            f"unique={f['unique_values']} null={f['null_count']} "
            f"(null_ratio={f['null_ratio']:.1%})"
        )
    summary_text = (
        "═══════════════ 字段统计 (升级版) ═══════════════\n"
        f"  输入字节:    {summary['input_bytes']:>12,d}\n"
        f"  总行数:      {total_rows:>12,d}{' (truncated)' if truncated else ''}\n"
        f"  唯一行:      {unique_rows:>12,d}\n"
        f"  字段数:      {len(field_counters):>12,d}\n"
        f"  分隔符:      {sep!r}\n"
        f"  header:      {use_header}\n"
        f"  耗时:        {elapsed_ms:>12,d} ms\n"
        + "\n".join(parts_summary) + "\n"
        "═════════════════════════════════════════════════\n"
    )

    out = {
        "status": "ok", "schema_version": "v1", "task_type": "field_stats",
        "elapsed_ms": elapsed_ms,
        "summary": summary,
        "fields": fields_report,
        "result_lines": result_lines if emit_result_lines else [],
        "duplicate_groups": [],
        "summary_text": summary_text,
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
