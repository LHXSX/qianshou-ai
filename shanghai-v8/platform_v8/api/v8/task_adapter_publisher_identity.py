"""JWT author-key enrollment and isolated read-only issuer key resolution."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.core import Account
from platform_v8.services.workers import task_adapter_publisher_identity as identity

router = APIRouter(prefix="/api/v8/task-adapter-publisher-keys",
                   tags=["task-adapter-publisher-keys"])
internal_router = APIRouter(prefix="/api/v8/internal/task-adapter-publisher-keys",
                            tags=["task-adapter-publisher-keys-issuer"])
manifest_router = APIRouter(prefix="/api/v8/task-adapter-publications",
                            tags=["task-adapter-author-manifest"])


class EnrollIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key_id: str = Field(..., min_length=31, max_length=31)
    public_key: str = Field(..., min_length=43, max_length=43)
    challenge_id: str = Field(..., min_length=36, max_length=36)
    signature: str = Field(..., min_length=86, max_length=86)


class ManifestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    author_manifest: dict[str, Any]


def _jwt(request: Request) -> None:
    if getattr(request.state, "auth_via", None) != "jwt":
        raise HTTPException(status_code=403, detail="作者密钥登记仅支持账号 JWT 登录")


def _error(exc: identity.PublisherIdentityError) -> None:
    if isinstance(exc, identity.PublisherIdentityNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, identity.PublisherIdentityRevoked):
        raise HTTPException(status_code=410, detail=str(exc)) from exc
    if isinstance(exc, identity.PublisherIdentityConflict):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    raise HTTPException(status_code=400, detail=str(exc)) from exc


def _service(authorization: str | None) -> None:
    if not identity.issuer_authorized(authorization):
        raise HTTPException(status_code=403, detail="作者密钥查询服务未授权")


@router.post("/challenge", summary="账号绑定的作者签名一次性挑战")
def challenge(request: Request, current: Account = Depends(get_current_account),
              session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    try:
        return identity.challenge(session, owner_id=current.id)
    except identity.PublisherIdentityError as exc:
        _error(exc)


@router.post("", summary="私钥持有证明后登记作者公钥；私钥永不上传")
def enroll(body: EnrollIn, request: Request,
           current: Account = Depends(get_current_account),
           session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    try:
        return identity.enroll(session, owner_id=current.id, **body.model_dump())
    except identity.PublisherIdentityError as exc:
        _error(exc)


@router.post("/{key_id}/revoke", summary="作者撤销自己的登记密钥")
def revoke(key_id: str, request: Request,
           current: Account = Depends(get_current_account),
           session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    try:
        return identity.revoke(session, owner_id=current.id, key_id=key_id)
    except identity.PublisherIdentityError as exc:
        _error(exc)


@internal_router.get("/publications/{publication_id}/manifest",
                     summary="独立验包服务读取账号已登记的不可变作者清单")
def issuer_manifest(publication_id: str, response: Response,
                    authorization: str | None = Header(default=None),
                    session: Session = Depends(get_session)) -> dict[str, Any]:
    _service(authorization)
    response.headers["Cache-Control"] = "no-store"
    try:
        return identity.manifest_for_issuer(session, publication_id=publication_id)
    except identity.PublisherIdentityError as exc:
        _error(exc)


@internal_router.get("/{owner_id}/{key_id}",
                     summary="独立验包服务实时查询作者当前活动公钥")
def issuer_key(owner_id: int, key_id: str, response: Response,
               authorization: str | None = Header(default=None),
               session: Session = Depends(get_session)) -> dict[str, Any]:
    _service(authorization)
    response.headers["Cache-Control"] = "no-store"
    try:
        return identity.active_key(session, owner_id=owner_id, key_id=key_id)
    except identity.PublisherIdentityError as exc:
        _error(exc)


@manifest_router.post("/{publication_id}/author-manifest",
                      summary="作者上传对当前六文件和本机运行包的签名声明")
def author_manifest(publication_id: str, body: ManifestIn, request: Request,
                    current: Account = Depends(get_current_account),
                    session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    try:
        return identity.publish_manifest(session, owner_id=current.id,
                                         publication_id=publication_id,
                                         envelope=body.author_manifest)
    except identity.PublisherIdentityError as exc:
        _error(exc)
