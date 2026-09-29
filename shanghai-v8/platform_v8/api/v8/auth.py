"""
Auth HTTP router · /api/v8/auth/*

设计要点 (考虑全链路):
  - 严格遵循 ops.py 模板: router 不写业务 · 调 service
  - request body 用 protocol/http_schema.py 统一定义
  - 错误统一抛 HTTPException · 由 api/app.py exception_handler 转 {ok, code, message, trace_id}
  - 鉴权 endpoint (/me) 用 Depends(get_current_account) (api/deps.py)
"""
from __future__ import annotations
import logging
import os
import secrets
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from platform_v8.api.client_ip import client_ip as resolve_client_ip
from platform_v8.api.deps import get_session, get_current_account
from platform_v8.api.rate_limit import rate_limit
from platform_v8.core import Account
from platform_v8.protocol.http_schema import (
    RegisterRequest, LoginRequest, LoginTotpRequest, RefreshRequest,
    AccountOut, LoginResponse, MeResponse, RefreshResponse, TokenPair,
    SessionTrustRequest,
)
from platform_v8.services.auth import register as register_svc
from platform_v8.services.auth import login as login_svc
from platform_v8.services.auth import token as token_svc
from platform_v8.services.auth import passwords as pwd_svc
from platform_v8.services.auth import totp as totp_svc
from platform_v8.services.auth import sessions as auth_sessions_svc
from platform_v8.services.auth import trusted_devices as trusted_devices_svc
from platform_v8.services import sms as sms_svc
from platform_v8.storage.repo import (
    AccountRepo,
    AuditRepo,
    AuthSessionRepo,
    TrustedDeviceRepo,
)
from platform_v8.core import AuditAction
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/auth", tags=["auth"])
REFRESH_COOKIE_NAME = "we_refresh_token"


def _client_ip(request: Request) -> str:
    return resolve_client_ip(request)


def _is_tauri(request: Request) -> bool:
    return request.headers.get("X-Client-Type", "").strip().lower() == "tauri"


def _client_platform(request: Request) -> str | None:
    value = (request.headers.get("X-Client-Platform") or "").strip()
    return value or None


def _incoming_device_credential(request: Request) -> str | None:
    # 优先读 header：局域网跨端口 (5178→8000) 时 SameSite Cookie 常传不回，
    # 网页两步验证期间用 X-Device-Credential 对齐 Tauri 行为。
    header = (request.headers.get("X-Device-Credential") or "").strip()
    if header:
        return header
    return request.cookies.get(trusted_devices_svc.COOKIE_NAME)


def _device_metadata(request: Request) -> dict:
    user_agent = request.headers.get("User-Agent")
    description = auth_sessions_svc.describe_user_agent(
        user_agent,
        client_type="tauri" if _is_tauri(request) else "web",
        client_platform=_client_platform(request),
    )
    meta = {
        **description,
        "client_type": "tauri" if _is_tauri(request) else "web",
        "user_agent": user_agent or "",
        "client_ip": _client_ip(request),
    }
    fingerprint = (request.headers.get("X-Device-Fingerprint") or "").strip()
    if (
        fingerprint
        and len(fingerprint) <= 128
        and all(ch.isalnum() or ch in "-_" for ch in fingerprint)
    ):
        meta["fingerprint"] = fingerprint
    return meta


def _login_input_from_request(
    request: Request,
    *,
    username: str,
    password: str,
    remember_me: bool = False,
) -> login_svc.LoginInput:
    return login_svc.LoginInput(
        username=username,
        password=password,
        trace_id=getattr(request.state, "trace_id", None),
        ip=_client_ip(request),
        user_agent=request.headers.get("User-Agent"),
        remember_me=remember_me,
        client_type="tauri" if _is_tauri(request) else "web",
        client_platform=_client_platform(request),
    )


def _secure_device_cookie(request: Request) -> bool:
    environment = (
        os.environ.get("V8_ENV")
        or os.environ.get("APP_ENV")
        or os.environ.get("ENVIRONMENT")
        or ""
    ).strip().lower()
    forwarded_proto = request.headers.get("X-Forwarded-Proto", "")
    return (
        environment in {"prod", "production"}
        or request.url.scheme == "https"
        or forwarded_proto.split(",", 1)[0].strip().lower() == "https"
    )


def _deliver_device_credential(
    payload: dict,
    *,
    request: Request,
    response: Response,
    credential: str | None,
) -> dict:
    if not credential:
        return payload
    # 始终回传 JSON 字段：MFA 挑战阶段网页必须能记住凭证并在 /login/totp 带回。
    # Cookie 仍写入，供同站刷新后静默识别；跨端口开发环境不可依赖 Cookie  alone。
    payload["device_credential"] = credential
    if not _is_tauri(request):
        response.set_cookie(
            key=trusted_devices_svc.COOKIE_NAME,
            value=credential,
            max_age=trusted_devices_svc.COOKIE_MAX_AGE_SECONDS,
            httponly=True,
            secure=_secure_device_cookie(request),
            samesite="lax",
            path="/",
        )
    return payload


def _deliver_refresh_token(
    payload: dict,
    out: login_svc.LoginOutput,
    *,
    request: Request,
    response: Response,
) -> dict:
    """Deliver refresh token for renewal.

    Cookie alone is unreliable for LAN/cross-port SPAs (e.g. :1421 → :8000):
    SameSite cookies often do not round-trip, and enterprise-agent stores refresh
    in localStorage. Always return refresh in JSON (Tauri + web); still set the
    httpOnly cookie for same-origin portals that prefer it.
    """
    if not _is_tauri(request):
        response.set_cookie(
            key=REFRESH_COOKIE_NAME,
            value=out.tokens.refresh_token,
            max_age=token_svc.REFRESH_TTL_SECONDS if out.remember_me else None,
            httponly=True,
            secure=_secure_device_cookie(request),
            samesite="lax",
            path="/api/v8/auth",
        )
    # Keep refresh in body for both clients (localStorage / keychain renewal).
    payload["refresh_token"] = out.tokens.refresh_token
    payload["agent_token"] = out.tokens.refresh_token
    if isinstance(payload.get("tokens"), dict):
        payload["tokens"]["refresh_token"] = out.tokens.refresh_token
    return payload


# ── POST /register ──────────────────────────────────
# 2026-05-25 P3 · dependencies 式 rate_limit · 5 次/分钟/IP
@router.post("/register", summary="注册新账号（自动签发 token · 注册即登录）",
             dependencies=[Depends(rate_limit("auth_register", per_minute=5, key="ip"))])
def register_endpoint(
    body: RegisterRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    """注册成功后立即签发 access + refresh token，前端可一步完成注册并登录。

    返回结构与 /login 对齐（顶层 access_token / refresh_token / role / user
    + v1 兼容的 agent_token + v8 风格 tokens / account），无需前端再多调 /login。
    """
    try:
        account = register_svc.register(
            session,
            register_svc.RegisterInput(
                username=body.username,
                password=body.password,
                email=body.email,
                company=getattr(body, "company", None),
                trace_id=getattr(request.state, "trace_id", None),
                ip=_client_ip(request),
                user_agent=request.headers.get("User-Agent"),
            ),
        )
    except register_svc.RegistrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        device = trusted_devices_svc.resolve_or_register(
            session,
            account_id=account.id,
            credential=_incoming_device_credential(request),
            metadata=_device_metadata(request),
        )
        out = login_svc.complete_login(
            session,
            account,
            _login_input_from_request(
                request,
                username=account.username,
                password="",
                remember_me=body.remember_me,
            ),
            device_id=device.device_id,
        )
    except (login_svc.LoginError, trusted_devices_svc.TrustedDeviceError) as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    payload = _login_response(out, request=request, response=response)
    payload["user"].update({
        "node_count": 0,
        "completed_tasks": 0,
        "total_earnings": 0.0,
    })
    return _deliver_device_credential(
        payload,
        request=request,
        response=response,
        credential=device.credential,
    )


# ── 手机号注册 / 登录（短信验证码） ──────────────────────────────
#
# 三条规矩（见 docs/dev-plan/账号体系-手机号注册登录设计-20260920.md）：
#   1. 登录返回体复用 `_login_response()` —— 手机号登录的用户同样要有
#      设备信任记录、同样出现在会话列表里、同样能被撤销；
#   2. 验证码先核销再动账号 —— 核销失败不产生任何账号副作用；
#   3. 手机号注册的账号**不需要口令**：口令用随机值占位，用户以后可以自己设。


class SmsSendRequest(BaseModel):
    """发送验证码。`purpose` 决定文案与用途，默认按登录。"""

    phone: str = Field(min_length=6, max_length=20)
    purpose: str = Field(default="login", pattern="^(register|login|bind|reset)$")


class PhoneLoginRequest(BaseModel):
    """手机号 + 验证码登录。"""

    phone: str = Field(min_length=6, max_length=20)
    code: str = Field(min_length=4, max_length=8)
    remember_me: bool = False


class PhoneRegisterRequest(BaseModel):
    """手机号 + 验证码注册。`username` 不传就自动生成一个不冲突的。"""

    phone: str = Field(min_length=6, max_length=20)
    code: str = Field(min_length=4, max_length=8)
    username: str | None = Field(default=None, max_length=64)
    remember_me: bool = False


def _sms_error(exc: Exception) -> HTTPException:
    """把短信服务的异常翻译成 HTTP。**不把内部细节原样吐给用户。**"""
    if isinstance(exc, sms_svc.PhoneError):
        return HTTPException(status_code=400, detail=str(exc))
    if isinstance(exc, sms_svc.SmsLimitError):
        retry_after = getattr(exc, "retry_after_seconds", None)
        return HTTPException(
            status_code=429, detail=str(exc),
            headers={"Retry-After": str(retry_after)} if retry_after else None,
        )
    if isinstance(exc, sms_svc.CodeRejected):
        return HTTPException(status_code=401, detail=str(exc))
    if isinstance(exc, sms_svc.SmsConfigError):
        # 配置缺失是**我们**的问题，不是用户的；但对用户也不能装作成功。
        logger.error("auth.sms · 配置缺失：%s", exc)
        return HTTPException(status_code=503, detail="短信通道暂时不可用，请稍后再试")
    if isinstance(exc, sms_svc.SmsSendError):
        return HTTPException(status_code=502, detail=str(exc))
    raise exc


def _complete_phone_login(
    *, session: Session, account, request: Request, response: Response, remember_me: bool
) -> dict:
    """手机号登录/注册共用的收尾，遵守现有账号的 TOTP 策略。"""
    response.headers["Cache-Control"] = "no-store"
    login_input = _login_input_from_request(
        request, username=account.username, password="", remember_me=remember_me,
    )
    try:
        secret_enc, enabled_at = AccountRepo.get_totp_state(session, account.id)
        if secret_enc and enabled_at:
            preparation = trusted_devices_svc.prepare_for_login(
                session,
                account_id=account.id,
                credential=_incoming_device_credential(request),
                metadata=_device_metadata(request),
            )
            if trusted_devices_svc.is_trusted(preparation.device):
                device = trusted_devices_svc.finalize_prepared(
                    session, account_id=account.id, preparation=preparation,
                )
                trusted_devices_svc.mark_trusted_login(
                    session, device_id=device.device_id, account_id=account.id,
                )
                out = login_svc.complete_login(
                    session, account, login_input, device_id=device.device_id,
                    trusted_device=True,
                )
                return _deliver_device_credential(
                    _login_response(out, request=request, response=response),
                    request=request, response=response, credential=device.credential,
                )
            challenge_token = totp_svc.create_login_challenge(
                session,
                account_id=account.id,
                device_id=preparation.device_id,
                pending_credential_hash=(
                    None if preparation.device_id else preparation.credential_hash
                ),
                device_metadata=preparation.metadata,
                remember_me=remember_me,
            )
            AuditRepo.write(
                session,
                action="auth.login_2fa_challenge", actor_account_id=account.id,
                actor_kind="user", trace_id=login_input.trace_id, ip=login_input.ip,
                user_agent=login_input.user_agent,
                detail={"method": "totp", "first_factor": "sms"},
            )
            return _deliver_device_credential(
                {
                    "ok": True,
                    "two_factor_required": True,
                    "challenge_token": challenge_token,
                    "challenge_expires_in": totp_svc.LOGIN_CHALLENGE_TTL_SECONDS,
                    "account_id": account.id,
                    "available_methods": [{
                        "method": "totp", "display_name": "身份验证器应用",
                        "description": "输入身份验证器应用中显示的 6 位动态码",
                    }],
                    "default_method": "totp",
                },
                request=request, response=response,
                credential=preparation.credential,
            )
        device = trusted_devices_svc.resolve_or_register(
            session,
            account_id=account.id,
            credential=_incoming_device_credential(request),
            metadata=_device_metadata(request),
        )
        out = login_svc.complete_login(
            session,
            account,
            login_input,
            device_id=device.device_id,
        )
    except (login_svc.LoginError, trusted_devices_svc.TrustedDeviceError,
            totp_svc.TotpError) as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    payload = _login_response(out, request=request, response=response)
    return _deliver_device_credential(
        payload,
        request=request,
        response=response,
        credential=device.credential,
    )


@router.post("/sms/send", summary="发送手机号验证码",
             dependencies=[Depends(rate_limit("auth_sms_send", per_minute=5, key="ip"))])
def sms_send_endpoint(
    body: SmsSendRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """发一条验证码短信。

    限流是**两层**：这里的 `rate_limit` 按 IP 挡分布式前的基本面，
    `services/sms` 里还有按手机号和全站日量的闸（见该模块的说明）。
    """
    try:
        result = sms_svc.issue_and_send(
            session,
            phone_raw=body.phone,
            purpose=body.purpose,
            request_ip=_client_ip(request),
        )
    except Exception as exc:  # noqa: BLE001 - 统一交给 _sms_error 分类
        raise _sms_error(exc)
    return {"ok": True, **result}


@router.post("/login/phone", summary="手机号 + 验证码登录",
             dependencies=[Depends(rate_limit("auth_login_phone", per_minute=10, key="ip"))])
def login_phone_endpoint(
    body: PhoneLoginRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    """已绑定手机号的用户，用验证码登录（不需要口令）。"""
    try:
        phone = sms_svc.verify_code(
            session, phone_raw=body.phone, purpose="login", code=body.code
        )
    except Exception as exc:  # noqa: BLE001
        raise _sms_error(exc)

    account = AccountRepo.by_phone(session, phone)
    if account is None:
        raise HTTPException(status_code=404, detail="这个手机号还没有注册，请先注册")
    if not account.is_active:
        raise HTTPException(status_code=403, detail="这个账号已被停用，请联系客服")
    return _complete_phone_login(
        session=session, account=account, request=request,
        response=response, remember_me=body.remember_me,
    )


@router.post("/register/phone", summary="手机号 + 验证码注册（注册即登录）",
             dependencies=[Depends(rate_limit("auth_register_phone", per_minute=5, key="ip"))])
def register_phone_endpoint(
    body: PhoneRegisterRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    """手机号注册。**验证码先核销，再建账号** —— 顺序反了会留下"注册了但没绑定"的残号。"""
    try:
        phone = sms_svc.verify_code(
            session, phone_raw=body.phone, purpose="register", code=body.code
        )
    except Exception as exc:  # noqa: BLE001
        raise _sms_error(exc)

    if AccountRepo.exists_phone(session, phone):
        raise HTTPException(status_code=409, detail="这个手机号已经注册过了，直接用验证码登录")

    username = (body.username or "").strip()
    if username and AccountRepo.exists_username(session, username):
        raise HTTPException(status_code=409, detail="这个用户名已经被占用了")
    if not username:
        # 不拿手机号当用户名：用户名在界面上是可见的，把号码摊出去没有必要。
        for _ in range(5):
            candidate = "qs" + secrets.token_hex(3)
            if not AccountRepo.exists_username(session, candidate):
                username = candidate
                break
        if not username:
            raise HTTPException(status_code=503, detail="用户名生成失败，请重试")

    try:
        account = register_svc.register(
            session,
            register_svc.RegisterInput(
                username=username,
                # 手机号登录不需要口令；占位随机口令保证"永远猜不到"，
                # 用户以后可以走 /me 改成自己的。
                password=secrets.token_urlsafe(24),
                email=None,
                trace_id=getattr(request.state, "trace_id", None),
                ip=_client_ip(request),
                user_agent=request.headers.get("User-Agent"),
            ),
        )
    except register_svc.RegistrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    AccountRepo.set_phone(session, account.id, phone)
    session.flush()
    account = AccountRepo.by_id(session, account.id)
    if account is None:
        raise HTTPException(status_code=503, detail="账号创建后读取失败，请重试")

    AuditRepo.write(
        session,
        action=AuditAction.REGISTER,
        actor_account_id=account.id,
        actor_kind="user",
        target_kind="account",
        target_id=str(account.id),
        trace_id=getattr(request.state, "trace_id", None),
        ip=_client_ip(request),
        user_agent=request.headers.get("User-Agent"),
        detail={"channel": "phone", "phone": phone[:3] + "****" + phone[-4:]},
    )
    return _complete_phone_login(
        session=session, account=account, request=request,
        response=response, remember_me=body.remember_me,
    )


# ── POST /login ─────────────────────────────────────
def _login_response(
    out: login_svc.LoginOutput,
    *,
    request: Request,
    response: Response,
) -> dict:
    account = AccountOut.model_validate(out.account)
    payload = {
        "ok": True,
        "tokens": {
            "access_token": out.tokens.access_token,
            "refresh_token": out.tokens.refresh_token,
            "token_type": "Bearer",
            "expires_in": out.tokens.expires_in,
        },
        "account": account.model_dump(mode="json"),
        "access_token": out.tokens.access_token,
        "refresh_token": out.tokens.refresh_token,
        "agent_token": out.tokens.refresh_token,
        "token_type": "Bearer",
        "expires_in": out.tokens.expires_in,
        "agent_token_expires_in": 604800,
        "role": account.role,
        "user": {
            "id": account.id,
            "username": account.username,
            "email": account.email,
            "status": account.status,
            "balance": float(out.account.balance or 0),
        },
    }
    return _deliver_refresh_token(
        payload,
        out,
        request=request,
        response=response,
    )


# 2026-05-25 P3 · dependencies 式 rate_limit · 10 次/分钟/IP 防暴力破解
@router.post("/login", summary="登录 (用户名或邮箱 + 密码)",
             dependencies=[Depends(rate_limit("auth_login", per_minute=10, key="ip"))])
def login_endpoint(
    body: LoginRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    response.headers["Cache-Control"] = "no-store"
    login_input = _login_input_from_request(
        request,
        username=body.username,
        password=body.password,
        remember_me=body.remember_me,
    )
    try:
        account = login_svc.authenticate(session, login_input)
    except login_svc.LoginError as exc:
        raise HTTPException(status_code=401, detail=str(exc))

    try:
        device_preparation = trusted_devices_svc.prepare_for_login(
            session,
            account_id=account.id,
            credential=_incoming_device_credential(request),
            metadata=_device_metadata(request),
        )
    except trusted_devices_svc.TrustedDeviceError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    secret_enc, enabled_at = AccountRepo.get_totp_state(session, account.id)
    if secret_enc and enabled_at:
        if trusted_devices_svc.is_trusted(device_preparation.device):
            device_resolution = trusted_devices_svc.finalize_prepared(
                session,
                account_id=account.id,
                preparation=device_preparation,
            )
            trusted_devices_svc.mark_trusted_login(
                session,
                device_id=device_resolution.device_id,
                account_id=account.id,
            )
            payload = _login_response(
                login_svc.complete_login(
                    session,
                    account,
                    login_input,
                    device_id=device_resolution.device_id,
                    trusted_device=True,
                ),
                request=request,
                response=response,
            )
            return _deliver_device_credential(
                payload,
                request=request,
                response=response,
                credential=device_resolution.credential,
            )
        try:
            challenge_token = totp_svc.create_login_challenge(
                session,
                account_id=account.id,
                device_id=device_preparation.device_id,
                pending_credential_hash=(
                    None
                    if device_preparation.device_id
                    else device_preparation.credential_hash
                ),
                device_metadata=device_preparation.metadata,
                remember_me=body.remember_me,
            )
        except totp_svc.TotpError as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        AuditRepo.write(
            session,
            action="auth.login_2fa_challenge",
            actor_account_id=account.id,
            actor_kind="user",
            trace_id=login_input.trace_id,
            ip=login_input.ip,
            user_agent=login_input.user_agent,
            detail={"method": "totp"},
        )
        payload = {
            "ok": True,
            "two_factor_required": True,
            "challenge_token": challenge_token,
            "challenge_expires_in": totp_svc.LOGIN_CHALLENGE_TTL_SECONDS,
            "account_id": account.id,
            "available_methods": [
                {
                    "method": "totp",
                    "display_name": "身份验证器应用",
                    "description": "输入身份验证器应用中显示的 6 位动态码",
                }
            ],
            "default_method": "totp",
        }
        return _deliver_device_credential(
            payload,
            request=request,
            response=response,
            credential=device_preparation.credential,
        )

    device_resolution = trusted_devices_svc.finalize_prepared(
        session,
        account_id=account.id,
        preparation=device_preparation,
    )
    payload = _login_response(
        login_svc.complete_login(
            session,
            account,
            login_input,
            device_id=device_resolution.device_id,
        ),
        request=request,
        response=response,
    )
    return _deliver_device_credential(
        payload,
        request=request,
        response=response,
        credential=device_resolution.credential,
    )


@router.post(
    "/login/totp",
    summary="完成登录两步验证",
    dependencies=[Depends(rate_limit("auth_login_totp", per_minute=10, key="ip"))],
)
def login_totp_endpoint(
    body: LoginTotpRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    response.headers["Cache-Control"] = "no-store"
    try:
        challenge = totp_svc.resolve_login_challenge_data(
            session,
            body.challenge_token,
        )
    except totp_svc.TotpError as exc:
        raise HTTPException(status_code=401, detail=str(exc))

    account = AccountRepo.by_id(session, challenge.account_id)
    if account is None or not account.is_active:
        raise HTTPException(status_code=401, detail="账号不可用")
    secret_enc, enabled_at = AccountRepo.get_totp_state(session, account.id)
    if not secret_enc or not enabled_at:
        raise HTTPException(status_code=409, detail="两步验证状态已改变，请重新登录")
    try:
        counter = totp_svc.counter_for_code(secret_enc, body.code)
    except totp_svc.TotpError as exc:
        raise HTTPException(status_code=401, detail=str(exc))
    if counter is None:
        login_svc.write_failed_audit(
            session,
            action="auth.login_2fa_fail",
            actor_account_id=account.id,
            actor_kind="user",
            trace_id=getattr(request.state, "trace_id", None),
            ip=_client_ip(request),
            user_agent=request.headers.get("User-Agent"),
            detail={"reason": "wrong_totp"},
        )
        raise HTTPException(status_code=401, detail="动态验证码不正确")

    credential = _incoming_device_credential(request)
    resolved_device = trusted_devices_svc.resolve_for_account(
        session,
        account_id=account.id,
        credential=credential,
    )
    device = None
    preparation = None
    if challenge.device_id:
        if (
            resolved_device is None
            or str(resolved_device["id"]) != challenge.device_id
        ):
            raise HTTPException(status_code=401, detail="登录设备验证失败，请重新登录")
        device = resolved_device
    elif challenge.pending_credential_hash:
        try:
            credential_hash = trusted_devices_svc.hash_credential(credential or "")
        except trusted_devices_svc.TrustedDeviceError:
            credential_hash = ""
        if credential_hash != challenge.pending_credential_hash:
            raise HTTPException(status_code=401, detail="登录设备验证失败，请重新登录")
        preparation = trusted_devices_svc.DevicePreparation(
            credential=str(credential),
            credential_hash=credential_hash,
            metadata=challenge.device_metadata,
        )
    if not AccountRepo.accept_totp_counter(session, account.id, counter):
        login_svc.write_failed_audit(
            session,
            action="auth.login_2fa_fail",
            actor_account_id=account.id,
            actor_kind="user",
            trace_id=getattr(request.state, "trace_id", None),
            ip=_client_ip(request),
            user_agent=request.headers.get("User-Agent"),
            detail={"reason": "totp_replay"},
        )
        raise HTTPException(status_code=401, detail="动态验证码已使用，请等待下一组验证码")
    try:
        totp_svc.consume_login_challenge(session, challenge.challenge_id)
    except totp_svc.TotpError as exc:
        raise HTTPException(status_code=401, detail=str(exc))
    if preparation is not None:
        resolution = trusted_devices_svc.finalize_prepared(
            session,
            account_id=account.id,
            preparation=preparation,
        )
        device = resolution.device
        challenge_device_id = resolution.device_id
        credential = resolution.credential
    else:
        challenge_device_id = challenge.device_id
    if body.trust_device:
        if not challenge_device_id:
            raise HTTPException(status_code=409, detail="当前登录不支持信任设备")
        try:
            device = trusted_devices_svc.activate_trust(
                session,
                device_id=challenge_device_id,
                account_id=account.id,
                duration="30d",
            )
        except trusted_devices_svc.TrustedDeviceError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    login_input = _login_input_from_request(
        request,
        username=account.username,
        password="",
        remember_me=(
            challenge.remember_me
            if body.remember_me is None
            else body.remember_me
        ),
    )
    payload = _login_response(
        login_svc.complete_login(
            session,
            account,
            login_input,
            two_factor=True,
            device_id=challenge_device_id,
        ),
        request=request,
        response=response,
    )
    return _deliver_device_credential(
        payload,
        request=request,
        response=response,
        credential=credential,
    )


# ── POST /refresh ───────────────────────────────────
@router.post("/refresh", response_model=RefreshResponse, summary="refresh token 续期")
def refresh_endpoint(
    request: Request,
    response: Response,
    body: RefreshRequest | None = None,
    session: Session = Depends(get_session),
):
    refresh_token = (
        body.refresh_token if body else None
    ) or request.cookies.get(REFRESH_COOKIE_NAME)
    if not refresh_token:
        raise HTTPException(status_code=401, detail="缺少 refresh token")
    try:
        out = login_svc.refresh(
            session,
            refresh_token,
            ip=_client_ip(request),
            user_agent=request.headers.get("User-Agent"),
        )
    except login_svc.LoginError as exc:
        raise HTTPException(status_code=401, detail=str(exc))
    if not _is_tauri(request):
        _deliver_refresh_token({}, out, request=request, response=response)
    # Always return refresh in body · web SPA (LAN 跨端口) 靠 localStorage 续期，
    # Cookie  alone 不可靠 (见 _deliver_refresh_token 注释)。
    return RefreshResponse(
        tokens=TokenPair(
            access_token=out.tokens.access_token,
            refresh_token=out.tokens.refresh_token,
            expires_in=out.tokens.expires_in,
        ),
    )


# ── GET /me (需鉴权) ────────────────────────────────
@router.get("/me", response_model=MeResponse, summary="当前登录用户信息")
def me_endpoint(current: Account = Depends(get_current_account)):
    return MeResponse(account=AccountOut.model_validate(current))


class TotpSetupRequest(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=128)


class TotpConfirmRequest(BaseModel):
    setup_token: str = Field(..., min_length=20, max_length=4096)
    code: str = Field(..., pattern=r"^\d{6}$")


class TotpDisableRequest(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=128)
    code: str = Field(..., pattern=r"^\d{6}$")


def _write_totp_audit(
    session: Session,
    request: Request,
    current: Account,
    action: str,
) -> None:
    AuditRepo.write(
        session,
        action=action,
        actor_account_id=current.id,
        actor_kind="user",
        target_kind="account",
        target_id=str(current.id),
        trace_id=getattr(request.state, "trace_id", None),
        ip=_client_ip(request),
        user_agent=request.headers.get("User-Agent"),
        detail={"method": "totp"},
    )


@router.get("/totp/status", summary="查询身份验证器状态")
def totp_status_endpoint(
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    secret_enc, enabled_at = AccountRepo.get_totp_state(session, current.id)
    return {
        "ok": True,
        "enabled": bool(secret_enc and enabled_at),
        "enabled_at": enabled_at.isoformat() if enabled_at else None,
    }


@router.post(
    "/totp/setup",
    summary="开始绑定身份验证器",
    dependencies=[Depends(rate_limit("auth_totp_setup", per_minute=5, key="ip"))],
)
def totp_setup_endpoint(
    body: TotpSetupRequest,
    request: Request,
    response: Response,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    if not pwd_svc.verify_password(body.current_password, current.password_hash):
        raise HTTPException(status_code=400, detail="当前密码错误")
    secret_enc, enabled_at = AccountRepo.get_totp_state(session, current.id)
    if secret_enc or enabled_at:
        raise HTTPException(status_code=409, detail="身份验证器已启用")
    try:
        setup = totp_svc.create_setup(
            account_id=current.id,
            account_name=current.email or current.username,
        )
    except totp_svc.TotpError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    _write_totp_audit(session, request, current, "auth.totp_setup")
    response.headers["Cache-Control"] = "no-store"
    return {
        "ok": True,
        "setup_token": setup.setup_token,
        "secret": setup.secret,
        "otpauth_uri": setup.otpauth_uri,
        "expires_in": setup.expires_in,
    }


@router.post(
    "/totp/confirm",
    summary="确认绑定身份验证器",
    dependencies=[Depends(rate_limit("auth_totp_confirm", per_minute=10, key="ip"))],
)
def totp_confirm_endpoint(
    body: TotpConfirmRequest,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    secret_enc, enabled_at = AccountRepo.get_totp_state(session, current.id)
    if secret_enc or enabled_at:
        raise HTTPException(status_code=409, detail="身份验证器已启用")
    try:
        encrypted_secret = totp_svc.confirm_setup(
            account_id=current.id,
            setup_token=body.setup_token,
            code=body.code,
        )
    except totp_svc.TotpError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    enabled_at = AccountRepo.enable_totp(session, current.id, encrypted_secret)
    counter = totp_svc.counter_for_code(encrypted_secret, body.code)
    if counter is None or not AccountRepo.accept_totp_counter(
        session,
        current.id,
        counter,
    ):
        raise HTTPException(status_code=400, detail="动态验证码已使用")
    trusted_devices_svc.revoke_all(session, account_id=current.id)
    AuthSessionRepo.revoke_all(session, current.id)
    _write_totp_audit(session, request, current, "auth.totp_enabled")
    return {
        "ok": True,
        "enabled": True,
        "enabled_at": enabled_at.isoformat(),
        "reauthentication_required": True,
        "message": "身份验证器已启用，请重新登录",
    }


@router.post(
    "/totp/disable",
    summary="解除绑定身份验证器",
    dependencies=[Depends(rate_limit("auth_totp_disable", per_minute=5, key="ip"))],
)
def totp_disable_endpoint(
    body: TotpDisableRequest,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    if not pwd_svc.verify_password(body.current_password, current.password_hash):
        raise HTTPException(status_code=400, detail="当前密码错误")
    secret_enc, enabled_at = AccountRepo.get_totp_state(session, current.id)
    if not secret_enc or not enabled_at:
        raise HTTPException(status_code=409, detail="身份验证器尚未启用")
    try:
        counter = totp_svc.counter_for_code(secret_enc, body.code)
    except totp_svc.TotpError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if counter is None:
        raise HTTPException(status_code=400, detail="动态验证码不正确")
    if not AccountRepo.accept_totp_counter(session, current.id, counter):
        raise HTTPException(status_code=400, detail="动态验证码已使用")
    if not AccountRepo.disable_totp(session, current.id):
        raise HTTPException(status_code=500, detail="解除绑定失败")
    trusted_devices_svc.revoke_all(session, account_id=current.id)
    AuthSessionRepo.revoke_all(session, current.id)
    _write_totp_audit(session, request, current, "auth.totp_disabled")
    return {
        "ok": True,
        "enabled": False,
        "enabled_at": None,
        "reauthentication_required": True,
        "message": "身份验证器已停用，请重新登录",
    }


# ════════════════════════════════════════════════════════════════════
# 补 audit 报告中标记的 P0/P1 缺失 endpoint (2026-05-19)
# ════════════════════════════════════════════════════════════════════


# ── POST /logout (P0) ───────────────────────────────
@router.post("/logout", summary="退出登录（写审计 + 通知客户端清 token）")
def logout_endpoint(
    request: Request,
    response: Response,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    """v8 当前 JWT 是无状态的，logout 主要做：
       1) 写一条 AUDIT 留痕（哪个 IP / UA / 何时退出）
       2) 返回 200，前端据此清本地 token
    后续可扩展：把 jti 加入 we_revoked_jti 黑名单（需新增表）。
    """
    try:
        AuditRepo.write(
            session,
            action=getattr(AuditAction, "LOGOUT", "auth.logout"),
            actor_account_id=current.id,
            actor_kind="user",
            trace_id=getattr(request.state, "trace_id", None),
            ip=_client_ip(request),
            user_agent=request.headers.get("User-Agent"),
            detail={"username": current.username},
        )
    except Exception as exc:
        logger.warning("logout audit 写入失败（不影响 logout 流程）: %s", exc)
    # 2026-06-04 · jti 吊销:把当前 access token 的 jti 写黑名单(TTL=剩余有效期)
    # 堵"登出后 token 仍有效"。失败不影响 logout。
    try:
        import time as _time
        jti = getattr(request.state, "token_jti", "")
        exp = int(getattr(request.state, "token_exp", 0) or 0)
        if jti and exp > 0:
            from platform_v8.services.auth import revocation
            revocation.revoke_jti(jti, max(1, exp - int(_time.time())))
    except Exception as exc:
        logger.warning("logout 吊销 jti 失败（不影响 logout 流程）: %s", exc)
    session_id = getattr(request.state, "session_id", "")
    if session_id:
        AuthSessionRepo.revoke(session, session_id, current.id)
    response.delete_cookie(REFRESH_COOKIE_NAME, path="/api/v8/auth")
    return {"ok": True, "message": "已退出登录"}


@router.get("/sessions", summary="查看历史登录设备")
def list_sessions_endpoint(
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    current_session_id = getattr(request.state, "session_id", "")
    # 按设备指纹合并并删除重复历史，避免同机反复登录刷出上百条
    try:
        auth_sessions_svc.purge_duplicate_login_history(
            session,
            account_id=current.id,
            keep_session_id=current_session_id or None,
        )
        session.commit()
    except Exception as exc:
        logger.warning("login device history cleanup failed: %s", exc)
        session.rollback()

    rows = AuthSessionRepo.list_for_account(session, current.id)
    device_ids = [str(row["device_id"]) for row in rows if row.get("device_id")]
    devices = TrustedDeviceRepo.by_ids_for_account(
        session,
        device_ids,
        current.id,
    )
    secret_enc, enabled_at = AccountRepo.get_totp_state(session, current.id)
    totp_enabled = bool(secret_enc and enabled_at)
    sessions = []
    for row in rows:
        device_id = str(row["device_id"]) if row.get("device_id") else None
        device = devices.get(device_id) if device_id else None
        trust = trusted_devices_svc.public_trust_fields(device)
        status_value = "active"
        if row["revoked_at"]:
            status_value = "revoked"
        else:
            refresh_expiry = row.get("refresh_expires_at")
            expiry_now = (
                datetime.now(tz=refresh_expiry.tzinfo)
                if refresh_expiry and refresh_expiry.tzinfo
                else datetime.utcnow()
            )
        if (
            not row["revoked_at"]
            and (
                not row.get("refresh_expires_at")
                or row["refresh_expires_at"] <= expiry_now
            )
        ):
            status_value = "expired"
        described = auth_sessions_svc.describe_user_agent(row.get("user_agent"))
        # 历史行可能把原生客户端写成「未知设备」；有 UA 时按最新规则重算展示文案。
        if not (row.get("user_agent") or "").strip():
            described = {
                "device_name": row["device_name"],
                "device_type": row["device_type"],
                "browser": row["browser"],
                "os": row["os"],
            }
        sessions.append({
            "session_id": row["id"],
            "device_id": device_id,
            "device_name": described["device_name"],
            "device_type": described["device_type"],
            "browser": described["browser"],
            "os": described["os"],
            "user_agent": row["user_agent"],
            "client_ip": row["client_ip"],
            "created_at": row["created_at"].isoformat(),
            "last_seen_at": row["last_seen_at"].isoformat(),
            "revoked_at": row["revoked_at"].isoformat() if row["revoked_at"] else None,
            "status": status_value,
            "is_current": row["id"] == current_session_id,
            "trust_eligible": bool(
                totp_enabled and device is not None and row["revoked_at"] is None
            ),
            "is_trusted": trust["is_trusted"],
            "trusted_at": (
                trust["trusted_at"].isoformat() if trust["trusted_at"] else None
            ),
            "trusted_until": (
                trust["trusted_until"].isoformat() if trust["trusted_until"] else None
            ),
            "trust_permanent": trust["trust_permanent"],
        })
    return {
        "ok": True,
        "sessions": sessions,
    }


@router.put(
    "/sessions/{session_id}/trust",
    summary="为登录设备启用可信登录",
    dependencies=[Depends(rate_limit("auth_session_trust", per_minute=5, key="uid"))],
)
def trust_session_endpoint(
    session_id: str,
    body: SessionTrustRequest,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    auth_session = AuthSessionRepo.by_id_for_account(session, session_id, current.id)
    if auth_session is None or auth_session["revoked_at"] is not None:
        raise HTTPException(status_code=404, detail="有效登录设备不存在")
    device_id = auth_session.get("device_id")
    if not device_id:
        raise HTTPException(status_code=409, detail="该登录会话不支持可信设备")
    if not pwd_svc.verify_password(body.current_password, current.password_hash):
        raise HTTPException(status_code=400, detail="当前密码错误")
    secret_enc, enabled_at = AccountRepo.get_totp_state(session, current.id)
    if not secret_enc or not enabled_at:
        raise HTTPException(status_code=409, detail="请先启用身份验证器")
    try:
        counter = totp_svc.counter_for_code(secret_enc, body.code)
    except totp_svc.TotpError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if counter is None:
        raise HTTPException(status_code=400, detail="动态验证码不正确")
    if not AccountRepo.accept_totp_counter(session, current.id, counter):
        raise HTTPException(status_code=400, detail="动态验证码已使用")
    try:
        device = trusted_devices_svc.activate_trust(
            session,
            device_id=str(device_id),
            account_id=current.id,
            duration=body.duration,
        )
    except trusted_devices_svc.TrustedDeviceError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    AuditRepo.write(
        session,
        action="auth.device_trusted",
        actor_account_id=current.id,
        actor_kind="user",
        target_kind="auth_device",
        target_id=str(device_id),
        trace_id=getattr(request.state, "trace_id", None),
        ip=_client_ip(request),
        user_agent=request.headers.get("User-Agent"),
        detail={"duration": body.duration, "session_id": session_id},
    )
    trust = trusted_devices_svc.public_trust_fields(device)
    return {
        "ok": True,
        "session_id": session_id,
        "device_id": str(device_id),
        "duration": body.duration,
        "is_trusted": trust["is_trusted"],
        "trusted_at": trust["trusted_at"].isoformat(),
        "trusted_until": (
            trust["trusted_until"].isoformat() if trust["trusted_until"] else None
        ),
        "trust_permanent": trust["trust_permanent"],
    }


@router.delete(
    "/sessions/{session_id}/trust",
    summary="撤销登录设备可信状态",
    dependencies=[Depends(rate_limit("auth_session_untrust", per_minute=20, key="uid"))],
)
def untrust_session_endpoint(
    session_id: str,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    auth_session = AuthSessionRepo.by_id_for_account(session, session_id, current.id)
    if auth_session is None:
        raise HTTPException(status_code=404, detail="登录设备不存在")
    device_id = auth_session.get("device_id")
    if not device_id:
        raise HTTPException(status_code=409, detail="该登录会话不支持可信设备")
    device = trusted_devices_svc.by_id_for_account(
        session,
        device_id=str(device_id),
        account_id=current.id,
    )
    if device is None:
        raise HTTPException(status_code=404, detail="登录设备不存在")
    trusted_devices_svc.revoke(
        session,
        device_id=str(device_id),
        account_id=current.id,
    )
    AuditRepo.write(
        session,
        action="auth.device_trust_revoked",
        actor_account_id=current.id,
        actor_kind="user",
        target_kind="auth_device",
        target_id=str(device_id),
        trace_id=getattr(request.state, "trace_id", None),
        ip=_client_ip(request),
        user_agent=request.headers.get("User-Agent"),
        detail={"session_id": session_id},
    )
    return {
        "ok": True,
        "session_id": session_id,
        "device_id": str(device_id),
        "is_trusted": False,
    }


@router.delete(
    "/sessions/{session_id}",
    summary="远程退出指定登录设备",
    dependencies=[Depends(rate_limit("auth_session_revoke", per_minute=20, key="ip"))],
)
def revoke_session_endpoint(
    session_id: str,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    if session_id == getattr(request.state, "session_id", ""):
        raise HTTPException(status_code=400, detail="当前设备请使用退出登录")
    auth_session = AuthSessionRepo.by_id_for_account(session, session_id, current.id)
    if not AuthSessionRepo.revoke(session, session_id, current.id):
        raise HTTPException(status_code=404, detail="登录设备不存在或已退出")
    if auth_session and auth_session.get("device_id"):
        trusted_devices_svc.revoke(
            session,
            device_id=str(auth_session["device_id"]),
            account_id=current.id,
        )
    AuditRepo.write(
        session,
        action="auth.session_revoked",
        actor_account_id=current.id,
        actor_kind="user",
        target_kind="auth_session",
        target_id=session_id,
        trace_id=getattr(request.state, "trace_id", None),
        ip=_client_ip(request),
        user_agent=request.headers.get("User-Agent"),
        detail={"scope": "single"},
    )
    return {"ok": True, "message": "该设备已退出登录"}


@router.delete(
    "/sessions",
    summary="退出当前设备以外的所有登录设备",
    dependencies=[Depends(rate_limit("auth_sessions_revoke_others", per_minute=5, key="ip"))],
)
def revoke_other_sessions_endpoint(
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    current_session_id = getattr(request.state, "session_id", "")
    current_session = AuthSessionRepo.by_id_for_account(
        session,
        current_session_id,
        current.id,
    ) if current_session_id else None
    current_device_id = (
        str(current_session["device_id"])
        if current_session and current_session.get("device_id")
        else None
    )
    device_ids = AuthSessionRepo.active_device_ids_for_others(
        session,
        current.id,
        current_session_id or None,
        exclude_device_id=current_device_id,
    )
    revoked_count = AuthSessionRepo.revoke_others(
        session,
        current.id,
        current_session_id or None,
    )
    trusted_devices_svc.revoke_many(
        session,
        device_ids=device_ids,
        account_id=current.id,
    )
    AuditRepo.write(
        session,
        action="auth.sessions_revoked",
        actor_account_id=current.id,
        actor_kind="user",
        trace_id=getattr(request.state, "trace_id", None),
        ip=_client_ip(request),
        user_agent=request.headers.get("User-Agent"),
        detail={"scope": "others", "revoked_count": revoked_count},
    )
    return {"ok": True, "revoked_count": revoked_count, "message": "其他设备已退出登录"}


# ── PUT /me (P1) ────────────────────────────────────
class UpdateMeRequest(BaseModel):
    """修改账号自身信息。所有字段可选，按提交字段更新。"""
    password: str | None = Field(default=None, min_length=6, max_length=64,
                                  description="新密码（≥6位）")
    old_password: str | None = Field(default=None, description="旧密码（修改密码时必填）")
    # 暂不开放修改 username / email（涉及唯一性校验 + 邮件验证）
    # 留接口供后续 P2 启用：
    # username: str | None = None
    # email: str | None = None


@router.put("/me", summary="修改自己的账号信息（当前仅支持改密码）")
def update_me_endpoint(
    body: UpdateMeRequest,
    request: Request,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    changes: dict = {}

    if body.password is not None:
        # 改密码必须提供旧密码作二次确认
        if not body.old_password:
            raise HTTPException(400, "改密码需提供 old_password")
        if not pwd_svc.verify_password(body.old_password, current.password_hash):
            raise HTTPException(400, "旧密码错误")
        new_hash = pwd_svc.hash_password(body.password)
        ok = AccountRepo.update_password(session, current.id, new_hash)
        if not ok:
            raise HTTPException(500, "密码更新失败")
        trusted_devices_svc.revoke_all(session, account_id=current.id)
        AuthSessionRepo.revoke_all(session, current.id)
        changes["password"] = "changed"

    if not changes:
        raise HTTPException(400, "未提交任何可更新字段")

    # 写审计
    try:
        AuditRepo.write(
            session,
            action=getattr(AuditAction, "UPDATE_ACCOUNT", "auth.update_account"),
            actor_account_id=current.id,
            actor_kind="user",
            trace_id=getattr(request.state, "trace_id", None),
            ip=_client_ip(request),
            user_agent=request.headers.get("User-Agent"),
            detail={"changes": list(changes.keys())},
        )
    except Exception as exc:
        logger.warning("update_me audit 写入失败: %s", exc)

    return {
        "ok": True,
        "updated": list(changes.keys()),
        "reauthentication_required": "password" in changes,
        "message": (
            "密码已更新，请重新登录"
            if "password" in changes
            else "账号信息已更新"
        ),
    }


# ── GET /security-logs (P1) ─────────────────────────
@router.get("/security-logs", summary="当前账号的安全审计日志")
def security_logs_endpoint(
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
    limit: int = 50,
):
    """从 we_audit 表拉当前账号的最近 N 条安全相关 action（登录/登出/改密码/失败尝试 等）。"""
    from sqlalchemy import select, or_
    from platform_v8.storage.repo import audit_t

    limit = max(1, min(limit, 200))
    # 只暴露安全相关的 action（不展示 worker.* 等业务事件）
    security_actions_prefix = ("auth.", "user.")
    stmt = (
        select(audit_t)
        .where(audit_t.c.actor_account_id == int(current.id))
        .order_by(audit_t.c.created_at.desc())
        .limit(limit * 3)  # 多拉一些后过滤
    )
    rows = session.execute(stmt).all()
    logs: list[dict] = []
    for row in rows:
        d = dict(row._mapping)
        action = str(d.get("action", ""))
        # 按前缀过滤，或者保留特定 action
        if not any(action.startswith(p) for p in security_actions_prefix) and action not in (
            "LOGIN", "LOGOUT", "REGISTER", "UPDATE_ACCOUNT"
        ):
            continue
        logs.append({
            "id": str(d.get("id")),
            "action": action,
            "ip": d.get("ip"),
            "user_agent": d.get("user_agent"),
            "detail": d.get("detail") or {},
            "created_at": d.get("created_at").isoformat() if d.get("created_at") else None,
        })
        if len(logs) >= limit:
            break
    return {"ok": True, "logs": logs, "total": len(logs)}
