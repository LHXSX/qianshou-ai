#!/usr/bin/env python3
"""文本去重 — 适配千手引擎 run_script 协议"""
import os, json, hashlib

input_dir = os.environ.get("EC_INPUT_DIR", ".")
params = json.loads(os.environ.get("EC_PARAMS", "{}"))

# 读输入文件（支持 inline 和 single_file）
inline = params.get("inline_input", "")
input_files = [os.path.join(input_dir, f) for f in os.listdir(input_dir) if f.endswith('.txt')]

lines = []
if inline:
    lines = inline.splitlines()
elif input_files:
    for fp in input_files:
        with open(fp) as f:
            lines.extend(f.read().splitlines())

seen = {}
for line in lines:
    seen[line] = seen.get(line, 0) + 1

unique = [l for l in lines if seen[l] == 1]
duplicates = {l: c for l, c in seen.items() if c > 1}

result = {
    "input_rows": len(lines),
    "input_bytes": sum(len(l) for l in lines),
    "unique_rows": len(unique),
    "duplicate_rows": sum(duplicates.values()) - len(duplicates),
    "duplicate_groups": len(duplicates),
    "sha256_input": hashlib.sha256(("\n".join(lines)).encode()).hexdigest()[:16],
    "sha256_unique": hashlib.sha256(("\n".join(unique)).encode()).hexdigest()[:16],
    "result_lines": unique
}
print(json.dumps(result, ensure_ascii=False))
