"""Live, signed readiness gate for independent buyer activation.

An operator flag and a configured public key do not prove that the remote
challenge executor is working. This module never signs an activation receipt.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import threading
import time
from typing import Mapping
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

_REQUEST_SCHEMA = "qianshou.order-adapter-attestor-health-request.v1"
_RESPONSE_SCHEMA = "qianshou.order-adapter-attestor-health.v1"
_CHALLENGE_SCHEMA = "qianshou.order-adapter-remote-challenge.v1"
_INVENTORY_ALGORITHM = "qianshou.source-package.v1"
_CHECKS = frozenset({
    "pinned_archive_verified", "randomized_node_execution",
    "independent_result_verified", "online_node_bound",
    "receipt_signing_ready",
})
_KEY_ID = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
_B64 = re.compile(r"[A-Za-z0-9_-]+={0,2}\Z")
_cache_lock = threading.Lock()
_cached: tuple[str, float, bool] | None = None


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _decode(value: object, length: int) -> bytes:
    if not isinstance(value, str) or len(value) > 128 or not _B64.fullmatch(value):
        raise ValueError("invalid base64url")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if (len(decoded) != length or
            base64.urlsafe_b64encode(decoded).rstrip(b"=").decode() != value.rstrip("=")):
        raise ValueError("invalid base64url length")
    return decoded


def _config(roots: Mapping[str, Ed25519PublicKey]) -> tuple[str, str, str, str | bool] | None:
    url = os.getenv("V8_ORDER_ADAPTER_INSTALL_ATTESTOR_URL", "").rstrip("/")
    token = os.getenv("V8_ORDER_ADAPTER_INSTALL_ATTESTOR_TOKEN", "")
    key_id = os.getenv("V8_ORDER_ADAPTER_INSTALL_ATTESTOR_KEY_ID", "")
    public = os.getenv("V8_ORDER_ADAPTER_INSTALL_ATTESTOR_PUBLIC_KEY", "")
    ca = os.getenv("V8_ORDER_ADAPTER_INSTALL_ATTESTOR_CA_FILE", "")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return None
    if (not url or len(url) > 2048 or parsed.scheme != "https" or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or (port not in (None, 443) and os.getenv("V8_ENV") != "staging")
            or not 32 <= len(token) <= 2048
            or not _KEY_ID.fullmatch(key_id) or key_id not in roots):
        return None
    # A configured CA is an operator-owned file, never supplied by a buyer.
    if ca and (not os.path.isfile(ca) or len(ca) > 4096):
        return None
    try:
        key_bytes = _decode(public, 32)
    except (ValueError, TypeError):
        return None
    if roots[key_id].public_bytes(Encoding.Raw, PublicFormat.Raw) != key_bytes:
        return None
    return url, token, key_id, ca or True


def _check(envelope: object, *, nonce: str, key_id: str,
           key: Ed25519PublicKey, now: int) -> bool:
    try:
        if (not isinstance(envelope, dict)
                or set(envelope) != {"key_id", "payload", "signature"}
                or envelope["key_id"] != key_id):
            return False
        payload = envelope["payload"]
        if (not isinstance(payload, dict) or set(payload) != {
                "schema", "nonce", "status", "inventory_algorithm",
                "challenge_schema", "receipt_schema", "checks",
                "issued_at", "expires_at"}):
            return False
        key.verify(_decode(envelope["signature"], 64), _canonical(payload))
        return (payload["schema"] == _RESPONSE_SCHEMA
                and payload["nonce"] == nonce and payload["status"] == "ready"
                and payload["inventory_algorithm"] == _INVENTORY_ALGORITHM
                and payload["challenge_schema"] == _CHALLENGE_SCHEMA
                and payload["receipt_schema"] == _CHALLENGE_SCHEMA
                and isinstance(payload["checks"], dict)
                and set(payload["checks"]) == _CHECKS
                and all(value is True for value in payload["checks"].values())
                and type(payload["issued_at"]) is int
                and type(payload["expires_at"]) is int
                and now - 30 <= payload["issued_at"] <= now + 10
                and now < payload["expires_at"] <= payload["issued_at"] + 60)
    except (InvalidSignature, ValueError, TypeError, KeyError):
        return False


def _live(config: tuple[str, str, str, str | bool],
          roots: Mapping[str, Ed25519PublicKey]) -> bool:
    url, token, key_id, ca = config
    nonce = str(uuid4())
    try:
        response = httpx.post(
            url + "/health",
            json={"schema": _REQUEST_SCHEMA, "nonce": nonce},
            headers={"Authorization": "Bearer " + token},
            # The signed health answer runs a real locked COS read, sandbox
            # isolation probe and Shanghai witness challenge. A 2-second
            # deadline rejects a healthy independent service in production.
            timeout=httpx.Timeout(15.0, connect=3.0), verify=ca,
            follow_redirects=False, trust_env=False)
        if response.status_code != 200 or len(response.content) > 8192:
            return False
        return _check(response.json(), nonce=nonce, key_id=key_id,
                      key=roots[key_id], now=int(time.time()))
    except (httpx.HTTPError, ValueError, TypeError, KeyError):
        return False


def attestor_ready(roots: Mapping[str, Ed25519PublicKey], *, fresh: bool = False) -> bool:
    """Use a brief display cache; debit always forces a fresh signed challenge."""
    global _cached
    config = _config(roots)
    if config is None:
        return False
    cache_key = hashlib.sha256(repr(config).encode("utf-8")).hexdigest()
    if not fresh:
        with _cache_lock:
            if _cached is not None and _cached[0] == cache_key and _cached[1] > time.monotonic():
                return _cached[2]
    ready = _live(config, roots)
    with _cache_lock:
        _cached = (cache_key, time.monotonic() + 5, ready)
    return ready
