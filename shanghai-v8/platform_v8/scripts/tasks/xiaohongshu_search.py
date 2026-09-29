#!/usr/bin/env python3
"""
xhs_crawler.py — 小红书笔记爬虫
按关键词搜索并采集笔记数据

参数：
  keyword: str        — 搜索关键词
  limit: int          — 采集数量，默认 20
  sort: str           — general / popularity_desc / time_desc

输出：
  { keyword, total, notes: [{title, likes, comments, url}] }
"""
import os, json, time, re
from urllib.request import Request, urlopen
from urllib.parse import quote

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
keyword = params.get("keyword", "")
limit = min(params.get("limit", 20), 50)

# 小红书搜索 API（模拟手机端）
HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/537.36",
    "Referer": "https://www.xiaohongshu.com/",
}

def search_xhs(kw: str, page: int) -> list:
    try:
        url = f"https://edith.xiaohongshu.com/api/sns/web/v1/search/notes?keyword={quote(kw)}&page={page}&page_size=20&sort=general"
        req = Request(url, headers=HEADERS)
        resp = urlopen(req, timeout=15)
        data = json.loads(resp.read())
        notes = []
        for item in data.get("data", {}).get("items", []):
            note = item.get("note_card", {})
            notes.append({
                "title": note.get("title", ""),
                "likes": note.get("interact_info", {}).get("liked_count", 0),
                "comments": note.get("interact_info", {}).get("comment_count", 0),
                "url": f"https://www.xiaohongshu.com/explore/{note.get('note_id', '')}",
            })
        return notes
    except Exception as e:
        return []

all_notes = []
for p in range((limit // 20) + 1):
    notes = search_xhs(keyword, p)
    all_notes.extend(notes)
    if len(all_notes) >= limit:
        break
    time.sleep(1)

result = {
    "keyword": keyword,
    "total": len(all_notes),
    "notes": all_notes[:limit],
    "time": time.time(),
}
print(json.dumps(result, ensure_ascii=False))
