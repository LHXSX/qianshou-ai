"""通用 workload Webhook（结果落库后 best effort 投递）。"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import logging
import socket
import time
import uuid
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


def _load_webhook_config(workload) -> tuple[str, str]:
    try:
        from platform_v8.storage import db as db_mod
        from platform_v8.storage.repo import DeveloperTaskRepo

        with db_mod.session_scope() as session:
            config = DeveloperTaskRepo.get_webhook(session, str(workload.id))
        if config:
            return (
                str(config.get("callback_url") or "").strip(),
                str(config.get("callback_secret") or ""),
            )
    except Exception:
        logger.warning(
            "developer webhook 配置读取失败 workload=%s",
            workload.id,
            exc_info=True,
        )
    # 兼容迁移前已落库的 PDF 专用任务；新任务不再把 secret 放进 workload.spec。
    params = getattr(getattr(workload, "spec", None), "params", {}) or {}
    return (
        str(params.get("_developer_callback_url") or "").strip(),
        str(params.get("_developer_callback_secret") or ""),
    )


def _record_delivery(
    workload_id: str,
    event: str,
    attempt: int,
    *,
    success: bool,
    status_code: int | None = None,
    error: str = "",
) -> None:
    try:
        from platform_v8.storage import db as db_mod
        from platform_v8.storage.repo import DeveloperTaskRepo

        with db_mod.session_scope() as session:
            DeveloperTaskRepo.record_webhook_delivery(
                session,
                workload_id=workload_id,
                event=event,
                attempt=attempt,
                success=success,
                status_code=status_code,
                error=error,
            )
            session.commit()
    except Exception:
        logger.warning(
            "developer webhook 投递记录写入失败 workload=%s",
            workload_id,
            exc_info=True,
        )


def _resolve_public_https(url: str) -> tuple[object, str] | None:
    try:
        parsed = urlparse(url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.fragment
        ):
            return None
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
        addresses: list[str] = []
        for info in infos:
            address = ipaddress.ip_address(info[4][0])
            if not address.is_global:
                return None
            if str(address) not in addresses:
                addresses.append(str(address))
        if not addresses:
            return None
        # 返回已验证 IP，投递时直接连 IP 并保留 SNI/证书 hostname，避免二次 DNS rebinding。
        return parsed, addresses[0]
    except Exception:
        return None


def _looks_like_object_key(value: str) -> bool:
    token = (value or "").strip()
    if not token or token.startswith(("http://", "https://", "{", "[")):
        return False
    if any(char in token for char in " \t\n\r"):
        return False
    return (
        token.startswith(("v8/", "wuji/", "tasks/", "account-"))
        or "/result/" in token
        or "/input/" in token
    )


def _public_result(value):
    if isinstance(value, dict):
        public = {
            key: _public_result(item)
            for key, item in value.items()
            if key != "object_key"
        }
        object_key = value.get("object_key")
        if isinstance(object_key, str) and _looks_like_object_key(object_key):
            public["download_url"] = _public_result(object_key)
        return public
    if isinstance(value, list):
        return [_public_result(item) for item in value]
    if isinstance(value, str) and _looks_like_object_key(value):
        try:
            from platform_v8.services.oss_provider import get_oss_provider
            signed = get_oss_provider().presign_get(value, expires=3600)
            if hasattr(signed, "url"):
                return str(signed.url)
            if isinstance(signed, dict):
                return str(signed.get("url") or value)
            return str(signed)
        except Exception:
            logger.warning("developer webhook 结果动态签名失败")
    return value


def _post_pinned(
    *,
    parsed,
    address: str,
    body: bytes,
    headers: dict[str, str],
) -> int:
    import urllib3

    port = parsed.port or 443
    host_header = parsed.hostname if port == 443 else f"{parsed.hostname}:{port}"
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    pool = urllib3.HTTPSConnectionPool(
        address,
        port=port,
        server_hostname=parsed.hostname,
        assert_hostname=parsed.hostname,
        cert_reqs="CERT_REQUIRED",
        timeout=urllib3.Timeout(connect=5.0, read=15.0),
        retries=False,
        maxsize=1,
    )
    try:
        response = pool.request(
            "POST",
            path,
            body=body,
            headers={**headers, "Host": host_header},
            redirect=False,
            preload_content=False,
        )
        try:
            return int(response.status)
        finally:
            response.release_conn()
    finally:
        pool.close()


def deliver_event(
    workload,
    *,
    outcome: str,
    result_payload: dict | None = None,
    error: str = "",
    max_attempts: int = 3,
) -> bool:
    """同步有限重试；调用方须在线程中、且终态事务已提交后调用。"""
    url, secret = _load_webhook_config(workload)
    if not url:
        return False
    if not secret:
        logger.warning("developer webhook 缺少签名 secret workload=%s", workload.id)
        return False
    if outcome not in {"completed", "failed"}:
        raise ValueError("unsupported webhook outcome")

    status = "DONE" if outcome == "completed" else "FAILED"
    event_name = f"task.{outcome}"
    timestamp = int(time.time())
    body = {
        "event": event_name,
        "delivery_id": str(uuid.uuid4()),
        "workload_id": str(workload.id),
        "task_type": str(getattr(getattr(workload, "spec", None), "task_type", "") or ""),
        "status": status,
        "occurred_at": timestamp,
    }
    if outcome == "completed":
        body["result"] = _public_result(result_payload or {})
    else:
        body["error"] = str(error or getattr(workload, "error", "") or "workload failed")[:2000]
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    signed_payload = str(timestamp).encode("ascii") + b"." + encoded
    signature = hmac.new(
        secret.encode("utf-8"),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Qianshou-Webhook/1.0",
        "X-Qianshou-Event": event_name,
        "X-Qianshou-Delivery": body["delivery_id"],
        "X-Qianshou-Timestamp": str(timestamp),
        "X-Qianshou-Signature": f"sha256={signature}",
    }

    attempts = max(1, min(int(max_attempts), 3))
    for attempt in range(1, attempts + 1):
        target = _resolve_public_https(url)
        if target is None:
            logger.warning("developer webhook 拒绝非公网 HTTPS workload=%s", workload.id)
            _record_delivery(
                str(workload.id),
                event_name,
                attempt,
                success=False,
                error="callback URL is not public HTTPS",
            )
            return False
        parsed, address = target
        try:
            status_code = _post_pinned(
                parsed=parsed,
                address=address,
                body=encoded,
                headers=headers,
            )
        except Exception as exc:
            _record_delivery(
                str(workload.id),
                event_name,
                attempt,
                success=False,
                error=type(exc).__name__,
            )
            logger.warning(
                "developer webhook 网络失败 workload=%s attempt=%d/%d type=%s",
                workload.id,
                attempt,
                attempts,
                type(exc).__name__,
            )
            retryable = True
        else:
            if 200 <= status_code < 300:
                _record_delivery(
                    str(workload.id),
                    event_name,
                    attempt,
                    success=True,
                    status_code=status_code,
                )
                return True
            _record_delivery(
                str(workload.id),
                event_name,
                attempt,
                success=False,
                status_code=status_code,
                error=f"HTTP {status_code}",
            )
            retryable = status_code in {408, 425, 429} or status_code >= 500
            logger.warning(
                "developer webhook HTTP失败 workload=%s status=%d attempt=%d/%d",
                workload.id,
                status_code,
                attempt,
                attempts,
            )
        if not retryable or attempt >= attempts:
            return False
        time.sleep(0.5 * (2 ** (attempt - 1)))
    return False


def deliver_completion(workload, result_payload: dict) -> bool:
    return deliver_event(workload, outcome="completed", result_payload=result_payload)


def deliver_failure(workload, error: str = "") -> bool:
    return deliver_event(workload, outcome="failed", error=error)
