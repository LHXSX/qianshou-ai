"""
开发者 API · /api/v8/developer/*

企业账号管理长期 API Key · 用 Bearer qs_... 调用现有 /files /workloads。
不新增推理引擎；不改 submit / 调度。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import uuid
from decimal import Decimal
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from pydantic_core import PydanticCustomError
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session, require_scope
from platform_v8.api.rate_limit import rate_limit
from platform_v8.services.result_envelope import normalize_result_envelope
from platform_v8.core import Account
from platform_v8.engine.task_registry import (
    TaskMode,
    compute_origin_fields,
    get_developer_spec,
    input_file_limits,
    list_developer_specs,
    resolve_tier_routing,
)
from platform_v8.storage.repo import (
    API_KEY_MAX_PER_ACCOUNT,
    API_KEY_ALLOWED_SCOPES,
    ApiKeyRepo,
    AuditRepo,
    DeveloperTaskRepo,
    WorkloadRepo,
    audit_t,
)
from platform_v8.services.workloads import submit as submit_svc
from platform_v8.services.storage_refs import (
    StorageReferenceError,
    is_protected_media_result_ref,
    materialize_get_url,
    validate_owned_object_key,
)
from platform_v8.services.archive_normalization_jobs import (
    start_submitted_workload,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/developer", tags=["developer"])

_PDF_KEY_RE = re.compile(r"^(?:v8/account-|uploads/tenant_)(\d+)/")
_MEDIA_EXTENSIONS = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm",
    "video/quicktime": "mov",
}


class ApiKeyCreateIn(BaseModel):
    name: str = Field(default="", max_length=100, description="Key 名称 · 仅展示")
    scopes: list[str] = Field(default_factory=list, description="files/workloads/results/webhooks")
    expires_days: int | None = Field(
        default=None,
        ge=1,
        le=3650,
        description="多少天后失效；None=永久",
    )

    @field_validator("scopes")
    @classmethod
    def validate_scopes(cls, value: list[str]) -> list[str]:
        normalized = list(dict.fromkeys(str(scope).strip().lower() for scope in value if str(scope).strip()))
        invalid = sorted(set(normalized) - API_KEY_ALLOWED_SCOPES)
        if invalid:
            raise PydanticCustomError(
                "api_key_scope",
                f"不支持的 API Key scope: {','.join(invalid)}",
            )
        return normalized


class PdfTextCreateIn(BaseModel):
    """开发者 PDF 转文本任务。

    文件须先走 ``POST /api/v8/files/upload-url`` 上传；避免把大二进制经 API
    进程转发。单文件填 ``input_ref``，多文件填 ``input_refs``。
    """

    input_ref: str = ""
    input_refs: list[str] = Field(default_factory=list, max_length=100)
    name: str = Field(default="PDF 转文本", min_length=1, max_length=255)
    mode: str = Field(default="auto", pattern="^(auto|text|ocr)$")
    language: str = Field(default="ch", max_length=16)
    page_range: str = Field(default="", max_length=200)
    output_format: str = Field(default="txt", pattern="^(txt|md|both)$")
    callback_url: str = Field(default="", max_length=2048)
    callback_secret: str = Field(default="", max_length=512)
    idempotency_key: str = Field(default="", max_length=128)
    budget: Decimal = Field(default=Decimal("0.50"), ge=0)
    quote_token: str | None = Field(default=None, max_length=4096)


class DeveloperUploadURLIn(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(default="application/octet-stream", max_length=255)
    size_bytes: int = Field(ge=1, le=2 * 1024 * 1024 * 1024)
    sha256: str = Field(default="", pattern=r"^(?:[0-9a-fA-F]{64})?$")


class DeveloperFileCompleteIn(BaseModel):
    object_key: str = Field(min_length=1, max_length=2048)
    size_bytes: int = Field(ge=1, le=2 * 1024 * 1024 * 1024)
    sha256: str = Field(default="", pattern=r"^(?:[0-9a-fA-F]{64})?$")
    content_type: str = Field(default="application/octet-stream", max_length=255)


class DeveloperTaskCreateIn(BaseModel):
    task_type: str = Field(min_length=1, max_length=100)
    input_kind: str = Field(min_length=1, max_length=30)
    input_ref: str = Field(default="", max_length=2048)
    input_refs: list[str] = Field(default_factory=list, max_length=100)
    inline_input: str | None = Field(default=None, max_length=1_000_000)
    params: dict[str, Any] = Field(default_factory=dict)
    name: str = Field(default="", max_length=255)
    budget: Decimal = Field(default=Decimal("0.50"), ge=0)
    quote_token: str | None = Field(default=None, max_length=4096)
    timeout_s: int = Field(default=300, ge=1, le=3600)
    max_shards: int = Field(default=1, ge=1, le=100)
    auto_shard: bool = True
    idempotency_key: str = Field(min_length=1, max_length=128)
    callback_url: str = Field(default="", max_length=2048)
    callback_secret: str = Field(default="", max_length=512)


def _owned_object_key_prefix(account_id: int) -> str:
    return f"v8/account-{account_id}/"


def _validate_owned_object_key(account_id: int, object_key: str) -> str:
    try:
        return validate_owned_object_key(account_id, object_key)
    except StorageReferenceError as exc:
        raise HTTPException(
            status_code=403,
            detail=str(exc),
        ) from exc


def _completed_object_key(session: Session, account_id: int, object_key: str) -> bool:
    row = session.execute(
        select(audit_t.c.id)
        .where(
            audit_t.c.action == "developer.file.complete",
            audit_t.c.actor_account_id == account_id,
            audit_t.c.target_id == object_key,
        )
        .limit(1)
    ).first()
    return row is not None


def _presigned_url(value: Any) -> str:
    if hasattr(value, "url"):
        return str(value.url)
    if isinstance(value, dict):
        return str(value.get("url") or "")
    return str(value)


def _presign_input_refs(object_keys: list[str], *, timeout_s: int) -> list[str]:
    """Compatibility wrapper: materialize stable keys for an immediate response."""
    if not object_keys:
        return []
    try:
        expires = max(86400, min(7 * 86400, int(timeout_s) + 3600))
        owner_match = _PDF_KEY_RE.match(object_keys[0])
        if owner_match is None:
            raise StorageReferenceError("无法确定 object_key 归属")
        owner_id = int(owner_match.group(1))
        urls = [materialize_get_url(owner_id, key, expires) for key in object_keys]
    except Exception as exc:
        logger.warning("developer.task input presign failed: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="OSS input signing unavailable") from exc
    return urls


def _head_uploaded_object(object_key: str, expected_size: int, expected_sha256: str) -> dict[str, Any]:
    """通过 provider HEAD 校验对象，绝不把大文件回流到 API 进程。"""
    try:
        from platform_v8.services.oss_provider import get_oss_provider

        metadata = get_oss_provider().head_object(object_key)
        if not metadata:
            raise HTTPException(status_code=422, detail="OSS 对象不存在或元数据不可读")
        actual_size = int(metadata.get("size_bytes") or 0)
        if actual_size <= 0:
            raise HTTPException(status_code=422, detail="OSS HEAD 未返回有效文件大小")
        if actual_size != expected_size:
            raise HTTPException(
                status_code=422,
                detail=f"文件大小不匹配: expected={expected_size}, actual={actual_size}",
            )

        actual_sha256 = str(metadata.get("sha256") or "").lower()
        if expected_sha256:
            expected = expected_sha256.lower()
            if not actual_sha256:
                raise HTTPException(status_code=422, detail="OSS 未返回可验证 SHA256 元数据")
            if not hmac.compare_digest(actual_sha256, expected):
                raise HTTPException(status_code=422, detail="文件 SHA256 不匹配")
        return {"size_bytes": actual_size, "sha256": actual_sha256,
                "object_version_id": metadata.get("object_version_id")}
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("developer.file.complete 校验失败 key=%s: %s", object_key, exc)
        raise HTTPException(status_code=503, detail=f"OSS verify unavailable: {exc}") from exc


def _validate_task_input(
    session: Session,
    account_id: int,
    body: DeveloperTaskCreateIn,
) -> tuple[Any, list[str]]:
    spec = get_developer_spec(body.task_type)
    if spec is None:
        from platform_v8.services.workers.task_adapter_publications import callable_task_spec
        spec = callable_task_spec(session, body.task_type)
    if spec is None:
        raise HTTPException(status_code=422, detail="任务类型尚无可调用的已审核能力")
    if spec.mode != TaskMode.ONESHOT:
        raise HTTPException(status_code=422, detail="开发者任务仅支持 oneshot 模式")
    if body.input_kind == "stream":
        raise HTTPException(status_code=422, detail="stream 输入暂未开放")
    if body.input_kind not in spec.accepted_input_kinds:
        raise HTTPException(
            status_code=422,
            detail=f"input_kind 不受支持；允许: {list(spec.accepted_input_kinds)}",
        )

    refs: list[str] = []
    inline_present = body.inline_input is not None
    if body.input_kind == "inline":
        if not inline_present or body.input_ref or body.input_refs:
            raise HTTPException(status_code=422, detail="inline 只允许且必须提供 inline_input")
    elif body.input_kind in {"single_file", "archive"}:
        if not body.input_ref or body.input_refs or inline_present:
            raise HTTPException(
                status_code=422,
                detail=f"{body.input_kind} 只允许且必须提供 input_ref",
            )
        refs = [_validate_owned_object_key(account_id, body.input_ref)]
    elif body.input_kind == "multi_file":
        if body.input_ref or not body.input_refs or inline_present:
            raise HTTPException(status_code=422, detail="multi_file 只允许且必须提供 input_refs")
        refs = [_validate_owned_object_key(account_id, ref) for ref in body.input_refs]
        if len(set(refs)) != len(refs):
            raise HTTPException(status_code=422, detail="input_refs 不允许重复")
    elif body.input_kind == "params_only":
        if body.input_ref or body.input_refs or inline_present:
            raise HTTPException(status_code=422, detail="params_only 不允许携带文件或 inline_input")

    for object_key in refs:
        if not _completed_object_key(session, account_id, object_key):
            raise HTTPException(
                status_code=409,
                detail=f"文件尚未 complete: {object_key}",
            )
    return spec, refs


def _task_fingerprint(body: DeveloperTaskCreateIn) -> str:
    payload = body.model_dump(mode="json")
    # The quote is issued for this fingerprint, so its token cannot itself be
    # part of the fingerprint. Budget is confirmed after the quote is shown;
    # it is checked separately by submit_workload against the signed price.
    payload.pop("quote_token", None)
    payload.pop("budget", None)
    payload["callback_secret"] = hashlib.sha256(
        body.callback_secret.encode("utf-8")
    ).hexdigest() if body.callback_secret else ""
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _task_spec_dict(body: DeveloperTaskCreateIn, task_spec: Any,
                    refs: list[str]) -> dict[str, Any]:
    """One exact workload spec for both developer estimate and create."""
    params = dict(body.params)
    params.update({
        "_developer_api_version": "task.v1",
        "_developer_idempotency_key": body.idempotency_key,
        "_developer_idempotency_fingerprint": _task_fingerprint(body),
        "_developer_webhook_configured": bool(body.callback_url),
    })
    return {
        "kind": "DATA_PROCESSING",
        "task_type": task_spec.task_type,
        "runtime": task_spec.runtimes[0] if task_spec.runtimes else "python3",
        "input_kind": body.input_kind,
        "input_ref": refs[0] if body.input_kind in {"single_file", "archive"} else "",
        "input_refs": refs if body.input_kind == "multi_file" else [],
        "inline_input": body.inline_input if body.input_kind == "inline" else None,
        "params": params,
        "timeout_s": body.timeout_s,
        "max_shards": body.max_shards,
        "auto_shard": body.auto_shard,
    }


def _lock_idempotency(session: Session, account_id: int, idempotency_key: str) -> None:
    bind = session.get_bind()
    if bind.dialect.name != "postgresql":
        return
    digest = hashlib.sha256(f"{account_id}:{idempotency_key}".encode()).digest()
    lock_key = int.from_bytes(digest[:8], byteorder="big", signed=True)
    session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_key})


def _task_urls(workload_id: str) -> dict[str, str]:
    base = f"/api/v8/developer/tasks/{workload_id}"
    return {
        "status_url": base,
        "result_url": f"{base}/result",
        "download_url": f"{base}/download",
    }


def _task_status_payload(workload: Any) -> dict[str, Any]:
    result = {
        "ok": True,
        "id": str(workload.id),
        "task_id": str(workload.id),
        "workload_id": str(workload.id),
        "name": workload.name,
        "task_type": workload.spec.task_type,
        "status": workload.status.value,
        "progress": workload.progress,
        "total_shards": workload.total_shards,
        "completed_shards": workload.completed_shards,
        "failed_shards": workload.failed_shards,
        "error": workload.error or None,
        "created_at": workload.created_at.isoformat() if workload.created_at else None,
        "completed_at": workload.completed_at.isoformat() if workload.completed_at else None,
    }
    result.update(_task_urls(str(workload.id)))
    return result


def _validate_owned_pdf_refs(account_id: int, refs: list[str]) -> None:
    if not refs:
        raise HTTPException(status_code=422, detail="至少提供一个 input_ref / input_refs")
    for ref in refs:
        key = _validate_owned_object_key(account_id, ref)
        if not key.lower().endswith(".pdf"):
            raise HTTPException(status_code=422, detail="仅支持 .pdf 输入文件")


def _validate_callback_url(url: str) -> str:
    if not url:
        return ""
    parsed = urlparse(url)
    # 完整 SSRF 防护还在投递阶段解析 DNS；这里先阻止非 HTTPS/无 host。
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(status_code=422, detail="callback_url 必须是无凭据的 HTTPS URL")
    hostname = parsed.hostname.lower()
    if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(".local"):
        raise HTTPException(status_code=422, detail="callback_url 禁止 localhost / .local")
    return url


def _require_api_key_scope(request: Request, scope: str) -> None:
    if getattr(request.state, "auth_via", None) != "api_key":
        return
    scopes = {
        str(value).strip().lower()
        for value in (getattr(request.state, "api_key_scopes", None) or [])
    }
    if "*" not in scopes and scope not in scopes:
        raise HTTPException(status_code=403, detail=f"API Key 缺少权限: {scope}")


async def _start_workload(workload_id: str) -> None:
    try:
        await start_submitted_workload(workload_id)
    except Exception:
        logger.exception("developer.task 启动 workload 失败 id=%s", workload_id)


@router.get(
    "/keys",
    summary="API Key 列表（不含明文）",
    dependencies=[Depends(rate_limit("developer_keys_list", per_minute=60, key="uid"))],
)
def list_keys(
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    items = ApiKeyRepo.list_for_account(session, current.id)
    return {"ok": True, "items": items, "total": len(items)}


@router.post(
    "/keys",
    status_code=201,
    summary="创建 API Key（secret_once 仅本次返回）",
    dependencies=[Depends(rate_limit("developer_keys_create", per_minute=10, key="uid"))],
)
def create_key(
    body: ApiKeyCreateIn,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    if ApiKeyRepo.count_active(session, current.id) >= API_KEY_MAX_PER_ACCOUNT:
        raise HTTPException(
            status_code=400,
            detail=f"API Key 已达上限 {API_KEY_MAX_PER_ACCOUNT} 个 · 请先吊销旧的",
        )
    item = ApiKeyRepo.create(
        session,
        account_id=current.id,
        name=body.name,
        scopes=body.scopes,
        expires_days=body.expires_days,
    )
    try:
        AuditRepo.write(
            session,
            action="developer.api_key.create",
            actor_account_id=current.id,
            actor_kind="user",
            target_kind="api_key",
            target_id=str(item["id"]),
            detail={"prefix": item.get("key_prefix"), "name": body.name},
        )
    except Exception:
        logger.debug("developer.api_key.create audit skipped", exc_info=True)
    return {
        "ok": True,
        "item": item,
        "_note": "secret_once 仅本次返回 · 妥善保存 · 后续无法再取",
    }


@router.delete(
    "/keys/{key_id}",
    summary="吊销 API Key",
    dependencies=[Depends(rate_limit("developer_keys_revoke", per_minute=30, key="uid"))],
)
def revoke_key(
    key_id: int,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    ok = ApiKeyRepo.revoke(session, key_id=key_id, account_id=current.id)
    if not ok:
        raise HTTPException(status_code=404, detail="key 不存在或已吊销")
    try:
        AuditRepo.write(
            session,
            action="developer.api_key.revoke",
            actor_account_id=current.id,
            actor_kind="user",
            target_kind="api_key",
            target_id=str(key_id),
            detail={},
        )
    except Exception:
        logger.debug("developer.api_key.revoke audit skipped", exc_info=True)
    return {"ok": True, "revoked": key_id}


@router.get(
    "/task-types",
    summary="开发者可提交任务目录",
    dependencies=[
        Depends(rate_limit("developer_task_types", per_minute=120, key="uid")),
        Depends(require_scope("workloads")),
    ],
)
def list_task_types(session: Session = Depends(get_session)):
    from platform_v8.services.workers.task_adapter_publications import list_callable_task_specs

    items = []
    known = {spec.task_type: spec for spec in list_developer_specs()}
    known.update({spec.task_type: spec for spec in list_callable_task_specs(session)})
    for spec in sorted(known.values(), key=lambda item: item.task_type):
        accepted = [kind for kind in spec.accepted_input_kinds if kind != "stream"]
        if not accepted:
            continue
        default_input_kind = (
            spec.default_input_kind
            if spec.default_input_kind in accepted
            else accepted[0]
        )
        required_tier, fallback_tiers = resolve_tier_routing(spec)
        items.append({
            "task_type": spec.task_type,
            "category": spec.category,
            "description": spec.description,
            "accepted_input_kinds": accepted,
            "default_input_kind": default_input_kind,
            "mode": spec.mode.value,
            "executor": spec.executor.value,
            "runtimes": list(spec.runtimes),
            "required_software": list(spec.required_software),
            "required_tier": required_tier,
            "fallback_tiers": list(fallback_tiers),
            "min_memory_mb": spec.min_memory_mb,
            "requires_gpu": spec.requires_gpu,
            "max_shards": spec.max_shards_limit,
            "required_params": list(submit_svc.required_task_params(spec.task_type)),
            **submit_svc.task_input_form_contract(spec),
            "batch_semantics": spec.batch_semantics,
            **compute_origin_fields(spec),  # 2026-09-18 · 算力归属 (加法字段)
            **input_file_limits(spec),
            "example_params": {},
        })
    return {"ok": True, "items": items, "total": len(items)}


@router.post(
    "/files/upload-url",
    status_code=201,
    summary="签发开发者文件 PUT URL",
    dependencies=[
        Depends(rate_limit("developer_file_upload", per_minute=60, key="uid")),
        Depends(require_scope("files")),
    ],
)
def developer_upload_url(
    body: DeveloperUploadURLIn,
    current: Account = Depends(get_current_account),
):
    safe_name = os.path.basename(body.filename).replace("\x00", "").strip() or "file"
    file_id = uuid.uuid4().hex
    object_key = (
        f"{_owned_object_key_prefix(current.id)}developer/{file_id}/input/{safe_name}"
    )
    try:
        from platform_v8.services.oss_provider import get_oss_provider

        provider = get_oss_provider()
        try:
            signed = provider.presign_put(
                object_key,
                content_type=body.content_type,
                expires=3600,
                max_size=body.size_bytes,
                metadata={"sha256": body.sha256.lower()} if body.sha256 else None,
            )
        except TypeError:
            signed = provider.presign_put(
                object_key,
                content_type=body.content_type,
                expires=3600,
            )
    except Exception as exc:
        logger.warning("developer.file.upload-url 签发失败: %s", exc)
        raise HTTPException(status_code=503, detail=f"OSS provider unavailable: {exc}") from exc
    url = _presigned_url(signed)
    headers = dict(getattr(signed, "headers", {}) or {})
    if isinstance(signed, dict):
        headers = dict(signed.get("headers") or {})
    return {
        "ok": True,
        "object_key": object_key,
        "url": url,
        "upload_url": url,
        "method": "PUT",
        "headers": headers,
        "expires_in": 3600,
    }


@router.post(
    "/files/complete",
    summary="校验开发者文件上传完成",
    dependencies=[
        Depends(rate_limit("developer_file_complete", per_minute=60, key="uid")),
        Depends(require_scope("files")),
    ],
)
def developer_file_complete(
    body: DeveloperFileCompleteIn,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    object_key = _validate_owned_object_key(current.id, body.object_key)
    verified = _head_uploaded_object(object_key, body.size_bytes, body.sha256)
    AuditRepo.write(
        session,
        action="developer.file.complete",
        actor_account_id=current.id,
        actor_kind="user",
        target_kind="developer_file",
        target_id=object_key,
        trace_id=getattr(request.state, "trace_id", None),
        ip=request.client.host if request.client else None,
        detail={
            "object_key": object_key,
            "size_bytes": verified["size_bytes"],
            "sha256": verified["sha256"] or body.sha256.lower(),
            "content_type": body.content_type,
            "object_version_id": verified.get("object_version_id"),
        },
    )
    return {
        "ok": True,
        "object_key": object_key,
        "size_bytes": verified["size_bytes"],
        "sha256": verified["sha256"] or body.sha256.lower(),
        "completed": True,
        "object_version_id": verified.get("object_version_id"),
    }


@router.post(
    "/tasks/estimate",
    summary="为开发者任务签发与提交内容完全一致的报价",
    dependencies=[
        Depends(rate_limit("developer_task_estimate", per_minute=60, key="uid")),
        Depends(require_scope("workloads")),
    ],
)
def estimate_developer_task(
    body: DeveloperTaskCreateIn,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    task_spec, refs = _validate_task_input(session, current.id, body)
    callback_url = _validate_callback_url(body.callback_url)
    if callback_url and not body.callback_secret:
        raise HTTPException(status_code=422, detail="callback_url 需要 callback_secret")
    if callback_url:
        _require_api_key_scope(request, "webhooks")
    from platform_v8.api.v8.economy import EstimateRequest, estimate_workload
    return estimate_workload(
        EstimateRequest(name=body.name or task_spec.description or task_spec.task_type,
                        spec=_task_spec_dict(body, task_spec, refs),
                        budget=float(body.budget)),
        session=session, current=current,
    )


@router.post(
    "/tasks",
    status_code=202,
    summary="提交通用开发者任务",
    dependencies=[
        Depends(rate_limit("developer_task_create", per_minute=30, key="uid")),
        Depends(require_scope("workloads")),
    ],
)
async def create_developer_task(
    body: DeveloperTaskCreateIn,
    request: Request,
    bg: BackgroundTasks,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    task_spec, refs = _validate_task_input(session, current.id, body)
    callback_url = _validate_callback_url(body.callback_url)
    if callback_url and not body.callback_secret:
        raise HTTPException(status_code=422, detail="callback_url 需要 callback_secret")
    if callback_url:
        _require_api_key_scope(request, "webhooks")

    fingerprint = _task_fingerprint(body)
    _lock_idempotency(session, current.id, body.idempotency_key)
    reservation = DeveloperTaskRepo.get_idempotency(
        session,
        account_id=current.id,
        idempotency_key=body.idempotency_key,
    )
    if reservation is not None:
        if reservation["request_fingerprint"] != fingerprint:
            raise HTTPException(
                status_code=409,
                detail="idempotency_key 已用于不同请求",
            )
        workload_id = reservation.get("workload_id")
        if not workload_id:
            raise HTTPException(status_code=409, detail="同幂等请求正在处理中，请稍后重试")
        existing = WorkloadRepo.by_id(session, str(workload_id))
        if existing is None:
            raise HTTPException(status_code=409, detail="幂等记录对应任务不存在")
        result = _task_status_payload(existing)
        result["reused"] = True
        return result
    DeveloperTaskRepo.reserve_idempotency(
        session,
        account_id=current.id,
        idempotency_key=body.idempotency_key,
        request_fingerprint=fingerprint,
    )

    spec_dict = _task_spec_dict(body, task_spec, refs)
    try:
        workload = submit_svc.submit_workload(
            session,
            submit_svc.SubmitInput(
                owner_id=current.id,
                name=body.name or task_spec.description or task_spec.task_type,
                spec_dict=spec_dict,
                budget=body.budget,
                quote_token=body.quote_token,
                trace_id=getattr(request.state, "trace_id", None),
                ip=request.client.host if request.client else None,
                is_admin=current.is_admin,
            ),
        )
    except submit_svc.SubmitWorkloadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    DeveloperTaskRepo.bind_idempotency_workload(
        session,
        account_id=current.id,
        idempotency_key=body.idempotency_key,
        workload_id=str(workload.id),
    )
    if callback_url:
        DeveloperTaskRepo.save_webhook(
            session,
            workload_id=str(workload.id),
            account_id=current.id,
            callback_url=callback_url,
            callback_secret=body.callback_secret,
        )
    bg.add_task(_start_workload, str(workload.id))
    result = _task_status_payload(workload)
    result["reused"] = False
    result["webhook_event"] = "task.completed" if callback_url else None
    return result


def _get_developer_workload(
    session: Session,
    current: Account,
    workload_id: str,
):
    workload = WorkloadRepo.by_id(session, workload_id)
    if workload is None:
        raise HTTPException(status_code=404, detail="开发者任务不存在")
    if not current.is_admin and workload.owner_id != current.id:
        raise HTTPException(status_code=403, detail="forbidden")
    return workload


def _sign_result_value(value: Any, account_id: int) -> Any:
    """递归将结果 manifest 中本账号 object key 转成短期 GET URL。"""
    if isinstance(value, list):
        return [_sign_result_value(item, account_id) for item in value]
    if isinstance(value, dict):
        is_media = value.get("content_type") in _MEDIA_EXTENSIONS
        if is_media:
            return {key: value[key] for key in ("schema", "content_type", "size_bytes", "sha256")
                    if key in value}
        result = {
            key: _sign_result_value(item, account_id)
            for key, item in value.items()
            if key != "object_key"
        }
        object_key = value.get("object_key")
        if isinstance(object_key, str) and object_key.startswith(
            _owned_object_key_prefix(account_id)
        ):
            try:
                from platform_v8.services.oss_provider import get_oss_provider

                result["download_url"] = _presigned_url(
                    get_oss_provider().presign_get(object_key, expires=3600)
                )
            except Exception:
                logger.warning("developer.result object key 签名失败", exc_info=True)
        return result
    if isinstance(value, str) and is_protected_media_result_ref(value):
        return None
    if isinstance(value, str) and value.startswith(_owned_object_key_prefix(account_id)):
        try:
            from platform_v8.services.oss_provider import get_oss_provider

            return _presigned_url(get_oss_provider().presign_get(value, expires=3600))
        except Exception:
            logger.warning("developer.result object key 签名失败", exc_info=True)
    return value


@router.get(
    "/tasks/{workload_id}",
    summary="查询通用开发者任务状态",
    dependencies=[
        Depends(rate_limit("developer_task_get", per_minute=180, key="uid")),
        Depends(require_scope("workloads", "results")),
    ],
)
def get_developer_task(
    workload_id: str,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    return _task_status_payload(
        _get_developer_workload(session, current, workload_id)
    )


@router.get(
    "/tasks/{workload_id}/result",
    summary="获取通用开发者任务结果",
    dependencies=[
        Depends(rate_limit("developer_task_result", per_minute=180, key="uid")),
        Depends(require_scope("results")),
    ],
)
def get_developer_task_result(
    workload_id: str,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    workload = _get_developer_workload(session, current, workload_id)
    if workload.status.value != "DONE" or workload.result is None:
        raise HTTPException(status_code=409, detail=f"任务尚未完成: {workload.status.value}")
    raw = (workload.result.output_ref or workload.result.inline_output or "").strip()
    # 2026-09-18 · 纯文本形状先归一成平台信封（合法 JSON 逐字节不变），
    # 让开发者接口与 /workloads/{id}/result 见到同一种结果口径。
    raw = normalize_result_envelope(raw)
    # 2026-09-18 · 与 /workloads/{id}/result 同口径：已落库聚合若是空壳
    # （聚合层丢掉纯文本分片的产物），改用分片正文，否则开发者接口
    # 会把 result_text:"" / results:[] 当成真实结果返回。
    from platform_v8.services.result_envelope import reconcile_with_shard_texts
    from platform_v8.storage.repo import ShardRepo
    _owner = int(workload.owner_id)
    raw = reconcile_with_shard_texts(raw, [
        normalize_result_envelope(s.output_ref or "")
        for s in sorted(ShardRepo.by_workload(session, str(workload.id)),
                        key=lambda s: s.index)
    ])
    try:
        payload: Any = json.loads(raw)
    except (TypeError, ValueError):
        payload = raw
    media_ref = None
    from platform_v8.protocol.artifact import parse_artifact_ref
    from platform_v8.services import media_view_grants
    artifact = parse_artifact_ref(raw)
    is_media_artifact = artifact is not None and artifact.content_type in _MEDIA_EXTENSIONS
    if is_media_artifact:
        from platform_v8.storage.repo import ResultVerificationRepo
        shards = ShardRepo.by_workload(session, str(workload.id))
        verified = media_view_grants.attested_asset(
            workload, shards, artifact.sha256,
            {str(shard.id): ResultVerificationRepo.current(session, str(shard.id))
             for shard in shards},
        )
        # A media result is never exposed through an ordinary OSS presign. The
        # only usable reference must redeem a finalized independent receipt.
        if isinstance(payload, dict):
            payload = {key: value for key, value in payload.items()
                       if key not in {"object_key", "download_url"}}
        if verified is not None:
            extension = _MEDIA_EXTENSIONS[artifact.content_type]
            media_ref = (f"qianshou-media://task/{workload.id}/"
                         f"{artifact.sha256}.{extension}")
            payload["media_ref"] = media_ref
    return {
        "ok": True,
        "id": str(workload.id),
        "task_id": str(workload.id),
        "workload_id": str(workload.id),
        "status": workload.status.value,
        "result": (payload if is_media_artifact else
                   _sign_result_value(payload, int(workload.owner_id))),
        "output_ref": media_ref,
        "summary": workload.result.summary,
        "elapsed_ms": workload.result.elapsed_ms,
        "download_url": (None if is_media_artifact else
                         _task_urls(str(workload.id))["download_url"]),
    }


@router.get(
    "/tasks/{workload_id}/media-view-grant",
    summary="获取已核验任务媒体的短期查看授权",
    dependencies=[
        Depends(rate_limit("developer_media_view_grant", per_minute=120, key="uid")),
        Depends(require_scope("results")),
    ],
)
def get_developer_media_view_grant(
    workload_id: str,
    asset_id: str,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    """Authorize metadata only; the viewer downloads verified bytes from Guangzhou."""
    from platform_v8.services import media_view_grants
    from platform_v8.services.workers import task_adapter_evidence_storage
    from platform_v8.storage.repo import ResultVerificationRepo, ShardRepo

    if not re.fullmatch(r"[a-f0-9]{64}", asset_id):
        raise HTTPException(status_code=400, detail="媒体引用无效")
    workload = _get_developer_workload(session, current, workload_id)
    # A privileged operator's account is not a substitute for the owner's
    # session when issuing a grant redeemable outside Shanghai.
    if int(workload.owner_id) != int(current.id):
        raise HTTPException(status_code=404, detail="媒体结果不存在")
    shards = ShardRepo.by_workload(session, str(workload.id))
    verification_rows = {
        str(shard.id): ResultVerificationRepo.current(session, str(shard.id))
        for shard in shards
    }
    asset = media_view_grants.attested_asset(
        workload, shards, asset_id, verification_rows,
    )
    if asset is None:
        raise HTTPException(status_code=404, detail="媒体结果不存在或尚未核验")
    try:
        bucket = task_adapter_evidence_storage.provider().bucket
        grant = media_view_grants.issue(
            account_id=int(current.id), task_id=str(workload.id),
            asset_id=asset_id, bucket=bucket, asset=asset,
        )
    except (task_adapter_evidence_storage.EvidenceStorageUnavailable,
            media_view_grants.MediaViewUnavailable) as exc:
        raise HTTPException(status_code=503, detail="媒体交付服务尚未就绪") from exc
    return JSONResponse({"ok": True, "grant": grant},
                        headers={"Cache-Control": "private, no-store",
                                 "Pragma": "no-cache"})


@router.get(
    "/tasks/{workload_id}/download",
    summary="下载通用开发者任务结果",
    dependencies=[
        Depends(rate_limit("developer_task_download", per_minute=120, key="uid")),
        Depends(require_scope("results")),
    ],
)
def download_developer_task_result(
    workload_id: str,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    _get_developer_workload(session, current, workload_id)
    try:
        from uuid import UUID
        from platform_v8.api.v8.workloads import workload_download

        return workload_download(UUID(workload_id), session=session, current=current)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="开发者任务不存在") from exc


@router.post(
    "/pdf-to-text",
    status_code=202,
    summary="创建异步 PDF 智能转文本任务",
    dependencies=[
        Depends(rate_limit("developer_pdf_text_create", per_minute=20, key="uid")),
        Depends(require_scope("workloads")),
    ],
)
async def create_pdf_to_text(
    body: PdfTextCreateIn,
    request: Request,
    bg: BackgroundTasks,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    """兼容旧请求体，统一转入通用开发者任务提交链路。"""
    refs = [body.input_ref] if body.input_ref else list(body.input_refs)
    if body.input_ref and body.input_refs:
        raise HTTPException(status_code=422, detail="input_ref 与 input_refs 只能二选一")
    _validate_owned_pdf_refs(current.id, refs)
    # 老调用方没有 /developer/files/complete 步骤。兼容层只在 provider HEAD
    # 确认对象真实存在且属于当前账号后补登记，再交给通用入口做统一校验。
    from platform_v8.services.oss_provider import get_oss_provider

    provider = get_oss_provider()
    for object_key in refs:
        if _completed_object_key(session, current.id, object_key):
            continue
        metadata = provider.head_object(object_key)
        if not metadata or int(metadata.get("size_bytes") or 0) <= 0:
            raise HTTPException(status_code=422, detail=f"PDF 对象不存在或不可验证: {object_key}")
        AuditRepo.write(
            session,
            action="developer.file.complete",
            actor_account_id=current.id,
            actor_kind="user",
            target_kind="developer_file",
            target_id=object_key,
            trace_id=getattr(request.state, "trace_id", None),
            ip=request.client.host if request.client else None,
            detail={
                "object_key": object_key,
                "size_bytes": int(metadata["size_bytes"]),
                "sha256": str(metadata.get("sha256") or ""),
                "compat_pdf_api": True,
            },
        )

    generic = DeveloperTaskCreateIn(
        name=body.name,
        task_type="pdf_to_text",
        input_kind="single_file" if len(refs) == 1 else "multi_file",
        input_ref=refs[0] if len(refs) == 1 else "",
        input_refs=refs if len(refs) > 1 else [],
        params={
            "mode": body.mode,
            "language": body.language,
            "page_range": body.page_range,
            "output_format": body.output_format,
        },
        budget=body.budget,
        quote_token=body.quote_token,
        timeout_s=3600,
        max_shards=20,
        auto_shard=True,
        idempotency_key=body.idempotency_key or f"pdf-compat-{uuid.uuid4().hex}",
        callback_url=body.callback_url,
        callback_secret=body.callback_secret,
    )
    result = await create_developer_task(
        generic,
        request,
        bg,
        current,
        session,
    )
    workload_id = str(result["workload_id"])
    result["poll_url"] = f"/api/v8/developer/pdf-to-text/{workload_id}"
    result["result_url"] = f"/api/v8/developer/pdf-to-text/{workload_id}/result"
    return result


@router.get(
    "/pdf-to-text/{workload_id}",
    summary="查询 PDF 转文本任务状态",
    dependencies=[
        Depends(rate_limit("developer_pdf_text_get", per_minute=120, key="uid")),
        Depends(require_scope("workloads")),
    ],
)
def get_pdf_to_text(
    workload_id: str,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    from platform_v8.storage.repo import WorkloadRepo
    workload = WorkloadRepo.by_id(session, workload_id)
    if workload is None or workload.spec.task_type != "pdf_to_text":
        raise HTTPException(status_code=404, detail="PDF 转文本任务不存在")
    if not current.is_admin and workload.owner_id != current.id:
        raise HTTPException(status_code=403, detail="forbidden")
    return {
        "ok": True,
        "workload_id": str(workload.id),
        "status": workload.status.value,
        "progress": workload.progress,
        "total_shards": workload.total_shards,
        "completed_shards": workload.completed_shards,
        "failed_shards": workload.failed_shards,
        "result_url": f"/api/v8/developer/pdf-to-text/{workload.id}/result"
        if workload.status.value == "DONE" else None,
        "error": workload.error or None,
    }


@router.get(
    "/pdf-to-text/{workload_id}/result",
    summary="获取 PDF 转文本结果清单",
    dependencies=[
        Depends(rate_limit("developer_pdf_text_result", per_minute=120, key="uid")),
        Depends(require_scope("results")),
    ],
)
def get_pdf_to_text_result(
    workload_id: str,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    from platform_v8.storage.repo import WorkloadRepo
    workload = WorkloadRepo.by_id(session, workload_id)
    if workload is None or workload.spec.task_type != "pdf_to_text":
        raise HTTPException(status_code=404, detail="PDF 转文本任务不存在")
    if not current.is_admin and workload.owner_id != current.id:
        raise HTTPException(status_code=403, detail="forbidden")
    if workload.status.value != "DONE" or not workload.result:
        raise HTTPException(status_code=409, detail=f"任务尚未完成: {workload.status.value}")
    # 2026-09-18 · 历史纯文本 pdf_to_text 结果此前命中 500「结果格式损坏」；
    # 先归一再解析（合法 JSON 逐字节不变）。
    try:
        payload = json.loads(
            normalize_result_envelope(workload.result.output_ref or "{}")
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail="结果格式损坏") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail="结果格式损坏")
    # 回调/开发者查询只拿 manifest，不泄漏内部 OSS key；download_url 是短期 presign。
    return {
        "ok": True,
        "workload_id": workload_id,
        "result": _sign_result_value(payload, int(workload.owner_id)),
    }
