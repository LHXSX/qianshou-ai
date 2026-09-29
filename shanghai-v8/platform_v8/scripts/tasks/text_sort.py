#!/usr/bin/env python3
"""text_sort — 文本行排序（字典序/数字/反向/去重）。
输入: 纯文本或 JSON {lines, params: {numeric, reverse, unique, case_insensitive}}
"""
import json, sys, time

def main():
    t0 = time.time()
    try:
        raw = sys.stdin.read()
    except Exception as e:
        print(json.dumps({"status":"failed","error":f"stdin:{e}"})); return 1
    try:
        txt = raw.lstrip()
        if txt.startswith("{") or txt.startswith("["):
            obj = json.loads(raw)
            lines = obj.get("lines") or obj.get("params",{}).get("lines",[])
            p = obj.get("params", {})
        else:
            lines = raw.splitlines(); p = {}
        numeric = p.get("numeric", False)
        reverse = p.get("reverse", False)
        unique = p.get("unique", False)
        case_insensitive = p.get("case_insensitive", False)

        if unique: lines = list(set(lines))
        if numeric:
            def key(x):
                try: return float(x.strip())
                except: return float("inf")
            sorted_lines = sorted(lines, key=key, reverse=reverse)
        else:
            sorted_lines = sorted(lines, key=lambda x: x.lower() if case_insensitive else x, reverse=reverse)
        elapsed = int((time.time()-t0)*1000)
        print(json.dumps({
            "status":"ok","schema_version":"v1","task_type":"text_sort",
            "elapsed_ms":elapsed,
            "summary":{"input_lines":len(lines),"output_lines":len(sorted_lines),
                       "numeric":numeric,"reverse":reverse,"unique":unique},
            "result_lines":sorted_lines,
            "summary_text":f"✅ 排序完成\n⚡ 用时 {elapsed}ms\n📥 输入 {len(lines)} 行\n📤 输出 {len(sorted_lines)} 行\n📊 模式: " + (
                "数字" if numeric else "字典序") + (" · 逆序" if reverse else "") + (" · 去重" if unique else ""),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"status":"failed","task_type":"text_sort","error":str(e)})); return 1

if __name__ == "__main__": sys.exit(main())
