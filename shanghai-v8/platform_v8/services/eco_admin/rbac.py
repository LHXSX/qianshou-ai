"""生态运营台轻量 RBAC。

鉴权仍要求 is_admin（get_admin_account）；本模块在管理员之内再按 role 收权。
未识别的 admin role 默认视为超级管理员，保证存量账号零回归。
"""
from __future__ import annotations

from typing import Iterable

from fastapi import Depends, HTTPException

from platform_v8.api.deps import get_admin_account
from platform_v8.core import Account

# permission → 允许的 role 集合（小写）
_PERMS: dict[str, frozenset[str]] = {
    "eco.home": frozenset({"super_admin", "admin", "ops", "finance", "openapi_readonly"}),
    "eco.apps.review": frozenset({"super_admin", "admin", "ops"}),
    "eco.openapi.read": frozenset({"super_admin", "admin", "ops", "openapi_readonly"}),
    "eco.openapi.revoke_key": frozenset({"super_admin", "admin"}),
    "eco.funds.read": frozenset({"super_admin", "admin", "ops", "finance"}),
    "eco.audit.read": frozenset({"super_admin", "admin", "ops"}),
    "eco.users.balance_adjust": frozenset({"super_admin", "admin"}),
    "eco.settings": frozenset({"super_admin", "admin"}),
}

_ALIAS = {
    "superadmin": "super_admin",
    "运营": "ops",
    "运营审核": "ops",
    "财务": "finance",
    "财务只读": "finance",
    "开放平台只读": "openapi_readonly",
}


def normalize_role(account: Account) -> str:
    raw = str(getattr(account, "role", "") or "").strip().lower()
    if raw in _ALIAS:
        raw = _ALIAS[raw]
    if raw in ("super_admin", "admin", "ops", "finance", "openapi_readonly"):
        return raw
    # 存量 is_admin 账号多数 role=admin / personal；个人但已过 get_admin_account → 当 admin
    return "admin"


def has_perm(account: Account, perm: str) -> bool:
    allowed = _PERMS.get(perm)
    if allowed is None:
        return True
    return normalize_role(account) in allowed


def require_perm(perm: str):
    def _dep(admin: Account = Depends(get_admin_account)) -> Account:
        if not has_perm(admin, perm):
            raise HTTPException(
                status_code=403,
                detail=f"当前角色无权限：{perm}",
            )
        return admin

    return _dep


def matrix_for_ui() -> list[dict]:
    roles = ("super_admin", "admin", "ops", "finance", "openapi_readonly")
    out = []
    for perm, allowed in _PERMS.items():
        row = {"perm": perm}
        for r in roles:
            row[r] = r in allowed
        out.append(row)
    return out


def assert_any(account: Account, perms: Iterable[str]) -> None:
    if not any(has_perm(account, p) for p in perms):
        raise HTTPException(status_code=403, detail="权限不足")
