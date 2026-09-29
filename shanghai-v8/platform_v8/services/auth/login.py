"""
登录业务

设计要点 (考虑全链路):
  1. 支持用户名 或 邮箱登录 (统一调 AccountRepo.by_username_or_email)
  2. 修复 v1 老 bug: login 跟 register 走同一份数据源 (都查 DB) · 不再"账号不存在 vs 已注册"矛盾
  3. 账号 status=suspended 不允许登录 (admin 封号机制)
  4. 签发 access + refresh 双 token (替代 v1 的 3 token: access/agent/session)
  5. 写审计 + 更新 last_login_at (跟登录在同一事务)
"""
from __future__ import annotations
import hashlib
import logging
import time
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from platform_v8.core import Account, AccountStatus, AuditAction
from platform_v8.storage.repo import AccountRepo, AuditRepo, AuthSessionRepo
from platform_v8.services.auth import passwords as pwd_svc
from platform_v8.services.auth import token as token_svc
from platform_v8.services.auth import sessions as sessions_svc

logger = logging.getLogger(__name__)


class LoginError(Exception):
    """登录失败"""
    pass


@dataclass
class LoginInput:
    username: str        # 用户名 或 邮箱
    password: str
    # 审计上下文
    trace_id: str | None = None
    ip: str | None = None
    user_agent: str | None = None
    remember_me: bool = False
    client_type: str | None = None
    client_platform: str | None = None


@dataclass
class LoginOutput:
    account: Account
    tokens: token_svc.TokenPair
    remember_me: bool = False


def write_failed_audit(s: Session, **values) -> None:
    """Commit security failures even when the request transaction rolls back."""
    bind = s.get_bind()
    if bind.dialect.name == "sqlite":
        AuditRepo.write(s, **values)
        s.commit()
        return
    with Session(bind=bind) as audit_session:
        try:
            AuditRepo.write(audit_session, **values)
            audit_session.commit()
        except Exception:
            audit_session.rollback()
            logger.exception("auth failure audit commit failed")


def authenticate(s: Session, inp: LoginInput) -> Account:
    """仅校验账号、状态和密码，不签发 token。供两步验证挑战流程复用。"""
    # 1. 找用户 (统一查 · 不分 username/email)
    account = AccountRepo.by_username_or_email(s, inp.username)
    if account is None:
        # 显式记审计 (即使账号不存在 · 也记一条 · 给 admin 看)
        write_failed_audit(
            s,
            action="auth.login_fail",
            actor_account_id=None,
            actor_kind="system",
            trace_id=inp.trace_id,
            ip=inp.ip,
            user_agent=inp.user_agent,
            detail={"reason": "account_not_found", "attempted": inp.username},
        )
        raise LoginError("用户名或密码错误")

    # 2. 状态检查 (suspended / deleted 不允许)
    if account.status != AccountStatus.ACTIVE:
        write_failed_audit(
            s,
            action="auth.login_fail",
            actor_account_id=account.id,
            actor_kind="user",
            trace_id=inp.trace_id,
            ip=inp.ip,
            detail={"reason": f"account_{account.status.value}"},
        )
        raise LoginError(f"账号已 {account.status.value} · 无法登录")

    # 3. 密码校验
    if not pwd_svc.verify_password(inp.password, account.password_hash):
        write_failed_audit(
            s,
            action="auth.login_fail",
            actor_account_id=account.id,
            actor_kind="user",
            trace_id=inp.trace_id,
            ip=inp.ip,
            detail={"reason": "wrong_password"},
        )
        raise LoginError("用户名或密码错误")

    return account


def complete_login(
    s: Session,
    account: Account,
    inp: LoginInput,
    *,
    two_factor: bool = False,
    device_id: str | None = None,
    trusted_device: bool = False,
) -> LoginOutput:
    """认证步骤全部完成后签发 token，并统一更新登录状态与审计。"""
    session_id = sessions_svc.create_login_session(
        s,
        account_id=account.id,
        user_agent=inp.user_agent,
        client_ip=inp.ip,
        device_id=device_id,
        remember_me=inp.remember_me,
        client_type=inp.client_type,
        client_platform=inp.client_platform,
    )
    tokens = token_svc.issue_token_pair(
        account_id=account.id,
        role=account.role.value,
        session_id=session_id,
    )
    refresh_claims = token_svc.verify_token(
        tokens.refresh_token,
        expected_kind="refresh",
    )
    if not AuthSessionRepo.initialize_refresh(
        s,
        session_id,
        account.id,
        refresh_jti_hash=_hash_jti(refresh_claims.jti),
        refresh_expires_at=datetime.utcfromtimestamp(refresh_claims.exp),
    ):
        raise LoginError("登录会话初始化失败，请重试")

    AccountRepo.update_last_login(s, account.id)
    AuditRepo.write(
        s,
        action=AuditAction.LOGIN,
        actor_account_id=account.id,
        actor_kind="user",
        trace_id=inp.trace_id,
        ip=inp.ip,
        user_agent=inp.user_agent,
        detail={
            "role": account.role.value,
            "two_factor": two_factor,
            "trusted_device": trusted_device,
        },
    )

    logger.info("auth.login · account=%s role=%s trace=%s",
                account.id, account.role.value, inp.trace_id)
    return LoginOutput(
        account=account,
        tokens=tokens,
        remember_me=inp.remember_me,
    )


def login(s: Session, inp: LoginInput) -> LoginOutput:
    """普通登录：完成凭据校验并立即签发 token。"""
    account = authenticate(s, inp)
    return complete_login(s, account, inp)


# ── refresh token ────────────────────────────────────
def refresh(
    s: Session,
    refresh_token: str,
    *,
    ip: str | None = None,
    user_agent: str | None = None,
) -> LoginOutput:
    """Atomically rotate one refresh family; reuse revokes its whole session."""
    try:
        claims = token_svc.verify_token(refresh_token, expected_kind="refresh")
    except token_svc.TokenError as exc:
        raise LoginError(f"refresh token 无效: {exc}")

    if not claims.sid or not claims.jti:
        raise LoginError("旧版 refresh token 不再支持 · 请重新登录")

    account = AccountRepo.by_id(s, claims.account_id)
    if account is None:
        raise LoginError("账号不存在")
    if account.status != AccountStatus.ACTIVE:
        raise LoginError(f"账号已 {account.status.value}")

    session_id = claims.sid
    session_row = AuthSessionRepo.by_id_for_account(s, session_id, account.id)
    if session_row is None:
        raise LoginError("登录设备会话不存在 · 请重新登录")
    if (
        session_row.get("revoked_at") is not None
        or not session_row.get("refresh_jti_hash")
        or not session_row.get("refresh_expires_at")
    ):
        AuthSessionRepo.revoke(s, session_id, account.id)
        s.commit()
        raise LoginError("旧版或已退出的登录会话不可续期 · 请重新登录")

    tokens = token_svc.issue_token_pair(
        account_id=account.id,
        role=account.role.value,
        session_id=session_id,
    )
    new_claims = token_svc.verify_token(
        tokens.refresh_token,
        expected_kind="refresh",
    )

    if not AuthSessionRepo.rotate_refresh(
        s,
        session_id,
        account.id,
        expected_jti_hash=_hash_jti(claims.jti),
        new_jti_hash=_hash_jti(new_claims.jti),
        new_expires_at=datetime.utcfromtimestamp(new_claims.exp),
    ):
        current = AuthSessionRepo.by_id_for_account(s, session_id, account.id)
        if current and current.get("revoked_at") is None:
            AuthSessionRepo.revoke(s, session_id, account.id)
            s.commit()
            raise LoginError("检测到 refresh token 重用，会话已吊销 · 请重新登录")
        raise LoginError("登录设备会话已退出 · 请重新登录")

    try:
        from platform_v8.services.auth import revocation
        revocation.revoke_jti(
            claims.jti,
            max(1, claims.exp - int(time.time())),
        )
    except Exception:
        pass

    return LoginOutput(
        account=account,
        tokens=tokens,
        remember_me=bool(session_row.get("remember_me")),
    )


def _hash_jti(jti: str) -> str:
    return hashlib.sha256(str(jti).encode("utf-8")).hexdigest()
