"""
v8 法律检索路由（外置资源库最小可用版）

提供给前端「文件审阅台」的可检索来源接口：
  POST /api/v8/legal/research/retrieve

设计目标：
1) 返回结构稳定（sourceId/type/title/articleOrCase/url/excerpt）
2) 离线可用、可核验：语料来自内置法条/案例库（platform_v8/api/v8/legal_corpus.py）
3) 检索为关键词 + 中文二元组重合打分，不做生成；后续可平滑替换为向量库/RAG 引擎
"""
from __future__ import annotations

import re

from fastapi import APIRouter
from pydantic import BaseModel, Field

from platform_v8.api.v8.legal_corpus import CORPUS

router = APIRouter(prefix="/api/v8/legal/research", tags=["v8-legal-research"])


class RetrieveReq(BaseModel):
    query: str = Field(..., min_length=1, description="检索问题或材料摘要")
    topK: int = Field(default=8, ge=1, le=30)
    limit: int = Field(default=8, ge=1, le=30)


class SourceItem(BaseModel):
    sourceId: str
    type: str
    title: str
    articleOrCase: str = ""
    url: str = ""
    excerpt: str = ""
    publisher: str = ""
    effectiveDate: str = ""


# 常见法律主题同义词，命中任一即视为该主题相关，提升召回
_SYNONYMS: dict[str, tuple[str, ...]] = {
    "违约": ("违约", "违约金", "违约责任", "毁约", "不履行", "赔偿"),
    "借贷": ("借贷", "借款", "欠款", "还款", "利息", "高利", "借据"),
    "合同": ("合同", "协议", "订立", "解除", "履行", "效力"),
    "保证": ("保证", "担保", "抵押", "质押", "连带"),
    "证据": ("证据", "举证", "质证", "证明"),
    "诉讼": ("诉讼", "起诉", "管辖", "保全", "时效", "仲裁"),
    "劳动": ("劳动", "工资", "试用期", "解除", "经济补偿", "社保", "加班", "赔偿金"),
    "消费": ("消费", "欺诈", "退一赔三", "假冒", "商品", "服务"),
    "食品": ("食品", "十倍", "食品安全"),
    "婚姻": ("婚姻", "离婚", "抚养", "夫妻", "财产分割", "家暴", "家庭暴力"),
    "继承": ("继承", "遗产", "遗嘱", "遗赠"),
    "侵权": ("侵权", "过错", "损害", "赔偿", "人身", "安全保障"),
    "人身损害": ("人身损害", "受伤", "工伤", "误工", "护理费", "残疾", "伤残", "医疗费", "营养费", "住院"),
    "劳务": ("劳务", "雇佣", "雇员", "提供劳务", "承揽", "务工", "受雇", "接受劳务"),
    "租赁": ("租赁", "租金", "承租", "出租", "欠租", "房租"),
}

_STOP = set("的了和与及或对在于是被把为了这那哪什么如何怎样请问一个我们你们")

# 超通用二元组：几乎出现在所有法条里，用于匹配会引入大量噪音，打分时剔除
_GENERIC = {
    "赔偿", "损失", "责任", "合同", "当事", "民事", "人民", "共和", "和国",
    "履行", "约定", "义务", "权利", "法律", "规定", "应当", "可以", "有权",
    "承担", "发生", "造成", "第一", "第二", "以下", "本法", "相关", "进行",
}

# 超通用关键词：跨领域的救济/关系词，单独命中不足以判定相关（如"赔偿金"会误配"残疾赔偿金"）
_GENERIC_KW = {
    "赔偿", "赔偿金", "损失", "损害", "责任", "违约", "合同", "担保", "费用", "支付",
}


def _tokens(text: str) -> set[str]:
    """把中文文本切成字符二元组 + 抓取的英文/数字词，作为匹配单元。"""
    text = text.strip().lower()
    grams: set[str] = set()
    # 英文/数字整词
    for w in re.findall(r"[a-z0-9]+", text):
        if len(w) >= 2:
            grams.add(w)
    # 连续中文串取二元组
    for chunk in re.findall(r"[\u4e00-\u9fff]+", text):
        chunk = "".join(c for c in chunk if c not in _STOP)
        if len(chunk) == 1:
            grams.add(chunk)
        for i in range(len(chunk) - 1):
            grams.add(chunk[i : i + 2])
    return grams


def _bag(item: dict) -> str:
    return (
        f"{item.get('title', '')} {item.get('articleOrCase', '')} "
        f"{item.get('excerpt', '')} {' '.join(item.get('keywords', []))}"
    ).lower()


def _score(query: str, q_tokens: set[str], item: dict) -> tuple[int, bool]:
    """返回 (分数, 是否强相关)。

    仅靠"通用二元组重合"不足以判定相关（会把食品安全法之类拉进来），
    因此区分强信号（策展关键词命中 / 真正的主题同义命中 / 短查询整句命中）
    与弱信号（二元组重合，仅用于强相关项之间的排序），由调用方按阈值过滤。
    """
    q = query.strip().lower()
    bag = _bag(item)
    kw = [k.lower() for k in item.get("keywords", [])]

    # 1) 短查询整句命中（长材料摘要不适用，避免恒不命中或误命中）
    phrase = bool(q and len(q) <= 400 and q in bag)

    # 2) 策展关键词命中（精度最高）；排除跨领域通用词，避免"赔偿金"之类误配
    kw_hits = sum(1 for k in kw if k and k not in _GENERIC_KW and k in q)

    # 3) 主题同义词命中：要求查询"确属"该主题（长材料摘要需≥2个同义词命中，避免单个通用词误触），
    #    且该条目也确属该主题（主题写进了 keywords，或该主题同义词在条目里出现≥2个）
    need_in_query = 2 if len(q) > 200 else 1
    topic_hits = 0
    for topic, syns in _SYNONYMS.items():
        in_query = sum(1 for s in syns if s in q) >= need_in_query
        in_item = (topic in kw) or (sum(1 for s in syns if s in bag) >= 2)
        if in_query and in_item:
            topic_hits += 1

    # 4) 二元组重合度（剔除超通用词后，仅用于排序，权重很低）
    overlap = len((q_tokens & _tokens(bag)) - _GENERIC)

    score = 300 * phrase + 80 * kw_hits + 50 * topic_hits + 2 * overlap

    # 强相关判定：仅靠"单个跨领域主题"或"零散二元组"不算相关，需具备实质信号：
    #   命中整句 / 命中具体关键词 / 同时命中≥2个主题 / 命中1个主题且有一定二元组重合
    strong = phrase or kw_hits >= 1 or topic_hits >= 2 or (topic_hits >= 1 and overlap >= 3)

    return score, strong


@router.post("/retrieve", summary="检索法条/案例来源（前端 RAG 入口）")
async def retrieve(req: RetrieveReq) -> dict:
    k = max(1, min(int(req.limit or req.topK or 8), 30))
    q_tokens = _tokens(req.query)
    scored = [(item, *_score(req.query, q_tokens, item)) for item in CORPUS]

    # 只保留"强相关"项（具备实质信号），按分数排序；强相关判定已在 _score 中完成
    strong_hits = sorted(
        [(item, s) for item, s, strong in scored if strong and s > 0],
        key=lambda pair: pair[1],
        reverse=True,
    )
    if strong_hits:
        ranked = [item for item, _ in strong_hits]
    else:
        # 无强相关：只回退极少量得分最高的条文，避免整份无来源，同时不引入噪音
        fallback = sorted(scored, key=lambda t: t[1], reverse=True)
        ranked = [item for item, s, _ in fallback[:3] if s > 0]

    items = [SourceItem(**{k2: v for k2, v in x.items() if k2 != "keywords"}).model_dump() for x in ranked[:k]]
    return {
        "ok": True,
        "query": req.query,
        "count": len(items),
        "items": items,
    }
