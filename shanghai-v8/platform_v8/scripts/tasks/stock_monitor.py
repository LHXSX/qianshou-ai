#!/usr/bin/env python3
"""
stock_monitor.py — 补货监控脚本
监控京东/淘宝商品是否有货

参数：
  urls: [str]         — 商品链接列表
  check_interval: int — 检查间隔（秒），默认 300

输出：
  { results: [{url, in_stock, price}] }
"""
import os, json, re, time

from _script_safety import open_public_url, read_limited

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
urls = params.get("urls", [])
MAX_URLS = 100
MAX_HTML_BYTES = 3 * 1024 * 1024

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

def check_stock(url: str) -> dict:
    try:
        resp, checked_url = open_public_url(
            url,
            headers=HEADERS,
            timeout_s=10,
            max_bytes=MAX_HTML_BYTES,
        )
        with resp:
            html = read_limited(resp, MAX_HTML_BYTES).decode("utf-8", errors="ignore")
        in_stock = "库存" in html and "无货" not in html and "sold out" not in html.lower()
        price_m = re.search(r'¥?([\d.]+)', html)
        price = float(price_m.group(1)) if price_m else 0
        return {
            "url": url,
            "checked_url": checked_url,
            "in_stock": in_stock,
            "price": price,
            "alert": in_stock,
            "status": "ok",
        }
    except Exception as e:
        return {
            "url": url,
            "error": str(e)[:80],
            "in_stock": False,
            "alert": False,
            "status": "error",
        }

if not isinstance(urls, list) or not urls:
    print(json.dumps({"status": "failed", "error": "urls 必须是非空数组"}))
    raise SystemExit(1)
if len(urls) > MAX_URLS:
    print(json.dumps({"status": "failed", "error": f"单个分片最多 {MAX_URLS} 个 URL"}))
    raise SystemExit(1)

t0 = time.time()
results = [check_stock(u) for u in urls]
alerts = [r for r in results if r.get("alert")]
ok_count = sum(1 for r in results if r["status"] == "ok")
print(json.dumps({
    "status": "ok",
    "schema_version": "v1",
    "task_type": "stock_monitor",
    "elapsed_ms": int((time.time() - t0) * 1000),
    "summary": {
        "total": len(results),
        "ok": ok_count,
        "error": len(results) - ok_count,
        "in_stock": len(alerts),
    },
    "results": results,
    "alerts": alerts,
    "time": time.time(),
    "summary_text": f"库存检查完成 · 有货 {len(alerts)}/{len(results)}",
}, ensure_ascii=False))
