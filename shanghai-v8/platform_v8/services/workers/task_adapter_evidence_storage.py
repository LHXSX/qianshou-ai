"""Dedicated, locked review-evidence storage for adapter archives and media.

The existing general-purpose media bucket is deliberately never used here.
Shanghai only issues direct PUT grants and reads storage control metadata;
Guangzhou independently reads the exact versions and verifies object bytes.
"""
from __future__ import annotations

import base64
import json
import os
import stat
import time
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlsplit

from platform_v8.services.oss_provider import OSSConfig, S3CompatibleProvider, get_oss_provider


class EvidenceStorageUnavailable(RuntimeError):
    pass


_PREFIX = "V8_TASK_ADAPTER_EVIDENCE_OSS_"


def _temporary_credential(*, bucket: str, region: str, endpoint: str) -> tuple[str, str, str] | None:
    """Read a rotated, scoped STS credential at grant time, never at process start."""
    path = os.environ.get(_PREFIX + "STS_FILE", "").strip()
    if not path:
        return None
    if not Path(path).is_absolute():
        raise EvidenceStorageUnavailable("审核证据桶临时凭据文件路径无效")
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077
                    or info.st_uid != os.geteuid() or info.st_size > 16384):
                raise EvidenceStorageUnavailable("审核证据桶临时凭据文件权限无效")
            data = json.loads(source.read(16385))
    except EvidenceStorageUnavailable:
        raise
    except (OSError, ValueError, TypeError) as exc:
        raise EvidenceStorageUnavailable("审核证据桶临时凭据不可读取") from exc
    if (not isinstance(data, dict)
            or data.get("schema") != "qianshou.oss-sts.v1"
            or data.get("bucket") != bucket
            or data.get("region") != region
            or data.get("endpoint") != endpoint
            or type(data.get("expires_at")) is not int
            or data["expires_at"] <= int(time.time()) + 120
            or any(not isinstance(data.get(key), str) or not data[key]
                   for key in ("access_key_id", "access_key_secret", "session_token"))):
        raise EvidenceStorageUnavailable("审核证据桶临时凭据已过期或与桶配置不一致")
    return data["access_key_id"], data["access_key_secret"], data["session_token"]


def _https_endpoint(value: str) -> bool:
    parsed = urlsplit(value)
    return (parsed.scheme == "https" and bool(parsed.hostname)
            and not parsed.username and not parsed.password and not parsed.query
            and not parsed.fragment and len(value) <= 1024)


def retention_hours() -> int:
    try:
        hours = int(os.environ[_PREFIX + "LOCK_HOURS"])
    except (KeyError, TypeError, ValueError) as exc:
        raise EvidenceStorageUnavailable("审核证据桶未显式配置对象锁保留小时数") from exc
    # 48 h covers a <=24 h independent receipt plus a 24 h recheck window.
    # Longer receipts are rejected by the publication readiness gate unless
    # operators explicitly choose a correspondingly longer retention.
    if not 48 <= hours <= 720:
        raise EvidenceStorageUnavailable("审核证据桶锁定时间须为 48–720 小时")
    return hours


def provider() -> S3CompatibleProvider:
    if os.environ.get("V8_TASK_ADAPTER_EVIDENCE_ENABLED") != "1":
        raise EvidenceStorageUnavailable("审核证据桶未启用")
    provider_name = os.environ.get(_PREFIX + "PROVIDER", "").strip().lower()
    endpoint = os.environ.get(_PREFIX + "ENDPOINT", "").strip()
    internal = os.environ.get(_PREFIX + "INTERNAL_ENDPOINT", "").strip() or endpoint
    bucket = os.environ.get(_PREFIX + "BUCKET", "").strip()
    region = os.environ.get(_PREFIX + "REGION", "").strip()
    key_id = os.environ.get(_PREFIX + "ACCESS_KEY_ID", "")
    secret = os.environ.get(_PREFIX + "ACCESS_KEY_SECRET", "")
    session_token = os.environ.get(_PREFIX + "SESSION_TOKEN", "")
    style = os.environ.get(_PREFIX + "ADDRESSING_STYLE", "").strip().lower()
    retention_hours()
    temporary = _temporary_credential(bucket=bucket, region=region, endpoint=endpoint)
    if temporary is not None:
        key_id, secret, session_token = temporary
    if (provider_name not in {"s3", "aws", "minio", "cos"}
            or not _https_endpoint(endpoint) or not _https_endpoint(internal)
            or not bucket or "/" in bucket or not region or not key_id or not secret
            or len(session_token) > 4096
            or style not in {"virtual", "path"}):
        raise EvidenceStorageUnavailable("审核证据桶缺少独立的 HTTPS、区域或凭据配置")
    if (provider_name == "cos"
            and os.environ.get("V8_TASK_ADAPTER_EVIDENCE_COS_MD5_LOCK_VERIFIED") != "1"):
        # COS accepts an incorrect x-amz-checksum-sha256 without rejecting
        # PUT and omits that value on HEAD. An isolated bucket must first
        # prove signed Content-MD5 enforcement, VersionId and exact-version
        # COMPLIANCE lock. Guangzhou independently GETs and hashes SHA-256.
        raise EvidenceStorageUnavailable("COS 审核证据桶尚未完成 MD5、版本与对象锁实测")
    general = get_oss_provider()
    if bucket == getattr(general, "bucket", None):
        raise EvidenceStorageUnavailable("审核证据桶不能复用未受锁的通用媒体桶")
    try:
        return S3CompatibleProvider(OSSConfig(
            provider=provider_name, endpoint=endpoint, internal_endpoint=internal,
            bucket=bucket, region=region, access_key_id=key_id,
            access_key_secret=secret, session_token=session_token,
            prefix="", addressing_style=style))
    except Exception as exc:
        raise EvidenceStorageUnavailable("审核证据桶客户端初始化失败") from exc


def require_bucket_proof(storage: S3CompatibleProvider) -> None:
    """Read-only capability check before granting any immutable write.

    A generic S3-compatible server that silently ignores versioning, Object
    Lock or CORS must not receive a grant. No object is fetched or modified.
    """
    try:
        client = storage._internal
        versioning = client.get_bucket_versioning(Bucket=storage.bucket)
        lock = client.get_object_lock_configuration(Bucket=storage.bucket)
        cors = client.get_bucket_cors(Bucket=storage.bucket)
        rules = cors.get("CORSRules", [])
        version_exposed = any(
            "PUT" in rule.get("AllowedMethods", [])
            and ("*" in rule.get("AllowedHeaders", []) or all(
                header in {h.lower() for h in rule.get("AllowedHeaders", [])}
                for header in ("content-type", "content-md5", "x-amz-checksum-sha256",
                               "x-amz-object-lock-mode", "x-amz-object-lock-retain-until-date")))
            and ({"x-amz-version-id", "x-cos-version-id"}
                 & {h.lower() for h in rule.get("ExposeHeaders", [])})
            for rule in rules)
        if (versioning.get("Status") != "Enabled"
                or lock.get("ObjectLockConfiguration", {}).get("ObjectLockEnabled") != "Enabled"
                or not version_exposed):
            raise EvidenceStorageUnavailable("审核证据桶缺少版本化、对象锁或 VersionId CORS 暴露")
    except EvidenceStorageUnavailable:
        raise
    except Exception as exc:
        raise EvidenceStorageUnavailable("无法只读核验审核证据桶版本化、对象锁及 CORS") from exc


def checked_content_md5(value: str) -> str:
    """Return canonical Base64 for the exact 16-byte MD5 of frozen bytes."""
    try:
        raw = base64.b64decode(value, validate=True)
    except (TypeError, ValueError, base64.binascii.Error) as exc:
        raise EvidenceStorageUnavailable("Content-MD5 必须是标准 Base64") from exc
    if len(raw) != 16 or base64.b64encode(raw).decode("ascii") != value:
        raise EvidenceStorageUnavailable("Content-MD5 必须是 16 字节标准 Base64")
    return value


def locked_put_grant(
    storage: S3CompatibleProvider, *, object_key: str, sha256_hex: str,
    content_md5: str, content_type: str, expires: int,
    min_retention_hours: int = 48,
) -> tuple[str, dict[str, str], datetime]:
    """Sign a fixed-key PUT; caller still must HEAD the returned VersionId."""
    if not 48 <= min_retention_hours <= 720:
        raise EvidenceStorageUnavailable("上传授权的最低对象锁期不合法")
    # S3 HTTP dates have one-second precision. Persist exactly the timestamp
    # signed into the PUT, or a successful HEAD appears microscopically short.
    retain_until = datetime.fromtimestamp(
        int(datetime.now(timezone.utc).timestamp())
        + max(retention_hours(), min_retention_hours) * 3600,
        tz=timezone.utc,
    )
    retention = retain_until.strftime("%Y-%m-%dT%H:%M:%SZ")
    checksum = base64.b64encode(bytes.fromhex(sha256_hex)).decode("ascii")
    md5 = checked_content_md5(content_md5)
    params = {
        "Bucket": storage.bucket, "Key": object_key,
        "ContentType": content_type, "ContentMD5": md5, "ChecksumSHA256": checksum,
        "ObjectLockMode": "COMPLIANCE", "ObjectLockRetainUntilDate": retention,
    }
    try:
        url = storage._public.generate_presigned_url(
            "put_object", Params=params, ExpiresIn=expires, HttpMethod="PUT")
    except Exception as exc:
        raise EvidenceStorageUnavailable("审核证据桶无法签发合规锁直传授权") from exc
    if not _https_endpoint(url.split("?", 1)[0]) or len(url) > 8192:
        raise EvidenceStorageUnavailable("审核证据桶上传授权必须使用 HTTPS")
    return url, {
        "Content-Type": content_type,
        "Content-MD5": md5,
        "x-amz-checksum-sha256": checksum,
        "x-amz-object-lock-mode": "COMPLIANCE",
        "x-amz-object-lock-retain-until-date": retention,
    }, retain_until
