#!/usr/bin/env python3
"""text_replace — 批量文本替换（支持正则）。

输入形态 (S4-T4 · 2026-06-07 兼容三种):
  1. stdin JSON: {lines: [...], params: {find/old, replace/new, regex, case_sensitive}}
  2. EC_PARAMS 环境变量 (executor 注入 spec.params): {find/old, replace/new, ...}
     stdin 是纯文本(按行切),params 走 EC_PARAMS
  3. inline_input 是纯文本 + EC_PARAMS 提供 find/replace

兼容字段别名:
  - find / old  (find 优先)
  - replace / new
"""
import json, os, re, sys, time

def _read_lines() -> tuple[list, str]:
    try:
        raw = sys.stdin.read()
    except Exception as e:
        raise RuntimeError(f"stdin:{e}") from e
    if raw.strip():
        return raw.splitlines(), raw
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if input_dir and os.path.isdir(input_dir):
        lines = []
        for fname in sorted(os.listdir(input_dir)):
            fp = os.path.join(input_dir, fname)
            if not os.path.isfile(fp) or fname.startswith(".") or fname == "input_manifest.v1.json":
                continue
            with open(fp, "r", encoding="utf-8", errors="replace") as fh:
                lines.extend(fh.read().splitlines())
        return lines, "\n".join(lines)
    return raw.splitlines(), raw

def main():
    t0 = time.time()
    try:
        raw = ""
        try:
            lines, raw = _read_lines()
        except Exception as e:
            print(json.dumps({"status":"failed","error":str(e)})); return 1
        obj = json.loads(raw) if raw.lstrip().startswith(("{","[")) else {"lines": lines}
        lines = obj.get("lines") or obj.get("params",{}).get("lines",[])
        p = obj.get("params", {})
        # 兼容 executor 通过 EC_PARAMS 注入(其他脚本如 hash_batch 已是此模式)
        try:
            ec_params_raw = os.environ.get("EC_PARAMS", "")
            if ec_params_raw:
                ec_params = json.loads(ec_params_raw)
                if isinstance(ec_params, dict):
                    # EC_PARAMS 覆盖 stdin params (调用方显式参数优先)
                    p = {**p, **ec_params}
        except Exception:
            pass
        # 字段别名: find = find / old · replace = replace / new
        find = p.get("find", "") or p.get("old", "")
        replace = p.get("replace", "") if "replace" in p else p.get("new", "")
        use_regex = p.get("regex", False)
        case_sensitive = p.get("case_sensitive", True)
        if not find:
            print(json.dumps({"status":"failed","task_type":"text_replace","error":"params.find/old 不能为空"})); return 1
        pattern = re.compile(find, 0 if case_sensitive else re.IGNORECASE) if use_regex else None
        out_lines = []
        replaced_count = 0
        for l in lines:
            if use_regex:
                new_l, n = pattern.subn(replace, l)
            else:
                if case_sensitive:
                    n = l.count(find); new_l = l.replace(find, replace)
                else:
                    new_l = re.sub(re.escape(find), replace, l, flags=re.IGNORECASE); n = sum(1 for _ in re.finditer(re.escape(find), l, re.IGNORECASE))
            replaced_count += n
            out_lines.append(new_l)
        elapsed = int((time.time()-t0)*1000)
        lines_changed = sum(1 for a,b in zip(lines, out_lines) if a != b)
        print(json.dumps({
            "status":"ok","schema_version":"v1","task_type":"text_replace",
            "elapsed_ms":elapsed,
            "summary":{"input_lines":len(lines),"lines_changed":lines_changed,
                       "replacements":replaced_count,"pattern":find,"is_regex":use_regex},
            "result_lines":out_lines,
            "summary_text":f"✅ 文本替换完成\n⚡ 用时 {elapsed}ms\n📥 处理 {len(lines)} 行\n✏️  改动 {lines_changed} 行（{replaced_count} 处替换）\n🔍 模式: {find!r} → {replace!r}",
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"status":"failed","task_type":"text_replace","error":str(e)})); return 1

if __name__ == "__main__": sys.exit(main())
