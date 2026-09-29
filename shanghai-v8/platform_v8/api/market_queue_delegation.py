"""Verify Guangzhou's one-use delegation for three read-only market queues.

The caller still needs a valid Shanghai account JWT. This service assertion
only grants three exact review-queue GETs; review writes keep their existing
Shanghai admin dependency and independent evidence gates.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import time
from typing import Any

from fastapi import Depends, Header, HTTPException, Request

from platform_v8.api.deps import get_current_account
from platform_v8.core import Account
from platform_v8.services.auth import token as token_svc
from platform_v8.storage.kv import get_redis

logger = logging.getLogger(__name__)

_AUDIENCE = "shanghai.market.queue.v1"
_HEADER = re.compile(r"v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\Z")
_KEY_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z", re.I)
_B64 = re.compile(r"[A-Za-z0-9_-]+\Z")
_PENDING_PATHS = frozenset({
    "/api/v8/admin/task-adapter-publications/pending",
    "/api/v8/admin/order-adapter-products/pending",
})
_APP_REVIEW_PATH = "/api/v8/admin/marketplace/review"
_FIELDS = frozenset({"v", "kid", "aud", "sub", "access_token_sha256", "perm", "scope", "method", "path", "iat", "exp", "jti"})


def _deny(detail: str = "市场审核只读委托无效") -> None:
    raise HTTPException(status_code=403, detail=detail)


def _b64decode(value: str) -> bytes:
    if not _B64.fullmatch(value):
        raise ValueError("base64url characters")
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii") != value:
        raise ValueError("base64url canonical form")
    return raw


def _no_duplicate_fields(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate field")
        result[key] = value
    return result


def _keys() -> dict[str, bytes]:
    """Operator-owned trust map, separate from JWT and evidence-issuer keys."""
    raw = os.environ.get("V8_MARKET_QUEUE_DELEGATION_KEYS", "")
    if not raw or len(raw) > 8192:
        return {}
    try:
        parsed = json.loads(raw, object_pairs_hook=_no_duplicate_fields)
        if not isinstance(parsed, dict) or not 1 <= len(parsed) <= 8:
            return {}
        keys: dict[str, bytes] = {}
        for kid, encoded in parsed.items():
            if not isinstance(kid, str) or not _KEY_ID.fullmatch(kid) or not isinstance(encoded, str):
                return {}
            key = _b64decode(encoded)
            if not 32 <= len(key) <= 192 or key in keys.values():
                return {}
            keys[kid] = key
        return keys
    except (TypeError, ValueError, UnicodeError):
        return {}


def _consume_once(kid: str, jti: str, expires_at: int, now: int) -> None:
    """Require shared Redis; an unavailable replay store never grants access."""
    try:
        redis = get_redis()
        if redis is None:
            raise RuntimeError("replay store unavailable")
        replay_key = "v8:market:queue-delegation:" + hashlib.sha256(
            f"{kid}:{jti}".encode("ascii")).hexdigest()
        accepted = redis.set(replay_key, "1", nx=True, ex=max(1, expires_at - now + 6))
    except Exception as exc:
        logger.warning("market queue delegation replay store unavailable: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="市场审核委托防重放服务不可用") from exc
    if not accepted:
        _deny("市场审核只读委托已使用")


def _target(request: Request) -> str:
    path, query = request.url.path, request.url.query
    if request.method != "GET":
        _deny()
    if path in _PENDING_PATHS and not query:
        return path
    if path == _APP_REVIEW_PATH and re.fullmatch(r"limit=(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)", query):
        return f"{path}?{query}"
    _deny()


def get_market_queue_reader(
    request: Request,
    x_qianshou_market_delegation: str | None = Header(default=None),
    current: Account = Depends(get_current_account),
) -> Account:
    """Allow a Shanghai admin or one valid, purpose-bound Guangzhou read grant."""
    if current.is_admin:
        return current
    if (getattr(request.state, "auth_via", None) != "jwt"
            or not getattr(request.state, "token_jti", None)):
        _deny("市场审核只读委托需要有效的上海账号会话")
    target = _target(request)
    token = x_qianshou_market_delegation
    if not isinstance(token, str) or len(token) > 2048:
        _deny()
    match = _HEADER.fullmatch(token)
    if match is None:
        _deny()
    encoded_payload, encoded_signature = match.groups()
    try:
        payload_bytes = _b64decode(encoded_payload)
        signature = _b64decode(encoded_signature)
        payload = json.loads(payload_bytes.decode("utf-8"), object_pairs_hook=_no_duplicate_fields)
        if (not isinstance(payload, dict) or set(payload) != _FIELDS
                or len(payload_bytes) > 1024 or len(signature) != 32):
            raise ValueError("delegation structure")
        kid = payload["kid"]
        if not isinstance(kid, str) or not _KEY_ID.fullmatch(kid):
            raise ValueError("key id")
        key = _keys().get(kid)
        if key is None:
            raise ValueError("trust key unavailable")
        expected = hmac.new(key, f"v1.{encoded_payload}".encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("signature")
        raw_token = token_svc.extract_bearer(request.headers.get("authorization"))
        token_digest = payload["access_token_sha256"]
        if (not isinstance(token_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", token_digest)
                or not hmac.compare_digest(
                    token_digest, hashlib.sha256(raw_token.encode("utf-8")).hexdigest())):
            raise ValueError("account token mismatch")
        now = int(time.time())
        issued, expires = payload["iat"], payload["exp"]
        if (type(payload["v"]) is not int or payload["v"] != 1
                or payload["aud"] != _AUDIENCE
                or payload["sub"] != str(current.id)
                or payload["perm"] != "market.read" or payload["scope"] != "all"
                or payload["method"] != "GET" or payload["path"] != target
                or type(issued) is not int or type(expires) is not int
                or not 1 <= expires - issued <= 30 or not issued - 5 <= now <= expires
                or not isinstance(payload["jti"], str) or not _UUID.fullmatch(payload["jti"])):
            raise ValueError("grant mismatch or expiry")
        _consume_once(kid, payload["jti"], expires, now)
        logger.info("market queue delegated read account_id=%s path=%s kid=%s", current.id, target, kid)
        return current
    except (TypeError, ValueError, UnicodeError, OverflowError, token_svc.TokenError) as exc:
        logger.info("market queue delegation denied reason=%s", type(exc).__name__)
        _deny()
