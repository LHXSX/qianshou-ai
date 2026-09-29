"""
W5-Step2 · gateway._do_proxy_ledger_transfer 单测 (2026-05-26)

覆盖:
  - 正常 path · 客户 id 是 int · worker 有 owner · 调 ledger.transfer
  - client_id 非数字 (api_key) · 跳过
  - worker 无 owner · 跳过
  - revenue_edg <= 0 · 跳过
  - workload_id 格式 "proxy_{sid}"
"""
from __future__ import annotations
import sys
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.proxy import gateway as pg


def _make_session(client_id: str = "100", worker_id: str = "worker-x") -> pg.ProxySession:
    return pg.ProxySession(
        session_id="sid_abc",
        worker_id=worker_id,
        client_id=client_id,
        target_host="example.com",
        target_port=443,
    )


# ════════════════════════════════════════════════════════════════
# 跳过情形
# ════════════════════════════════════════════════════════════════
def test_skip_when_revenue_zero():
    """revenue=0 · 不调 ledger.transfer · 不查 DB"""
    fake_s = MagicMock()
    sess = _make_session()
    with patch("platform_v8.services.economy.ledger.transfer") as mock_transfer:
        pg._do_proxy_ledger_transfer(fake_s, sess=sess, revenue_edg=0.0,
                                     session_id="sid_abc")
        mock_transfer.assert_not_called()
    fake_s.execute.assert_not_called()


def test_skip_when_revenue_negative():
    fake_s = MagicMock()
    sess = _make_session()
    with patch("platform_v8.services.economy.ledger.transfer") as mock_transfer:
        pg._do_proxy_ledger_transfer(fake_s, sess=sess, revenue_edg=-0.5,
                                     session_id="sid_abc")
        mock_transfer.assert_not_called()


def test_skip_when_client_id_not_int():
    """client_id="api_key_xyz" · 非数字 · 跳过 (老 api_key 客户)"""
    fake_s = MagicMock()
    sess = _make_session(client_id="api_key_xyz")
    with patch("platform_v8.services.economy.ledger.transfer") as mock_transfer:
        pg._do_proxy_ledger_transfer(fake_s, sess=sess, revenue_edg=0.001,
                                     session_id="sid_abc")
        mock_transfer.assert_not_called()
    fake_s.execute.assert_not_called()


def test_skip_when_worker_has_no_owner():
    """worker 查不到 owner · 跳过"""
    fake_s = MagicMock()
    fake_s.execute.return_value.first.return_value = None
    sess = _make_session()
    with patch("platform_v8.services.economy.ledger.transfer") as mock_transfer:
        pg._do_proxy_ledger_transfer(fake_s, sess=sess, revenue_edg=0.001,
                                     session_id="sid_abc")
        mock_transfer.assert_not_called()


def test_skip_when_owner_is_null():
    """worker 行存在但 owner_id 是 None"""
    fake_s = MagicMock()
    fake_s.execute.return_value.first.return_value = (None,)
    sess = _make_session()
    with patch("platform_v8.services.economy.ledger.transfer") as mock_transfer:
        pg._do_proxy_ledger_transfer(fake_s, sess=sess, revenue_edg=0.001,
                                     session_id="sid_abc")
        mock_transfer.assert_not_called()


# ════════════════════════════════════════════════════════════════
# 正常 path
# ════════════════════════════════════════════════════════════════
def test_calls_ledger_transfer_with_correct_args():
    """正常 path · client=100 · worker.owner=42 · revenue=0.01 EDG"""
    fake_s = MagicMock()
    fake_s.execute.return_value.first.return_value = (42,)
    sess = _make_session(client_id="100", worker_id="worker-x")

    with patch("platform_v8.services.economy.ledger.transfer") as mock_transfer:
        pg._do_proxy_ledger_transfer(fake_s, sess=sess, revenue_edg=0.01,
                                     session_id="sid_abc")
        mock_transfer.assert_called_once()
        kwargs = mock_transfer.call_args.kwargs
        assert kwargs["client_account_id"] == 100
        assert kwargs["worker_owner_id"] == 42
        assert kwargs["platform_account_id"] == pg.PROXY_PLATFORM_ACCOUNT_ID
        assert kwargs["total_amount"] == Decimal("0.0100")
        assert kwargs["platform_fee_pct"] == pg.PROXY_PLATFORM_FEE_PCT
        assert kwargs["workload_id"] == "proxy_sid_abc"
        assert "example.com:443" in kwargs["note"]


def test_handles_str_owner_id():
    """worker.owner_id 是 str (UUID 旧风格) · 仍能转 int"""
    fake_s = MagicMock()
    fake_s.execute.return_value.first.return_value = ("17",)
    sess = _make_session(client_id="100")

    with patch("platform_v8.services.economy.ledger.transfer") as mock_transfer:
        pg._do_proxy_ledger_transfer(fake_s, sess=sess, revenue_edg=0.5,
                                     session_id="sid_abc")
        kwargs = mock_transfer.call_args.kwargs
        assert kwargs["worker_owner_id"] == 17


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
