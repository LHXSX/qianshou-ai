"""
Session Dispatcher · 跟 broker 平级 · SESSION 模式任务的发送门面 (W0-3 新增)

设计要点:
  1. broker 是 SHARD 派发 (oneshot · ShardAssign 帧)
     session_dispatcher 是 SESSION 派发 (持续 · TunnelOpen/Chunk/Close 帧)
  2. 业务模块 (gateway.py / cdn.py / ...) 不直接 build_tunnel_* + push_to_worker
     改成调 session_dispatcher.open_tunnel(...) · 由 dispatcher 负责协议帧构造 + push
  3. dispatcher 不维护 session 状态 (那是业务的事 · 如 gateway 维护 _sessions 表)
     只是"通用发送门面" · 让业务跟协议解耦
  4. 节点上行帧 (TunnelChunk/TunnelClose) 走 frame_router · 不在本模块

典型业务调用:
    # services/proxy/gateway.py
    from platform_v8.engine import session_dispatcher

    ok = await session_dispatcher.open_tunnel(
        worker_id=worker_id,
        service_type="ip_proxy",
        tunnel_id=sid,
        target={"host": host, "port": port, "use_tls": use_tls},
        initial_data=initial_data,
        timeout_s=60,
        display_task_type="system_session",
        estimated_reward_edg=0.001,
    )

设计约束:
  - 不 import 业务模块 (engine 不 知道业务存在)
  - 通过 broker.push_to_worker 发帧 · 不直接接触 ws
  - 全部 async fn · 失败返 False · 业务方处理
"""
from __future__ import annotations
import base64
import logging

from platform_v8.engine import broker
from platform_v8.protocol import ws_schema as wsp

logger = logging.getLogger(__name__)


async def open_tunnel(
    *,
    worker_id: str,
    service_type: str,
    tunnel_id: str,
    target: dict | None = None,
    initial_data: bytes = b"",
    timeout_s: int = 60,
    deadline_ms: int = 0,
    display_task_type: str = "system_session",
    display_name: str = "系统任务",
    estimated_reward_edg: float = 0.0,
) -> bool:
    """业务调用 · 通过 broker.push_to_worker 发 TunnelOpen 帧

    Args:
        worker_id: 目标节点 ID
        service_type: 业务标识 ("ip_proxy" / "cdn_relay" / ...)
        tunnel_id: 会话 ID (业务自己生成 · 通常 uuid4)
        target: 业务自定义目标 (协议透传)
        initial_data: 首批数据 (会 base64 编码)
        timeout_s: 会话空闲超时
        deadline_ms: 会话最长时长
        display_*: 节点 UI 显示用 (业务脱敏)
        estimated_reward_edg: 预估奖励 (节点 UI 显示)

    Returns:
        True · 帧已发到 worker
        False · worker 不在线 / push 失败
    """
    initial_b64 = base64.b64encode(initial_data).decode() if initial_data else ""
    frame = wsp.build_tunnel_open(
        tunnel_id=tunnel_id,
        service_type=service_type,
        target=target or {},
        initial_data_b64=initial_b64,
        timeout_s=timeout_s,
        deadline_ms=deadline_ms,
        display_task_type=display_task_type,
        display_name=display_name,
        estimated_reward_edg=estimated_reward_edg,
    )
    ok = await broker.push_to_worker(worker_id, frame)
    if not ok:
        logger.warning("session_dispatcher.open_tunnel · push 失败 · worker=%s service=%s tid=%s",
                       worker_id, service_type, tunnel_id[:8])
    return ok


async def send_chunk(
    worker_id: str, tunnel_id: str, data: bytes, *, seq: int = 0,
) -> bool:
    """业务调用 · 发 TunnelChunk 帧 (平台 → 节点 · 下行数据)

    Returns:
        True · 已发 · False · push 失败
    """
    frame = wsp.build_tunnel_chunk(
        tunnel_id=tunnel_id,
        data_b64=base64.b64encode(data).decode(),
        seq=seq,
    )
    ok = await broker.push_to_worker(worker_id, frame)
    if not ok:
        logger.debug("session_dispatcher.send_chunk · push 失败 · worker=%s tid=%s seq=%d",
                     worker_id, tunnel_id[:8], seq)
    return ok


async def send_close(
    worker_id: str, tunnel_id: str,
    *,
    reason: str = "",
    stats: dict | None = None,
    error: str = "",
) -> bool:
    """业务调用 · 发 TunnelClose 帧 (平台 → 节点 · 关 session)

    Args:
        reason: "client_close" / "target_close" / "timeout" / "error" / 自定义
        stats: 业务自定义统计 (e.g. {"bytes_up": 1024, "bytes_down": 2048})
        error: 错误描述 (空 = 正常关闭)

    Returns:
        True · 已发 · False · push 失败 (worker 可能已掉线)
    """
    frame = wsp.build_tunnel_close(
        tunnel_id=tunnel_id,
        reason=reason,
        stats=stats or {},
        error=error,
    )
    ok = await broker.push_to_worker(worker_id, frame)
    if not ok:
        logger.debug("session_dispatcher.send_close · push 失败 (节点可能已掉线) · worker=%s tid=%s reason=%s",
                     worker_id, tunnel_id[:8], reason)
    return ok
