"""共享测试辅助工具（避免各用例手写 dependency_overrides）。"""

from .auth_client import (
    client_with_admin,
    client_with_dependency_overrides,
    make_fake_account,
)

__all__ = [
    "make_fake_account",
    "client_with_admin",
    "client_with_dependency_overrides",
]
