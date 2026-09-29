"""
GEO 监测 · 模块注册入口 (W2-4)

启动时调 install() · 完成:
  1. task_registry 注册 task_type=geo_query (mode=PULL)
  2. event_bus 订阅 shard.completed · 触发 aggregator_hook.on_shard_completed
"""
from __future__ import annotations
import logging

from platform_v8.engine import task_registry
from platform_v8.engine.task_registry import TaskMode, TaskTypeSpec

from . import aggregator_hook

logger = logging.getLogger(__name__)


# ──── task_registry 注册项 ────
_GEO_QUERY_SPEC = TaskTypeSpec(
    task_type="geo_query",
    category="ai",
    description="GEO 监测 · 调 LLM API 查询品牌关键词 (PULL 模式 · 节点抢)",
    accepted_input_kinds=("params_only",),
    default_input_kind="params_only",
    slicer="single",                  # PULL 模式 · slicer 不会被调 (因为 orders.py 手动 build shards)
    aggregator="inline_concat",       # workload DONE 时 · 不需要再聚合 (observations 已在 hook 写)
    runtimes=("python3",),
    required_software=("requests",),  # 节点端调 LLM 用
    min_memory_mb=128,
    requires_gpu=False,
    default_max_shards=1,
    max_shards_limit=500,             # 单订单 ≤ 500 query
    mode=TaskMode.PULL,               # 关键: PULL 模式 · lifecycle 不调 broker
)


_installed = False


def install() -> None:
    """注册 GEO 业务模块 (幂等)
    
    api/app.py lifespan 启动里调:
        from platform_v8.services.geo import install as install_geo
        install_geo()
    """
    global _installed
    if _installed:
        return
    
    # 1. 注册 task_type
    task_registry.register_dynamic(_GEO_QUERY_SPEC)
    
    # 2. 订阅 shard.completed 事件 · 触发 NLP 分析
    try:
        from platform_v8.services.economy import event_bus
        event_bus.subscribe("shard.completed", aggregator_hook.on_shard_completed)
    except Exception as exc:
        logger.warning("geo.install · event_bus subscribe 失败 (NLP 分析将无法自动跑): %s", exc)
    
    _installed = True
    logger.info("services.geo · install 完成 · task=geo_query mode=PULL + event_bus subscribe")


def uninstall() -> None:
    """测试用 · 清掉注册"""
    global _installed
    task_registry.TASK_REGISTRY.pop("geo_query", None)
    # event_bus 没 unsubscribe API · 留着不影响 (重启时清)
    _installed = False
