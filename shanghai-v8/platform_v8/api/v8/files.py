"""v8 文件上传/下载 · /api/v8/files

复用 v1 backend/routers/oss_presign.py 的 OSS provider · 提供 v8 风格 URL。
v8 不重写 OSS 逻辑 · 只做 thin proxy (维护成本最小)。

接口:
  POST /api/v8/files/upload-url   · 拿 PUT presign (企业上传)
  POST /api/v8/files/download-url · 拿 GET presign (节点拉数据)
  POST /api/v8/files/direct-put   · 服务器落盘（绕过 OSS，节点用 blob GET）
  GET  /api/v8/files/blob/{id}    · 无鉴权拉取落盘文件（uuid 不可猜测）
  GET  /api/v8/files/me           · 列我上传过的文件
"""
from __future__ import annotations

import logging
import re
import uuid as _uuid
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from platform_v8.api.deps import get_current_account, require_scope
from platform_v8.core import Account

logger = logging.getLogger("platform_v8.api.v8.files")
router = APIRouter(
    prefix="/api/v8/files",
    tags=["files"],
    dependencies=[Depends(require_scope("files"))],
)
from platform_v8.api.v8.file_attachment_credentials import router as attachment_credentials_router
router.include_router(attachment_credentials_router)
# 节点拉 input_ref：无鉴权；仅接受 uuid 文件名
public_router = APIRouter(
    prefix="/api/v8/files",
    tags=["files-public"],
)

_BLOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def _files_local_dir() -> Path:
    raw = (os.environ.get("FILES_LOCAL_DIR") or "/opt/edge/data/blobs").strip()
    p = Path(raw)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _files_public_base() -> str:
    return (os.environ.get("FILES_PUBLIC_BASE") or "https://www.qianshousuanli.com").rstrip("/")


def _files_local_max_bytes() -> int:
    try:
        return max(1 * 1024 * 1024, int(os.environ.get("FILES_LOCAL_MAX_BYTES") or str(700 * 1024 * 1024)))
    except ValueError:
        return 700 * 1024 * 1024


def _blob_public_url(blob_id: str) -> str:
    return f"{_files_public_base()}/api/v8/files/blob/{blob_id}"


def _legacy_direct_bridge_enabled() -> bool:
    # This compatibility path sends file bytes through Shanghai and creates
    # long-lived bearer blob URLs. New installations use OSS presign instead.
    return os.environ.get("V8_LEGACY_DIRECT_FILE_BRIDGE_ENABLED", "").strip() == "1"


class UploadURLReq(BaseModel):
    filename: str
    purpose: str = Field(default="input", description="input/code/script/result")
    content_type: str = "application/octet-stream"
    size_bytes: int | None = None
    task_id: str | None = None


class UploadURLResp(BaseModel):
    object_key: str
    url: str  # 标准字段
    upload_url: str = ""  # alias · v1 老前端用 upload_url · 兼容 enterprise-client useUpload.ts
    method: str = "PUT"
    headers: dict[str, str] = Field(default_factory=dict)
    # 上传 URL · 6h
    expires_in: int = 21600


class DownloadURLReq(BaseModel):
    object_key: str
    object_version_id: str | None = None
    # 下载 URL · 默认 1h (S2-T8 · 2026-06-07 缩短泄露窗口)
    # 任务长跑场景由 broker._refresh_oss_url 自动重签 (broker.py:593-651)
    # 客户端长期持有的链接如需更久可显式传更大值 (max 7d)
    expires_in: int = 3600


class DownloadURLResp(BaseModel):
    url: str
    download_url: str = ""  # alias · v1 兼容
    expires_in: int


@router.post("/upload-url", response_model=UploadURLResp, summary="拿文件上传 presign URL")
async def upload_url(req: UploadURLReq, current: Account = Depends(get_current_account)) -> UploadURLResp:
    account_id = current.id
    """企业拿到 PUT presign 直传 OSS · 服务器不接触文件。"""
    try:
        from platform_v8.services.oss_provider import get_oss_provider  # type: ignore
    except Exception as exc:
        logger.warning("v8 files · OSS provider 加载失败: %s", exc)
        raise HTTPException(status_code=503, detail="OSS provider unavailable")

    provider = get_oss_provider()
    task_part = req.task_id or "unassigned"
    file_id = _uuid.uuid4().hex[:16]
    safe_name = os.path.basename(req.filename).replace("\x00", "") or "file"
    object_key = f"v8/account-{account_id}/{task_part}/{req.purpose}/{file_id}-{safe_name}"
    from platform_v8.services.storage_refs import (
        StorageReferenceError, validate_owned_object_key,
    )
    try:
        object_key = validate_owned_object_key(account_id, object_key)
    except StorageReferenceError as exc:
        raise HTTPException(status_code=400, detail="invalid file path component") from exc

    try:
        presigned = provider.presign_put(
            object_key,
            content_type=req.content_type,
            expires=21600,  # 6h · 同 UploadURLResp.expires_in
            max_size=req.size_bytes,
        )
    except Exception as exc:
        logger.error("v8 files · presign 失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"presign failed: {exc}")

    # 兼容 PresignedURL 对象 / dict / str
    if hasattr(presigned, "url"):
        actual_url = presigned.url
        actual_headers = getattr(presigned, "headers", {}) or {}
    elif isinstance(presigned, dict):
        actual_url = presigned["url"]
        actual_headers = presigned.get("headers", {}) or {}
    else:
        actual_url = str(presigned)
        actual_headers = {}
    return UploadURLResp(
        object_key=object_key,
        url=actual_url,
        upload_url=actual_url,  # alias · 兼容 v1 useUpload.ts
        headers=actual_headers,
    )


# ── artifact.v1 · 节点结果直传 (租约绑定 · 服务端定 object_key) ──

class ResultUploadURLReq(BaseModel):
    shard_id: str
    worker_id: str
    lease_token: str
    result_id: str
    filename: str
    size_bytes: int = Field(..., ge=1)
    sha256: str
    content_md5: str | None = None
    content_type: str = "application/octet-stream"


class ResultUploadURLResp(BaseModel):
    object_key: str
    # SVG media is uploaded to the dedicated, versioned review-evidence bucket.
    bucket: str = ""
    url: str
    upload_url: str = ""
    method: str = "PUT"
    headers: dict[str, str] = Field(default_factory=dict)
    expires_in: int = 900
    # Unix 时间戳；节点必须用它约束上传窗口，避免仅依赖 expires_in。
    expires_at: int = 0
    schema_version: str = "artifact.v1"
    # Shanghai-signed control metadata for independent sample/order audits.
    # No object bytes or presigned URL are covered by this receipt.
    issuance_receipt: dict[str, Any] | None = None


@router.post(
    "/result-upload-url",
    response_model=ResultUploadURLResp,
    summary="节点结果上传 · 租约绑定 presign (artifact.v1)",
)
async def result_upload_url(
    req: ResultUploadURLReq,
    current: Account = Depends(get_current_account),
) -> ResultUploadURLResp:
    """仅当节点仍持有该 shard 租约时签发 PUT URL · 路径由服务端生成。"""
    from platform_v8.core import ShardStatus
    from platform_v8.protocol.artifact import (
        MAX_ARTIFACT_BYTES,
        ArtifactV1,
        build_object_key,
    )
    from platform_v8.services.artifact_lease import (
        lease_ttl_for_size,
        verify_lease_token,
    )
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo, WorkloadRepo, WorkerRepo

    if req.size_bytes > MAX_ARTIFACT_BYTES:
        raise HTTPException(status_code=413, detail="file exceeds 2GiB limit")

    def _load_ctx():
        with db_mod.session_scope() as s:
            sh = ShardRepo.by_id(s, req.shard_id)
            if sh is None:
                return None, None, None
            wl = WorkloadRepo.by_id(s, sh.workload_id)
            worker = WorkerRepo.by_id(s, req.worker_id)
            return sh, wl, worker

    import asyncio
    sh, wl, worker = await asyncio.to_thread(_load_ctx)
    if sh is None or wl is None:
        raise HTTPException(status_code=404, detail="shard not found")
    if worker is None or int(worker.owner_id) != int(current.id):
        raise HTTPException(status_code=403, detail="worker not owned by account")
    # PULL 在 confirm 前可能只有 lease_by_node；一律转 str 防 UUID≠str 误拒
    holder = str(sh.worker_id or sh.lease_by_node or "")
    if not holder or holder != str(req.worker_id):
        raise HTTPException(status_code=403, detail="worker does not hold shard")
    if sh.status not in (
        ShardStatus.DISPATCHED,
        ShardStatus.RUNNING,
        ShardStatus.LEASED,
    ):
        raise HTTPException(status_code=409, detail=f"shard status={sh.status}")
    if not verify_lease_token(
        req.lease_token,
        shard_id=req.shard_id,
        worker_id=req.worker_id,
        attempt=sh.attempts,
    ):
        raise HTTPException(status_code=403, detail="invalid or expired lease_token")

    # 校验 sha / filename 形状 (与最终 manifest 一致)
    try:
        _ = ArtifactV1.model_validate({
            "schema": "artifact.v1",
            "object_key": "v8/validate-only/placeholder.bin",
            "filename": req.filename,
            "size_bytes": req.size_bytes,
            "content_type": req.content_type,
            "sha256": req.sha256,
            "result_id": req.result_id,
            "shard_id": req.shard_id,
            "workload_id": str(wl.id),
            "account_id": int(wl.owner_id),
        })
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid artifact meta: {exc}") from exc

    object_key = build_object_key(
        account_id=int(wl.owner_id),
        workload_id=str(wl.id),
        shard_id=str(sh.id),
        result_id=req.result_id,
        filename=req.filename,
    )
    expires = lease_ttl_for_size(req.size_bytes)
    issued_at = int(time.time())
    expires_at = issued_at + expires
    from platform_v8.services import artifact_issuance_receipt
    from platform_v8.engine.task_registry import TASK_REGISTRY

    from platform_v8.services.result_verifier import _registered_task_spec
    registered = _registered_task_spec(str(wl.spec.task_type))
    if getattr(registered, "adapter_file_schema", None):
        from platform_v8.protocol.generic_file import validate_file_schema
        try:
            output = validate_file_schema(registered.adapter_file_schema)["outputs"][0]
            if (req.filename != output["filename"] or req.content_type != output["contentType"]
                    or not 1 <= req.size_bytes <= output["maxBytes"]):
                raise ValueError("upload differs from file declaration")
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=422, detail="文件输出不符合已审核声明") from exc
    try:
        issuance_receipt = artifact_issuance_receipt.issue(
            account_id=int(wl.owner_id), workload_id=str(wl.id),
            shard_id=str(sh.id), worker_id=str(req.worker_id),
            attempt=int(sh.attempts), result_id=req.result_id,
            object_key=object_key, sha256=req.sha256,
            size_bytes=req.size_bytes, content_type=req.content_type,
            issued_at=issued_at, expires_at=expires_at,
        )
    except (artifact_issuance_receipt.IssuanceReceiptConfigurationError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="result issuance signer unavailable") from exc
    if (registered is not None and registered.external_artifact_verifier_required
            and issuance_receipt is None):
        raise HTTPException(status_code=503, detail="result issuance signer required")

    def _record_issuance() -> bool:
        with db_mod.session_scope() as s:
            ok = ShardRepo.record_result_upload_issuance(
                s,
                req.shard_id,
                worker_id=req.worker_id,
                object_key=object_key,
                result_id=req.result_id,
                size_bytes=req.size_bytes,
                sha256=req.sha256,
                content_type=req.content_type,
                expires_at=expires_at,
            )
            s.commit()
            return ok

    evidence_media = bool(registered is not None
                          and registered.external_artifact_verifier_required)
    if evidence_media:
        from platform_v8.services.workers import task_adapter_evidence_storage as evidence_storage
        try:
            if req.content_md5 is None:
                raise evidence_storage.EvidenceStorageUnavailable("媒体结果缺少冻结字节的 Content-MD5")
            provider = evidence_storage.provider()
            evidence_storage.require_bucket_proof(provider)
            if provider._full_key(object_key) != object_key:
                raise evidence_storage.EvidenceStorageUnavailable("审核证据桶不能附加对象键前缀")
            actual_url, actual_headers, _ = evidence_storage.locked_put_grant(
                provider, object_key=object_key, sha256_hex=req.sha256,
                content_md5=req.content_md5,
                content_type=req.content_type, expires=expires)
        except evidence_storage.EvidenceStorageUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    else:
        try:
            from platform_v8.services.oss_provider import get_oss_provider
            provider = get_oss_provider()
            try:
                presigned = provider.presign_put(
                    object_key,
                    content_type=req.content_type,
                    expires=expires,
                    max_size=req.size_bytes,
                )
            except TypeError:
                # 旧 provider 无 max_size 参数
                presigned = provider.presign_put(
                    object_key,
                    content_type=req.content_type,
                    expires=expires,
                )
        except Exception as exc:
            logger.error("v8 result-upload · presign 失败: %s", exc)
            raise HTTPException(status_code=503, detail="result storage unavailable") from exc

        if hasattr(presigned, "url"):
            actual_url = presigned.url
            actual_headers = getattr(presigned, "headers", {}) or {}
        elif isinstance(presigned, dict):
            actual_url = presigned["url"]
            actual_headers = presigned.get("headers", {}) or {}
        else:
            actual_url = str(presigned)
            actual_headers = {}

    # Do not persist a grant if the storage path cannot issue a usable URL.
    if not await asyncio.to_thread(_record_issuance):
        raise HTTPException(
            status_code=409,
            detail="artifact issuance already exists for this shard attempt",
        )


    logger.info(
        "v8.result_upload_url · shard=%s worker=%s key=%s size=%d",
        req.shard_id, req.worker_id, object_key, req.size_bytes,
    )
    return ResultUploadURLResp(
        object_key=object_key,
        bucket=provider.bucket if evidence_media else "",
        url=actual_url,
        upload_url=actual_url,
        headers=dict(actual_headers),
        expires_in=expires,
        expires_at=expires_at,
        issuance_receipt=issuance_receipt,
    )


@router.post("/download-url", response_model=DownloadURLResp, summary="拿文件下载 presign URL")
async def download_url(req: DownloadURLReq, current: Account = Depends(get_current_account)) -> DownloadURLResp:
    account_id = current.id
    """用户拿 GET presign 从 OSS 拉自己的数据。

    2026-06-04 安全 · 修 IDOR:此前任意登录用户可对任意 object_key 签下载链(知 key 即可
    跨用户读)。这里校验 key 归属:本端上传的 key 形如 v8/account-{id}/... · 只允许
    下载自己账户前缀下的 key(admin 例外)。
    节点取 input 走派单帧 input_ref 直链,不调本端点,故不受影响。

    2026-08 · object_key 若已是 http(s)（服务器落盘 blob URL）则原样返回。
    """
    key = (req.object_key or "").strip()
    from platform_v8.services.storage_refs import is_protected_media_result_ref
    if is_protected_media_result_ref(key):
        raise HTTPException(status_code=409, detail="媒体结果须通过独立核验后的查看授权获取")
    if key.lower().startswith(("http://", "https://")):
        return DownloadURLResp(url=key, download_url=key, expires_in=req.expires_in)

    # IDOR 防护:object_key 必须属于本账户(或 admin)
    if not current.is_admin:
        prefix = f"v8/account-{account_id}/"
        if not key.startswith(prefix):
            logger.warning("v8 files · 拒绝越权下载 · account=%s key=%s",
                           account_id, key[:80])
            raise HTTPException(status_code=403, detail="无权访问该文件")
    owned = re.match(r"^v8/account-([0-9]+)/", key)
    if owned is not None:
        from platform_v8.services.storage_refs import (
            StorageReferenceError, materialize_get_url,
        )
        try:
            url = materialize_get_url(
                int(owned.group(1)), key, req.expires_in,
                object_version_id=req.object_version_id)
        except StorageReferenceError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return DownloadURLResp(url=url, download_url=url, expires_in=req.expires_in)
    try:
        from platform_v8.services.oss_provider import get_oss_provider  # type: ignore
    except Exception:
        raise HTTPException(status_code=503, detail="OSS provider unavailable")

    provider = get_oss_provider()
    try:
        presigned = provider.presign_get(key, expires=req.expires_in)
        # PresignedURL 对象 or dict or str · 都提取 url
        if hasattr(presigned, "url"):
            url = presigned.url
        elif isinstance(presigned, dict):
            url = presigned["url"]
        else:
            url = str(presigned)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"presign failed: {exc}")

    return DownloadURLResp(url=url, download_url=url, expires_in=req.expires_in)


class DirectPutResp(BaseModel):
    object_key: str
    url: str
    download_url: str = ""
    input_ref: str = ""
    size: int = 0
    storage: str = "local"
    filename: str = ""
    content_type: str = "application/octet-stream"


@router.post("/direct-put", response_model=DirectPutResp, summary="服务器中转上传到 MinIO")
async def direct_put(request: Request, current: Account = Depends(get_current_account)) -> DirectPutResp:
    """原始 body → MinIO（临时落盘再 upload_file）；返回节点可 GET 的 https input_ref。"""
    if not _legacy_direct_bridge_enabled():
        raise HTTPException(status_code=503, detail="legacy direct file bridge is disabled")
    import tempfile

    raw_name = (
        (request.headers.get("x-filename") or request.headers.get("X-Filename") or "upload.bin")
        .strip()
        or "upload.bin"
    )
    try:
        name = unquote(raw_name)
    except Exception:
        name = raw_name
    name = os.path.basename(name.replace("\x00", "")) or "upload.bin"
    content_type = (
        (request.headers.get("x-content-type") or request.headers.get("content-type") or "")
        .strip()
        or "application/octet-stream"
    )
    if "multipart/" in content_type.lower():
        content_type = "application/octet-stream"

    max_bytes = _files_local_max_bytes()
    blob_id = _uuid.uuid4().hex
    object_key = f"v8/account-{current.id}/direct/{blob_id}-{name}"
    size = 0
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix="direct-put-", suffix=".bin", delete=False) as tmp:
            tmp_path = Path(tmp.name)
            async for chunk in request.stream():
                if not chunk:
                    continue
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"文件超过上限 {max_bytes} bytes",
                    )
                tmp.write(chunk)
        if size <= 0:
            raise HTTPException(status_code=400, detail="空文件")

        from platform_v8.services.oss_provider import get_oss_provider

        provider = get_oss_provider()
        put_file = getattr(provider, "put_file", None)
        if callable(put_file):
            object_key = put_file(object_key, str(tmp_path), content_type=content_type)
            storage = "minio"
        else:
            # 回退：旧 LocalFallback / 无 put_file 时写本机 blobs
            dest = _files_local_dir() / blob_id
            meta_path = _files_local_dir() / f"{blob_id}.meta"
            dest.write_bytes(tmp_path.read_bytes())
            meta_path.write_text(
                f"filename={name}\ncontent_type={content_type}\naccount_id={current.id}\nsize={size}\n",
                encoding="utf-8",
            )
            public = _blob_public_url(blob_id)
            logger.info(
                "files.direct-put · fallback local blob account=%s size=%d name=%s",
                current.id, size, name[:80],
            )
            return DirectPutResp(
                object_key=public,
                url=public,
                download_url=public,
                input_ref=public,
                size=size,
                storage="local",
                filename=name,
                content_type=content_type,
            )

        # 节点拉数：7 天 SigV4 GET（object_key 仍返回裸 key，兼容产品；input_ref 给 https）
        getu = provider.presign_get(object_key, expires=7 * 24 * 3600)
        input_ref = getu.url if hasattr(getu, "url") else str(getu)
        logger.info(
            "files.direct-put · account=%s size=%d name=%s key=%s storage=%s",
            current.id, size, name[:80], object_key[:80], storage,
        )
        return DirectPutResp(
            object_key=object_key,
            url=input_ref,
            download_url=input_ref,
            input_ref=input_ref,
            size=size,
            storage=storage,
            filename=name,
            content_type=content_type,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("files.direct-put failed")
        raise HTTPException(status_code=500, detail=f"上传到对象存储失败: {exc}") from exc
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass


@public_router.get("/blob/{blob_id}", summary="拉取服务器落盘文件（节点用，无鉴权）")
async def get_local_blob(blob_id: str):
    if not _legacy_direct_bridge_enabled():
        raise HTTPException(status_code=503, detail="legacy direct file bridge is disabled")
    bid = (blob_id or "").strip().lower()
    if not _BLOB_ID_RE.match(bid):
        raise HTTPException(status_code=404, detail="not found")
    path = _files_local_dir() / bid
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    filename = bid
    media = "application/octet-stream"
    meta = _files_local_dir() / f"{bid}.meta"
    if meta.is_file():
        try:
            for line in meta.read_text(encoding="utf-8").splitlines():
                if line.startswith("filename="):
                    filename = line.split("=", 1)[1].strip() or bid
                elif line.startswith("content_type="):
                    media = line.split("=", 1)[1].strip() or media
        except Exception:
            pass
    return FileResponse(
        path,
        media_type=media,
        filename=filename,
        headers={"Cache-Control": "private, max-age=3600"},
    )


# ── STS 临时凭证 ─────────────────────────────────────────────
# 2026-06-19 · 替代固定 AK/SK · 前端直传 OSS 用短时凭证 (15min)
# 配合 oss.qianshousuanli.com 私密域(不开 CDN)使用

class STSReq(BaseModel):
    task_id: int | str = 0
    mode: str = Field(default="write", description="read / write / readwrite")
    duration_seconds: int = Field(default=900, ge=300, le=3600, description="5min ~ 1h")


class STSResp(BaseModel):
    AccessKeyId: str
    AccessKeySecret: str
    SecurityToken: str
    ExpiresAt: int
    Bucket: str
    Endpoint: str
    Region: str
    Prefix: str           # 强制路径前缀 · 前端只能往这写
    RequestId: str = ""


@router.post("/sts", response_model=STSResp, summary="签发 OSS STS 临时凭证 (前端直传用)")
async def issue_oss_sts(
    req: STSReq,
    current: Account = Depends(get_current_account),
) -> STSResp:
    """签发 STS 临时凭证 · 路径强制限制到 `uploads/tenant_{account_id}/task_{task_id}/`

    流程:
      前端 POST /api/v8/files/sts → 拿临时 AK/SK/Token (15min)
      前端用 ossutil 或 ali-oss-sdk-js 直传到 oss.qianshousuanli.com
      传完 POST /api/v8/files/callback 通知后端记录

    设计要点(§5.6 护栏):
      - 凭证范围限制到单一 prefix · 即使泄露也只能写一个 task 目录
      - 15min 过期 · 攻击窗口短
      - 同账户 + task + mode 5min 内复用同一 token (we_kv 缓存 · 省 STS 配额)
    """
    if req.mode not in ("read", "write", "readwrite"):
        raise HTTPException(status_code=400, detail="mode 必须是 read/write/readwrite")

    try:
        from platform_v8.services.oss_sts import issue_sts
    except Exception as exc:
        logger.error("OSS STS 模块加载失败: %s", exc)
        raise HTTPException(status_code=503, detail="STS service unavailable")

    try:
        cred = issue_sts(
            account_id=current.id,
            task_id=req.task_id,
            mode=req.mode,  # type: ignore
            duration_seconds=req.duration_seconds,
        )
    except Exception as exc:
        logger.error("STS 签发失败: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"STS issue failed: {exc}")

    return STSResp(
        AccessKeyId=cred.access_key_id,
        AccessKeySecret=cred.access_key_secret,
        SecurityToken=cred.security_token,
        ExpiresAt=cred.expires_at,
        Bucket=cred.bucket,
        Endpoint=cred.endpoint or "oss-cn-guangzhou.aliyuncs.com",
        Region=cred.region or "cn-guangzhou",
        Prefix=cred.prefix,
        RequestId=cred.request_id,
    )


class UploadCallbackReq(BaseModel):
    """前端上传完成回调 · 让后端记录文件元数据"""
    object_key: str
    size_bytes: int = 0
    content_type: str = "application/octet-stream"
    task_id: int | str = 0
    sha256: str = ""
    purpose: str = "input"


@router.post("/callback", summary="前端上传完成回调")
async def upload_callback(
    req: UploadCallbackReq,
    current: Account = Depends(get_current_account),
) -> dict[str, Any]:
    """前端 STS 直传完成后调本端点 · 后端入 audit 表。

    IDOR 防护:object_key 必须在本账户的 uploads/tenant_{id}/ 前缀下。
    """
    account_id = current.id
    expected_prefix = f"uploads/tenant_{account_id}/"
    if not current.is_admin and not req.object_key.startswith(expected_prefix):
        logger.warning("上传 callback IDOR 防护 · account=%s key=%s",
                       account_id, req.object_key[:80])
        raise HTTPException(status_code=403, detail="object_key 不属于本账户")

    try:
        from platform_v8.storage.db import get_session_factory
        from sqlalchemy import text
        from datetime import datetime
        with get_session_factory()() as s:
            s.execute(text("""
                INSERT INTO we_audit (actor_account_id, action, target, detail, created_at)
                VALUES (:aid, 'file.upload', :tgt, :dt::jsonb, :ts)
            """), {
                "aid": account_id,
                "tgt": req.object_key,
                "dt": __import__("json").dumps({
                    "object_key": req.object_key,
                    "size_bytes": req.size_bytes,
                    "content_type": req.content_type,
                    "task_id": str(req.task_id) if req.task_id else "",
                    "sha256": req.sha256,
                    "purpose": req.purpose,
                    "filename": os.path.basename(req.object_key),
                }),
                "ts": datetime.utcnow(),
            })
            s.commit()
    except Exception as exc:
        logger.warning("upload callback 写 audit 失败 (非阻塞): %s", exc)

    return {"ok": True, "object_key": req.object_key}


@router.get("/me", summary="列我上传过的文件 (通过 audit 反查)")
async def my_files(current: Account = Depends(get_current_account)) -> dict[str, Any]:
    account_id = current.id
    """v8 没有专门的 uploads 表 · 通过 audit 反查 (轻量 · 适合 UI 列表)"""
    from platform_v8.storage.db import get_session_factory
    from sqlalchemy import text
    with get_session_factory()() as s:
        rows = s.execute(text("""
            SELECT detail, created_at FROM we_audit
            WHERE action = 'file.upload' AND actor_account_id = :aid
            ORDER BY created_at DESC LIMIT 100
        """), {"aid": account_id}).fetchall()
    items = [
        {
            "filename": (r[0] or {}).get("filename", ""),
            "object_key": (r[0] or {}).get("object_key", ""),
            "size": (r[0] or {}).get("size_bytes", 0),
            "purpose": (r[0] or {}).get("purpose", "input"),
            "uploaded_at": r[1].isoformat() if r[1] else None,
        }
        for r in rows
    ]
    return {"ok": True, "total": len(items), "items": items}
