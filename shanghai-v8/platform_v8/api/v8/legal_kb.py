"""
律所知识库 / Provider 元数据（P0 预留）

- GET  /api/v8/legal/providers          当前启用了哪些源（不含密钥）
- POST /api/v8/legal/kb/firm/search     律师团队共享库检索（未开通则 enabled=false）
- POST /api/v8/legal/kb/lessons/search  团队难点库检索（预留）
- POST /api/v8/legal/kb/industry/search 行业库检索（默认关）

威科先行真源检索仍走 /legal/research/retrieve 聚合层；此处只声明状态。
密钥：WKINFO_API_KEY / WKINFO_BASE_URL 等，禁止写入响应。
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/v8/legal", tags=["v8-legal-kb"])


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _wkinfo_ready() -> bool:
    """声明启用且后端有凭证时视为 configured；真正检索 Adapter 后续再接。"""
    return _flag("WKINFO_ENABLED") and bool(os.environ.get("WKINFO_API_KEY", "").strip())


def _firm_team_ready() -> bool:
    return _flag("FIRM_KB_TEAM_ENABLED")


def _lesson_team_ready() -> bool:
    return _flag("LESSON_TEAM_ENABLED")


def _industry_ready() -> bool:
    return _flag("INDUSTRY_KB_ENABLED")


class KbSearchReq(BaseModel):
    query: str = Field(default="", description="检索文本")
    topK: int = Field(default=5, ge=1, le=30)
    matterId: str = ""
    caseType: str = ""
    firmId: str = ""
    teamId: str = ""


@router.get("/providers")
async def list_providers() -> dict[str, Any]:
    """前端 / 运维查看当前 Provider 状态（不含密钥）。"""
    wk_key = bool(os.environ.get("WKINFO_API_KEY", "").strip())
    return {
        "ok": True,
        "providers": [
            {
                "id": "builtin",
                "kind": "law",
                "label": "内置公开库检索",
                "enabled": True,
                "status": "ready",
                "note": "精选语料关键词检索；非全量实时法库。",
            },
            {
                "id": "wkinfo",
                "kind": "law",
                "label": "威科先行",
                "enabled": _flag("WKINFO_ENABLED"),
                "status": "ready" if _wkinfo_ready() else (
                    "configured_pending" if _flag("WKINFO_ENABLED") else "disabled"
                ),
                "hasCredential": wk_key,
                "note": (
                    "已配置凭证，待 Adapter 接通检索。"
                    if _wkinfo_ready()
                    else (
                        "已声明启用但缺少 WKINFO_API_KEY。"
                        if _flag("WKINFO_ENABLED")
                        else "未启用。私有部署开通威科合同后配置 WKINFO_ENABLED + WKINFO_API_KEY。"
                    )
                ),
            },
            {
                "id": "firm_team",
                "kind": "kb",
                "label": "律师团队共享库",
                "enabled": _firm_team_ready(),
                "status": "configured_pending" if _firm_team_ready() else "disabled",
                "privateOnly": True,
                "note": (
                    "私有部署团队库：上传/权限/同步待实现；当前 search 返回空。"
                    if _firm_team_ready()
                    else "设置 FIRM_KB_TEAM_ENABLED=true 后开放预留接口。"
                ),
            },
            {
                "id": "lesson_team",
                "kind": "kb",
                "label": "团队共享难点库",
                "enabled": _lesson_team_ready(),
                "status": "configured_pending" if _lesson_team_ready() else "disabled",
                "privateOnly": True,
                "note": "难点团队共享预留；未接通前勿展示假命中。",
            },
            {
                "id": "industry",
                "kind": "kb",
                "label": "行业库",
                "enabled": _industry_ready(),
                "status": "configured_pending" if _industry_ready() else "disabled",
                "note": "默认关闭。",
            },
            {
                "id": "case_stub",
                "kind": "case",
                "label": "类案检索",
                "enabled": False,
                "status": "disabled",
                "note": "数据源未定，禁止直爬裁判文书网。",
            },
        ],
    }


@router.post("/kb/firm/search")
async def firm_kb_search(req: KbSearchReq) -> dict[str, Any]:
    """律师团队共享库检索。未开通时 enabled=false，items=[]。"""
    if not _firm_team_ready():
        return {
            "ok": True,
            "enabled": False,
            "items": [],
            "message": "团队共享库未开通（需 FIRM_KB_TEAM_ENABLED=true 并部署存储）",
        }
    # P0：接口位已留，存储未接 —— 诚实返回空，前端回落本机库
    return {
        "ok": True,
        "enabled": True,
        "items": [],
        "message": "团队库存储尚未接通，暂无服务端命中（前端应回落本机库）",
        "query": req.query,
        "topK": req.topK,
    }


@router.post("/kb/lessons/search")
async def lesson_kb_search(req: KbSearchReq) -> dict[str, Any]:
    if not _lesson_team_ready():
        return {
            "ok": True,
            "enabled": False,
            "items": [],
            "message": "团队难点库未开通",
        }
    return {
        "ok": True,
        "enabled": True,
        "items": [],
        "message": "团队难点存储尚未接通",
        "query": req.query,
    }


@router.post("/kb/industry/search")
async def industry_kb_search(req: KbSearchReq) -> dict[str, Any]:
    if not _industry_ready():
        return {
            "ok": True,
            "enabled": False,
            "items": [],
            "message": "行业库未启用",
        }
    return {
        "ok": True,
        "enabled": True,
        "items": [],
        "message": "行业库语料尚未接通",
        "query": req.query,
    }
