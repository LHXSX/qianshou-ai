"""
余额查询 (从 ledger SUM · 单一真相)

设计要点:
  1. 优先用 we_accounts.balance (cache · 99% 场景够快)
  2. force_recompute=True 时从 ledger SUM 重算 (admin 审计 / 异常排查)
  3. ledger 是真相 · accounts.balance 是 cache · 不一致时 ledger 赢
"""
from __future__ import annotations
from decimal import Decimal

from sqlalchemy.orm import Session

from platform_v8.storage.repo import AccountRepo, LedgerRepo


def get_balance(s: Session, account_id: int,
                *, force_recompute: bool = False) -> Decimal:
    """返回当前余额"""
    if force_recompute:
        return LedgerRepo.sum_balance(s, account_id)
    account = AccountRepo.by_id(s, account_id)
    if account is None:
        raise ValueError(f"account {account_id} 不存在")
    return account.balance


def verify_consistency(s: Session, account_id: int) -> dict:
    """admin 用 · 比对 cache vs ledger SUM · 返回是否一致"""
    cached = get_balance(s, account_id, force_recompute=False)
    actual = LedgerRepo.sum_balance(s, account_id)
    return {
        "account_id": account_id,
        "cached": str(cached),
        "actual": str(actual),
        "consistent": cached == actual,
        "diff": str(actual - cached),
    }
