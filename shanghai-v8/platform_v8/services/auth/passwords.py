"""
密码工具 · bcrypt hash + verify

设计要点 (考虑全局):
  1. 只用 bcrypt · 不接 legacy sha256 (v1 老代码 auth.py:435 的 legacy 兼容已抛弃)
  2. cost=12 (业界标准 · ~250ms/次)
  3. verify 错误返 False · 不抛 (避免 timing 攻击)
  4. 全平台只在这一个文件做密码操作 (后续 services/auth/change_password 也用这个)
"""
from __future__ import annotations
import logging

import bcrypt

logger = logging.getLogger(__name__)

_BCRYPT_COST = 12


def hash_password(plain: str) -> str:
    """bcrypt hash · 返回字符串形式 (DB 存这个)"""
    if not plain:
        raise ValueError("密码不能为空")
    salt = bcrypt.gensalt(rounds=_BCRYPT_COST)
    return bcrypt.hashpw(plain.encode("utf-8"), salt).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """const-time 比较 · 任何异常返 False (避免 timing 攻击)"""
    if not plain or not hashed:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception as exc:
        logger.warning("verify_password 异常 (返回 False): %s", exc)
        return False
