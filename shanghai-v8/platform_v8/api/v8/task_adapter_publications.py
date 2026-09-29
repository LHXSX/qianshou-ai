"""独立接单适配器受理与审核；不复用商品市场 we_apps 审核。"""
from __future__ import annotations

import hmac
import json
import os
from typing import Any, Literal

from cryptography.exceptions import InvalidSignature
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_admin_account, get_current_account, get_session
from platform_v8.api.market_queue_delegation import get_market_queue_reader
from platform_v8.core import Account
from platform_v8.services.workers import task_adapter_publications as publication_svc
from platform_v8.services.workers import task_adapter_package_upload as package_upload_svc
from platform_v8.services.workers import task_adapter_review_samples as sample_svc

router = APIRouter(prefix="/api/v8/task-adapter-publications", tags=["task-adapter-publications"])
admin_router = APIRouter(prefix="/api/v8/admin/task-adapter-publications",
                         tags=["task-adapter-publications-admin"])
internal_router = APIRouter(prefix="/api/v8/internal/task-adapter-publications",
                            tags=["task-adapter-publications-issuer"])


class PublicationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_type: str = Field(..., min_length=1, max_length=100)
    capability_id: str = Field(..., min_length=1, max_length=100)
    input_kinds: list[str] = Field(..., min_length=1, max_length=8)
    output_kind: str = Field(..., min_length=1, max_length=32)
    contract_version: str = Field(..., min_length=1, max_length=16)
    artifact_digest: str = Field(..., min_length=64, max_length=71)
    package_digest: str = Field(..., min_length=64, max_length=71)
    version: str = Field(..., min_length=1, max_length=40)
    name: str = Field(..., min_length=1, max_length=100)
    category: str = Field(..., min_length=2, max_length=32,
                          pattern=r"^[a-z][a-z0-9_.-]+$")
    description: str = Field(..., min_length=1, max_length=500)
    configuration: str = Field("", max_length=1000)
    task_definition: dict[str, Any] | None = None
    currency: Literal["CNY"] = "CNY"
    price_yuan: str | None = Field(default=None, min_length=1, max_length=16,
                                   description="人民币元，由平台已审核价目自动确定")
    sale_price_yuan: str | None = Field(default=None, min_length=1, max_length=16,
                                        description="技能一次买断售价；提供时同次审核后自动上架")


class PricePreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_type: str = Field(..., min_length=1, max_length=100)
    task_definition: dict[str, Any]


class ApproveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note: str = Field(..., min_length=1, max_length=1000)


class EvidenceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    receipt: dict[str, Any]
    revalidation_material: dict[str, Any] | None = None


class RejectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note: str = Field(..., min_length=1, max_length=1000)


class PackageUploadPrepareIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifact_digest: str = Field(..., min_length=71, max_length=71)
    package_digest: str = Field(..., min_length=71, max_length=71)
    archive_digest: str = Field(..., min_length=71, max_length=71)
    content_md5: str = Field(..., min_length=24, max_length=24)
    size_bytes: int = Field(..., ge=1, le=16 * 1024 * 1024)


class PackageUploadConfirmIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    upload_intent: str = Field(..., min_length=10, max_length=2048)
    version_id: str = Field(..., min_length=1, max_length=200)


class ReviewSampleUploadIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lease_token: str = Field(..., min_length=10, max_length=512)
    result_id: str = Field(..., min_length=36, max_length=36)
    sha256: str = Field(..., min_length=64, max_length=64)
    content_md5: str = Field(..., min_length=24, max_length=24)
    size_bytes: int = Field(..., ge=1, le=16 * 1024 * 1024)


class ReviewSampleVerifyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    result_id: str = Field(..., min_length=36, max_length=36)
    object_version_id: str = Field(..., min_length=1, max_length=200)


class ReviewWorkerEnrollIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    owner_id: int = Field(..., ge=1)


class ReviewSampleFinalizeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runner_attestation: dict[str, Any]


def _jwt_only(request: Request) -> None:
    if getattr(request.state, "auth_via", None) != "jwt":
        raise HTTPException(status_code=403, detail="接单技能发布审核仅支持账号 JWT 登录")


def _raise(exc: Exception) -> None:
    if getattr(exc, "code", None) == "NATIVE_H3_DEVICE_SAMPLE_MISSING":
        raise HTTPException(status_code=409, detail={"code": exc.code, "message": str(exc)}) from exc
    if isinstance(exc, package_upload_svc.PackageUploadNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, package_upload_svc.PackageUploadConflict):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, package_upload_svc.PackageUploadUnavailable):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if isinstance(exc, package_upload_svc.PackageUploadError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if isinstance(exc, publication_svc.PublicationNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, publication_svc.PublicationConflict):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, publication_svc.PublicationError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


@router.post("/{publication_id}/package-upload/prepare",
             summary="为当前投稿签发固定键、校验和及合规锁定的直传授权")
def prepare_package_upload(
    publication_id: str,
    body: PackageUploadPrepareIn,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    try:
        return package_upload_svc.prepare(
            session, publication_id=publication_id, owner_id=current.id,
            **body.model_dump())
    except package_upload_svc.PackageUploadError as exc:
        _raise(exc)


@router.post("/{publication_id}/package-upload/confirm",
             summary="仅在对象存储证明精确版本、校验和及合规锁后确认归档")
def confirm_package_upload(
    publication_id: str,
    body: PackageUploadConfirmIn,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    try:
        return package_upload_svc.confirm(
            session, publication_id=publication_id, owner_id=current.id,
            **body.model_dump())
    except package_upload_svc.PackageUploadError as exc:
        _raise(exc)


@router.get("/{publication_id}/package-upload",
            summary="作者查看归档上传状态；确认不等于广州独立验包")
def package_upload_status(
    publication_id: str,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    try:
        return package_upload_svc.status(
            session, publication_id=publication_id, owner_id=current.id)
    except package_upload_svc.PackageUploadError as exc:
        _raise(exc)


@router.post("", summary="机主一键提交接单适配器审核")
def submit_publication(
    body: PublicationIn,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    try:
        return publication_svc.submit(session, owner_id=current.id, body=body.model_dump())
    except publication_svc.PublicationError as exc:
        _raise(exc)


@router.post("/price-preview", summary="作者预览已审核任务策略的人民币价目")
def preview_publication_price(
    body: PricePreviewIn,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    try:
        return publication_svc.preview_reviewed_price(
            session, task_type=body.task_type,
            task_definition=body.task_definition)
    except publication_svc.PublicationError as exc:
        _raise(exc)


@router.get("/mine", summary="机主查看自己的接单适配器投稿")
def my_publications(
    request: Request,
    include_archived: bool = False,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    return publication_svc.mine(session, owner_id=current.id, include_archived=include_archived)



class NativeDeviceChallengeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    worker_id: str = Field(min_length=1,max_length=36)
    key_id: str = Field(min_length=41,max_length=41)
    public_key: str = Field(min_length=43,max_length=43)


class NativeDeviceRegisterIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    worker_id: str = Field(min_length=1,max_length=36)
    challenge_id: str = Field(min_length=36,max_length=36)
    signature: str = Field(min_length=86,max_length=86)


class NativeReviewStartIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    worker_id: str = Field(min_length=1,max_length=36)
    key_id: str = Field(min_length=41,max_length=41)


class NativeReviewUploadIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    result_id: str = Field(min_length=36,max_length=36)
    sha256: str = Field(min_length=64,max_length=64)
    size_bytes: int = Field(ge=1,le=16777216,strict=True)
    content_md5: str = Field(min_length=24,max_length=24)


class NativeDeviceConfigChallengeIn(BaseModel):
    model_config=ConfigDict(extra="forbid",strict=True)
    worker_id:str=Field(min_length=1,max_length=36)
    key_id:str=Field(min_length=1,max_length=64)
    local_owner_config_digest:str=Field(pattern=r"^sha256:[0-9a-f]{64}$")
    expected_revision:int=Field(ge=0,le=9007199254740991)


@router.get("/{publication_id}/native-device-configs")
def native_device_config(publication_id:str,worker_id:str,request:Request,response:Response,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request);response.headers["Cache-Control"]="no-store"
    from platform_v8.services.workers.native_h3_device_configs import get_config
    try:return get_config(session,publication_id=publication_id,owner_id=current.id,worker_id=worker_id)
    except (publication_svc.PublicationError,ValueError) as exc:
        _raise(exc if isinstance(exc,publication_svc.PublicationError) else publication_svc.PublicationError('设备配置读取无效'))


@router.post("/{publication_id}/native-device-configs/challenge")
def native_device_config_challenge(publication_id:str,body:NativeDeviceConfigChallengeIn,request:Request,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request)
    from platform_v8.services.workers.native_h3_device_configs import challenge
    try:return challenge(session,publication_id=publication_id,owner_id=current.id,**body.model_dump())
    except (publication_svc.PublicationError,ValueError) as exc:
        _raise(exc if isinstance(exc,publication_svc.PublicationError) else publication_svc.PublicationError('配置登记挑战无效'))


@router.post("/{publication_id}/native-device-configs/register")
def native_device_config_register(publication_id:str,body:NativeDeviceRegisterIn,request:Request,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request)
    from platform_v8.services.workers.native_h3_device_configs import register
    try:return register(session,publication_id=publication_id,owner_id=current.id,**body.model_dump())
    except (publication_svc.PublicationError,ValueError) as exc:
        _raise(exc if isinstance(exc,publication_svc.PublicationError) else publication_svc.PublicationError('配置登记回执无效'))


@router.post("/native-device-keys/challenge")
def native_device_challenge(body:NativeDeviceChallengeIn,request:Request,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request)
    from platform_v8.services.workers.native_h3_device_keys import challenge
    try:
        return challenge(session,owner_id=current.id,**body.model_dump())
    except (publication_svc.PublicationError,ValueError) as exc:
        _raise(exc) if isinstance(exc,publication_svc.PublicationError) else _raise(publication_svc.PublicationError(str(exc)))


@router.post("/native-device-keys/register")
def native_device_register(body:NativeDeviceRegisterIn,request:Request,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request)
    from platform_v8.services.workers.native_h3_device_keys import register
    try:
        return register(session,owner_id=current.id,**body.model_dump())
    except publication_svc.PublicationError as exc:
        _raise(exc)


@router.get("/native-review-samples/pending")
def pending_native_review(worker_id:str,request:Request,binding_version:Literal[1,2]=1,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request)
    from platform_v8.services.workers.native_h3_review_samples import pending
    if binding_version==2:
        from platform_v8.services.workers.native_h3_review_samples_v2 import pending
    try:
        return pending(session,owner_id=current.id,worker_id=worker_id)
    except publication_svc.PublicationError as exc:
        _raise(exc)


@router.post("/{publication_id}/native-review-samples/start")
def start_native_review(publication_id:str,body:NativeReviewStartIn,request:Request,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request)
    from platform_v8.services.workers.native_h3_versions import review_start as start
    try:
        return start(session,publication_id=publication_id,owner_id=current.id,**body.model_dump())
    except publication_svc.PublicationError as exc:
        _raise(exc)


@router.post("/{publication_id}/native-review-samples/restart")
def restart_native_review(publication_id:str,body:NativeReviewStartIn,request:Request,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request)
    from platform_v8.services.workers.native_h3_versions import review_restart as restart
    try:
        return restart(session,publication_id=publication_id,owner_id=current.id,**body.model_dump())
    except publication_svc.PublicationError as exc:
        _raise(exc)


@router.post("/{publication_id}/native-review-samples/{nonce}/upload-intent")
def native_review_upload(publication_id:str,nonce:str,body:NativeReviewUploadIn,request:Request,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request)
    from platform_v8.services.workers.native_h3_versions import review_upload as upload_intent
    try:
        return upload_intent(session,publication_id=publication_id,nonce=nonce,owner_id=current.id,**body.model_dump())
    except publication_svc.PublicationError as exc:
        _raise(exc)


@router.post("/{publication_id}/native-review-samples/{nonce}/report")
async def native_review_report(publication_id:str,nonce:str,request:Request,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request)
    data=bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data)>48*1024:
            raise HTTPException(413,"native metadata too large")
    try:
        from fastapi.concurrency import run_in_threadpool
        from platform_v8.services.workers.native_h3_versions import review_report as report
        body=json.loads(data)
        if not isinstance(body,dict) or set(body)!={"execution"}:
            raise ValueError("execution envelope required")
        return await run_in_threadpool(report,session,publication_id=publication_id,owner_id=current.id,
            nonce=nonce,execution_receipt=body['execution'])
    except publication_svc.PublicationError as exc:
        _raise(exc)
    except (ValueError,TypeError,InvalidSignature) as exc:
        raise HTTPException(400,"invalid native execution metadata") from exc


class NativeProofRequestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    worker_id:str = Field(min_length=1,max_length=36)
    challenge_nonce:str = Field(min_length=43,max_length=43)


@router.post("/{publication_id}/native-device-proof/request")
def request_native_device_proof(publication_id:str,body:NativeProofRequestIn,request:Request,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request)
    from platform_v8.services.workers.native_h3_versions import implementation
    sample_module=implementation(session,publication_id,'review_samples')
    service,_job=sample_module.service,sample_module._job
    from platform_v8.services.workers.native_h3_versions import deposit
    try:
        row,job=_job(session,publication_id=publication_id,owner_id=current.id,nonce=body.challenge_nonce)
        if (job['device_id']!=body.worker_id or job['status'] not in ({'decoded','verified'} if row['contract_version']=='v2' else {'decoded'}) or row['status']!='approved'
            or publication_svc._issues(session,row,row['review_evidence'] or {},reviewer_id=row['reviewer_id'],require_runtime_pin=True)):
            raise publication_svc.PublicationConflict("当前制品尚未真正批准或样例设备不一致")
        proof=service('/native-h3/device-proof',{'schema':'qianshou.native-h3-device-proof-request.'+row['contract_version'],
            'publication_id':publication_id,'device_id':body.worker_id,'challenge_nonce':body.challenge_nonce})
        return deposit(session,publication_id=publication_id,receipt=proof)
    except publication_svc.PublicationError as exc:
        _raise(exc)


def _native_service_auth(request:Request):
    token=os.getenv("V8_NATIVE_H3_REGISTRY_READER_TOKEN","")
    if not 32<=len(token)<=2048 or not hmac.compare_digest(request.headers.get("authorization",""),"Bearer "+token):
        raise HTTPException(401,"unauthorized")


@internal_router.get("/native-device-keys/{worker_id}/{key_id}")
def read_native_device_key(worker_id:str,key_id:str,owner_id:int,request:Request,
    session:Session=Depends(get_session)):
    _native_service_auth(request)
    from platform_v8.services.workers.native_h3_device_keys import active_key
    try:
        return active_key(session,owner_id=owner_id,worker_id=worker_id,key_id=key_id)
    except publication_svc.PublicationError as exc:
        _raise(exc)


@internal_router.get("/{publication_id}/native-config-context")
def native_config_context(publication_id:str,worker_id:str,request:Request,session:Session=Depends(get_session)):
    _native_service_auth(request)
    from platform_v8.services.workers.native_h3_device_configs import enrollment_context
    try:return enrollment_context(session,publication_id=publication_id,worker_id=worker_id)
    except publication_svc.PublicationError as exc:_raise(exc)


@internal_router.get("/{publication_id}/native-device-config-context")
def native_current_config_context(publication_id:str,worker_id:str,request:Request,session:Session=Depends(get_session)):
    _native_service_auth(request)
    from platform_v8.services.workers.native_h3_device_configs import current_config
    try:
        row=publication_svc._get(session,publication_id)
        config,key_id=current_config(session,row=row,worker_id=worker_id)
        return {**config,'key_id':key_id}
    except publication_svc.PublicationError as exc:_raise(exc)


@internal_router.get("/{publication_id}/native-approved-context")
def native_approved_context(publication_id:str,worker_id:str,request:Request,
    session:Session=Depends(get_session)):
    _native_service_auth(request)
    from platform_v8.services.workers.native_h3_versions import approved_context
    try:
        return approved_context(session,publication_id=publication_id,worker_id=worker_id)
    except publication_svc.PublicationError as exc:
        _raise(exc)


class NativePresenceReportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    worker_id: str = Field(min_length=1,max_length=36)
    challenge_nonce: str = Field(min_length=43,max_length=43)
    signature: str = Field(min_length=86,max_length=86)


@router.post("/{publication_id}/native-device-presence/challenge")
def native_presence_challenge(publication_id:str,body:NativeReviewStartIn,request:Request,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request)
    from platform_v8.services.workers.native_h3_versions import presence_challenge as challenge
    try:
        return challenge(session,publication_id=publication_id,owner_id=current.id,**body.model_dump())
    except (ValueError,InvalidSignature) as exc:
        _raise(exc if isinstance(exc,publication_svc.PublicationError) else publication_svc.PublicationError('续签挑战无效'))


@router.post("/{publication_id}/native-device-presence/report")
def native_presence_report(publication_id:str,body:NativePresenceReportIn,request:Request,
    current:Account=Depends(get_current_account),session:Session=Depends(get_session)):
    _jwt_only(request)
    from platform_v8.services.workers.native_h3_versions import presence_report as report
    try:
        return report(session,publication_id=publication_id,owner_id=current.id,**body.model_dump())
    except (ValueError,InvalidSignature) as exc:
        _raise(exc if isinstance(exc,publication_svc.PublicationError) else publication_svc.PublicationError('续签回执无效'))


@internal_router.get("/native-presence-observations/{nonce}")
def native_presence_observation(nonce:str,request:Request,session:Session=Depends(get_session)):
    _native_service_auth(request)
    from platform_v8.services.workers.native_h3_versions import observation
    try:
        return observation(session,nonce=nonce)
    except (ValueError,InvalidSignature) as exc:
        _raise(exc if isinstance(exc,publication_svc.PublicationError) else publication_svc.PublicationError('续签连接观察无效'))


@router.get("/native-proof-trust")
def native_proof_trust(request:Request,response:Response,current:Account=Depends(get_current_account)):
    """Only configured operator public keys, never request-supplied keys or embedded proof keys."""
    _jwt_only(request)
    response.headers["Cache-Control"]="no-store"
    from platform_v8.services.workers.native_h3_presence import public_trust
    try:
        return public_trust()
    except publication_svc.PublicationError as exc:
        _raise(exc)


@router.get("/native-bindings", summary="当前账号设备的已审核原生H3绑定")
def native_bindings(worker_id: str, response: Response, binding_version:Literal[1,2]=1,
                    session: Session = Depends(get_session),
                    current: Account = Depends(get_current_account)) -> dict[str, Any]:
    from platform_v8.services.workers.native_h3_bindings import current_bindings
    if binding_version==2:
        from platform_v8.services.workers.native_h3_bindings_v2 import current_bindings
    response.headers["Cache-Control"] = "no-store"
    try:
        return current_bindings(session, owner_id=current.id, worker_id=worker_id)
    except publication_svc.PublicationError as exc:
        _raise(exc)


@internal_router.post("/{publication_id}/native-device-proof", summary="独立原生H3设备签名回执")
async def native_device_proof(publication_id: str, request: Request,
                              authorization: str | None = Header(default=None),
                              session: Session = Depends(get_session)) -> dict[str, Any]:
    token = os.getenv("V8_NATIVE_H3_DEVICE_PROOF_INGRESS_TOKEN", "")
    if (not 32 <= len(token) <= 2048 or not isinstance(authorization, str)
            or not hmac.compare_digest(authorization, "Bearer " + token)):
        raise HTTPException(status_code=403, detail="独立原生H3设备签发服务未授权")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > 16384:
            raise HTTPException(status_code=413, detail="原生H3设备回执过大")
    try:
        from platform_v8.services.workers.native_h3_bindings import deposit
        value = json.loads(data)
        return deposit(session, publication_id=publication_id, receipt=value)
    except (ValueError, TypeError) as exc:
        if isinstance(exc, publication_svc.PublicationError):
            _raise(exc)
        raise HTTPException(status_code=400, detail="原生H3设备回执无效") from exc


def _sample_raise(exc: publication_svc.PublicationError) -> None:
    if isinstance(exc, publication_svc.PublicationNotFound):
        code = 404
    elif isinstance(exc, sample_svc.ReviewSampleUnavailable):
        code = 503
    else:
        code = 409
    raise HTTPException(status_code=code, detail=str(exc)) from exc


@router.post("/{publication_id}/review-samples/start",
             summary="作者一键启动零预算、不可结算的真实独立审核样单")
def start_review_samples(
    publication_id: str, request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    try:
        row = publication_svc._get(session, publication_id, lock=True)
        if row["owner_id"] != current.id:
            raise publication_svc.PublicationNotFound("接单技能投稿不存在")
        definition = row.get("task_definition")
        if (isinstance(definition, dict)
                and isinstance(definition.get("nativeBinding"), dict)
                and definition["nativeBinding"].get("runtimeAbi")
                    in ("qianshou.order-runtime.native-h3.v1", "qianshou.order-runtime.native-h3.v2")):
            # Verify the locked author's exact definition, without fetching media
            # or falling back to the unrelated generic GIF/MP4 recipe.
            publication_svc.package_snapshot_for_issuer(session, publication_id)
            raise publication_svc.PublicationConflict(
                "此技能使用本机H3双样例审核，请从当前接单设备启动原生审核")
        return sample_svc.start(session, publication_id=publication_id,
                                owner_id=current.id)
    except publication_svc.PublicationError as exc:
        _sample_raise(exc)


@router.get("/{publication_id}/review-samples",
            summary="作者查看双样单与签名媒体验收状态")
def review_sample_status(
    publication_id: str, request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    try:
        return sample_svc.status(session, publication_id=publication_id,
                                 owner_id=current.id)
    except publication_svc.PublicationError as exc:
        _raise(exc)


@admin_router.post("/review-runner/{worker_id}/enroll",
                   summary="管理员将暂停且无在途任务的固定节点登记为独立审核节点")
def enroll_review_runner(
    worker_id: str, body: ReviewWorkerEnrollIn, request: Request,
    admin: Account = Depends(get_admin_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    try:
        return sample_svc.enroll_review_worker(
            session, worker_id=worker_id, owner_id=body.owner_id,
            admin_id=admin.id)
    except sample_svc.ReviewSampleError as exc:
        _sample_raise(exc)


@admin_router.post("/review-runner/{worker_id}/revoke",
                   summary="管理员在审核节点暂停且无在途分片后撤销专用隔离")
def revoke_review_runner(
    worker_id: str, body: ReviewWorkerEnrollIn, request: Request,
    admin: Account = Depends(get_admin_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    try:
        return sample_svc.revoke_review_worker(
            session, worker_id=worker_id, owner_id=body.owner_id,
            admin_id=admin.id)
    except sample_svc.ReviewSampleError as exc:
        _sample_raise(exc)


def _review_runner_authorized(authorization: str | None) -> bool:
    token = os.environ.get("V8_TASK_ADAPTER_REVIEW_RUNNER_TOKEN", "")
    return (isinstance(authorization, str) and 32 <= len(token) <= 2048
            and hmac.compare_digest(authorization, "Bearer " + token))


@internal_router.post("/review-samples/heartbeat",
                      summary="独立审核计算节点刷新固定平台注册节点心跳")
def heartbeat_review_runner(
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if not _review_runner_authorized(authorization):
        raise HTTPException(status_code=403, detail="独立审核 runner 未授权")
    try:
        return sample_svc.heartbeat(session)
    except sample_svc.ReviewSampleError as exc:
        _sample_raise(exc)


@internal_router.get("/review-samples/pending",
                     summary="独立 Mac 审核计算节点领取未派入生产队列的待验样单索引")
def pending_review_samples(
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if not _review_runner_authorized(authorization):
        raise HTTPException(status_code=403, detail="独立审核 runner 未授权")
    try:
        return sample_svc.pending(session)
    except sample_svc.ReviewSampleError as exc:
        _sample_raise(exc)


@internal_router.post("/{publication_id}/review-samples/{fmt}/lease",
                      summary="独立 Mac 审核计算节点领取真实审核分片租约")
def lease_review_sample(
    publication_id: str, fmt: str,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if not _review_runner_authorized(authorization):
        raise HTTPException(status_code=403, detail="独立审核 runner 未授权")
    try:
        return sample_svc.lease(session, publication_id=publication_id, fmt=fmt)
    except sample_svc.ReviewSampleError as exc:
        _sample_raise(exc)


@internal_router.post("/{publication_id}/review-samples/{fmt}/upload-intent",
                      summary="真实审核分片同期签名固定键媒体上传及发行回执")
def review_sample_upload_intent(
    publication_id: str, fmt: str, body: ReviewSampleUploadIn,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if not _review_runner_authorized(authorization):
        raise HTTPException(status_code=403, detail="独立审核 runner 未授权")
    try:
        return sample_svc.upload_intent(session, publication_id=publication_id,
                                        fmt=fmt, **body.model_dump())
    except sample_svc.ReviewSampleError as exc:
        _sample_raise(exc)


@internal_router.post("/{publication_id}/review-samples/{fmt}/verify",
                      summary="只读精确媒体版本并由广州独立签发逐单回执")
def review_sample_verify(
    publication_id: str, fmt: str, body: ReviewSampleVerifyIn,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if not _review_runner_authorized(authorization):
        raise HTTPException(status_code=403, detail="独立审核 runner 未授权")
    try:
        return sample_svc.verify(session, publication_id=publication_id,
                                 fmt=fmt, **body.model_dump())
    except sample_svc.ReviewSampleError as exc:
        _sample_raise(exc)


@internal_router.get("/{publication_id}/review-samples/verified-pair",
                     summary="广州独立 runner 读取两份已验证样单原始控制证据")
def review_sample_verified_pair(
    publication_id: str,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if not _review_runner_authorized(authorization):
        raise HTTPException(status_code=403, detail="独立审核 runner 未授权")
    try:
        return sample_svc.verified_pair(session, publication_id=publication_id)
    except sample_svc.ReviewSampleError as exc:
        _sample_raise(exc)


@internal_router.post("/{publication_id}/review-samples/finalize",
                      summary="广州独立验包验媒体通过后原子归档签名媒体验收")
def finalize_review_samples(
    publication_id: str, body: ReviewSampleFinalizeIn,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if not _review_runner_authorized(authorization):
        raise HTTPException(status_code=403, detail="独立审核 runner 未授权")
    try:
        return sample_svc.finalize(session, publication_id=publication_id,
                                   runner_attestation=body.runner_attestation)
    except publication_svc.PublicationError as exc:
        _sample_raise(exc)


def _review_snapshot_authorized(kind: str | None, authorization: str | None) -> bool:
    if kind not in {"security", "contract"} or not isinstance(authorization, str):
        return False
    raw = os.environ.get("V8_TASK_PUBLICATION_REVIEW_SNAPSHOT_TOKENS", "")
    if not raw or len(raw) > 8192:
        return False
    try:
        tokens = json.loads(raw)
        if (not isinstance(tokens, dict) or set(tokens) != {"security", "contract"}
                or any(not isinstance(value, str) or not 32 <= len(value) <= 2048
                       for value in tokens.values())
                or tokens["security"] == tokens["contract"]):
            return False
        return hmac.compare_digest(authorization, "Bearer " + tokens[kind])
    except (TypeError, ValueError):
        return False


def _pending_review_authorized(kind: str, authorization: str | None) -> bool:
    if kind not in {"package", "security", "contract", "sample"} or not isinstance(authorization, str):
        return False
    raw = os.environ.get("V8_TASK_PUBLICATION_PENDING_REVIEW_TOKENS", "")
    if not raw or len(raw) > 8192:
        return False
    try:
        tokens = json.loads(raw)
        if (not isinstance(tokens, dict)
                or set(tokens) not in ({"package", "security", "contract"},
                                       {"package", "security", "contract", "sample"})
                or kind not in tokens
                or any(not isinstance(value, str) or not 32 <= len(value) <= 2048
                       for value in tokens.values())
                or len(set(tokens.values())) != len(tokens)):
            return False
        return hmac.compare_digest(authorization, "Bearer " + tokens[kind])
    except (TypeError, ValueError):
        return False


@internal_router.get("/pending-review",
                     summary="独立签发服务按用途只读领取待审 UUID 索引")
def pending_review_for_issuer(
    kind: Literal["package", "security", "contract", "sample"],
    response: Response,
    cursor: str | None = None,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if not _pending_review_authorized(kind, authorization):
        raise HTTPException(status_code=403, detail="独立审核队列读取方未授权")
    response.headers["Cache-Control"] = "no-store"
    try:
        return publication_svc.pending_review_index(session, kind=kind, cursor=cursor)
    except publication_svc.PublicationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@internal_router.get("/{publication_id}/review-snapshot",
                     summary="独立审查服务读取服务端当前投稿与验签不可变包快照")
def publication_review_snapshot(
    publication_id: str,
    authorization: str | None = Header(default=None),
    x_qianshou_review_kind: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if not _review_snapshot_authorized(x_qianshou_review_kind, authorization):
        raise HTTPException(status_code=403, detail="独立审查快照调用方未授权")
    from platform_v8.services.workers import task_adapter_review_issuer
    try:
        return task_adapter_review_issuer.review_snapshot(session, publication_id)
    except task_adapter_review_issuer.ReviewEvidenceError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@internal_router.get("/{publication_id}/revalidation-snapshot",
                     summary="广州独立复验读取已审稿原始样单及精确锁定版本元数据")
def publication_revalidation_snapshot(
    publication_id: str,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    token = os.environ.get("V8_TASK_PUBLICATION_REVALIDATION_SNAPSHOT_TOKEN", "")
    if (not 32 <= len(token) <= 2048 or not isinstance(authorization, str)
            or not hmac.compare_digest(authorization, "Bearer " + token)):
        raise HTTPException(status_code=403, detail="独立复验快照调用方未授权")
    from platform_v8.services.workers import task_adapter_revalidation
    try:
        return task_adapter_revalidation.snapshot(session, publication_id)
    except publication_svc.PublicationError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/readiness/{task_type}", summary="任务接单发布状态（只读，实时复核）")
def publication_readiness(
    task_type: str,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    return publication_svc.readiness(session, task_type, owner_id=current.id)


@admin_router.get("/review-capabilities", summary="当前账号的市场审核写授权")
def review_capabilities(
    request: Request,
    current: Account = Depends(get_current_account),
) -> dict[str, Any]:
    """Report the same account flag required by existing review write routes."""
    _jwt_only(request)
    return {"schema": "qianshou.market-review-capabilities.v1",
            "account_id": current.id, "review_authorized": bool(current.is_admin)}


@admin_router.get("/pending", summary="管理员待审接单适配器队列")
def pending_publications(
    request: Request,
    admin: Account = Depends(get_market_queue_reader),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    return publication_svc.pending(session, reviewer_id=admin.id)


@internal_router.post("/{publication_id}/evidence/{kind}",
                      summary="独立签发方存入用途隔离的签名审核回执")
def deposit_publication_evidence(
    publication_id: str,
    kind: str,
    body: EvidenceIn,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if not publication_svc.issuer_authorized(kind, authorization):
        raise HTTPException(status_code=403, detail="审核回执签发方未授权")
    try:
        return publication_svc.deposit_evidence(session, publication_id=publication_id,
                                                kind=kind, receipt=body.receipt,
                                                revalidation_material=body.revalidation_material)
    except publication_svc.PublicationError as exc:
        _raise(exc)


@internal_router.get("/{publication_id}/package-snapshot",
                     summary="独立 v5 验包方读取已确认锁版归档与作者签名控制元数据")
def package_snapshot_for_issuer(
    publication_id: str,
    response: Response,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    token = os.environ.get("V8_TASK_PUBLICATION_PACKAGE_SNAPSHOT_TOKEN", "")
    if (not isinstance(authorization, str) or not 32 <= len(token) <= 2048
            or not hmac.compare_digest(authorization, "Bearer " + token)):
        raise HTTPException(status_code=403, detail="独立验包快照读取方未授权")
    response.headers["Cache-Control"] = "no-store"
    try:
        return publication_svc.package_snapshot_for_issuer(session, publication_id)
    except publication_svc.PublicationError as exc:
        _raise(exc)


@internal_router.get("/{publication_id}/sample-snapshot",
                     summary="独立样例签发方读取已验包的受控投稿快照")
def sample_snapshot_for_issuer(
    publication_id: str,
    response: Response,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    token = os.environ.get("V8_TASK_PUBLICATION_SAMPLE_SNAPSHOT_TOKEN", "")
    if (not isinstance(authorization, str) or not 32 <= len(token) <= 2048
            or not hmac.compare_digest(authorization, "Bearer " + token)):
        raise HTTPException(status_code=403, detail="独立样例快照读取方未授权")
    response.headers["Cache-Control"] = "no-store"
    try:
        return publication_svc.sample_snapshot_for_issuer(session, publication_id)
    except publication_svc.PublicationError as exc:
        _raise(exc)


@admin_router.post("/{publication_id}/approve", summary="管理员核验可信证据后批准")
def approve_publication(
    publication_id: str,
    body: ApproveIn,
    request: Request,
    admin: Account = Depends(get_admin_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    try:
        return publication_svc.approve(session, publication_id=publication_id,
                                       reviewer_id=admin.id, note=body.note)
    except publication_svc.PublicationError as exc:
        _raise(exc)


@admin_router.post("/{publication_id}/reject", summary="管理员驳回接单适配器投稿")
def reject_publication(
    publication_id: str,
    body: RejectIn,
    request: Request,
    admin: Account = Depends(get_admin_account),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _jwt_only(request)
    try:
        return publication_svc.reject(session, publication_id=publication_id,
                                      reviewer_id=admin.id, note=body.note)
    except publication_svc.PublicationError as exc:
        _raise(exc)
