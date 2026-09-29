"""
采集子系统 · 模块注册入口 (W4-D3 · 2026-05-26)

启动时调 install() 完成:
  1. task_registry 注册 task_type=crawl_subtask (mode=PULL)
  2. event_bus 订阅 shard.completed · 触发 aggregator_hook.on_shard_completed
     (反写 we_crawl_subtasks 状态 · 触发 verify/finalize/payout)
"""
from __future__ import annotations
import logging

from platform_v8.engine import task_registry
from platform_v8.engine.task_registry import TaskMode, TaskTypeSpec

logger = logging.getLogger(__name__)


# ──── task_registry 注册项 ────
_CRAWL_SUBTASK_SPEC = TaskTypeSpec(
    task_type="crawl_subtask",
    category="data",
    description="采集子任务 · 节点 HTTP GET 目标 URL + parser_type 解析 (PULL 模式 · 节点抢)",
    accepted_input_kinds=("params_only",),
    default_input_kind="params_only",
    slicer="single",                  # PULL 模式 · slicer 不调 (orders.py 手动 build shards)
    aggregator="inline_concat",       # workload DONE 时由 aggregator_hook 写 we_crawl_orders
    runtimes=("python3",),
    required_software=("requests",),  # 节点端 HTTP 抓取
    min_memory_mb=64,
    requires_gpu=False,
    default_max_shards=1,
    max_shards_limit=1_000_000,       # 单订单上限 100 万 subtask · 跟 OrderIn.total_count 一致
    mode=TaskMode.PULL,
)


_installed = False


def install() -> None:
    """注册 crawl 业务模块 (幂等)

    api/app.py lifespan 启动里调:
        from platform_v8.services.crawl import install as install_crawl
        install_crawl()
    """
    global _installed
    if _installed:
        return

    # 1. 注册 task_type
    task_registry.register_dynamic(_CRAWL_SUBTASK_SPEC)

    # 2. 订阅 shard.completed 事件 · aggregator_hook 反写 we_crawl_subtasks
    try:
        from platform_v8.services.economy import event_bus
        from . import aggregator_hook
        event_bus.subscribe("shard.completed", aggregator_hook.on_shard_completed)
        event_bus.subscribe("shard.failed", aggregator_hook.on_shard_failed)
    except Exception as exc:
        logger.warning("crawl.install · event_bus subscribe 失败 (老 HTTP API 仍能跑): %s", exc)

    _installed = True
    logger.info("services.crawl · install 完成 · task=crawl_subtask mode=PULL + event_bus subscribe")


def uninstall() -> None:
    """测试用 · 清掉注册"""
    global _installed
    task_registry.TASK_REGISTRY.pop("crawl_subtask", None)
    _installed = False
