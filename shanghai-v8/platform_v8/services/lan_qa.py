"""LAN / 验收与结果验收兼容开关。

LAN 验收（临时绕过 quarantine / crawl 等）仍要求：
  ``EDGE_LAN_QA=1``（或 ``V8_ENV`` 为 development/lan/local）
  且 ``EDGE_LAN_QA_RELAX_VERIFIER=1``。

旧节点兼容（artifact 策略下允许 inline 回传）：
  **默认开启**。若需恢复严格「必须 server-issued artifact.v1」，设
  ``EDGE_ARTIFACT_STRICT=1``。
"""
from __future__ import annotations

import os
from typing import Iterable


def _truthy(raw: str | None) -> bool:
    if raw is None:
        return False
    return raw.strip().lower() in {"1", "true", "yes", "on", "enabled"}


def lan_qa_context() -> bool:
    """是否处于 LAN/验收上下文（仍需 relax 开关才会改 verifier 行为）。"""
    if _truthy(os.getenv("EDGE_LAN_QA")):
        return True
    env = (os.getenv("V8_ENV") or os.getenv("ENVIRONMENT") or "").strip().lower()
    return env in {"development", "dev", "lan", "local", "test"}


def relax_verifier_enabled() -> bool:
    """主开关：放宽 verifier / quarantine（仅 LAN/验收）。"""
    if not _truthy(os.getenv("EDGE_LAN_QA_RELAX_VERIFIER")):
        return False
    return lan_qa_context()


def effective_settlement_policy(policy: str) -> str:
    """REGISTRY_QUARANTINE → artifact（仅 LAN relax）。"""
    p = (policy or "quarantine").strip().lower()
    if p not in {"semantic", "artifact", "quarantine"}:
        p = "quarantine"
    if relax_verifier_enabled() and p == "quarantine":
        return "artifact"
    return p


def allow_inline_under_artifact() -> bool:
    """允许 artifact 策略下用 inline 交割（兼容旧节点）。

    默认 True。设 ``EDGE_ARTIFACT_STRICT=1`` 恢复强制 artifact.v1。
    """
    if _truthy(os.getenv("EDGE_ARTIFACT_STRICT")):
        return False
    return True


def force_legacy_settle() -> bool:
    """legacy settle 门控为 shadow/off 时，LAN 验收仍放行结算。"""
    return relax_verifier_enabled()


def crawl_allow_domains() -> set[str]:
    """LAN 验收额外爬虫白名单域名（逗号分隔，不含协议）。

    例: ``EDGE_LAN_QA_CRAWL_ALLOW_DOMAINS=example.com,www.example.com``
    需同时满足 ``lan_qa_context()``；不改生产 DB 白名单表。
    """
    if not lan_qa_context():
        return set()
    raw = (os.getenv("EDGE_LAN_QA_CRAWL_ALLOW_DOMAINS") or "").strip()
    if not raw:
        return set()
    out: set[str] = set()
    for part in raw.split(","):
        d = part.strip().lower().lstrip(".")
        if d:
            out.add(d)
    return out


def host_in_crawl_allowlist(host: str, domains: Iterable[str] | None = None) -> bool:
    h = (host or "").strip().lower()
    if not h:
        return False
    allow = set(domains) if domains is not None else crawl_allow_domains()
    if not allow:
        return False
    for d in allow:
        if h == d or h.endswith("." + d):
            return True
    return False
