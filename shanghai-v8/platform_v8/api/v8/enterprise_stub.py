"""
企业端 endpoint · 2026-05-21 起占位 · S3-T8 (2026-06-07) 逐步真实化
================================================================

已真实化(S3-T8):
  - invoice-titles  → we_invoice_titles (v8_030)
  - api-keys        → we_api_keys       (v8_031)

仍 stub(P2 后续):
  - members / projects / scheduled-tasks / webhooks / invoices(税票走 we_tax_invoices)
"""
from __future__ import annotations

import json as _json

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.core import Account

router = APIRouter(prefix="/api/v8/enterprise", tags=["enterprise-stub"])

_STUB_NOTE = "功能后端开发中 · 当前为占位响应 · 数据仍在客户端 localStorage"


def _stub_list_response(kind: str) -> dict:
    return {
        "ok": True,
        "items": [],
        "total": 0,
        "_stub": True,
        "_kind": kind,
        "_note": _STUB_NOTE,
    }


def _stub_write_block(kind: str):
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail={
            "code": "STUB_NOT_IMPLEMENTED",
            "kind": kind,
            "message": _STUB_NOTE,
        },
    )


# ════════════════════════════════════════════════════════════════════
# 1. invoices · 发票
# ════════════════════════════════════════════════════════════════════
@router.get("/invoices", summary="[STUB] 发票列表")
def list_invoices(
    _: Account = Depends(get_current_account),
    __: Session = Depends(get_session),
):
    return _stub_list_response("invoices")


# ── invoice-titles · S3-T8 真实化 (we_invoice_titles · v8_030) ──

class InvoiceTitleIn(BaseModel):
    title_type: str = Field(..., pattern="^(personal|company)$")
    title_name: str = Field(..., min_length=1, max_length=200)
    tax_id: str | None = Field(None, max_length=50)
    bank_name: str | None = Field(None, max_length=200)
    bank_account: str | None = Field(None, max_length=64)
    address: str | None = Field(None, max_length=500)
    phone: str | None = Field(None, max_length=50)
    email: str | None = Field(None, max_length=200)
    is_default: bool = False


def _row_to_title(r) -> dict:
    return {
        "id": r.id, "title_type": r.title_type, "title_name": r.title_name,
        "tax_id": r.tax_id, "bank_name": r.bank_name, "bank_account": r.bank_account,
        "address": r.address, "phone": r.phone, "email": r.email,
        "is_default": r.is_default,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@router.get("/invoice-titles", summary="发票抬头列表")
def list_invoice_titles(
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    rows = session.execute(text("""
        SELECT * FROM we_invoice_titles
         WHERE account_id = :aid
         ORDER BY is_default DESC, created_at DESC
    """), {"aid": current.id}).fetchall()
    return {"ok": True, "items": [_row_to_title(r) for r in rows], "total": len(rows)}


@router.post("/invoice-titles", summary="新增发票抬头")
def create_invoice_title(
    body: InvoiceTitleIn,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    if body.title_type == "company" and not body.tax_id:
        raise HTTPException(status_code=400, detail="公司抬头必须填税号")
    # 如果设为默认 · 先把已有默认置 false
    if body.is_default:
        session.execute(text("""
            UPDATE we_invoice_titles SET is_default=false, updated_at=NOW()
             WHERE account_id=:aid AND is_default=true
        """), {"aid": current.id})
    result = session.execute(text("""
        INSERT INTO we_invoice_titles
          (account_id, title_type, title_name, tax_id, bank_name, bank_account,
           address, phone, email, is_default)
        VALUES (:aid, :tt, :tn, :ti, :bn, :ba, :ad, :ph, :em, :df)
        RETURNING id, account_id, title_type, title_name, tax_id, bank_name,
                  bank_account, address, phone, email, is_default, created_at
    """), {
        "aid": current.id, "tt": body.title_type, "tn": body.title_name,
        "ti": body.tax_id, "bn": body.bank_name, "ba": body.bank_account,
        "ad": body.address, "ph": body.phone, "em": body.email, "df": body.is_default,
    }).fetchone()
    session.commit()
    return {"ok": True, "item": _row_to_title(result)}


@router.delete("/invoice-titles/{title_id}", summary="删除发票抬头")
def delete_invoice_title(
    title_id: int,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    result = session.execute(text("""
        DELETE FROM we_invoice_titles
         WHERE id=:tid AND account_id=:aid
    """), {"tid": title_id, "aid": current.id})
    session.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="抬头不存在或无权删除")
    return {"ok": True, "deleted": title_id}


@router.post("/invoices", summary="[STUB] 申请开票")
def create_invoice(
    _: Account = Depends(get_current_account),
):
    _stub_write_block("invoices.create")


# ════════════════════════════════════════════════════════════════════
# 2. members · 团队成员
# ════════════════════════════════════════════════════════════════════
@router.get("/members", summary="[STUB] 团队成员")
def list_members(
    _: Account = Depends(get_current_account),
    __: Session = Depends(get_session),
):
    return _stub_list_response("members")


@router.post("/members/invite", summary="[STUB] 邀请成员")
def invite_member(
    _: Account = Depends(get_current_account),
):
    _stub_write_block("members.invite")


@router.delete("/members/{member_id}", summary="[STUB] 移除成员")
def remove_member(
    member_id: str,
    _: Account = Depends(get_current_account),
):
    _stub_write_block("members.remove")


# ════════════════════════════════════════════════════════════════════
# 3. projects · 项目
# ════════════════════════════════════════════════════════════════════
@router.get("/projects", summary="[STUB] 项目分组")
def list_projects(
    _: Account = Depends(get_current_account),
    __: Session = Depends(get_session),
):
    return _stub_list_response("projects")


@router.post("/projects", summary="[STUB] 新建项目")
def create_project(
    _: Account = Depends(get_current_account),
):
    _stub_write_block("projects.create")


# ════════════════════════════════════════════════════════════════════
# 4. scheduled · 定时任务
# ════════════════════════════════════════════════════════════════════
@router.get("/scheduled-tasks", summary="[STUB] 定时任务")
def list_scheduled_tasks(
    _: Account = Depends(get_current_account),
    __: Session = Depends(get_session),
):
    return _stub_list_response("scheduled_tasks")


@router.post("/scheduled-tasks", summary="[STUB] 新建定时任务")
def create_scheduled_task(
    _: Account = Depends(get_current_account),
):
    _stub_write_block("scheduled_tasks.create")


# ════════════════════════════════════════════════════════════════════
# 5. webhooks
# ════════════════════════════════════════════════════════════════════
@router.get("/webhooks", summary="[STUB] Webhooks")
def list_webhooks(
    _: Account = Depends(get_current_account),
    __: Session = Depends(get_session),
):
    return _stub_list_response("webhooks")


@router.post("/webhooks", summary="[STUB] 添加 Webhook")
def create_webhook(
    _: Account = Depends(get_current_account),
):
    _stub_write_block("webhooks.create")


# ════════════════════════════════════════════════════════════════════
# 6. api_keys · S3-T8 真实化 (we_api_keys · v8_031) · 委托 ApiKeyRepo
#    新入口优先用 /api/v8/developer/keys；此处保留兼容旧 enterprise-portal
# ════════════════════════════════════════════════════════════════════

class ApiKeyCreateIn(BaseModel):
    name: str = Field(default="", max_length=100, description="给 key 起的名字 · 仅展示")
    scopes: list[str] = Field(default_factory=list, description="预留 · 当前未做粒度控制")
    expires_days: int | None = Field(default=None, ge=1, le=3650,
                                     description="多少天后失效;None=永久")


@router.get("/api-keys", summary="API Key 列表 (仅前缀 · secret 不可再取)")
def list_api_keys(
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    from platform_v8.storage.repo import ApiKeyRepo
    items = ApiKeyRepo.list_for_account(session, current.id)
    return {"ok": True, "items": items, "total": len(items)}


@router.post("/api-keys", status_code=201, summary="创建 API Key (secret 只在响应中返一次)")
def create_api_key(
    body: ApiKeyCreateIn,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    from platform_v8.storage.repo import API_KEY_MAX_PER_ACCOUNT, ApiKeyRepo
    if ApiKeyRepo.count_active(session, current.id) >= API_KEY_MAX_PER_ACCOUNT:
        raise HTTPException(status_code=400, detail="API Key 已达上限 10 个 · 请先吊销旧的")
    item = ApiKeyRepo.create(
        session,
        account_id=current.id,
        name=body.name,
        scopes=body.scopes,
        expires_days=body.expires_days,
    )
    try:
        from platform_v8.storage.repo import AuditRepo as _A
        _A.write(session, action="enterprise.api_key.create",
                 actor_account_id=current.id, actor_kind="user",
                 target_kind="api_key", target_id=str(item["id"]),
                 detail={"prefix": item.get("key_prefix"), "name": body.name})
    except Exception:
        pass
    return {"ok": True, "item": item,
            "_note": "secret_once 仅本次返回 · 妥善保存 · 后续无法再取"}


@router.delete("/api-keys/{key_id}", summary="吊销 API Key")
def revoke_api_key(
    key_id: int,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    from platform_v8.storage.repo import ApiKeyRepo
    ok = ApiKeyRepo.revoke(session, key_id=key_id, account_id=current.id)
    if not ok:
        raise HTTPException(status_code=404, detail="key 不存在或已吊销")
    try:
        from platform_v8.storage.repo import AuditRepo as _A
        _A.write(session, action="enterprise.api_key.revoke",
                 actor_account_id=current.id, actor_kind="user",
                 target_kind="api_key", target_id=str(key_id), detail={})
    except Exception:
        pass
    return {"ok": True, "revoked": key_id}


# ════════════════════════════════════════════════════════════════════
# 元信息 · 给前端 / ops 查询「哪些 enterprise 功能仍是 stub」
# ════════════════════════════════════════════════════════════════════
@router.get("/_meta/stubs", summary="列出当前所有 stub 路径 (开发自检用)")
def list_stub_routes():
    return {
        "ok": True,
        "version": "v8.0.x-stubs",
        "note": _STUB_NOTE,
        "stubs": [
            "GET  /api/v8/enterprise/invoices",
            "GET  /api/v8/enterprise/invoice-titles",
            "POST /api/v8/enterprise/invoices",
            "GET  /api/v8/enterprise/members",
            "POST /api/v8/enterprise/members/invite",
            "DELETE /api/v8/enterprise/members/{member_id}",
            "GET  /api/v8/enterprise/projects",
            "POST /api/v8/enterprise/projects",
            "GET  /api/v8/enterprise/scheduled-tasks",
            "POST /api/v8/enterprise/scheduled-tasks",
            "GET  /api/v8/enterprise/webhooks",
            "POST /api/v8/enterprise/webhooks",
            "GET  /api/v8/enterprise/api-keys",
            "POST /api/v8/enterprise/api-keys",
            "DELETE /api/v8/enterprise/api-keys/{key_id}",
        ],
    }
