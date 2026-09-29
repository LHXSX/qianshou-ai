#!/usr/bin/env python3
"""plain_text_read — 读取纯文本材料 (txt/md/csv/json/log)."""
import json
import os
import sys
import time


TEXT_EXTS = (".txt", ".md", ".markdown", ".csv", ".json", ".log", ".text", ".eml")


def main() -> int:
    t0 = time.time()
    text = ""
    d = os.environ.get("EC_INPUT_DIR", "")
    if d and os.path.isdir(d):
        parts = []
        for fn in sorted(os.listdir(d)):
            if any(fn.lower().endswith(ext) for ext in TEXT_EXTS) or "." not in fn:
                fp = os.path.join(d, fn)
                if os.path.isfile(fp):
                    with open(fp, "rb") as fh:
                        raw = fh.read()
                    parts.append(raw.decode("utf-8", errors="ignore"))
        text = "\n\n".join(parts).strip()
    if not text:
        raw = sys.stdin.buffer.read()
        text = raw.decode("utf-8", errors="ignore").strip()
    print(json.dumps({
        "status": "ok",
        "schema_version": "v1",
        "task_type": "plain_text_read",
        "result_text": text,
        "elapsed_ms": int((time.time() - t0) * 1000),
        "summary": {"chars": len(text)},
    }, ensure_ascii=False))
    return 0 if text else 1


if __name__ == "__main__":
    sys.exit(main())
