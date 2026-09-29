"""crawl 服务 · 公开数据采集白名单管控 + 审计

模块组成:
  whitelist.py        · URL 白名单服务 (查 / 增 / 删 / 改)
  schemas.py          · pydantic DTO
  orders.py           · 客户下单 + 拆 subtask + escrow + (W4) 双写 unified workload+shards
  dispatch.py         · 节点 HTTP poll/complete/fail (兼容期 · 后续下线)
  worker.py           · 后台 reclaim/finalize 循环
  registry.py         · (W4) task_registry 注册 + event_bus 订阅
  aggregator_hook.py  · (W4) shard.completed/failed 反写老 we_crawl_subtasks
"""
from .registry import install, uninstall  # noqa: F401
