"""
GEO 监测 · aggregator hook (W2-7)

工作模式:
  - shard 完成 (aggregator.on_shard_done) · 检查 sh.metadata['business'] == 'geo'
  - 是 GEO · 取 shard.output (LLM 响应) · 调 nlp_analyze · 写 we_geo_observations
  - hook 通过 event_bus 订阅 shard.completed 事件 (P4.19 已实现)

注: 不修改 aggregator.py 主代码 · 通过 event_bus 解耦订阅
"""
from __future__ import annotations
import json
import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

from . import nlp_analyze
from . import brands as brands_svc

logger = logging.getLogger(__name__)


async def on_shard_completed(event) -> None:
    """event_bus 订阅 shard.completed 事件
    
    event.payload: {
        "workload_id": str,
        "shard_id": str,
        "worker_id": str | None,
        "outcome": "success" | "failure",
    }
    """
    payload = event.payload if hasattr(event, "payload") else (event or {})
    if not isinstance(payload, dict):
        return
    
    if payload.get("outcome") != "success":
        return  # 失败不分析
    
    shard_id = payload.get("shard_id")
    workload_id = payload.get("workload_id")
    if not shard_id or not workload_id:
        return
    
    # 用 to_thread 包 DB 操作
    import asyncio
    try:
        await asyncio.to_thread(_process_shard_sync, shard_id, workload_id)
    except Exception as exc:
        logger.warning("geo.aggregator_hook · shard=%s err=%s", shard_id[:8], exc)


def _process_shard_sync(shard_id: str, workload_id: str) -> None:
    """同步处理 (在线程池跑)"""
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo, WorkloadRepo
    
    with db_mod.session_scope() as s:
        sh = ShardRepo.by_id(s, shard_id)
        if sh is None:
            return
        # 业务过滤 · 只处理 GEO
        if (sh.metadata or {}).get("business") != "geo":
            return
        
        # 解析 LLM 输出
        output_ref = sh.output_ref or ""
        response_text, response_hash, llm_code, keyword = _parse_llm_output(
            output_ref, sh.metadata or {},
        )
        if not response_text:
            logger.debug("geo · shard=%s 无响应文本 · 跳过 NLP", shard_id[:8])
            return
        
        # 拿 workload spec params 里的 brand 信息
        wl = WorkloadRepo.by_id(s, workload_id)
        if wl is None:
            return
        params = (wl.spec.params or {}) if wl.spec else {}
        brand_id = int(params.get("brand_id", 0))
        brand_name = params.get("brand_name", "")
        brand_aliases = list(params.get("brand_aliases") or [])
        category = params.get("category")
        
        if not brand_name or brand_id == 0:
            logger.warning("geo · workload=%s brand 信息缺失 · 跳过", workload_id[:8])
            return
        
        # 跑 NLP
        result = nlp_analyze.analyze(
            response_text,
            brand_name=brand_name,
            brand_aliases=brand_aliases,
            category=category,
        )
        
        # 写 we_geo_observations
        s.execute(
            text(
                "INSERT INTO we_geo_observations "
                "(workload_id, shard_id, brand_id, keyword, llm_code, "
                " mention_count, rank_position, sentiment, recommended, "
                " competitors, raw_excerpt, response_hash) "
                "VALUES "
                "(:wid, :sid, :bid, :kw, :llm, "
                " :mc, :rp, :st, :rec, "
                " CAST(:comp AS JSONB), :exc, :hash)"
            ),
            {
                "wid": workload_id,
                "sid": shard_id,
                "bid": brand_id,
                "kw": keyword,
                "llm": llm_code,
                "mc": result.mention_count,
                "rp": result.rank_position,
                "st": result.sentiment,
                "rec": result.recommended,
                "comp": json.dumps(result.competitors),
                "exc": result.raw_excerpt[:5000],
                "hash": response_hash[:64],
            },
        )
        s.commit()
        
        logger.info(
            "geo.observation · shard=%s brand=%s llm=%s mention=%d rank=%s sent=%s rec=%s",
            shard_id[:8], brand_name, llm_code,
            result.mention_count, result.rank_position,
            result.sentiment, result.recommended,
        )


def _parse_llm_output(output_ref: str, shard_meta: dict) -> tuple[str, str, str, str]:
    """解 shard.output_ref · 返 (response_text, response_hash, llm_code, keyword)
    
    output_ref 通常是 OSS URL · 但 inline 时直接是 JSON 字符串
    geo_query.py 输出: {"ok": True, "response_text": "...", "response_hash": "...", ...}
    """
    response_text = ""
    response_hash = ""
    
    # 节点端 geo_query.py inline_output 通常是 JSON
    # 这里假设 output_ref 是 JSON 字符串 (节点 ws 推 inline_output 走这条路径)
    # OSS 路径暂时不解 (节点端大输出走 OSS · 但 GEO 响应通常 < 16KB · 走 inline)
    if output_ref and output_ref.startswith("{"):
        try:
            data = json.loads(output_ref)
            response_text = data.get("response_text", "")
            response_hash = data.get("response_hash", "")
        except Exception:
            response_text = output_ref  # fallback · 当作纯文本
    elif output_ref:
        response_text = output_ref
    
    # 从 shard.metadata.params 拿 keyword + llm_code
    params = (shard_meta or {}).get("params") or {}
    keyword = params.get("keyword", "")
    llm_code = params.get("llm_code", "")
    
    return response_text, response_hash, llm_code, keyword
