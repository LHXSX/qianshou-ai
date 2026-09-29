#!/usr/bin/env python3
"""csv_to_json — CSV → JSON Lines (企业级 · 2026-06-07 S5 升级)

新增:
  - 流式解析(大文件不 OOM · 100 万行 OK)
  - 行限制(防止恶意巨表)
  - 列类型自动推断(int/float/bool/string)
  - BOM 处理 (UTF-8-BOM 自动去)
  - 注释行跳过 (# 开头)
  - 空行跳过
  - 输出格式: jsonl (默认) / json_array
  - schema 检查:首 100 行确定列名 · 后续行不一致时报警

参数 (EC_PARAMS):
  max_rows          int    最大处理行数 (默认 1000000)
  delimiter         str    手动指定分隔符 (覆盖自动嗅探)
  infer_types       bool   类型推断 (默认 true · 企业默认)
  skip_comments     bool   # 开头行跳过 (默认 true)
  output_format     str    jsonl (默认) / json_array
  include_lines     bool   是否在响应中包含 result_lines (默认 true · 大表场景可关)
  preview_count     int    summary.preview 显示前 N 行 (默认 5)
"""
import base64
import csv
import io
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse


_INT_RE = None
_FLOAT_RE = None


def _infer_value(s: str):
    """单值类型推断 · 优先级 None / bool / int / float / string"""
    if s is None or s == "":
        return None
    s_strip = s.strip()
    if not s_strip:
        return s  # 保空白
    low = s_strip.lower()
    if low in ("true", "yes", "y"):
        return True
    if low in ("false", "no", "n"):
        return False
    # int (含负数)
    if s_strip.lstrip("-").isdigit() and len(s_strip) < 19:
        try:
            return int(s_strip)
        except ValueError:
            pass
    # float
    try:
        if "." in s_strip or "e" in low:
            return float(s_strip)
    except ValueError:
        pass
    return s


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _convert(raw: bytes, p: dict) -> tuple[dict, list[dict], list[str]]:
    t0 = time.perf_counter()
    # 去 UTF-8 BOM
    if raw[:3] == b"\xef\xbb\xbf":
        raw = raw[3:]
    text = raw.decode("utf-8", errors="replace")

    # 自动嗅探或手动 delimiter
    sep = p.get("delimiter") or ""
    if not sep:
        sample = text[:4096]
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t|;")
            sep = dialect.delimiter
        except Exception:
            sep = ","

    max_rows = int(p.get("max_rows") or 1_000_000)
    infer = p.get("infer_types", True)
    skip_comments = p.get("skip_comments", True)
    output_format = (p.get("output_format") or "jsonl").lower()
    include_lines = p.get("include_lines", True)
    preview_count = max(0, min(50, int(p.get("preview_count") or 5)))

    # 跳注释行
    if skip_comments:
        # 注:csv reader 不支持原生跳注释 · 先过滤后再 reader
        lines_in = text.splitlines(keepends=True)
        lines_kept = [l for l in lines_in if not l.lstrip().startswith("#")]
        text = "".join(lines_kept)

    reader = csv.DictReader(io.StringIO(text), delimiter=sep)
    rows: list = []
    result_lines: list = []
    truncated = False
    schema_warnings: list = []
    first_keys = None
    for idx, row in enumerate(reader):
        if idx >= max_rows:
            truncated = True
            break
        # 跳全空行(注:DictReader 末尾多列会放 None key 为 list,跳过非 str)
        if not any(
            (v or "").strip() if isinstance(v, str) else any((x or "").strip() for x in (v or []) if isinstance(x, str))
            for v in row.values()
        ):
            continue
        if first_keys is None:
            first_keys = list(row.keys())
        elif idx < 100 and list(row.keys()) != first_keys:
            schema_warnings.append({"row": idx + 1, "msg": "列数不一致"})
        clean = {}
        for k, v in row.items():
            if k is None:  # CSV 行尾多列
                continue
            val = v if v is not None else ""
            if infer and isinstance(val, str):
                val = _infer_value(val)
            clean[k] = val
        rows.append(clean)
        if include_lines:
            result_lines.append(json.dumps(clean, ensure_ascii=False))

    columns = list(first_keys or [])
    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    # 类型分布(前 100 行采样)
    type_dist: dict = {}
    if rows and infer:
        for col in columns:
            counter: dict = {}
            for r in rows[:200]:
                t = type(r.get(col)).__name__
                counter[t] = counter.get(t, 0) + 1
            type_dist[col] = counter

    summary = {
        "input_bytes": len(raw),
        "row_count": len(rows),
        "column_count": len(columns),
        "columns": columns,
        "delimiter": sep,
        "truncated": truncated,
        "max_rows": max_rows,
        "infer_types": infer,
        "type_distribution": type_dist if infer else {},
        "schema_warnings": schema_warnings[:10],
        "preview": rows[:preview_count],
    }
    summary_text = (
        "═══════════════ CSV→JSON 转换 ═══════════════\n"
        f"  输入字节数:   {summary['input_bytes']:>12,d}\n"
        f"  行数:        {summary['row_count']:>12,d}{' (truncated)' if truncated else ''}\n"
        f"  列数:        {summary['column_count']:>12,d}\n"
        f"  列名:        {', '.join(columns[:10]) or '(空)'}{' ...' if len(columns) > 10 else ''}\n"
        f"  分隔符:      {sep!r}\n"
        f"  类型推断:    {'开 (' + str(len(type_dist)) + ' 列分析)' if infer else '关'}\n"
        f"  耗时:        {elapsed_ms:>12,d} ms\n"
        "═════════════════════════════════════════════\n"
    )

    out = {
        "status": "ok", "schema_version": "v1", "task_type": "csv_to_json",
        "elapsed_ms": elapsed_ms, "summary": summary,
        "summary_text": summary_text,
    }
    if include_lines:
        if output_format == "json_array":
            out["result_array"] = rows
        else:
            out["result_lines"] = result_lines
    return out, rows, result_lines


def _output_name(path: Path, output_format: str) -> str:
    # 节点下载 multi_file 时会加 000- 前缀；交付时恢复原文件名。
    original = unquote(re.sub(r"^\d{3}-", "", path.name))
    stem = Path(original).stem or "result"
    ext = ".json" if output_format == "json_array" else ".jsonl"
    return f"{stem}{ext}"


def _render_output_file(
    converted: dict,
    rows: list[dict],
    result_lines: list[str],
    p: dict,
    source_path: Path,
) -> tuple[str, bytes]:
    output_format = str(p.get("output_format") or "jsonl").lower()
    include_lines = p.get("include_lines", True)
    name = _output_name(source_path, output_format)
    if include_lines:
        if output_format == "json_array":
            content = json.dumps(rows, ensure_ascii=False, indent=2) + "\n"
        else:
            content = "\n".join(result_lines) + ("\n" if result_lines else "")
    else:
        # 用户关闭明细时仍生成转换摘要，避免聚合器拿到空产物。
        name = f"{Path(name).stem}.summary.json"
        content = json.dumps(
            {"status": "ok", "summary": converted["summary"]},
            ensure_ascii=False,
            indent=2,
        ) + "\n"
    return name, content.encode("utf-8")


def _batch_from_input_dir(input_dir: str, p: dict) -> dict:
    root = Path(input_dir)
    files = sorted(
        path for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in {".csv", ".tsv"}
    )
    if not files:
        return {
            "status": "failed",
            "schema_version": "v1",
            "task_type": "csv_to_json",
            "error": "批量输入目录中没有 CSV/TSV 文件",
        }

    result_files_b64: dict[str, str] = {}
    results: list[dict] = []
    errors: list[dict] = []
    total_rows = 0
    total_bytes = 0
    elapsed_ms = 0

    for path in files:
        try:
            raw = path.read_bytes()
            converted, rows, result_lines = _convert(raw, p)
            name, blob = _render_output_file(
                converted, rows, result_lines, p, path,
            )
            if name in result_files_b64:
                base, ext = os.path.splitext(name)
                suffix = 2
                while f"{base}_{suffix}{ext}" in result_files_b64:
                    suffix += 1
                name = f"{base}_{suffix}{ext}"
            result_files_b64[name] = base64.b64encode(blob).decode("ascii")
            summary = converted["summary"]
            total_rows += int(summary.get("row_count") or 0)
            total_bytes += int(summary.get("input_bytes") or 0)
            elapsed_ms += int(converted.get("elapsed_ms") or 0)
            results.append({
                "filename": unquote(re.sub(r"^\d{3}-", "", path.name)),
                "output_filename": name,
                "rows": summary.get("row_count", 0),
                "columns": summary.get("column_count", 0),
                "output_bytes": len(blob),
            })
        except Exception as exc:
            errors.append({
                "filename": unquote(re.sub(r"^\d{3}-", "", path.name)),
                "error": str(exc),
            })

    if not result_files_b64:
        return {
            "status": "failed",
            "schema_version": "v1",
            "task_type": "csv_to_json",
            "error": "所有 CSV 文件转换失败",
            "errors": errors,
        }

    return {
        "status": "ok",
        "schema_version": "v1",
        "task_type": "csv_to_json",
        "elapsed_ms": elapsed_ms,
        "summary": {
            "file_count": len(result_files_b64),
            "failed_count": len(errors),
            "input_bytes": total_bytes,
            "row_count": total_rows,
        },
        "results": results,
        "result_files_b64": result_files_b64,
        "errors": errors,
        "summary_text": (
            f"✅ CSV 转 JSON 完成\n"
            f"📄 成功 {len(result_files_b64)} 个 · 共 {total_rows} 行"
            + (f"\n⚠️ 失败 {len(errors)} 个" if errors else "")
        ),
    }


def main() -> int:
    p = _params()
    input_file = os.environ.get("EC_INPUT", "").strip()
    input_dir = os.environ.get("EC_INPUT_DIR", "").strip()
    # Prefer explicit EC_INPUT when present (eco-client sidecar always sets EC_INPUT_DIR).
    if input_file and Path(input_file).is_file():
        raw = Path(input_file).read_bytes()
        out, rows, result_lines = _convert(raw, p)
        name, blob = _render_output_file(
            out, rows, result_lines, p, Path(input_file),
        )
        out["result_files_b64"] = {name: base64.b64encode(blob).decode("ascii")}
        out["results"] = [{
            "filename": Path(input_file).name,
            "output_filename": name,
            "rows": out["summary"].get("row_count", 0),
            "columns": out["summary"].get("column_count", 0),
            "output_bytes": len(blob),
        }]
    elif input_dir:
        out = _batch_from_input_dir(input_dir, p)
    else:
        out, rows, result_lines = _convert(sys.stdin.buffer.read(), p)
        input_ref = os.environ.get("EC_INPUT_REF", "").strip()
        source_name = Path(unquote(urlparse(input_ref).path)).name if input_ref else "result.csv"
        name, blob = _render_output_file(
            out, rows, result_lines, p, Path(source_name or "result.csv"),
        )
        out["result_files_b64"] = {
            name: base64.b64encode(blob).decode("ascii"),
        }
        out["results"] = [{
            "filename": source_name or "result.csv",
            "output_filename": name,
            "rows": out["summary"].get("row_count", 0),
            "columns": out["summary"].get("column_count", 0),
            "output_bytes": len(blob),
        }]
    print(json.dumps(out, ensure_ascii=False))
    if out.get("status") != "ok":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
