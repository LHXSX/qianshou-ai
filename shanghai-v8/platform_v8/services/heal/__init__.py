"""
services/heal · 后端主导自愈 (2026-06-05)

闭环: 节点 env 失败 → aggregator 钩子 → decider 决策 → WS 下发 control 白名单指令
      → 客户端执行 → control_result 回报 → 记录 we_node_repairs。

是客户端本地自愈 (self_heal.rs) 的增强/兜底:
  - 本地自愈是第一道防线 (节点自己重装 tier)
  - 后端决策器针对"本地没修好/反复失败/全局性问题"下发针对性修复指令
  - 全 flag 门控 nce_backend_heal · 默认 OFF
"""
from platform_v8.services.heal import decider  # noqa: F401
