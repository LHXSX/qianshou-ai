#!/usr/bin/env python3
"""url_check — 批量检查公网 URL 可访问性（HEAD + SSRF 护栏）。"""
import json
import os
import sys
import time

from _script_safety import open_public_url


MAX_URLS = 100

def main():
    t0 = time.time()
    try:
        raw = sys.stdin.read()
    except Exception as e:
        print(json.dumps({"status":"failed","error":f"stdin:{e}"})); return 1
    try:
        txt = raw.lstrip()
        env_params = json.loads(os.environ.get("EC_PARAMS", "{}") or "{}")
        if txt.startswith("{") or txt.startswith("["):
            obj = json.loads(raw)
            urls = (env_params.get("urls") or obj.get("urls")
                    or obj.get("lines") or obj.get("params",{}).get("urls",[]))
            timeout = env_params.get(
                "timeout", obj.get("params",{}).get("timeout", 5)
            )
        else:
            urls = env_params.get("urls") or [
                l.strip() for l in raw.splitlines() if l.strip()
            ]
            timeout = env_params.get("timeout", 5)
        if not isinstance(urls, list):
            raise ValueError("urls 必须是数组")
        if len(urls) > MAX_URLS:
            raise ValueError(f"单次最多检查 {MAX_URLS} 个 URL")
        timeout = max(1, min(float(timeout), 30))
        results = []; ok, fail = 0, 0
        for u in urls:
            row = {"url":u}
            t1 = time.time()
            try:
                resp, checked_url = open_public_url(
                    u, method="HEAD", timeout_s=timeout, max_bytes=0,
                )
                with resp:
                    row["status"] = resp.status; row["ok"] = True
                    row["checked_url"] = checked_url
                    row["content_type"] = resp.headers.get("Content-Type","")
                    row["content_length"] = resp.headers.get("Content-Length","")
                    ok += 1
            except Exception as e:
                row["status"] = getattr(e, "code", 0)
                row["ok"] = False
                fail += 1
                row["error"] = str(e)[:160]
            row["latency_ms"] = int((time.time()-t1)*1000)
            results.append(row)
        elapsed = int((time.time()-t0)*1000)
        avg_lat = sum(r["latency_ms"] for r in results)/max(1,len(results))
        print(json.dumps({
            "status":"ok","schema_version":"v1","task_type":"url_check",
            "elapsed_ms":elapsed,
            "summary":{"total":len(urls),"reachable":ok,"unreachable":fail,
                       "avg_latency_ms":round(avg_lat,1),"timeout_s":timeout},
            "result":results, "results":results,
            "summary_text":f"✅ URL 可用性检查完成\n⚡ 总用时 {elapsed}ms\n📥 检查 {len(urls)} 个 URL\n✓ 可访问 {ok} · ✗ 失败 {fail}\n⏱ 平均延迟 {round(avg_lat,1)}ms",
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"status":"failed","task_type":"url_check","error":str(e)})); return 1

if __name__ == "__main__": sys.exit(main())
