"""TestClient + FastAPI dependency override 标准化封装。

约定（CI / 并行）:
  - 云效流水线当前是 ``cd platform_v8 && python -m pytest -q``，未启用
    pytest-xdist；同一进程内用例默认串行。
  - 若将来开 xdist：每个 worker 是独立进程，各自有一份模块级 ``app``，
    ``dependency_overrides`` 本身互不共享，无需跨进程同步。
  - 同一进程内若出现多线程共用同一 ``app``（非常规），本模块用
    ``RLock`` 串行化 override 写入/清理，避免竞态；仍禁止跨线程长期
    持有未关闭的 client。

注意：函数名不以 ``test_`` 开头，避免被 pytest 当作用例收集。
"""
from __future__ import annotations

import threading
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from platform_v8.api.deps import get_admin_account
from platform_v8.core import Account, AccountRole

_OVERRIDE_LOCK = threading.RLock()


def make_fake_account(
    *,
    account_id: int = 1,
    username: str = "admin",
    email: str = "admin@test",
    role: AccountRole = AccountRole.ADMIN,
    password_hash: str = "test-only-not-a-real-hash",
) -> Account:
    """构造测试用 Account；默认 admin，可覆盖 role/id。"""
    return Account(
        id=account_id,
        username=username,
        email=email,
        password_hash=password_hash,
        role=role,
    )


@contextmanager
def client_with_dependency_overrides(
    app: FastAPI,
    overrides: Mapping[Callable[..., Any], Callable[..., Any]],
) -> Iterator[TestClient]:
    """在 TestClient 生命周期内注入 dependency_overrides，退出时清理。"""
    with _OVERRIDE_LOCK:
        previous = {
            dep: app.dependency_overrides[dep]
            for dep in overrides
            if dep in app.dependency_overrides
        }
        app.dependency_overrides.update(overrides)
    try:
        with TestClient(app) as client:
            yield client
    finally:
        with _OVERRIDE_LOCK:
            for dep in overrides:
                if dep in previous:
                    app.dependency_overrides[dep] = previous[dep]
                else:
                    app.dependency_overrides.pop(dep, None)


@contextmanager
def client_with_admin(
    app: FastAPI,
    *,
    account: Account | None = None,
) -> Iterator[TestClient]:
    """绕过 get_admin_account 的标准 TestClient。"""
    fake = account or make_fake_account()

    def _fake_admin() -> Account:
        return fake

    with client_with_dependency_overrides(
        app,
        {get_admin_account: _fake_admin},
    ) as client:
        yield client
