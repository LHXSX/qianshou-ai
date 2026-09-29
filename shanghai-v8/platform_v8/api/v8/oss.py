"""
OSS Presigned URL 路由 — /api/v8/oss/*
直接挂载在 v8 app 上，跟 v1 的 /api/v1/oss/* 完全独立

核心理念：中央服务器不碰文件，只签发凭证。
"""
from __future__ import annotations
import logging
import os
import time
import hmac
import hashlib
import base64
import uuid
from urllib.parse import urlencode, quote
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from platform_v8.api.deps import get_session, get_current_account, get_admin_account
from platform_v8.core import Account
from platform_v8.services.oss_provider import (
    StorageMode, get_oss_provider,
)
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/oss", tags=["oss"])


# ── Request / Response ───────────────────────────────

class UploadURLRequest(BaseModel):
    filename: str = Field(..., description="文件名")
    task_id: int = Field(0, description="关联任务ID")
    content_type: str = "application/octet-stream"
    mode: str = "task_input"  # task_input / task_output / script / custom

class UploadURLResponse(BaseModel):
    upload_url: str
    object_key: str
    expires_in: int
    storage_mode: str

class DownloadURLRequest(BaseModel):
    object_key: str
    # 下载 URL · 默认 1h (S2-T8 · 2026-06-07 缩短泄露窗口)
    # admin 长任务场景由 broker._refresh_oss_url 自动重签;手工长链可显式传更大值
    expires_in: int = 3600

class DownloadURLResponse(BaseModel):
    download_url: str
    expires_in: int
    storage_mode: str


# ── 上传 presigned URL ───────────────────────────────

@router.post("/upload-url")
async def get_upload_url(
    req: UploadURLRequest,
    request: Request,
    current: Account = Depends(get_current_account),
):
    """S2-T7 (2026-06-07) · object_key 命名强制 owner 前缀
    旧版 key=`tasks/{task_id}/input/{filename}` 任意登录用户可签,与 /files/* 模型不一致。
    现统一为 `v8/account-{owner_id}/{task_id}/input/{uuid}-{filename}`,
    与 platform_v8/api/v8/files.py 一致,download-url 归属校验才能生效。
    """
    import os as _os
    import uuid as _uuid
    provider = get_oss_provider()
    task_part = str(req.task_id) if req.task_id else "unassigned"
    safe_name = _os.path.basename(req.filename).replace("\x00", "") or "file"
    file_id = _uuid.uuid4().hex[:16]
    key = f"v8/account-{current.id}/{task_part}/input/{file_id}-{safe_name}"
    # 上传 URL · 6h (给慢网络 / 大文件 / 续传留余地)
    _UPLOAD_EXPIRES = 21600
    presigned = provider.presign_put(
        key,
        content_type=req.content_type,
        expires=_UPLOAD_EXPIRES,
    )
    return UploadURLResponse(
        upload_url=presigned.url,
        object_key=presigned.object_key,
        expires_in=_UPLOAD_EXPIRES,
        storage_mode="oss" if "aliyuncs" in presigned.url else "local",
    )


# ── 下载 presigned URL ───────────────────────────────

@router.post("/download-url")
async def get_download_url(
    req: DownloadURLRequest,
    request: Request,
    # 2026-06-04 安全 · 堵 IDOR:此端点 key=tasks/{id}/... 不含 account 无法按归属校验,
    # 而现役调用方为 0(节点走 input_ref 直链·前端走 /files)→ 收紧为 admin-only,零误伤。
    _admin: Account = Depends(get_admin_account),
):
    from platform_v8.services.storage_refs import is_protected_media_result_ref
    if is_protected_media_result_ref(req.object_key):
        raise HTTPException(status_code=409, detail="媒体结果须通过独立核验后的查看授权获取")
    provider = get_oss_provider()
    presigned = provider.presign_get(
        req.object_key,
        expires=req.expires_in,
    )
    return DownloadURLResponse(
        download_url=presigned.url,
        expires_in=req.expires_in,
        storage_mode="oss" if "aliyuncs" in presigned.url else "local",
    )


# ── 任务结果下载 URL ─────────────────────────────────

@router.post("/result-url")
async def get_result_url(
    req: DownloadURLRequest,
    request: Request,
    # 2026-06-04 安全 · 同 download-url:收紧 admin-only 堵 IDOR(现役走 /workloads/{id}/download)
    _admin: Account = Depends(get_admin_account),
):
    """任务结果下载 · 路径约定: tasks/{task_id}/output/{filename}"""
    from platform_v8.services.storage_refs import is_protected_media_result_ref
    if is_protected_media_result_ref(req.object_key):
        raise HTTPException(status_code=409, detail="媒体结果须通过独立核验后的查看授权获取")
    provider = get_oss_provider()
    key = f"tasks/{req.object_key}"
    presigned = provider.presign_get(
        key,
        expires=req.expires_in,
    )
    return DownloadURLResponse(
        download_url=presigned.url,
        expires_in=req.expires_in,
        storage_mode="oss" if "aliyuncs" in presigned.url else "local",
    )


# ── 本地回退存储 (开发 · 无阿里云 OSS 时) ─────────────────────────
# LocalFallbackProvider 签发本路由 · 浏览器/节点直传文件到本机磁盘

def _local_storage_root() -> str:
    from platform_v8.services.oss_provider import get_oss_provider, LocalFallbackProvider
    p = get_oss_provider()
    if isinstance(p, LocalFallbackProvider):
        return p.storage_root
    return os.path.join(os.path.expanduser("~"), ".qianshou", "local-oss")


def _safe_local_path(object_key: str) -> str:
    """防 path traversal · 归一化到 storage_root 内。"""
    key = (object_key or "").lstrip("/")
    if not key or ".." in key.split("/"):
        raise HTTPException(status_code=400, detail="invalid object_key")
    root = os.path.realpath(_local_storage_root())
    full = os.path.realpath(os.path.join(root, key))
    if not full.startswith(root + os.sep) and full != root:
        raise HTTPException(status_code=400, detail="object_key escapes storage root")
    return full


def _local_upload_limit(max_size: int | None) -> int:
    """Return the signed limit, additionally bounded by the local server cap."""
    try:
        configured = int(os.getenv("V8_LOCAL_OSS_MAX_BYTES") or 2 * 1024 * 1024 * 1024)
    except ValueError:
        configured = 2 * 1024 * 1024 * 1024
    configured = max(1, configured)
    signed = max(0, int(max_size or 0))
    return min(configured, signed) if signed else configured


def _authorize_local_bearer(request: Request, object_key: str, session: Session) -> None:
    """A bearer fallback is scoped to the current active account's objects.

    A presigned URL is the explicit delegated credential for a particular
    object. An ordinary access JWT is not a file-wide credential and must not
    bypass the separate media-result viewing authorization.
    """
    from platform_v8.services.auth import token as token_svc
    from platform_v8.services.auth import validation as auth_validation
    from platform_v8.services.storage_refs import (
        StorageReferenceError, is_protected_media_result_ref,
        validate_owned_object_key,
    )

    try:
        token = token_svc.extract_bearer(request.headers.get("authorization"))
        validated = auth_validation.validate_v8_access(session, token, touch=False)
    except (token_svc.TokenError, auth_validation.AuthValidationError) as exc:
        raise HTTPException(status_code=401, detail="invalid authorization") from exc
    if is_protected_media_result_ref(object_key):
        raise HTTPException(status_code=403, detail="media result requires separate authorization")
    try:
        validate_owned_object_key(validated.account.id, object_key)
    except (StorageReferenceError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=403, detail="object is not owned by this account") from exc


@router.put("/local/upload/{object_key:path}")
async def local_upload(
    object_key: str,
    request: Request,
    expires: int | None = None,
    sig: str | None = None,
    max_size: int | None = None,
    session: Session = Depends(get_session),
):
    """本地 OSS 回退 · PUT 落盘 (dev/LAN)。

    鉴权二选一（贴近真 OSS 预签名，浏览器 XHR 无需 Authorization）:
      1) query expires + sig (LocalFallbackProvider 签发)
      2) Authorization: Bearer … active JWT, restricted to own object namespace
    """
    from platform_v8.services.oss_provider import verify_local_object_sig

    ok = verify_local_object_sig("PUT", object_key, expires, sig, max_size)
    if not ok:
        _authorize_local_bearer(request, object_key, session)

    limit = _local_upload_limit(max_size)
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > limit:
        raise HTTPException(status_code=413, detail="upload exceeds permitted size")

    path = _safe_local_path(object_key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    part_path = f"{path}.{uuid.uuid4().hex}.part"
    written = 0
    try:
        with open(part_path, "xb") as fh:
            async for chunk in request.stream():
                written += len(chunk)
                if written > limit:
                    raise HTTPException(status_code=413, detail="upload exceeds permitted size")
                fh.write(chunk)
        os.replace(part_path, path)
    except Exception:
        try:
            os.unlink(part_path)
        except FileNotFoundError:
            pass
        raise
    logger.info("oss.local.upload · key=%s bytes=%d", object_key, written)
    return {"ok": True, "object_key": object_key, "size": written}


@router.get("/local/download/{object_key:path}")
async def local_download(
    object_key: str,
    request: Request,
    expires: int | None = None,
    sig: str | None = None,
    session: Session = Depends(get_session),
):
    """本地 OSS 回退 · GET 读盘 · 签名 URL 或 JWT。"""
    from fastapi.responses import FileResponse
    from platform_v8.services.oss_provider import verify_local_object_sig

    ok = verify_local_object_sig("GET", object_key, expires, sig)
    if not ok:
        _authorize_local_bearer(request, object_key, session)

    path = _safe_local_path(object_key)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="object not found")
    return FileResponse(path, filename=os.path.basename(path))


# ── 公共资产镜像 (节点拉模型/runtime/二进制) ────────────────────
#
# 2026-06-12 · 商用 OSS 私有 bucket 方案
# - 14 个公共资产已传到 oss://wuji-compute/ (v1/ onnxruntime/ binaries/)
# - 阿里云 BPA 默认 ON · 不允许设公共读 → 客户端匿名 HEAD 403
# - 不放公共读 (更安全) · 走这个路由 302 重定向到 OSS 预签名 URL
# - 节点匿名 GET · prefix 白名单防越界 · 1h 签名有效期足够下载 466 MB
#
# 客户端链路:
# 2026-06-19 OSS 改造完成 · edgecompute bucket (oss-cn-guangzhou · 私有 · BPA on)
# 公共资产传到 oss://edgecompute/{runtime,models,releases}/
# 主链路是 CDN(by/models/dl.qianshousuanli.com)· 本路由是 BPA 私有 bucket 的兜底
#
# 客户端链路(快路径):
#   GET https://by.qianshousuanli.com/runtime/ffmpeg/v7.0/macos-arm64/ffmpeg.tar.gz
#      → CDN 边缘缓存返回(国内 <100ms)
#
# 客户端链路(慢/兜底):
#   GET https://www.qianshousuanli.com/api/v8/oss/asset-mirror/runtime/ffmpeg/v7.0/...
#      → 302 → https://edgecompute.oss-cn-guangzhou.aliyuncs.com/runtime/ffmpeg/...?Signature=...

# 白名单 · 防越界访问 uploads/(企业 PII)
_PUBLIC_ASSET_PREFIXES = (
    "runtime/",   # ffmpeg / uv / python venv / onnxruntime / pypi
    "models/",    # ONNX 模型
    "releases/",  # 客户端 OTA 包
    # 兼容旧 prefix(过渡期 · 数据迁移完成后可删):
    "v1/", "onnxruntime/", "ffmpeg/", "binaries/",
)
_PUBLIC_ASSET_EXPIRES = 3600  # 1h · 大文件慢网够用


@router.head("/asset-mirror/{asset_path:path}")
@router.get("/asset-mirror/{asset_path:path}")
async def asset_mirror(asset_path: str, request: Request):
    """公共资产镜像 · 给节点客户端拉模型/runtime/二进制 · 免登录 · 返 302。

    白名单 prefix 防越界访问 OSS 上的任务输入/输出(那些含 PII)。
    """
    if not asset_path or ".." in asset_path or "\\" in asset_path:
        raise HTTPException(400, "invalid path")
    if not any(asset_path.startswith(p) for p in _PUBLIC_ASSET_PREFIXES):
        raise HTTPException(404, "not a public asset")

    bucket = os.getenv("OSS_BUCKET", "")
    endpoint = os.getenv("OSS_ENDPOINT", "")
    ak = os.getenv("OSS_ACCESS_KEY_ID", "")
    sk = os.getenv("OSS_ACCESS_KEY_SECRET", "")
    if not (bucket and endpoint and ak and sk):
        raise HTTPException(503, "OSS not configured")

    expire_ts = int(time.time()) + _PUBLIC_ASSET_EXPIRES
    string_to_sign = f"GET\n\n\n{expire_ts}\n/{bucket}/{asset_path}"
    sig = hmac.new(sk.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha1).digest()
    params = urlencode({
        "OSSAccessKeyId": ak,
        "Expires": str(expire_ts),
        "Signature": base64.b64encode(sig).decode(),
    })
    host = endpoint.replace("https://", "").replace("http://", "").rstrip("/")
    target = f"https://{host}/{bucket}/{quote(asset_path, safe='/')}?{params}"
    return RedirectResponse(target, status_code=302)


# ── 任务 OSS 路径模板 ────────────────────────────────

@router.get("/task-paths/{task_id}")
async def get_task_oss_paths(
    task_id: str,
    current: Account = Depends(get_current_account),
):
    provider = get_oss_provider()
    paths = provider.build_task_paths(task_id)
    return {
        "task_id": task_id,
        "input_dir": paths["input_dir"],
        "output_dir": paths["output_dir"],
        "script_dir": paths["script_dir"],
        "log_dir": paths["log_dir"],
        "storage_mode": "oss",
    }
