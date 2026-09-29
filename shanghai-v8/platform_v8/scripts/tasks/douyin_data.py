#!/usr/bin/env python3
"""
douyin_data.py — 抖音数据采集脚本
爬取抖音商品销量、视频数据

参数：
  url: str           — 抖音商品链接或视频链接
  data_type: str     — product / video / author

输出：
  { url, data_type, data }
"""
import os, json, re, time
from urllib.request import Request, urlopen

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
url = params.get("url", "")
data_type = params.get("data_type", "product")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/537.36",
    "Referer": "https://www.douyin.com/",
}

def fetch_product(share_url: str) -> dict:
    req = Request(share_url, headers=HEADERS)
    resp = urlopen(req, timeout=10)
    html = resp.read().decode("utf-8", errors="ignore")
    title = re.search(r'"title":"([^"]+)"', html)
    price = re.search(r'"price":"?([\d.]+)"?', html)
    sales = re.search(r'"sales":(\d+)', html)
    return {
        "title": title.group(1) if title else "",
        "price": float(price.group(1)) if price else 0,
        "sales": int(sales.group(1)) if sales else 0,
    }

result = fetch_product(url) if data_type == "product" else {"note": f"{data_type} 解析待实现"}
print(json.dumps({"url": url, "data_type": data_type, "data": result, "time": time.time()}, ensure_ascii=False))
