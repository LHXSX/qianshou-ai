"""
IP 代理池 · 对外 API · /api/v8/proxy/*

3 种使用方式 (按场景):

【1】REST · 给后端服务 (如 GEO 监测自家调) 用:
  POST   /api/v8/proxy/sessions  {target_host, target_port}      → {session_id, worker_id}
  POST   /api/v8/proxy/sessions/{sid}/data  {data_b64}          → {ok, bytes_sent}
  GET    /api/v8/proxy/sessions/{sid}/data?timeout=30           → {data_b64, closed?}
  DELETE /api/v8/proxy/sessions/{sid}                           → {ok}

【2】WebSocket · 给外部客户 (爬虫 SDK 等) 用:
  WS /api/v8/proxy/ws?target_host=...&target_port=...&token=...
  (双工 piping · 客户写帧 → 节点 · 节点回帧 → 客户)

【3】SOCKS5 桥接 · 跑独立 bridge 容器 (W3):
  docker run qianshousuanli/proxy-bridge -p 1080:1080 -e PLATFORM_URL=...
  容器内开 SOCKS5 server · 后端走 ws 转到平台

风控:
  - 客户必须有有效 token (account.access_token)
  - 目标 host 白名单 (gateway.is_target_allowed)
  - 计费走 ledger (W1D4 实现)
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

# 2026-06-05 双层可见性:IP 代理池为管理员私有数字资产,REST/WS/stats 全收 admin
from platform_v8.api.deps import get_admin_account, get_session
from platform_v8.core import Account
from platform_v8.services.auth import validation as auth_validation
from platform_v8.services.proxy import gateway as pg
from platform_v8.storage import db as db_mod

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/proxy", tags=["proxy"])


# ════════════════════════════════════════════════════════════════════
# REST API
# ════════════════════════════════════════════════════════════════════
class OpenSessionReq(BaseModel):
    target_host: str = Field(..., min_length=1, max_length=253)
    target_port: int = Field(..., ge=1, le=65535)
    use_tls: bool = False
    initial_data_b64: str = ""
    region_hint: str = ""


class OpenSessionResp(BaseModel):
    session_id: str
    worker_id: str


@router.post("/sessions", response_model=OpenSessionResp)
async def open_session(
    req: OpenSessionReq,
    acc: Account = Depends(get_admin_account),
):
    """开新代理 session"""
    try:
        initial = base64.b64decode(req.initial_data_b64) if req.initial_data_b64 else b""
    except Exception:
        raise HTTPException(status_code=400, detail="initial_data_b64 invalid")

    try:
        sid, wid = await pg.open_session(
            client_id=str(acc.id),
            target_host=req.target_host,
            target_port=req.target_port,
            use_tls=req.use_tls,
            initial_data=initial,
            region_hint=req.region_hint,
        )
    except RuntimeError as exc:
        msg = str(exc)
        if "target_denied" in msg:
            raise HTTPException(status_code=403, detail=msg)
        if "no_available_node" in msg:
            raise HTTPException(status_code=503, detail=msg)
        raise HTTPException(status_code=500, detail=msg)

    return OpenSessionResp(session_id=sid, worker_id=wid)


class WriteDataReq(BaseModel):
    data_b64: str


class WriteDataResp(BaseModel):
    ok: bool
    bytes_sent: int


@router.post("/sessions/{sid}/data", response_model=WriteDataResp)
async def write_data(
    sid: str,
    req: WriteDataReq,
    acc: Account = Depends(get_admin_account),
):
    """客户写数据 (上行)"""
    sess = pg._sessions.get(sid)
    if not sess:
        raise HTTPException(status_code=404, detail="session not found")
    if sess.client_id != str(acc.id):
        raise HTTPException(status_code=403, detail="forbidden")

    try:
        data = base64.b64decode(req.data_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="data_b64 invalid")

    ok = await pg.forward_to_node(sid, data)
    if not ok:
        raise HTTPException(status_code=410, detail="session closed")
    return WriteDataResp(ok=True, bytes_sent=len(data))


class ReadDataResp(BaseModel):
    data_b64: str = ""
    closed: bool = False
    reason: str = ""


@router.get("/sessions/{sid}/data", response_model=ReadDataResp)
async def read_data(
    sid: str,
    timeout: float = Query(30.0, ge=0.1, le=120.0),
    acc: Account = Depends(get_admin_account),
):
    """客户读数据 (下行) · long poll"""
    sess = pg._sessions.get(sid)
    if not sess:
        raise HTTPException(status_code=404, detail="session not found")
    if sess.client_id != str(acc.id):
        raise HTTPException(status_code=403, detail="forbidden")

    data = await pg.read_from_node(sid, timeout=timeout)
    if data is None:
        # 超时 · 客户重新 GET
        return ReadDataResp(data_b64="", closed=sess.closed, reason=sess.close_reason)
    if data == b"" and sess.closed:
        return ReadDataResp(data_b64="", closed=True, reason=sess.close_reason)
    return ReadDataResp(data_b64=base64.b64encode(data).decode(), closed=False)


@router.delete("/sessions/{sid}")
async def close_session(
    sid: str,
    acc: Account = Depends(get_admin_account),
):
    sess = pg._sessions.get(sid)
    if not sess:
        return {"ok": True}
    if sess.client_id != str(acc.id):
        raise HTTPException(status_code=403, detail="forbidden")
    await pg.close_session(sid, reason="client_close")
    return {"ok": True}


# ════════════════════════════════════════════════════════════════════
# WebSocket 双工 API
# ════════════════════════════════════════════════════════════════════
@router.websocket("/ws")
async def proxy_ws(ws: WebSocket):
    """WebSocket 双工代理

    URL 参数: ?token=...&target_host=...&target_port=...&use_tls=0|1
    协议:
      C→S: 第一帧 (open) {"type":"open","host":"...","port":443}
           后续帧 (data) {"type":"data","data_b64":"..."}
           结束帧 (close) {"type":"close"}
      S→C: 节点响应 {"type":"data","data_b64":"..."}
           关闭   {"type":"close","reason":"...","bytes_up":N,"bytes_down":N}
    """
    await ws.accept()

    # 鉴权 (从 query token 或 Authorization header)
    token = ws.query_params.get("token") or ""
    if not token:
        await ws.close(code=4401, reason="missing token")
        return
    def _validated_admin():
        with db_mod.session_scope() as session:
            validated = auth_validation.validate_v8_access(session, token)
            if not validated.account.is_admin:
                raise auth_validation.AuthValidationError("admin only")
            session.commit()
            return validated

    try:
        validated = await asyncio.to_thread(_validated_admin)
        client_id = str(validated.account.id)
    except auth_validation.AuthValidationError:
        await ws.close(code=4401, reason="invalid token")
        return

    # 收 open
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=10)
    except asyncio.TimeoutError:
        await ws.close(code=4408, reason="open timeout")
        return
    try:
        frame = json.loads(raw)
        assert frame.get("type") == "open"
        target_host = str(frame["host"])
        target_port = int(frame["port"])
        use_tls = bool(frame.get("use_tls", False))
        initial = base64.b64decode(frame.get("initial_b64", "")) if frame.get("initial_b64") else b""
    except Exception:
        await ws.close(code=4400, reason="bad open frame")
        return

    # 开 session
    try:
        sid, wid = await pg.open_session(
            client_id=client_id,
            target_host=target_host,
            target_port=target_port,
            use_tls=use_tls,
            initial_data=initial,
        )
    except RuntimeError as exc:
        await ws.send_text(json.dumps({"type": "close", "reason": str(exc)}))
        await ws.close(code=4503, reason=str(exc)[:40])
        return

    await ws.send_text(json.dumps({"type": "ready", "session_id": sid, "worker_id": wid}))

    # 双向 pumping
    async def pump_to_node():
        """收客户帧 · 转给节点"""
        try:
            while True:
                raw = await ws.receive_text()
                await asyncio.to_thread(_validated_admin)
                m = json.loads(raw)
                t = m.get("type")
                if t == "data":
                    data = base64.b64decode(m.get("data_b64", ""))
                    if data:
                        await pg.forward_to_node(sid, data)
                elif t == "close":
                    await pg.close_session(sid, reason="client_close")
                    return
        except WebSocketDisconnect:
            await pg.close_session(sid, reason="ws_disconnect")
        except Exception as exc:
            logger.warning("proxy.ws.up · sid=%s err=%s", sid[:8], exc)
            await pg.close_session(sid, reason="up_error")

    async def pump_to_client():
        """从节点 queue 取数据 · 转给客户"""
        try:
            while True:
                data = await pg.read_from_node(sid, timeout=30)
                if data is None:
                    await asyncio.to_thread(_validated_admin)
                    # 30s 周期同时复核登录会话与代理 session。
                    sess = pg._sessions.get(sid)
                    if not sess or sess.closed:
                        return
                    continue
                if data == b"":
                    # 信号: session 关闭
                    sess = pg._sessions.get(sid)
                    reason = sess.close_reason if sess else "closed"
                    await ws.send_text(json.dumps({
                        "type": "close", "reason": reason,
                        "bytes_up": sess.bytes_up if sess else 0,
                        "bytes_down": sess.bytes_down if sess else 0,
                    }))
                    return
                await ws.send_text(json.dumps({
                    "type": "data",
                    "data_b64": base64.b64encode(data).decode(),
                }))
        except Exception as exc:
            logger.warning("proxy.ws.down · sid=%s err=%s", sid[:8], exc)

    try:
        await asyncio.gather(pump_to_node(), pump_to_client())
    finally:
        try:
            await ws.close()
        except Exception:
            pass


# ════════════════════════════════════════════════════════════════════
# 监控 / 调试
# ════════════════════════════════════════════════════════════════════
@router.get("/stats")
async def get_stats(acc: Account = Depends(get_admin_account)):
    """当前 proxy 状态 (admin 私有)"""
    return pg.stats()
