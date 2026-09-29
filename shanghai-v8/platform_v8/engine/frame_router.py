"""
Frame Router · 通用 ws 帧路由 (业务无关 · W0-2 新增)

设计要点:
  1. 引擎 ws.py 主循环不再 hardcode `if isinstance(frame, BusinessFrame): ...`
  2. 业务模块在 app 启动时注册自己的 handler (frame_type → callable)
  3. 引擎主循环对未知帧调 `dispatch(frame, worker_id, owner_id)`
  4. dispatch 找不到 handler → 返 False · 主循环再返 1004 unknown frame
  5. handler 异常静默 (logger.exception) · 不影响主循环

handler 签名 (Awaitable):
    async def handler(frame: FrameBase, worker_id: str, owner_id: int | None) -> None

典型用法:
    # services/proxy/__init__.py (业务模块) · 启动时调一次
    from platform_v8.engine import frame_router
    from platform_v8.protocol import ws_schema as wsp
    from platform_v8.services.proxy import gateway as _pg

    async def _on_tunnel_chunk(frame, worker_id, owner_id):
        # 这里通常需要按 service_type 二级路由 (因为 Tunnel 帧是通用的)
        # 但 tunnel_chunk/close 不带 service_type · 业务靠 _sessions[tunnel_id] 找回 service_type
        p = frame.payload
        await _pg.on_node_chunk(p.tunnel_id, p.data_b64, seq=p.seq)

    def install():
        frame_router.register_handler("tunnel_chunk", _on_tunnel_chunk)

    # api/app.py lifespan 里调:
    # from platform_v8.services.proxy import install_handlers
    # install_handlers()

设计约束:
  - 引擎 不 知道业务存在 · 只调 frame_router.dispatch
  - 业务 不 import api/v8/ws.py · 不 import engine 内部
  - 业务 import frame_router (引擎导出的扩展点) + protocol/ws_schema (协议)
"""
from __future__ import annotations
import asyncio
import logging
from typing import Awaitable, Callable

from platform_v8.protocol import ws_schema as wsp

logger = logging.getLogger(__name__)

# handler 签名 · 业务实现成 async fn
FrameHandler = Callable[[wsp.FrameBase, str, int | None], Awaitable[None]]


# 帧类型 → handler 的注册表 (业务启动时填)
_handlers: dict[str, FrameHandler] = {}


def register_handler(frame_type: str, handler: FrameHandler) -> None:
    """业务模块启动时注册 handler

    Args:
        frame_type: 帧 type 字段值 (如 "tunnel_chunk" / "tunnel_close")
        handler: async fn(frame, worker_id, owner_id) -> None
    """
    if frame_type in _handlers:
        logger.warning("frame_router · %s 被重复注册 · 后注册覆盖", frame_type)
    _handlers[frame_type] = handler
    logger.info("frame_router · 注册 handler · type=%s", frame_type)


def unregister_handler(frame_type: str) -> None:
    """注销 handler (测试用 · 一般业务不调)"""
    _handlers.pop(frame_type, None)


async def dispatch(frame, worker_id: str, owner_id: int | None = None) -> bool:
    """引擎 ws.py 主循环调用

    Returns:
        True  · 已 dispatch 给业务 handler (主循环 continue)
        False · 没注册 handler · 主循环走默认 (返 1004 unknown frame)
    """
    handler = _handlers.get(frame.type)
    if handler is None:
        return False
    try:
        await handler(frame, worker_id, owner_id)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        # handler 内部异常静默 (业务问题不能炸 ws 主循环)
        logger.exception("frame_router · handler %s 异常 · worker=%s · err=%s",
                         frame.type, worker_id, exc)
    return True


def list_handlers() -> list[str]:
    """admin 调试用 · 返当前注册的 frame_type 列表"""
    return sorted(_handlers.keys())


def clear_all() -> None:
    """测试 fixture 用 · 清空所有 handler"""
    _handlers.clear()
