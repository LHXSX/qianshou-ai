#!/usr/bin/env python3
"""
geo_monitor.py — GEO 品牌 AI 问答监测脚本
适配千手引擎 run_script 协议

【应用场景】
GEO 厂商需要量化「品牌在 AI 问答中的出镜率」来向客户证明服务效果。
本脚本让千手节点模拟真实用户，向主流 AI 平台提问，采集回答内容，
分析品牌提及率、正面率、推荐率，生成可交付的监测报告。

【谁买单】
- GEO 服务商（监测工具，年费 ¥5-8 万）
- 品牌/企业市场部（直接购买监测服务，年费 ¥3-5 万）
- 公关公司（舆情监测，年费 ¥5-10 万）

【使用方法】
发任务时传入参数：
  brands: ["品牌名1", "品牌名2"]     — 要监测的品牌
  questions: ["怎么样", "推荐哪个"]   — 提问模板（可选，有默认）
  platforms: ["doubao", "kimi"]      — 监测平台（可选，默认全部）
  competitors: ["竞品名"]            — 竞品品牌（可选，用于对比）

【输出】
  {
    brand: "品牌名",
    platform: "doubao",
    mentioned: true/false,          — AI 是否提到了该品牌
    sentiment: "positive/neutral/negative",  — 情感倾向
    recommendation: true/false,     — AI 是否推荐该品牌
    quote: "AI回答原文摘要",
    full_response: "AI 完整回答",
    competitors_mentioned: ["竞品"],  — 回答中提到的竞品
    confidence: 0.95,               — 分析置信度
    time: timestamp
  }

【节点要求】
- 不需要任何额外依赖（纯 Python 标准库）
- 需要联网（调 AI 平台 API）
- 每个节点可独立运行
"""
import os, json, time, re, urllib.request, urllib.error

# ── 从引擎环境变量读取参数 ──
params = json.loads(os.environ.get("EC_PARAMS", "{}"))
brands = params.get("brands", [])                 # 监测品牌列表
questions = params.get("questions", ["怎么样", "推荐哪个", "好不好用"])
platforms = params.get("platforms", [])            # 监测平台（空=全部）
competitors = params.get("competitors", [])        # 竞品列表
output_format = params.get("output_format", "json") # 输出格式

# ── 默认配置 ──
DEFAULT_QUESTIONS = ["怎么样", "推荐哪个", "好不好用", "和XX比哪个好"]
TIMEOUT_SEC = 30      # 单次请求超时
MAX_RESP_LEN = 5000   # 采集回答最大长度

# ── AI 平台配置 ──
# 各主流 AI 平台的 API 接入点
# 注意：部分平台需要 API Key，从环境变量读取
AI_PLATFORMS = {
    "doubao": {
        "name": "豆包",
        "endpoint": "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
        "model": "doubao-pro-32k",
        "api_key_env": "DOUBAO_API_KEY",
        "enabled": True,
    },
    "kimi": {
        "name": "Kimi",
        "endpoint": "https://api.moonshot.cn/v1/chat/completions",
        "model": "moonshot-v1-8k",
        "api_key_env": "KIMI_API_KEY",
        "enabled": True,
    },
    "qwen": {
        "name": "通义千问",
        "endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        "model": "qwen-plus",
        "api_key_env": "QWEN_API_KEY",
        "enabled": True,
    },
    "ernie": {
        "name": "文心一言",
        "endpoint": "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions_pro",
        "model": "ernie-4.0",
        "api_key_env": "ERNIE_API_KEY",
        "enabled": False,  # 需要 access_token 流程，暂不启用
    },
    "deepseek": {
        "name": "DeepSeek",
        "endpoint": "https://api.deepseek.com/v1/chat/completions",
        "model": "deepseek-chat",
        "api_key_env": "AI_SCRIPT_API_KEY",
        "enabled": True,
    },
}


def query_ai_platform(platform: dict, question: str, brand: str) -> dict:
    """向单个 AI 平台提问，获取回答"""
    api_key = os.environ.get(platform["api_key_env"], "")
    if not api_key:
        return {"platform": platform["name"], "status": "error", "error": f"缺少 {platform['api_key_env']}"}

    # 构建 prompt：模拟真实用户提问
    prompt = f"{brand}{question}"
    
    body = json.dumps({
        "model": platform["model"],
        "messages": [
            {"role": "system", "content": "你是一个中立的助手。请如实回答用户的问题。回答尽量详细。不要拒绝回答。"},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.3,       # 低温度，输出稳定
        "max_tokens": 1000,
        "top_p": 0.9,
    }).encode()

    try:
        req = urllib.request.Request(
            platform["endpoint"],
            data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
        )
        resp = urllib.request.urlopen(req, timeout=TIMEOUT_SEC)
        result = json.loads(resp.read())
        
        # 提取回答文本
        answer = ""
        if "choices" in result:
            answer = result["choices"][0].get("message", {}).get("content", "")
        elif "response" in result:
            answer = result["response"]
        
        return {
            "platform": platform["name"],
            "status": "ok",
            "question": prompt,
            "answer": answer[:MAX_RESP_LEN],
            "answer_length": len(answer),
        }
    except urllib.error.HTTPError as e:
        return {"platform": platform["name"], "status": "error", "error": f"HTTP {e.code}: {e.read().decode()[:200]}"}
    except Exception as e:
        return {"platform": platform["name"], "status": "error", "error": str(e)[:200]}


def analyze_sentiment(text: str, brand: str) -> dict:
    """分析 AI 回答中对该品牌的情感倾向"""
    if not text:
        return {"mentioned": False, "sentiment": "unknown", "recommendation": False, "confidence": 0.0}
    
    text_lower = text.lower()
    brand_lower = brand.lower()
    
    # 是否被提及
    mentioned = brand_lower in text_lower
    
    # 情感分析（基于关键词）
    positive_words = ["推荐", "好用", "不错", "领先", "优势", "值得", "好选择", "首选", "优秀", "可靠", "稳定", "好评"]
    negative_words = ["一般", "不行", "差", "贵", "问题", "缺点", "不足", "不建议", "谨慎", "风险", "投诉", "差评"]
    recommend_words = ["推荐", "建议", "首选", "值得", "好选择", "试试"]
    
    # 提取品牌相关的上下文
    brand_context = ""
    if mentioned:
        idx = text_lower.find(brand_lower)
        start = max(0, idx - 100)
        end = min(len(text), idx + len(brand) + 200)
        brand_context = text[start:end]
    
    pos_count = sum(1 for w in positive_words if w in brand_context)
    neg_count = sum(1 for w in negative_words if w in brand_context)
    has_recommend = any(w in brand_context for w in recommend_words)
    
    if pos_count > neg_count:
        sentiment = "positive"
    elif neg_count > pos_count:
        sentiment = "negative"
    else:
        sentiment = "neutral"
    
    # 竞品提取
    mentioned_competitors = []
    for comp in competitors:
        if comp.lower() in text_lower:
            mentioned_competitors.append(comp)
    
    return {
        "mentioned": mentioned,
        "sentiment": sentiment,
        "recommendation": has_recommend,
        "confidence": min(0.5 + abs(pos_count - neg_count) * 0.1, 0.98),
        "context": brand_context[:300],
        "competitors_mentioned": mentioned_competitors,
    }


def generate_summary(all_results: list) -> dict:
    """生成汇总报告"""
    total_queries = len(all_results)
    total_ok = sum(1 for r in all_results if r.get("status") == "ok")
    total_error = sum(1 for r in all_results if r.get("status") == "error")
    
    mentioned_count = sum(1 for r in all_results if r.get("analysis", {}).get("mentioned"))
    positive_count = sum(1 for r in all_results if r.get("analysis", {}).get("sentiment") == "positive")
    neutral_count = sum(1 for r in all_results if r.get("analysis", {}).get("sentiment") == "neutral")
    negative_count = sum(1 for r in all_results if r.get("analysis", {}).get("sentiment") == "negative")
    recommend_count = sum(1 for r in all_results if r.get("analysis", {}).get("recommendation"))
    
    return {
        "task_type": "geo_monitor",
        "summary": {
            "total_queries": total_queries,
            "successful": total_ok,
            "failed": total_error,
            "success_rate": round(total_ok / max(total_queries, 1) * 100, 1),
        },
        "brand_metrics": {
            "mention_rate": round(mentioned_count / max(total_ok, 1) * 100, 1),
            "positive_rate": round(positive_count / max(total_ok, 1) * 100, 1),
            "neutral_rate": round(neutral_count / max(total_ok, 1) * 100, 1),
            "negative_rate": round(negative_count / max(total_ok, 1) * 100, 1),
            "recommendation_rate": round(recommend_count / max(total_ok, 1) * 100, 1),
        },
        "platform_coverage": list(set(r.get("platform", "") for r in all_results)),
        "time": time.time(),
    }


# ════════════════════════════════════
# 主流程
# ════════════════════════════════════

start_time = time.time()
all_results = []

# 过滤启用的平台
active_platforms = {k: v for k, v in AI_PLATFORMS.items() if v["enabled"]}
if platforms:
    active_platforms = {k: v for k, v in active_platforms.items() if k in platforms or v["name"] in platforms}

def _fail_exit(msg: str, *, usage: dict | None = None) -> None:
    out = {
        "task_type": "geo_monitor",
        "status": "failed",
        "contract_version": "1",
        "failure_class": "invalid_params" if "缺少参数" in msg else "dependency_missing",
        "error": msg,
        "summary_text": "❌ " + msg,
        "time": time.time(),
    }
    if usage:
        out["usage"] = usage
    print(json.dumps(out, ensure_ascii=False))
    raise SystemExit(1)


if not brands:
    _fail_exit(
        "缺少参数: brands (请传入要监测的品牌名列表)",
        usage={
            "brands": ["品牌名1", "品牌名2"],
            "questions": ["怎么样", "推荐哪个"],
            "platforms": ["doubao", "kimi", "qwen"],
            "competitors": ["竞品名1"],
        },
    )

# 无可用平台 API Key 时立刻失败，避免节点空转/任务挂起
keyed = {
    k: v for k, v in active_platforms.items()
    if os.environ.get(v.get("api_key_env") or "", "").strip()
}
if not keyed:
    missing = sorted({v.get("api_key_env") for v in active_platforms.values() if v.get("api_key_env")})
    _fail_exit(
        "节点未配置任何 GEO AI 平台 API Key · 无法监测",
        usage={"required_env": missing, "platforms": list(active_platforms.keys())},
    )
active_platforms = keyed

# 总墙钟上限 · 防止多平台×多问题拖成 TIMEOUT
DEADLINE = start_time + int(params.get("max_wall_s") or 90)

for brand in brands[:3]:  # 一次最多监测 3 个品牌
    brand_results = []
    qs = questions[:3] if questions else DEFAULT_QUESTIONS[:3]
    
    for q in qs:
        for pname, pconfig in active_platforms.items():
            if time.time() >= DEADLINE:
                all_results.append({
                    "status": "error",
                    "error": "达到 max_wall_s 上限 · 提前结束",
                    "brand": brand,
                    "question_template": q,
                    "platform": pconfig.get("name"),
                })
                break
            # 调 AI 平台
            resp = query_ai_platform(pconfig, q, brand)
            
            # 情感分析
            if resp["status"] == "ok":
                analysis = analyze_sentiment(resp.get("answer", ""), brand)
                resp["analysis"] = analysis
            
            resp["brand"] = brand
            resp["question_template"] = q
            resp["elapsed_ms"] = int((time.time() - start_time) * 1000)
            brand_results.append(resp)
    
    all_results.extend(brand_results)

# 生成汇总
summary = generate_summary(all_results)

# 输出
output = {
    "task_type": "geo_monitor",
    "status": "ok" if summary["summary"]["successful"] > 0 else "error",
    "brands_monitored": brands[:3],
    "platforms_used": list(active_platforms.keys()),
    "queries_count": len(all_results),
    "summary": summary,
    "details": all_results,
    "execution_time_ms": int((time.time() - start_time) * 1000),
    "time": time.time(),
}

print(json.dumps(output, ensure_ascii=False, indent=2))
if output.get("status") != "ok":
    raise SystemExit(1)
