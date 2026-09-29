"""
W0-7 · services/proxy/registry.py
IP 代理池业务模块的"注册中心" · 启动时调一次

职责:
  1. 在 frame_router 注册 tunnel_chunk / tunnel_close handler
     · 节点上行的隧道帧到达 ws.py 后会路由到这里
  2. 在 task_registry 注册 ip_proxy task_type (SESSION 模式)
     · 让 admin UI 能按模式分组 + 跟其他业务对齐

调用时机:
  - api/app.py lifespan 启动里调 install()
  - 一次性 · 重复调用幂等 (frame_router 会警告 · task_registry 会跳过相同 spec)
"""
from __future__ import annotations
import logging

from platform_v8.engine import frame_router, task_registry
from platform_v8.engine.task_registry import TaskMode, TaskTypeSpec
from platform_v8.protocol import ws_schema as wsp

logger = logging.getLogger(__name__)


# ──── frame_router handler (节点 → 平台 · 上行) ────
async def _on_tunnel_chunk(frame, worker_id: str, owner_id: int | None) -> None:
    """节点上行隧道数据 · 路由到 gateway.on_node_chunk"""
    p = frame.payload
    # 防御性检查 · 只处理本业务 service_type 的帧
    # 注: TunnelChunk/TunnelClose 不带 service_type · 业务靠 _sessions[tunnel_id] 找回
    # 如果 tunnel_id 不在本业务表 · gateway.on_node_chunk 会静默忽略
    from platform_v8.services.proxy import gateway as _pg
    await _pg.on_node_chunk(p.tunnel_id, p.data_b64, seq=p.seq)


async def _on_tunnel_close(frame, worker_id: str, owner_id: int | None) -> None:
    """节点上行关 session · 路由到 gateway.on_node_close"""
    p = frame.payload
    stats = p.stats or {}
    from platform_v8.services.proxy import gateway as _pg
    await _pg.on_node_close(
        p.tunnel_id,
        reason=p.reason or "target_close",
        bytes_up=int(stats.get("bytes_up", 0)),
        bytes_down=int(stats.get("bytes_down", 0)),
        error=p.error,
    )


# ──── task_registry 注册 ip_proxy task_type ────
_IP_PROXY_SPEC = TaskTypeSpec(
    task_type="ip_proxy",
    category="system",
    description="IP 代理池会话 (平台自营 · SESSION 模式)",
    accepted_input_kinds=("params_only",),
    default_input_kind="params_only",
    # SESSION 模式不走 slice/aggregate · 但 dataclass 必填 · 填默认
    slicer="single",
    aggregator="inline_concat",
    mode=TaskMode.SESSION,
)


# ──── 安装入口 (api/app.py lifespan 调) ────
_installed = False


def install() -> None:
    """注册本业务的所有扩展点

    幂等 (重复调不重复注册).
    api/app.py lifespan startup 里调一次:

        from platform_v8.services.proxy import registry as proxy_registry
        proxy_registry.install()
    """
    global _installed
    if _installed:
        logger.debug("services.proxy.registry · install 已调过 · 跳过")
        return

    # 1. frame_router 注册节点上行帧 handler
    # 注意: tunnel_chunk/tunnel_close 是 *通用* 帧
    # 如果将来 CDN/RPC 也用 tunnel_* · 需要按 service_type 二级路由 (TODO W2/W3)
    # MVP 阶段只有 ip_proxy 在用 tunnel_* · 直接绑定即可
    frame_router.register_handler("tunnel_chunk", _on_tunnel_chunk)
    frame_router.register_handler("tunnel_close", _on_tunnel_close)

    # 2. task_registry 注册 ip_proxy task_type (admin UI 用)
    task_registry.register_dynamic(_IP_PROXY_SPEC)

    _installed = True
    logger.info("services.proxy.registry · install 完成 · 已注册 tunnel_chunk/close handler + ip_proxy task_type")


def uninstall() -> None:
    """测试用 · 清除注册"""
    global _installed
    frame_router.unregister_handler("tunnel_chunk")
    frame_router.unregister_handler("tunnel_close")
    task_registry.TASK_REGISTRY.pop("ip_proxy", None)
    _installed = False
