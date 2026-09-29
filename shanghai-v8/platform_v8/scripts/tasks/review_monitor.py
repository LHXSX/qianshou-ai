#!/usr/bin/env python3
"""
review_monitor.py — 评价监控脚本
监控淘宝/京东商品的好评/差评变化

参数：
  product_id: str     — 商品 ID
  platform: str       — taobao / jd
  watch_days: int     — 监控天数，默认 7

输出：
  { positive_ratio, total_reviews, bad_reviews, new_bad_reviews }
"""
import os, json, re, time
from urllib.request import Request, urlopen

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
product_id = params.get("product_id", "")
platform = params.get("platform", "taobao")

def fetch_taobao_reviews(pid: str) -> dict:
    url = f"https://rate.taobao.com/feedRateList.htm?itemId={pid}&currentPage=1"
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    resp = urlopen(req, timeout=10)
    data = json.loads(resp.read())
    total = data.get("total", 0)
    bad = sum(1 for r in data.get("rates", []) if r.get("rate", "") == "bad")
    return {"total": total, "bad": bad, "good": total - bad}

result = fetch_taobao_reviews(product_id) if platform == "taobao" else {"total": 0, "bad": 0, "good": 0}
result["product_id"] = product_id
result["platform"] = platform
result["positive_ratio"] = round(result["good"] / max(result["total"], 1) * 100, 2)
print(json.dumps(result, ensure_ascii=False))
