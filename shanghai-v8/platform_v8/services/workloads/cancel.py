"""
取消任务业务

设计要点:
  1. 只能取消未终止的任务 (status not in DONE/FAILED/CANCELLED)
  2. 同一事务: workload.status = CANCELLED · 未完成分片 → CANCELLED · escrow 退款
  3. 给在跑节点发 shard_cancel · 含 race_workers · 不让算力白白消耗
  4. stop_workload_nodes: 已 terminal / 已 CANCELLED 的分片也能补发停帧（清僵尸）
"""
from __future__ import annotations
import asyncio
import logging
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from platform_v8.core import Workload, WorkloadStatus, AuditAction, Account, ShardStatus
from platform_v8.storage.repo import WorkloadRepo, AuditRepo, ShardRepo
from platform_v8.services.economy import ledger as ledger_svc

logger = logging.getLogger(__name__)

_ACTIVE_SHARD = (
    ShardStatus.PENDING,
    ShardStatus.DISPATCHED,
    ShardStatus.LEASED,
    ShardStatus.RUNNING,
)

# stop-nodes / 取消补推：节点可能仍在跑已标 CANCELLED 的片
_STOP_NOTIFY_STATUS = _ACTIVE_SHARD + (ShardStatus.CANCELLED,)


class CancelError(Exception):
    pass


def _collect_cancel_targets(
    shards: list,
    *,
    statuses: tuple = _ACTIVE_SHARD,
) -> list[tuple[str, str]]:
    """返回 [(shard_id, worker_id), ...] · owner + race_workers 去重。"""
    out: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for sh in shards:
        st = sh.status
        if st not in statuses:
            continue
        sid = str(sh.id)
        candidates: list[str] = []
        wid = getattr(sh, "worker_id", None)
        if wid:
            candidates.append(str(wid))
        md = getattr(sh, "metadata", None) or {}
        if isinstance(md, dict):
            for r in (md.get("race_workers") or []):
                if r:
                    candidates.append(str(r))
        for w in candidates:
            key = (sid, w)
            if key in seen:
                continue
            seen.add(key)
            out.append(key)
    return out


def cancel_workload(s: Session, workload_id: str, *,
                    caller: Account, reason: str = "user_cancel") -> Workload:
    """
    取消任务 · 退款 · 分片标 CANCELLED · 通知节点停跑 · 返回更新后 Workload
    """
    w = WorkloadRepo.by_id(s, workload_id)
    if w is None:
        raise CancelError(f"workload {workload_id} 不存在")
    if w.owner_id != caller.id and not caller.is_admin:
        raise CancelError("无权取消他人任务")
    shards = ShardRepo.by_workload(s, workload_id)
    # A cold verifier process used to isolate an otherwise valid dynamic task
    # as REGISTRY_QUARANTINE. No result was verified and no reward was paid;
    # preserve the buyer's ability to release its held CNY. A structurally
    # checked result requiring buyer acceptance remains on its own path.
    registry_quarantine_refundable = (
        w.status == WorkloadStatus.QUARANTINED
        and w.error == "result_quarantined:REGISTRY_QUARANTINE"
        and Decimal(str(w.spent)) == 0
        and all(sh.status != ShardStatus.DONE for sh in shards)
    )
    if w.is_terminal and not registry_quarantine_refundable:
        raise CancelError(f"任务已 {w.status.value} · 无法取消")

    from platform_v8.services.media_profiles import is_media, MediaProfileError
    if is_media(w):
        from platform_v8.services.media_channel import cancel_media
        try:
            return cancel_media(s, w)
        except MediaProfileError as exc:
            raise CancelError(str(exc)) from None

    shards = ShardRepo.by_workload(s, workload_id)
    # 必须在 cancel_all_pending 之前收集 · 否则 worker_id 可能被清掉
    targets = _collect_cancel_targets(shards, statuses=_ACTIVE_SHARD)

    cancelable_statuses = (
        WorkloadStatus.NORMALIZING,
        WorkloadStatus.CREATED,
        WorkloadStatus.PLANNED,
        WorkloadStatus.RUNNING,
        WorkloadStatus.AGGREGATING,
        WorkloadStatus.WAITING_FOR_WORKERS,
    )
    if registry_quarantine_refundable:
        cancelable_statuses += (WorkloadStatus.QUARANTINED,)

    claimed = WorkloadRepo.transition_status(
        s, workload_id, WorkloadStatus.CANCELLED,
        expected_statuses=cancelable_statuses,
        error=f"已取消 ({reason})",
        completed_at=datetime.utcnow(),
    )
    if not claimed:
        latest = WorkloadRepo.by_id(s, workload_id)
        state = getattr(getattr(latest, "status", None), "value", "unknown")
        raise CancelError(f"任务已 {state} · 无法取消")

    cancelled_n = ShardRepo.cancel_all_pending(
        s, workload_id, error=f"cancelled:{reason}",
    )

    if w.budget > 0:
        # 断点续跑会再扣一轮托管金 · 退款幂等键须与当前托管轮次对齐
        resume_n = 0
        try:
            params = dict(getattr(getattr(w, "spec", None), "params", None) or {})
            resume_n = int(params.get("resume_count") or 0)
        except Exception:
            resume_n = 0
        refund_key = ledger_svc.settlement_round_key(
            "refund", workload_id, resume_n,
        )
        ledger_svc.refund(
            s,
            account_id=w.owner_id,
            amount=w.budget,
            workload_id=workload_id,
            reason=reason,
            idempotent_key=refund_key,
        )

    AuditRepo.write(
        s,
        action=AuditAction.WORKLOAD_CANCEL,
        actor_account_id=caller.id,
        actor_kind="admin" if caller.is_admin else "user",
        target_kind="workload",
        target_id=workload_id,
        detail={
            "reason": reason,
            "refund": str(w.budget),
            "cancelled_shards": cancelled_n,
            "notify_targets": len(targets),
        },
    )

    logger.info(
        "workload.cancel · id=%s by=%s reason=%s refund=%s shards=%d notify=%d",
        workload_id, caller.id, reason, w.budget, cancelled_n, len(targets),
    )

    if targets:
        _schedule_shard_cancels(targets, reason)

    return WorkloadRepo.by_id(s, workload_id)


def stop_workload_nodes(
    s: Session,
    workload_id: str,
    *,
    caller: Account,
    reason: str = "force_stop_nodes",
) -> dict[str, Any]:
    """强制通知节点停止本任务分片（workload / shard 已 terminal 也可补发）。

    关键点：取消后 DB 已 CANCELLED，但节点仍在跑 → 必须仍能按 worker_id 推 shard_cancel。
    """
    w = WorkloadRepo.by_id(s, workload_id)
    if w is None:
        raise CancelError(f"workload {workload_id} 不存在")
    if w.owner_id != caller.id and not caller.is_admin:
        raise CancelError("无权操作他人任务")

    shards = ShardRepo.by_workload(s, workload_id)
    active = [sh for sh in shards if sh.status in _ACTIVE_SHARD]
    # 含 CANCELLED：节点僵尸跑时 DB 已终态，仍要推停
    targets = _collect_cancel_targets(shards, statuses=_STOP_NOTIFY_STATUS)

    cancelled_shards = 0
    if active:
        cancelled_shards = ShardRepo.cancel_all_pending(
            s, workload_id, error=f"cancelled:{reason}",
        )

    AuditRepo.write(
        s,
        action=AuditAction.WORKLOAD_CANCEL,
        actor_account_id=caller.id,
        actor_kind="admin" if caller.is_admin else "user",
        target_kind="workload",
        target_id=workload_id,
        detail={
            "reason": reason,
            "action": "stop_nodes",
            "workload_status": getattr(w.status, "value", str(w.status)),
            "cancelled_shards": cancelled_shards,
            "notify_targets": len(targets),
        },
    )

    push_stats: dict[str, Any] = {
        "pushed": 0, "failed": 0, "targets": len(targets), "scheduled": False,
    }
    if targets:
        scheduled = _schedule_shard_cancels(targets, reason)
        if scheduled is not None:
            push_stats = {**scheduled, "scheduled": True}
        else:
            push_stats["scheduled"] = False

    logger.info(
        "workload.stop_nodes · id=%s by=%s cancelled=%d targets=%d",
        workload_id, caller.id, cancelled_shards, len(targets),
    )
    return {
        "workload_id": workload_id,
        "workload_status": getattr(w.status, "value", str(w.status)),
        "cancelled_shards": cancelled_shards,
        "notify_targets": len(targets),
        "pushed": int(push_stats.get("pushed", 0)),
        "failed": int(push_stats.get("failed", 0)),
        "offline": max(0, len(targets) - int(push_stats.get("pushed", 0))),
        "scheduled": bool(push_stats.get("scheduled")),
    }


def _schedule_shard_cancels(
    targets: list[tuple[str, str]],
    reason: str,
) -> dict[str, int] | None:
    """从 sync 派 async 任务发 shard_cancel。

    targets: [(shard_id, worker_id), ...]
    有 running loop 时返回占位统计；无 loop 返回 None。
    """
    from platform_v8.engine import broker as _broker

    async def _do() -> dict[str, int]:
        pushed = 0
        failed = 0
        for shard_id, worker_id in targets:
            try:
                ok = await _broker.cancel_shard(shard_id, worker_id, reason=reason)
                if ok:
                    pushed += 1
                else:
                    failed += 1
                    logger.warning(
                        "shard_cancel 未送达 shard=%s worker=%s",
                        shard_id[:8], worker_id[:8],
                    )
            except Exception as exc:
                failed += 1
                logger.warning(
                    "shard_cancel 推送失败 shard=%s: %s", shard_id[:8], exc,
                )
        logger.info(
            "shard_cancel.batch · targets=%d pushed=%d failed=%d reason=%s",
            len(targets), pushed, failed, reason,
        )
        return {"pushed": pushed, "failed": failed, "targets": len(targets)}

    try:
        asyncio.get_running_loop()
        _broker._spawn(_do())
        return {"pushed": 0, "failed": 0, "targets": len(targets)}
    except RuntimeError:
        logger.warning(
            "shard_cancel · 不在 event loop · 跳过推送 targets=%d（请调 stop-nodes 补发）",
            len(targets),
        )
        return None
