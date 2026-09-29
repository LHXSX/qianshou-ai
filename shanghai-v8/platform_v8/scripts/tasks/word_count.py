#!/usr/bin/env python3
"""
word_count.py — 通用词频统计（带中文分词，支持多输入方式）
适配千手引擎 run_script 协议
"""
import os, json, sys, re, time
from collections import Counter

_TOKEN_RE = re.compile(r"[\w\u4e00-\u9fff]+", re.UNICODE)

try:
    import jieba
    HAS_JIEBA = True
except ImportError:
    HAS_JIEBA = False

# 读取输入
text = ""
params = json.loads(os.environ.get("EC_PARAMS", "{}"))
input_dir = os.environ.get("EC_INPUT_DIR", "")

if input_dir and os.path.isdir(input_dir):
    for fname in os.listdir(input_dir):
        fp = os.path.join(input_dir, fname)
        if os.path.isfile(fp):
            with open(fp) as fh:
                text += fh.read()
elif params.get("inline_input") or params.get("text"):
    text = params.get("text", params.get("inline_input", ""))
else:
    try:
        text = sys.stdin.read()
    except:
        text = ""

t0 = time.perf_counter()
tokens = []
for m in _TOKEN_RE.findall(text.lower()):
    has_cn = any("\u4e00" <= c <= "\u9fff" for c in m)
    if has_cn and HAS_JIEBA:
        tokens.extend(jieba.lcut(m))
    else:
        tokens.append(m)

counter = Counter(tokens)
total = sum(counter.values())
unique = len(counter)
top_n = min(params.get("top_n", 100), 1000)
top_items = counter.most_common(top_n)
result_lines = [f"{w}\t{c}" for w, c in top_items]

output = {
    "status": "ok",
    "schema_version": "v1",
    "task_type": "word_count",
    "elapsed_ms": int((time.perf_counter() - t0) * 1000),
    "summary": {
        "input_bytes": len(text.encode()),
        "total_tokens": total,
        "unique_tokens": unique,
        "top_n_returned": len(top_items),
        "jieba_enabled": HAS_JIEBA,
    },
    "result_lines": result_lines,
}
print(json.dumps(output, ensure_ascii=False))
