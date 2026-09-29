"""
admin 账号 ID 公共解析 · 防硬编码不一致 bug

2026-05-25 P0 修复:
  问题: deps.py 把 v1 token sub='admin' 硬编码映射成 account_id=1
        但 split.py 已发现 admin 账号重建后 id 会变 (序列继续递增)
        两处不一致 → 一边能登 一边 ledger FK violation
  方案: 统一公共函数 · env 优先 · DB 动态兜底 · 硬编码 1 最后兜
  调用方:
    - api/deps.py:get_current_account (v1 token fallback)
    - services/economy/split.py:_resolve_platform_account_id (分账记 admin)
"""
from __future__ import annotations
import logging
import os

logger = logging.getLogger(__name__)

# 进程内缓存 · 避免每次 ledger 写都 SELECT (大量调用时影响性能)
# 失效场景: admin 账号被删 / 重建 → 下次 LookupError 时再查
_cached_admin_id: int | None = None


def resolve_admin_account_id(force_refresh: bool = False) -> int:
    """
    返回 admin 账号 ID · 解析顺序:
      1. V8_PLATFORM_ACCOUNT_ID env (运维显式指定 · 优先级最高)
      2. 进程内缓存 (除非 force_refresh)
      3. DB 查 we_accounts WHERE role='admin' AND status='active' ORDER BY id LIMIT 1
      4. 硬编码 1 (兜底 · 至少不让 import 期崩溃)

    Args:
        force_refresh: True 时跳过缓存重查 DB · 用于 admin 重建后立即生效
    """
    global _cached_admin_id

    # 1. env 优先
    env_v = os.environ.get("V8_PLATFORM_ACCOUNT_ID")
    if env_v:
        try:
            return int(env_v)
        except ValueError:
            logger.warning("V8_PLATFORM_ACCOUNT_ID=%r 不是合法整数 · 忽略", env_v)

    # 2. 缓存
    if not force_refresh and _cached_admin_id is not None:
        return _cached_admin_id

    # 3. DB 查
    try:
        from platform_v8.storage import db as _db
        from sqlalchemy import text as _text
        with _db.session_scope() as s:
            row = s.execute(_text(
                "SELECT id FROM we_accounts WHERE role='admin' AND status='active' "
                "ORDER BY id LIMIT 1"
            )).first()
            if row:
                _cached_admin_id = int(row[0])
                return _cached_admin_id
    except Exception as exc:
        logger.warning("resolve_admin_account_id · DB 查询失败 · 走兜底: %s", exc)

    # 4. 兜底
    return 1


def invalidate_cache() -> None:
    """admin 账号重建 / 删除时由 admin API 调用 · 让下次 resolve 重查"""
    global _cached_admin_id
    _cached_admin_id = None
