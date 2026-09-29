"""
Redis cache 抽象 · 全平台唯一入口

设计要点 (考虑全链路):
  1. 用于 worker 在线状态 (TTL 30s) · session 缓存 · 限流计数 · 不存业务数据
  2. 失败 fallback: Redis 挂了 backend 不挂 · 退化为"没缓存" (DB 直查)
  3. 命名空间: 所有 key 加 "v8:" 前缀 · 不跟 v1/v2 老 key 冲突
"""
from __future__ import annotations
import logging
import os
from typing import Any
import json

logger = logging.getLogger(__name__)

# ── 单例 ─────────────────────────────────────
_redis = None
_KEY_PREFIX = "v8:"


def init_kv() -> Any:
    """初始化 Redis 连接 · 启动时调用 1 次"""
    global _redis
    if _redis is not None:
        return _redis

    try:
        import redis as _redis_mod
    except ImportError:
        logger.warning("redis 包未安装 · v8 KV cache 禁用 (功能不受影响 · 仅性能下降)")
        return None

    url = os.environ.get("V8_REDIS_URL") or os.environ.get("REDIS_URL")
    if not url:
        host = os.environ.get("REDIS_HOST", "localhost")
        port = os.environ.get("REDIS_PORT", "6379")
        url = f"redis://{host}:{port}/0"

    try:
        _redis = _redis_mod.Redis.from_url(url, decode_responses=True, socket_timeout=2.0)
        _redis.ping()
        logger.info("v8 Redis 连接成功 · target=%s", url.split("@")[-1])
    except Exception as exc:
        logger.warning("v8 Redis 连接失败 · 降级 no-cache 模式 · err=%s", exc)
        _redis = None
    return _redis


def get_redis() -> Any:
    """拿全局 redis 客户端 · 可能 None (Redis 挂了或未配置)"""
    return _redis


def _k(key: str) -> str:
    """加 v8: 前缀"""
    return f"{_KEY_PREFIX}{key}"


def set_json(key: str, value: Any, ttl_s: int | None = None) -> bool:
    r = get_redis()
    if r is None:
        return False
    try:
        r.set(_k(key), json.dumps(value, default=str), ex=ttl_s)
        return True
    except Exception as exc:
        logger.warning("kv.set_json fail key=%s err=%s", key, exc)
        return False


def get_json(key: str) -> Any:
    r = get_redis()
    if r is None:
        return None
    try:
        raw = r.get(_k(key))
        return json.loads(raw) if raw else None
    except Exception as exc:
        logger.warning("kv.get_json fail key=%s err=%s", key, exc)
        return None


def delete(key: str) -> bool:
    r = get_redis()
    if r is None:
        return False
    try:
        r.delete(_k(key))
        return True
    except Exception as exc:
        logger.warning("kv.delete fail key=%s err=%s", key, exc)
        return False


def healthcheck() -> dict[str, str]:
    """健康检查 (给 ops/health 用)"""
    r = get_redis()
    if r is None:
        return {"redis": "disabled"}
    try:
        r.ping()
        return {"redis": "ok"}
    except Exception as exc:
        return {"redis": "error", "detail": str(exc)}
