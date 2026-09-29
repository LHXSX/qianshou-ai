"""Owner decision for a structurally valid result awaiting human acceptance.

The structural checker proves only schema and byte integrity. No reward or
escrow release is permitted until the task owner records a single immutable
decision against the exact result and frozen reviewed contract.
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from platform_v8.core import ShardStatus, WorkloadStatus
from platform_v8.services.economy import ledger as ledger_svc
from platform_v8.services.workloads.reviewed_json_shape import parse_bounded_json
from platform_v8.storage.repo import (
    AuditRepo, ResultVerificationRepo, ShardRepo, WorkloadRepo,
    workload_buyer_acceptances_t as acceptances_t,
)


class AcceptanceError(ValueError):
    pass


class AcceptanceConflict(AcceptanceError):
    pass


def _bound_contract(workload: Any) -> dict[str, Any]:
    bound = (workload.spec.requirements or {}).get("_reviewed_task_contract")
    if (not isinstance(bound, dict)
            or bound.get("schema") != "qianshou.reviewed-workload-contract.v1"
            or bound.get("result_strategy") != "buyer-confirmed-structure.v1"
            or bound.get("output_kind") != "inline_json"
            or not isinstance(bound.get("contract_sha256"), str)
            or not bound["contract_sha256"].startswith("sha256:")
            or len(bound["contract_sha256"]) != 71
            or not isinstance(bound.get("output_schema_sha256"), str)
            or len(bound["output_schema_sha256"]) != 71
            or workload.spec.verification_policy != "semantic"
            or (workload.spec.params or {}).get("review_sample_only") is True):
        raise AcceptanceError("任务没有已审核的买方确认合同")
    return bound


def _pending_result(session: Session, workload: Any, *, lock: bool,
                    allow_settled: bool = False) -> tuple[dict[str, Any], str]:
    bound = _bound_contract(workload)
    shards = (ShardRepo.by_workload_for_update(session, workload.id) if lock
              else ShardRepo.by_workload(session, workload.id))
    if len(shards) != 1 or shards[0].status != ShardStatus.DONE:
        raise AcceptanceError("没有唯一且完成的待确认结果")
    shard = shards[0]
    rows = ResultVerificationRepo.by_workload_for_update(session, workload.id)
    matches = [row for row in rows if (str(row.get("shard_id")) == str(shard.id)
                                   and int(row.get("attempt") or -1) == int(shard.attempts))]
    if len(matches) != 1:
        raise AcceptanceError("待确认结果缺少本次验证记录")
    row = matches[0]
    evidence = row.get("evidence") or {}
    raw = shard.output_ref
    if not isinstance(raw, str):
        raise AcceptanceError("待确认结果正文缺失")
    try:
        preview = parse_bounded_json(raw)
    except ValueError as exc:
        raise AcceptanceError("待确认结果正文无效") from exc
    content_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    if (row.get("state") != ResultVerificationRepo.SUCCEEDED
            or row.get("disposition") != "QUARANTINED"
            or row.get("requested_policy") != "semantic"
            or row.get("content_sha256") != content_hash
            or str(row.get("workload_id")) != str(workload.id)
            or str(row.get("worker_id")) != str(shard.worker_id)
            or evidence.get("actual_disposition") != "structure"
            or evidence.get("semantic_contract") != "buyer-confirmed-structure.v1"
            or evidence.get("reason_code") != "BUYER_ACCEPTANCE_REQUIRED"
            or evidence.get("machine_semantics_verified") is not False
            or evidence.get("output_schema_sha256") != bound["output_schema_sha256"]
            or evidence.get("reviewed_contract_sha256") != bound["contract_sha256"]
            or (not allow_settled and Decimal(str(workload.spent)) != 0)):
        raise AcceptanceError("待确认结果与冻结合同或资金状态不一致")
    return {"inline_output": preview, "content_sha256": content_hash,
            "output_kind": "inline_json", "shard_id": str(shard.id)}, bound["contract_sha256"]


def get_acceptance(session: Session, *, workload_id: str,
                   owner_id: int) -> dict[str, Any]:
    workload = WorkloadRepo.by_id(session, workload_id)
    if workload is None or workload.owner_id != owner_id:
        raise AcceptanceError("任务不存在或无权查看")
    _bound_contract(workload)
    prior = session.execute(select(acceptances_t).where(
        acceptances_t.c.workload_id == workload_id)).mappings().first()
    if prior is None:
        if workload.status != WorkloadStatus.QUARANTINED:
            raise AcceptanceError("任务尚未进入买方确认状态")
        preview, _contract = _pending_result(session, workload, lock=False)
        state = "pending_buyer"
    else:
        preview, _contract = _pending_result(session, workload, lock=False,
                                             allow_settled=True)
        if prior["content_sha256"] != preview["content_sha256"]:
            raise AcceptanceError("已记录决定与当前结果不一致")
        state = "accepted" if prior["decision"] == "accept" else "rejected"
    held = (max(Decimal("0"), workload.budget - workload.spent)
            if workload.status in {WorkloadStatus.QUARANTINED,
                                   WorkloadStatus.RUNNING,
                                   WorkloadStatus.AGGREGATING}
            else Decimal("0"))
    return {"workload_id": workload_id, "status": state,
            "workload_status": workload.status.value, "currency": "CNY",
            "held_amount": str(held),
            **preview}


def decide(session: Session, *, workload_id: str, owner_id: int,
           decision: str, idempotency_key: str) -> tuple[dict[str, Any], bool]:
    """Return (public state, needs_finalize), committing is caller-owned."""
    if decision not in {"accept", "reject"}:
        raise AcceptanceError("决定只能是 accept 或 reject")
    try:
        idem = str(uuid.UUID(idempotency_key))
    except (ValueError, TypeError, AttributeError) as exc:
        raise AcceptanceError("idempotency_key 必须是 UUID") from exc
    workload = WorkloadRepo.by_id_for_update(session, workload_id)
    if workload is None or workload.owner_id != owner_id:
        raise AcceptanceError("任务不存在或无权确认")
    bound = _bound_contract(workload)
    prior = session.execute(select(acceptances_t).where(
        acceptances_t.c.workload_id == workload_id).with_for_update()).mappings().first()
    if prior is not None:
        if (prior["owner_id"] != owner_id or prior["decision"] != decision
                or prior["idempotency_key"] != idem
                or prior["contract_sha256"] != bound["contract_sha256"]):
            raise AcceptanceConflict("任务已经由买方作出不同的不可变决定")
        state = get_acceptance(session, workload_id=workload_id, owner_id=owner_id)
        return state, decision == "accept" and workload.status == WorkloadStatus.RUNNING
    if workload.status != WorkloadStatus.QUARANTINED:
        raise AcceptanceConflict("任务当前不能确认")
    preview, contract_hash = _pending_result(session, workload, lock=True)
    session.execute(insert(acceptances_t).values(
        workload_id=workload_id, owner_id=owner_id, decision=decision,
        idempotency_key=idem, content_sha256=preview["content_sha256"],
        contract_sha256=contract_hash, decided_at=datetime.now(timezone.utc),
    ))
    if decision == "reject":
        if not WorkloadRepo.transition_status(
            session, workload_id, WorkloadStatus.FAILED,
            expected_statuses=(WorkloadStatus.QUARANTINED,),
            error="buyer_rejected_structural_result", completed_at=datetime.utcnow(),
        ):
            raise AcceptanceConflict("任务状态已变化")
        if workload.budget > 0:
            ledger_svc.refund(
                session, account_id=owner_id, amount=workload.budget,
                workload_id=workload_id, reason="买方拒绝待验收结果",
                idempotent_key=f"buyer-reject-refund:{workload_id}",
            )
    else:
        if not WorkloadRepo.transition_status(
            session, workload_id, WorkloadStatus.RUNNING,
            expected_statuses=(WorkloadStatus.QUARANTINED,),
            error="buyer_accepted_structural_result", clear_completed=True,
        ):
            raise AcceptanceConflict("任务状态已变化")
    AuditRepo.write(
        session, action="workload.buyer_acceptance", actor_account_id=owner_id,
        actor_kind="user", target_kind="workload", target_id=workload_id,
        detail={"decision": decision, "content_sha256": preview["content_sha256"],
                "contract_sha256": contract_hash},
    )
    return {"workload_id": workload_id,
            "status": "accepted" if decision == "accept" else "rejected",
            "workload_status": "RUNNING" if decision == "accept" else "FAILED",
            "currency": "CNY",
            "held_amount": str(workload.budget if decision == "accept" else Decimal("0")),
            **preview}, decision == "accept"
