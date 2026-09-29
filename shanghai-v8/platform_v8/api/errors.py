"""统一错误码 · 9 个标准码 + 业务码

跟前端 frontend/shared/utils/error.ts 1:1 对齐。
任何 raise HTTPException · 任何 return {"ok": False, "code": ...} → 必须用这里的常量。
禁止散写 "http_404" / "not_found" / "bad_auth" 字面量。
"""
from __future__ import annotations
from enum import Enum


class ErrorCode(str, Enum):
    # ─── 认证 ─────────────────────────────────────────
    AUTH_TOKEN_EXPIRED = "AUTH_TOKEN_EXPIRED"
    AUTH_TOKEN_INVALID = "AUTH_TOKEN_INVALID"
    AUTH_LOGIN_FAILED = "AUTH_LOGIN_FAILED"
    AUTH_PERMISSION_DENIED = "AUTH_PERMISSION_DENIED"

    # ─── 资源 ─────────────────────────────────────────
    RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND"
    RESOURCE_CONFLICT = "RESOURCE_CONFLICT"

    # ─── 校验 / 限流 ──────────────────────────────────
    VALIDATION_ERROR = "VALIDATION_ERROR"
    RATE_LIMITED = "RATE_LIMITED"
    METHOD_NOT_ALLOWED = "METHOD_NOT_ALLOWED"
    UNSUPPORTED_MEDIA_TYPE = "UNSUPPORTED_MEDIA_TYPE"

    # ─── 业务 ─────────────────────────────────────────
    BALANCE_INSUFFICIENT = "BALANCE_INSUFFICIENT"
    GUARD_BLOCKED = "GUARD_BLOCKED"          # AI 工具守卫
    PROMPT_INJECTION = "PROMPT_INJECTION"    # AI 提示注入
    LLM_ERROR = "LLM_ERROR"                  # AI 推理异常

    # ─── 系统 ─────────────────────────────────────────
    INTERNAL_ERROR = "INTERNAL_ERROR"
    NETWORK_ERROR = "NETWORK_ERROR"


# HTTP status_code → 标准 ErrorCode 映射
_STATUS_TO_CODE: dict[int, ErrorCode] = {
    400: ErrorCode.VALIDATION_ERROR,
    401: ErrorCode.AUTH_TOKEN_INVALID,
    403: ErrorCode.AUTH_PERMISSION_DENIED,
    404: ErrorCode.RESOURCE_NOT_FOUND,
    405: ErrorCode.METHOD_NOT_ALLOWED,
    409: ErrorCode.RESOURCE_CONFLICT,
    415: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
    422: ErrorCode.VALIDATION_ERROR,
    429: ErrorCode.RATE_LIMITED,
    500: ErrorCode.INTERNAL_ERROR,
    502: ErrorCode.INTERNAL_ERROR,
    503: ErrorCode.INTERNAL_ERROR,
    504: ErrorCode.INTERNAL_ERROR,
}


def status_to_code(status: int) -> ErrorCode:
    """HTTP status_code → 标准 ErrorCode"""
    return _STATUS_TO_CODE.get(status, ErrorCode.INTERNAL_ERROR)
