"""
注册业务

设计要点 (考虑全链路):
  1. 唯一性校验: 用户名 + 邮箱 都不能重复
  2. 密码强度: pydantic 已校验 (min_length=6) · 这里不重复
  3. 邮箱可选: 不填用 <username>@local 占位
  4. 全程 1 个事务: AccountRepo.create + AuditRepo.write 一起 commit
  5. 失败统一抛 ValueError · router 层转 HTTPException
"""
from __future__ import annotations
import logging
from dataclasses import dataclass

from sqlalchemy.orm import Session

from platform_v8.core import Account, AccountRole, AuditAction
from platform_v8.storage.repo import AccountRepo, AuditRepo
from platform_v8.services.auth import passwords as pwd_svc

logger = logging.getLogger(__name__)


class RegistrationError(Exception):
    """注册失败 (用户名/邮箱重复 · 等)"""
    pass


@dataclass
class RegisterInput:
    username: str
    password: str
    email: str | None = None
    company: str | None = None
    # 审计上下文 (router 传入)
    trace_id: str | None = None
    ip: str | None = None
    user_agent: str | None = None


def register(s: Session, inp: RegisterInput) -> Account:
    """
    注册新账号 · 返回 Account · 失败抛 RegistrationError

    全程同步 · session.commit() 由 get_session 包装统一做。
    """
    # 修复运算符优先级 bug：必须加括号保证 if/else 先求值
    # 旧写法等价于 ((inp.username or inp.email.split("@")[0]) if inp.email else "user").strip()
    # 当前端不传 email 时 username 永远被改成 "user" → 与历史 deleted 用户冲突 → 400
    raw_username = inp.username or (inp.email.split("@")[0] if inp.email else "user")
    username = raw_username.strip()
    if not username:
        import secrets, string
        username = "user_" + "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(6))
    email = (inp.email or "").strip() or f"{username.lower()}@local"

    # 1. 唯一性校验
    if AccountRepo.exists_username(s, username):
        raise RegistrationError("该账号已被注册")
    # 占位邮箱 (<user>@local) 不参与冲突校验 (因为 username 已经唯一)
    if not email.endswith("@local"):
        if AccountRepo.exists_email(s, email):
            raise RegistrationError("该邮箱已被注册")

    # 2. bcrypt
    password_hash = pwd_svc.hash_password(inp.password)

    # 匿名注册的 company 仅表示企业用途意向，不能成为权限凭据。
    # 既有 enterprise 账号不在此处修改；升级角色需走管理员授权流程。
    company = (inp.company or "").strip().lower()
    role = AccountRole.PERSONAL

    # 3. 写 DB
    account = AccountRepo.create(
        s,
        username=username,
        email=email,
        password_hash=password_hash,
        role=role,
    )

    # 4. 审计 (跟 account 同一个事务)
    AuditRepo.write(
        s,
        action=AuditAction.REGISTER,
        actor_account_id=account.id,
        actor_kind="user",
        target_kind="account",
        target_id=str(account.id),
        trace_id=inp.trace_id,
        ip=inp.ip,
        user_agent=inp.user_agent,
        detail={
            "username": username,
            "email": email,
            "company": company or None,
            "requested_account_type": "enterprise" if company == "enterprise" else "personal",
            "role": role.value,
        },
    )

    logger.info("auth.register · account=%s · trace=%s", account.id, inp.trace_id)
    return account
