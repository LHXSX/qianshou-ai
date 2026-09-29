"""Existing-owner zero-fee trial submission/status, without media bytes or finance routes."""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from platform_v8.api.deps import get_current_account
from platform_v8.storage.db import get_session
from platform_v8.core import Account
from platform_v8.services import media_research_tasks as tasks
from platform_v8.services.media_research import _pairs
import json

router = APIRouter(prefix="/api/v8/media/research", tags=["zero-fee research tasks"])


def _error(error):
    if isinstance(error, tasks.ResearchTaskError):
        return HTTPException(error.status, error.code)
    return HTTPException(400, "research_request_invalid")


@router.post("/tasks")
async def submit(request: Request, s: Session = Depends(get_session), current: Account = Depends(get_current_account)):
    if list(request.query_params) or request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise HTTPException(400, "research_request_invalid")
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 16384:
            raise HTTPException(413, "research_request_exceeded_bound")
    try:
        body = json.loads(raw, object_pairs_hook=_pairs, parse_constant=lambda _x: (_ for _ in ()).throw(ValueError()))
        return tasks.submit(s, current.id, body)
    except (ValueError, KeyError, TypeError) as error:
        raise _error(error) from None


@router.get("/tasks")
def by_request(request: Request, s: Session = Depends(get_session), current: Account = Depends(get_current_account)):
    if list(request.query_params.keys()) != ["request_id"] or len(request.query_params.getlist("request_id")) != 1:
        raise HTTPException(400, "research_request_invalid")
    try:
        return tasks.status(s, current.id, request_id=request.query_params["request_id"])
    except (ValueError, KeyError, TypeError) as error:
        raise _error(error) from None


@router.get("/tasks/{task_id}")
def by_task(task_id: str, request: Request, s: Session = Depends(get_session), current: Account = Depends(get_current_account)):
    if list(request.query_params):
        raise HTTPException(400, "research_request_invalid")
    try:
        return tasks.status(s, current.id, task_id=task_id)
    except (ValueError, KeyError, TypeError) as error:
        raise _error(error) from None
