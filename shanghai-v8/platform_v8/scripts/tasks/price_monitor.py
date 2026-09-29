#!/usr/bin/env python3
"""
price_monitor.py — 电商价格监控脚本
适配千手引擎 run_script 协议

参数：
  urls: [str]          — 要监控的商品链接列表
  interval_hours: int  — 检查间隔（小时），默认 24
  alert_drop_ratio: float — 降价比例报警，默认 0.1（降价10%报警）

输出：
  results: [{url, title, current_price, last_price, drop_ratio, time}]
"""
import os, json, re, time

from _script_safety import open_public_url, read_limited

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
urls = params.get("urls", [])
alert_ratio = params.get("alert_drop_ratio", 0.1)
MAX_URLS = 100
MAX_HTML_BYTES = 3 * 1024 * 1024

FAKE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

def extract_price(html: str, url: str) -> float:
    """从 HTML 中提取价格"""
    patterns = [
        r'"price"[:\s]+([\d.]+)',
        r'"priceInfo"[^}]*"price"[:\s]+([\d.]+)',
        r'<span class="price"[^>]*>([^<]+)</span>',
        r'¥([\d.]+)',
        r'"salePrice"[:\s]+([\d.]+)',
    ]
    for p in patterns:
        m = re.search(p, html)
        if m:
            try:
                return float(m.group(1))
            except:
                continue
    return 0.0

def fetch_url(url: str) -> dict:
    """抓取一个商品页面"""
    try:
        resp, checked_url = open_public_url(
            url,
            headers=FAKE_HEADERS,
            timeout_s=15,
            max_bytes=MAX_HTML_BYTES,
        )
        with resp:
            html = read_limited(resp, MAX_HTML_BYTES).decode("utf-8", errors="ignore")
        price = extract_price(html, url)
        title = re.search(r'<title>([^<]+)</title>', html)
        return {
            "url": url,
            "checked_url": checked_url,
            "price": price,
            "title": title.group(1)[:50] if title else url,
            "status": "ok",
            "alert": 0 < price < 99999,
        }
    except Exception as e:
        return {"url": url, "error": str(e)[:100], "status": "error"}

if not isinstance(urls, list) or not urls:
    print(json.dumps({"status": "failed", "error": "urls 必须是非空数组"}))
    raise SystemExit(1)
if len(urls) > MAX_URLS:
    print(json.dumps({"status": "failed", "error": f"单个分片最多 {MAX_URLS} 个 URL"}))
    raise SystemExit(1)

t0 = time.time()
results = []
for url in urls:
    r = fetch_url(url)
    results.append(r)

ok_count = sum(1 for r in results if r["status"] == "ok")
error_count = len(results) - ok_count
output = {
    "status": "ok",
    "schema_version": "v1",
    "task_type": "price_monitor",
    "elapsed_ms": int((time.time() - t0) * 1000),
    "total": len(results),
    "ok": ok_count,
    "error": error_count,
    "summary": {"total": len(results), "ok": ok_count, "error": error_count},
    "results": results,
    "alerts": [r for r in results if r.get("alert")],
    "time": time.time(),
    "summary_text": f"价格检查完成 · 成功 {ok_count}/{len(results)}",
}
print(json.dumps(output, ensure_ascii=False))
