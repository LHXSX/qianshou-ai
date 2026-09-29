"""
GEO 监测 · NLP 分析 (W2-3 · MVP 简化版)

设计 (MVP):
  - 不依赖外部 NLP 库 (jieba/transformers/...) · 纯规则
  - 输入: LLM 原始响应 (str) + 监测品牌 (brand_name + aliases) + 关键词
  - 输出: GeoObservation 5 大指标
    · mention_count    · 品牌被提及次数 (alias 匹配 · 大小写不敏感)
    · rank_position    · 排名 (品牌首次出现的位置 · 越靠前越好 · None=未提及)
    · sentiment        · 情感 (-1.0~1.0 · MVP 用关键词词典)
    · recommended      · 是否被推荐 (含"推荐/最好/首选/值得"等词 + 品牌名同段落)
    · competitors      · 同响应里其他品牌 (top-K · 词典匹配)

未来 P2 升级:
  - 接 jieba 分词
  - 接 BERT 情感模型 (server 跑 · 1ms/句)
  - 接竞品词典 (按 category)
  - 接 GPT-4 二次分析 (高级套餐)
"""
from __future__ import annotations
import logging
import re
from dataclasses import dataclass

logger = logging.getLogger(__name__)


# ════════════════════════════════════════════════════════════════
# 情感词典 (MVP · 中英文混合)
# ════════════════════════════════════════════════════════════════
_POSITIVE_WORDS = {
    # 中文
    "好", "优秀", "出色", "卓越", "推荐", "建议", "首选", "最佳", "最好", "顶级",
    "强大", "稳定", "可靠", "高效", "流畅", "性价比", "值得", "满意", "喜欢",
    "领先", "突出", "杰出", "独特", "创新", "便利",
    # English
    "good", "great", "excellent", "best", "top", "recommend", "recommended",
    "outstanding", "superior", "reliable", "robust", "powerful", "efficient",
    "smooth", "love", "favorite", "preferred", "innovative", "leading",
}

_NEGATIVE_WORDS = {
    # 中文
    "差", "糟糕", "失败", "崩溃", "卡顿", "慢", "不行", "不好", "缺陷", "问题",
    "故障", "Bug", "bug", "失望", "不推荐", "避免", "不要", "垃圾", "废",
    # English
    "bad", "poor", "worst", "terrible", "awful", "slow", "broken", "unstable",
    "buggy", "disappointed", "avoid", "junk", "garbage", "fail", "failed",
}

_RECOMMEND_PATTERNS = [
    r"(推荐|建议|首选|强烈推荐|值得购买|值得选择|最佳选择|不错的选择)",
    r"(recommend|suggested|best choice|top pick|go-to)",
]


# ════════════════════════════════════════════════════════════════
# 简单竞品词典 (MVP · 按 category 扩 · 这里给个 default)
# ════════════════════════════════════════════════════════════════
_COMMON_BRANDS = {
    "phone": ["Apple", "苹果", "iPhone", "华为", "Huawei", "小米", "Xiaomi",
              "vivo", "OPPO", "三星", "Samsung", "荣耀", "Honor", "魅族", "Meizu"],
    "auto": ["特斯拉", "Tesla", "比亚迪", "BYD", "蔚来", "NIO", "理想", "Li Auto",
             "小鹏", "Xpeng", "丰田", "Toyota", "本田", "Honda", "大众", "VW"],
    "food": ["可口可乐", "Coca-Cola", "百事", "Pepsi", "雀巢", "Nestle", "蒙牛", "伊利"],
    "ai": ["ChatGPT", "GPT-4", "Claude", "Gemini", "Kimi", "DeepSeek", "豆包", "文心"],
}


# ════════════════════════════════════════════════════════════════
# 主分析函数
# ════════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class AnalysisResult:
    mention_count: int                     # 品牌被提及次数
    rank_position: int | None              # 排名 (1-base · None=未提及)
    sentiment: float | None                # -1.0 ~ 1.0
    recommended: bool                      # 是否被推荐
    competitors: list[str]                 # 其他品牌 (top-10)
    raw_excerpt: str                       # 相关片段 (≤ 500 chars)


def analyze(
    response_text: str,
    brand_name: str,
    brand_aliases: list[str] | None = None,
    *,
    category: str | None = None,
    extra_competitors: list[str] | None = None,
) -> AnalysisResult:
    """对 LLM 响应做 NLP 分析 · 返 AnalysisResult
    
    Args:
        response_text: LLM 原始响应文本
        brand_name: 被监测的主品牌名
        brand_aliases: 品牌别名 (Apple/苹果 等)
        category: 品牌类别 (phone/auto/...) · 用于查 _COMMON_BRANDS
        extra_competitors: 额外竞品词典 (客户自定义)
    
    Returns:
        AnalysisResult
    """
    if not response_text:
        return AnalysisResult(
            mention_count=0, rank_position=None, sentiment=None,
            recommended=False, competitors=[], raw_excerpt="",
        )
    
    # 1. 品牌匹配 (主名 + 所有 aliases · 大小写不敏感)
    brand_tokens = [brand_name] + list(brand_aliases or [])
    brand_tokens = [t for t in brand_tokens if t and t.strip()]
    
    # 找所有 (token, position) 列表
    matches: list[tuple[str, int]] = []
    lower_text = response_text.lower()
    for token in brand_tokens:
        if not token:
            continue
        start = 0
        token_lower = token.lower()
        while True:
            pos = lower_text.find(token_lower, start)
            if pos < 0:
                break
            matches.append((token, pos))
            start = pos + len(token_lower)
    
    mention_count = len(matches)
    
    if mention_count == 0:
        # 未提及 · 但还要看竞品 + 情感
        rank_position = None
        sentiment = None
        recommended = False
    else:
        # 排名: 看品牌首次出现 vs 文本总长度 · 越靠前排名越好
        # MVP: 简单按相对位置算 (1 if 前 10% · 5 if 50%+ · 等)
        first_pos = min(m[1] for m in matches)
        if len(response_text) > 0:
            relative_pos = first_pos / len(response_text)
            if relative_pos < 0.1:
                rank_position = 1
            elif relative_pos < 0.25:
                rank_position = 2
            elif relative_pos < 0.5:
                rank_position = 3
            elif relative_pos < 0.75:
                rank_position = 4
            else:
                rank_position = 5
        else:
            rank_position = None
        
        # 情感: 取品牌附近 ±100 字的上下文 · 词典打分
        # 多次提及 · 取所有上下文平均
        scores: list[float] = []
        for _, pos in matches:
            context_start = max(0, pos - 100)
            context_end = min(len(response_text), pos + 100)
            context = response_text[context_start:context_end]
            scores.append(_sentiment_score(context))
        sentiment = round(sum(scores) / len(scores), 3) if scores else None
        
        # 是否推荐: 任一上下文匹配推荐 pattern
        recommended = False
        for _, pos in matches:
            context_start = max(0, pos - 80)
            context_end = min(len(response_text), pos + 80)
            context = response_text[context_start:context_end]
            for pattern in _RECOMMEND_PATTERNS:
                if re.search(pattern, context, flags=re.IGNORECASE):
                    recommended = True
                    break
            if recommended:
                break
    
    # 2. 竞品识别 (按 category + extra)
    competitor_pool: set[str] = set()
    if category and category in _COMMON_BRANDS:
        competitor_pool.update(_COMMON_BRANDS[category])
    if extra_competitors:
        competitor_pool.update(extra_competitors)
    # 排除自己
    for token in brand_tokens:
        competitor_pool.discard(token)
    
    competitors_found: list[str] = []
    for comp in competitor_pool:
        if comp.lower() in lower_text:
            competitors_found.append(comp)
    competitors_found = competitors_found[:10]
    
    # 3. 摘录: 取第一个品牌匹配 ±150 字上下文 (无匹配则取前 500)
    if matches:
        first_pos = min(m[1] for m in matches)
        excerpt_start = max(0, first_pos - 150)
        excerpt_end = min(len(response_text), first_pos + 350)
        excerpt = response_text[excerpt_start:excerpt_end]
    else:
        excerpt = response_text[:500]
    excerpt = excerpt.strip()[:500]
    
    return AnalysisResult(
        mention_count=mention_count,
        rank_position=rank_position,
        sentiment=sentiment,
        recommended=recommended,
        competitors=competitors_found,
        raw_excerpt=excerpt,
    )


def _sentiment_score(text: str) -> float:
    """词典打分 · 返 -1.0 ~ 1.0
    
    MVP: 正面词 +1 · 负面词 -1 · 总分 / 总词数 · 限定区间
    """
    text_lower = text.lower()
    pos = sum(1 for w in _POSITIVE_WORDS if w.lower() in text_lower)
    neg = sum(1 for w in _NEGATIVE_WORDS if w.lower() in text_lower)
    total = pos + neg
    if total == 0:
        return 0.0
    score = (pos - neg) / total
    return max(-1.0, min(1.0, score))
