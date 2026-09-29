"""任务脚本共用的本地安全护栏。

这是脚本侧的纵深防御，不替代 API/services 层的 URL 准入和出口网络策略。
"""
from __future__ import annotations

import ipaddress
import hashlib
import os
import socket
import urllib.error
import urllib.parse
import urllib.request


MAX_REDIRECTS = 3


def require_public_http_url(raw_url: str) -> str:
    """仅接受 HTTP(S) 公网 URL，并拒绝私网、回环和链路本地 DNS 结果。"""
    parsed = urllib.parse.urlparse(str(raw_url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("仅允许带 hostname 的 http/https URL")
    if parsed.username or parsed.password:
        raise ValueError("URL 不允许携带用户凭证")
    host = parsed.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain"}:
        raise ValueError("禁止访问 localhost")
    try:
        addresses = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"URL 域名无法解析: {host}") from exc
    for _family, _socktype, _proto, _canonname, sockaddr in addresses:
        address = ipaddress.ip_address(sockaddr[0])
        # Clash/Surge tun fake-ip：把公网域名映射到 198.18.0.0/15（及部分 fdfe:...），
        # 真实流量仍走代理出口。按 is_private 拦截会误杀 GitHub/HF 等白名单下载。
        if isinstance(address, ipaddress.IPv4Address) and address in ipaddress.ip_network("198.18.0.0/15"):
            continue
        if isinstance(address, ipaddress.IPv6Address) and str(address).lower().startswith("fdfe:dcba:9876:"):
            continue
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            raise ValueError(f"禁止访问非公网地址: {address}")
    return parsed.geturl()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def open_public_url(
    raw_url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    timeout_s: float = 15,
    max_bytes: int = 5 * 1024 * 1024,
):
    """打开公网 URL；每跳重定向均校验目标，读取上限由调用方控制。"""
    url = require_public_http_url(raw_url)
    opener = urllib.request.build_opener(_NoRedirect())
    safe_headers = {"User-Agent": "EdgeCompute-Task/1.0"}
    for key, value in (headers or {}).items():
        # 禁止任务伪造常见敏感/跳转控制头
        if str(key).lower() in {"host", "authorization", "cookie", "proxy-authorization"}:
            continue
        safe_headers[str(key)] = str(value)

    for _attempt in range(MAX_REDIRECTS + 1):
        request = urllib.request.Request(url, method=method.upper(), headers=safe_headers)
        try:
            response = opener.open(request, timeout=max(1, min(float(timeout_s), 30)))
            return response, url
        except urllib.error.HTTPError as exc:
            if exc.code not in {301, 302, 303, 307, 308}:
                raise
            target = exc.headers.get("Location")
            if not target:
                raise ValueError(f"重定向 {exc.code} 缺少 Location") from exc
            url = require_public_http_url(urllib.parse.urljoin(url, target))
    raise ValueError(f"重定向次数超过上限 {MAX_REDIRECTS}")


def read_limited(response, max_bytes: int) -> bytes:
    """以字节数上限读取响应，超限立即失败。"""
    chunks: list[bytes] = []
    remaining = max(1, int(max_bytes))
    while True:
        chunk = response.read(min(64 * 1024, remaining + 1))
        if not chunk:
            return b"".join(chunks)
        if len(chunk) > remaining:
            raise ValueError(f"响应超过上限 {max_bytes} bytes")
        chunks.append(chunk)
        remaining -= len(chunk)


def write_output_artifact(filename: str, content: bytes, media_type: str) -> dict | None:
    """将二进制产物落到执行器提供的输出目录并返回可上传 manifest。"""
    out_dir = os.environ.get("EC_OUTPUT_DIR", "")
    if not out_dir or not os.path.isdir(out_dir):
        return None
    safe_name = os.path.basename(filename) or "output.bin"
    target = os.path.join(out_dir, safe_name)
    with open(target, "wb") as fh:
        fh.write(content)
    return {
        "filename": safe_name,
        "media_type": media_type,
        "bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "local_path": target,
    }
