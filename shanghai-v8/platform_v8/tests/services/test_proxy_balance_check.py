"""
W5-phase2-Step1 · _check_client_balance 预付余额护栏单测 (2026-05-26)

覆盖:
  - 余额充足 → ok=True
  - 余额不足 → ok=False · 返 reason
  - client_id 非数字 → 跳过 (返 ok=True · api_key 客户)
  - DB 异常 → fail-open (返 ok=True · 不阻塞)
"""
from __future__ import annotations
import sys
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.proxy import gateway as pg


# ════════════════════════════════════════════════════════════════
# 跳过情形
# ════════════════════════════════════════════════════════════════
def test_balance_check_skips_non_int_client():
    """client_id="api_key_xyz" · 非数字 · 跳过返 ok=True"""
    ok, reason = pg._check_client_balance("api_key_xyz")
    assert ok is True
    assert reason == ""


def test_balance_check_skips_empty_client():
    ok, reason = pg._check_client_balance("")
    assert ok is True


# ════════════════════════════════════════════════════════════════
# 余额检查 path
# ════════════════════════════════════════════════════════════════
def test_balance_check_passes_when_balance_sufficient():
    """余额 ≥ PROXY_MIN_CLIENT_BALANCE · 返 ok=True"""
    big = pg.PROXY_MIN_CLIENT_BALANCE + Decimal("10")
    with patch("platform_v8.storage.repo.LedgerRepo.sum_balance",
               return_value=big), \
         patch("platform_v8.storage.db.session_scope") as mock_scope:
        mock_scope.return_value.__enter__.return_value = MagicMock()
        mock_scope.return_value.__exit__.return_value = False
        ok, reason = pg._check_client_balance("100")
    assert ok is True
    assert reason == ""


def test_balance_check_rejects_when_balance_low():
    """余额 < PROXY_MIN_CLIENT_BALANCE · 返 ok=False · reason 含数值"""
    low = Decimal("0.01")  # < 默认 0.1
    with patch("platform_v8.storage.repo.LedgerRepo.sum_balance",
               return_value=low), \
         patch("platform_v8.storage.db.session_scope") as mock_scope:
        mock_scope.return_value.__enter__.return_value = MagicMock()
        mock_scope.return_value.__exit__.return_value = False
        ok, reason = pg._check_client_balance("100")
    assert ok is False
    assert "balance_too_low" in reason
    assert "0.01" in reason


def test_balance_check_exact_minimum_passes():
    """余额 = PROXY_MIN_CLIENT_BALANCE · 边界 · 通过"""
    with patch("platform_v8.storage.repo.LedgerRepo.sum_balance",
               return_value=pg.PROXY_MIN_CLIENT_BALANCE), \
         patch("platform_v8.storage.db.session_scope") as mock_scope:
        mock_scope.return_value.__enter__.return_value = MagicMock()
        mock_scope.return_value.__exit__.return_value = False
        ok, _ = pg._check_client_balance("100")
    assert ok is True


def test_balance_check_fail_open_on_db_error():
    """DB 异常 · fail-open · 返 ok=True · 不阻塞业务"""
    with patch("platform_v8.storage.repo.LedgerRepo.sum_balance",
               side_effect=RuntimeError("DB connection lost")), \
         patch("platform_v8.storage.db.session_scope") as mock_scope:
        mock_scope.return_value.__enter__.return_value = MagicMock()
        mock_scope.return_value.__exit__.return_value = False
        ok, reason = pg._check_client_balance("100")
    assert ok is True
    assert reason == ""


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
