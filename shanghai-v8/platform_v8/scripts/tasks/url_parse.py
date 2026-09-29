#!/usr/bin/env python3
"""url_parse — 批量 URL 解析（scheme/host/path/query/fragment）。"""
import json, sys, time
from urllib.parse import urlparse, parse_qs

def main():
    t0 = time.time()
    try:
        raw = sys.stdin.read()
    except Exception as e:
        print(json.dumps({"status":"failed","error":f"stdin:{e}"})); return 1
    try:
        txt = raw.lstrip()
        if txt.startswith("{") or txt.startswith("["):
            obj = json.loads(raw); urls = obj.get("urls") or obj.get("lines",[])
        else:
            urls = [l.strip() for l in raw.splitlines() if l.strip()]
        results = []
        domains = {}; schemes = {}
        for u in urls:
            try:
                p = urlparse(u)
                row = {"url":u, "scheme":p.scheme, "host":p.netloc, "path":p.path,
                       "query":dict(parse_qs(p.query)), "fragment":p.fragment, "port":p.port}
                domains[p.netloc] = domains.get(p.netloc,0)+1
                schemes[p.scheme] = schemes.get(p.scheme,0)+1
                results.append(row)
            except Exception as e:
                results.append({"url":u, "error":str(e)})
        elapsed = int((time.time()-t0)*1000)
        print(json.dumps({
            "status":"ok","schema_version":"v1","task_type":"url_parse",
            "elapsed_ms":elapsed,
            "summary":{"total":len(urls),"unique_domains":len(domains),
                       "top_domains":sorted(domains.items(), key=lambda x:-x[1])[:5],
                       "scheme_dist":schemes},
            "result":results,
            "summary_text":f"✅ URL 解析完成\n⚡ 用时 {elapsed}ms\n📥 解析 {len(urls)} 个 URL\n🌐 唯一域名 {len(domains)} 个\n📊 协议分布: " + ", ".join(f"{k}×{v}" for k,v in schemes.items()),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"status":"failed","task_type":"url_parse","error":str(e)})); return 1

if __name__ == "__main__": sys.exit(main())
