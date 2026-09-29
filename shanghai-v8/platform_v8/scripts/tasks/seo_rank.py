#!/usr/bin/env python3
"""
seo_rank.py — 关键词排名监测脚本
适配千手引擎 run_script 协议

参数：
  keyword: str        — 关键词
  engine: str         — baidu / google / bing
  pages: int          — 查多少页，默认 3

输出：
  { keyword, engine, results: [{rank, url, title}] }
"""
import os, json, re, time
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from urllib.parse import quote

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
keyword = params.get("keyword", "")
engine = params.get("engine", "baidu")
pages = min(params.get("pages", 3), 5)

if not str(keyword).strip():
    print(json.dumps({
        "task_type": "seo_rank",
        "status": "failed",
        "contract_version": "1",
        "failure_class": "invalid_params",
        "error": "缺少参数: keyword",
        "summary_text": "❌ 缺少参数: keyword",
        "usage": {"keyword": "要查询的关键词", "engine": "baidu", "pages": 3},
        "time": time.time(),
    }, ensure_ascii=False))
    raise SystemExit(1)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml",
}

def search_baidu(kw: str, page: int) -> list:
    """百度搜索结果"""
    pn = page * 10
    url = f"https://www.baidu.com/s?wd={quote(kw)}&pn={pn}"
    req = Request(url, headers=HEADERS)
    resp = urlopen(req, timeout=10)
    html = resp.read().decode("utf-8", errors="ignore")
    results = []
    for m in re.finditer(r'<a[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>', html):
        url = m.group(1)
        title = re.sub(r'<[^>]+>', '', m.group(2)).strip()
        if url.startswith("http") and title:
            results.append({"url": url[:100], "title": title[:50]})
    return results

def search_google(kw: str, page: int) -> list:
    """Google 搜索结果"""
    start = page * 10
    url = f"https://www.google.com/search?q={quote(kw)}&start={start}"
    req = Request(url, headers=HEADERS)
    resp = urlopen(req, timeout=10)
    html = resp.read().decode("utf-8", errors="ignore")
    results = []
    for m in re.finditer(r'<a[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>', html):
        url = m.group(1)
        title = re.sub(r'<[^>]+>', '', m.group(2)).strip()
        if url.startswith("http") and title and "google" not in url:
            results.append({"url": url[:100], "title": title[:50]})
    return results

searchers = {"baidu": search_baidu, "google": search_google}
searcher = searchers.get(engine, search_baidu)

all_results = []
fetch_ok = 0
fetch_errors = []
for p in range(pages):
    try:
        page_results = searcher(keyword, p)
        fetch_ok += 1
        for i, r in enumerate(page_results):
            r["rank"] = p * 10 + i + 1
        all_results.extend(page_results)
    except (URLError, HTTPError, TimeoutError, OSError) as e:
        fetch_errors.append({"page": p, "error": str(e)[:200]})
    except Exception as e:
        fetch_errors.append({"page": p, "error": str(e)[:200]})
    time.sleep(1)

# 依赖不可用：全部页面抓取失败
if fetch_ok == 0:
    print(json.dumps({
        "task_type": "seo_rank",
        "status": "failed",
        "contract_version": "1",
        "failure_class": "dependency_missing",
        "error": f"搜索源不可用 · engine={engine} · 全部 {pages} 页抓取失败",
        "summary_text": "❌ 搜索源不可用（非『无命中』）",
        "keyword": keyword,
        "engine": engine,
        "fetch_errors": fetch_errors[:5],
        "time": time.time(),
    }, ensure_ascii=False))
    raise SystemExit(1)

# 抓取成功但无命中：业务成功、空结果（明确标注）
output = {
    "task_type": "seo_rank",
    "status": "ok",
    "contract_version": "1",
    "keyword": keyword,
    "engine": engine,
    "total": len(all_results),
    "pages_searched": pages,
    "pages_ok": fetch_ok,
    "results": all_results[:30],
    "empty_result": len(all_results) == 0,
    "summary_text": (
        f"✅ 查询完成 · 无命中（engine={engine}）"
        if not all_results else
        f"✅ 查询完成 · {len(all_results)} 条"
    ),
    "fetch_errors": fetch_errors[:5],
    "time": time.time(),
}
print(json.dumps(output, ensure_ascii=False))
