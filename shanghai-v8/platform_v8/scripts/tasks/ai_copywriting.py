#!/usr/bin/env python3
"""ai_copywriting — AI 营销文案生成 (企业级 · 2026-06-07 S5 升级)

新增:
  - **多版本输出**(versions=3 · 一次出 3 个 A/B 测试候选)
  - 多平台深度模板(小红书/抖音/朋友圈/详情页/B 站/视频号/微博)
  - 行业模板(美妆/3C/食品/服装/教育/家居/汽车/医美)
  - 结构化输出(用 JSON 而非 | 切分 · 避免标题含 | 出错)
  - endpoints fallback + 重试
  - 字数控制(short<100 / medium<300 / long<800)
  - 关键词强制嵌入
  - hashtags 数量可控
  - 费用估算

参数 (EC_PARAMS):
  product         str    产品(必填)
  description     str    产品详细描述(可选 · 提升质量)
  platform        str    xiaohongshu/douyin/wechat/ecommerce/bilibili/wechat_video/weibo
  industry        str    beauty/3c/food/clothing/education/home/car/medical/general
  tone            str    casual / formal / persuasive / professional / cute / urgent
  length          str    short / medium / long
  keywords        list   强制嵌入关键词
  versions        int    生成几个候选 (默认 1 · 多版本 A/B)
  max_hashtags    int    话题标签数 (默认 5)
  endpoints       list   API 列表 fallback
  endpoint        str    单 endpoint(优先 endpoints)
  api_key         str    Bearer
  model           str    默认 ec-master
  timeout         int    默认 60
  retry           int    默认 2
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request


_PLATFORM_TEMPLATES = {
    "xiaohongshu": {
        "name": "小红书",
        "style": "种草爆款风 · emoji 丰富 · 分点清晰 · 真人体验感 · 痛点+解决方案",
        "title_max": 20,
        "body_min": 150, "body_max": 400,
        "must_have": ["✨ 或 💡 等 emoji 开头", "标签结尾 #xxx", "亲身体验口吻"],
    },
    "douyin": {
        "name": "抖音",
        "style": "短平快 · 钩子+反转+引导 · 适合 60s 内口播",
        "title_max": 16,
        "body_min": 60, "body_max": 200,
        "must_have": ["第一句必须钩子", "节奏感强", "结尾引导互动"],
    },
    "wechat": {
        "name": "朋友圈",
        "style": "亲切自然 · 私域感强 · 故事化 · 不要硬广痕迹",
        "title_max": 25,
        "body_min": 80, "body_max": 300,
        "must_have": ["第一人称叙述", "适当口语", "避免广告法违禁词"],
    },
    "ecommerce": {
        "name": "电商详情页",
        "style": "卖点+痛点+解决方案 · USP 清晰 · 信任背书 · 转化话术",
        "title_max": 50,
        "body_min": 200, "body_max": 800,
        "must_have": ["USP 加粗", "数字化卖点", "限时/限量等紧迫感"],
    },
    "bilibili": {
        "name": "B 站",
        "style": "二次元/UP 主风 · 信息密度高 · 互动梗 · 有 av/视频引导",
        "title_max": 30, "body_min": 100, "body_max": 500,
        "must_have": ["开头 'UP 主' 或 '小伙伴们'", "结尾求三连"],
    },
    "wechat_video": {
        "name": "视频号",
        "style": "微信生态 · 中老年友好 · 实用感 · 朴实",
        "title_max": 22, "body_min": 80, "body_max": 250,
        "must_have": ["开门见山", "避免网络梗"],
    },
    "weibo": {
        "name": "微博",
        "style": "140 字精炼 · 强观点 · 蹭热搜 · @KOL",
        "title_max": 30, "body_min": 60, "body_max": 140,
        "must_have": ["话题 # 包围", "@ 相关账号"],
    },
}

_INDUSTRY_TEMPLATES = {
    "beauty": "美妆行业 · 突出成分/质地/试色/适合肤质/前后对比 · 避免医疗化暗示",
    "3c": "3C 数码 · 突出参数/性能/做工/续航/兼容性 · 用专业术语",
    "food": "食品 · 突出口感/食材/工艺/产地/卫生 · 避免医疗功效宣称",
    "clothing": "服装 · 突出版型/面料/搭配/场景/上身效果",
    "education": "教育 · 突出师资/方法论/案例/口碑 · 避免承诺式表达",
    "home": "家居 · 突出材质/设计/空间利用/家庭场景",
    "car": "汽车 · 突出性能/安全/智能/价格区间",
    "medical": "医美 · 严格合规 · 不能宣称疗效 · 仅描述体验",
    "general": "通用风格 · 平衡卖点和情感",
}

_TONE_DESC = {
    "casual": "轻松随意 · 像朋友聊天",
    "formal": "正式专业 · 商务感",
    "persuasive": "强引导 · 痛点放大 · 紧迫感",
    "professional": "理性专业 · 数据 + 案例",
    "cute": "可爱萌系 · 颜文字 · 软糯",
    "urgent": "紧迫高压 · 限时限量",
}


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _post(url: str, body: dict, headers: dict, timeout: int):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    h = {"Content-Type": "application/json", **headers}
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _call_with_retry(endpoints, body, headers, timeout, retry):
    last = None
    for ep in endpoints:
        for attempt in range(retry + 1):
            try:
                return _post(ep, body, headers, timeout), ep
            except urllib.error.HTTPError as he:
                last = f"HTTP {he.code}@{ep}"
                if 400 <= he.code < 500 and he.code != 429:
                    break
            except Exception as exc:
                last = f"{exc}@{ep}"
            if attempt < retry:
                time.sleep(1.5 ** attempt)
    raise RuntimeError(last or "all endpoints failed")


def _build_prompt(product: str, description: str, platform: str, industry: str,
                  tone: str, length: str, keywords: list, max_hashtags: int) -> tuple:
    pt = _PLATFORM_TEMPLATES.get(platform, _PLATFORM_TEMPLATES["xiaohongshu"])
    ind = _INDUSTRY_TEMPLATES.get(industry, _INDUSTRY_TEMPLATES["general"])
    tone_desc = _TONE_DESC.get(tone, _TONE_DESC["casual"])

    length_hint = {
        "short": f"正文 {pt['body_min']} 字左右(短)",
        "medium": f"正文 {(pt['body_min']+pt['body_max'])//2} 字左右(中)",
        "long": f"正文 {pt['body_max']} 字左右(长)",
    }.get(length, "正文中等长度")

    kw_str = "、".join(keywords[:10]) if keywords else ""

    system = (
        f"你是顶级营销文案专家。为「{pt['name']}」平台写广告文案。\n\n"
        f"平台风格: {pt['style']}\n"
        f"硬性要求: {' / '.join(pt['must_have'])}\n"
        f"行业风格: {ind}\n"
        f"语气: {tone_desc}\n"
        f"长度: {length_hint}\n"
        f"标题: ≤ {pt['title_max']} 字 · 强钩子\n"
        f"话题标签: {max_hashtags} 个相关 hashtag\n"
        + (f"\n关键词强制嵌入: {kw_str}\n" if kw_str else "")
        + "\n严格按 JSON 输出 · 不要任何解释或代码块:\n"
        '{"title":"...", "body":"...", "hashtags":["#xxx", ...]}'
    )

    user = f"产品: {product}"
    if description:
        user += f"\n详细描述: {description[:500]}"
    return system, user


def _extract_json(text: str):
    s = text.strip()
    if s.startswith("```"):
        s = re.sub(r"^```\w*\n?", "", s)
        s = re.sub(r"\n?```$", "", s)
        s = s.strip()
    try:
        return json.loads(s)
    except Exception:
        pass
    start = s.find("{")
    end = s.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(s[start:end + 1])
        except Exception:
            return None
    return None


def main():
    t0 = time.time()
    try:
        p = _params()
        product = (p.get("product") or "").strip()
        if not product:
            raise ValueError("缺 product")

        description = p.get("description") or ""
        platform = (p.get("platform") or "xiaohongshu").lower()
        industry = (p.get("industry") or "general").lower()
        tone = (p.get("tone") or "casual").lower()
        length = (p.get("length") or "medium").lower()
        keywords = p.get("keywords") or []
        versions = max(1, min(10, int(p.get("versions") or 1)))
        max_hashtags = max(0, min(20, int(p.get("max_hashtags") or 5)))

        endpoints = p.get("endpoints") or ([p["endpoint"]] if p.get("endpoint") else [])
        if not endpoints:
            # 兼容老 env
            base = os.environ.get("AI_SCRIPT_BASE_URL", "https://www.qianshousuanli.com")
            endpoints = [f"{base.rstrip('/')}/api/v1/chat/completions"]
        model = p.get("model") or "ec-master"
        timeout = int(p.get("timeout") or 60)
        retry = int(p.get("retry") if p.get("retry") is not None else 2)
        headers = {}
        ak = p.get("api_key") or os.environ.get("AI_SCRIPT_API_KEY", "")
        if ak:
            headers["Authorization"] = f"Bearer {ak}"

        system, user = _build_prompt(product, description, platform, industry,
                                     tone, length, keywords, max_hashtags)

        results = []
        errors = []
        total_in = total_out = 0
        # 多版本:同 prompt 多次调 + 不同 temperature 提升多样性
        temps = [0.7, 0.85, 0.95, 1.05, 1.15, 1.25, 0.6, 0.5, 1.0, 0.8][:versions]
        for v_idx, temperature in enumerate(temps):
            body = {
                "model": model,
                "temperature": temperature,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            }
            try:
                r, _ = _call_with_retry(endpoints, body, headers, timeout, retry)
                answer = (r.get("choices", [{}])[0]
                          .get("message", {}).get("content", "") or "").strip()
                usage = r.get("usage") or {}
                total_in += int(usage.get("prompt_tokens") or 0)
                total_out += int(usage.get("completion_tokens") or 0)

                parsed = _extract_json(answer)
                if parsed and isinstance(parsed, dict):
                    title = (parsed.get("title") or "").strip()
                    body_text = (parsed.get("body") or "").strip()
                    hashtags = parsed.get("hashtags") or []
                    if isinstance(hashtags, str):
                        # 兼容 "#a #b #c"
                        hashtags = re.findall(r"#\S+", hashtags)
                    hashtags = [str(h) for h in hashtags][:max_hashtags]
                    # 关键词覆盖率检查
                    kw_hit = sum(1 for k in keywords if k in body_text) if keywords else 0
                    results.append({
                        "version": v_idx + 1,
                        "title": title,
                        "body": body_text,
                        "hashtags": hashtags,
                        "title_len": len(title),
                        "body_len": len(body_text),
                        "keyword_coverage": (f"{kw_hit}/{len(keywords)}" if keywords else "n/a"),
                        "temperature": temperature,
                    })
                else:
                    # JSON 解析失败 · 仍返原文
                    results.append({
                        "version": v_idx + 1,
                        "title": "", "body": answer,
                        "hashtags": [],
                        "title_len": 0, "body_len": len(answer),
                        "keyword_coverage": "n/a",
                        "temperature": temperature,
                        "warning": "JSON 解析失败 · 仅返原文",
                    })
            except Exception as exc:
                errors.append({"version": v_idx + 1, "error": str(exc)[:200]})

        if not results:
            print(json.dumps({
                "status": "failed", "task_type": "ai_copywriting",
                "error": "全部生成失败", "errors": errors,
                "summary_text": "❌ 文案生成失败 · " + (errors[0]["error"] if errors else ""),
            }, ensure_ascii=False))
            return 1

        elapsed = int((time.time() - t0) * 1000)
        first = results[0]
        out = {
            "status": "ok", "schema_version": "v1", "task_type": "ai_copywriting",
            "elapsed_ms": elapsed,
            "summary": {
                "product": product[:80],
                "platform": platform, "industry": industry,
                "tone": tone, "length": length,
                "versions_requested": versions,
                "versions_generated": len(results),
                "input_tokens": total_in,
                "output_tokens": total_out,
                "model": model,
            },
            # 主版本兼容老消费方
            "title": first["title"],
            "body": first["body"],
            "hashtags": first["hashtags"],
            # 多版本
            "versions": results,
            "errors": errors,
            "summary_text": (
                f"✅ {platform} 文案 · {len(results)}/{versions} 版本 · {industry}/{tone}/{length}\n"
                f"📝 主版本: {first['title']}\n"
                f"📊 Token: in {total_in} / out {total_out} · ⏱ {elapsed}ms"
            ),
        }
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "ai_copywriting",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
