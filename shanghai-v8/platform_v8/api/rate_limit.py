"""
轻量 rate limiter（Redis 多进程一致，故障时退化为进程内滑动窗）

设计:
  - Redis 正常时跨 uvicorn worker 共享额度
  - Redis 故障时退化为进程内，不让限流依赖拖垮业务
  - 按 (key_func 返回值, scope) 限流 · 例: 按 IP 限 login · 按 user_id 限 submit
  - 超限返 429 + Retry-After header

用法:
    from platform_v8.api.rate_limit import rate_limit
    @router.post("/login")
    @rate_limit("login", per_minute=5, key="ip")
    async def login(...):
        ...

2026-05-25 P3 修复 · Bug 11
  之前: 完全无限流 · 登录可爆破 · register 可批量刷 · workload 可烧光 budget
  现在: 关键写接口都有基础保护
"""
from __future__ import annotations
import asyncio
import functools
import hashlib
import logging
import time
from collections import defaultdict, deque
from typing import Callable

from fastapi import HTTPException, Request

from platform_v8.api.client_ip import client_ip

logger = logging.getLogger(__name__)


# (scope, key) → deque[timestamp]
_hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)
# 总条目上限 · 防内存泄漏 · 超过就清最老的
_MAX_ENTRIES = 100000


def _get_key(request: Request, key_kind: str) -> str:
    """
    提取限流 key
      ip   : 客户端 IP (含 X-Forwarded-For 兼容)
      uid  : 已认证用户 ID (没认证退化到 ip)
    """
    if key_kind == "ip":
        return client_ip(request)
    if key_kind == "uid":
        # 从 deps.get_current_account 注入的 state 取 (中间件层加)
        uid = getattr(request.state, "account_id", None)
        if uid is not None:
            return f"uid:{uid}"
        authorization = request.headers.get("authorization", "")
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer" and token:
            # Authentication dependencies run after this rate-limit dependency.
            # Bind every bearer credential to its own digest so ordinary ecosystem
            # sessions never collapse into the shared reverse-proxy IP bucket.
            digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
            return f"bearer:{digest}"
        # 没认证 · 退化 ip
        return _get_key(request, "ip")
    return "global"


def _cleanup_if_needed():
    """超 _MAX_ENTRIES 时砍掉一半最早访问的 key (防内存爆炸)"""
    if len(_hits) <= _MAX_ENTRIES:
        return
    # 按 deque 最早时间排序 · 删一半
    sorted_keys = sorted(_hits.items(), key=lambda kv: kv[1][0] if kv[1] else 0)
    for k, _ in sorted_keys[:_MAX_ENTRIES // 2]:
        _hits.pop(k, None)
    logger.info("rate_limit · cleanup · 当前 entries=%d", len(_hits))


def _check(scope: str, key: str, per_minute: int) -> int | None:
    """
    返回剩余冷却秒 · None=通过 · int=超限剩 N 秒
    """
    try:
        from platform_v8.storage.kv import get_redis

        redis = get_redis()
        if redis is not None:
            digest = hashlib.sha256(f"{scope}:{key}".encode("utf-8")).hexdigest()
            redis_key = f"v8:rate-limit:{digest}:{int(time.time() // 60)}"
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
                    61,
                )
            )
            if count > per_minute:
                return max(1, int(redis.ttl(redis_key)))
            return None
    except Exception as exc:
        logger.warning("rate_limit · Redis 降级为进程内 · scope=%s err=%s", scope, exc)

    now = time.monotonic()
    window = 60.0  # 1 分钟滑动窗
    bucket = _hits[(scope, key)]
    # 清掉窗外的
    while bucket and bucket[0] < now - window:
        bucket.popleft()
    if len(bucket) >= per_minute:
        retry_after = int(window - (now - bucket[0])) + 1
        return retry_after
    bucket.append(now)
    _cleanup_if_needed()
    return None


def rate_limit(scope: str, *, per_minute: int = 60, key: str = "ip"):
    """
    返回一个 FastAPI Dependency · 用 Depends() 注入到路由

    用法 (不要当 decorator):
        @router.post("/login", dependencies=[Depends(rate_limit("login", per_minute=10))])
        def login(...): ...

    Args:
        scope: 限流域名 · 同 scope 共享 quota
        per_minute: 每分钟允许次数
        key: "ip" 按 IP · "uid" 按已认证用户 ID (需在认证 dependency 之后才有 state.account_id)

    2026-05-25 P3 修复 · 之前用 functools.wraps decorator 干扰 FastAPI 参数注入 (422 body required)
    改用 FastAPI Dependency · 不动路由签名 · 完全兼容
    """
    def _dep(request: Request) -> None:
        limit_key = _get_key(request, key)
        retry_after = _check(scope, limit_key, per_minute)
        if retry_after is not None:
            logger.warning(
                "rate_limit · %s · key=%s 超限 (%d/分钟) · retry_after=%ds",
                scope, limit_key, per_minute, retry_after,
            )
            raise HTTPException(
                status_code=429,
                detail=f"请求过于频繁 · 请 {retry_after} 秒后重试",
                headers={"Retry-After": str(retry_after)},
            )
    return _dep
