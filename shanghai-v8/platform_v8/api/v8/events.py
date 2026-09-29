from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from platform_v8.engine import broker as broker_mod
from platform_v8.services.auth import validation as auth_validation
from platform_v8.storage import db as db_mod

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/ws", tags=["events"])


def _event_payload(event_type: str, data: dict[str, Any]) -> dict[str, Any]:
    return {"type": event_type, "data": data, "ts": int(time.time() * 1000)}


async def publish_event(event_type: str, data: dict[str, Any], *, owner_id: int | None = None) -> None:
    target_owner = owner_id or data.get("owner_id") or data.get("account_id")
    if target_owner is None:
        logger.debug("events.publish skip · type=%s missing owner", event_type)
        return
    await broker_mod.broadcast_to_owner(int(target_owner), event_type, data)


def publish_event_sync(event_type: str, data: dict[str, Any], *, owner_id: int | None = None) -> None:
    target_owner = owner_id or data.get("owner_id") or data.get("account_id")
    if target_owner is None:
        logger.debug("events.publish_sync skip · type=%s missing owner", event_type)
        return
    broker_mod.broadcast_to_owner_threadsafe(int(target_owner), event_type, data)


def _account_from_token(raw_token: str):
    with db_mod.session_scope() as s:
        try:
            validated = auth_validation.validate_v8_access(s, raw_token)
        except auth_validation.AuthValidationError:
            return None
        s.commit()
        return validated.account


@router.websocket("/events")
async def events_ws(ws: WebSocket):
    raw_token = ws.query_params.get("token") or ""
    account = await asyncio.to_thread(_account_from_token, raw_token)
    if account is None or not account.is_active:
        await ws.accept()
        await ws.send_text(json.dumps(_event_payload("error", {"message": "unauthorized"}), ensure_ascii=False))
        await ws.close(code=1008)
        return

    await ws.accept()
    owner_id = int(account.id)
    await broker_mod.register_event_listener(owner_id, ws)
    await ws.send_text(json.dumps(_event_payload("connected", {"owner_id": owner_id}), ensure_ascii=False))
    try:
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=30)
            except asyncio.TimeoutError:
                if await asyncio.to_thread(_account_from_token, raw_token) is None:
                    await ws.close(code=4401)
                    return
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                msg = {"type": raw}
            if msg.get("type") == "ping":
                if await asyncio.to_thread(_account_from_token, raw_token) is None:
                    await ws.close(code=4401)
                    return
                await ws.send_text(json.dumps(_event_payload("pong", {}), ensure_ascii=False))
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("events.ws error · owner=%s", owner_id)
    finally:
        await broker_mod.unregister_event_listener(owner_id, ws)


@router.websocket("/live")
async def live_ws(ws: WebSocket):
    """v1 兼容别名 · 前端 (web-portal/admin-portal) 调 /api/v8/ws/live?channels=stats,node,task
    · 鉴权同 /events · 无 token 时降级匿名(只回 ping/pong · 不推业务事件)。
    """
    raw_token = ws.query_params.get("token") or ""
    # channels 暂只用于将来过滤 · 当前 broker 不做 per-channel 过滤 · 全推
    _channels = (ws.query_params.get("channels") or "").split(",")

    account = None
    if raw_token:
        account = await asyncio.to_thread(_account_from_token, raw_token)

    if raw_token and (account is None or not account.is_active):
        await ws.accept()
        await ws.send_text(json.dumps(
            _event_payload("error", {"message": "unauthorized"}),
            ensure_ascii=False,
        ))
        await ws.close(code=4401)
        return

    # 匿名分支 · Home.vue 不带 token · 维持长连不推业务事件 · 避免 403 噪音
    if account is None:
        await ws.accept()
        await ws.send_text(json.dumps(_event_payload("connected", {"anonymous": True}), ensure_ascii=False))
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except Exception:
                    msg = {"type": raw}
                if msg.get("type") == "ping":
                    await ws.send_text(json.dumps(_event_payload("pong", {}), ensure_ascii=False))
        except WebSocketDisconnect:
            pass
        except Exception:
            logger.exception("live.ws anonymous error")
        return

    # 登录分支 · 复用 events 的 broker 订阅 + ping/pong
    await ws.accept()
    owner_id = int(account.id)
    await broker_mod.register_event_listener(owner_id, ws)
    await ws.send_text(json.dumps(_event_payload("connected", {"owner_id": owner_id, "channels": _channels}), ensure_ascii=False))
    try:
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=30)
            except asyncio.TimeoutError:
                if await asyncio.to_thread(_account_from_token, raw_token) is None:
                    await ws.close(code=4401)
                    return
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                msg = {"type": raw}
            if msg.get("type") == "ping":
                if await asyncio.to_thread(_account_from_token, raw_token) is None:
                    await ws.close(code=4401)
                    return
                await ws.send_text(json.dumps(_event_payload("pong", {}), ensure_ascii=False))
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("live.ws error · owner=%s", owner_id)
    finally:
        await broker_mod.unregister_event_listener(owner_id, ws)
