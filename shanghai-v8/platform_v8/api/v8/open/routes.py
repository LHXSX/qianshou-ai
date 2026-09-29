"""
开放平台 HTTP 接口（引擎零改）
================================

机器调用面（X-API-Key 鉴权 · 外部程序）:
  GET  /api/v8/open/catalog              可调用应用目录 + 输入契约（匿名可读）
  POST /api/v8/open/apps/{slug}/invoke   扣 1 配额 → 提交 workload → task_id
  GET  /api/v8/open/tasks/{task_id}      状态/进度/结果（仅 key 所属账户）

开发者管理面（Bearer · eco-client 开发者页）:
  GET  /api/v8/openapi/summary           配额 + 用量汇总
  GET  /api/v8/openapi/packs             套餐列表（含已购标记）
  POST /api/v8/openapi/packs/{id}/buy    购买（ledger 扣款分账 + 配额入账）
  GET  /api/v8/openapi/usage             调用流水

Key CRUD 复用 /api/v8/enterprise/api-keys（v8_031）。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.api.rate_limit import rate_limit
from platform_v8.core import Account
from platform_v8.services.openplatform import service as open_svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/open", tags=["open-platform"])
mgmt_router = APIRouter(prefix="/api/v8/openapi", tags=["open-platform-mgmt"])


# ── X-API-Key 鉴权依赖 ──────────────────────────────────────────────
def get_api_caller(
    x_api_key: str = Header(..., alias="X-API-Key"),
    session: Session = Depends(get_session),
) -> dict:
    try:
        return open_svc.verify_api_key(session, x_api_key)
    except open_svc.InvalidApiKey as exc:
        raise HTTPException(status_code=401, detail=str(exc))


class InvokeIn(BaseModel):
    inline_input: Optional[str] = Field(None, description="文本/JSON 输入（input_kind=json 类应用）")
    input_url: Optional[str] = Field(None, description="可公网 GET 的文件直链（文件类应用）")
    params: dict[str, Any] = Field(default_factory=dict)
    timeout_s: int = Field(600, ge=30, le=3600)


async def _async_start(workload_id: str) -> None:
    from platform_v8.engine import lifecycle as lifecycle_engine
    try:
        await lifecycle_engine.start(workload_id)
    except Exception:
        logger.exception("openapi invoke · engine.start 异常")


@router.get("/catalog", summary="可 API 调用的应用目录（匿名可读）")
def catalog(session: Session = Depends(get_session)) -> dict:
    return {"ok": True, "items": open_svc.api_catalog(session)}


@router.post(
    "/apps/{slug}/invoke",
    summary="调用应用（X-API-Key · 扣 1 配额）",
    dependencies=[Depends(rate_limit("openapi_invoke", per_minute=60, key="ip"))],
)
def invoke(
    slug: str,
    body: InvokeIn,
    bg: BackgroundTasks,
    caller: dict = Depends(get_api_caller),
    session: Session = Depends(get_session),
) -> dict:
    try:
        out = open_svc.invoke_app(
            session,
            account_id=caller["account_id"],
            key_id=caller["key_id"],
            slug=slug,
            inline_input=body.inline_input,
            input_url=body.input_url,
            params=body.params,
            timeout_s=body.timeout_s,
        )
    except open_svc.OpenPlatformError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    bg.add_task(_async_start, out["task_id"])
    return out


@router.get("/tasks/{task_id}", summary="任务状态/结果（X-API-Key）")
def task_status(
    task_id: str,
    caller: dict = Depends(get_api_caller),
    session: Session = Depends(get_session),
) -> dict:
    from platform_v8.services.workloads import query as query_svc
    from platform_v8.storage.repo import AccountRepo

    account = AccountRepo.by_id(session, caller["account_id"])
    if account is None:
        raise HTTPException(status_code=401, detail="账户不存在")
    try:
        w = query_svc.get_workload(session, task_id, caller=account)
    except query_svc.WorkloadNotFound:
        raise HTTPException(status_code=404, detail="任务不存在")
    except query_svc.WorkloadAccessDenied:
        raise HTTPException(status_code=403, detail="无权访问该任务")
    status = str(getattr(w.status, "value", w.status))
    out: dict[str, Any] = {
        "ok": True,
        "task_id": str(w.id),
        "status": status,
        "progress": float(w.progress or 0),
        "error": w.error or "",
        "created_at": w.created_at.isoformat() if w.created_at else None,
        "completed_at": w.completed_at.isoformat() if w.completed_at else None,
    }
    if status == "DONE" and w.result is not None and query_svc.can_read_result(w, account):
        r = w.result
        out["result"] = {
            "inline_output": getattr(r, "inline_output", None),
            "output_ref": getattr(r, "output_ref", "") or None,
            "summary": getattr(r, "summary", ""),
            "elapsed_ms": getattr(r, "elapsed_ms", 0),
        }
    return out


# ════════════════════════════════════════════════════════════════════
# 管理面（Bearer）
# ════════════════════════════════════════════════════════════════════
@mgmt_router.get("/summary", summary="开发者用量/配额汇总")
def summary(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    return {"ok": True, **open_svc.usage_summary(session, current.id)}


@mgmt_router.get("/packs", summary="套餐列表")
def packs(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    return {"ok": True, "items": open_svc.list_packs(session, current.id)}


@mgmt_router.post("/packs/{pack_id}/buy", summary="购买套餐（EDG 扣款 + 作者分账）")
def buy(
    pack_id: int,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    try:
        return open_svc.buy_pack(session, current.id, pack_id)
    except open_svc.OpenPlatformError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@mgmt_router.get("/usage", summary="调用流水")
def usage(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    return {"ok": True, "items": open_svc.usage_list(session, current.id)}
