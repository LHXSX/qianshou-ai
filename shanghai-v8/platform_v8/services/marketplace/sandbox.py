"""第三方应用沙箱策略（M4 加固）。"""
from __future__ import annotations

from typing import Any

ALLOWED_NETWORK = frozenset({"none", "whitelist", "full"})
OFFICIAL_AUTHOR_NAMES = frozenset({"千手官方", "qianshou", "official"})


class SandboxPolicyError(ValueError):
    pass


def resolve_sandbox_network(
    *,
    requested: str | None,
    verified_author: bool,
    author_name: str | None,
    is_official_task_type: bool,
) -> str:
    """
    第三方脚本默认 network=none。
    仅官方/已验证作者可申请 whitelist；full 仅管理员可批（此处拒绝）。
    """
    net = (requested or "none").strip().lower()
    if net not in ALLOWED_NETWORK:
        raise SandboxPolicyError(f"非法 sandbox_network: {requested}")
    official = (
        verified_author
        or (author_name or "").strip() in OFFICIAL_AUTHOR_NAMES
        or is_official_task_type
    )
    if not official:
        if net == "full":
            raise SandboxPolicyError("第三方应用禁止 sandbox_network=full")
        # whitelist 等非 none 请求一律钳制为 none（不静默升级权限）
        return "none"
    return net


def validate_bundle_integrity(
    *,
    sha256: str | None,
    signed: bool,
    require_signed: bool = True,
) -> list[str]:
    """返回警告列表；硬失败抛 SandboxPolicyError。"""
    warnings: list[str] = []
    if require_signed and not signed:
        raise SandboxPolicyError("上架包必须签名 (signed=true)")
    if not sha256 or len(sha256) != 64:
        if require_signed:
            raise SandboxPolicyError("上架包缺少有效 sha256")
        warnings.append("missing_sha256")
    return warnings


def lending_task_allowed(
    *,
    allow_third_party: bool,
    task_type: str,
    official_task_types: set[str],
) -> bool:
    """出借默认仅跑官方/已验证 task_type。"""
    if task_type in official_task_types:
        return True
    return bool(allow_third_party)


def app_to_policy_dict(app: dict[str, Any]) -> dict[str, Any]:
    return {
        "slug": app.get("slug"),
        "sandbox_network": app.get("sandbox_network") or "none",
        "verified_author": bool(app.get("verified_author")),
        "launch_kind": app.get("launch_kind") or "workload",
        "task_type": app.get("task_type"),
    }
