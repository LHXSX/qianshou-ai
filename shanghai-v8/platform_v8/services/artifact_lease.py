"""artifact 上传租约 · HMAC 绑定 shard + worker + attempt

节点申请 result-upload-url / 回报 artifact 时必须带 lease_token。
token = HMAC-SHA256(secret, f"{shard_id}|{worker_id}|{attempt}|{exp}") · base64url
默认有效期与上传 URL 对齐 (15 分钟) · 可续签。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time
from typing import Final

# 上传 URL / lease 默认 15 分钟 (大文件可在 API 层按 size 略延长)
DEFAULT_LEASE_TTL_S: Final[int] = 15 * 60
MAX_LEASE_TTL_S: Final[int] = 65 * 60  # 覆盖 1h 执行上限 + 上传缓冲


def _secret() -> bytes:
    raw = (
        os.environ.get("V8_ARTIFACT_LEASE_SECRET")
        or os.environ.get("V8_JWT_SECRET")
        or ""
    ).strip()
    if not raw:
        # 本地/测试兜底 · 生产必须配 V8_JWT_SECRET
        raw = "dev-only-artifact-lease-secret"
    return raw.encode("utf-8")


def mint_lease_token(
    *,
    shard_id: str,
    worker_id: str,
    attempt: int = 0,
    ttl_s: int = DEFAULT_LEASE_TTL_S,
) -> str:
    """签发租约 token · 放入 ShardAssign.lease_token。"""
    ttl = max(60, min(int(ttl_s), MAX_LEASE_TTL_S))
    exp = int(time.time()) + ttl
    attempt = max(0, int(attempt))
    msg = f"{shard_id}|{worker_id}|{attempt}|{exp}".encode("utf-8")
    sig = hmac.new(_secret(), msg, hashlib.sha256).digest()
    payload = f"{exp}.{attempt}.".encode("utf-8") + sig
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def verify_lease_token(
    token: str,
    *,
    shard_id: str,
    worker_id: str,
    attempt: int = 0,
) -> bool:
    """校验租约 · 过期或签名不符返回 False。"""
    if not token or not shard_id or not worker_id:
        return False
    try:
        pad = "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode(token + pad)
    except Exception:
        return False
    parts = raw.split(b".", 2)
    if len(parts) != 3:
        return False
    exp_b, attempt_b, sig = parts
    try:
        exp = int(exp_b.decode("ascii"))
        token_attempt = int(attempt_b.decode("ascii"))
    except Exception:
        return False
    if exp < int(time.time()) or token_attempt != max(0, int(attempt)):
        return False
    msg = f"{shard_id}|{worker_id}|{token_attempt}|{exp}".encode("utf-8")
    expect = hmac.new(_secret(), msg, hashlib.sha256).digest()
    return hmac.compare_digest(sig, expect)


def lease_ttl_for_size(size_bytes: int) -> int:
    """按体积略延长租约 · 仍封顶 MAX_LEASE_TTL_S。"""
    # ~10 MB/s 保守估计 + 余量
    if size_bytes <= 0:
        return DEFAULT_LEASE_TTL_S
    need = int(size_bytes / (10 * 1024 * 1024)) + DEFAULT_LEASE_TTL_S
    return max(DEFAULT_LEASE_TTL_S, min(need, MAX_LEASE_TTL_S))
