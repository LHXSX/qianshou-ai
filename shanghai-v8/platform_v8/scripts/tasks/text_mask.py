#!/usr/bin/env python3
"""
text_mask.py — 数据脱敏
适配千手引擎 run_script 协议
"""
import os, json, re, time, sys

PATTERNS = {
    "phone":  r"(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)",
    "id_cn":  r"(?<!\d)(\d{6})(\d{8})(\d{3}[\dxX])(?!\w)",
}

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

t0 = time.time()
counts = {}

def mask_phone(m): counts["phone"] = counts.get("phone",0)+1; return m.group(1) + "****" + m.group(3)
def mask_id(m): counts["id_cn"] = counts.get("id_cn",0)+1; return m.group(1) + "********" + m.group(3)

masked = text
masked = re.sub(PATTERNS["phone"], mask_phone, masked)
masked = re.sub(PATTERNS["id_cn"], mask_id, masked)

output = {
    "status": "ok",
    "task_type": "text_mask",
    "total_masked": sum(counts.values()),
    "counts": counts,
    "characters_processed": len(text),
    "sample_output": masked[:300],
    "elapsed_ms": int((time.time() - t0) * 1000),
}
print(json.dumps(output, ensure_ascii=False))
