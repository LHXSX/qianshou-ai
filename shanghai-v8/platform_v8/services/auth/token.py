"""
JWT token · 签发 + 验证

设计要点 (考虑全链路):
  1. 双 token: access (15min · 业务用) + refresh (7d · 续期用)
     v8 砍掉了 v1 的 "agent_token 1 年长效" (安全问题)
  2. 客户端长连 ws: 用 access_token 在 auth 帧鉴权 · access 过期后用 refresh 续
  3. JWT secret 从 env (V8_JWT_SECRET) · 不允许硬编码 (启动 fail-fast)
  4. claims: {sub: account_id, role, kind: access|refresh, exp, iat, jti}
  5. 全平台只在这一个文件签 + 验 JWT (api/deps.py 的 get_current_account 也调这里)
"""
from __future__ import annotations
import logging
import os
import time
import uuid
from dataclasses import dataclass

import jwt   # PyJWT

logger = logging.getLogger(__name__)


# ── 配置 (启动时校验) ───────────────────────────────
def _get_secret() -> str:
    s = os.environ.get("V8_JWT_SECRET")
    if not s:
        raise RuntimeError(
            "V8 JWT 配置缺失: 必须设置 V8_JWT_SECRET 环境变量。"
            "不再支持硬编码 secret (v1 老代码遗留的安全问题已在 v8 修复)。"
        )
    if len(s) < 32:
        raise RuntimeError("V8_JWT_SECRET 长度 < 32 字符 · 不安全")
    return s


ACCESS_TTL_SECONDS = int(os.environ.get("V8_JWT_ACCESS_TTL", "900"))       # 15 min
REFRESH_TTL_SECONDS = int(os.environ.get("V8_JWT_REFRESH_TTL", "604800"))  # 7 d
ALGORITHM = "HS256"


# ── token 数据结构 ───────────────────────────────────
@dataclass
class TokenClaims:
    """JWT decode 后的 claims"""
    sub: str           # account_id (字符串形式)
    role: str
    kind: str          # "access" | "refresh"
    exp: int           # epoch
    iat: int
    jti: str           # JWT id (唯一 · 后续可加 revocation)
    sid: str = ""      # 登录会话 ID · 用于设备管理

    @property
    def account_id(self) -> int:
        return int(self.sub)


@dataclass
class TokenPair:
    access_token: str
    refresh_token: str
    expires_in: int = ACCESS_TTL_SECONDS


# ── 签发 ────────────────────────────────────────────
def _sign(
    *,
    account_id: int,
    role: str,
    kind: str,
    ttl_s: int,
    session_id: str = "",
) -> str:
    now = int(time.time())
    payload = {
        "sub": str(account_id),
        "role": role,
        "kind": kind,
        "iat": now,
        "exp": now + ttl_s,
        "jti": uuid.uuid4().hex,
    }
    if session_id:
        payload["sid"] = session_id
    return jwt.encode(payload, _get_secret(), algorithm=ALGORITHM)


def issue_token_pair(*, account_id: int, role: str, session_id: str = "") -> TokenPair:
    """登录成功 / refresh 成功后调用 · 签发 access + refresh"""
    access = _sign(
        account_id=account_id, role=role,
        kind="access", ttl_s=ACCESS_TTL_SECONDS, session_id=session_id,
    )
    refresh = _sign(
        account_id=account_id, role=role,
        kind="refresh", ttl_s=REFRESH_TTL_SECONDS, session_id=session_id,
    )
    return TokenPair(access_token=access, refresh_token=refresh)


# ── 验证 ────────────────────────────────────────────
class TokenError(Exception):
    """JWT 验证失败 (任何原因)"""
    pass


def verify_token(token: str, *, expected_kind: str = "access") -> TokenClaims:
    """
    验证 + 解析 token · 失败抛 TokenError。

    expected_kind: 'access' (业务 endpoint 用) | 'refresh' (refresh endpoint 用)
    """
    if not token:
        raise TokenError("token 为空")

    try:
        payload = jwt.decode(token, _get_secret(), algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise TokenError("token 已过期")
    except jwt.InvalidTokenError as exc:
        raise TokenError(f"token 无效: {exc}")

    kind = payload.get("kind")
    if kind != expected_kind:
        raise TokenError(f"token 类型不匹配 (要求 {expected_kind} · 实际 {kind})")

    try:
        return TokenClaims(
            sub=str(payload["sub"]),
            role=str(payload.get("role", "")),
            kind=kind,
            exp=int(payload["exp"]),
            iat=int(payload["iat"]),
            jti=str(payload.get("jti", "")),
            sid=str(payload.get("sid", "")),
        )
    except (KeyError, ValueError) as exc:
        raise TokenError(f"token claims 不合法: {exc}")


def extract_bearer(authorization: str | None) -> str:
    """从 Authorization header 提取 token (e.g. 'Bearer xxx' → 'xxx')"""
    if not authorization:
        raise TokenError("缺少 Authorization 头")
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise TokenError("Authorization 格式应为 'Bearer <token>'")
    return parts[1]
