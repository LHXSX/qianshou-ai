"""
Workload 生命周期 · 状态机推进 (核心引擎)

设计要点 (考虑全链路):
  状态机:
    CREATED → PLANNED → RUNNING → AGGREGATING → DONE
                ↓              ↓                  ↓
            WAITING_FOR_WORKERS │              FAILED
                ↓              ↓
            CREATED (节点上线 hook 重提)
                                ↓
                            CANCELLED (用户取消)

  本文件 (链路 4) 只实现:
    - start(workload_id): CREATED → PLANNED → RUNNING (或 WAITING_FOR_WORKERS)
      链路 4 stub 版: 直接跳过 plan · 留在 CREATED (留待链路 5 实现 slice+schedule)
    - resubmit_waiting_workloads(owner_id): 节点上线 hook 调用

  链路 5 将完整实现:
    - planner.slice + planner.schedule + broker.dispatch
    - on_shard_done + aggregator.collect → DONE/FAILED
"""
from __future__ import annotations

RUNTIME_CONTRACT_ID = "2026-08-13.delivery-evidence"  # keep in sync with platform_v8.runtime_contract.CONTRACT_ID

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from platform_v8.core import Workload, WorkloadStatus
from platform_v8.services.observability import record_lifecycle_event
from platform_v8.storage.repo import WorkloadRepo
from platform_v8.engine import registry as registry_mod

logger = logging.getLogger(__name__)
_REDISPATCH_DEBOUNCE_SECONDS = 0.15
_redispatch_local_locks: dict[str, object] = {}
_redispatch_last_started: dict[str, float] = {}


# ═══════════════════════════════════════════════════════════════
# 租约续期与回收 · 防RUNNING卡死 · 2026-08
# ═══════════════════════════════════════════════════════════════

async def renew_shard_leases(worker_id: str, active_shard_count: int) -> None:
    """worker心跳时续约其所有RUNNING shard的租约。
    lease_expires_at = now + 90s（容忍3次心跳丢失）
    """
    from platform_v8.storage.repo import ShardRepo
    from platform_v8.storage import db as db_mod
    import sqlalchemy as sa

    def _renew():
        with db_mod.session_scope() as s:
            new_expiry_dt = datetime.utcnow() + timedelta(seconds=90)  # 90秒容忍
            rows = s.execute(
                sa.text("""
                    UPDATE we_shards SET lease_expires_at = :exp
                    WHERE worker_id = :wid AND status = 'RUNNING' AND lease_expires_at IS NOT NULL
                """),
                {"exp": new_expiry_dt, "wid": worker_id}
            )
            updated = rows.rowcount
            if updated:
                logger.debug("lease.renew · worker=%s · renewed %d shards", worker_id[:13], updated)
            s.commit()
    await asyncio.to_thread(_renew)


async def sweep_expired_leases() -> dict:
    """回收所有租约过期的shard → PENDING。每30秒cron调用。"""
    from platform_v8.storage.repo import ShardRepo
    from platform_v8.storage import db as db_mod
    import sqlalchemy as sa

    def _sweep():
        reclaimed = []
        with db_mod.session_scope() as s:
            now = datetime.utcnow()
            rows = s.execute(
                sa.text("""
                    SELECT id, worker_id FROM we_shards
                    WHERE status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at < :now
                    LIMIT 500
                """),
                {"now": now}
            ).fetchall()
            for row in rows:
                s.execute(
                    sa.text("""
                        UPDATE we_shards SET status = 'PENDING', worker_id = NULL,
                        lease_by_node = NULL, lease_expires_at = NULL, attempts = 0
                        WHERE id = :id AND status = 'RUNNING'
                    """),
                    {"id": row.id}
                )
                reclaimed.append(str(row.id))
            s.commit()
        if reclaimed:
            logger.warning("lease.sweep · 回收 %d 个过期租约shard", len(reclaimed))
        return {"reclaimed": len(reclaimed)}
    return await asyncio.to_thread(_sweep)


async def start(workload_id: str) -> None:
    """M2 · L1 单一权威派发入口。
       多网关下: 非 leader 把作业委派给 leader 执行 (杜绝"提交网关"与"leader"两个大脑接力派发)。
       leader / 单进程: 本地执行,再套 per-workload 锁串行 + 幂等兜底。
       委派失败 (无 Redis) → 本地兜底执行 · gw_multi OFF → 逐字节同旧行为。"""
    from platform_v8.engine import gateway as _gw
    if _gw.multi_enabled() and not _gw.is_leader_fresh():
        if _gw.publish_leader_job("start", workload_id):
            logger.debug("engine.start · workload=%s 非leader · 委派 leader 执行", workload_id)
            return
        # 委派未发出 (Redis 异常) → 落到本地兜底执行
    _tok = _gw.acquire_workload_lock(workload_id)
    if _tok is None:
        logger.debug("engine.start · workload=%s 派发锁被其他网关持有 · 跳过", workload_id)
        return
    try:
        await _start_impl(workload_id)
    finally:
        _gw.release_workload_lock(workload_id, _tok)


async def _start_impl(workload_id: str) -> None:
    """
    workload 提交后调用 · 推动状态机 CREATED → PLANNED → RUNNING

    流程:
      1. 拿 workload + 在线 worker 池
      2. 没 worker → WAITING_FOR_WORKERS (留待 auto-queue 重提)
      3. slice 分片 + schedule 选 worker + dispatch 派给 ws
      4. 全部 dispatch 成功 → RUNNING
      5. 部分 dispatch 失败 → 已 reset 的 shard 留待下次重试 (此处简化)

    派单契约 (跨账号):
      候选池 = 全平台在线节点 (broker.online_worker_ids_for_dispatch)
      不按 workload.owner_id 过滤 worker.owner_id。
      账号 A 提交的任务可派给账号 B 的节点；结算奖励仍记入执行节点所属账号。
    """
    import asyncio
    from platform_v8.engine import planner, broker
    from platform_v8.engine.slicers import slice_workload as slicer_slice
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo

    def _load_workload():
        with db_mod.session_scope() as s:
            return WorkloadRepo.by_id(s, workload_id)

    workload = await asyncio.to_thread(_load_workload)
    if workload is None:
        logger.warning("engine.start · workload %s 不存在", workload_id)
        return
    from platform_v8.services.media_profiles import is_media
    if is_media(workload):
        from platform_v8.services.media_channel import start_media
        await start_media(workload_id)
        return
    if workload.is_terminal:
        logger.debug("engine.start · workload %s 已 terminal · 跳过", workload_id)
        return
    if workload.status not in (WorkloadStatus.CREATED, WorkloadStatus.WAITING_FOR_WORKERS):
        logger.debug("engine.start · workload %s 状态 %s · 跳过",
                     workload_id, workload.status.value)
        return

    # 幂等: 已有 shard 说明上次 start 切片已落库（并发重试 / UniqueViolation 半截）。
    # 企业端与生态借调共用本入口 · 不重切 · 直接 RUNNING + redispatch。
    def _existing_shard_count() -> int:
        with db_mod.session_scope() as s:
            counts = ShardRepo.count_by_status(s, workload_id)
            return int(sum(counts.values())) if counts else 0

    existing_n = await asyncio.to_thread(_existing_shard_count)
    if existing_n > 0:
        logger.info(
            "engine.start · workload=%s 已有 %d shards · 跳过切片改走 redispatch",
            workload_id,
            existing_n,
        )

        def _promote_running() -> None:
            with db_mod.session_scope() as s:
                WorkloadRepo.update_status(
                    s, workload_id, WorkloadStatus.RUNNING, error="",
                )
                s.commit()

        await asyncio.to_thread(_promote_running)
        await redispatch_pending(workload_id)
        return

    # 1. 拿在线 worker（全平台 · 不按任务提交账号过滤）
    #   单进程: broker 本地会话 (dispatch 必须有 ws session)
    #   M2 多进程: 全局 Redis ZSET 在线集 (跨进程可见 · 不在本进程的节点靠跨网关 push 投递)
    online_worker_ids = broker.online_worker_ids_for_dispatch()
    if not online_worker_ids:
        await _mark_waiting(workload_id, reason="没在线 worker")
        return

    # 2. 从 DB 取 worker 详情 (打分用 capabilities / load)
    # 2026-06-02 P1-问题2 · 在线感知统一到单一权威:
    #   broker.get_online_worker_ids() = 有 live WS 会话的节点 (派发必需 · 真权威)
    #   老逻辑再用 DB status (w.is_online) 二次过滤 → "两套" · DB status 滞后会误踢
    #   有 live WS 的节点 (尤其 M1 批量回写让 last_seen/status 有 ≤30s 延迟时)。
    #   flag nce_trust_ws_online ON → 信任 WS 会话 · 不被 DB status 否决 (reaper 仍兜底对账)
    #   flag OFF → 老行为 (零回归 · 可一键回退)
    def _load_workers():
        with db_mod.session_scope() as s:
            from platform_v8.storage.repo import WorkerRepo
            from platform_v8.services.ops import feature_flags as _ff
            try:
                trust_ws = _ff.is_enabled("nce_trust_ws_online")
            except Exception:
                trust_ws = False
            workers = []
            for wid in online_worker_ids:
                w = WorkerRepo.by_id(s, wid)
                if w is None:
                    continue
                if trust_ws or w.is_online:
                    workers.append(w)
            return workers

    workers = await asyncio.to_thread(_load_workers)
    if not workers:
        await _mark_waiting(workload_id, reason="DB 中没找到对应 worker")
        return

    # 3. slice (2026-05-18 · 走新 task_registry → slicer 派发)
    # 2026-05-25 NCE P4.15 · flag ON 时按 max_shards 切 (不限 n_workers)
    # 让"一节点一片 + 排队"生效 · 否则切片数被压到 n_workers · 排不了队
    # package_digest 例外: 必须按真实在线可跑台数切 (上限 100), 禁止用 max_shards 虚增
    n_workers_for_slice = len(workers)
    task_type = str(getattr(workload.spec, "task_type", "") or "")
    if task_type not in ("package_digest", "material_digest"):
        try:
            from platform_v8.services.ops import feature_flags as _ff
            if _ff.is_enabled("nce_one_shard_per_worker", subject_id=None):
                n_workers_for_slice = max(len(workers), int(workload.spec.max_shards or 1))
        except Exception:
            pass
    # package_digest: 在线台数控制并发参考; slicer 按页切可超过台数排队(硬顶 100)
    # 禁止再把「预算≈在线台数」压成每材料 1 片 · 否则大扫描 PDF 整包硬塞节点
    else:
        n_workers_for_slice = max(1, min(100, len(workers)))
        logger.info(
            "engine.start · package_digest 切片参考在线台数 · workers=%d slice_cap=%d "
            "(实际页切由 package_recipe 按页/体积决定, 可排队)",
            len(workers), n_workers_for_slice,
        )
    try:
        from platform_v8.services.ops import feature_flags as _ff
        if _ff.is_enabled("nce_one_shard_per_worker", subject_id=None):
            n_workers_for_slice = max(len(workers), int(workload.spec.max_shards or 1))
    except Exception:
        pass
    try:
        shards = slicer_slice(workload, n_workers=n_workers_for_slice)
    except Exception as exc:
        from platform_v8.engine.task_registry import ShardCapacityError

        if not isinstance(exc, ShardCapacityError):
            raise

        def _fail_contract():
            with db_mod.session_scope() as s:
                WorkloadRepo.update_status(
                    s,
                    workload_id,
                    WorkloadStatus.FAILED,
                    error=f"执行合同无法满足: {exc}",
                )
                s.commit()

        await asyncio.to_thread(_fail_contract)
        logger.warning(
            "engine.start · workload=%s 分片容量合同失败 · 不再进入 WAITING 重试: %s",
            workload_id,
            exc,
        )
        return

    # ── W1-4 (2026-05-26) · 统一引擎 · 给每个 shard 设 mode ──
    # 从 task_registry.get_spec(task_type).mode 取 · 默认 ONESHOT (向后兼容现有 53 task)
    try:
        from platform_v8.engine.task_registry import get_spec as _get_spec, TaskMode
        from platform_v8.core import ShardMode
        _spec_meta = _get_spec(workload.spec.task_type)
        _workload_mode = _spec_meta.mode if _spec_meta else TaskMode.ONESHOT
        _shard_mode = ShardMode(_workload_mode.value)
        for sh in shards:
            sh.mode = _shard_mode
    except Exception as _exc:
        logger.warning("engine.start · 解析 task mode 失败 · 降级 ONESHOT: %s", _exc)
        from platform_v8.engine.task_registry import TaskMode
        from platform_v8.core import ShardMode
        _workload_mode = TaskMode.ONESHOT
        _shard_mode = ShardMode.ONESHOT
        for sh in shards:
            sh.mode = _shard_mode

    # 2026-05-18 · 冗余派发 (anti_cheat 多数派比对)
    # redundancy_factor>1 时 · 每片复制 R-1 份新 Shard · 派给不同 worker
    # 需要 workers >= R · 否则降级 (logger warning · 不冗余)
    redundancy = max(1, int(workload.spec.redundancy_factor or 1))
    if redundancy > 1:
        if len(workers) < redundancy:
            logger.warning("redundancy=%d 但 workers=%d 不够 · 降级 redundancy=1 (无 anti_cheat)",
                           redundancy, len(workers))
            redundancy = 1
        else:
            import copy
            from platform_v8.core import Shard
            from uuid import uuid4
            replicated: list = []
            for sh in shards:
                # 原片 (副本 0)
                sh.metadata = dict(sh.metadata or {})
                sh.metadata["replica_index"] = 0
                sh.metadata["replica_of"] = sh.id  # 标记 canonical id (相同片的 leader id)
                replicated.append(sh)
                # 副本 1..R-1
                for r in range(1, redundancy):
                    clone = copy.deepcopy(sh)
                    clone.id = str(uuid4())
                    clone.metadata = dict(clone.metadata or {})
                    clone.metadata["replica_index"] = r
                    clone.metadata["replica_of"] = sh.id
                    replicated.append(clone)
            logger.info("redundancy · workload=%s 原 %d 片 → 冗余 ×%d = %d 副本",
                        workload_id, len(shards), redundancy, len(replicated))
            shards = replicated

    # 4. 持久化 shard
    def _persist_shards():
        with db_mod.session_scope() as s:
            ShardRepo.create_batch(s, shards)
            WorkloadRepo.update_status(
                s, workload_id, WorkloadStatus.PLANNED,
                started_at=datetime.utcnow(),
                total_shards=len(shards),
            )
            s.commit()

    await asyncio.to_thread(_persist_shards)
    logger.info("engine.start · workload=%s 已切 %d shards · 进入 PLANNED",
                workload_id, len(shards))

    # ── W1-5 (2026-05-26) · 按 mode 路由 dispatch ──
    if _workload_mode == TaskMode.PULL:
        # PULL 模式 · 不调 planner + broker · 直接推到 RUNNING · 等节点 PullRequest 来抢
        # shard 已经持久化为 PENDING + mode=PULL · pull_dispatcher 会自动 lease
        def _mark_running_pull():
            with db_mod.session_scope() as s:
                WorkloadRepo.update_status(s, workload_id, WorkloadStatus.RUNNING)
                s.commit()
        await asyncio.to_thread(_mark_running_pull)
        logger.info("engine.dispatch · workload=%s mode=PULL · %d shards 落表 · 等节点拉取",
                    workload_id, len(shards))
        return

    if _workload_mode == TaskMode.SESSION:
        # SESSION 模式 · lifecycle 不参与具体派发 (业务直接调 session_dispatcher.open_tunnel)
        # 这种 workload 通常不走 lifecycle.start (业务自己 lifecycle)
        # 兜底: 标 RUNNING · 由业务自己管 shard
        logger.warning("engine.dispatch · workload=%s mode=SESSION · 应由业务直接调 session_dispatcher", workload_id)
        def _mark_running_session():
            with db_mod.session_scope() as s:
                WorkloadRepo.update_status(s, workload_id, WorkloadStatus.RUNNING)
                s.commit()
        await asyncio.to_thread(_mark_running_session)
        return

    # ONESHOT 模式 (现有 53 task) · 走 planner + broker (现状)
    assignments = planner.schedule_assignments(shards, workers, workload=workload)
    if not assignments:
        online_ids = {str(getattr(w, "id", "") or "") for w in workers}
        if await _fail_if_dead_pin(workload_id, workload, online_ids):
            return
        # 没节点匹配 task 要求 · 转 WAITING (等装好软件的节点上线) · 写明缺什么能力
        await _mark_waiting(workload_id, reason=_requirement_summary(workload))
        return
    report = await broker.dispatch_assignments(workload, shards, assignments)
    logger.info("engine.dispatch · workload=%s mode=ONESHOT · %s", workload_id, report)

    # 6. 推到 RUNNING (至少 1 个 shard 派出去就 RUNNING)
    if report["dispatched"] > 0:
        def _mark_running():
            with db_mod.session_scope() as s:
                WorkloadRepo.update_status(s, workload_id, WorkloadStatus.RUNNING)
                s.commit()
        await asyncio.to_thread(_mark_running)
    else:
        # 全 dispatch 失败 · 回 WAITING
        await _mark_waiting(workload_id, reason="dispatch 全失败")


def _requirement_summary(workload) -> str:
    """构造 WAITING 原因 · 写明该 task 缺哪类能力 (软件/内存/GPU) · 便于运营/客户定位。"""
    try:
        tt = getattr(getattr(workload, "spec", None), "task_type", "?")
        from platform_v8.engine.task_registry import get_spec
        spec = get_spec(tt)
        parts = []
        if spec.required_software:
            parts.append("software=" + "+".join(spec.required_software))
        if spec.min_memory_mb:
            parts.append(f"内存>={spec.min_memory_mb}MB")
        if spec.requires_gpu:
            parts.append("需要GPU")
        need = (" · 需要 " + " / ".join(parts)) if parts else ""
        return f"无在线节点满足 task={tt} 要求{need} (或合格节点均近期跑挂·冷却中)"
    except Exception:
        return "没节点满足 task requirements"


async def _mark_waiting(workload_id: str, reason: str) -> None:
    """marks workload as WAITING_FOR_WORKERS · 等节点上线 hook"""
    import asyncio
    from platform_v8.storage import db as db_mod

    def _do():
        with db_mod.session_scope() as s:
            WorkloadRepo.update_status(
                s, workload_id, WorkloadStatus.WAITING_FOR_WORKERS,
                error=f"WAITING: {reason}",
            )
            s.commit()
    await asyncio.to_thread(_do)
    logger.info("engine.waiting · workload=%s reason=%s", workload_id, reason)


def _workload_age(workload) -> timedelta | None:
    created = getattr(workload, "created_at", None)
    if created is None:
        return None
    if getattr(created, "tzinfo", None) is None:
        created = created.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - created


def _pin_known_ids(pin: set[str]) -> set[str]:
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import WorkerRepo

    found: set[str] = set()
    with db_mod.session_scope() as s:
        for wid in pin:
            row = WorkerRepo.by_id(s, wid)
            if row is not None:
                found.add(str(wid))
    return found


async def _dead_pin_reason_of(workload, online_ids: set[str]) -> str | None:
    from platform_v8.engine import planner

    pin = planner.pinned_worker_ids(workload)
    if pin is None:
        return None
    known = await asyncio.to_thread(_pin_known_ids, pin)
    return planner.pin_dead_reason(
        pin,
        online_ids=online_ids,
        known_ids=known,
        age=_workload_age(workload),
    )


async def _fail_dead_pin_shards(workload_id, reason: str) -> int:
    """pin 已死：PENDING 分片 FAILED，再走 finalize。"""
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo
    from platform_v8.core import ShardStatus
    from platform_v8.engine import aggregator as _aggregator

    error = f"pin unsatisfiable:{reason}"

    def _do() -> int:
        with db_mod.session_scope() as s:
            shards = ShardRepo.by_workload(s, workload_id)
            n = 0
            for sh in shards:
                if sh.status == ShardStatus.PENDING:
                    if ShardRepo.mark_failed(s, sh.id, error=error):
                        n += 1
            if n:
                s.commit()
            return n

    n = await asyncio.to_thread(_do)
    if n:
        await _aggregator._maybe_finalize_workload(workload_id)
        logger.warning("engine.pin_dead · workload=%s reason=%s shards=%d", workload_id, reason, n)
    return n


async def _fail_if_dead_pin(workload_id, workload, online_ids: set[str]) -> int:
    reason = await _dead_pin_reason_of(workload, online_ids)
    if reason is None:
        return 0
    return await _fail_dead_pin_shards(workload_id, reason)


async def resubmit_waiting_workloads(worker_id: str, owner_id: int) -> None:
    """
    节点上线 hook (注册到 registry.fire_worker_online)

    扫描所有 WAITING_FOR_WORKERS 任务 (跨 owner · 因为新节点能为任何用户跑) ·
    尝试重启 start。
    """
    from platform_v8.storage import db as db_mod

    def _query_waiting():
        with db_mod.session_scope() as s:
            return WorkloadRepo.list_waiting(s, limit=50)

    import asyncio
    waiting = await asyncio.to_thread(_query_waiting)
    if not waiting:
        return

    logger.info("engine.resubmit · worker=%s 上线 · 扫到 %d 个 WAITING workload",
                worker_id, len(waiting))
    for w in waiting:
        # 推回 CREATED · 等下一轮 start 处理 (链路 5)
        def _reset(wid: str):
            with db_mod.session_scope() as s:
                WorkloadRepo.update_status(s, wid, WorkloadStatus.CREATED, error="")
                s.commit()
        await asyncio.to_thread(_reset, w.id)
        await start(w.id)


async def redispatch_pending(workload_id: str) -> dict:
    """M2 · L1 单一权威重派入口。
       多网关下: 非 leader 委派给 leader 执行 (单一大脑驱动重派)。
       leader / 单进程: 本地执行,再套 per-workload 锁串行 + 幂等兜底。
       委派失败 → 本地兜底执行 · gw_multi OFF → 逐字节同旧行为。"""
    import asyncio
    import time

    # Redis locking coordinates gateways, but it cannot coalesce bursts from
    # multiple local callbacks (disconnect, watchdog, and sweeper).  Serialize
    # those callbacks first and suppress only the 100–250ms duplicate window.
    lock = _redispatch_local_locks.get(workload_id)
    if lock is None:
        lock = asyncio.Lock()
        _redispatch_local_locks[workload_id] = lock
    async with lock:
        now = time.monotonic()
        last = _redispatch_last_started.get(workload_id)
        if last is not None and now - last < _REDISPATCH_DEBOUNCE_SECONDS:
            return {"dispatched": 0, "failed": 0, "skipped": "debounced"}
        _redispatch_last_started[workload_id] = now
        return await _redispatch_pending_authorized(workload_id)


async def _redispatch_pending_authorized(workload_id: str) -> dict:
    """Cross-gateway authority and lock layer for a coalesced redispatch."""
    from platform_v8.engine import gateway as _gw
    if _gw.multi_enabled() and not _gw.is_leader_fresh():
        if _gw.publish_leader_job("redispatch", workload_id):
            logger.debug("engine.redispatch · workload=%s 非leader · 委派 leader 执行", workload_id)
            return {"dispatched": 0, "failed": 0, "skipped": "delegated_to_leader"}
        # 委派未发出 → 落到本地兜底执行
    _tok = _gw.acquire_workload_lock(workload_id)
    if _tok is None:
        logger.debug("engine.redispatch · workload=%s 派发锁被其他网关持有 · 跳过", workload_id)
        return {"dispatched": 0, "failed": 0, "skipped": "locked_by_peer"}
    try:
        return await _redispatch_pending_impl(workload_id)
    finally:
        _gw.release_workload_lock(workload_id, _tok)


async def on_shard_completed_redispatch(
    workload_id: str, *, idle_worker_id: str | None = None
) -> dict:
    """分片终态后的实时调度 · api/app.py 订阅 shard.completed 后调用。

    三步 (前两步各由 flag 独立守门 · 关掉后退化为纯重派):
      1) 偷该任务里"已派发但还没开跑"的片   flag nce_work_steal_dispatched
      2) 对仍 RUNNING 的片让空闲节点并行竞速 flag nce_work_race_running
      3) 重派残留 PENDING (始终执行)

    idle_worker_id: 刚交完活、此刻空闲的节点 · 优先把活转给它。
    多网关下非 leader 委派给 leader 执行 · idle_worker_id 经 payload 透传。
    """
    from platform_v8.engine import gateway as _gw
    if _gw.multi_enabled() and not _gw.is_leader_fresh():
        if _gw.publish_leader_job(
            "shard_completed", workload_id,
            payload={"idle_worker_id": idle_worker_id} if idle_worker_id else None,
        ):
            logger.debug("engine.shard_completed · workload=%s 非leader · 委派 leader 执行",
                         workload_id)
            return {"dispatched": 0, "failed": 0, "stolen": 0, "raced": 0,
                    "skipped": "delegated_to_leader"}
        # 委派未发出 (Redis 异常) → 落到本地兜底执行
    _tok = _gw.acquire_workload_lock(workload_id)
    if _tok is None:
        return {"dispatched": 0, "failed": 0, "stolen": 0, "raced": 0,
                "skipped": "locked_by_peer"}
    try:
        stolen = await _steal_dispatched_impl(workload_id, idle_worker_id=idle_worker_id)
        raced = await _race_running_impl(workload_id, idle_worker_id=idle_worker_id)
        report = dict(await _redispatch_pending_impl(workload_id))
        report["stolen"] = stolen
        report["raced"] = raced
        return report
    finally:
        _gw.release_workload_lock(workload_id, _tok)


# ── 工作窃取 · 把"已派发未开跑"的片转给空闲节点 ────────
# grace 存在的意义: 给原节点自己开跑的机会,别刚派过去就抢走。
# 重片 (多页包 / 高派发权重) 拖尾代价大 · grace 收紧,尽快转移。
_STEAL_SINGLE_GRACE_S = 8.0
_STEAL_HEAVY_GRACE_S = 3.0
_STEAL_MAX_PER_EVENT = 8

_RACE_MIN_AGE_S = 2.0
_RACE_HEAVY_MIN_AGE_S = 0.5
_RACE_MAX_PER_EVENT = 4


def _shard_is_heavy(sh) -> bool:
    """重片判定 · 多页分包或高派发权重。"""
    meta = getattr(sh, "metadata", None) or {}
    if not isinstance(meta, dict):
        return False
    try:
        if int(meta.get("page_part_total") or 1) > 1:
            return True
        if int(meta.get("dispatch_weight") or 0) >= 500:
            return True
    except (TypeError, ValueError):
        return False
    return False


def _steal_sort_key(sh):
    """重片优先 → 派发早的优先 → index/id 保证稳定。"""
    return (
        0 if _shard_is_heavy(sh) else 1,
        getattr(sh, "dispatched_at", None) or datetime.min,
        int(getattr(sh, "index", 0) or 0),
        str(sh.id),
    )


def _race_sort_key(sh):
    return (
        0 if _shard_is_heavy(sh) else 1,
        getattr(sh, "started_at", None) or getattr(sh, "dispatched_at", None) or datetime.max,
        int(getattr(sh, "index", 0) or 0),
        str(sh.id),
    )


def select_steal_candidates(
    shards: list,
    *,
    idle_worker_id: str | None = None,
    now: datetime | None = None,
    grace_s: float = _STEAL_SINGLE_GRACE_S,
    max_steal: int = _STEAL_MAX_PER_EVENT,
) -> list:
    """纯函数 · 选出可偷的 DISPATCHED shard (供单测)。

    规则:
      1. 有空闲节点: 其他节点手上的 DISPATCHED 都可抢 · 每片仍需派发满 grace ·
         不动空闲节点自己的队列
      2. 无空闲节点声明: 只拆同节点囤积的多余片 · 最早那片留给原节点
      3. 只碰 DISPATCHED · 不碰 RUNNING/终态 (防同片双跑)
    """
    from collections import defaultdict
    from platform_v8.core import ShardStatus

    now = now or datetime.utcnow()
    idle = str(idle_worker_id) if idle_worker_id else ""
    by_worker: dict[str, list] = defaultdict(list)
    for sh in shards:
        st = sh.status
        st_val = st.value if hasattr(st, "value") else str(st)
        if st_val != ShardStatus.DISPATCHED.value:
            continue
        wid = str(sh.worker_id) if sh.worker_id else ""
        if not wid:
            continue
        by_worker[wid].append(sh)

    candidates: list = []
    for wid, group in by_worker.items():
        group_sorted = sorted(
            group,
            key=lambda s: (
                getattr(s, "dispatched_at", None) or datetime.min,
                int(getattr(s, "index", 0) or 0),
                str(s.id),
            ),
        )
        if idle and wid != idle:
            for sh in group_sorted:
                dispatched_at = getattr(sh, "dispatched_at", None)
                if dispatched_at is None:
                    continue
                need = (
                    min(_STEAL_HEAVY_GRACE_S, grace_s)
                    if _shard_is_heavy(sh) else grace_s
                )
                if (now - dispatched_at).total_seconds() >= need:
                    candidates.append(sh)
        elif len(group_sorted) > 1:
            candidates.extend(group_sorted[1:])

    candidates.sort(key=_steal_sort_key)
    return candidates[: max(0, int(max_steal))]


async def _steal_dispatched_impl(
    workload_id: str, *, idle_worker_id: str | None = None
) -> int:
    """把可偷的 DISPATCHED 片 CAS 回 PENDING · 通知原节点 cancel · 返成功偷取数。"""
    import asyncio
    from platform_v8.engine import broker
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo
    from platform_v8.services.ops import feature_flags as _ff

    try:
        if not _ff.is_enabled("nce_work_steal_dispatched", subject_id=None):
            return 0
    except Exception:
        return 0

    def _load_shards():
        with db_mod.session_scope() as s:
            return ShardRepo.by_workload(s, workload_id)

    shards = await asyncio.to_thread(_load_shards)
    if not shards:
        return 0

    candidates = select_steal_candidates(shards, idle_worker_id=idle_worker_id)
    if not candidates:
        return 0

    stolen = 0
    for sh in candidates:
        old_worker = str(sh.worker_id) if sh.worker_id else None
        shard_id = str(sh.id)

        def _cas(_sid=shard_id, _wid=old_worker) -> bool:
            with db_mod.session_scope() as s:
                ok = ShardRepo.steal_dispatched(s, _sid, expected_worker_id=_wid)
                if ok:
                    s.commit()
                return ok

        if not await asyncio.to_thread(_cas):
            continue
        stolen += 1
        # 回 PENDING 后必须清投递幂等位 · 否则重派给同节点会被误去重 (幻影派发)
        try:
            from platform_v8.engine import delivery as _delivery
            _delivery.release_shard(shard_id)
        except Exception as exc:
            logger.debug("engine.steal · 清幂等位跳过 shard=%s: %s", shard_id, exc)
        if old_worker:
            try:
                await broker.cancel_shard(shard_id, old_worker, reason="work_steal")
            except Exception as exc:
                logger.debug("engine.steal · cancel 推送失败 shard=%s: %s", shard_id, exc)

    if stolen:
        logger.info("engine.steal · workload=%s stolen=%d idle_worker=%s",
                    workload_id, stolen, (idle_worker_id or "")[:8])
    return stolen


def select_race_candidates(
    shards: list,
    *,
    idle_worker_id: str | None = None,
    now: datetime | None = None,
    min_age_s: float = _RACE_MIN_AGE_S,
    max_race: int = _RACE_MAX_PER_EVENT,
) -> list:
    """纯函数 · 选出可让空闲节点并行竞速的 RUNNING 片 (先回传者胜)。

    已在竞速池里的节点不重复加入; 重片放宽 min_age · 尽早并行救拖尾。
    """
    from platform_v8.core import ShardStatus
    from platform_v8.storage.repo import ShardRepo

    if not idle_worker_id:
        return []
    idle = str(idle_worker_id)
    now = now or datetime.utcnow()
    out: list = []
    for sh in shards:
        st = sh.status
        st_val = st.value if hasattr(st, "value") else str(st)
        if st_val != ShardStatus.RUNNING.value:
            continue
        owner = str(sh.worker_id) if sh.worker_id else ""
        if not owner or owner == idle:
            continue
        if idle in ShardRepo.race_workers_of(sh):
            continue
        started = getattr(sh, "started_at", None) or getattr(sh, "dispatched_at", None)
        if started is not None:
            need = (
                min(_RACE_HEAVY_MIN_AGE_S, min_age_s)
                if _shard_is_heavy(sh) else min_age_s
            )
            if (now - started).total_seconds() < need:
                continue
        out.append(sh)
    out.sort(key=_race_sort_key)
    return out[: max(0, int(max_race))]


async def _race_running_impl(
    workload_id: str, *, idle_worker_id: str | None = None
) -> int:
    """空闲节点对同任务 RUNNING 片发起竞速 · 返成功下发的竞速数。"""
    import asyncio
    from platform_v8.engine import broker, planner
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo, WorkloadRepo, WorkerRepo
    from platform_v8.services.ops import feature_flags as _ff

    if not idle_worker_id:
        return 0
    try:
        if not _ff.is_enabled("nce_work_race_running", subject_id=None):
            return 0
    except Exception:
        return 0

    def _load():
        with db_mod.session_scope() as s:
            wl = WorkloadRepo.by_id(s, workload_id)
            shards = ShardRepo.by_workload(s, workload_id) if wl else []
            idle = WorkerRepo.by_id(s, str(idle_worker_id))
            return wl, shards, idle

    wl, shards, idle_w = await asyncio.to_thread(_load)
    if wl is None or idle_w is None:
        return 0
    if not planner.worker_can_run(idle_w, wl):
        return 0

    candidates = select_race_candidates(shards, idle_worker_id=idle_worker_id)
    if not candidates:
        return 0

    raced = 0
    for sh in candidates:
        def _join(_sid=str(sh.id), _wid=str(idle_worker_id)) -> bool:
            with db_mod.session_scope() as s:
                ok = ShardRepo.join_race(s, _sid, _wid)
                if ok:
                    s.commit()
                return ok

        if not await asyncio.to_thread(_join):
            continue

        def _reload(_sid=str(sh.id)):
            with db_mod.session_scope() as s:
                return ShardRepo.by_id(s, _sid)

        fresh = await asyncio.to_thread(_reload)
        if fresh is None:
            continue
        if await broker.dispatch_race_assign(wl, fresh, str(idle_worker_id)):
            raced += 1
        else:
            def _rollback(_sid=str(sh.id), _wid=str(idle_worker_id)):
                with db_mod.session_scope() as s:
                    ShardRepo.drop_race_worker(s, _sid, _wid)
                    s.commit()
            await asyncio.to_thread(_rollback)

    if raced:
        logger.info("engine.race · workload=%s raced=%d idle_worker=%s",
                    workload_id, raced, str(idle_worker_id)[:8])
    return raced


async def _leader_job_dispatch(action: str, workload_id: str, payload: dict | None = None) -> None:
    """leader 收到委派的派发作业 → 本地执行。
       此时 is_leader()=True · start/redispatch 不会再次委派 · 直接走本地锁路径。"""
    if action == "start":
        await start(workload_id)
    elif action == "redispatch":
        await redispatch_pending(workload_id)
    elif action == "shard_completed":
        await on_shard_completed_redispatch(
            workload_id,
            idle_worker_id=(payload or {}).get("idle_worker_id"),
        )
    else:
        logger.warning("engine.leader_job · 未知 action=%s wid=%s", action, workload_id)


async def manual_redispatch_shard(workload_id: str, shard_id: str) -> dict:
    """用户手动「重新派发」单分片。

    流程:
      1. 校验 shard 属本 workload 且处于 DISPATCHED/RUNNING/LEASED/PENDING
      2. 若已绑 worker → 发 cancel + 排除该节点
      3. 写入 preferred_workers = 本任务已 DONE 分片的 worker（优先派给已成功节点）
      4. 重置 PENDING（若尚未）→ redispatch_pending
    """
    import asyncio
    from platform_v8.core import ShardStatus, WorkloadStatus
    from platform_v8.engine import broker
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo, WorkloadRepo

    def _prepare() -> dict:
        with db_mod.session_scope() as s:
            wl = WorkloadRepo.by_id(s, workload_id)
            if wl is None:
                return {"ok": False, "error": "任务不存在", "code": 404}
            st = getattr(wl.status, "value", str(wl.status))
            if st not in (
                WorkloadStatus.RUNNING.value,
                WorkloadStatus.PLANNED.value,
                WorkloadStatus.WAITING_FOR_WORKERS.value,
            ):
                return {"ok": False, "error": f"任务状态 {st} 不可重派", "code": 400}

            sh = ShardRepo.by_id(s, shard_id)
            if sh is None or str(sh.workload_id) != str(workload_id):
                return {"ok": False, "error": "分片不存在", "code": 404}

            sh_st = getattr(sh.status, "value", str(sh.status))
            if sh_st in (
                ShardStatus.DONE.value,
                "SUCCEEDED",
                "COMPLETED",
                ShardStatus.FAILED.value,
                ShardStatus.CANCELLED.value,
            ):
                return {"ok": False, "error": f"分片已终态 ({sh_st})，无法重派", "code": 400}

            old_worker = str(sh.worker_id) if sh.worker_id else ""
            # 本任务已成功节点 → preferred
            all_shards = ShardRepo.by_workload(s, workload_id)
            proven: list[str] = []
            seen: set[str] = set()
            for other in all_shards:
                ost = getattr(other.status, "value", str(other.status))
                if ost not in (ShardStatus.DONE.value, "SUCCEEDED", "COMPLETED"):
                    continue
                wid = str(other.worker_id) if other.worker_id else ""
                if not wid or wid == old_worker or wid in seen:
                    continue
                seen.add(wid)
                proven.append(wid)

            if old_worker:
                try:
                    ShardRepo.add_excluded_worker(s, shard_id, old_worker)
                except Exception:
                    pass
            if proven:
                try:
                    ShardRepo.set_preferred_workers(s, shard_id, proven)
                except Exception:
                    pass

            reset_ok = True
            if sh_st != ShardStatus.PENDING.value:
                reset_ok = ShardRepo.reset_pending(s, shard_id)
            s.commit()
            return {
                "ok": True,
                "old_worker": old_worker or None,
                "preferred": proven,
                "reset": reset_ok,
                "prev_status": sh_st,
            }

    prep = await asyncio.to_thread(_prepare)
    if not prep.get("ok"):
        return prep

    old_worker = prep.get("old_worker")
    if old_worker:
        try:
            await broker.cancel_shard(
                shard_id, str(old_worker), reason="manual_redispatch",
            )
        except Exception as exc:
            logger.debug("manual_redispatch · cancel 旧节点跳过: %s", exc)

    report = await redispatch_pending(workload_id)
    logger.info(
        "engine.manual_redispatch · workload=%s shard=%s old=%s preferred=%s · %s",
        workload_id, str(shard_id)[:8], old_worker, prep.get("preferred"), report,
    )
    return {
        "ok": True,
        "shard_id": shard_id,
        "workload_id": workload_id,
        "excluded_worker": old_worker,
        "preferred_workers": prep.get("preferred") or [],
        "prev_status": prep.get("prev_status"),
        "dispatch": report,
    }


async def _redispatch_pending_impl(workload_id: str) -> dict:
    """
    2026-05-23 · sweeper 用 · 对已有 PENDING shard 重新调度 + 派发

    场景: workload 状态是 RUNNING · 但所有 shard 都被 reset 回 PENDING
    (worker 推送失败 / worker 下线 / push 后 ws 断连)
    不能再走 start() · 因为 start() 会再切片一遍 · 这里只对 PENDING 重派
    """
    import asyncio
    from platform_v8.engine import planner, broker
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo, WorkerRepo
    from platform_v8.core import ShardStatus

    def _load() -> tuple:
        with db_mod.session_scope() as s:
            wl = WorkloadRepo.by_id(s, workload_id)
            if wl is None:
                return None, []
            all_shards = ShardRepo.by_workload(s, workload_id)
            pending = [
                sh for sh in all_shards
                if sh.status == ShardStatus.PENDING and sh.exec_attempts_used() < sh.max_attempts
            ]
            return wl, pending

    wl, pending = await asyncio.to_thread(_load)
    from platform_v8.services.media_profiles import is_media
    if wl is not None and is_media(wl):
        from platform_v8.services.media_channel import start_media
        return await start_media(workload_id)
    if wl is None or not pending:
        return {"dispatched": 0, "failed": 0, "skipped": "no_pending"}
    if (getattr(wl.spec, "params", {}) or {}).get("review_sample_only") is True:
        # Dedicated unpaid audit samples are leased only through their
        # purpose-scoped internal endpoint; the ordinary scheduler must never
        # turn a quarantined sample into a paid worker assignment.
        return {"dispatched": 0, "failed": 0, "skipped": "review_sample_only"}

    # 幂等位清场: 这些 shard 已回 PENDING(需重派) · 清掉旧投递位,
    # 否则重派给同一节点会被误去重 → 幻影派发(标 DISPATCHED 却没真正下发)。
    try:
        from platform_v8.engine import delivery as _delivery
        for _sh in pending:
            _delivery.release_shard(str(_sh.id))
    except Exception as _exc:
        logger.debug("engine.redispatch · 清幂等位跳过: %s", _exc)

    # 2026-06-07 S1-T3 · 与 start() 口径一致 (单一权威):
    #   旧版用 broker.get_online_worker_ids() (本地进程 WS 表) → 多 worker 下重派候选池
    #   ≠ 初次派发候选池, gw_multi 开启时尤甚。统一走 online_worker_ids_for_dispatch()
    #   (M2 Redis 全局在线集 · flag OFF 时降级本地集),并加 nce_trust_ws_online 逻辑。
    online_ids = broker.online_worker_ids_for_dispatch()
    if not online_ids:
        return {"dispatched": 0, "failed": 0, "skipped": "no_online_worker"}

    def _load_workers():
        with db_mod.session_scope() as s:
            from platform_v8.services.ops import feature_flags as _ff
            try:
                trust_ws = _ff.is_enabled("nce_trust_ws_online")
            except Exception:
                trust_ws = False
            workers = []
            for wid in online_ids:
                w = WorkerRepo.by_id(s, wid)
                if w is None:
                    continue
                if trust_ws or w.is_online:
                    workers.append(w)
            return workers

    workers = await asyncio.to_thread(_load_workers)
    if not workers:
        return {"dispatched": 0, "failed": 0, "skipped": "workers_offline_in_db"}

    assignments = planner.schedule_assignments(pending, workers, workload=wl)
    if not assignments:
        n = await _fail_if_dead_pin(workload_id, wl, {str(x) for x in online_ids})
        if n:
            return {"dispatched": 0, "failed": n, "skipped": "pin_dead"}
        return {"dispatched": 0, "failed": 0, "skipped": "no_match"}

    report = await broker.dispatch_assignments(wl, pending, assignments)
    logger.info("engine.redispatch · workload=%s pending=%d · %s",
                workload_id, len(pending), report)
    return report


async def _fail_exhausted_pending(workload_id) -> int:
    """把 workload 下「PENDING 且 attempts 已用尽」的 shard 标 FAILED,返回标记数。

    2026-06-24 · 修复永久卡 RUNNING/PLANNED 不退款:
      shard 被 reclaim/sweeper 反复打回 PENDING,attempts 累加到 max 后 redispatch 会过滤掉它
      (只派 attempts<max),于是永远 PENDING、workload 永远不终态、escrow 永不退款。
      此处兜底:对用尽的 shard 直接 FAILED,后续 _maybe_finalize_workload 即可走 FAILED+refund。
    """
    import asyncio
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo
    from platform_v8.core import ShardStatus

    def _do() -> int:
        with db_mod.session_scope() as s:
            shards = ShardRepo.by_workload(s, workload_id)
            n = 0
            for sh in shards:
                if sh.status == ShardStatus.PENDING and sh.exec_attempts_used() >= sh.max_attempts:
                    if ShardRepo.mark_failed(s, sh.id, error="重试次数用尽 · 反复失败/无可用节点"):
                        n += 1
            if n:
                s.commit()
            return n

    return await asyncio.to_thread(_do)


async def cleanup_orphaned_result_artifacts(limit: int = 100) -> dict[str, int]:
    """Delete only server-issued artifacts invalidated by a retry/reset.

    Objects are queued in shard metadata by ``_clear_attempt_bindings`` and
    kept for five minutes before deletion.  This avoids touching inputs,
    accepted results, or arbitrary bucket keys without a migration.
    """
    import asyncio
    import time
    from sqlalchemy import select, update
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import shards_t
    from platform_v8.services.oss_provider import get_oss_provider

    now = int(time.time())

    def _load() -> list[tuple[str, dict, list[str]]]:
        with db_mod.session_scope() as s:
            rows = s.execute(select(shards_t.c.id, shards_t.c.metadata).limit(limit)).all()
            selected: list[tuple[str, dict, list[str]]] = []
            for row in rows:
                metadata = dict(row.metadata or {})
                keys = [
                    str(item.get("object_key"))
                    for item in (metadata.get("orphaned_result_artifacts") or [])
                    if isinstance(item, dict)
                    and int(item.get("not_before") or 0) <= now
                    and str(item.get("object_key") or "").startswith("v8/account-")
                    and "/result/" in str(item.get("object_key") or "")
                ]
                if keys:
                    selected.append((str(row.id), metadata, keys))
            return selected

    candidates = await asyncio.to_thread(_load)
    deleted = 0
    for shard_id, metadata, keys in candidates:
        deleted_keys: set[str] = set()
        for object_key in keys:
            try:
                if await asyncio.to_thread(get_oss_provider().delete_object, object_key):
                    deleted_keys.add(object_key)
                    deleted += 1
            except Exception as exc:
                logger.warning(
                    "lifecycle.artifact_cleanup · shard=%s key=%s failed: %s",
                    shard_id, object_key[:80], exc,
                )
        if not deleted_keys:
            continue

        def _remove_queued_keys() -> None:
            with db_mod.session_scope() as s:
                remaining = [
                    item for item in (metadata.get("orphaned_result_artifacts") or [])
                    if not isinstance(item, dict)
                    or str(item.get("object_key") or "") not in deleted_keys
                ]
                metadata["orphaned_result_artifacts"] = remaining
                s.execute(
                    update(shards_t).where(shards_t.c.id == shard_id).values(metadata=metadata)
                )
                s.commit()

        await asyncio.to_thread(_remove_queued_keys)
    return {"deleted": deleted, "candidates": len(candidates)}


def _as_naive_utc(dt: datetime | None) -> datetime | None:
    """把 DB 取回的时间戳统一成 naive UTC。

    同一列在不同写入路径下可能是 naive (datetime.utcnow) 也可能是 aware
    (datetime.now(timezone.utc))，两者在 Python 里直接比较会 TypeError。
    本模块的 cutoff 一律用 utcnow() 生成，所以统一往 naive UTC 收。
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _active_reclaim_reason(
    row,
    workload,
    *,
    online_set: set[str],
    now: datetime,
) -> str | None:
    """纯判定函数 · 不读写 DB，便于固定时钟覆盖边界。"""
    from platform_v8.core import ShardStatus
    from platform_v8.engine.effective_task import (
        soft_reclaim_dispatched_horizon_s,
        soft_reclaim_running_horizon_s,
    )

    status = getattr(row.status, "value", row.status)
    status = str(status or "")
    if status == ShardStatus.LEASED.value:
        worker_id = str(
            getattr(row, "lease_by_node", None)
            or getattr(row, "worker_id", None)
            or ""
        )
    else:
        worker_id = str(
            getattr(row, "worker_id", None)
            or getattr(row, "lease_by_node", None)
            or ""
        )
    if not worker_id or worker_id not in online_set:
        return "WORKER_OFFLINE"
    if workload is None:
        return None

    now_naive = _as_naive_utc(now) or datetime.utcnow()
    lease_expires = _as_naive_utc(
        getattr(row, "lease_expires_at", None)
    )
    if status in (ShardStatus.LEASED.value, ShardStatus.RUNNING.value):
        if lease_expires is not None:
            return None if lease_expires > now_naive else "EXPIRED_LEASE"

    if status == ShardStatus.DISPATCHED.value:
        anchor = _as_naive_utc(getattr(row, "dispatched_at", None))
        if anchor is None:
            return None
        horizon = soft_reclaim_dispatched_horizon_s(workload, row)
        return (
            "STALE_DISPATCHED"
            if (now_naive - anchor).total_seconds() >= horizon
            else None
        )

    if status == ShardStatus.LEASED.value:
        # 历史异常行没有 lease_expires_at 时按派发阶段兜底。
        anchor = _as_naive_utc(getattr(row, "dispatched_at", None))
        if anchor is None:
            return None
        horizon = soft_reclaim_dispatched_horizon_s(workload, row)
        return (
            "STALE_LEASED"
            if (now_naive - anchor).total_seconds() >= horizon
            else None
        )

    if status == ShardStatus.RUNNING.value:
        anchors = [
            _as_naive_utc(getattr(row, name, None))
            for name in ("progress_at", "started_at", "dispatched_at")
        ]
        anchor = max((value for value in anchors if value is not None), default=None)
        if anchor is None:
            return None
        horizon = soft_reclaim_running_horizon_s(workload, row)
        return (
            "STALE_RUNNING"
            if (now_naive - anchor).total_seconds() >= horizon
            else None
        )
    return None


def _reset_stale_active_shards(
    *,
    online_set: set[str],
    now: datetime | None = None,
    limit: int = 300,
) -> tuple[int, list[str]]:
    """扫描并 CAS 回收 stale active shard；由 async 调用方放入线程。"""
    from sqlalchemy import select
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo, WorkloadRepo, shards_t

    scan_now = now or datetime.utcnow()
    with db_mod.session_scope() as s:
        rows = s.execute(
            select(
                shards_t.c.id,
                shards_t.c.worker_id,
                shards_t.c.lease_by_node,
                shards_t.c.lease_expires_at,
                shards_t.c.attempts,
                shards_t.c.status,
                shards_t.c.dispatched_at,
                shards_t.c.started_at,
                shards_t.c.progress_at,
                shards_t.c.metadata,
                shards_t.c.workload_id,
            )
            .where(
                shards_t.c.status.in_(["DISPATCHED", "LEASED", "RUNNING"]),
            )
            .limit(min(max(1, int(limit)), 300))
        ).all()
        workloads: dict[str, object | None] = {}
        reset_n = 0
        touched_wl: set[str] = set()
        for row in rows:
            workload_id = str(row.workload_id or "")
            if workload_id not in workloads:
                workloads[workload_id] = (
                    WorkloadRepo.by_id(s, workload_id) if workload_id else None
                )
            reason = _active_reclaim_reason(
                row,
                workloads[workload_id],
                online_set=online_set,
                now=scan_now,
            )
            if reason is None:
                continue
            owner = (
                row.lease_by_node or row.worker_id
                if str(row.status) == "LEASED"
                else row.worker_id or row.lease_by_node
            )
            worker_id = str(owner or "")
            if not ShardRepo.reclaim_active_if_unchanged(
                s,
                row.id,
                expected_status=str(row.status),
                expected_worker_id=worker_id or None,
                expected_attempt=int(row.attempts),
                expected_progress_at=row.progress_at,
                expected_lease_expires_at=row.lease_expires_at,
            ):
                continue
            record_lifecycle_event(
                "reclaim",
                workload_id=row.workload_id,
                shard_id=row.id,
                worker_id=worker_id or None,
                attempt=int(row.attempts),
                reason_code=reason,
                outcome="reclaimed",
            )
            if worker_id:
                try:
                    ShardRepo.add_excluded_worker(s, row.id, worker_id)
                except Exception:
                    pass
            reset_n += 1
            if workload_id:
                touched_wl.add(workload_id)
        s.commit()
        return reset_n, list(touched_wl)


async def sweep_stuck_workloads() -> dict:
    """
    2026-05-23 · 周期 sweeper · 修复 stuck workload

    场景:
      1. CREATED 超 60s 未推进 → 调 start() 重新切片+派发
      2. WAITING_FOR_WORKERS 任意时长 + 有在线 worker → 调 start() 重试
      2b. PLANNED 超 60s (切片后/派发前崩溃) → 推 RUNNING + redispatch_pending  [2026-06-24]
      3. RUNNING 但没任何 DISPATCHED/RUNNING shard 且有 PENDING → redispatch_pending
      4. RUNNING/PLANNED 且 PENDING shard attempts 都到顶 → mark FAILED + finalize(退款)  [2026-06-24 已实现]
    """
    import asyncio
    from datetime import datetime, timedelta
    from sqlalchemy import select
    from platform_v8.engine import broker
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo, workloads_t

    stats = {"created_resumed": 0, "waiting_resumed": 0,
             "planned_resumed": 0,  # 2026-06-24 · PLANNED 卡死恢复
             "running_redispatched": 0, "stale_dispatched_reset": 0,
             "expired_leases_reaped": 0,  # W1-6 · PULL 模式 lease 超时
             "exhausted_failed": 0,  # 2026-06-24 · 重试用尽 → FAILED+refund
             "pin_dead_failed": 0,  # 纠-14 · pin 到缺失/长期离线
             "finalized_reconciled": 0,
             "orphaned_artifacts_deleted": 0}  # 2026-06-11 · 全 shard 终态但 workload 未 finalize 的兜底

    online_worker_count = len(broker.online_worker_ids_for_dispatch())
    if online_worker_count == 0:
        # 无在线节点时所有 active owner 均离线，仍需立即 CAS 回收；
        # 仅跳过后续派发，不能让分片挂到下一次有节点上线。
        try:
            reset_n, _ = await asyncio.to_thread(
                _reset_stale_active_shards, online_set=set()
            )
            stats["stale_dispatched_reset"] = reset_n
        except Exception as exc:
            logger.warning("sweep.offline_shard_reclaim · err=%s", exc)
        # Storage cleanup does not depend on an online worker.
        try:
            cleanup = await cleanup_orphaned_result_artifacts()
            stats["orphaned_artifacts_deleted"] = cleanup["deleted"]
        except Exception as exc:
            logger.warning("sweep.artifact_cleanup · err=%s", exc)
        # 没在线节点不做任何调度 (避免 WAITING 状态污染)
        return stats

    # ── 1. CREATED 超 60s ──────────────────────────────
    # 若 workload 已经有 shard (历史遗留 · start() 卡半截) · 走 redispatch_pending
    # 否则正常走 start() 切片
    cutoff = datetime.utcnow() - timedelta(seconds=60)

    def _fetch_stuck_created() -> list[tuple]:
        """返 [(workload_id, shard_count), ...]"""
        with db_mod.session_scope() as s:
            rows = s.execute(
                select(workloads_t.c.id).where(
                    workloads_t.c.status == WorkloadStatus.CREATED.value,
                    workloads_t.c.created_at < cutoff,
                ).limit(50)
            ).all()
            ret = []
            for r in rows:
                cnt = ShardRepo.count_by_status(s, r.id)
                ret.append((r.id, sum(cnt.values())))
            return ret

    for wid, shard_count in await asyncio.to_thread(_fetch_stuck_created):
        try:
            if shard_count > 0:
                # 已有 shard · 走 redispatch (start 会触发 unique violation)
                # 先把 workload 推到 RUNNING 状态 · 让 redispatch_pending 接管
                def _to_running(wid_: str):
                    with db_mod.session_scope() as s:
                        WorkloadRepo.update_status(s, wid_, WorkloadStatus.RUNNING, error="")
                        s.commit()
                await asyncio.to_thread(_to_running, wid)
                r = await redispatch_pending(wid)
                if r.get("dispatched", 0) > 0:
                    stats["created_resumed"] += 1
            else:
                await start(wid)
                stats["created_resumed"] += 1
        except Exception as exc:
            logger.warning("sweep.created_resume · workload=%s err=%s", wid, exc)

    # ── 2. WAITING_FOR_WORKERS ──────────────────────────
    def _fetch_waiting() -> list[str]:
        with db_mod.session_scope() as s:
            rows = s.execute(
                select(workloads_t.c.id).where(
                    workloads_t.c.status == WorkloadStatus.WAITING_FOR_WORKERS.value
                ).limit(50)
            ).all()
            return [r.id for r in rows]

    for wid in await asyncio.to_thread(_fetch_waiting):
        try:
            # 推回 CREATED 让 start() 处理
            def _reset(wid_: str):
                with db_mod.session_scope() as s:
                    WorkloadRepo.update_status(s, wid_, WorkloadStatus.CREATED, error="")
                    s.commit()
            await asyncio.to_thread(_reset, wid)
            await start(wid)
            stats["waiting_resumed"] += 1
        except Exception as exc:
            logger.warning("sweep.waiting_resume · workload=%s err=%s", wid, exc)

    # ── 2b. PLANNED 卡死 (切片后、派发前进程崩溃 → 永久 PLANNED · 之前无人扫) ──
    #   shard 已建为 PENDING,直接推 RUNNING + redispatch_pending 接管;
    #   若 PENDING 都已 attempts 用尽则 FAILED+finalize 退款。
    from platform_v8.engine import aggregator as _agg_planned

    def _fetch_stuck_planned() -> list[str]:
        with db_mod.session_scope() as s:
            rows = s.execute(
                select(workloads_t.c.id).where(
                    workloads_t.c.status == WorkloadStatus.PLANNED.value,
                    workloads_t.c.created_at < cutoff,
                ).limit(50)
            ).all()
            return [r.id for r in rows]

    for wid in await asyncio.to_thread(_fetch_stuck_planned):
        try:
            def _to_running(wid_: str):
                with db_mod.session_scope() as s:
                    WorkloadRepo.update_status(s, wid_, WorkloadStatus.RUNNING, error="")
                    s.commit()
            await asyncio.to_thread(_to_running, wid)
            r = await redispatch_pending(wid)
            if r.get("dispatched", 0) > 0:
                stats["planned_resumed"] += 1
            else:
                failed_n = await _fail_exhausted_pending(wid)
                if failed_n > 0:
                    await _agg_planned._maybe_finalize_workload(wid)
                    stats["exhausted_failed"] += failed_n
        except Exception as exc:
            logger.warning("sweep.planned_resume · workload=%s err=%s", wid, exc)

    # ── 3a. active shard 按有效 task timeout 软回收 ───────────────────
    # 离线立即回收；在线 PULL 运行租约优先；无租约按最近可信进度判断。
    online_set = set(broker.online_worker_ids_for_dispatch())
    reset_n, touched = await asyncio.to_thread(
        _reset_stale_active_shards, online_set=online_set
    )
    stats["stale_dispatched_reset"] = reset_n
    for wid in touched:
        try:
            r = await redispatch_pending(wid)
            if r.get("dispatched", 0) > 0:
                stats["running_redispatched"] += 1
        except Exception as exc:
            logger.warning("sweep.stale_shard_redispatch · workload=%s err=%s", wid, exc)

    # ── W1-6 (2026-05-26) · PULL 模式动态 lease 超时 reaper ────
    def _reap_expired():
        with db_mod.session_scope() as s:
            n = ShardRepo.reap_expired_leases(s, limit=200)
            if n > 0:
                s.commit()
            return n

    try:
        expired_n = await asyncio.to_thread(_reap_expired)
        stats["expired_leases_reaped"] = expired_n
    except Exception as exc:
        logger.warning("sweep.reap_expired_leases · err=%s", exc)

    # ── 3b. RUNNING 卡 PENDING / 漏 finalize ────────────────
    #   2026-08-04: pending>0 且 (无 active 或存在空闲在线节点) → 补派
    #   旧条件仅 active==0：别处还有 RUNNING 时空闲机干等。
    def _fetch_stuck_running() -> list[tuple]:
        from platform_v8.engine import broker as _broker
        online_ids = set(_broker.online_worker_ids_for_dispatch() or [])
        with db_mod.session_scope() as s:
            rows = s.execute(
                select(workloads_t.c.id).where(
                    workloads_t.c.status == WorkloadStatus.RUNNING.value
                ).limit(200)
            ).all()
            wl_ids = [r.id for r in rows]
            idle_online = False
            if online_ids:
                for oid in online_ids:
                    try:
                        act = ShardRepo.by_worker_active(s, oid) or []
                    except Exception:
                        act = []
                    if not act:
                        idle_online = True
                        break
            stuck = []
            for wid in wl_ids:
                counts = ShardRepo.count_by_status(s, wid)
                active = counts.get("DISPATCHED", 0) + counts.get("RUNNING", 0)
                pending = counts.get("PENDING", 0)
                total = sum(counts.values())
                if pending > 0 and (active == 0 or idle_online):
                    stuck.append((wid, "redispatch"))
                elif active == 0 and pending == 0 and total > 0:
                    stuck.append((wid, "finalize"))
            return stuck

    from platform_v8.engine import aggregator as _aggregator
    for wid, action in await asyncio.to_thread(_fetch_stuck_running):
        try:
            if action == "finalize":
                await _aggregator._maybe_finalize_workload(wid)
                stats["finalized_reconciled"] += 1
                logger.info("sweep.finalize_reconcile · workload=%s 全 shard 终态 · 兜底 finalize", wid)
            else:
                r = await redispatch_pending(wid)
                if r.get("dispatched", 0) > 0:
                    stats["running_redispatched"] += 1
                elif r.get("skipped") == "pin_dead":
                    stats["pin_dead_failed"] += int(r.get("failed") or 0)
                else:
                    # 一片都没派出去:可能 PENDING 全 attempts 用尽 → 标 FAILED + finalize 退款,
                    # 否则 workload 永久卡 RUNNING、escrow 永不释放。
                    failed_n = await _fail_exhausted_pending(wid)
                    if failed_n > 0:
                        await _aggregator._maybe_finalize_workload(wid)
                        stats["exhausted_failed"] += failed_n
        except Exception as exc:
            logger.warning("sweep.running_reconcile · workload=%s action=%s err=%s", wid, action, exc)

    # ── 3c. AGGREGATING 卡死 (聚合/post_process 中途崩溃 → 永久 AGGREGATING) ──[2026-06-24]
    #   _finalize_done 进聚合时置 AGGREGATING;若中途崩溃则永远停在此态。
    #   超 10 分钟未推进 → 兜底重跑 finalize(幂等:reward/refund 有幂等键)。
    agg_cutoff = datetime.utcnow() - timedelta(minutes=10)

    def _fetch_stuck_aggregating() -> list[str]:
        with db_mod.session_scope() as s:
            rows = s.execute(
                select(workloads_t.c.id).where(
                    workloads_t.c.status == WorkloadStatus.AGGREGATING.value,
                    workloads_t.c.updated_at < agg_cutoff,
                ).limit(100)
            ).all()
            return [r.id for r in rows]

    for wid in await asyncio.to_thread(_fetch_stuck_aggregating):
        try:
            await _aggregator._maybe_finalize_workload(wid)
            stats["finalized_reconciled"] += 1
            logger.info("sweep.aggregating_reconcile · workload=%s 卡 AGGREGATING · 兜底重 finalize", wid)
        except Exception as exc:
            logger.warning("sweep.aggregating_reconcile · workload=%s err=%s", wid, exc)

    try:
        cleanup = await cleanup_orphaned_result_artifacts()
        stats["orphaned_artifacts_deleted"] = cleanup["deleted"]
    except Exception as exc:
        logger.warning("sweep.artifact_cleanup · err=%s", exc)

    if any(stats.values()):
        logger.info("engine.sweep · stats=%s online_workers=%d",
                    stats, online_worker_count)
    return stats


async def _sweeper_loop(interval_s: int = 30) -> None:
    """sweeper 后台循环 (app lifespan 启动)"""
    import asyncio
    logger.info("engine.sweeper · 启动 · interval=%ds", interval_s)
    while True:
        # M1 · 先把进程内心跳缓冲批量回写 PG (flag hb_via_redis ON 时才有数据 · 否则 no-op)
        # 放最前 + 独立 try · 保证即使 sweep 抛错也不丢心跳回写
        # 心跳批量回写是"每进程各刷自己缓冲" · 不能 leader 单例 · 永远跑
        try:
            from platform_v8.services.workers import heartbeat as _hb
            n = await asyncio.to_thread(_hb.flush_hb_buffer)
            if n:
                logger.debug("engine.sweeper · 心跳批量回写 %d 节点", n)
        except Exception as exc:
            logger.warning("engine.sweeper · 心跳回写异常 (继续): %s", exc)
        # 派发驱动(stuck workload 重扫)是全局动作 · M2 多进程下仅 leader 跑 (防 N 份重复扫)
        try:
            from platform_v8.engine import gateway as _gw
            run_sweep = _gw.should_run_singleton()
        except Exception:
            run_sweep = True
        if run_sweep:
            try:
                await sweep_stuck_workloads()
            except Exception as exc:
                logger.exception("engine.sweeper · 异常 (继续轮询): %s", exc)
        await asyncio.sleep(interval_s)


# M2 横扩 · 跨进程"丢帧"快速召回 (送达确认 reaper)
DELIV_CONFIRM_TIMEOUT_S = 15   # 派发后 N 秒仍未确认送达节点 socket → 判丢帧
DELIV_REAPER_INTERVAL_S = 6    # 召回轮询周期


async def reap_unconfirmed_dispatched() -> dict:
    """把"已派发但未确认送达节点 socket"的分片快速召回重派(根治跨进程 route_push 丢帧)。
       仅多网关有意义(单进程本地直发恒确认)。判据:
         status=DISPATCHED 且 dispatched_at < now-DELIV_CONFIRM_TIMEOUT_S 且 无送达确认。
       动作: reset PENDING + 清幂等位 + 重派 workload。
       安全: confirm 标记保守失败时返 True(不误判);即便误召回, shard_id 幂等让重派对节点无害。
       把丢帧恢复从 watchdog 的 ~timeout_s+30(≈90s)缩到 ~CONFIRM_TIMEOUT+INTERVAL(≈20s)。"""
    import asyncio
    from datetime import datetime, timedelta
    from sqlalchemy import select
    from platform_v8.engine import broker, delivery
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo, shards_t

    try:
        from platform_v8.engine import gateway as _gw
        if not _gw.multi_enabled():
            return {"reaped": 0}
    except Exception:
        return {"reaped": 0}

    if not broker.online_worker_ids_for_dispatch():
        return {"reaped": 0}

    cutoff = datetime.utcnow() - timedelta(seconds=DELIV_CONFIRM_TIMEOUT_S)

    def _fetch() -> list[tuple]:
        with db_mod.session_scope() as s:
            rows = s.execute(
                select(shards_t.c.id, shards_t.c.workload_id).where(
                    shards_t.c.status == "DISPATCHED",
                    shards_t.c.dispatched_at < cutoff,
                ).limit(200)
            ).all()
            return [(r.id, r.workload_id) for r in rows]

    candidates = await asyncio.to_thread(_fetch)
    if not candidates:
        return {"reaped": 0}

    reaped = 0
    reaped_wls: set[str] = set()
    for sid, wid in candidates:
        if delivery.is_confirmed(str(sid)):
            continue  # 已送达节点 socket · 正常在跑 · 不动

        def _reset(_sid=sid) -> bool:
            with db_mod.session_scope() as s:
                ok = ShardRepo.reset_pending(s, _sid)
                if ok:
                    s.commit()
                return bool(ok)

        try:
            if await asyncio.to_thread(_reset):
                delivery.release_shard(str(sid))
                record_lifecycle_event(
                    "reclaim",
                    workload_id=wid,
                    shard_id=sid,
                    reason_code="UNCONFIRMED_DELIVERY",
                    outcome="reclaimed",
                )
                reaped += 1
                if wid:
                    reaped_wls.add(wid)
        except Exception as exc:
            logger.debug("deliv_reaper · reset shard=%s err=%s", sid, exc)

    for wid in reaped_wls:
        try:
            await redispatch_pending(wid)
        except Exception as exc:
            logger.warning("deliv_reaper · redispatch wid=%s err=%s", wid, exc)

    if reaped:
        logger.info("engine.deliv_reaper · 召回未确认丢帧分片=%d workloads=%d",
                    reaped, len(reaped_wls))
    return {"reaped": reaped}


async def _delivery_reaper_loop(interval_s: int = DELIV_REAPER_INTERVAL_S) -> None:
    """送达确认 reaper 后台循环 · 仅 leader 跑(防 N 份重复召回)。
       gw_multi OFF → reap_unconfirmed_dispatched 直接 no-op · 零开销。"""
    import asyncio
    logger.info("engine.deliv_reaper · 启动 · interval=%ds timeout=%ds",
                interval_s, DELIV_CONFIRM_TIMEOUT_S)
    while True:
        try:
            from platform_v8.engine import gateway as _gw
            run = _gw.should_run_singleton()
        except Exception:
            run = True
        if run:
            try:
                await reap_unconfirmed_dispatched()
            except Exception as exc:
                logger.exception("engine.deliv_reaper · 异常 (继续轮询): %s", exc)
        await asyncio.sleep(interval_s)


async def reap_stale_workers(ttl_seconds: int = 60) -> dict:
    """
    2026-05-25 · 心跳超时 reaper · 把超过 ttl_seconds 没心跳的 worker 标 OFFLINE

    场景:
      1. API 进程重启 / 崩溃 → WS 清理未执行时，DB 状态由本回收器更新
      2. 节点 ws 半死(TCP 没断但卡住) → 心跳超时 ws.receive_text 也卡住
      3. NAT / nginx upstream 切换导致 ws frame 丢但 socket 还在

    动作:
      - 查 status in (ONLINE, BUSY) AND last_seen < now - ttl 的 worker
      - 条件更新 status = OFFLINE，保护扫描后重连的节点
      - WS 自行按连接代际和心跳超时关闭，避免误关新会话
      - 写审计 + 推 worker.offline 事件 (UI 即时刷新)
    """
    import asyncio
    from datetime import datetime, timedelta
    from sqlalchemy import select, update
    from platform_v8.core import WorkerStatus, AuditAction
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import workers_t, AuditRepo

    def _do() -> list[tuple[str, int]]:
        """返 [(worker_id, owner_id), ...]"""
        cutoff = datetime.utcnow() - timedelta(seconds=ttl_seconds)
        with db_mod.session_scope() as s:
            rows = s.execute(
                select(workers_t.c.id, workers_t.c.owner_id).where(
                    workers_t.c.status.in_(["ONLINE", "BUSY"]),
                    workers_t.c.last_seen < cutoff,
                ).limit(500)
            ).all()
            if not rows:
                return []
            stale = []
            for row in rows:
                # A heartbeat/reconnect can arrive after SELECT. Preserve it
                # with an atomic predicate on the actual status update.
                changed = s.execute(
                    update(workers_t)
                    .where(workers_t.c.id == row.id)
                    .where(workers_t.c.status.in_(["ONLINE", "BUSY"]))
                    .where(workers_t.c.last_seen < cutoff)
                    .values(status=WorkerStatus.OFFLINE.value)
                )
                if changed.rowcount:
                    stale.append((str(row.id), int(row.owner_id)))
            for wid, oid in stale:
                try:
                    AuditRepo.write(
                        s, action=AuditAction.WORKER_OFFLINE,
                        actor_account_id=oid, actor_kind="reaper",
                        target_kind="worker", target_id=wid,
                        detail={"reason": "heartbeat_timeout",
                                "ttl_seconds": ttl_seconds},
                    )
                except Exception as exc:
                    logger.debug("reaper · audit write fail (silent): %s", exc)
            s.commit()
            return stale

    stale = await asyncio.to_thread(_do)
    if not stale:
        return {"reaped": 0}

    # Remove only stale online scores. ZREM by worker ID here could delete a
    # fresh reconnect that heartbeats after the DB commit.
    try:
        from platform_v8.storage import kv as kv_mod
        r = kv_mod.get_redis()
        if r is not None and stale:
            r.zremrangebyscore("v8:worker:hb", "-inf", (datetime.utcnow() - timedelta(seconds=ttl_seconds)).timestamp())
    except Exception as exc:
        logger.debug("reaper · ZSET ZREM 失败 (静默): %s", exc)

    # The WS loop has its own heartbeat timeout and closes its exact socket.
    # Looking up a broker session here after the DB commit could select and
    # forcibly close a new connection that registered during this interval.

    # 推 worker.offline 事件 (企业端/admin 即时刷新)
    try:
        from platform_v8.api.v8.events import publish_event_sync
        for wid, oid in stale:
            try:
                publish_event_sync("worker.offline", {
                    "worker_id": wid,
                    "owner_id": oid,
                    "reason": "heartbeat_timeout",
                }, owner_id=oid)
            except Exception:
                pass
    except Exception:
        pass

    # registry 缓存失效 (planner 下次取最新 worker 列表)
    try:
        from platform_v8.engine import registry as registry_mod
        for _wid, oid in stale:
            try:
                registry_mod.invalidate_cache(owner_id=oid)
            except Exception:
                pass
    except Exception:
        pass

    logger.info("engine.heartbeat_reaper · %d 个 worker 心跳超时 → OFFLINE (TTL=%ds) ids=%s",
                len(stale), ttl_seconds, [w[0][:8] for w in stale])
    return {"reaped": len(stale), "worker_ids": [w[0] for w in stale]}


async def _heartbeat_reaper_loop(interval_s: int = 30, ttl_seconds: int = 60) -> None:
    """
    2026-05-25 · 心跳超时 reaper 后台循环 (app lifespan 启动)

    interval_s: 扫描周期 (默认 30s · 节点 hb 15s 一次 · 60s 没收即超时)
    ttl_seconds: 心跳 TTL (默认 60s · 与 ws.HB_TIMEOUT_S=120 配合 · 60s reaper 更激进)
    """
    import asyncio
    logger.info("engine.heartbeat_reaper · 启动 · interval=%ds ttl=%ds",
                interval_s, ttl_seconds)
    # 启动后立即跑一次 (处理进程重启留下的 stale ONLINE)
    await asyncio.sleep(5)
    while True:
        # reaper 基于全局 PG last_seen · M2 多进程下仅 leader 跑 (防 N 个 reaper 重复标记)
        try:
            from platform_v8.engine import gateway as _gw
            run_reap = _gw.should_run_singleton()
        except Exception:
            run_reap = True
        if run_reap:
            try:
                await reap_stale_workers(ttl_seconds=ttl_seconds)
            except Exception as exc:
                logger.exception("engine.heartbeat_reaper · 异常 (继续轮询): %s", exc)
        await asyncio.sleep(interval_s)


async def _lease_reaper_loop(interval_s: int = 30) -> None:
    """2026-08 · 租约回收后台循环 · 回收过期lease的shard → PENDING"""
    import asyncio as _aloop
    logger.info("engine.lease_reaper · 启动 · interval=%ds", interval_s)
    await _aloop.sleep(10)
    while True:
        try:
            result = await sweep_expired_leases()
            if result.get("reclaimed", 0) > 0:
                logger.info("engine.lease_reaper · 本轮回收 %d 个过期租约", result["reclaimed"])
        except Exception:
            logger.exception("engine.lease_reaper · 异常 (继续轮询)")
        await _aloop.sleep(interval_s)


async def evaluate_hw_score_on_online(worker_id: str, owner_id: int) -> None:
    """
    2026-05-25 NCE P2 · 节点上线 hook · 自动算 hw_score + 写 history (trigger=onboard)

    fail-safe: 任何异常吞掉 · 不能阻塞 ws / 派单
    去重: 同节点 30 分钟内已评分 · 跳过 (heartbeat 频繁连接不重算)
    """
    import asyncio
    try:
        from platform_v8.services.economy import hw_scoring
        from platform_v8.storage import db as db_mod
        from platform_v8.storage.repo import WorkerRepo
        from datetime import datetime, timedelta, timezone

        def _do():
            with db_mod.session_scope() as s:
                worker = WorkerRepo.by_id(s, worker_id)
                if worker is None:
                    return None
                # 去重: 30 分钟内评过 · 跳过
                if worker.capabilities is None:
                    return "no_caps"
                # 用 row 直查 evaluated_at
                from sqlalchemy import text
                row = s.execute(
                    text("SELECT hw_evaluated_at FROM we_workers WHERE id = CAST(:wid AS uuid)"),
                    {"wid": worker_id},
                ).fetchone()
                if row and row[0]:
                    evaluated_at = row[0]
                    if evaluated_at.tzinfo is None:
                        evaluated_at = evaluated_at.replace(tzinfo=timezone.utc)
                    if (datetime.now(timezone.utc) - evaluated_at) < timedelta(minutes=30):
                        return "skip_recent"

                # 评分 + 持久化
                result = hw_scoring.evaluate(worker.capabilities)
                cap_snap = {
                    "cpu_brand": getattr(worker.capabilities, "cpu_brand", ""),
                    "cpu_cores": getattr(worker.capabilities, "cpu_cores", 0),
                    "total_memory_mb": getattr(worker.capabilities, "total_memory_mb", 0),
                    "gpu_model": getattr(worker.capabilities, "gpu_model", ""),
                    "gpu_count": getattr(worker.capabilities, "gpu_count", 0),
                    "vram_mb": getattr(worker.capabilities, "vram_mb", 0),
                }
                hw_scoring.persist_score(
                    worker_id, result, trigger="onboard",
                    capabilities_snapshot=cap_snap, session=s,
                )
                s.commit()
                return f"{result.hw_tier}/{result.hw_score}"

        ret = await asyncio.to_thread(_do)
        if ret and ret not in ("skip_recent", "no_caps"):
            logger.info("hw_score.onboard · worker=%s → %s", worker_id, ret)
    except Exception as exc:
        logger.warning("hw_score.onboard fail (silent) · worker=%s err=%s", worker_id, exc)


async def _rep_score_cron_loop(interval_s: int = 86400) -> None:
    """
    NCE P3 · 每日重算所有在线节点 4 子分 + 调和平均主分
    
    跑法 (api/app.py lifespan):
        asyncio.create_task(lifecycle._rep_score_cron_loop())
    
    flag nce_rep_multi_dim_cron 控 · 默认 OFF · 启用后才跑
    """
    import asyncio
    logger.info("rep_score.cron · 启动 · interval=%ds", interval_s)
    await asyncio.sleep(90)  # 启动后 90s 再跑首次 (跟 hw_score cron 错开)
    while True:
        try:
            from platform_v8.services.ops import feature_flags as ff
            if ff.is_enabled("nce_rep_multi_dim_cron"):
                from platform_v8.services.economy import rep_scoring
                def _do():
                    return rep_scoring.recompute_all(
                        only_online=True, trigger="cron", dry_run=False,
                    )
                result = await asyncio.to_thread(_do)
                logger.info("rep_score.cron · 跑完 · total=%d updated=%d defaults=%d histogram=%s",
                            result["total"], result["updated"],
                            result["default_count"], result["histogram"])
            else:
                logger.debug("rep_score.cron · flag OFF · skip")
        except Exception as exc:
            logger.warning("rep_score.cron · err=%s · 继续", exc)
        await asyncio.sleep(interval_s)


async def _hw_score_cron_loop(interval_s: int = 86400) -> None:
    """
    NCE P2 · 每日重算所有在线节点 hw_score
    
    跑法 (api/app.py lifespan):
        asyncio.create_task(lifecycle._hw_score_cron_loop())
    
    flag nce_hw_score_cron 控 · 默认 OFF · 启用后才跑
    """
    import asyncio
    logger.info("hw_score.cron · 启动 · interval=%ds", interval_s)
    # 启动后等 60s 再跑首次 (避开启动峰)
    await asyncio.sleep(60)
    while True:
        try:
            from platform_v8.services.ops import feature_flags as ff
            if ff.is_enabled("nce_hw_score_cron"):
                from platform_v8.services.economy import hw_scoring
                def _do():
                    return hw_scoring.recompute_all(
                        only_online=True, trigger="cron", dry_run=False,
                    )
                result = await asyncio.to_thread(_do)
                logger.info("hw_score.cron · 跑完 · total=%d updated=%d distribution=%s",
                            result["total"], result["updated"], result["tier_distribution"])
            else:
                logger.debug("hw_score.cron · flag OFF · skip")
        except Exception as exc:
            logger.warning("hw_score.cron · err=%s · 继续", exc)
        await asyncio.sleep(interval_s)


def init_engine() -> None:
    """
    startup 时调用 · 注册节点上线 hook (auto-queue + NCE hw_score) + W1 PULL handler

    api/app.py lifespan 里调:
        from platform_v8.engine import lifecycle
        lifecycle.init_engine()
        asyncio.create_task(lifecycle._sweeper_loop())
        asyncio.create_task(lifecycle._hw_score_cron_loop())
    """
    registry_mod.register_on_worker_online(resubmit_waiting_workloads)
    registry_mod.register_on_worker_online(evaluate_hw_score_on_online)

    # W1-6 (2026-05-26) · 统一引擎 · 注册 PULL 模式 dispatcher
    # 节点发 PullRequest → frame_router → pull_dispatcher._on_pull_request
    try:
        from platform_v8.engine import pull_dispatcher
        pull_dispatcher.install()
    except Exception as exc:
        logger.warning("init_engine · pull_dispatcher.install 失败 (PULL 模式可能不可用): %s", exc)
    logger.info("engine.lifecycle · 已注册 on_worker_online hook (auto-queue + hw_score)")
