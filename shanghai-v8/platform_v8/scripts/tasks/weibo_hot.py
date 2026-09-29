#!/usr/bin/env python3
"""
weibo_hot.py — 微博热搜采集脚本
爬取微博热搜榜及趋势

参数：
  topic_count: int   — 取多少条，默认 50

输出：
  { topics: [{rank, title, hot_value}] }
"""
import os, json, re, time
from urllib.request import Request, urlopen

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
count = min(params.get("topic_count", 50), 100)

def fetch_weibo_hot() -> list:
    url = "https://weibo.com/ajax/side/hotSearch"
    req = Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://weibo.com/"})
    resp = urlopen(req, timeout=10)
    data = json.loads(resp.read())
    topics = []
    for i, item in enumerate(data.get("data", {}).get("realtime", [])[:count]):
        topics.append({
            "rank": i + 1,
            "title": item.get("word", ""),
            "hot_value": item.get("raw_hot", 0),
            "category": item.get("category", ""),
        })
    return topics

topics = fetch_weibo_hot()
print(json.dumps({
    "total": len(topics),
    "topics": topics,
    "time": time.time(),
}, ensure_ascii=False))
