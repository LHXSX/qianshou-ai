#!/usr/bin/env python3
"""text_diff — 文本差异 (企业级 · 2026-06-07 S5 升级)

新增:
  - **相似度 ratio** (SequenceMatcher · 0-1)
  - **word-level diff** (字符级别 → 词级 · 合同对比更可读)
  - **HTML 高亮输出**(可直接嵌网页)
  - **两文件 EC_INPUT_DIR 输入**(自动识别 a.txt + b.txt)
  - **stats by section**(块 hunk 计数 / 最大变更块)
  - EC_PARAMS 统一参数

参数 (EC_PARAMS · 优先 stdin):
  a / b           str    文本(优先 EC_PARAMS > stdin.a/b > EC_INPUT_DIR)
  context         int    diff 上下文行 (默认 3)
  output_format   str    unified (默认) / html / word / inline_summary
  ignore_case     bool   忽略大小写比较 (默认 false)
  ignore_whitespace bool 忽略首尾空白 (默认 false)
"""
import difflib
import json
import os
import re
import sys
import time


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _read_from_dir() -> tuple:
    """EC_INPUT_DIR 必须恰好包含两个业务输入文件。"""
    d = os.environ.get("EC_INPUT_DIR", "")
    if not d or not os.path.isdir(d):
        return None, None
    files = sorted(
        f for f in os.listdir(d)
        if f != "input_manifest.v1.json"
        and os.path.isfile(os.path.join(d, f))
    )
    if not files:
        return None, None
    if len(files) != 2:
        raise ValueError(
            f"text_diff 目录输入必须恰好包含 2 个文件，实际 {len(files)} 个"
        )
    a_path = next((f for f in files if f.lower().startswith("a.")), None) or files[0]
    b_path = next((f for f in files if f.lower().startswith("b.")), None)
    if b_path is None:
        b_path = next(f for f in files if f != a_path)
    with open(os.path.join(d, a_path), encoding="utf-8", errors="replace") as fh:
        a = fh.read()
    with open(os.path.join(d, b_path), encoding="utf-8", errors="replace") as fh:
        b = fh.read()
    return a, b


def _to_words(s: str) -> list:
    """按词切 · 保留分隔符 (英文按空白 · 中文按字)"""
    out = []
    for tok in re.split(r"(\s+|[\u4e00-\u9fff]|[,.;:!?，。;:!?])", s):
        if tok:
            out.append(tok)
    return out


def _word_diff(a: str, b: str) -> list:
    """词级 diff · 返 [(tag, words), ...] · tag ∈ equal/insert/delete/replace"""
    a_w = _to_words(a)
    b_w = _to_words(b)
    sm = difflib.SequenceMatcher(None, a_w, b_w)
    ops = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            ops.append({"tag": "equal", "text": "".join(a_w[i1:i2])})
        elif tag == "insert":
            ops.append({"tag": "insert", "text": "".join(b_w[j1:j2])})
        elif tag == "delete":
            ops.append({"tag": "delete", "text": "".join(a_w[i1:i2])})
        elif tag == "replace":
            ops.append({"tag": "delete", "text": "".join(a_w[i1:i2])})
            ops.append({"tag": "insert", "text": "".join(b_w[j1:j2])})
    return ops


def _html_diff(ops: list) -> str:
    """word_diff → 安全 HTML(防 XSS · 用 entity 转义)"""
    from html import escape
    parts = []
    for op in ops:
        text = escape(op["text"])
        if op["tag"] == "equal":
            parts.append(text)
        elif op["tag"] == "insert":
            parts.append(f'<ins style="background:#e6ffe6;color:#006600">{text}</ins>')
        elif op["tag"] == "delete":
            parts.append(f'<del style="background:#ffe6e6;color:#990000">{text}</del>')
    return "<div class='diff-output'>" + "".join(parts) + "</div>"


def _normalize(s: str, ignore_case: bool, ignore_ws: bool) -> str:
    if ignore_case:
        s = s.lower()
    if ignore_ws:
        s = "\n".join(l.strip() for l in s.splitlines())
    return s


def main():
    t0 = time.time()
    try:
        p = _params()
        raw = sys.stdin.read()
        a = b = None
        if raw and raw.lstrip().startswith(("{", "[")):
            try:
                obj = json.loads(raw)
                if isinstance(obj, dict):
                    a = obj.get("a")
                    b = obj.get("b")
                    merged = dict(obj.get("params") or {})
                    merged.update(p)
                    p = merged
            except Exception:
                pass

        if p.get("a") is not None:
            a = p["a"]
        if p.get("b") is not None:
            b = p["b"]

        if a is None or b is None:
            a_dir, b_dir = _read_from_dir()
            if a_dir is not None and b_dir is not None:
                if a is None:
                    a = a_dir
                if b is None:
                    b = b_dir

        if a is None or b is None:
            raise ValueError("缺 a / b(EC_PARAMS / stdin / EC_INPUT_DIR 两文件)")

        a = str(a)
        b = str(b)

        ignore_case = bool(p.get("ignore_case", False))
        ignore_ws = bool(p.get("ignore_whitespace", False))
        a_cmp = _normalize(a, ignore_case, ignore_ws)
        b_cmp = _normalize(b, ignore_case, ignore_ws)

        ctx = int(p.get("context") or 3)
        output_format = (p.get("output_format") or "unified").lower()

        # 行级 unified diff
        a_lines = a_cmp.splitlines(keepends=True)
        b_lines = b_cmp.splitlines(keepends=True)
        unified = list(difflib.unified_diff(a_lines, b_lines, lineterm="",
                                            n=ctx, fromfile="A", tofile="B"))
        adds = sum(1 for l in unified if l.startswith("+") and not l.startswith("+++"))
        dels = sum(1 for l in unified if l.startswith("-") and not l.startswith("---"))
        hunks = sum(1 for l in unified if l.startswith("@@"))

        # 相似度
        ratio = difflib.SequenceMatcher(None, a_cmp, b_cmp).ratio()

        # 输出
        out_obj = {
            "status": "ok", "schema_version": "v1", "task_type": "text_diff",
            "summary": {
                "a_bytes": len(a.encode("utf-8")),
                "b_bytes": len(b.encode("utf-8")),
                "a_lines": len(a_lines), "b_lines": len(b_lines),
                "additions": adds, "deletions": dels, "hunks": hunks,
                "similarity": round(ratio, 6),
                "identical": ratio == 1.0,
                "ignore_case": ignore_case,
                "ignore_whitespace": ignore_ws,
                "output_format": output_format,
            },
        }

        if output_format == "html":
            ops = _word_diff(a_cmp, b_cmp)
            out_obj["result_html"] = _html_diff(ops)
            out_obj["result_word_ops"] = ops
        elif output_format == "word":
            out_obj["result_word_ops"] = _word_diff(a_cmp, b_cmp)
        elif output_format == "inline_summary":
            out_obj["result_summary"] = (
                f"相似度 {ratio:.2%} · 增 {adds} 行 · 删 {dels} 行 · {hunks} 块"
            )
        else:
            out_obj["result_diff"] = "\n".join(unified)

        elapsed = int((time.time() - t0) * 1000)
        out_obj["elapsed_ms"] = elapsed
        out_obj["summary_text"] = (
            f"✅ 文本差异 · A {len(a_lines)} 行 / B {len(b_lines)} 行\n"
            f"相似度 {ratio:.2%} · 增 {adds} 行 · 删 {dels} 行 · {hunks} 块\n"
            f"⏱ {elapsed}ms · 格式 {output_format}"
        )
        print(json.dumps(out_obj, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "text_diff",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
