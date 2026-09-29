"""IP 代理池 · 2026-05-26 新增 (W0-7 调整 · 业务模块标准接入)

平台自营业务 (走 D 方案 · 节点知情但脱敏 · 给小额奖励):
  - 节点装客户端 = 默认接入 + EULA 同意
  - 节点端 UI 显示 "system_session" 字段 (display_task_type 脱敏)
  - 心跳不计 proxy session 进 NCE active_shards
  - 收入: 大客户 → 平台 (100% 归平台 · 写 we_platform_revenue)
  - 节点补贴: 走 we_subsidy_rules + we_node_subsidies (小额 EDG)

模块入口:
  - registry.install()    · 启动时调一次 · 注册 frame_router handler + task_registry
  - gateway.open_session()· 业务 API · 创建代理会话
  - gateway.close_session()
  - gateway.forward_to_node() / read_from_node()

合规兜底 (法律边界):
  - 用户 EULA 必须包含 "节点资源可被平台调度用于多种合法业务"
  - 否则有 "未经同意占用宽带" 风险 (PCDN 雷)
"""
from . import gateway  # noqa: F401
from .registry import install, uninstall  # noqa: F401

__all__ = ["gateway", "install", "uninstall"]
