"""
DB 连接抽象 · 全平台唯一入口

替代 backend/persistence.py · 解决"persistence._ready=False"根因。

设计要点 (考虑全链路):
  1. 一次性 init · 所有 services 共用同一份 engine + session_factory
  2. session 通过 FastAPI Depends 注入到 endpoint · 自动 commit/rollback/close
  3. 连接池: pool_size=10, max_overflow=20 (单 backend 进程上限 30 连接)
  4. 失败时显式抛 · 不静默 (避免老代码 "_ready=False 然后绕过 psycopg2 直连")
  5. 同时支持 sync + async 两种 session (sync 给 reaper/migration · async 给 endpoint)
"""
from __future__ import annotations
import hashlib
import logging
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

logger = logging.getLogger(__name__)

# ── 单例全局状态 ─────────────────────────────────────
_engine: Engine | None = None
_session_factory: sessionmaker | None = None


def _build_dsn() -> str:
    """从环境变量构建 DSN · 失败时显式抛"""
    dsn = os.environ.get("V8_DATABASE_URL")
    if dsn:
        return dsn

    # 兜底: 从分量构建 (兼容老 docker-compose 环境变量)
    host = os.environ.get("POSTGRES_HOST", "localhost")
    port = os.environ.get("POSTGRES_PORT", "5432")
    user = os.environ.get("POSTGRES_USER", "admin")
    pwd = os.environ.get("POSTGRES_PASSWORD")
    db = os.environ.get("POSTGRES_DB", "edge_compute")

    if not pwd:
        raise RuntimeError(
            "V8 DB 配置缺失: 必须设置 V8_DATABASE_URL 或 POSTGRES_PASSWORD 环境变量。"
            "不再支持硬编码密码 (v1 老代码遗留的安全问题已在 v8 修复)。"
        )

    return f"postgresql+psycopg2://{user}:{pwd}@{host}:{port}/{db}"


def init_db(echo: bool = False) -> Engine:
    """初始化全局 engine + session_factory · 整个 backend 启动时调用 1 次"""
    global _engine, _session_factory

    if _engine is not None:
        logger.debug("DB 已 init · 跳过重复调用")
        return _engine

    dsn = _build_dsn()
    safe_dsn = dsn.split("@", 1)[-1]  # 不打印密码
    logger.info("v8 DB 初始化 · target=%s", safe_dsn)

    # dialect 自适应: SQLite 本地联调用短连接，避免 WebSocket/后台线程占满
    # 默认 QueuePool 后，所有 HTTP 请求会等待到超时。
    engine_kwargs: dict = {"echo": echo, "future": True}
    if dsn.startswith("sqlite"):
        engine_kwargs.update({
            "poolclass": NullPool,
            "connect_args": {
                "check_same_thread": False,
                "timeout": float(os.environ.get("V8_SQLITE_BUSY_TIMEOUT", "30")),
            },
        })
    else:
        engine_kwargs.update({
            # 4 个 uvicorn worker 默认合计最多 24 条连接，不超过 PgBouncer 25 槽位。
            "pool_size": int(os.environ.get("V8_DB_POOL_SIZE", "5")),
            "max_overflow": int(os.environ.get("V8_DB_MAX_OVERFLOW", "1")),
            "pool_timeout": float(os.environ.get("V8_DB_POOL_TIMEOUT", "5")),
            "pool_pre_ping": True,    # 防 idle 连接挂掉
            "pool_recycle": 3600,     # 1 小时回收
        })
        # ── 时区根因修复 (2026-06-07 S1-T1 · 2026-06-11 改用 libpq 启动参数加固) ──
        # 根因: Python `datetime.utcnow()` 返回 naive datetime · SQLAlchemy 传给 PG timestamptz
        #   列时 PG 按 server 时区 (Asia/Shanghai +08) 解释 · 实际值偏 -8h · 引爆"AI 报 0 节点"
        #   /大屏在线数错/任何裸 NOW() 查询错位 等多个隐性 bug。
        # 修法: 连接 startup 即把 session 时区钉死 UTC · naive utcnow 被当 UTC 写入即正确 ·
        #   读取 NOW() 也是 UTC · 与 last_seen 直接比较语义一致。
        # 为何用 connect_args options 而非 @event SET TIME ZONE:
        #   `SET TIME ZONE` 在隐式事务里执行 · 部分连接 (迁移脚本/短连接) 会被 SQLAlchemy
        #   的 reset-on-return rollback 撤销 · 表现为"live 进程对、脚本连接错"的脆弱状态。
        #   libpq `-c timezone=UTC` 在连接建立时由 server 应用 · 事务无法回滚 · 全连接一致。
        # 历史活跃数据由 migration v8_029_timezone_utc.sql 一次性 backfill。
        connect_args = engine_kwargs.get("connect_args", {})
        existing_opts = connect_args.get("options", "")
        connect_args["options"] = (existing_opts + " -c timezone=UTC").strip()
        engine_kwargs["connect_args"] = connect_args

    _engine = create_engine(dsn, **engine_kwargs)

    _session_factory = sessionmaker(
        bind=_engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
    )

    # 启动时立即验证 (失败 fail-fast · 不允许 "_ready=False" 的歧义状态)
    with _engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    logger.info("v8 DB 连接验证通过")

    # 本地 UI 联调可显式启用 SQLite schema bootstrap。生产数据库始终由迁移
    # 管理，避免 create_all 绕过版本与 checksum 校验。
    if (
        dsn.startswith("sqlite")
        and os.environ.get("V8_BOOTSTRAP_SQLITE_SCHEMA") == "1"
    ):
        from platform_v8.storage.repo import create_all_for_testing
        from platform_v8.services.ops import feature_flags as ff

        create_all_for_testing(_engine)
        ff.bootstrap_sqlite_flags(_engine)
        logger.warning("本地开发 SQLite schema 已按 V8_BOOTSTRAP_SQLITE_SCHEMA 创建")

    return _engine


def get_engine() -> Engine:
    """拿全局 engine · init_db() 没调用过会抛"""
    if _engine is None:
        raise RuntimeError("DB 未初始化 · 必须先调用 init_db()")
    return _engine


def get_session_factory() -> sessionmaker:
    """拿全局 session 工厂"""
    if _session_factory is None:
        raise RuntimeError("DB 未初始化 · 必须先调用 init_db()")
    return _session_factory


@contextmanager
def session_scope() -> Iterator[Session]:
    """
    手动用法 (脚本 / reaper / migration):

        with session_scope() as s:
            s.execute(text("..."))
            s.commit()  # 显式 commit
    """
    factory = get_session_factory()
    session = factory()
    try:
        yield session
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_session() -> Iterator[Session]:
    """
    FastAPI Depends 用法:

        @router.get(...)
        def endpoint(session: Session = Depends(get_session)):
            ...

    出 endpoint 时自动 commit (无异常) 或 rollback (有异常) · 然后 close。
    """
    factory = get_session_factory()
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def healthcheck() -> dict[str, str]:
    """健康检查 (给 ops/health 用)"""
    try:
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"db": "ok"}
    except Exception as exc:
        return {"db": "error", "detail": str(exc)}


def auth_schema_healthcheck() -> dict[str, str]:
    """Verify that authentication migrations required by the running code exist."""
    required: dict[str, set[str]] = {
        "we_shards": {"failure_class"},
        "we_accounts": {
            "totp_secret_enc",
            "totp_enabled_at",
            "totp_last_counter",
            # 手机号登录（2026-09-20）：缺这三列时启动自检必须报出来，
            # 而不是等第一个用户点"获取验证码"才发现。
            "phone",
            "phone_country",
            "phone_verified_at",
        },
        "we_sms_verifications": {
            "id",
            "phone",
            "purpose",
            "code_hash",
            "expires_at",
            "attempts",
            "consumed_at",
        },
        "we_auth_sessions": {
            "id",
            "account_id",
            "device_id",
            "revoked_at",
            "refresh_jti_hash",
            "refresh_expires_at",
            "remember_me",
        },
        "we_auth_devices": {
            "id",
            "credential_hash",
            "account_id",
            "trusted_at",
            "trusted_until",
            "trust_revoked_at",
        },
        "we_auth_login_challenges": {
            "id",
            "token_hash",
            "account_id",
            "pending_credential_hash",
            "expires_at",
            "consumed_at",
        },
    }
    try:
        inspector = inspect(get_engine())
        table_names = set(inspector.get_table_names())
        problems: list[str] = []
        for table, expected_columns in required.items():
            if table not in table_names:
                problems.append(f"缺少表 {table}")
                continue
            actual_columns = {
                str(column["name"]) for column in inspector.get_columns(table)
            }
            missing = sorted(expected_columns - actual_columns)
            if missing:
                problems.append(f"{table} 缺少列 {','.join(missing)}")
        if problems:
            return {"auth_schema": "error", "detail": "; ".join(problems)}
        return {"auth_schema": "ok"}
    except Exception as exc:
        return {"auth_schema": "error", "detail": str(exc)}


def migration_healthcheck() -> dict[str, str]:
    """Verify the production migration ledger against immutable SQL checksums."""
    if os.environ.get("ENVIRONMENT", "").strip().lower() != "production":
        return {"migrations": "disabled"}

    migration_dir = Path(__file__).resolve().parents[1] / "migrations"
    versions = (
        "v8_033_totp_authenticator.sql",
        "v8_034_auth_sessions.sql",
        "v8_035_trusted_devices.sql",
        "v8_036_auth_hardening.sql",
    )
    try:
        expected: dict[str, str] = {}
        for version in versions:
            migration = migration_dir / version
            if not migration.is_file():
                return {
                    "migrations": "error",
                    "detail": f"缺少迁移文件 {version}",
                }
            expected[version] = hashlib.sha256(migration.read_bytes()).hexdigest()

        inspector = inspect(get_engine())
        if "we_schema_migrations" not in set(inspector.get_table_names()):
            return {"migrations": "error", "detail": "缺少表 we_schema_migrations"}
        columns = {
            str(column["name"])
            for column in inspector.get_columns("we_schema_migrations")
        }
        if "checksum_sha256" not in columns:
            return {
                "migrations": "error",
                "detail": "we_schema_migrations 缺少列 checksum_sha256",
            }

        placeholders = ", ".join(f":version_{index}" for index in range(len(versions)))
        parameters = {
            f"version_{index}": version for index, version in enumerate(versions)
        }
        with get_engine().connect() as connection:
            rows = connection.execute(
                text(
                    "SELECT version, checksum_sha256 FROM we_schema_migrations "
                    f"WHERE version IN ({placeholders})"
                ),
                parameters,
            ).mappings()
            actual = {
                str(row["version"]): str(row["checksum_sha256"] or "")
                for row in rows
            }

        problems = []
        for version, checksum in expected.items():
            if version not in actual:
                problems.append(f"未记录 {version}")
            elif actual[version] != checksum:
                problems.append(f"{version} checksum 不匹配")
        if problems:
            return {"migrations": "error", "detail": "; ".join(problems)}
        return {"migrations": "ok"}
    except Exception as exc:
        return {"migrations": "error", "detail": str(exc)}
