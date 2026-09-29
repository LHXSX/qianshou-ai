"""result_envelope · 把「非 JSON 形状的结果」统一包装成平台合法信封。

背景
----
we_shards.output_ref 历史上存在三种形状（2026-09-18 全库统计，仅 DONE）：

- jsonish 3205 条 · 节点回报的聚合 JSON
- text     285 条 · 节点回报的纯文本（如 LLM 的最终回答）
- empty     82 条 · 无输出

聚合层 engine/aggregators/* 只认平台 JSON 信封
（{"status":"ok","schema_version":"v1","results":[...],"result_text":...}）。
纯文本形状喂进去时，load_shard_result 抛 ValueError，各聚合器 except 后
静默 skip 该分片，于是产出
{"summary":"合并 1 个分片 · 0 条记录","results":[],"result_text":""}
—— 一条真实存在的 75 字回答被合并成空结果，读取端随后读到空白。

设计约定（纯加法 · 向后兼容）
----------------------------
本模块只做一件事：判定 + 包装，不读库、不写库、不发网络请求、不做计费。
两个入口必须满足同一套契约：

1. normalize_result_envelope —— 读路径用。已落库的 workloads.result
   可能是纯文本；包装后交给既有 _result_as_json_or_text 消费。
2. wrap_plain_shard_result —— 聚合路径用。让聚合器不再丢弃纯文本分片。

契约（三条，测试逐条覆盖）：

- 合法 JSON 一律逐字节返回原文（最重要回归面）
  —— 既有的 3205 条 JSON 结果输出必须不变。
- 纯文本 → 包装成 status/schema_version/results[].answer/result_text 信封，
  原文一字不改。
- 空 → 原样返回 ""，不凭空造内容。

为什么复用不了 services/legacy_result_normalizer.py
------------------------------------------------------
该模块（LegacyResultNormalizer.normalize_and_enqueue）的职责边界是
入站 WebSocket 帧 → artifact.v1 → 结算校验入队：它绑定
LegacyResultEnvelope（含 shard/worker/attempt/lease 绑定与
_BOUND_ENVELOPE_CAPABILITY 能力令牌）、需要 DB 与存储后端、
产出 ArtifactV1 而不是展示信封，且只挂在 api/v8/ws.py 的 WS 路径上。

本模块需要的是「纯文本 → 展示信封」的单向纯函数，与结算/校验无关。
强行复用会把结算语义（隔离、去重、入队）拖进读取路径，风险高于收益，
所以这里只把可复用的形状判定抽出来共用（见 plain_text_body），
不复制其结算逻辑。
"""
from __future__ import annotations

import json

__all__ = [
    "ENVELOPE_SCHEMA_VERSION",
    "plain_text_body",
    "normalize_result_envelope",
    "wrap_plain_shard_result",
]

# 与 engine/aggregators/* 既有信封保持一致；本模块不改 schema_version 语义。
ENVELOPE_SCHEMA_VERSION = "v1"


def plain_text_body(raw: object) -> str | None:
    """判定 raw 是否为「纯文本形状」，是则返回原文，否则 None。

    None 覆盖三种情况：空值、合法 JSON（对象/数组/标量）、以及
    json.loads 能解析但却不是平台信封的 JSON。判定只看形状，不看语义，
    因此对调用方永远是纯加法：返回 None 时调用方行为与改动前完全一致。
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None
    try:
        json.loads(text)
    except (TypeError, ValueError):
        return text
    return None


def _envelope_for(text: str) -> dict:
    """按 manifest_only 的既有信封形状包装纯文本。"""
    body = text.strip()
    return {
        "status": "ok",
        "schema_version": ENVELOPE_SCHEMA_VERSION,
        "results": [{"answer": body}],
        "result_text": body,
        "summary_text": f"纯文本结果 · {len(body)} 字",
    }


def normalize_result_envelope(raw: object) -> object:
    """读路径归一：合法 JSON 原样返回，纯文本包装成信封，空则原样返回。

    返回类型与入参形状一致方便直接回填既有响应字段：
    合法 JSON 返回原字符串（不 re-dump，保证逐字节不变），
    纯文本返回信封 JSON 字符串，空返回原值。
    """
    if not isinstance(raw, str):
        return raw
    if not raw.strip():
        return raw
    text = plain_text_body(raw)
    if text is None:
        # 合法 JSON（或可解析的其他形状）—— 一个字都不动。
        return raw
    return json.dumps(_envelope_for(text), ensure_ascii=False)


def wrap_plain_shard_result(raw: object) -> dict | None:
    """聚合路径用：纯文本分片 → 可直接喂给聚合器主循环的 dict。

    非纯文本返回 None，调用方据此保持原有分支（丢异常 / 读 object_key），
    因此既有 JSON 分片与 object_key 分片的路径完全不受影响。
    """
    text = plain_text_body(raw)
    if text is None:
        return None
    env = _envelope_for(text)
    # 让 manifest_only 既有的 result_text 收集分支自然命中，
    # 也让 lines_merge 的多键回退把 answer 当作一条记录。
    env["shard_text"] = text
    return env


def _looks_like_recognised_manifest(text: str) -> bool:
    """复用 api/v8/workloads 的形状判定；避免把 URL/artifact 类结果误判成空壳。

    延迟 import：本模块要保持为叶子模块（无内部依赖），
    不能在建模块期就与 api 层形成环。
    """
    try:
        from platform_v8.api.v8.workloads import _looks_like_aggregator_manifest
    except Exception:
        return False
    try:
        return bool(_looks_like_aggregator_manifest(text))
    except Exception:
        return False


def _carries_answer(data: dict) -> bool:
    """结果里是否带了**用户可见正文**。

    只认真正承载答案的字段（result_text / text / results 内容）。
    刻意不认 summary_text —— 那是元信息（如「合并 1 个分片 · 共 0 条记录」），
    把它当正文正是「下载出来是一句摘要」的成因。
    """
    for key in ("result_text", "text"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return True
    results = data.get("results")
    return isinstance(results, list) and bool(results)


def is_empty_result_shell(raw: object) -> bool:
    """判定结果是否为「认得出形状但没有答案」的空壳。

    这是本方案的关键：聚合层丢弃纯文本分片后会产出
    {results: [], result_text: "", summary_text: "合并 N 个分片 · 共 0 条记录"}
    —— 合法 JSON、看起来正常，但内容在说谎；正文其实留在各分片里。

    刻意保守：**先问平台认不认**（含 artifact.v1）。只要平台认得出来
    （可下载 URL、preview_urls、result_lines、stats、download_kind=zip 等），
    就一律不算空壳，避免误伤「media/zip 任务只有 URL 没有正文」的正常结果。

    非 JSON 字符串返回 False：归一之后不可能还是原始文本形状。
    """
    if not isinstance(raw, str):
        return False
    text = raw.strip()
    if not text:
        return False
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return False
    if not isinstance(data, dict):
        # 合法 JSON 但不是对象（标量/数组）→ 没有可交付正文
        return True
    schema = str(data.get("schema") or data.get("schema_version") or "")
    if schema == "artifact.v1":
        return False
    if _looks_like_recognised_manifest(text):
        return False
    return not _carries_answer(data)


def reconcile_with_shard_texts(raw: object, shard_texts) -> object:
    """已落库结果不可用时，改用分片派生的正文。

    单一口径：Web 端 /result、/download 与开发者接口都调这一个函数，
    避免各自实现出第二份判据（那正是本轮要修的问题类型）。

    shard_texts 为空 / 全是空白时保持原样返回，绝不凭空造内容。
    """
    if not is_empty_result_shell(raw):
        return raw
    parts = [str(t).strip() for t in (shard_texts or []) if str(t).strip()]
    if not parts:
        return raw
    return "\n".join(parts)
