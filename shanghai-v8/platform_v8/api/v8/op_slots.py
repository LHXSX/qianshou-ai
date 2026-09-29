"""
运营位 (Op Slot) · 公共读取接口 · /api/v8/op-slots/*

客户端 (Tauri / web-portal / 未来移动端) 通过此接口拉取当前生效的运营内容。
不需要登录态 (公开接口 · 让游客也能看 splash/notice)。

热更新链路:
   后台改 → admin_op_slots.py 写入 + 调 broker.broadcast_op_slots_changed
   → 所有在线客户端收到 ws 帧 op_slots_changed
   → 客户端 useOpSlots 立即重新调本接口拉最新

埋点链路 (2026-05-23 加):
   客户端首次可见 → POST /op-slots/{id}/impression
   用户点击      → POST /op-slots/{id}/click
   用户关闭      → POST /op-slots/{id}/dismiss
   写入 we_op_slot_events 表 · 给广告主出 CTR / 独立设备数报表
"""
from __future__ import annotations
import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/op-slots", tags=["op-slots"])


# ════════════════════════════════════════════════════════════════════
# Schemas
# ════════════════════════════════════════════════════════════════════
class OpSlotItem(BaseModel):
    id: int
    slot_key: str
    title: str
    subtitle: str = ""
    image_url: Optional[str] = None
    video_url: Optional[str] = None
    rich_html: Optional[str] = None
    action_type: str = "none"
    action_target: Optional[str] = None
    action_label: Optional[str] = None
    priority: int = 0
    cooldown_hours: int = 0
    show_once: bool = False
    closable: bool = True
    start_at: Optional[str] = None
    end_at: Optional[str] = None


class ActiveSlotsResponse(BaseModel):
    ok: bool = True
    server_time: str  # ISO timestamp · 给客户端做 cache TTL 参考
    slots: dict[str, list[OpSlotItem]]  # { slot_key: [items 按 priority 降序] }


# ════════════════════════════════════════════════════════════════════
# helpers
# ════════════════════════════════════════════════════════════════════
def _row_to_item(row) -> OpSlotItem:
    d = dict(row)
    for k in ("start_at", "end_at"):
        if d.get(k):
            d[k] = d[k].isoformat() if hasattr(d[k], "isoformat") else str(d[k])
    return OpSlotItem(**{k: v for k, v in d.items() if k in OpSlotItem.model_fields})


# ════════════════════════════════════════════════════════════════════
# GET /op-slots/active · 拉取当前生效的运营位
# ════════════════════════════════════════════════════════════════════
@router.get("/active", response_model=ActiveSlotsResponse)
def get_active_slots(
    keys: str = Query(
        ...,
        description="逗号分隔的 slot_key · 如 splash,banner,notice",
        examples=["splash,banner,notice"],
    ),
    client_version: Optional[str] = Query(None, description="客户端版本号 · 用于受众过滤"),
    os: Optional[str] = Query(None, description="客户端 OS · macos/windows/linux"),
    tags: Optional[str] = Query(
        None,
        description="客户端 tags · 逗号分隔 · 如 'gpu:nvidia,skill:image-gen,arch:x86_64'",
        examples=["os:macos,gpu:apple,skill:llm-chat"],
    ),
    session: Session = Depends(get_session),
) -> ActiveSlotsResponse:
    key_list = [k.strip() for k in keys.split(",") if k.strip()]
    if not key_list:
        raise HTTPException(status_code=400, detail="keys 参数不能为空")
    if len(key_list) > 20:
        raise HTTPException(status_code=400, detail="单次最多查询 20 个 slot_key")

    # 解析客户端 tags 为 set
    client_tags: set[str] = set()
    if tags:
        client_tags = {t.strip() for t in tags.split(",") if t.strip()}

    now = datetime.now(timezone.utc)
    # 一次查所有 key · 在内存按 key 分组 (比 N 次查询快)
    # SQLite 不支持 ANY(:array) · 用 IN 兼容本地开发库
    bind = session.get_bind()
    dialect = getattr(getattr(bind, "dialect", None), "name", "") or ""
    try:
        if dialect == "sqlite":
            placeholders = ", ".join(f":k{i}" for i in range(len(key_list)))
            params = {f"k{i}": k for i, k in enumerate(key_list)}
            params["now"] = now.isoformat()
            rows = session.execute(
                text(
                    f"SELECT * FROM we_op_slots "
                    f"WHERE slot_key IN ({placeholders}) "
                    "  AND is_active = 1 "
                    "  AND (start_at IS NULL OR start_at <= :now) "
                    "  AND (end_at IS NULL OR end_at > :now) "
                    "ORDER BY slot_key, priority DESC, id DESC"
                ),
                params,
            ).mappings().all()
        else:
            rows = session.execute(
                text(
                    "SELECT * FROM we_op_slots "
                    "WHERE slot_key = ANY(:keys) "
                    "  AND is_active = TRUE "
                    "  AND (start_at IS NULL OR start_at <= :now) "
                    "  AND (end_at IS NULL OR end_at > :now) "
                    "ORDER BY slot_key, priority DESC, id DESC"
                ),
                {"keys": key_list, "now": now},
            ).mappings().all()
    except Exception as exc:
        # 本地 SQLite 缺迁移表时 · 返回空运营位，避免企业端反复弹「服务器内部错误」
        msg = str(exc)
        if "we_op_slots" in msg or "no such table" in msg.lower():
            logger.warning("op_slots.active · 表不可用 · 返回空 slots · err=%s", exc)
            try:
                session.rollback()
            except Exception:
                pass
            return ActiveSlotsResponse(
                ok=True,
                server_time=now.isoformat(),
                slots={k: [] for k in key_list},
            )
        raise

    # 按 key 分组 + 受众过滤 (含 tags 定向)
    grouped: dict[str, list[OpSlotItem]] = {k: [] for k in key_list}
    for row in rows:
        item = _row_to_item(row)
        audience = row.get("target_audience") or {}
        if isinstance(audience, str):
            try:
                audience = json.loads(audience)
            except Exception:
                audience = {}
        if not _match_audience(audience, client_version, os, client_tags):
            continue
        grouped[item.slot_key].append(item)

    return ActiveSlotsResponse(
        ok=True,
        server_time=now.isoformat(),
        slots=grouped,
    )


def _match_audience(
    audience: dict,
    client_version: Optional[str],
    client_os: Optional[str],
    client_tags: Optional[set[str]] = None,
) -> bool:
    """
    受众过滤 · 空 audience = 全部匹配

    支持字段:
      - os: ['macos','windows']  · 客户端 os 必须 ∈ 列表 (空表示不限制)
      - min_version / max_version · 客户端版本范围 (字典序简单对比)
      - tags_any: ['gpu:nvidia','skill:image-gen']
          · 客户端 tags 任一命中即通过 (OR 语义)
      - tags_all: ['os:macos','skill:llm-chat']
          · 客户端 tags 全部命中才通过 (AND 语义)
      - tags_not: ['skill:disabled']
          · 客户端 tags 含任一就排除 (黑名单)

    多个条件之间 AND 关系 · 全部满足才返回 True
    """
    if not audience:
        return True

    # 1. OS 过滤
    target_os = audience.get("os")
    if target_os and client_os and client_os not in target_os:
        return False

    # 2. 版本范围
    min_ver = audience.get("min_version")
    if min_ver and client_version and client_version < min_ver:
        return False
    max_ver = audience.get("max_version")
    if max_ver and client_version and client_version > max_ver:
        return False

    # 3. tag 定向 (空 client_tags 视为空集合)
    client_tags = client_tags or set()

    # 3a. tags_any · OR · 任一命中即通过
    tags_any = audience.get("tags_any") or []
    if tags_any:
        if not (client_tags & set(tags_any)):
            return False

    # 3b. tags_all · AND · 全部命中才通过
    tags_all = audience.get("tags_all") or []
    if tags_all:
        if not set(tags_all).issubset(client_tags):
            return False

    # 3c. tags_not · 黑名单 · 任一命中即排除
    tags_not = audience.get("tags_not") or []
    if tags_not:
        if client_tags & set(tags_not):
            return False

    return True


# ════════════════════════════════════════════════════════════════════
# 埋点 · 事件上报 (公开接口 · 客户端 + web 都可调)
# ════════════════════════════════════════════════════════════════════
class EventReportIn(BaseModel):
    """客户端事件上报 body · 字段均可选 · 留 None 表示未知"""
    node_id: Optional[str] = Field(None, description="v8 worker_id · 设备级匿名")
    account_id: Optional[int] = Field(None, description="登录用户 id · 未登录为 NULL")
    client_version: Optional[str] = None
    client_os: Optional[str] = None
    client_tags: list[str] = Field(default_factory=list, description="客户端定向 tags 列表")
    action_type: Optional[str] = Field(None, description="仅 click 事件填 · 实际触发的跳转类型")
    action_target: Optional[str] = None


VALID_EVENT_TYPES = {"impression", "click", "dismiss", "close"}


def _daily_salt() -> str:
    """日级 salt · 当天内同一 IP hash 相同 · 跨日不可关联 (GDPR 友好)"""
    base = os.environ.get("OP_SLOT_SALT", "qianshou-op-slot-2026")
    today = datetime.now(timezone.utc).date().isoformat()
    return f"{base}::{today}"


def _hash_ip(ip: str | None) -> str | None:
    if not ip:
        return None
    return hashlib.sha256(f"{_daily_salt()}|{ip}".encode()).hexdigest()[:32]


def _hash_ua(ua: str | None) -> str | None:
    if not ua:
        return None
    return hashlib.sha256(f"ua|{ua}".encode()).hexdigest()[:32]


def _client_ip(request: Request) -> str | None:
    # 走 nginx 代理 · 优先 X-Forwarded-For
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    return request.client.host if request.client else None


def _record_event(
    session: Session,
    *,
    slot_id: int,
    event_type: str,
    payload: EventReportIn,
    request: Request,
) -> dict:
    # 校验 slot 存在 (容忍 NotFound 静默 200 · 客户端不感知后台删 slot 的事件)
    slot_key_row = session.execute(
        text("SELECT slot_key FROM we_op_slots WHERE id = :id"),
        {"id": slot_id},
    ).first()
    if not slot_key_row:
        # 不抛 404 · 防止客户端反复重试 · 但记一条 warn
        logger.warning("op_slot_event · slot_id=%s not found · type=%s", slot_id, event_type)
        return {"ok": True, "stored": False}

    slot_key = slot_key_row[0]
    session.execute(
        text(
            "INSERT INTO we_op_slot_events "
            "(slot_id, slot_key, event_type, node_id, account_id, "
            " client_version, client_os, client_tags, "
            " action_type, action_target, ip_hash, ua_hash) "
            "VALUES "
            "(:slot_id, :slot_key, :event_type, :node_id, :account_id, "
            " :client_version, :client_os, CAST(:client_tags AS jsonb), "
            " :action_type, :action_target, :ip_hash, :ua_hash)"
        ),
        {
            "slot_id": slot_id,
            "slot_key": slot_key,
            "event_type": event_type,
            "node_id": payload.node_id,
            "account_id": payload.account_id,
            "client_version": payload.client_version,
            "client_os": payload.client_os,
            "client_tags": json.dumps(payload.client_tags, ensure_ascii=False),
            "action_type": payload.action_type,
            "action_target": payload.action_target,
            "ip_hash": _hash_ip(_client_ip(request)),
            "ua_hash": _hash_ua(request.headers.get("user-agent")),
        },
    )
    session.commit()
    return {"ok": True, "stored": True}


@router.post("/{slot_id}/impression", response_model=dict, summary="上报曝光事件")
def report_impression(
    slot_id: int,
    body: EventReportIn,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    return _record_event(
        session, slot_id=slot_id, event_type="impression",
        payload=body, request=request,
    )


@router.post("/{slot_id}/click", response_model=dict, summary="上报点击事件")
def report_click(
    slot_id: int,
    body: EventReportIn,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    return _record_event(
        session, slot_id=slot_id, event_type="click",
        payload=body, request=request,
    )


@router.post("/{slot_id}/dismiss", response_model=dict, summary="上报关闭/dismiss 事件")
def report_dismiss(
    slot_id: int,
    body: EventReportIn,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    return _record_event(
        session, slot_id=slot_id, event_type="dismiss",
        payload=body, request=request,
    )


@router.post("/batch-events", response_model=dict, summary="批量事件上报")
def report_batch(
    request: Request,
    events: list[dict] = Body(..., embed=False, description="[{slot_id, event_type, ...EventReportIn}]"),
    session: Session = Depends(get_session),
) -> dict:
    """
    批量埋点 (客户端可能合并多条事件减少请求量)
    每条 event dict 必须含 slot_id + event_type + EventReportIn 字段
    """
    ok_n, fail_n = 0, 0
    for ev in events:
        try:
            slot_id = int(ev.get("slot_id", 0))
            event_type = str(ev.get("event_type", ""))
            if not slot_id or event_type not in VALID_EVENT_TYPES:
                fail_n += 1
                continue
            payload = EventReportIn(
                node_id=ev.get("node_id"),
                account_id=ev.get("account_id"),
                client_version=ev.get("client_version"),
                client_os=ev.get("client_os"),
                client_tags=ev.get("client_tags") or [],
                action_type=ev.get("action_type"),
                action_target=ev.get("action_target"),
            )
            _record_event(
                session, slot_id=slot_id, event_type=event_type,
                payload=payload, request=request,
            )
            ok_n += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("batch event 单条失败: %s · ev=%s", exc, ev)
            fail_n += 1
    return {"ok": True, "stored": ok_n, "failed": fail_n}
