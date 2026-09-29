"""
Pull Dispatcher · 跟 broker 平级 · PULL 模式 shard 的分配器 (W1-3 · 2026-05-26)

设计要点:
  1. broker (ONESHOT)         · server 主动派 · 用 NCE 打分选 worker · push 推
     session_dispatcher (SESSION) · server 主动派 · 1 session = 1 worker · TunnelOpen
     pull_dispatcher (PULL)    · node 主动抢 · server 给 N 个 LEASED shard · PullAssign
  2. 流向:
     节点 ws → PullRequest 帧
       → frame_router.dispatch (W0-2 已实现)
       → pull_dispatcher._on_pull_request (本模块)
       → ShardRepo.lease_pending_pull (W1-1 已实现 · FOR UPDATE SKIP LOCKED)
       → 构造 ShardAssignPayload (复用 broker 同样的 shard→payload 转换)
       → broker.push_to_worker (PullAssign 帧)
       → 节点收 PullAssign · 走 executor (复用现有 task 执行链)
  3. lease 超时回 PENDING (lifecycle._sweeper_loop 调 ShardRepo.reap_expired_leases · W1-6 接)
  4. 节点完成时走原 shard_result 帧 (没新协议)
  
扩展点 · 业务调用:
  - install() · 引擎启动时调一次 · 注册 frame_router handler ("pull_request")
  - assign_pull() · admin 调试用 (直接调取 N 个 shard · 不走 ws)
"""
from __future__ import annotations
import logging
import time
from datetime import datetime
from typing import Any

from platform_v8.core import Shard, ShardMode, Workload
from platform_v8.protocol import ws_schema as wsp
from platform_v8.services.observability import record_lifecycle_event

logger = logging.getLogger(__name__)


# PULL lease 覆盖有效执行超时和结果上传缓冲；不再使用固定 120 秒。
PULL_UPLOAD_BUFFER_SECONDS = 45
MIN_PULL_LEASE_SECONDS = 180

# 节点 pull 限速提示 (server → node · 下次 pull 等多久 · 防 ddos)
DEFAULT_NEXT_PULL_MS = 5000


# ════════════════════════════════════════════════════════════════════
# 1. shard → ShardAssignPayload (跟 broker 同套路 · 节点端 executor 完全复用)
# ════════════════════════════════════════════════════════════════════
def _shard_to_assign_payload(
    sh: Shard, wl: Workload,
    *,
    worker_id: str = "",
    requester_name: str = "",
    requester_avatar: str = "",
    created_at_ms: int = 0,
) -> wsp.ShardAssignPayload:
    """单 Shard + Workload → ShardAssignPayload (跟 broker.dispatch_assignments 一致)

    这是 W1-3 临时实现 · 跟 broker 重复逻辑.
    TODO (W1+): 抽到 engine/_payload_helpers.py 统一管理.

    V8.1 (2026-05-27) · 跟 broker 同步加 required_tier · 爬虫/GEO 等 PULL 业务
    也按 venv 路由 · 客户端 v8.1.0+ 收到后 spawn_shard_task → executor 选对 venv 跑
    """
    from platform_v8.engine.assignment_payload import build_assignment_payload

    return build_assignment_payload(
        sh,
        wl,
        worker_id=worker_id or str(sh.lease_by_node or sh.worker_id or ""),
        requester_name=requester_name,
        requester_avatar=requester_avatar,
        created_at_ms=created_at_ms,
    )


# ════════════════════════════════════════════════════════════════════
# 2. assign_pull · 业务/handler 调 · 抢 N 个 PULL shard
# ════════════════════════════════════════════════════════════════════
def _strict_adapter_allowed(s: Any, worker: Any, workload: Workload) -> bool:
    """Mandatory server-side adapter admission, independent of legacy feature flags."""
    from platform_v8.engine.task_registry import get_spec

    task_type = str(getattr(workload.spec, "task_type", "") or "")
    registered = get_spec(task_type)
    if not registered.requires_verified_adapter:
        return True
    if worker is None:
        return False
    from platform_v8.services.workers.task_adapter_routing import can_route_reviewed_adapter

    return can_route_reviewed_adapter(
        s, worker, task_type=task_type,
        input_kind=str(getattr(workload.spec, "input_kind", "") or ""),
        capability_id=registered.adapter_capability_id,
        output_kind=registered.adapter_output_kind,
    )


async def assign_pull(
    *,
    worker_id: str,
    max_count: int = 1,
    task_type_filter: list[str] | None = None,
    lease_seconds: int | None = None,
) -> list[wsp.ShardAssignPayload]:
    """节点抢 N 个 PULL 模式 shard · 返 ShardAssignPayload 列表 (准备发 PullAssign 用)
    
    实现:
      1. ShardRepo.lease_pending_pull (FOR UPDATE SKIP LOCKED 抢)
      2. 每个 shard 查对应 workload · 转 ShardAssignPayload
      3. 出错的 shard 释放回 PENDING (避免被 lease 但发不出去)
    
    Returns:
        ShardAssignPayload 列表 (可能为空 · server 没活时也返空)
    """
    import asyncio
    dispatch_started = time.perf_counter()
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo, WorkloadRepo, AccountRepo, WorkerRepo
    
    def _do() -> list[wsp.ShardAssignPayload]:
        with db_mod.session_scope() as s:
            wls_map: dict[str, Workload] = {}

            def _workload_for(shard: Shard) -> Workload | None:
                workload = wls_map.get(shard.workload_id)
                if workload is None:
                    workload = WorkloadRepo.by_id(s, shard.workload_id)
                    if workload is not None:
                        wls_map[shard.workload_id] = workload
                return workload

            def _lease_seconds_for(shard: Shard) -> int:
                from platform_v8.engine.effective_task import (
                    soft_reclaim_running_horizon_s,
                )

                return soft_reclaim_running_horizon_s(
                    _workload_for(shard), shard
                )

            shards = ShardRepo.lease_pending_pull(
                s, worker_id=worker_id,
                max_count=max_count,
                task_type_filter=task_type_filter,
                lease_seconds=lease_seconds,
                lease_seconds_for=(
                    None if lease_seconds is not None else _lease_seconds_for
                ),
            )
            if not shards:
                s.commit()
                return []
            
            # 一次查所有 workload + account (避免 N+1)
            wl_ids = list({sh.workload_id for sh in shards})
            for wid in wl_ids:
                if wid not in wls_map:
                    w = WorkloadRepo.by_id(s, wid)
                    if w is not None:
                        wls_map[wid] = w
            
            owner_ids = list({wl.owner_id for wl in wls_map.values()})
            owners_map: dict[int, Any] = {}
            for oid in owner_ids:
                a = AccountRepo.by_id(s, oid)
                if a is not None:
                    owners_map[oid] = a

            # 2026-06-02 P1-问题3 · PULL 抢单对齐 PUSH 能力硬过滤:
            #   节点只按自报 task_type_filter 抢 shard · 不校验真实能力 →
            #   抢到跑不了的活 (缺 software/GPU/内存) → 执行失败 → shard 反复弹回。
            #   flag pull_capability_check ON → 用 planner.worker_can_run 单一谓词校验 ·
            #   不合格的 shard 释放回 PENDING (留给有能力的节点) · 与 PUSH 同一套过滤器。
            #   flag OFF → 老行为 (零回归)。校验只读 worker 一次 · 异常 fail-open 不拦。
            #
            # 2026-08 · worker_ids 硬 pin 始终生效（不看 flag）:
            #   律所等写入 requirements.worker_ids 后，别家节点不得 lease。
            _cap_check = False
            _worker_obj = None
            try:
                from platform_v8.services.ops import feature_flags as _ff
                _cap_check = _ff.is_enabled("pull_capability_check")
            except Exception:
                _cap_check = False
            try:
                _worker_obj = WorkerRepo.by_id(s, worker_id)
            except Exception as exc:
                logger.debug("pull_dispatcher · 取 worker 失败: %s", exc)
                _worker_obj = None
            
            payloads: list[wsp.ShardAssignPayload] = []
            failed_shards: list[str] = []
            unfit_shards: list[str] = []
            for sh in shards:
                wl = wls_map.get(sh.workload_id)
                if wl is None:
                    # workload 不存在 (异常状态 · 释放 lease 回 PENDING)
                    failed_shards.append(sh.id)
                    continue
                # 即使底层 SQL 未来被替换，管理员定向节点约束也不能被 PULL 路径绕过。
                from platform_v8.engine.planner import worker_allowed_for_workload
                if not worker_allowed_for_workload(worker_id, wl):
                    logger.warning(
                        "pull_dispatcher · worker=%s 不在 workload=%s 指定节点名单 · 释放 shard=%s",
                        worker_id, wl.id, sh.id)
                    unfit_shards.append(sh.id)
                    continue
                # Reviewed and purchased adapters use the same server-owned
                # qualification as PUSH. Node task filters and the legacy
                # pull_capability_check flag cannot grant this route.
                try:
                    if not _strict_adapter_allowed(s, _worker_obj, wl):
                        unfit_shards.append(sh.id)
                        continue
                except Exception as exc:
                    logger.warning("pull_dispatcher · 接单适配器资格不可用，拒绝 shard=%s: %s",
                                   sh.id, exc)
                    unfit_shards.append(sh.id)
                    continue
                # 能力校验 (flag ON 且取到 worker 时) · 不合格释放回 PENDING
                if _cap_check and _worker_obj is not None:
                    try:
                        from platform_v8.engine.planner import worker_can_run
                        if not worker_can_run(_worker_obj, wl):
                            logger.info(
                                "pull_dispatcher · worker=%s 缺 %s 任务能力 · 释放 shard=%s 回 PENDING",
                                worker_id, wl.spec.task_type, sh.id)
                            unfit_shards.append(sh.id)
                            continue
                    except Exception as exc:
                        logger.debug("pull_dispatcher · 能力校验异常 fail-open: %s", exc)
                acc = owners_map.get(wl.owner_id)
                try:
                    payload = _shard_to_assign_payload(
                        sh, wl,
                        worker_id=worker_id,
                        requester_name=getattr(acc, "username", "") if acc else "",
                        requester_avatar=getattr(acc, "avatar_url", "") if acc else "",
                        created_at_ms=int(wl.created_at.timestamp() * 1000) if wl.created_at else 0,
                    )
                    payloads.append(payload)
                except Exception as exc:
                    logger.warning("pull_dispatcher · shard %s 转 payload 失败: %s",
                                   sh.id, exc)
                    failed_shards.append(sh.id)
            
            # 释放转换失败 + 能力不合格的 lease (回 PENDING · 让其他/有能力节点拉)
            for fid in failed_shards:
                ShardRepo.release_lease(s, fid, expected_worker_id=worker_id)
            for uid in unfit_shards:
                ShardRepo.release_lease(s, uid, expected_worker_id=worker_id)
            
            s.commit()
            return payloads
    
    payloads = await asyncio.to_thread(_do)
    for payload in payloads:
        record_lifecycle_event(
            "dispatch",
            workload_id=payload.workload_id,
            shard_id=payload.shard_id,
            worker_id=worker_id,
            latency_ms=(time.perf_counter() - dispatch_started) * 1000,
            outcome="issued",
            extra={"mode": "pull"},
        )
    return payloads


# ════════════════════════════════════════════════════════════════════
# 3. frame_router handler · 收 PullRequest → assign_pull → 发 PullAssign
# ════════════════════════════════════════════════════════════════════
async def _on_pull_request(frame, worker_id: str, owner_id: int | None) -> None:
    """节点发来 PullRequest · 我们 lease N 个 shard 给它"""
    from platform_v8.engine import broker
    
    p = frame.payload
    max_count = max(1, min(int(p.max_count or 1), 10))  # 服务端硬限制 [1, 10]
    task_type_filter = list(p.task_type_filter or []) or None
    
    try:
        payloads = await assign_pull(
            worker_id=worker_id,
            max_count=max_count,
            task_type_filter=task_type_filter,
        )
    except Exception as exc:
        logger.exception("pull_dispatcher · assign_pull 异常 · worker=%s err=%s",
                         worker_id, exc)
        payloads = []
    
    # 发 PullAssign 帧 (即使空 shards · 也回一次告诉节点"现在没活")
    frame_text = wsp.build_pull_assign(
        shards=payloads,
        next_pull_after_ms=DEFAULT_NEXT_PULL_MS,
        server_load_hint=0.0,  # TODO P2 接 server 真实负载
    )
    ok = await broker.push_to_worker(worker_id, frame_text, source="pull")
    if not ok:
        # 节点掉线 · 释放所有 lease (避免 lease 时间到才回 PENDING)
        logger.warning("pull_dispatcher · push PullAssign 失败 · 释放 %d 个 lease · worker=%s",
                       len(payloads), worker_id)
        if payloads:
            import asyncio
            from platform_v8.storage import db as db_mod
            from platform_v8.storage.repo import ShardRepo
            
            def _release_all():
                with db_mod.session_scope() as s:
                    for p_ in payloads:
                        ShardRepo.release_lease(s, p_.shard_id, expected_worker_id=worker_id)
                    s.commit()
            await asyncio.to_thread(_release_all)
        return
    
    if payloads:
        # 2026-06-06 · push 成功 → confirm lease (LEASED→RUNNING · 写 worker_id)
        # 闭环修复: 解决 PULL shard 卡 LEASED + worker_id 空 → 节点完成时 mark_done CAS 失败。
        # 乐观确认(push 成功≈节点收到) · 节点若 confirm 后崩 → reap_expired_leases 超时回收。
        import asyncio as _aio
        from platform_v8.storage import db as _db
        from platform_v8.storage.repo import ShardRepo as _SR

        def _confirm_all() -> int:
            with _db.session_scope() as s:
                n = 0
                for p_ in payloads:
                    lease_ttl = max(
                        MIN_PULL_LEASE_SECONDS,
                        int(p_.timeout_s) + PULL_UPLOAD_BUFFER_SECONDS,
                    )
                    if _SR.confirm_lease_start(
                        s,
                        p_.shard_id,
                        expected_worker_id=worker_id,
                        expected_attempt=int(p_.attempt),
                        lease_seconds=lease_ttl,
                    ):
                        n += 1
                s.commit()
                return n

        try:
            confirmed = await _aio.to_thread(_confirm_all)
        except Exception as exc:
            confirmed = -1
            logger.warning("pull_dispatcher · confirm_lease_start 异常 (不致命·靠 reap 兜底): %s", exc)
        logger.info("pull_dispatcher · assign · worker=%s count=%d confirmed=%d filter=%s",
                    worker_id, len(payloads), confirmed, task_type_filter)


# ════════════════════════════════════════════════════════════════════
# 4. install · 引擎启动时调一次 (lifecycle.init_engine 调)
# ════════════════════════════════════════════════════════════════════
_installed = False


def install() -> None:
    """注册 PullRequest handler 到 frame_router (幂等)
    
    api/app.py lifespan 启动时调:
        from platform_v8.engine import pull_dispatcher
        pull_dispatcher.install()
    """
    global _installed
    if _installed:
        return
    from platform_v8.engine import frame_router
    frame_router.register_handler("pull_request", _on_pull_request)
    _installed = True
    logger.info("pull_dispatcher · install 完成 · pull_request handler 已注册")


def uninstall() -> None:
    """测试用 · 清除注册"""
    global _installed
    from platform_v8.engine import frame_router
    frame_router.unregister_handler("pull_request")
    _installed = False
