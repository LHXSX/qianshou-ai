"""
NCE P4.13 · 异步事件总线

设计要点 (考虑全链路):
  1. 派单/完成/失败等事件 publish 到 in-process queue · 不阻塞主流程
  2. 多个订阅者并发处理 (信誉算分 / 反作弊检测 / 监控上报)
  3. 失败/超时自动重试 (3 次) · 仍失败写 dead letter queue
  4. 单进程版 (P5 可换 Redis Streams / Kafka)
  
  事件类型 (NCE 关心的):
    - shard.dispatched      派单
    - shard.completed       完成
    - shard.failed          失败
    - worker.online         上线
    - worker.offline        下线
  
  订阅者 (示例):
    - hw_score 重算 (worker.online)
    - rep_score 重算 (shard.completed / shard.failed)
    - anti_cheat 检测 (shard.completed)
    - 监控告警
  
  fail-safe: 总线挂了 · publish 静默丢 · 不影响业务
"""
from __future__ import annotations
import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

logger = logging.getLogger(__name__)


# ════════════════════════════════════════════════════════════════════════════
# 事件模型
# ════════════════════════════════════════════════════════════════════════════

@dataclass
class Event:
    type: str                       # shard.dispatched / shard.completed / ...
    payload: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    attempts: int = 0


# ════════════════════════════════════════════════════════════════════════════
# 总线 (单例 · 进程内)
# ════════════════════════════════════════════════════════════════════════════

_QUEUE_MAX = 10000          # 防内存爆
_MAX_RETRIES = 3
_WORKER_COUNT = 2           # 并发处理协程数

_queue: asyncio.Queue | None = None
_subscribers: dict[str, list] = {}
_dead_letter: list[Event] = []
_consumers: list = []
_stats = {
    "published": 0,
    "consumed": 0,
    "failed": 0,
    "dead": 0,
}


def init_bus() -> None:
    """启动时调 · 初始化 queue + consumer 协程"""
    global _queue
    if _queue is not None:
        return
    _queue = asyncio.Queue(maxsize=_QUEUE_MAX)
    for i in range(_WORKER_COUNT):
        task = asyncio.create_task(_consumer_loop(worker_id=i))
        _consumers.append(task)
    logger.info("event_bus · 启动 · workers=%d max=%d", _WORKER_COUNT, _QUEUE_MAX)


async def shutdown_bus() -> None:
    """关闭 · 取消 consumer"""
    for t in _consumers:
        if not t.done():
            t.cancel()
            try:
                await t
            except Exception:
                pass
    _consumers.clear()


# ════════════════════════════════════════════════════════════════════════════
# Publish · 派单热路径调
# ════════════════════════════════════════════════════════════════════════════

def publish(event_type: str, **payload) -> bool:
    """
    publish 事件 (fire-and-forget · 不阻塞)
    
    Returns: True = 入队成功 · False = 队列满或总线未启动
    """
    if _queue is None:
        return False
    evt = Event(type=event_type, payload=payload)
    try:
        _queue.put_nowait(evt)
        _stats["published"] += 1
        return True
    except asyncio.QueueFull:
        logger.warning("event_bus · queue 满 · 丢事件 type=%s", event_type)
        return False


# ════════════════════════════════════════════════════════════════════════════
# Subscribe · 订阅者注册
# ════════════════════════════════════════════════════════════════════════════

def subscribe(event_type: str, handler: Callable[[Event], Awaitable[None]]) -> None:
    """
    注册订阅者 · 启动时调
    
    handler 必须是 async def 函数 · 接受 Event · 返 None
    异常会自动重试 (最多 3 次) · 仍失败进 dead_letter
    """
    _subscribers.setdefault(event_type, []).append(handler)
    logger.info("event_bus.subscribe · type=%s handler=%s", event_type, handler.__name__)


# ════════════════════════════════════════════════════════════════════════════
# Consumer loop · 后台协程
# ════════════════════════════════════════════════════════════════════════════

async def _consumer_loop(worker_id: int) -> None:
    """后台协程 · 从 queue 取事件 · 派发给订阅者"""
    logger.info("event_bus.consumer[%d] · 启动", worker_id)
    while True:
        try:
            evt: Event = await _queue.get()
            handlers = _subscribers.get(evt.type, [])
            if not handlers:
                _stats["consumed"] += 1
                continue

            # 并发跑所有 handler · 不抛异常
            for h in handlers:
                try:
                    await h(evt)
                except Exception as exc:
                    evt.attempts += 1
                    if evt.attempts < _MAX_RETRIES:
                        # 重新入队 (放队尾)
                        try:
                            _queue.put_nowait(evt)
                        except asyncio.QueueFull:
                            _dead_letter.append(evt)
                            _stats["dead"] += 1
                            _stats["failed"] += 1
                    else:
                        _dead_letter.append(evt)
                        _stats["dead"] += 1
                        _stats["failed"] += 1
                        logger.warning("event_bus.handler[%s] FAIL after %d retries: %s",
                                       h.__name__, evt.attempts, exc)
            _stats["consumed"] += 1
        except asyncio.CancelledError:
            logger.info("event_bus.consumer[%d] · 收到 cancel · 退出", worker_id)
            return
        except Exception as exc:
            logger.exception("event_bus.consumer[%d] · 异常 (继续): %s", worker_id, exc)


# ════════════════════════════════════════════════════════════════════════════
# Stats · admin 看
# ════════════════════════════════════════════════════════════════════════════

def get_stats() -> dict:
    return {
        "running": _queue is not None,
        "queue_size": _queue.qsize() if _queue else 0,
        "queue_max": _QUEUE_MAX,
        "consumers": len(_consumers),
        "subscribers": {t: len(hs) for t, hs in _subscribers.items()},
        "dead_letter_count": len(_dead_letter),
        "stats": dict(_stats),
    }


def get_dead_letter(limit: int = 50) -> list:
    """看 dead letter 队列 (debug 用)"""
    return [
        {
            "type": e.type, "attempts": e.attempts,
            "created_at": e.created_at,
            "payload_keys": list(e.payload.keys()),
        }
        for e in _dead_letter[-limit:]
    ]
