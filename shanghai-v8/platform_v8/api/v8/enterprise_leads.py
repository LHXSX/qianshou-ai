"""官网企业咨询：公开严格收取，管理员专属读取。"""
from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.client_ip import client_ip
from platform_v8.api.deps import get_admin_account, get_session
from platform_v8.api.rate_limit import rate_limit
from platform_v8.core import Account

logger = logging.getLogger(__name__)

public_router = APIRouter(prefix="/api/v8", tags=["enterprise-leads"])
admin_router = APIRouter(prefix="/api/v8/admin/enterprise", tags=["admin-enterprise-leads"])

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_NOTE_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_ACCEPTED = {"ok": True, "message": "申请已收悉，后续安排以正式回复为准。"}


class EnterpriseLeadIn(BaseModel):
    """字段与官网 BetaProgram 表单一致；phone 是历史名称，接受常用联系渠道。"""

    # JSON 中 datetime 是 ISO 字符串；Pydantic 的全局 strict=True 会错误拒绝官网表单。
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    company: str = Field(min_length=2, max_length=120)
    contact: str = Field(min_length=1, max_length=60)
    phone: str = Field(min_length=3, max_length=120)
    size: Literal["", "1-10", "11-50", "51-200", "200+"] = ""
    use_case: Literal["3d-render", "ai-inference", "data-eng", "research", "other"]
    budget: Literal["", "lt-1k", "1k-5k", "5k-30k", "30k+"] = ""
    note: str = Field(default="", max_length=2000)
    source: Literal["beta-program-page"]
    submitted_at: datetime

    @field_validator("company", "contact", "phone", mode="before")
    @classmethod
    def no_control_chars(cls, value: object) -> object:
        if isinstance(value, str) and _CONTROL.search(value):
            raise ValueError("不得包含控制字符")
        return value

    @field_validator("note", mode="before")
    @classmethod
    def note_no_control_chars(cls, value: object) -> object:
        if isinstance(value, str) and _NOTE_CONTROL.search(value):
            raise ValueError("备注包含无效字符")
        return value

    @field_validator("submitted_at")
    @classmethod
    def timestamp_has_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("提交时间必须带时区")
        return value


def _dedupe_key(company: str, channel: str) -> str:
    """同公司 + 同联系方式 24 小时去重；不在日志里打印明文。"""
    normalized = "\0".join(" ".join(part.split()).casefold() for part in (company, channel))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _row(row) -> dict:
    """管理员响应显式列字段，避免未来加密列或内部字段意外透出。"""
    return {
        "id": row["id"],
        "company": row["company"],
        "contact": row["contact"],
        "phone": row["contact_channel"],
        "size": row["company_size"],
        "use_case": row["use_case"],
        "budget": row["budget"],
        "note": row["note"],
        "source": row["source"],
        "submitted_at": row["client_submitted_at"].isoformat(),
        "created_at": row["created_at"].isoformat(),
        "status": row["status"],
        "source_ip": row["source_ip"],
        "user_agent": row["user_agent"],
    }


def _list_row(row) -> dict:
    """列表仅含跟进所需的摘要；备注、IP 与 UA 留在管理员详情页。"""
    return {
        "id": row["id"],
        "company": row["company"],
        "contact": row["contact"],
        "phone": row["contact_channel"],
        "size": row["company_size"],
        "use_case": row["use_case"],
        "budget": row["budget"],
        "source": row["source"],
        "created_at": row["created_at"].isoformat(),
        "status": row["status"],
    }


@public_router.post(
    "/leads/enterprise",
    status_code=202,
    dependencies=[Depends(rate_limit("enterprise_lead_submit", per_minute=5, key="ip"))],
    summary="提交企业合作咨询",
)
def submit_enterprise_lead(
    body: EnterpriseLeadIn,
    request: Request,
    s: Session = Depends(get_session),
) -> dict:
    key = _dedupe_key(body.company, body.phone)
    # 事务锁使多个 uvicorn worker 对同一联系方式的并发提交也只落一条。
    lock_key = int.from_bytes(bytes.fromhex(key[:16]), "big", signed=True)
    s.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_key})
    existing = s.execute(
        text("SELECT id FROM we_enterprise_leads "
             "WHERE dedupe_key = :key AND created_at > NOW() - INTERVAL '24 hours' "
             "ORDER BY created_at DESC LIMIT 1"),
        {"key": key},
    ).first()
    if existing is not None:
        return dict(_ACCEPTED)

    row = s.execute(
        text("""
            INSERT INTO we_enterprise_leads
              (company, contact, contact_channel, company_size, use_case, budget, note,
               source, client_submitted_at, source_ip, user_agent, dedupe_key)
            VALUES
              (:company, :contact, :channel, :size, :use_case, :budget, :note,
               :source, :submitted_at, :source_ip, :user_agent, :dedupe_key)
            RETURNING id
        """),
        {
            "company": body.company,
            "contact": body.contact,
            "channel": body.phone,
            "size": body.size,
            "use_case": body.use_case,
            "budget": body.budget,
            "note": body.note,
            "source": body.source,
            "submitted_at": body.submitted_at,
            "source_ip": client_ip(request),
            "user_agent": request.headers.get("user-agent", "")[:300],
            "dedupe_key": key,
        },
    ).first()
    if row is None:
        raise HTTPException(503, "咨询提交暂不可用")
    logger.info("enterprise_lead · accepted id=%s", row[0])
    return dict(_ACCEPTED)


@admin_router.get("/leads", summary="企业咨询列表")
def admin_list_enterprise_leads(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
    s: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
) -> dict:
    rows = s.execute(
        text("SELECT id, company, contact, contact_channel, company_size, use_case, budget, "
             "source, created_at, status "
             "FROM we_enterprise_leads ORDER BY created_at DESC, id DESC "
             "LIMIT :limit OFFSET :offset"),
        {"limit": limit, "offset": offset},
    ).mappings().all()
    total = s.execute(text("SELECT COUNT(*) FROM we_enterprise_leads")).scalar() or 0
    return {"ok": True, "items": [_list_row(row) for row in rows], "total": total}


@admin_router.get("/leads/{lead_id}", summary="企业咨询详情")
def admin_get_enterprise_lead(
    lead_id: int,
    s: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
) -> dict:
    row = s.execute(
        text("SELECT id, company, contact, contact_channel, company_size, use_case, budget, "
             "note, source, client_submitted_at, created_at, status, source_ip, user_agent "
             "FROM we_enterprise_leads WHERE id = :id"),
        {"id": lead_id},
    ).mappings().first()
    if row is None:
        raise HTTPException(404, "咨询记录不存在")
    return {"ok": True, "lead": _row(row)}
