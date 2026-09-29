#!/usr/bin/env python3
"""
regex_extract.py — 正则批量提取（邮箱 / 手机号 / IP / URL）

输入：stdin 任意文本
输出：stdout schema v1
  result_lines: 提取到的所有匹配，格式 "<type>\t<value>"
  summary:      每种类型的命中数 + Top10 高频值
"""
import json
import os
import re
import sys
import time
from collections import Counter


PATTERNS = {
    "email": re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"),
    "mobile_cn": re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
    "ipv4": re.compile(r"(?<!\d)((?:25[0-5]|2[0-4]\d|[01]?\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d{1,2})(?!\d)"),
    "url": re.compile(r"https?://[^\s''<>]+"),
    "id_card_cn": re.compile(r"(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)"),
}
MAX_INPUT_BYTES = 10 * 1024 * 1024
MAX_MATCHES = 100_000


def _read_text() -> tuple[str, bytes]:
    raw = sys.stdin.buffer.read()
    if raw.strip():
        return raw.decode("utf-8", errors="replace"), raw
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if input_dir and os.path.isdir(input_dir):
        parts = []
        for fname in sorted(os.listdir(input_dir)):
            fp = os.path.join(input_dir, fname)
            if not os.path.isfile(fp) or fname.startswith(".") or fname == "input_manifest.v1.json":
                continue
            with open(fp, "r", encoding="utf-8", errors="replace") as fh:
                parts.append(fh.read())
        joined = "\n".join(parts)
        return joined, joined.encode("utf-8")
    return raw.decode("utf-8", errors="replace"), raw


def main() -> int:
    t0 = time.perf_counter()
    text, raw = _read_text()
    if len(raw) > MAX_INPUT_BYTES:
        print(json.dumps({
            "status": "failed", "task_type": "regex_extract", "contract_version": "1",
            "error": "输入超过 10MiB 上限",
        }, ensure_ascii=False))
        return 1

    type_counts = {}
    type_top = {}
    result_lines = []
    for name, pat in PATTERNS.items():
        matches = pat.findall(text)
        # findall 对带 group 的返回 tuple，规范化
        flat = []
        for m in matches:
            if isinstance(m, tuple):
                # 组合方式：拼回原匹配靠 finditer 更准
                continue
            flat.append(m)
        if not flat:
            # 用 finditer 兜底（拿原始 match string）
            flat = [m.group(0) for m in pat.finditer(text)]
        type_counts[name] = len(flat)
        ctr = Counter(flat)
        type_top[name] = ctr.most_common(10)
        for v in flat:
            if len(result_lines) >= MAX_MATCHES:
                break
            result_lines.append(f"{name}\t{v}")

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    summary = {
        "input_bytes": len(raw),
        "total_matches": sum(type_counts.values()),
        "returned_matches": len(result_lines),
        "truncated": sum(type_counts.values()) > len(result_lines),
        "by_type": type_counts,
    }
    lines = [
        f"  {name:>12s}：{count:>8,d}  Top1={(top[0][0] + '×' + str(top[0][1])) if top else 'n/a'}"
        for name, count in type_counts.items()
        for top in [type_top[name]]
    ]
    summary_text = (
        "═══════════════ 正则提取报告 ═══════════════\n"
        f"  输入字节数：  {summary['input_bytes']:>12,d}\n"
        f"  总命中数：    {summary['total_matches']:>12,d}\n"
        + "\n".join(lines) + "\n"
        f"  耗时：        {elapsed_ms:>12,d} ms\n"
        "═════════════════════════════════════════════\n"
    )
    out = {
        "status": "ok", "schema_version": "v1", "task_type": "regex_extract",
        "elapsed_ms": elapsed_ms, "summary": summary,
        "result_lines": result_lines,
        "duplicate_groups": [],
        "summary_text": summary_text,
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
