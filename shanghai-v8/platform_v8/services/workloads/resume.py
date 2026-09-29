"""
断点续跑 · 保留已完成分片，只复活 CANCELLED/FAILED 分片并重派。
"""
from __future__ import annotations

import logging
from decimal import Decimal

from sqlalchemy.orm import Session

from platform_v8.core import Account, ShardStatus, Workload, WorkloadStatus
from platform_v8.services.economy import balance as balance_svc
from platform_v8.services.economy import ledger as ledger_svc
from platform_v8.storage.repo import ShardRepo, WorkloadRepo

logger = logging.getLogger(__name__)


class ResumeError(Exception):
    pass


def resume_workload(s: Session, workload_id: str, *, caller: Account) -> tuple[Workload, dict]:
    """同步部分：校验 + 复活分片 + 重新托管。调用方再 await redispatch。"""
    w = WorkloadRepo.by_id(s, workload_id)
    if w is None:
        raise ResumeError("任务不存在")
    if w.owner_id != caller.id and not caller.is_admin:
        raise ResumeError("无权继续他人任务")

    st = getattr(w.status, "value", str(w.status))
    if st not in (WorkloadStatus.CANCELLED.value, WorkloadStatus.FAILED.value):
        raise ResumeError(f"仅已中断/失败的任务可续跑（当前 {st}）")

    shards = ShardRepo.by_workload(s, workload_id)
    if not shards:
        raise ResumeError("任务没有分片，无法续跑；请重新提交")

    done_n = sum(
        1 for sh in shards
        if getattr(sh.status, "value", str(sh.status)) in (
            ShardStatus.DONE.value, "SUCCEEDED", "COMPLETED",
        )
    )
    incomplete = [
        sh for sh in shards
        if getattr(sh.status, "value", str(sh.status)) in (
            ShardStatus.CANCELLED.value,
            ShardStatus.FAILED.value,
            ShardStatus.PENDING.value,
        )
    ]
    if not incomplete:
        raise ResumeError("没有未完成分片可续跑（可能已全部完成）")
    if done_n == 0 and st == WorkloadStatus.FAILED.value:
        # 允许全失败重试；取消且零完成也允许（等价重跑未完成片）
        pass

    # 托管：取消时已全额退回 · 续跑再扣一轮（幂等键带 resume 轮次）
    resume_n = WorkloadRepo.bump_resume_count(s, workload_id)
    if w.budget and Decimal(str(w.budget)) > 0:
        amount = Decimal(str(w.budget))
        bal = balance_svc.get_balance(s, w.owner_id)
        if bal < amount:
            raise ResumeError(f"余额不足（当前 {bal} · 续跑需托管 {amount}）")
        ledger_svc.escrow_hold(
            s,
            account_id=w.owner_id,
            amount=amount,
            workload_id=workload_id,
            note=f"断点续跑托管 (第 {resume_n} 次)",
            idempotent_key=ledger_svc.settlement_round_key(
                "escrow", workload_id, resume_n,
            ),
        )

    revived = ShardRepo.revive_incomplete(s, workload_id)

    # 优先已成功节点
    proven: list[str] = []
    seen: set[str] = set()
    for sh in shards:
        ost = getattr(sh.status, "value", str(sh.status))
        if ost not in (ShardStatus.DONE.value, "SUCCEEDED", "COMPLETED"):
            continue
        wid = str(sh.worker_id) if sh.worker_id else ""
        if wid and wid not in seen:
            seen.add(wid)
            proven.append(wid)
    if proven:
        pending_now = [
            sh for sh in ShardRepo.by_workload(s, workload_id)
            if getattr(sh.status, "value", str(sh.status)) == ShardStatus.PENDING.value
        ]
        for sh in pending_now:
            try:
                ShardRepo.set_preferred_workers(s, sh.id, proven)
            except Exception:
                pass

    progress = (done_n / max(1, len(shards))) if shards else 0.0
    if not WorkloadRepo.transition_status(
        s,
        workload_id,
        WorkloadStatus.RUNNING,
        expected_statuses=(WorkloadStatus.CANCELLED, WorkloadStatus.FAILED),
        error="",
        progress=progress,
        completed_shards=done_n,
        failed_shards=0,
        clear_completed=True,
    ):
        raise ResumeError("任务状态已变化，无法续跑")

    s.flush()
    w2 = WorkloadRepo.by_id(s, workload_id)
    if w2 is None:
        raise ResumeError("续跑后读取任务失败")

    meta = {
        "revived": revived,
        "done_kept": done_n,
        "resume_count": resume_n,
        "preferred_workers": proven,
        "pending": len(incomplete),
    }
    logger.info(
        "workload.resume · id=%s revived=%s done_kept=%s resume_n=%s",
        workload_id, revived, done_n, resume_n,
    )
    return w2, meta
