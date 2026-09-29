"""
FastAPI 依赖注入 · 全 v8 endpoint 复用

设计要点 (考虑全链路):
  - get_session: 注入 db session · 出 endpoint 自动 commit/rollback/close
  - get_current_account: 注入 JWT 验证后的 Account · 未登录返 401
  - get_admin_account: 强制 admin · 否则 403
  - get_request_id: 注入 trace_id · 用于审计日志
"""
from __future__ import annotations
import hashlib
import logging
import os
import threading
import time
from typing import Iterator
from uuid import uuid4

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from platform_v8.core import Account
from platform_v8.storage import db as db_mod
from platform_v8.storage.repo import AccountRepo, ApiKeyRepo
from platform_v8.services.auth import token as token_svc
from platform_v8.services.auth import validation as auth_validation

logger = logging.getLogger(__name__)
_API_KEY_BURST_LIMIT = max(
    1, int(os.environ.get("V8_API_KEY_BURST_PER_SECOND", "30"))
)
_api_key_burst_lock = threading.Lock()
_api_key_burst_local: dict[str, tuple[int, int]] = {}


def _is_api_key_management_request(request: Request) -> bool:
    path = request.url.path.rstrip("/")
    return (
        path == "/api/v8/developer/keys"
        or path.startswith("/api/v8/developer/keys/")
        or path == "/api/v8/enterprise/api-keys"
        or path.startswith("/api/v8/enterprise/api-keys/")
    )


def _is_scoped_api_key_request(request: Request) -> bool:
    """Long-lived keys only enter routers that declare a scope on every route."""
    path = request.url.path.rstrip("/")
    return path.startswith("/api/v8/developer/") or path.startswith("/api/v8/files/")


def _enforce_api_key_burst_limit(token: str) -> None:
    """在访问数据库前按 API Key 削峰，避免突发请求耗尽连接池。"""
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    redis_key = f"v8:auth:api-key-burst:{digest}"
    count: int | None = None
    retry_after = 1

    try:
        from platform_v8.storage.kv import get_redis

        redis = get_redis()
        if redis is not None:
            count = int(
                redis.eval(
                    """
                    local count = redis.call('INCR', KEYS[1])
                    if count == 1 then
                        redis.call('EXPIRE', KEYS[1], ARGV[1])
                    end
                    return count
                    """,
                    1,
                    redis_key,
                    1,
                )
            )
            retry_after = max(1, int(redis.ttl(redis_key)))
    except Exception:
        # Redis 故障时仍用进程内固定窗保护本进程的连接池。
        count = None

    if count is None:
        window = int(time.monotonic())
        with _api_key_burst_lock:
            previous_window, previous_count = _api_key_burst_local.get(
                digest, (window, 0)
            )
            count = previous_count + 1 if previous_window == window else 1
            _api_key_burst_local[digest] = (window, count)
            if len(_api_key_burst_local) > 10_000:
                stale = [
                    key
                    for key, (item_window, _) in _api_key_burst_local.items()
                    if item_window < window
                ]
                for key in stale:
                    _api_key_burst_local.pop(key, None)

    if count > _API_KEY_BURST_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="API Key 请求突发过高，请降低并发并稍后重试",
            headers={"Retry-After": str(retry_after)},
        )


def get_session() -> Iterator[Session]:
    """db session 依赖 · 直接 yield from storage.db.get_session"""
    yield from db_mod.get_session()


def get_request_id(
    request: Request,
    x_request_id: str | None = Header(default=None, alias="X-Request-ID"),
) -> str:
    """每个请求生成 trace_id (或用客户端传的)"""
    rid = x_request_id or str(uuid4())
    # 挂到 request.state 给 middleware / 日志拿
    request.state.trace_id = rid
    return rid


# ── 鉴权依赖 (链路 2 实现 · 后续所有 protected endpoint 用) ─────────────
def get_current_account(
    request: Request,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> Account:
    """
    JWT access token 验证 + 加载 Account · 失败 401。

    2026-05-18 v8 全收口:
      1. 优先验 v8 access token (kind=access)
      2. fallback 验 v1 token (kind=user / 或 v1 老 payload)
         · v1 sub = sv_users.id · 跟 we_accounts.id 一一对应 (已迁移)
         · 直接用 sub 当 account_id 加载

    2026-07 开发者 API:
      · Bearer qs_... (及历史 qsk_...) → we_api_keys 查 hash → Account
      · 先验 JWT；若非 JWT 且形如 API Key 前缀再走 Key 鉴权

    用法 (任何需要登录的 endpoint):
        @router.get("/me")
        def me(current: Account = Depends(get_current_account)):
            ...
    """
    try:
        token = token_svc.extract_bearer(authorization)
    except token_svc.TokenError as exc:
        raise HTTPException(status_code=401, detail=str(exc))

    # ── 开发者长期 API Key (qs_ / 历史 qsk_) ─────────────────────────
    if token.startswith("qs_") or token.startswith("qsk_"):
        _enforce_api_key_burst_limit(token)
        if _is_api_key_management_request(request):
            raise HTTPException(status_code=403, detail="API Key 管理仅支持 JWT 登录")
        if not _is_scoped_api_key_request(request):
            raise HTTPException(status_code=403, detail="API Key 仅可用于声明了权限范围的开发者接口")
        account, scopes = ApiKeyRepo.resolve_key(session, token)
        if account is None:
            raise HTTPException(status_code=401, detail="API Key 无效、已吊销或已过期")
        if not account.is_active:
            raise HTTPException(status_code=403, detail=f"账号已 {account.status.value}")
        request.state.account_id = account.id
        request.state.account_role = (
            account.role.value if hasattr(account.role, "value") else str(account.role)
        )
        request.state.auth_via = "api_key"
        request.state.api_key_scopes = scopes
        # 鉴权与业务接口共享 Session；先结束短事务，避免连接被整个请求占用。
        session.commit()
        return account

    # 1. 仅接受 v8 access token (S2-T1 · 2026-06-07 安全收紧)
    # 此前 fallback 验 refresh,导致泄露的 refresh 可直调任意 API(refresh 7 天有效)。
    # 现 HTTP API 强制 access (15min);refresh 仅在 /auth/refresh 端点显式校验。
    account_id: int | None = None
    claims_obj = None
    account = None
    try:
        validated = auth_validation.validate_v8_access(session, token)
        claims_obj = validated.claims
        account_id = claims_obj.account_id
        account = validated.account
    except auth_validation.AuthValidationError as v8_error:
        try:
            token_svc.verify_token(token, expected_kind="access")
        except token_svc.TokenError:
            pass
        else:
            raise HTTPException(status_code=401, detail=str(v8_error))
        # 检测是否是 refresh token (给清晰错误而非"无效")
        try:
            _maybe_refresh = token_svc.verify_token(token, expected_kind="refresh")
            if _maybe_refresh.account_id:
                raise HTTPException(
                    status_code=401,
                    detail="不能用 refresh token 调 API · 请用 /auth/refresh 换 access token",
                )
        except token_svc.TokenError:
            pass
    if claims_obj is not None:
        request.state.session_id = claims_obj.sid
    if account_id is None:
        try:
            sub, _kind = auth_validation.validate_legacy_token(
                token,
                allowed_kinds=("user",),
            )
            if str(sub).lower() == "admin":
                from platform_v8.services.auth.admin_lookup import resolve_admin_account_id
                account_id = resolve_admin_account_id()
            else:
                account_id = int(sub)
        except (auth_validation.AuthValidationError, TypeError, ValueError) as exc:
            raise HTTPException(status_code=401, detail=f"token 无效: {exc}")

    account = account or AccountRepo.by_id(session, account_id)
    if account is None:
        raise HTTPException(status_code=401, detail=f"账号 {account_id} 不存在 (v1→v8 未迁移?)")
    if not account.is_active:
        raise HTTPException(status_code=403, detail=f"账号已 {account.status.value}")

    # 2026-05-25 P3 · 给 rate_limit "uid" key 用 · 也方便中间件统一记 access log
    request.state.account_id = account.id
    request.state.account_role = account.role.value if hasattr(account.role, "value") else str(account.role)
    request.state.auth_via = "jwt"
    # 2026-06-04 · 存 jti/exp 给 logout 吊销用 (v8 token 才有)
    if claims_obj is not None:
        request.state.token_jti = claims_obj.jti
        request.state.token_exp = claims_obj.exp

    session.commit()
    return account


def get_admin_account(
    current: Account = Depends(get_current_account),
) -> Account:
    """admin-only endpoint · 否则 403"""
    if not current.is_admin:
        raise HTTPException(status_code=403, detail="需要 admin 权限")
    return current


def require_scope(*needed: str):
    """API Key scopes 闸门。JWT 会话跳过；Key 须含 needed 任一或 *。

    用法::
        @router.post("/upload-url", dependencies=[Depends(require_scope("files"))])
    """

    needed_set = {str(s).strip().lower() for s in needed if s}

    def _dep(
        request: Request,
        current: Account = Depends(get_current_account),
    ) -> Account:
        if getattr(request.state, "auth_via", None) != "api_key":
            return current
        scopes = getattr(request.state, "api_key_scopes", None)
        if not isinstance(scopes, list):
            scopes = []
        scopes_l = {str(s).strip().lower() for s in scopes}
        if "*" in scopes_l or not needed_set:
            return current
        if scopes_l & needed_set:
            return current
        raise HTTPException(
            status_code=403,
            detail=f"API Key 缺少权限: {','.join(sorted(needed_set))}",
        )

    return _dep
