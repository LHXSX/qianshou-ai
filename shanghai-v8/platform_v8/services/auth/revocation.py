"""JWT jti 吊销黑名单 (2026-06-04)

登出 / 重置令牌时把 token 的 jti 写 Redis 黑名单(TTL=token 剩余有效期),
deps.get_current_account 验签后查黑名单 → 命中即拒绝(401)。

铁律:
  - Redis 挂 / 异常 → fail-open(不拒绝 · 零回归 · 与现有鉴权 fallback 一致)。
  - 只对 v8 token(带 jti)生效;v1 fallback 无 jti · 自动跳过。
  - 不碰节点长连:节点不调 logout · 其 token jti 不会进黑名单 · 正常运行不受影响。
"""
from __future__ import annotations
import logging

logger = logging.getLogger(__name__)

_PREFIX = "revoked_jti:"


def revoke_jti(jti: str, ttl_s: int) -> None:
    """把 jti 加入黑名单 · TTL=token 剩余有效期(过期后 Redis 自动清 · 无需手动 GC)。"""
    if not jti or ttl_s <= 0:
        return
    try:
        from platform_v8.storage import kv
        kv.set_json(_PREFIX + jti, 1, ttl_s=int(ttl_s))
    except Exception as exc:
        logger.warning("revocation.revoke_jti fail jti=%s: %s", jti[:8], exc)


def is_jti_revoked(jti: str) -> bool:
    """该 jti 是否已被吊销。Redis 挂/异常 → False(fail-open · 不误拒)。"""
    if not jti:
        return False
    try:
        from platform_v8.storage import kv
        return kv.get_json(_PREFIX + jti) is not None
    except Exception:
        return False
