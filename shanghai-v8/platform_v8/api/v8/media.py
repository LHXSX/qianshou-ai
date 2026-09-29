"""Metadata-only owner media status and separately authenticated current order."""
import hmac
from decimal import Decimal
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session
from platform_v8.api.deps import get_current_account
from platform_v8.core import Account
from platform_v8.storage.db import get_session
from platform_v8.storage.repo import WorkloadRepo
from platform_v8.storage.media_repo import MediaRepo
from platform_v8.services import media_channel as channel
from platform_v8.services.media_profiles import MediaProfileError
from platform_v8.services import media_storage

router = APIRouter(prefix="/api/v8/media", tags=["formal media"])


def _owned(s, task_id, current):
    w = WorkloadRepo.by_id(s, task_id)
    # No administrator cross-owner grant on the ordinary result delivery path.
    if w is None or w.owner_id != current.id:
        raise HTTPException(404, "媒体任务不存在")
    return w


@router.get("/tasks")
def find_task(request_id: str = Query(min_length=1, max_length=128),
              s: Session = Depends(get_session), current: Account = Depends(get_current_account)):
    row = MediaRepo.request(s, current.id, request_id)
    if row is None:
        raise HTTPException(404, "该 request_id 尚无已确认媒体任务；禁止未知提交自动重提")
    return _status(s, _owned(s, row["workload_id"], current))


def _status(s, w):
    try:
        return channel.task_status(s, w)
    except MediaProfileError as exc:
        raise HTTPException(503, str(exc)) from None


@router.get("/tasks/{task_id}")
def get_task(task_id: str, s: Session = Depends(get_session), current: Account = Depends(get_current_account)):
    return _status(s, _owned(s, task_id, current))


def service_auth(authorization: str | None = Header(default=None)):
    try:
        expected = channel._file("V8_MEDIA_SERVICE_INBOUND_TOKEN_FILE", secret=True).decode().strip()
    except MediaProfileError:
        raise HTTPException(503, "媒体订单服务身份尚未配置") from None
    if len(expected) < 32 or not hmac.compare_digest(authorization or "", "Bearer " + expected):
        raise HTTPException(401, "media service authentication required")


class CurrentOrder(BaseModel):
    model_config = ConfigDict(extra="forbid")
    taskId: str = Field(min_length=1, max_length=36)
    attemptId: str = Field(min_length=1, max_length=36)
    leaseEpoch: int = Field(strict=True, ge=1)


@router.post("/internal/order-current", dependencies=[Depends(service_auth)])
def order_current(body: CurrentOrder, s: Session = Depends(get_session)):
    try:
        return {"ok": True, "order": channel.current_order(s, body.taskId, body.attemptId, body.leaseEpoch)}
    except MediaProfileError as exc:
        raise HTTPException(409, str(exc)) from None


def _storage_auth(authorization, role):
    try:
        expected = channel._file("V8_MEDIA_STORAGE_" + role + "_SERVICE_INBOUND_TOKEN_FILE", secret=True).decode().strip()
    except MediaProfileError:
        raise HTTPException(503, "专用媒体存储服务身份尚未配置") from None
    if len(expected) < 32 or not hmac.compare_digest(authorization or "", "Bearer " + expected):
        raise HTTPException(401, "media storage service authentication required")


def storage_write_auth(authorization: str | None = Header(default=None)):
    _storage_auth(authorization, "WRITE")


def storage_read_auth(authorization: str | None = Header(default=None)):
    _storage_auth(authorization, "READ")


class InputWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ticket: dict


class InputRead(InputWrite):
    object_version_id: str = Field(min_length=1, max_length=200)


class ResultWrite(CurrentOrder):
    assetId: str = Field(min_length=36, max_length=36)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes: int = Field(strict=True, ge=1, le=67108864)
    content_type: str = Field(min_length=1, max_length=64)


class ResultRead(ResultWrite):
    object_version_id: str = Field(min_length=1, max_length=200)


def _storage_call(fn):
    try:
        return fn()
    except MediaProfileError as exc:
        raise HTTPException(503, str(exc)) from None


@router.post("/internal/input-write-credential", dependencies=[Depends(storage_write_auth)])
def input_write(body: InputWrite, s: Session = Depends(get_session)):
    return _storage_call(lambda: media_storage.input_grant(s, body.ticket))


@router.post("/internal/input-read-credential", dependencies=[Depends(storage_read_auth)])
def input_read(body: InputRead, s: Session = Depends(get_session)):
    return _storage_call(lambda: media_storage.input_grant(s, body.ticket, version=body.object_version_id))


@router.post("/internal/result-write-credential", dependencies=[Depends(storage_write_auth)])
def result_write(body: ResultWrite, s: Session = Depends(get_session)):
    return _storage_call(lambda: media_storage.result_grant(s, body.model_dump()))


@router.post("/internal/result-read-credential", dependencies=[Depends(storage_read_auth)])
def result_read(body: ResultRead, s: Session = Depends(get_session)):
    return _storage_call(lambda: media_storage.result_grant(s, body.model_dump(), read=True))


@router.get("/provider/summary")
def provider_summary(s: Session = Depends(get_session), current: Account = Depends(get_current_account)):
    from sqlalchemy import select
    from platform_v8.storage.media_repo import attempts_t, settlements_t
    from platform_v8.storage.repo import ledger_t, workloads_t
    from platform_v8.core import LedgerType
    modes = {kind: {"completedCalls": 0, "activeCalls": 0, "settledEarnings": Decimal("0")}
             for kind in ("image", "video")}
    def mode(spec):
        return spec.get("media_input", {}).get("capability") if isinstance(spec, dict) else None
    joined = attempts_t.join(workloads_t, attempts_t.c.task_id == workloads_t.c.id)
    for row in s.execute(select(workloads_t.c.spec).select_from(settlements_t.join(joined,
            settlements_t.c.attempt_id == attempts_t.c.attempt_id)).where(attempts_t.c.worker_owner_id == current.id)):
        if mode(row.spec) in modes:
            modes[mode(row.spec)]["completedCalls"] += 1
    for row in s.execute(select(workloads_t.c.spec).select_from(joined).where(
            attempts_t.c.worker_owner_id == current.id, attempts_t.c.state.notin_(["settled", "failed", "cancelled"]))):
        if mode(row.spec) in modes:
            modes[mode(row.spec)]["activeCalls"] += 1
    for row in s.execute(select(ledger_t.c.amount, workloads_t.c.spec).select_from(ledger_t.join(
            settlements_t, ledger_t.c.workload_id == settlements_t.c.workload_id).join(joined,
            settlements_t.c.attempt_id == attempts_t.c.attempt_id)).where(
            attempts_t.c.worker_owner_id == current.id, ledger_t.c.account_id == current.id,
            ledger_t.c.type == LedgerType.REWARD.value, ledger_t.c.basis == "node_compute",
            ledger_t.c.idempotent_key.like("reward:%:media-node"))):
        if mode(row.spec) in modes:
            modes[mode(row.spec)]["settledEarnings"] += Decimal(row.amount)
    totals = {key: sum((v[key] for v in modes.values()), Decimal("0") if key == "settledEarnings" else 0)
              for key in ("completedCalls", "activeCalls", "settledEarnings")}
    for group in [totals, *modes.values()]:
        group["settledEarnings"] = str(group["settledEarnings"])
    return {"ok": True, **totals, "modes": modes, "currency": "CNY", "basis": "actual_settled_ledger"}
