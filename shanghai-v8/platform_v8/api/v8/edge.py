"""
千手加速 · 边缘分布式处理入口

接收律所客户端的批量文档chunks → 创建workload → planner切片 → broker分发 → 聚合回传。

用法:
  POST /api/v8/edge/accelerate
  {
    "type": "contract_review",
    "chunks": [
      {"index": 0, "text": "第一条...", "context": "合同名称"},
      {"index": 1, "text": "第二条...", "context": "合同名称"}
    ],
    "params": {"party_side": "甲方"}
  }
"""
from __future__ import annotations

import asyncio
import logging
import os
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from platform_v8.api.deps import get_admin_account
from platform_v8.core import Account

router = APIRouter(prefix="/api/v8/edge", tags=["edge-accelerate"])
logger = logging.getLogger(__name__)


class AccelerateRequest(BaseModel):
    type: str = "contract_review"
    chunks: list[dict]
    params: dict | None = {}


class AccelerateResponse(BaseModel):
    ok: bool = True
    type: str
    total_chunks: int
    completed: int
    time_ms: int
    results: list[dict] = []
    message: str = ""


@router.post("/accelerate")
async def accelerate(
    req: AccelerateRequest,
    _admin: Account = Depends(get_admin_account),
):
    """
    千手加速入口：接收批量文档分块，走底座分布式处理。
    
    当前实现：直接串行处理（底座节点未就绪）。
    目标实现：planner切片 → broker分发 → N节点并行 → aggregator聚合。
    """
    # This legacy direct-provider path is an explicit admin-only opt-in.
    # It is not billed through the distributed scheduler.
    if os.environ.get("V8_EDGE_ACCELERATE_ENABLED", "").strip() != "1":
        raise HTTPException(status_code=503, detail="edge accelerate is disabled")
    if len(req.chunks) > 16 or any(
        not isinstance(chunk.get("text"), str) or len(chunk["text"]) > 8000
        for chunk in req.chunks
    ):
        raise HTTPException(status_code=422, detail="chunks exceed request limits")
    t0 = time.time()
    chunks = req.chunks
    total = len(chunks)
    
    logger.info(f"千手加速: type={req.type} chunks={total}")
    
    if total == 0:
        return AccelerateResponse(
            type=req.type, total_chunks=0, completed=0, time_ms=0,
            message="无chunks"
        )
    
    # ── 当前实现：串行处理（底座节点未就绪时的回退方案）──
    results = []
    try:
        for chunk in chunks:
            # 根据type选择处理函数
            if req.type in ("contract_review", "ocr_image"):
                # 合同审查走 DeepSeek API 直调
                result = await _process_chunk_direct(chunk, req.type, req.params)
            elif req.type == "case_digest":
                result = await _process_chunk_direct(chunk, req.type, req.params)
            else:
                result = {"index": chunk["index"], "error": f"未知任务类型: {req.type}"}
            
            result["index"] = chunk.get("index", 0)
            results.append(result)
    except Exception as exc:
        logger.exception(f"处理失败: {exc}")
        # 即使部分失败也回传已完成的结果
        pass
    
    elapsed_ms = int((time.time() - t0) * 1000)
    completed = len(results)
    
    logger.info(f"千手加速完成: {completed}/{total} 耗时 {elapsed_ms}ms")
    
    return AccelerateResponse(
        type=req.type,
        total_chunks=total,
        completed=completed,
        time_ms=elapsed_ms,
        results=results,
        message=f"串行模式（底座节点就绪后切换为并行）· {completed}/{total}"
    )


async def _process_chunk_direct(chunk: dict, task_type: str, params: dict | None = None) -> dict:
    """单块直接处理（当前回退方案）—— 调用 DeepSeek API"""
    import os
    import json
    import urllib.request
    import urllib.error
    
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        return {"error": "DEEPSEEK_API_KEY 未配置"}
    
    text = chunk.get("text", "")
    if not text:
        return {"error": "chunk无文本内容"}
    
    system_prompts = {
        "contract_review": "你是一位资深合同律师。请审查以下合同条款，标注风险点，给出修改建议。",
        "case_digest": "你是一位法律分析专家。请从以下案卷材料中提取案件摘要、争议焦点和关键事实。",
    }
    
    system_msg = system_prompts.get(task_type, "请分析以下文档内容。")
    
    payload = {
        "model": "deepseek-chat",
        "messages": [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": text[:8000]}  # 单块限制8000字
        ],
        "temperature": 0.3,
        "max_tokens": 2000,
    }
    
    req = urllib.request.Request(
        "https://api.deepseek.com/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }
    )
    
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
            content = data["choices"][0]["message"]["content"]
            return {"result": content}
    except urllib.error.HTTPError as e:
        return {"error": f"API错误: {e.code}"}
    except Exception as e:
        return {"error": str(e)}
