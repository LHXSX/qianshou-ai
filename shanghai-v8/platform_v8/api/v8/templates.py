"""v8 任务模板库 · /api/v8/templates

复用 backend/services/task_templates.py (内置 L1 模板) · 提供 v8 风格接口。

接口:
  GET  /api/v8/templates              · 列出所有可用模板
  GET  /api/v8/templates/{template_id} · 单个模板详情
  GET  /api/v8/industries             · 行业分类
  GET  /api/v8/bundles                · 套餐 (可选 · v1 兼容)

不需鉴权 (公开读) · 写操作需 admin。
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status

logger = logging.getLogger("platform_v8.api.v8.templates")
router = APIRouter(prefix="/api/v8/templates", tags=["templates"])


@router.get("", summary="列出所有可用任务模板")
async def list_templates() -> dict[str, Any]:
    """返回内置 L1 模板列表。复用 v1 的 services.task_templates。"""
    try:
        from platform_v8.services.task_templates import list_templates as _list  # type: ignore
        items = _list()
    except Exception as exc:  # pragma: no cover
        logger.warning("templates · 加载失败 · 返空: %s", exc)
        items = []
    return {"ok": True, "total": len(items), "items": items}


@router.get("/{template_id}", summary="单个模板详情")
async def get_template(template_id: str) -> dict[str, Any]:
    try:
        from platform_v8.services.task_templates import match_template  # type: ignore
        t = match_template(template_id)
    except Exception as exc:
        logger.warning("templates · match 失败: %s", exc)
        t = None
    if not t:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail=f"template {template_id} not found")
    return {"ok": True, "template": t}


@router.get("/industries/list", summary="行业分类")  # /industries 跟 /{template_id} 冲突 · 用 /industries/list
async def list_industries() -> dict[str, Any]:
    """行业分类 (v1 是从 services 拉 · v8 直接硬编码 11 个常见行业)"""
    items = [
        {"id": "data_processing", "name": "数据处理", "icon": "📊", "tags": ["dedup", "sort", "filter"]},
        {"id": "ml_training", "name": "机器学习训练", "icon": "🧠", "tags": ["pytorch", "sklearn"]},
        {"id": "media_processing", "name": "媒体处理", "icon": "🎬", "tags": ["ffmpeg", "image"]},
        {"id": "web_scraping", "name": "网页爬虫", "icon": "🕷️", "tags": ["http", "parse"]},
        {"id": "text_analytics", "name": "文本分析", "icon": "📝", "tags": ["nlp", "summary"]},
        {"id": "scientific", "name": "科学计算", "icon": "🔬", "tags": ["numpy", "scipy"]},
        {"id": "rendering", "name": "渲染计算", "icon": "🎨", "tags": ["3d", "ray"]},
        {"id": "ocr", "name": "OCR 识别", "icon": "👁️", "tags": ["paddle", "tesseract"]},
        {"id": "ai_inference", "name": "AI 推理", "icon": "🤖", "tags": ["llm", "embedding"]},
        {"id": "video_processing", "name": "视频处理", "icon": "📹", "tags": ["transcode", "stream"]},
        {"id": "audio_processing", "name": "音频处理", "icon": "🎵", "tags": ["asr", "tts"]},
    ]
    return {"ok": True, "industries": items}


@router.get("/bundles/list", summary="套餐列表 (v1 兼容)")
async def list_bundles() -> dict[str, Any]:
    """套餐 · v1 用于推荐 task pack · v8 暂留空 (后续电商化用)"""
    return {"ok": True, "bundles": []}
