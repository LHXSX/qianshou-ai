"""Stable tenant-owned object references and dispatch-time materialization."""
from __future__ import annotations

import ipaddress
import os
import re
from urllib.parse import unquote, urlsplit


class StorageReferenceError(ValueError):
    """An object reference is invalid, foreign, or cannot be materialized."""


_PROTECTED_MEDIA_RESULT = re.compile(
    r"(?:^|/)v8/account-[0-9]+/workload-[^/]+/shard-[^/]+/result/[^/]+/[^/]+"
    r"\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a)$",
    re.I,
)


def is_protected_media_result_ref(value: object) -> bool:
    """Recognize a locked result key even inside an encoded historical URL."""
    raw = str(value or "").strip()
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return False
    path = parsed.path if parsed.scheme in ("http", "https") else raw
    return bool(_PROTECTED_MEDIA_RESULT.search(_decoded(path)))


def _decoded(value: str) -> str:
    decoded = value
    for _ in range(3):
        next_value = unquote(decoded)
        if next_value == decoded:
            break
        decoded = next_value
    return decoded


def validate_owned_object_key(owner_id: int, key: object) -> str:
    """Return a canonical owned key, rejecting URL/path ambiguity."""
    value = str(key or "").strip()
    decoded = _decoded(value)
    prefixes = (
        f"v8/account-{int(owner_id)}/",
        f"uploads/tenant_{int(owner_id)}/",
    )
    parts = decoded.split("/")
    if (
        not value
        or value.startswith(("/", "\\"))
        or "://" in value
        or "?" in value
        or "#" in value
        or "\\" in value
        or "\\" in decoded
        or any(ord(ch) < 32 or ord(ch) == 127 for ch in decoded)
        or any(part in ("", ".", "..") for part in parts)
        or not value.startswith(prefixes)
        or not decoded.startswith(prefixes)
    ):
        raise StorageReferenceError(
            "object_key 必须是当前账号命名空间内的稳定 OSS key"
        )
    return value


def _provider_url_config(provider: object) -> tuple[set[str], str, str]:
    config = getattr(provider, "config", None)
    endpoint_values = [
        getattr(provider, "endpoint", ""),
        getattr(provider, "public_endpoint", ""),
        getattr(provider, "base_url", ""),
        getattr(provider, "cdn_domain", ""),
        getattr(config, "endpoint", ""),
        getattr(config, "cdn_domain", ""),
    ]
    endpoint_values.extend(
        os.getenv(name, "")
        for name in (
            "OSS_ENDPOINT",
            "OSS_CDN_DOMAIN",
            "API_BASE_URL",
            "V8_PUBLIC_BASE_URL",
            "PUBLIC_API_BASE",
            "FILES_PUBLIC_BASE",
            "EDGECOMPUTE_PUBLIC_SITE",
        )
    )
    hosts: set[str] = set()
    for raw in endpoint_values:
        try:
            host = (urlsplit(str(raw)).hostname or "").rstrip(".").lower()
        except ValueError:
            host = ""
        if host:
            hosts.add(host)
    bucket = str(getattr(provider, "bucket", "") or getattr(config, "bucket", "") or "")
    prefix = str(getattr(provider, "prefix", "") or getattr(config, "prefix", "") or "").strip("/")
    return hosts, bucket, prefix


def owned_key_from_presigned_url(owner_id: int, value: object) -> str:
    """Recover an owned key only from the current provider's trusted URL forms."""
    raw = str(value or "").strip()
    try:
        parsed = urlsplit(raw)
    except ValueError as exc:
        raise StorageReferenceError("历史下载地址格式无效") from exc
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise StorageReferenceError("历史下载地址必须是 HTTP(S) URL")
    if parsed.username or parsed.password or parsed.fragment:
        raise StorageReferenceError("历史下载地址包含不允许的 URL 组件")
    host = parsed.hostname.rstrip(".").lower()
    is_ip = False
    try:
        ipaddress.ip_address(host)
        is_ip = True
    except ValueError:
        pass

    from platform_v8.services.oss_provider import get_oss_provider

    try:
        provider = get_oss_provider()
    except Exception as exc:
        raise StorageReferenceError("无法验证历史对象存储地址") from exc
    trusted_hosts, bucket, prefix = _provider_url_config(provider)
    # LAN / 本机联调：允许已配置公网基址中的 IP（如 FILES_PUBLIC_BASE=http://192.168.x.x:8000）
    if is_ip and host not in trusted_hosts:
        raise StorageReferenceError("历史下载地址不接受 IP host")
    host_ok = host in trusted_hosts
    if not host_ok and bucket:
        host_ok = any(host == f"{bucket}.{trusted}" for trusted in trusted_hosts)
    if not host_ok:
        raise StorageReferenceError("历史下载地址 host 不属于当前对象存储")

    path = _decoded(parsed.path or "").lstrip("/")
    local_marker = "api/v8/oss/local/download/"
    if local_marker in path:
        path = path.split(local_marker, 1)[1]
    elif bucket and path.startswith(bucket + "/"):
        path = path[len(bucket) + 1:]
    if prefix and path.startswith(prefix + "/"):
        path = path[len(prefix) + 1:]
    return validate_owned_object_key(owner_id, path)


def canonicalize_owned_reference(owner_id: int, value: object) -> str:
    """Accept stable keys plus trusted historical presigned URLs."""
    raw = str(value or "").strip()
    if raw.lower().startswith(("http://", "https://")):
        return owned_key_from_presigned_url(owner_id, raw)
    return validate_owned_object_key(owner_id, raw)


def _presigned_url(value: object) -> str:
    if hasattr(value, "url"):
        return str(getattr(value, "url") or "")
    if isinstance(value, dict):
        return str(value.get("url") or "")
    return str(value or "")


def materialize_get_url(owner_id: int, key: object, expires: int = 3600,
                        *, object_version_id: str | None = None) -> str:
    """Sign an owned canonical key; never return an opaque key on failure."""
    canonical = canonicalize_owned_reference(owner_id, key)
    if is_protected_media_result_ref(canonical):
        raise StorageReferenceError("媒体结果须通过独立核验后的查看授权获取")
    try:
        from platform_v8.services.oss_provider import get_oss_provider
        url = _presigned_url(
            get_oss_provider().presign_get(canonical, expires=max(60, int(expires)))
        ).strip()
    except StorageReferenceError:
        raise
    except Exception as exc:
        raise StorageReferenceError("对象存储下载地址签名失败") from exc
    try:
        parsed = urlsplit(url)
    except ValueError as exc:
        raise StorageReferenceError("对象存储返回了无效下载地址") from exc
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise StorageReferenceError("对象存储未返回 HTTP(S) 下载地址")
    return url
