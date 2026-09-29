#!/usr/bin/env python3
"""
geo_scan.py — GEO 全网品牌信息扫描脚本
适配千手引擎 run_script 协议

【应用场景】
GEO 厂商需要先找出全网关于客户的「错误/过期/负面」信息，才能去修正和覆盖。
本脚本让节点扫描百度、知乎、小红书等平台上的品牌公开信息，
标记需要处理的条目，输出结构化错误清单。

【谁买单】
- GEO 服务商（扫描工具，年费 ¥3-5 万）
- 品牌公关（舆情扫描，年费 ¥5-8 万）
- 法务/合规（侵权信息排查，按次 ¥2,000）

【参数】
  brand: str                — 品牌名（必填）
  platforms: [str]          — 扫描平台（默认 all）
  scan_depth: int           — 扫描深度（1-5，默认 3）
  check_negative: bool      — 是否标记负面信息，默认 true
  max_results: int          — 最大结果数，默认 50

【输出】
  {
    brand: "品牌名",
    total_found: 120,
    issues: [
      {
        platform: "baidu",
        title: "过期信息标题",
        url: "https://...",
        issue_type: "outdated/negative/error",
        severity: "high/medium/low",
        summary: "内容摘要"
      }
    ],
    stats: { outdated: 15, negative: 8, error: 3 }
  }
"""
import os, json, time, re, urllib.request, urllib.error
from urllib.parse import quote

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
brand = params.get("brand", "")
platforms = params.get("platforms", ["baidu", "zhihu"])
scan_depth = min(params.get("scan_depth", 3), 5)
max_results = min(params.get("max_results", 50), 200)

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


def search_baidu(keyword: str, pages: int):
    """百度搜索 · 返回 (results, error_or_None)"""
    results = []
    last_err = None
    for p in range(pages):
        try:
            url = f"https://www.baidu.com/s?wd={quote(keyword)}&pn={p*10}"
            req = urllib.request.Request(url, headers=HEADERS)
            resp = urllib.request.urlopen(req, timeout=15)
            html = resp.read().decode("utf-8", errors="ignore")
            for m in re.finditer(r'<a[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>', html):
                u = m.group(1)
                t = re.sub(r'<[^>]+>', '', m.group(2)).strip()
                if u.startswith("http") and t and "baidu" not in u:
                    results.append({"platform": "baidu", "title": t[:100], "url": u[:200]})
            time.sleep(0.5)
        except Exception as e:
            last_err = str(e)[:200]
    return results, last_err


def search_zhihu(keyword: str, pages: int):
    """知乎搜索 · 返回 (results, error_or_None)"""
    results = []
    last_err = None
    for p in range(pages):
        try:
            url = f"https://www.zhihu.com/search?type=content&q={quote(keyword)}"
            req = urllib.request.Request(url, headers={**HEADERS, "Referer": "https://www.zhihu.com/"})
            resp = urllib.request.urlopen(req, timeout=15)
            html = resp.read().decode("utf-8", errors="ignore")
            for m in re.finditer(r'<a[^>]*href="(https?://www.zhihu.com[^"]+)"[^>]*>(.*?)</a>', html):
                u = m.group(1)
                t = re.sub(r'<[^>]+>', '', m.group(2)).strip()
                if t:
                    results.append({"platform": "zhihu", "title": t[:100], "url": u[:200]})
            time.sleep(0.5)
        except Exception as e:
            last_err = str(e)[:200]
    return results, last_err


def analyze_issue(item: dict, brand: str) -> dict:
    """分析单条信息的问题类型"""
    title = (item.get("title", "") + " " + item.get("snippet", "")).lower()
    brand_lower = brand.lower()
    
    # 检测负面关键词
    negative_keywords = ["投诉", "差评", "曝光", "维权", "骗", "假", "质量问题", "售后差", "不推荐", "避雷"]
    outdated_keywords = ["旧版", "已停", "历史", "以前", "老款", "过时", "旧"]
    error_keywords = ["出错", "错误", "异常", "bug", "故障"]
    
    is_negative = any(k in title for k in negative_keywords)
    is_outdated = any(k in title for k in outdated_keywords)
    is_error = any(k in title for k in error_keywords)
    
    if is_negative:
        issue_type = "negative"
        severity = "high"
    elif is_outdated:
        issue_type = "outdated"
        severity = "medium"
    elif is_error:
        issue_type = "error"
        severity = "high"
    else:
        issue_type = "info"
        severity = "low"
    
    return {"issue_type": issue_type, "severity": severity}


def process_results(results: list, brand: str) -> list:
    """处理搜索结果，标记问题类型"""
    processed = []
    for r in results:
        analysis = analyze_issue(r, brand)
        processed.append({
            **r,
            **analysis,
            "snippet": r.get("snippet", "")[:200],
            "summary": r.get("title", "")[:100],
        })
    return processed


if not brand:
    print(json.dumps({
        "task_type": "geo_scan",
        "status": "failed",
        "contract_version": "1",
        "failure_class": "invalid_params",
        "error": "缺少参数: brand (请传入要扫描的品牌名)",
        "summary_text": "❌ 缺少参数: brand",
        "usage": {"brand": "品牌名", "platforms": ["baidu", "zhihu"], "scan_depth": 3},
        "time": time.time(),
    }, ensure_ascii=False))
    raise SystemExit(1)

start_time = time.time()
all_results = []
searchers = {"baidu": search_baidu, "zhihu": search_zhihu}
platforms_ok = 0
platform_errors = []

for pname in platforms[:2]:  # 一次最多 2 个平台
    searcher = searchers.get(pname)
    if not searcher:
        platform_errors.append({"platform": pname, "error": "unsupported platform"})
        continue
    results, err = searcher(brand, min(scan_depth, 3))
    if results:
        platforms_ok += 1
        all_results.extend(results)
    elif err:
        platform_errors.append({"platform": pname, "error": err})
    else:
        # 请求看似成功但零结果：仍计为可访问
        platforms_ok += 1

# 全部平台不可用 → 依赖缺失（不是「扫描成功但无问题」）
if platforms_ok == 0:
    print(json.dumps({
        "task_type": "geo_scan",
        "status": "failed",
        "contract_version": "1",
        "failure_class": "dependency_missing",
        "error": "扫描源不可用 · 全部平台抓取失败（非『无命中』）",
        "summary_text": "❌ 扫描源不可用",
        "brand": brand,
        "platforms": platforms[:2],
        "platform_errors": platform_errors[:5],
        "execution_time_ms": int((time.time() - start_time) * 1000),
        "time": time.time(),
    }, ensure_ascii=False, indent=2))
    raise SystemExit(1)

processed = process_results(all_results[:max_results], brand)

issues = [r for r in processed if r["issue_type"] != "info"]
stats = {}
for r in processed:
    t = r["issue_type"]
    stats[t] = stats.get(t, 0) + 1

output = {
    "task_type": "geo_scan",
    "status": "ok",
    "contract_version": "1",
    "brand": brand,
    "total_found": len(processed),
    "total_issues": len(issues),
    "stats": stats,
    "issues": issues[:30],
    "empty_result": len(processed) == 0,
    "platforms_ok": platforms_ok,
    "platform_errors": platform_errors[:5],
    "summary_text": (
        f"✅ 扫描完成 · 无命中（brand={brand}）"
        if not processed else
        f"✅ 扫描完成 · {len(processed)} 条 / 问题 {len(issues)}"
    ),
    "execution_time_ms": int((time.time() - start_time) * 1000),
    "time": time.time(),
}

print(json.dumps(output, ensure_ascii=False, indent=2))
