#!/usr/bin/env python3
"""line_count — 统计行数（总行/空行/非空/平均长度）。"""
import json, os, sys, time


def _read_text() -> str:
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""
    if raw.strip():
        return raw
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if input_dir and os.path.isdir(input_dir):
        parts = []
        for fname in sorted(os.listdir(input_dir)):
            fp = os.path.join(input_dir, fname)
            if not os.path.isfile(fp) or fname.startswith(".") or fname == "input_manifest.v1.json":
                continue
            with open(fp, "r", encoding="utf-8", errors="replace") as fh:
                parts.append(fh.read())
        return "\n".join(parts)
    return raw


def main():
    t0 = time.time()
    try:
        raw = _read_text()
    except Exception as e:
        print(json.dumps({"status":"failed","error":f"stdin:{e}"})); return 1
    try:
        lines = raw.splitlines()
        total = len(lines)
        empty = sum(1 for l in lines if not l.strip())
        non_empty = total - empty
        avg_len = sum(len(l) for l in lines) / max(1,total)
        longest = max((len(l) for l in lines), default=0)
        shortest = min((len(l) for l in lines if l), default=0)
        elapsed = int((time.time()-t0)*1000)
        print(json.dumps({
            "status":"ok","schema_version":"v1","task_type":"line_count",
            "elapsed_ms":elapsed,
            "summary":{"total":total,"empty":empty,"non_empty":non_empty,
                       "avg_length":round(avg_len,2),"longest":longest,"shortest":shortest,
                       "total_bytes":len(raw.encode())},
            "summary_text":f"✅ 行数统计完成\n📊 总行数 {total}\n   ├ 非空 {non_empty} 行\n   └ 空白 {empty} 行\n📏 平均长度 {round(avg_len,2)} 字符\n📏 最长 {longest} · 最短 {shortest}",
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"status":"failed","task_type":"line_count","error":str(e)})); return 1

if __name__ == "__main__": sys.exit(main())
