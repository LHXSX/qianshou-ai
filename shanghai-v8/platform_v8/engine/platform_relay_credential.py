"""Scope the platform relay credential before building a worker assignment.

The task scripts may accept user-selected fallback endpoints.  Sending a
platform credential with a mixed platform/third-party list would disclose it
on fallback, so every possible endpoint must be platform-owned before the
dispatcher injects the credential into ``params``.
"""
from __future__ import annotations

import os
from collections.abc import Mapping
from urllib.parse import urlsplit

RELAY_CREDENTIAL_ENV = "QS_PLATFORM_RELAY_API_KEY"
_RELAY_TASK_TYPES = frozenset({
    "llm_chat", "llm_classify", "llm_extract", "llm_translate",
    "ai_copywriting", "case_digest", "contract_review", "embedding",
})
_SCRIPT_BASE_TASK_TYPES = frozenset({
    "ai_copywriting", "case_digest", "contract_review",
})
_DEFAULT_HOSTS = frozenset({"qianshousuanli.com", "www.qianshousuanli.com"})


def _host(value: object, *, allow_bare: bool) -> str:
    if not isinstance(value, str):
        return ""
    raw = value.strip()
    if not raw or any(char.isspace() for char in raw):
        return ""
    try:
        if "://" in raw:
            parsed = urlsplit(raw)
            if (parsed.scheme.lower() != "https" or not parsed.netloc
                    or parsed.username is not None or parsed.password is not None):
                return ""
        elif allow_bare and not any(char in raw for char in "/?#@"):
            parsed = urlsplit("//" + raw)
        else:
            return ""
        host = (parsed.hostname or "").lower().rstrip(".")
        # Accessing port also rejects malformed authorities such as :abc.
        port = parsed.port
    except ValueError:
        return ""
    if not host or not all(part for part in host.split(".")):
        return ""
    if port is not None and not 1 <= port <= 65535:
        return ""
    return host


def _allowed_hosts() -> set[str]:
    hosts = set(_DEFAULT_HOSTS)
    for entry in os.environ.get("QS_PLATFORM_RELAY_HOSTS", "").split(","):
        host = _host(entry, allow_bare=True)
        if host:
            hosts.add(host)
    return hosts


def is_platform_host(value: object) -> bool:
    """Match only configured exact hosts, never suffix or user-info tricks."""
    host = _host(value, allow_bare=True)
    return bool(host and host in _allowed_hosts())


def relays_via_platform(task_type: str, params: Mapping | None) -> bool:
    """Return true only if all endpoints a task may contact are platform-owned."""
    if task_type not in _RELAY_TASK_TYPES:
        return False
    values = params if isinstance(params, Mapping) else {}
    explicit = values.get("endpoints")
    if explicit:
        if (not isinstance(explicit, (list, tuple)) or not explicit
                or not all(isinstance(url, str) and is_platform_host(url)
                           for url in explicit)):
            return False
        return True
    endpoint = values.get("endpoint")
    if endpoint:
        return is_platform_host(endpoint)
    if task_type == "embedding":
        configured = os.environ.get("AI_EMBED_BASE_URL")
    elif task_type in _SCRIPT_BASE_TASK_TYPES:
        configured = os.environ.get("AI_SCRIPT_BASE_URL")
    else:
        configured = None
    return is_platform_host(configured) if configured is not None else True


def inject_platform_relay_credential(task_type: str, params: dict | None) -> dict:
    """Copy params and inject the service key only for platform-only routing."""
    out = dict(params or {})
    if out.get("api_key") or not relays_via_platform(task_type, out):
        return out
    credential = os.environ.get(RELAY_CREDENTIAL_ENV, "").strip()
    if credential:
        out["api_key"] = credential
    return out
