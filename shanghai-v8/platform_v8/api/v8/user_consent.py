"""
用户能力授权 API · /api/v8/my/consent

用户对千手节点 5 能力 (compute / crawl / proxy / display / storage)
的同意状态由本接口持久化到 we_accounts.profile.capability_consent (JSONB)。

- POST /api/v8/my/consent  · 更新同意矩阵
- GET  /api/v8/my/consent  · 拉取当前矩阵

兼容旧客户端：未调用本接口的账号 capability_consent 字段为空 dict。
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.core import Account

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/my", tags=["my"])

# 合法能力 ID 白名单 (跟前端 useCapabilities.CAPABILITIES 对齐)
VALID_CAPABILITY_IDS = {"compute", "crawl", "proxy", "display", "storage"}


# ════════════════════════════════════════════════════════════════════
# Schemas
# ════════════════════════════════════════════════════════════════════
class ConsentPayload(BaseModel):
    """同意矩阵 · 客户端提交格式"""

    consents: dict[str, bool] = Field(
        default_factory=dict,
        description="每个能力的同意状态 · key 必须 ∈ VALID_CAPABILITY_IDS",
    )
    agreed_tos: bool = Field(default=False, description="是否同意服务总协议")
    agreed_privacy: bool = Field(default=False, description="是否同意隐私政策")
    tos_version: str = Field(default="v1.0", description="同意时的总协议版本")
    privacy_version: str = Field(default="v1.0", description="同意时的隐私版本")


class ConsentResponse(BaseModel):
    ok: bool
    consents: dict[str, bool]
    agreed_tos: bool
    agreed_privacy: bool
    tos_version: str | None = None
    privacy_version: str | None = None
    confirmed_at: str | None = None


# ════════════════════════════════════════════════════════════════════
# GET /my/consent · 读取当前同意矩阵
# ════════════════════════════════════════════════════════════════════
@router.get("/consent", response_model=ConsentResponse)
def get_my_consent(
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> ConsentResponse:
    row = session.execute(
        text(
            "SELECT COALESCE(profile->'capability_consent', '{}'::jsonb) AS cc "
            "FROM we_accounts WHERE id = :uid"
        ),
        {"uid": current.id},
    ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="账号不存在")

    cc = row["cc"] or {}
    # 默认值兜底
    consents_raw = cc.get("consents") or {}
    consents = {
        cid: bool(consents_raw.get(cid, False)) for cid in VALID_CAPABILITY_IDS
    }
    return ConsentResponse(
        ok=True,
        consents=consents,
        agreed_tos=bool(cc.get("agreed_tos", False)),
        agreed_privacy=bool(cc.get("agreed_privacy", False)),
        tos_version=cc.get("tos_version"),
        privacy_version=cc.get("privacy_version"),
        confirmed_at=cc.get("confirmed_at"),
    )


# ════════════════════════════════════════════════════════════════════
# POST /my/consent · 更新同意矩阵 (整体覆盖)
# ════════════════════════════════════════════════════════════════════
@router.post("/consent", response_model=ConsentResponse)
def post_my_consent(
    payload: ConsentPayload,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> ConsentResponse:
    # 1. 校验 capability id 在白名单内
    unknown = set(payload.consents.keys()) - VALID_CAPABILITY_IDS
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"未知能力 id: {sorted(unknown)} · 仅支持 {sorted(VALID_CAPABILITY_IDS)}",
        )

    # 2. 规范化 (缺失的能力按 False 补齐 · 多余的丢弃)
    consents_norm = {
        cid: bool(payload.consents.get(cid, False)) for cid in VALID_CAPABILITY_IDS
    }

    confirmed_at = datetime.now(timezone.utc).isoformat()
    cc_blob: dict[str, Any] = {
        "consents": consents_norm,
        "agreed_tos": payload.agreed_tos,
        "agreed_privacy": payload.agreed_privacy,
        "tos_version": payload.tos_version,
        "privacy_version": payload.privacy_version,
        "confirmed_at": confirmed_at,
    }

    # 3. JSONB merge 写入 profile.capability_consent (整段替换)
    session.execute(
        text(
            "UPDATE we_accounts "
            "SET profile = COALESCE(profile, '{}'::jsonb) "
            "             || jsonb_build_object('capability_consent', CAST(:cc AS jsonb)) "
            "WHERE id = :uid"
        ),
        {"cc": _json_dumps(cc_blob), "uid": current.id},
    )
    session.commit()

    logger.info(
        "user.consent · uid=%s consents=%s tos=%s privacy=%s",
        current.id,
        consents_norm,
        payload.agreed_tos,
        payload.agreed_privacy,
    )

    return ConsentResponse(
        ok=True,
        consents=consents_norm,
        agreed_tos=payload.agreed_tos,
        agreed_privacy=payload.agreed_privacy,
        tos_version=payload.tos_version,
        privacy_version=payload.privacy_version,
        confirmed_at=confirmed_at,
    )


# ════════════════════════════════════════════════════════════════════
# helpers
# ════════════════════════════════════════════════════════════════════
def _json_dumps(obj: Any) -> str:
    import json
    return json.dumps(obj, ensure_ascii=False)


def apply_consent_to_account(
    session: Session, account_id: int, cc_raw: dict[str, Any] | None,
) -> bool:
    """
    内部 service · 把客户端 WS hello 带的 capability_consent
    持久化到 we_accounts.profile.capability_consent

    返回是否实际更新了数据库。None / 空 dict / 校验失败 → False。
    被 ws.py 调用 · 必须吞掉所有异常 (不要让 WS hello 因 consent 处理失败而中断)
    """
    if not cc_raw or not isinstance(cc_raw, dict):
        return False
    try:
        consents_raw = cc_raw.get("consents") or {}
        if not isinstance(consents_raw, dict):
            return False
        unknown = set(consents_raw.keys()) - VALID_CAPABILITY_IDS
        if unknown:
            logger.warning(
                "user_consent.apply · uid=%s 忽略未知能力 %s", account_id, sorted(unknown),
            )
        consents_norm = {
            cid: bool(consents_raw.get(cid, False)) for cid in VALID_CAPABILITY_IDS
        }
        cc_blob = {
            "consents": consents_norm,
            "agreed_tos": bool(cc_raw.get("agreed_tos", False)),
            "agreed_privacy": bool(cc_raw.get("agreed_privacy", False)),
            "tos_version": cc_raw.get("tos_version", "v1.0"),
            "privacy_version": cc_raw.get("privacy_version", "v1.0"),
            "confirmed_at": cc_raw.get("confirmed_at") or datetime.now(timezone.utc).isoformat(),
            "source": "ws_hello",  # 区分是 REST API 还是 WS 上报
        }
        session.execute(
            text(
                "UPDATE we_accounts "
                "SET profile = COALESCE(profile, '{}'::jsonb) "
                "             || jsonb_build_object('capability_consent', CAST(:cc AS jsonb)) "
                "WHERE id = :uid"
            ),
            {"cc": _json_dumps(cc_blob), "uid": account_id},
        )
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("user_consent.apply · uid=%s 失败 %s", account_id, exc)
        return False
