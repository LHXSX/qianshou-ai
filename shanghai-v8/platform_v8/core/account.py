"""
Account · 用户账号

替代: sv_users
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any

from .enums import AccountRole, AccountStatus


@dataclass
class Account:
    id: int                                     # 自增 (内部用) · 外部 API 用 username
    username: str                               # 唯一 · 登录用
    email: str                                  # 唯一 · 可 @local 占位
    password_hash: str                          # bcrypt
    role: AccountRole = AccountRole.PERSONAL
    status: AccountStatus = AccountStatus.ACTIVE
    balance: Decimal = field(default_factory=lambda: Decimal("0"))
    profile: dict[str, Any] = field(default_factory=dict)  # 头像/昵称/手机/...
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
    last_login_at: datetime | None = None
    phone: str | None = None                    # 手机号（唯一，可空）· 手机号登录用
    phone_verified_at: datetime | None = None   # 首次通过短信验证码核销的时间

    @property
    def is_admin(self) -> bool:
        return self.role == AccountRole.ADMIN

    @property
    def is_active(self) -> bool:
        return self.status == AccountStatus.ACTIVE
