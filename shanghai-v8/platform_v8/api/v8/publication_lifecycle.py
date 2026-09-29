"""JWT owner/admin lifecycle actions, independent of queue read delegation."""
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_admin_account, get_current_account, get_session
from platform_v8.core import Account
from platform_v8.services.workers import publication_lifecycle as service

router = APIRouter(prefix="/api/v8/task-adapter-publications", tags=["publication-lifecycle"])
admin_router = APIRouter(prefix="/api/v8/admin/task-adapter-publications", tags=["publication-lifecycle-admin"])


class LifecycleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["withdraw", "delist", "archive", "restore"]
    expected_revision: int = Field(..., ge=0, strict=True)
    note: str = Field(..., min_length=1, max_length=500)


def _jwt(request: Request, response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    if getattr(request.state, "auth_via", None) != "jwt":
        raise HTTPException(403, "PUBLICATION_JWT_REQUIRED")


def _manage(session: Session, current: Account, publication_id: str,
            body: LifecycleIn, *, admin: bool) -> dict[str, Any]:
    try:
        return service.manage(session, publication_id=publication_id,
            actor_id=current.id, admin=admin, **body.model_dump())
    except service.LifecycleError as exc:
        raise HTTPException(exc.status, exc.code) from exc


@router.post("/{publication_id}/lifecycle")
def manage_owner(publication_id: str, body: LifecycleIn, request: Request, response: Response,
                 current: Account = Depends(get_current_account),
                 session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request, response)
    return _manage(session, current, publication_id, body, admin=False)


@admin_router.get("/managed")
def list_managed(request: Request, response: Response, include_archived: bool = True,
                 current: Account = Depends(get_admin_account),
                 session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request, response)
    return service.managed(session, include_archived=include_archived)


@admin_router.post("/{publication_id}/lifecycle")
def manage_admin(publication_id: str, body: LifecycleIn, request: Request, response: Response,
                 current: Account = Depends(get_admin_account),
                 session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request, response)
    return _manage(session, current, publication_id, body, admin=True)
