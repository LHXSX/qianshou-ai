"""部署期管理员初始化；凭据只从环境变量读取，绝不写入仓库。"""
from __future__ import annotations

import os

from platform_v8.core import AccountRole
from platform_v8.services.auth.passwords import hash_password
from platform_v8.storage import db
from platform_v8.storage.repo import AccountRepo, accounts_t


def ensure_admin_from_env() -> None:
    password = os.environ.get("ADMIN_BOOTSTRAP_PASSWORD", "")
    if not password:
        return
    username = os.environ.get("ADMIN_BOOTSTRAP_USERNAME", "admin").strip()
    email = os.environ.get("ADMIN_BOOTSTRAP_EMAIL", "admin@localhost").strip()
    if not username or len(password) < 8:
        raise RuntimeError("ADMIN_BOOTSTRAP_USERNAME 不能为空，ADMIN_BOOTSTRAP_PASSWORD 至少 8 位")
    reset = os.environ.get("ADMIN_BOOTSTRAP_RESET_PASSWORD") == "1"
    with db.session_scope() as session:
        account = AccountRepo.by_username(session, username)
        if account is None:
            AccountRepo.create(
                session, username=username, email=email, password_hash=hash_password(password),
                role=AccountRole.ADMIN, profile={"nickname": "平台管理员"},
            )
        else:
            values = {"role": AccountRole.ADMIN.value}
            if reset:
                values["password_hash"] = hash_password(password)
            session.execute(accounts_t.update().where(accounts_t.c.id == account.id).values(**values))
        session.commit()
