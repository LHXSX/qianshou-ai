"""Buyer confirmation of structurally checked, unpaid task output."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.core import Account
from platform_v8.engine import aggregator
from platform_v8.services.workloads import buyer_acceptance as acceptance_svc

router = APIRouter(prefix="/api/v8/workloads", tags=["workload-acceptance"])


class DecisionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: str
    idempotency_key: str


@router.get("/{workload_id}/acceptance")
def get_acceptance(workload_id: str,
                   current: Account = Depends(get_current_account),
                   session: Session = Depends(get_session)) -> dict:
    try:
        return acceptance_svc.get_acceptance(
            session, workload_id=workload_id, owner_id=current.id)
    except acceptance_svc.AcceptanceError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{workload_id}/acceptance")
async def decide_acceptance(workload_id: str, body: DecisionBody,
                            current: Account = Depends(get_current_account),
                            session: Session = Depends(get_session)) -> dict:
    try:
        _state, needs_finalize = acceptance_svc.decide(
            session, workload_id=workload_id, owner_id=current.id,
            decision=body.decision, idempotency_key=body.idempotency_key)
        # The immutable decision and refund must commit before aggregation
        # opens a separate transaction to pay anyone.
        session.commit()
    except acceptance_svc.AcceptanceConflict as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except acceptance_svc.AcceptanceError as exc:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="确认请求已经用于其他任务") from exc
    if needs_finalize:
        await aggregator._maybe_finalize_workload(workload_id)
    return acceptance_svc.get_acceptance(
        session, workload_id=workload_id, owner_id=current.id)
