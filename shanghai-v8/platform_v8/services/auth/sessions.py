"""登录设备识别与会话记录。"""
from __future__ import annotations

import re
import uuid
from datetime import datetime

from sqlalchemy.orm import Session

from platform_v8.storage.repo import AuthSessionRepo

_OS_ALIASES = {
    "macos": "macOS",
    "macintosh": "macOS",
    "mac os": "macOS",
    "mac os x": "macOS",
    "darwin": "macOS",
    "windows": "Windows",
    "win32": "Windows",
    "win64": "Windows",
    "linux": "Linux",
    "android": "Android",
    "ios": "iOS",
    "iphone": "iOS",
    "ipad": "iOS",
}

_CLIENT_UA_MARKERS = (
    "tauri",
    "reqwest",
    "edgecompute-client",
    "qianshou-client",
    "qianshou_client",
    "千手节点",
)


def _normalize_os_name(raw: str | None) -> str | None:
    token = (raw or "").strip().lower()
    if not token:
        return None
    if token in _OS_ALIASES:
        return _OS_ALIASES[token]
    for key, label in _OS_ALIASES.items():
        if key in token:
            return label
    return None


def _looks_like_native_client(user_agent: str | None) -> bool:
    lower = (user_agent or "").strip().lower()
    return any(marker in lower for marker in _CLIENT_UA_MARKERS)


def _os_from_client_ua(user_agent: str | None) -> str | None:
    """Parse OS from UA forms like ``EdgeCompute-Client/1.0.0 (macos; Tauri)``."""
    ua = (user_agent or "").strip()
    if not ua:
        return None
    match = re.search(r"\(([^)]*)\)", ua)
    if match:
        for part in match.group(1).split(";"):
            normalized = _normalize_os_name(part)
            if normalized:
                return normalized
    return _normalize_os_name(ua)


def describe_user_agent(
    user_agent: str | None,
    *,
    client_type: str | None = None,
    client_platform: str | None = None,
) -> dict[str, str]:
    """Classify browser/OS for login sessions.

    Native desktop clients send ``EdgeCompute-Client/...`` (not ``reqwest``),
    and set ``X-Client-Type: tauri``; both signals must identify as 千手节点客户端.
    """
    ua = (user_agent or "").strip()
    lower = ua.lower()
    is_native_client = (
        (client_type or "").strip().lower() == "tauri"
        or _looks_like_native_client(ua)
    )

    if is_native_client:
        browser = "千手节点客户端"
    elif "edg/" in lower or "edge/" in lower:
        browser = "Microsoft Edge"
    elif "firefox/" in lower:
        browser = "Firefox"
    elif "chrome/" in lower or "crios/" in lower:
        browser = "Chrome"
    elif "safari/" in lower:
        browser = "Safari"
    else:
        browser = "未知应用"

    os_name = (
        _normalize_os_name(client_platform)
        or _os_from_client_ua(ua)
        or None
    )
    if os_name is None:
        if "android" in lower:
            os_name = "Android"
        elif "iphone" in lower or "ipad" in lower or "ios" in lower:
            os_name = "iOS"
        elif "windows" in lower:
            os_name = "Windows"
        elif "macintosh" in lower or "mac os" in lower:
            os_name = "macOS"
        elif "linux" in lower:
            os_name = "Linux"
        else:
            os_name = "未知系统"

    if is_native_client:
        device_type = "client"
    elif "ipad" in lower or "tablet" in lower:
        device_type = "tablet"
    elif "mobile" in lower or "android" in lower or "iphone" in lower:
        device_type = "mobile"
    else:
        device_type = "desktop"

    if browser == "未知应用" and os_name == "未知系统":
        device_name = "未知设备"
    elif browser == "千手节点客户端":
        device_name = f"千手节点客户端 · {os_name}"
    else:
        device_name = f"{browser} · {os_name}"

    return {
        "device_name": device_name,
        "device_type": device_type,
        "browser": browser,
        "os": os_name,
    }


def soft_device_group_key(session_row: dict, device_row: dict | None = None) -> str:
    """历史去重：同账号下按「浏览器 + 系统」合并（基于 UA 重算，避免旧字段不一致）。"""
    _ = device_row
    described = describe_user_agent(session_row.get("user_agent"))
    browser = str(described.get("browser") or session_row.get("browser") or "").strip() or "unknown"
    os_name = str(described.get("os") or session_row.get("os") or "").strip() or "unknown"
    return f"soft:{browser}|{os_name}"


def purge_duplicate_login_history(
    s: Session,
    *,
    account_id: int,
    keep_session_id: str | None = None,
) -> dict[str, int]:
    """按设备指纹合并历史登录：每组只留一条，删除其余会话与孤儿设备。"""
    from platform_v8.storage.repo import TrustedDeviceRepo

    sessions = AuthSessionRepo.list_for_account(s, account_id, limit=200)
    if not sessions:
        return {"sessions_deleted": 0, "devices_deleted": 0}

    groups: dict[str, list[dict]] = {}
    for row in sessions:
        key = soft_device_group_key(row)
        groups.setdefault(key, []).append(row)

    def _rank(item: dict) -> tuple:
        is_current = 1 if keep_session_id and str(item["id"]) == str(keep_session_id) else 0
        status_rank = 0
        if item.get("revoked_at") is None:
            refresh_expiry = item.get("refresh_expires_at")
            if refresh_expiry is None:
                status_rank = 2  # active / unknown expiry
            else:
                try:
                    now = (
                        datetime.now(tz=refresh_expiry.tzinfo)
                        if getattr(refresh_expiry, "tzinfo", None)
                        else datetime.utcnow()
                    )
                    status_rank = 2 if refresh_expiry > now else 1
                except Exception:
                    status_rank = 2
        last_seen = item.get("last_seen_at")
        stamp = last_seen.timestamp() if hasattr(last_seen, "timestamp") else 0.0
        return (is_current, status_rank, stamp)

    drop_ids: list[str] = []
    keep_device_ids: set[str] = set()
    for items in groups.values():
        best = max(items, key=_rank)
        if best.get("device_id"):
            keep_device_ids.add(str(best["device_id"]))
        for item in items:
            if str(item["id"]) == str(best["id"]):
                continue
            drop_ids.append(str(item["id"]))

    deleted_sessions = AuthSessionRepo.delete_ids(s, account_id, drop_ids)

    # 再清一轮：非当前会话的已退出/已过期记录不再展示
    remaining = AuthSessionRepo.list_for_account(s, account_id, limit=200)
    stale_ids: list[str] = []
    for item in remaining:
        if keep_session_id and str(item["id"]) == str(keep_session_id):
            continue
        if item.get("revoked_at") is not None:
            stale_ids.append(str(item["id"]))
            continue
        refresh_expiry = item.get("refresh_expires_at")
        if refresh_expiry is not None:
            try:
                now = (
                    datetime.now(tz=refresh_expiry.tzinfo)
                    if getattr(refresh_expiry, "tzinfo", None)
                    else datetime.utcnow()
                )
                if refresh_expiry <= now:
                    stale_ids.append(str(item["id"]))
            except Exception:
                pass
    deleted_sessions += AuthSessionRepo.delete_ids(s, account_id, stale_ids)

    keep_device_ids = {
        str(row["device_id"])
        for row in AuthSessionRepo.list_for_account(s, account_id, limit=200)
        if row.get("device_id")
    }
    deleted_devices = TrustedDeviceRepo.delete_orphans(
        s,
        account_id,
        keep_device_ids=keep_device_ids,
    )
    return {
        "sessions_deleted": deleted_sessions,
        "devices_deleted": deleted_devices,
    }


def create_login_session(
    s: Session,
    *,
    account_id: int,
    user_agent: str | None,
    client_ip: str | None,
    device_id: str | None = None,
    remember_me: bool = False,
    client_type: str | None = None,
    client_platform: str | None = None,
) -> str:
    session_id = str(uuid.uuid4())
    device = describe_user_agent(
        user_agent,
        client_type=client_type,
        client_platform=client_platform,
    )
    if device_id:
        AuthSessionRepo.revoke_active_for_device(s, account_id, device_id)
    AuthSessionRepo.create(
        s,
        session_id=session_id,
        account_id=account_id,
        device_id=device_id,
        device_name=device["device_name"],
        device_type=device["device_type"],
        browser=device["browser"],
        os_name=device["os"],
        user_agent=user_agent or "",
        client_ip=client_ip,
        remember_me=remember_me,
    )
    return session_id
