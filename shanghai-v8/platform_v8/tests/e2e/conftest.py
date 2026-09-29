"""
e2e 共享 fixture (sqlite in-memory · 不需 docker)

设计:
  - 每个测试一个独立 sqlite engine (memory · 隔离)
  - 自动 create_all_for_testing → 所有 v8 表
  - 替换 db._engine / _session_factory · 让真实 service code 透明用 sqlite
  - 提供 admin / user / worker 三个预 seed 账号
  - 自动清理全局 (proxy._sessions / event_bus 等)
"""
from __future__ import annotations
import os
import sys
import time
import uuid
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# 让 db._build_dsn 不报错 (虽然我们会覆盖 _engine)
os.environ.setdefault("POSTGRES_PASSWORD", "e2e-test-pwd")
os.environ.setdefault("V8_DATABASE_URL", "sqlite:///:memory:")


# ════════════════════════════════════════════════════════════════
# DB fixture · 每个测试独立 sqlite engine
# ════════════════════════════════════════════════════════════════
@pytest.fixture
def db_session():
    """全套 v8 表 · 真实 schema · sqlite in-memory · 测试后丢弃"""
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import create_all_for_testing

    eng = create_engine("sqlite:///:memory:", future=True)
    create_all_for_testing(eng)

    factory = sessionmaker(bind=eng, autoflush=False, autocommit=False,
                           expire_on_commit=False, future=True)

    # 接管全局 · 让 service code 用本 sqlite
    orig_engine = db_mod._engine
    orig_factory = db_mod._session_factory
    db_mod._engine = eng
    db_mod._session_factory = factory

    s = factory()
    try:
        yield s
        s.commit()
    finally:
        s.close()
        # 还原
        db_mod._engine = orig_engine
        db_mod._session_factory = orig_factory
        eng.dispose()


# ════════════════════════════════════════════════════════════════
# Seed accounts (admin / customer / worker_owner)
# ════════════════════════════════════════════════════════════════
@pytest.fixture
def seed_accounts(db_session):
    """3 个标准账号 · 余额预热 · 返 dict 含 id/balance"""
    s = db_session
    now = "2026-05-26T00:00:00"

    # admin (account_id=1 · 平台账户)
    s.execute(text("""
        INSERT INTO we_accounts (id, username, email, password_hash, role, balance,
                                  status, profile, created_at, updated_at)
        VALUES (1, 'admin', 'admin@test.local', 'x', 'admin', 0,
                'active', '{}', :ts, :ts)
    """), {"ts": now})

    # customer (account_id=100 · 充值 10 EDG)
    s.execute(text("""
        INSERT INTO we_accounts (id, username, email, password_hash, role, balance,
                                  status, profile, created_at, updated_at)
        VALUES (100, 'biz_customer', 'biz@test.local', 'x', 'user', 10.0,
                'active', '{}', :ts, :ts)
    """), {"ts": now})

    # worker_owner (account_id=200 · 0 余额)
    s.execute(text("""
        INSERT INTO we_accounts (id, username, email, password_hash, role, balance,
                                  status, profile, created_at, updated_at)
        VALUES (200, 'node_owner', 'node@test.local', 'x', 'user', 0,
                'active', '{}', :ts, :ts)
    """), {"ts": now})

    # 给 customer 一笔 deposit 进 ledger · 让 sum_balance 准
    s.execute(text("""
        INSERT INTO we_ledger (id, account_id, type, amount, currency,
                                idempotent_key, note, metadata, created_at)
        VALUES (:id, 100, 'DEPOSIT', 10.0, 'EDG', :ikey, 'seed', '{}', :ts)
    """), {"id": str(uuid.uuid4()), "ikey": f"seed-deposit-{uuid.uuid4()}", "ts": now})

    s.commit()

    return {
        "admin": {"id": 1, "balance": Decimal("0")},
        "customer": {"id": 100, "balance": Decimal("10")},
        "worker_owner": {"id": 200, "balance": Decimal("0")},
    }


# ════════════════════════════════════════════════════════════════
# Seed worker
# ════════════════════════════════════════════════════════════════
@pytest.fixture
def seed_worker(db_session, seed_accounts):
    """注册一个 ONLINE worker · 接 owner=200 · 返 worker_id"""
    s = db_session
    wid = str(uuid.uuid4())
    now = "2026-05-26T00:00:00"
    s.execute(text("""
        INSERT INTO we_workers (id, owner_id, name, status, capabilities,
                                 load, active_shards, reputation, capability_score,
                                 last_seen, registered_at, client_version)
        VALUES (:id, 200, 'test_worker_01', 'ONLINE', '{}',
                0.0, 0, 0.5, 0.0,
                :ts, :ts, '')
    """), {"id": wid, "ts": now})
    s.commit()
    return wid


# ════════════════════════════════════════════════════════════════
# 清理 proxy 全局 (跨测试隔离)
# ════════════════════════════════════════════════════════════════
@pytest.fixture(autouse=True)
def _reset_proxy_globals():
    from platform_v8.services.proxy import gateway as pg
    pg._sessions.clear()
    pg._node_sessions.clear()
    pg._blacklist_workers.clear()
    yield
    pg._sessions.clear()
    pg._node_sessions.clear()
    pg._blacklist_workers.clear()
