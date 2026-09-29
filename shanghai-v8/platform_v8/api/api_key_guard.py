"""API Key 请求入口保护：跨进程并发槽位，Redis 故障时进程内降级。"""
from __future__ import annotations

import hashlib
import os
import threading
import time
import uuid
from dataclasses import dataclass


_MAX_CONCURRENCY = max(
    1, int(os.environ.get("V8_API_KEY_MAX_CONCURRENCY", "8"))
)
_LEASE_TTL_S = max(
    30, int(os.environ.get("V8_API_KEY_CONCURRENCY_LEASE_S", "120"))
)
_local_lock = threading.Lock()
_local_leases: dict[str, dict[str, float]] = {}


@dataclass(frozen=True)
class ApiKeyLease:
    digest: str
    lease_id: str
    redis_backed: bool


def acquire(token: str) -> ApiKeyLease | None:
    """占用一个 API Key 并发槽；无槽位时返回 None。"""
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    lease_id = uuid.uuid4().hex
    redis_key = f"v8:auth:api-key-concurrency:{digest}"
    now = time.time()

    try:
        from platform_v8.storage.kv import get_redis

        redis = get_redis()
        if redis is not None:
            allowed = int(
                redis.eval(
                    """
                    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
                    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
                    local count = redis.call('ZCARD', KEYS[1])
                    redis.call('EXPIRE', KEYS[1], ARGV[4])
                    if count > tonumber(ARGV[5]) then
                        redis.call('ZREM', KEYS[1], ARGV[3])
                        return 0
                    end
                    return 1
                    """,
                    1,
                    redis_key,
                    now - _LEASE_TTL_S,
                    now,
                    lease_id,
                    _LEASE_TTL_S * 2,
                    _MAX_CONCURRENCY,
                )
            )
            if allowed:
                return ApiKeyLease(digest, lease_id, True)
            return None
    except Exception:
        # Redis 不可用时，每进程最多占满自身连接池的一部分。
        pass

    fallback_limit = min(_MAX_CONCURRENCY, 4)
    cutoff = time.monotonic() - _LEASE_TTL_S
    with _local_lock:
        leases = _local_leases.setdefault(digest, {})
        for stale_id in [
            item_id for item_id, started_at in leases.items() if started_at < cutoff
        ]:
            leases.pop(stale_id, None)
        if len(leases) >= fallback_limit:
            return None
        leases[lease_id] = time.monotonic()
        return ApiKeyLease(digest, lease_id, False)


def release(lease: ApiKeyLease) -> None:
    """释放并发槽；失败不影响业务响应，租约会自动过期。"""
    if lease.redis_backed:
        try:
            from platform_v8.storage.kv import get_redis

            redis = get_redis()
            if redis is not None:
                redis.zrem(
                    f"v8:auth:api-key-concurrency:{lease.digest}",
                    lease.lease_id,
                )
                return
        except Exception:
            return

    with _local_lock:
        leases = _local_leases.get(lease.digest)
        if leases is None:
            return
        leases.pop(lease.lease_id, None)
        if not leases:
            _local_leases.pop(lease.digest, None)
