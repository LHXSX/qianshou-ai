"""
Worker 在线状态管理 · 调度引擎的"节点视图"

设计要点 (考虑全链路):
  1. 单一接口: snapshot() 返回当前在线 worker 列表
     调度器 (planner.py · 链路 5) 用这个查可用节点
  2. 两层缓存:
     L1: Redis (TTL 30s · 跨进程共享)
     L2: DB 查 (Redis 挂 fallback)
     这一层抽象后 · 调度器不直接查 DB
  3. on_worker_online hook (链路 5 接 auto-queue):
     节点上线时 · 触发所有注册的 callback (重提 WAITING 任务)
  4. 用全局 dispatcher 模式 (类似 v1 的 _agent_registry · 但有 TTL 保护)
"""
from __future__ import annotations
import asyncio
import logging
from typing import Awaitable, Callable

from platform_v8.core import Worker
from platform_v8.storage import db as db_mod
from platform_v8.storage import kv as kv_mod
from platform_v8.storage.repo import WorkerRepo

logger = logging.getLogger(__name__)

WORKER_ONLINE_TTL_S = 60
WORKER_CACHE_TTL_S = 30


# ── on_worker_online hook 注册表 ─────────────────────
OnWorkerOnlineCallback = Callable[[str, int], Awaitable[None]]   # (worker_id, owner_id) -> coro

_online_callbacks: list[OnWorkerOnlineCallback] = []


def register_on_worker_online(cb: OnWorkerOnlineCallback) -> None:
    """
    其他模块在 startup 时注册 (e.g. 链路 5 的 auto-queue 重提 hook)

    用法:
        @app.on_event("startup")
        def setup():
            registry.register_on_worker_online(auto_queue.resubmit_waiting_for_owner)
    """
    _online_callbacks.append(cb)
    logger.info("registry.on_worker_online · 注册 callback %s", cb.__name__)


async def fire_worker_online(worker_id: str, owner_id: int) -> None:
    """
    节点上线时被调 · 触发所有注册 callback (fire-and-forget · 不阻塞 ws 主流程)

    api/v8/ws.py 在 auth_ok 后调本函数。

    2026-05-25 P1 · 用 broker._spawn 保留引用防 GC
    """
    from platform_v8.engine import broker as _broker
    for cb in list(_online_callbacks):
        try:
            _broker._spawn(cb(worker_id, owner_id))
        except Exception as exc:
            logger.warning("registry.fire_worker_online · callback %s 抛异常 (忽略): %s",
                           cb.__name__, exc)


# ── snapshot · 调度器入口 ────────────────────────────
async def snapshot(*, owner_id: int | None = None) -> list[Worker]:
    """
    返回当前在线 worker 列表

    优先级:
      1. Redis cache (TTL 30s) · 命中即返
      2. DB 查 · 写回 Redis · 返
    """
    cache_key = f"workers:online:{owner_id or 'all'}"

    # L1: Redis
    cached = kv_mod.get_json(cache_key)
    if cached is not None:
        # 把 dict 还原成 Worker (跳过 · 反正 planner 直接用 dict 就行)
        return _dicts_to_workers(cached)

    # L2: DB
    def _query():
        with db_mod.session_scope() as s:
            return WorkerRepo.list_online(s, owner_id=owner_id,
                                          online_ttl_seconds=WORKER_ONLINE_TTL_S)

    workers = await asyncio.to_thread(_query)

    # 写回缓存
    kv_mod.set_json(cache_key, [_worker_to_dict(w) for w in workers],
                    ttl_s=WORKER_CACHE_TTL_S)
    return workers


def invalidate_cache(*, owner_id: int | None = None) -> None:
    """worker 状态变化时 invalidate (注册/心跳更新/离线)"""
    kv_mod.delete(f"workers:online:{owner_id or 'all'}")
    if owner_id is not None:
        # 同时清"全平台"快照
        kv_mod.delete("workers:online:all")


# ── 内部 helper ──────────────────────────────────────
def _worker_to_dict(w: Worker) -> dict:
    """Worker dataclass → dict (用于 Redis 序列化)"""
    return {
        "id": w.id,
        "owner_id": w.owner_id,
        "name": w.name,
        "status": w.status.value,
        "capabilities": {
            "cpu_cores": w.capabilities.cpu_cores,
            "memory_gb": w.capabilities.memory_gb,
            "gpu_count": w.capabilities.gpu_count,
            "gpu_model": w.capabilities.gpu_model,
            "vram_mb": w.capabilities.vram_mb,
            "accelerators": w.capabilities.accelerators,
            "runtimes": w.capabilities.runtimes,
            "installed_skills": w.capabilities.installed_skills,
            "os": w.capabilities.os,
            "arch": w.capabilities.arch,
            "tier": w.capabilities.tier,
            "review_only": w.capabilities.review_only,
            "provided_capabilities": w.capabilities.provided_capabilities,
            "verified_task_adapters": w.capabilities.verified_task_adapters,
            "protocol_capabilities": w.capabilities.protocol_capabilities,
            "protocol_profile": w.capabilities.protocol_profile,
        },
        "load": w.load,
        "active_shards": w.active_shards,
        "reputation": w.reputation,
        "capability_score": w.capability_score,
        "last_seen": w.last_seen.isoformat() if w.last_seen else None,
        "registered_at": w.registered_at.isoformat(),
        "client_version": w.client_version,
    }


def _dicts_to_workers(dicts: list[dict]) -> list[Worker]:
    """Redis 缓存还原 (跳过 · 暂留 list[dict] 形式)"""
    from datetime import datetime
    from platform_v8.core import WorkerCapabilities, WorkerStatus
    out: list[Worker] = []
    for d in dicts:
        caps = d.get("capabilities", {})
        out.append(Worker(
            id=d["id"],
            owner_id=d["owner_id"],
            name=d["name"],
            status=WorkerStatus(d["status"]),
            capabilities=WorkerCapabilities.from_stored(caps if isinstance(caps, dict) else {}),
            load=d.get("load", 0.0),
            active_shards=d.get("active_shards", 0),
            reputation=d.get("reputation", 0.5),
            capability_score=d.get("capability_score", 0.0),
            last_seen=datetime.fromisoformat(d["last_seen"]) if d.get("last_seen") else None,
            registered_at=datetime.fromisoformat(d["registered_at"]),
            client_version=d.get("client_version", ""),
        ))
    return out
