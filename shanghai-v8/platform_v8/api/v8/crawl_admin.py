"""
crawl 白名单 admin API (2026-05-24)

路由前缀: /api/v8/admin/crawl/whitelist

CRUD:
  GET    /                    列白名单 (?status=active|disabled|all · ?q=domain_like)
  POST   /                    加白名单 (admin only)
  GET    /{id}                单条详情
  PUT    /{id}                更新 (path_pattern / max_qps / notes / approval_ref)
  POST   /{id}/disable        禁用 (软删 · 保留审计)
  POST   /{id}/enable         重新启用
  DELETE /{id}                物理删 (慎用 · 推荐 disable)
  POST   /check               预检 URL · 给前端实时验证用
"""
from __future__ import annotations
import logging

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.core import Account
from platform_v8.services.crawl import whitelist as crawl_wl

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/admin/crawl-whitelist", tags=["admin-crawl-whitelist"])


# ════════════════════════════════════════════════════════════════════
# admin 守卫 (复用 admin_v2 模式)
# ════════════════════════════════════════════════════════════════════
def require_admin(current: Account = Depends(get_current_account)) -> Account:
    role_str = getattr(current.role, "value", str(current.role)).lower()
    if not (getattr(current, "is_admin", False) or role_str in ("admin", "super_admin", "accountrole.admin")):
        raise HTTPException(status_code=403, detail=f"需要管理员权限 (current role: {role_str})")
    return current


# ════════════════════════════════════════════════════════════════════
# Schemas
# ════════════════════════════════════════════════════════════════════
class AddWhitelistRequest(BaseModel):
    domain: str = Field(..., min_length=3, max_length=255, examples=["en.wikipedia.org"])
    path_pattern: str = Field("/*", max_length=500, examples=["/wiki/*"])
    max_qps: int = Field(1, ge=0, le=100)
    notes: str = Field("", max_length=2000)
    approval_ref: str = Field("", max_length=120)


class UpdateWhitelistRequest(BaseModel):
    path_pattern: str | None = Field(None, max_length=500)
    max_qps: int | None = Field(None, ge=0, le=100)
    notes: str | None = Field(None, max_length=2000)
    approval_ref: str | None = Field(None, max_length=120)


class CheckUrlRequest(BaseModel):
    url: str = Field(..., examples=["https://en.wikipedia.org/wiki/AI"])


# ════════════════════════════════════════════════════════════════════
# Endpoints
# ════════════════════════════════════════════════════════════════════
@router.get("", summary="列白名单条目")
def list_entries(
    status: str = Query("active", regex="^(active|disabled|all)$"),
    q: str = Query("", description="domain 模糊搜索"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    items = crawl_wl.list_whitelist(
        session,
        status=None if status == "all" else status,
        domain_like=q or None,
        limit=limit,
        offset=offset,
    )
    return {"ok": True, "total": len(items), "items": items}


@router.post("", summary="加白名单条目 (admin)")
def add_entry(
    body: AddWhitelistRequest,
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    try:
        entry = crawl_wl.add_whitelist(
            session,
            domain=body.domain.strip().lower(),
            path_pattern=body.path_pattern,
            added_by=current.id,
            max_qps=body.max_qps,
            notes=body.notes,
            approval_ref=body.approval_ref,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        # 重复 (domain, path_pattern) 等约束冲突
        msg = str(e).lower()
        if "unique" in msg or "duplicate" in msg or "we_crawl_url_whitelist_uk" in msg:
            raise HTTPException(409, f"该 (domain, path_pattern) 已存在 · 用 GET 查询")
        raise HTTPException(500, f"内部错误: {e}")
    return {"ok": True, "entry": entry}


@router.get("/{entry_id}", summary="单条详情")
def get_entry(
    entry_id: int,
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    entry = crawl_wl.get_whitelist_entry(session, entry_id)
    if not entry:
        raise HTTPException(404, f"entry {entry_id} 不存在")
    return {"ok": True, "entry": entry}


@router.put("/{entry_id}", summary="更新 path_pattern/max_qps/notes/approval_ref")
def update_entry(
    entry_id: int,
    body: UpdateWhitelistRequest,
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    if not crawl_wl.get_whitelist_entry(session, entry_id):
        raise HTTPException(404, f"entry {entry_id} 不存在")
    try:
        updated = crawl_wl.update_whitelist(
            session,
            entry_id,
            path_pattern=body.path_pattern,
            max_qps=body.max_qps,
            notes=body.notes,
            approval_ref=body.approval_ref,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not updated:
        return {"ok": True, "noop": True, "entry": crawl_wl.get_whitelist_entry(session, entry_id)}
    return {"ok": True, "entry": crawl_wl.get_whitelist_entry(session, entry_id)}


@router.post("/{entry_id}/disable", summary="禁用 (软删 · 保留审计)")
def disable_entry(
    entry_id: int,
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    if not crawl_wl.get_whitelist_entry(session, entry_id):
        raise HTTPException(404, f"entry {entry_id} 不存在")
    ok = crawl_wl.disable_whitelist(session, entry_id, by_account_id=current.id)
    return {"ok": ok, "entry": crawl_wl.get_whitelist_entry(session, entry_id)}


@router.post("/{entry_id}/enable", summary="重新启用")
def enable_entry(
    entry_id: int,
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    if not crawl_wl.get_whitelist_entry(session, entry_id):
        raise HTTPException(404, f"entry {entry_id} 不存在")
    ok = crawl_wl.enable_whitelist(session, entry_id)
    return {"ok": ok, "entry": crawl_wl.get_whitelist_entry(session, entry_id)}


@router.delete("/{entry_id}", summary="物理删 (慎用 · 推荐 disable)")
def delete_entry(
    entry_id: int,
    current: Account = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    if not crawl_wl.get_whitelist_entry(session, entry_id):
        raise HTTPException(404, f"entry {entry_id} 不存在")
    ok = crawl_wl.delete_whitelist(session, entry_id)
    return {"ok": ok}


@router.post("/check", summary="预检 URL · 前端实时验证 (任何登录用户可调)")
def check_url(
    body: CheckUrlRequest,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    """前端 UI 用 · 用户填 URL 时实时反馈是否在白名单"""
    ok, reason, entry = crawl_wl.check_url_allowed(session, body.url)
    return {
        "ok": ok,
        "url": body.url,
        "reason": reason,
        "matched_entry": entry,
    }
