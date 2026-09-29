"""OSS 对象存储抽象层 — 预留接口，支持阿里云 OSS / S3 兼容存储。

核心设计：
    常规链路由客户端直传，中央服务器主要负责签发 presigned URL。
    受信兼容/归一化链路可使用本模块的常量内存流式读写接口，
    但不得把私有签名 URL 暴露给调用方。
    客户端 → OSS 直传上传
    节点   → OSS 直接拉取输入
    节点   → OSS 直接上传结果
    客户端 → OSS 直接下载结果

    中央服务器 = 调度指挥 + 签发凭证

使用方式：
    provider = get_oss_provider()
    upload_url = provider.presign_put("tasks/123/input/data.csv", expires=3600)
    download_url = provider.presign_get("tasks/123/output/result.zip", expires=3600)
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import tempfile
import time
from abc import ABC, abstractmethod
from contextlib import closing
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, BinaryIO, Dict, Iterable, Iterator, List, Optional
from urllib.parse import quote, urlencode

logger = logging.getLogger("services.oss_provider")


# ── 存储模式枚举 ─────────────────────────────────────────────────
class StorageMode(str, Enum):
    """任务的文件传输模式。"""
    LOCAL = "local"        # 走中央服务器中转（现有方式，小文件兜底）
    OSS = "oss"            # 走 OSS 直传（推荐，大文件必须用这个）
    S3 = "s3"              # 走 S3 兼容存储
    CUSTOM_URL = "custom"  # 企业自带文件 URL（节点直接拉取）


# ── Presigned URL 返回结构 ───────────────────────────────────────
@dataclass
class PresignedURL:
    """签名后的 URL 及元数据。"""
    url: str                          # 带签名的完整 URL
    method: str = "PUT"               # PUT=上传, GET=下载
    headers: Dict[str, str] = field(default_factory=dict)  # 请求时需携带的 headers
    expires_at: int = 0               # Unix 时间戳
    object_key: str = ""              # OSS 中的完整 key
    bucket: str = ""


@dataclass(frozen=True)
class StreamWriteResult:
    """Integrity evidence produced by a server-side streaming write."""

    object_key: str
    size_bytes: int
    sha256: str
    content_type: str


class StreamIntegrityError(ValueError):
    """A streamed object exceeded its gate or did not match expected evidence."""


@dataclass
class OSSConfig:
    """OSS 连接配置。"""
    provider: str = "aliyun"          # aliyun / aws / minio / local
    endpoint: str = ""                # 如 https://oss-cn-hangzhou.aliyuncs.com
    bucket: str = ""
    access_key_id: str = ""
    access_key_secret: str = ""
    session_token: str = ""            # optional short-lived STS credential
    region: str = ""                  # 如 cn-hangzhou
    role_arn: str = ""                # STS 临时授权 ARN（可选）
    cdn_domain: str = ""              # CDN 加速域名（可选，下载用）
    internal_endpoint: str = ""       # 内网 endpoint（节点在同 region 时用）
    prefix: str = ""                  # 所有 key 的公共前缀(2026-06-19 改造:空 · 由 build_tenant_prefix 决定)
    addressing_style: str = ""        # 专用桶可独立选择 virtual/path
    # §5.6 护栏④ SSE-KMS 静态加密
    sse_algorithm: str = ""           # "" | "AES256" | "KMS" · 空表示不加密
    kms_key_id: str = ""              # KMS 密钥 ID (sse_algorithm=KMS 时生效)


# ── 抽象基类 ─────────────────────────────────────────────────────
class OSSProvider(ABC):
    """对象存储抽象接口。所有实现必须满足这些方法。"""

    @abstractmethod
    def presign_put(
        self,
        object_key: str,
        *,
        content_type: str = "application/octet-stream",
        expires: int = 3600,
        max_size: int = 0,
    ) -> PresignedURL:
        """生成上传用的 presigned URL（客户端/节点用 PUT 直传到 OSS）。"""
        ...

    @abstractmethod
    def presign_get(
        self,
        object_key: str,
        *,
        expires: int = 3600,
        filename: str = "",
    ) -> PresignedURL:
        """生成下载用的 presigned URL（客户端/节点用 GET 直接从 OSS 拉取）。"""
        ...

    @abstractmethod
    def delete_object(self, object_key: str) -> bool:
        """删除 OSS 上的对象。"""
        ...

    @abstractmethod
    def list_objects(self, prefix: str, max_keys: int = 100) -> List[str]:
        """列出 prefix 下的所有 key。"""
        ...

    @abstractmethod
    def object_exists(self, object_key: str) -> bool:
        """检查对象是否存在。"""
        ...

    def iter_object(
        self,
        object_key: str,
        *,
        chunk_size: int = 1024 * 1024,
    ) -> Iterator[bytes]:
        """Yield one private object without exposing its signed URL to callers."""
        raise NotImplementedError(
            f"{type(self).__name__} does not support server-side reads"
        )

    def _put_fileobj(
        self,
        object_key: str,
        source: BinaryIO,
        *,
        size_bytes: int,
        content_type: str,
    ) -> str:
        raise NotImplementedError(
            f"{type(self).__name__} does not support server-side writes"
        )

    def write_stream(
        self,
        object_key: str,
        chunks: Iterable[bytes],
        *,
        content_type: str = "application/octet-stream",
        max_size: int = 0,
        expected_size: int | None = None,
        expected_sha256: str | None = None,
    ) -> StreamWriteResult:
        """Validate a stream before upload, using constant memory.

        A temporary file keeps provider SDKs from buffering an untrusted stream.
        The destination is not touched until all size/hash gates pass.
        """
        limit = max(0, int(max_size or 0))
        expected = (
            str(expected_sha256 or "").strip().lower() or None
        )
        if expected is not None and (
            len(expected) != 64
            or any(ch not in "0123456789abcdef" for ch in expected)
        ):
            raise StreamIntegrityError("expected_sha256 is invalid")
        digest = hashlib.sha256()
        received = 0
        with tempfile.TemporaryFile(mode="w+b") as staged:
            for chunk in chunks:
                if not isinstance(chunk, (bytes, bytearray, memoryview)):
                    raise StreamIntegrityError("stream yielded a non-bytes chunk")
                data = bytes(chunk)
                if not data:
                    continue
                received += len(data)
                if limit and received > limit:
                    raise StreamIntegrityError("stream exceeds maximum size")
                if expected_size is not None and received > int(expected_size):
                    raise StreamIntegrityError("stream exceeds expected size")
                digest.update(data)
                staged.write(data)
            actual_sha = digest.hexdigest()
            if expected_size is not None and received != int(expected_size):
                raise StreamIntegrityError("stream size mismatch")
            if expected is not None and actual_sha != expected:
                raise StreamIntegrityError("stream sha256 mismatch")
            staged.seek(0)
            self._put_fileobj(
                object_key,
                staged,
                size_bytes=received,
                content_type=content_type,
            )
        return StreamWriteResult(
            object_key=str(object_key),
            size_bytes=received,
            sha256=actual_sha,
            content_type=str(content_type),
        )

    def copy_object(
        self,
        source_key: str,
        destination_key: str,
        *,
        content_type: str = "application/octet-stream",
        max_size: int = 0,
        expected_size: int | None = None,
        expected_sha256: str | None = None,
        chunk_size: int = 1024 * 1024,
    ) -> StreamWriteResult:
        """Safely copy within the configured provider.

        Providers may later override this with a native copy only when source
        integrity can still be proven. The default never trusts ETag as SHA-256.
        """
        return self.write_stream(
            destination_key,
            self.iter_object(source_key, chunk_size=chunk_size),
            content_type=content_type,
            max_size=max_size,
            expected_size=expected_size,
            expected_sha256=expected_sha256,
        )

    def head_object(self, object_key: str) -> Dict[str, Any] | None:
        """Return non-authoritative object metadata when available."""
        return None

    def build_task_paths(self, task_id: str) -> Dict[str, str]:
        """为一个任务生成标准的 OSS 路径模板。"""
        return {
            "input_dir": f"tasks/{task_id}/input/",
            "output_dir": f"tasks/{task_id}/output/",
            "script_dir": f"tasks/{task_id}/scripts/",
            "log_dir": f"tasks/{task_id}/logs/",
        }


# ── 阿里云 OSS 实现 ─────────────────────────────────────────────
class AliyunOSSProvider(OSSProvider):
    """阿里云 OSS presigned URL 实现。

    不依赖 oss2 SDK — 用原生 HMAC-SHA256 签名，零外部依赖。
    生产环境建议换成 oss2 SDK 或 STS 临时凭证。
    """

    def __init__(self, config: OSSConfig):
        self.config = config
        self.bucket = config.bucket
        self.endpoint = config.endpoint.rstrip("/")
        self.access_key_id = config.access_key_id
        self.access_key_secret = config.access_key_secret
        self.prefix = config.prefix.strip("/")
        self.cdn_domain = config.cdn_domain.rstrip("/") if config.cdn_domain else ""

    def _full_key(self, key: str) -> str:
        """拼接 prefix，避免重复。"""
        key = key.lstrip("/")
        if self.prefix and not key.startswith(self.prefix):
            return f"{self.prefix}/{key}"
        return key

    def _sign_url(
        self,
        method: str,
        object_key: str,
        expires: int,
        content_type: str = "",
    ) -> str:
        """OSS V1 签名（兼容性最好）。"""
        full_key = self._full_key(object_key)
        expire_ts = int(time.time()) + expires
        string_to_sign = f"{method}\n\n{content_type}\n{expire_ts}\n/{self.bucket}/{full_key}"
        signature = hmac.new(
            self.access_key_secret.encode("utf-8"),
            string_to_sign.encode("utf-8"),
            hashlib.sha1,
        ).digest()
        import base64
        sig_b64 = base64.b64encode(signature).decode()
        params = urlencode({
            "OSSAccessKeyId": self.access_key_id,
            "Expires": str(expire_ts),
            "Signature": sig_b64,
        })
        host = f"https://{self.bucket}.{self.endpoint.replace('https://', '').replace('http://', '')}"
        return f"{host}/{quote(full_key, safe='/')}?{params}"

    def presign_put(
        self,
        object_key: str,
        *,
        content_type: str = "application/octet-stream",
        expires: int = 3600,
        max_size: int = 0,
    ) -> PresignedURL:
        full_key = self._full_key(object_key)
        url = self._sign_url("PUT", object_key, expires, content_type)
        headers = {"Content-Type": content_type}
        # §5.6 护栏④ SSE-KMS 静态加密 (上传后 OSS 服务端加密存储)
        sse = (self.config.sse_algorithm or "").upper()
        if sse == "KMS":
            headers["x-oss-server-side-encryption"] = "KMS"
            if self.config.kms_key_id:
                headers["x-oss-server-side-encryption-key-id"] = self.config.kms_key_id
        elif sse == "AES256":
            headers["x-oss-server-side-encryption"] = "AES256"
        return PresignedURL(
            url=url,
            method="PUT",
            headers=headers,
            expires_at=int(time.time()) + expires,
            object_key=full_key,
            bucket=self.bucket,
        )

    def presign_get(
        self,
        object_key: str,
        *,
        expires: int = 3600,
        filename: str = "",
    ) -> PresignedURL:
        full_key = self._full_key(object_key)
        # 优先用 CDN 域名
        if self.cdn_domain:
            url = f"{self.cdn_domain}/{quote(full_key, safe='/')}"
        else:
            url = self._sign_url("GET", object_key, expires)
        return PresignedURL(
            url=url,
            method="GET",
            expires_at=int(time.time()) + expires,
            object_key=full_key,
            bucket=self.bucket,
        )

    def delete_object(self, object_key: str) -> bool:
        # Normalization cleanup must not silently retain partial tenant data.
        # OSS V1 supports DELETE with the same signed-object convention used
        # for PUT/GET, so keep this provider dependency-free.
        import urllib.error
        import urllib.request
        try:
            url = self._sign_url("DELETE", object_key, expires=300)
            request = urllib.request.Request(url, method="DELETE")
            with urllib.request.urlopen(request, timeout=15) as response:
                return 200 <= int(response.status) < 300
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return True
            logger.warning("[OSS] delete_object failed · status=%s", exc.code)
            return False
        except Exception as exc:
            logger.warning("[OSS] delete_object failed: %s", type(exc).__name__)
            return False

    def list_objects(self, prefix: str, max_keys: int = 100) -> List[str]:
        logger.info("[OSS] list_objects(%s) — 需要 oss2 SDK 实现", prefix)
        return []

    def object_exists(self, object_key: str) -> bool:
        logger.info("[OSS] object_exists(%s) — 需要 oss2 SDK 实现", object_key)
        return False

    def iter_object(
        self,
        object_key: str,
        *,
        chunk_size: int = 1024 * 1024,
    ) -> Iterator[bytes]:
        """Read through a short-lived provider-issued URL, kept internal."""
        import urllib.request

        url = self._sign_url("GET", object_key, expires=300)
        request = urllib.request.Request(url, method="GET")
        with closing(urllib.request.urlopen(request, timeout=180)) as response:
            status = int(getattr(response, "status", 200))
            if not 200 <= status < 300:
                raise OSError(f"Aliyun OSS GET failed with status {status}")
            while True:
                chunk = response.read(max(64 * 1024, int(chunk_size)))
                if not chunk:
                    break
                yield bytes(chunk)

    def _put_fileobj(
        self,
        object_key: str,
        source: BinaryIO,
        *,
        size_bytes: int,
        content_type: str,
    ) -> str:
        import urllib.request

        url = self._sign_url(
            "PUT", object_key, expires=300, content_type=content_type,
        )
        headers = {
            "Content-Type": content_type,
            "Content-Length": str(int(size_bytes)),
        }
        sse = (self.config.sse_algorithm or "").upper()
        if sse == "KMS":
            headers["x-oss-server-side-encryption"] = "KMS"
            if self.config.kms_key_id:
                headers["x-oss-server-side-encryption-key-id"] = (
                    self.config.kms_key_id
                )
        elif sse == "AES256":
            headers["x-oss-server-side-encryption"] = "AES256"
        request = urllib.request.Request(
            url,
            data=source,
            headers=headers,
            method="PUT",
        )
        with closing(urllib.request.urlopen(request, timeout=180)) as response:
            status = int(getattr(response, "status", 200))
            if not 200 <= status < 300:
                raise OSError(f"Aliyun OSS PUT failed with status {status}")
        return self._full_key(object_key)


# ── 本地回退实现（开发/测试用）────────────────────────────────────
def _local_oss_secret() -> bytes:
    """Local presigns require a configured secret, never a public default."""
    raw = (
        os.getenv("V8_LOCAL_OSS_SECRET")
        or os.getenv("V8_JWT_SECRET")
    )
    if not raw or len(raw) < 32:
        raise RuntimeError("local OSS signing requires a private secret of at least 32 characters")
    return str(raw).encode("utf-8")


def sign_local_object(
    method: str,
    object_key: str,
    expires: int,
    max_size: int = 0,
) -> str:
    """签发本地直传 query sig（浏览器不需要 Authorization，贴近真 OSS 预签名）。"""
    key = (object_key or "").lstrip("/")
    msg = f"{method.upper()}\n{key}\n{int(expires)}\n{max(0, int(max_size or 0))}".encode("utf-8")
    return hmac.new(_local_oss_secret(), msg, hashlib.sha256).hexdigest()


def verify_local_object_sig(
    method: str,
    object_key: str,
    expires: int | str | None,
    sig: str | None,
    max_size: int | str | None = 0,
) -> bool:
    if not expires or not sig:
        return False
    try:
        exp = int(expires)
    except (TypeError, ValueError):
        return False
    if exp < int(time.time()) - 30:  # 30s 时钟容差
        return False
    try:
        size = max(0, int(max_size or 0))
    except (TypeError, ValueError):
        return False
    try:
        expect = sign_local_object(method, object_key, exp, size)
    except RuntimeError:
        return False
    if hmac.compare_digest(expect, str(sig).strip().lower()) or hmac.compare_digest(
        expect, str(sig).strip()
    ):
        return True
    # Pre-P1 local URLs did not bind a size. Keep them valid until expiry;
    # they are treated as explicitly unbounded and are still protected by the
    # server-wide local upload limit.
    if size == 0:
        legacy_msg = f"{method.upper()}\n{(object_key or '').lstrip('/')}\n{exp}".encode("utf-8")
        legacy = hmac.new(_local_oss_secret(), legacy_msg, hashlib.sha256).hexdigest()
        return hmac.compare_digest(legacy, str(sig).strip().lower())
    return False


class LocalFallbackProvider(OSSProvider):
    """本地文件系统模拟 OSS 行为 — 开发和测试阶段使用。

    presign_put/get 返回本机 API 的 /api/v8/oss/local/* URL，
    并在 query 带 HMAC `expires`/`sig`（像真 OSS 预签名），
    浏览器 PUT 无需 Authorization，避免企业端 XHR 401。
    """

    def __init__(self, storage_root: str = "", base_url: str = ""):
        default_root = os.path.join(
            os.path.expanduser("~"), ".qianshou", "local-oss"
        )
        self.storage_root = storage_root or os.getenv("STORAGE_PATH") or default_root
        # 浏览器直传需要绝对 URL · 空则回落到本机后端
        self.base_url = (
            base_url.rstrip("/")
            or os.getenv("API_BASE_URL", "").rstrip("/")
            or os.getenv("V8_PUBLIC_BASE_URL", "").rstrip("/")
            or "http://127.0.0.1:8000"
        )
        os.makedirs(self.storage_root, exist_ok=True)

    def _abs(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _local_path(self, object_key: str) -> Path:
        key = str(object_key or "").replace("\\", "/").lstrip("/")
        if not key or any(part in {"", ".", ".."} for part in key.split("/")):
            raise ValueError("invalid local object key")
        root = Path(self.storage_root).resolve()
        candidate = (root / key).resolve()
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise ValueError("local object key escapes storage root") from exc
        return candidate

    def _signed_url(
        self, method: str, object_key: str, expires: int, max_size: int = 0,
    ) -> str:
        exp = int(time.time()) + max(60, int(expires))
        size = max(0, int(max_size or 0))
        sig = sign_local_object(method, object_key, exp, size)
        q = urlencode({"expires": str(exp), "max_size": str(size), "sig": sig})
        path = f"/api/v8/oss/local/{'upload' if method.upper() == 'PUT' else 'download'}/{quote(object_key, safe='/')}"
        return self._abs(f"{path}?{q}")

    def presign_put(
        self,
        object_key: str,
        *,
        content_type: str = "application/octet-stream",
        expires: int = 3600,
        max_size: int = 0,
    ) -> PresignedURL:
        url = self._signed_url("PUT", object_key, expires, max_size)
        return PresignedURL(
            url=url,
            method="PUT",
            headers={"Content-Type": content_type},
            expires_at=int(time.time()) + expires,
            object_key=object_key,
            bucket="local",
        )

    def presign_get(
        self,
        object_key: str,
        *,
        expires: int = 3600,
        filename: str = "",
    ) -> PresignedURL:
        url = self._signed_url("GET", object_key, expires)
        return PresignedURL(
            url=url,
            method="GET",
            expires_at=int(time.time()) + expires,
            object_key=object_key,
            bucket="local",
        )

    def delete_object(self, object_key: str) -> bool:
        path = self._local_path(object_key)
        if path.exists():
            path.unlink()
            return True
        return False

    def list_objects(self, prefix: str, max_keys: int = 100) -> List[str]:
        base = os.path.join(self.storage_root, prefix)
        if not os.path.isdir(base):
            return []
        results = []
        for root, _, files in os.walk(base):
            for f in files:
                fp = os.path.join(root, f)
                results.append(os.path.relpath(fp, self.storage_root))
                if len(results) >= max_keys:
                    return results
        return results

    def object_exists(self, object_key: str) -> bool:
        return self._local_path(object_key).is_file()

    def put_file(self, object_key: str, file_path: str, content_type: str = "application/octet-stream") -> str:
        """QA/LAN · 让 files.direct-put 走稳定 object_key（不再回退 blob URL）。"""
        path = Path(file_path)
        size = path.stat().st_size
        with path.open("rb") as source:
            return self._put_fileobj(
                object_key,
                source,
                size_bytes=size,
                content_type=content_type or "application/octet-stream",
            )

    def iter_object(
        self,
        object_key: str,
        *,
        chunk_size: int = 1024 * 1024,
    ) -> Iterator[bytes]:
        with self._local_path(object_key).open("rb") as source:
            while True:
                chunk = source.read(max(64 * 1024, int(chunk_size)))
                if not chunk:
                    break
                yield chunk

    def _put_fileobj(
        self,
        object_key: str,
        source: BinaryIO,
        *,
        size_bytes: int,
        content_type: str,
    ) -> str:
        destination = self._local_path(object_key)
        destination.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(
            prefix=f".{destination.name}.", dir=str(destination.parent),
        )
        try:
            with os.fdopen(fd, "wb") as output:
                copied = 0
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    copied += len(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            if copied != int(size_bytes):
                raise StreamIntegrityError("local write size mismatch")
            os.replace(temporary, destination)
        except Exception:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise
        return str(object_key)

    def head_object(self, object_key: str) -> Dict[str, Any] | None:
        path = self._local_path(object_key)
        if not path.is_file():
            return None
        return {
            "content_length": path.stat().st_size,
            "content_type": "application/octet-stream",
        }


# ── S3 / MinIO 兼容（SigV4 · path-style）──────────────────────────
class S3CompatibleProvider(OSSProvider):
    """自建 MinIO / 任意 S3 兼容存储。

    - 内网 endpoint 用于服务端 put/get/list
    - 预签名用公网 endpoint（签名含 Host，禁止签完再改域名）
    - path-style：https://oss.example.com/{bucket}/{key}
    """

    def __init__(self, config: OSSConfig):
        self.config = config
        self.bucket = config.bucket
        self.region = config.region or "us-east-1"
        self.public_endpoint = (config.endpoint or "").rstrip("/")
        self.internal_endpoint = (
            (config.internal_endpoint or config.endpoint or "").rstrip("/")
        )
        if not self.public_endpoint or not config.access_key_id or not config.access_key_secret:
            raise ValueError("S3CompatibleProvider 需要 endpoint + access_key")
        # 腾讯云 COS 禁止 path-style（PathStyleDomainForbidden）；MinIO 用 path。
        # 可用 OSS_ADDRESSING_STYLE=virtual/path 显式覆盖。
        _style = (config.addressing_style or os.getenv("OSS_ADDRESSING_STYLE") or ("virtual" if (config.provider or "").strip().lower() == "cos" else "path")).strip().lower()
        self.addressing_style = _style if _style in ("virtual", "path") else "path"
        self._public = self._make_client(self.public_endpoint)
        self._internal = self._make_client(self.internal_endpoint)

    def _make_client(self, endpoint: str):
        import boto3
        from botocore.client import Config

        return boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=self.config.access_key_id,
            aws_secret_access_key=self.config.access_key_secret,
            aws_session_token=self.config.session_token or None,
            region_name=self.region,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": self.addressing_style},
                # COS 不支持 botocore>=1.36 默认的流式校验和（分片 UploadPart 会缺
                # Content-Length 报 MissingContentLength），改为仅在必需时计算
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        )

    def _full_key(self, object_key: str) -> str:
        key = (object_key or "").lstrip("/")
        if self.config.prefix:
            p = self.config.prefix.strip("/")
            if not key.startswith(p + "/") and key != p:
                key = f"{p}/{key}" if key else p
        return key

    def presign_put(
        self,
        object_key: str,
        *,
        content_type: str = "application/octet-stream",
        expires: int = 3600,
        max_size: int = 0,
        metadata: Dict[str, str] | None = None,
    ) -> PresignedURL:
        full_key = self._full_key(object_key)
        params: Dict[str, Any] = {"Bucket": self.bucket, "Key": full_key}
        headers: Dict[str, str] = {}
        if content_type:
            params["ContentType"] = content_type
            headers["Content-Type"] = content_type
        if metadata:
            if (set(metadata) != {"sha256"} or not isinstance(metadata["sha256"], str)
                    or len(metadata["sha256"]) != 64
                    or any(char not in "0123456789abcdef" for char in metadata["sha256"])):
                raise ValueError("upload SHA256 metadata invalid")
            params["Metadata"] = dict(metadata)
            headers["x-amz-meta-sha256"] = metadata["sha256"]
        url = self._public.generate_presigned_url(
            "put_object",
            Params=params,
            ExpiresIn=int(expires),
            HttpMethod="PUT",
        )
        return PresignedURL(
            url=url,
            method="PUT",
            headers=headers,
            expires_at=int(time.time()) + int(expires),
            object_key=full_key,
            bucket=self.bucket,
        )

    def presign_get(
        self,
        object_key: str,
        *,
        expires: int = 3600,
        filename: str = "",
    ) -> PresignedURL:
        full_key = self._full_key(object_key)
        params: Dict[str, Any] = {"Bucket": self.bucket, "Key": full_key}
        if filename:
            params["ResponseContentDisposition"] = f'attachment; filename="{filename}"'
        url = self._public.generate_presigned_url(
            "get_object",
            Params=params,
            ExpiresIn=int(expires),
            HttpMethod="GET",
        )
        return PresignedURL(
            url=url,
            method="GET",
            expires_at=int(time.time()) + int(expires),
            object_key=full_key,
            bucket=self.bucket,
        )

    def put_file(
        self,
        object_key: str,
        file_path: str,
        *,
        content_type: str = "application/octet-stream",
    ) -> str:
        """服务端直传本地文件到桶，返回 object_key。"""
        full_key = self._full_key(object_key)
        extra: Dict[str, Any] = {}
        if content_type:
            extra["ContentType"] = content_type
        self._internal.upload_file(
            file_path,
            self.bucket,
            full_key,
            ExtraArgs=extra or None,
        )
        return full_key

    def put_bytes(
        self,
        object_key: str,
        data: bytes,
        *,
        content_type: str = "application/octet-stream",
    ) -> str:
        full_key = self._full_key(object_key)
        self._internal.put_object(
            Bucket=self.bucket,
            Key=full_key,
            Body=data,
            ContentType=content_type,
        )
        return full_key

    def iter_object(
        self,
        object_key: str,
        *,
        chunk_size: int = 1024 * 1024,
    ) -> Iterator[bytes]:
        full_key = self._full_key(object_key)
        response = self._internal.get_object(
            Bucket=self.bucket,
            Key=full_key,
        )
        body = response["Body"]
        try:
            while True:
                chunk = body.read(max(64 * 1024, int(chunk_size)))
                if not chunk:
                    break
                yield bytes(chunk)
        finally:
            close = getattr(body, "close", None)
            if callable(close):
                close()

    def _put_fileobj(
        self,
        object_key: str,
        source: BinaryIO,
        *,
        size_bytes: int,
        content_type: str,
    ) -> str:
        full_key = self._full_key(object_key)
        params: Dict[str, Any] = {
            "Bucket": self.bucket,
            "Key": full_key,
            "Body": source,
            "ContentLength": int(size_bytes),
        }
        if content_type:
            params["ContentType"] = content_type
        self._internal.put_object(**params)
        return full_key

    def delete_object(self, object_key: str) -> bool:
        full_key = self._full_key(object_key)
        try:
            self._internal.delete_object(Bucket=self.bucket, Key=full_key)
            return True
        except Exception as exc:
            logger.warning("[OSS/S3] delete_object failed: %s", exc)
            return False

    def list_objects(self, prefix: str, max_keys: int = 100) -> List[str]:
        full_prefix = self._full_key(prefix)
        resp = self._internal.list_objects_v2(
            Bucket=self.bucket, Prefix=full_prefix, MaxKeys=max_keys
        )
        return [o["Key"] for o in (resp.get("Contents") or [])]

    def object_exists(self, object_key: str) -> bool:
        full_key = self._full_key(object_key)
        try:
            self._internal.head_object(Bucket=self.bucket, Key=full_key)
            return True
        except Exception:
            return False

    def head_object(self, object_key: str) -> Dict[str, Any] | None:
        full_key = self._full_key(object_key)
        try:
            resp = self._internal.head_object(Bucket=self.bucket, Key=full_key)
            metadata = resp.get("Metadata") or {}
            return {
                "size_bytes": resp.get("ContentLength"),
                "sha256": str(metadata.get("sha256") or "").lower(),
                "object_version_id": resp.get("VersionId"),
                "content_length": resp.get("ContentLength"),
                "content_type": resp.get("ContentType"),
                "etag": resp.get("ETag"),
                "last_modified": resp.get("LastModified"),
            }
        except Exception:
            return None


# ── 全局单例工厂 ─────────────────────────────────────────────────
_provider: Optional[OSSProvider] = None


def configure_oss(config: Optional[OSSConfig] = None) -> OSSProvider:
    """初始化 OSS provider（应用启动时调用一次）。"""
    global _provider
    if config is None:
        config = load_oss_config_from_env()
    provider = (config.provider or "local").strip().lower()
    if provider in ("minio", "s3", "aws", "cos") and config.access_key_id:
        _provider = S3CompatibleProvider(config)
        logger.info(
            "[OSS] 已启用 S3/MinIO — bucket=%s public=%s internal=%s",
            config.bucket,
            config.endpoint,
            config.internal_endpoint,
        )
    elif provider == "aliyun" and config.access_key_id:
        _provider = AliyunOSSProvider(config)
        logger.info("[OSS] 已启用阿里云 OSS — bucket=%s endpoint=%s", config.bucket, config.endpoint)
    else:
        _provider = LocalFallbackProvider()
        logger.info(
            "[OSS] 使用本地回退存储 · root=%s base=%s",
            _provider.storage_root,
            _provider.base_url,
        )
    return _provider


def get_oss_provider() -> OSSProvider:
    """获取 OSS provider 单例。未初始化时自动回退到本地。"""
    global _provider
    if _provider is None:
        _provider = configure_oss()
    return _provider


def load_oss_config_from_env() -> OSSConfig:
    """从环境变量加载 OSS 配置。

    2026-08 MinIO 本机存储（阿里云欠费废弃）:
      OSS_PROVIDER=minio
      OSS_BUCKET=edgecompute
      OSS_ENDPOINT=https://oss.qianshousuanli.com
      OSS_INTERNAL_ENDPOINT=http://127.0.0.1:9000
      OSS_REGION=us-east-1
    """
    return OSSConfig(
        provider=os.getenv("OSS_PROVIDER", "local"),
        endpoint=os.getenv("OSS_ENDPOINT", "https://oss.qianshousuanli.com"),
        bucket=os.getenv("OSS_BUCKET", "edgecompute"),
        access_key_id=os.getenv("OSS_ACCESS_KEY_ID", ""),
        access_key_secret=os.getenv("OSS_ACCESS_KEY_SECRET", ""),
        region=os.getenv("OSS_REGION", "us-east-1"),
        role_arn=os.getenv("OSS_ROLE_ARN", ""),
        cdn_domain=os.getenv("OSS_CDN_DOMAIN", ""),
        internal_endpoint=os.getenv(
            "OSS_INTERNAL_ENDPOINT",
            "http://127.0.0.1:9000",
        ),
        prefix=os.getenv("OSS_PREFIX", ""),
        addressing_style=os.getenv("OSS_ADDRESSING_STYLE", ""),
        sse_algorithm=os.getenv("OSS_SSE_ALGORITHM", ""),
        kms_key_id=os.getenv("OSS_KMS_KEY_ID", ""),
    )
