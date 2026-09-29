"""Owner 删除节点后的墓碑 · 阻止同 worker_id 立刻重注册。

门户「删除设备」会删 we_workers 行；若客户端未注销仍拿旧 identity 重连，
会 upsert 出同 ID 新节点，看起来像「删不掉」。墓碑在 Redis 中保留一段时间，
注册时命中则 fatal 拒绝，驱动客户端 AUTH_FAILED → 注销登录。
"""
from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)

_KEY_PREFIX = "v8:worker:deleted:"
# 30 天：覆盖常见「客户端未退出又自动重连」窗口；过期后同 ID 可再注册
DEFAULT_TTL_S = 30 * 24 * 3600


def _redis():
    try:
        from platform_v8.engine import gateway as gateway_mod
        return gateway_mod._redis()  # noqa: SLF001 · 与 disabled 共用连接
    except Exception:
        return None


def mark_deleted(worker_id: str, *, owner_id: int, ttl_s: int = DEFAULT_TTL_S) -> None:
    wid = str(worker_id or "").strip()
    if not wid:
        return
    try:
        r = _redis()
        if r is None:
            return
        payload = f"{int(owner_id)}|{int(time.time())}"
        r.setex(f"{_KEY_PREFIX}{wid}", int(ttl_s), payload)
    except Exception as exc:
        logger.debug("worker_tombstone.mark fail wid=%s: %s", wid[:12], exc)


def is_deleted(worker_id: str) -> bool:
    wid = str(worker_id or "").strip()
    if not wid:
        return False
    try:
        r = _redis()
        if r is None:
            return False
        return bool(r.exists(f"{_KEY_PREFIX}{wid}"))
    except Exception as exc:
        logger.debug("worker_tombstone.check fail wid=%s: %s", wid[:12], exc)
        return False


def clear_deleted(worker_id: str) -> None:
    wid = str(worker_id or "").strip()
    if not wid:
        return
    try:
        r = _redis()
        if r is None:
            return
        r.delete(f"{_KEY_PREFIX}{wid}")
    except Exception as exc:
        logger.debug("worker_tombstone.clear fail wid=%s: %s", wid[:12], exc)
