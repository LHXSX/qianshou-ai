"""SSRF-safe URL validation and pinned-IP synchronous HTTP transport."""
from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator
from urllib.parse import urljoin, urlsplit, urlunsplit


class UnsafeURLError(ValueError):
    """A URL or redirect violates the outbound request policy."""


class SafeHTTPError(RuntimeError):
    """A sanitized outbound transport failure."""


@dataclass(frozen=True)
class URLPolicy:
    schemes: tuple[str, ...] = ("https", "http")
    ports: tuple[int, ...] = (80, 443, 8000, 8080)
    max_redirects: int = 3
    max_response_bytes: int = 64 * 1024 * 1024
    timeout: float = 30.0


DEFAULT_POLICY = URLPolicy()


def redact_url(value: object) -> str:
    """Keep a URL's origin and path while removing credential-bearing query."""
    raw = str(value or "")
    try:
        parts = urlsplit(raw)
    except ValueError:
        return "<invalid-url>"
    if not parts.scheme or not parts.netloc:
        return raw.split("?", 1)[0]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "<redacted>" if parts.query else "", ""))


def safe_transport_error(exc: Exception) -> str:
    """Expose a diagnostic error category without leaking request URLs."""
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status is not None:
        return f"object storage HTTP {status}"
    return f"object storage {type(exc).__name__}"


def _trusted_private_hosts() -> set[str]:
    """配置里的 OSS/公网入口 host；这些域名允许解析到私网或链路本地。

    腾讯云 CVM 上 ``{bucket}.cos.{region}.myqcloud.com`` 常解析到 ``169.254.x.x``，
    若不信任桶域，结果校验拉 OSS 会误报 UnsafeURLError，借调任务全挂。

    注意：不要把泛化的 localhost 放进这里——否则公网 URL 302 到 loopback
    会被当成「可信私网」放行（SSRF）。本机 OSS 请走 FILES_PUBLIC_BASE / API_BASE。
    """
    import os
    from urllib.parse import urlsplit as _urlsplit
    hosts: set[str] = set()
    for name in (
        "FILES_PUBLIC_BASE",
        "API_BASE_URL",
        "V8_PUBLIC_BASE_URL",
        "PUBLIC_API_BASE",
        "OSS_ENDPOINT",
        "OSS_INTERNAL_ENDPOINT",
        "EDGECOMPUTE_PUBLIC_SITE",
    ):
        raw = os.getenv(name, "") or ""
        try:
            host = (_urlsplit(raw).hostname or "").rstrip(".").lower()
        except ValueError:
            host = ""
        if host:
            hosts.add(host)
    # COS / OSS 虚拟主机：{bucket}.cos.{region}.myqcloud.com
    bucket = (os.getenv("COS_BUCKET") or os.getenv("OSS_BUCKET") or "").strip()
    region = (os.getenv("COS_REGION") or os.getenv("OSS_REGION") or "").strip()
    if bucket and region:
        hosts.add(f"{bucket}.cos.{region}.myqcloud.com".lower())
        hosts.add(f"cos.{region}.myqcloud.com".lower())
    return hosts


def _is_trusted_oss_host(host: str) -> bool:
    """桶虚拟主机 / 地域 endpoint：信任其私网或链路本地解析。"""
    h = (host or "").rstrip(".").lower()
    if not h:
        return False
    if h in _trusted_private_hosts():
        return True
    # 兜底：腾讯云 COS 虚拟主机（避免漏配 bucket 环境变量）
    if h.endswith(".myqcloud.com") and ".cos." in h:
        return True
    return False


def resolve_global_ips(hostname: str, port: int) -> tuple[str, ...]:
    """Resolve once; require global IPs, or trusted OSS hosts (含机内 169.254)。"""
    try:
        rows = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        addresses = tuple(dict.fromkeys(str(row[4][0]) for row in rows))
        if not addresses:
            raise UnsafeURLError("URL host 解析到非公网地址")
        host = (hostname or "").rstrip(".").lower()
        allow_private = _is_trusted_oss_host(host)
        ok = True
        for ip in addresses:
            obj = ipaddress.ip_address(ip)
            if obj.is_global:
                continue
            # 腾讯云 COS 机内 DNS 常给 169.254.x.x（link-local），不是 is_private
            if allow_private and (
                obj.is_private or obj.is_loopback or obj.is_link_local
            ):
                continue
            ok = False
            break
        if not ok:
            raise UnsafeURLError("URL host 解析到非公网地址")
        return addresses
    except UnsafeURLError:
        raise
    except (OSError, ValueError) as exc:
        raise UnsafeURLError("URL host DNS 解析失败") from exc


def validate_url(value: object, policy: URLPolicy = DEFAULT_POLICY) -> tuple[str, int, tuple[str, ...]]:
    """Validate URL syntax and return host, port, and the pinned DNS answer."""
    try:
        parsed = urlsplit(str(value or "").strip())
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except (TypeError, ValueError) as exc:
        raise UnsafeURLError("URL 格式无效") from exc
    if (
        parsed.scheme not in policy.schemes
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
        or port not in policy.ports
    ):
        raise UnsafeURLError("URL 不符合出站访问策略")
    host = parsed.hostname.rstrip(".").lower()
    return host, port, resolve_global_ips(host, port)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, pinned_ip: str, timeout: float):
        super().__init__(host, port=port, timeout=timeout)
        self._pinned_ip = pinned_ip

    def connect(self) -> None:
        self.sock = socket.create_connection(
            (self._pinned_ip, self.port), self.timeout, self.source_address
        )


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, pinned_ip: str, timeout: float):
        super().__init__(
            host,
            port=port,
            timeout=timeout,
            context=ssl.create_default_context(),
        )
        self._pinned_ip = pinned_ip

    def connect(self) -> None:
        raw = socket.create_connection(
            (self._pinned_ip, self.port), self.timeout, self.source_address
        )
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


class SafeResponse:
    """Small HTTPResponse proxy enforcing the configured body limit."""

    def __init__(self, response: http.client.HTTPResponse, connection: object, max_bytes: int):
        self._response = response
        self._connection = connection
        self._max_bytes = max_bytes
        self._read = 0
        self.status = response.status
        self.headers = response.headers

    def read(self, amount: int = -1) -> bytes:
        remaining = self._max_bytes - self._read
        if remaining < 0:
            raise SafeHTTPError("HTTP response exceeded size limit")
        requested = remaining + 1 if amount is None or amount < 0 else min(amount, remaining + 1)
        data = self._response.read(requested)
        self._read += len(data)
        if self._read > self._max_bytes:
            self.close()
            raise SafeHTTPError("HTTP response exceeded size limit")
        return data

    def close(self) -> None:
        try:
            self._response.close()
        finally:
            self._connection.close()

    def __enter__(self) -> "SafeResponse":
        return self

    def __exit__(self, *_args) -> None:
        self.close()


def safe_open(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    policy: URLPolicy = DEFAULT_POLICY,
) -> SafeResponse:
    """Open a URL through a validated, DNS-pinned connection on every hop."""
    current = str(url or "").strip()
    request_method = method.upper()
    for hop in range(policy.max_redirects + 1):
        host, port, addresses = validate_url(current, policy)
        parsed = urlsplit(current)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        request_headers = dict(headers or {})
        default_port = 443 if parsed.scheme == "https" else 80
        request_headers["Host"] = host if port == default_port else f"{host}:{port}"
        connection_cls = _PinnedHTTPSConnection if parsed.scheme == "https" else _PinnedHTTPConnection
        connection = connection_cls(host, port, addresses[0], policy.timeout)
        try:
            connection.request(request_method, path, headers=request_headers)
            response = connection.getresponse()
        except Exception as exc:
            connection.close()
            raise SafeHTTPError(f"HTTP transport {type(exc).__name__}") from exc
        if response.status not in (301, 302, 303, 307, 308):
            content_length = (
                response.headers.get("Content-Length")
                if request_method != "HEAD"
                else None
            )
            try:
                if content_length and int(content_length) > policy.max_response_bytes:
                    response.close()
                    connection.close()
                    raise SafeHTTPError("HTTP response exceeded size limit")
            except ValueError:
                pass
            return SafeResponse(response, connection, policy.max_response_bytes)
        location = response.headers.get("Location")
        response.close()
        connection.close()
        if not location or hop >= policy.max_redirects:
            raise UnsafeURLError("HTTP redirect 不完整或超过上限")
        current = urljoin(current, location)
        if response.status == 303:
            request_method = "GET"
    raise UnsafeURLError("HTTP redirect 超过上限")


@contextmanager
def safe_stream(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    policy: URLPolicy = DEFAULT_POLICY,
) -> Iterator[SafeResponse]:
    response = safe_open(url, method=method, headers=headers, policy=policy)
    try:
        yield response
    finally:
        response.close()
