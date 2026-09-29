#!/usr/bin/env python3
"""dedup_lines — 去重 (企业级 · 2026-06-07 S5 升级)

新增:
  - **normalize 模糊去重**:strip / lowercase / collapse_whitespace 选项
  - **JSONL key 去重**:每行 JSON · 按 dedup_key 字段去重(嵌套 user.email 支持)
  - **keep 策略**:first(默认) / last (保留最后一次)
  - **min_count 过滤**:仅返出现 ≥N 次的(找热门)
  - **EC_PARAMS 统一**(向后兼容 stdin.params)

参数 (EC_PARAMS · 优先 stdin.params):
  normalize           list   ["strip","lower","collapse_ws"] 任意组合
  dedup_key           str    JSONL 模式 · 按字段去重(支持 nested user.email)
  keep                str    first / last (默认 first)
  min_count           int    只返出现 ≥N 次的(默认 1 = 全要)
  max_return_lines    int    防爆截断(默认 200000)
  max_dup_groups      int    duplicate_groups 数组上限(默认 5000)
"""
import hashlib
import json
import os
import re
import sys
import time
from collections import OrderedDict


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _get_nested(obj, key: str):
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


def _normalize(s: str, ops: list) -> str:
    if not ops:
        return s
    out = s
    if "lower" in ops:
        out = out.lower()
    if "collapse_ws" in ops:
        out = re.sub(r"\s+", " ", out)
    if "strip" in ops:
        out = out.strip()
    return out


def main() -> int:
    t0 = time.time()
    p = _params()
    try:
        raw_input = sys.stdin.read()
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": f"stdin: {exc}"}))
        return 1

    input_bytes = len(raw_input.encode("utf-8"))
    sha_input = hashlib.sha256(raw_input.encode("utf-8")).hexdigest()[:16]

    # 解析输入
    lines: list = []
    txt = raw_input.lstrip()
    if txt.startswith("{") or txt.startswith("["):
        try:
            obj = json.loads(raw_input)
            if isinstance(obj, list):
                lines = [str(x) for x in obj]
            elif isinstance(obj, dict):
                merged = dict(obj.get("params") or {})
                merged.update(p)
                p = merged
                if isinstance(obj.get("lines"), list):
                    lines = [str(x) for x in obj["lines"]]
                else:
                    params_lines = (obj.get("params") or {}).get("lines")
                    if isinstance(params_lines, list):
                        lines = [str(x) for x in params_lines]
                    elif isinstance((obj.get("params") or {}).get("text"), str):
                        lines = obj["params"]["text"].splitlines()
                    else:
                        lines = raw_input.splitlines()
            else:
                lines = raw_input.splitlines()
        except json.JSONDecodeError:
            lines = raw_input.splitlines()
    else:
        lines = raw_input.splitlines()

    normalize_ops = p.get("normalize") or []
    if isinstance(normalize_ops, str):
        normalize_ops = [normalize_ops]
    dedup_key = p.get("dedup_key") or ""
    keep = (p.get("keep") or "first").lower()
    min_count = max(1, int(p.get("min_count") or 1))
    max_return = max(1, int(p.get("max_return_lines") or 200_000))
    max_dups = max(0, int(p.get("max_dup_groups") or 5000))

    # 计算 key & 保留显示值
    items: list = []
    if dedup_key:
        for ln in lines:
            try:
                obj = json.loads(ln)
            except Exception:
                k = _normalize(ln, normalize_ops)
                items.append((k, ln))
                continue
            v = _get_nested(obj, dedup_key)
            if v is None:
                k = json.dumps(obj, ensure_ascii=False, sort_keys=True)
            else:
                k = _normalize(str(v), normalize_ops)
            items.append((k, ln))
    else:
        for ln in lines:
            k = _normalize(ln, normalize_ops)
            items.append((k, ln))

    # 保序聚合
    agg: "OrderedDict[str, dict]" = OrderedDict()
    for k, ln in items:
        if k in agg:
            agg[k]["count"] += 1
            agg[k]["last_line"] = ln
        else:
            agg[k] = {"first_line": ln, "last_line": ln, "count": 1}

    # 输出 + min_count 过滤
    unique_lines = []
    for k, info in agg.items():
        if info["count"] < min_count:
            continue
        unique_lines.append(info["last_line"] if keep == "last" else info["first_line"])

    duplicate_groups_full = [(k, info["count"], info["first_line"])
                             for k, info in agg.items() if info["count"] > 1]
    duplicate_groups_full.sort(key=lambda x: (-x[1], x[0]))
    duplicate_rows = sum(c - 1 for _, c, _ in duplicate_groups_full)

    sha_unique = hashlib.sha256("\n".join(unique_lines).encode("utf-8")).hexdigest()[:16]
    elapsed_ms = int((time.time() - t0) * 1000)

    summary = {
        "input_rows":       len(lines),
        "input_bytes":      input_bytes,
        "unique_rows":      len(agg),
        "returned_rows":    len(unique_lines),
        "duplicate_rows":   duplicate_rows,
        "duplicate_groups": len(duplicate_groups_full),
        "sha256_input":     sha_input,
        "sha256_unique":    sha_unique,
        "normalize":        list(normalize_ops),
        "dedup_key":        dedup_key or None,
        "keep":             keep,
        "min_count":        min_count,
    }

    top_dups = duplicate_groups_full[:5]
    top_dups_str = (
        "\n".join(f"  {c} × {(v if len(v) <= 80 else v[:80] + '...')}"
                  for _, c, v in top_dups)
        if top_dups else "  (无重复)"
    )
    summary_text = (
        "═════════════════════════════════════════════\n"
        f"  去重报告 (dedup_lines v1 升级版)\n"
        "═════════════════════════════════════════════\n"
        f"  原始:        {len(lines):>10,} 行 / {input_bytes:>10,} 字节\n"
        f"  唯一值:      {len(agg):>10,}\n"
        f"  返回:        {len(unique_lines):>10,} 行\n"
        f"  重复:        {duplicate_rows:>10,} 行 ({len(duplicate_groups_full)} 组)\n"
        f"  归一化:      {', '.join(normalize_ops) or '(无)'}\n"
        f"  去重 key:    {dedup_key or '(整行)'}\n"
        f"  保留策略:    {keep}\n"
        f"  min_count:   {min_count}\n"
        f"  输入哈希:    {sha_input}\n"
        f"  去重哈希:    {sha_unique}\n"
        f"  耗时:        {elapsed_ms} ms\n"
        "─────────────────────────────────────────────\n"
        f"  TOP 5 重复:\n{top_dups_str}\n"
        "═════════════════════════════════════════════\n"
    )

    truncated = False
    if len(unique_lines) > max_return:
        unique_lines = unique_lines[:max_return]
        truncated = True

    out = {
        "status": "ok", "schema_version": "v1", "task_type": "dedup_lines",
        "elapsed_ms": elapsed_ms,
        "summary": summary,
        "result_lines": unique_lines,
        "duplicate_groups": [
            {"value": v if len(v) <= 200 else v[:200] + "...", "count": c}
            for _, c, v in duplicate_groups_full[:max_dups]
        ],
        "summary_text": summary_text,
    }
    if truncated:
        out["truncated_result_lines"] = True

    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
