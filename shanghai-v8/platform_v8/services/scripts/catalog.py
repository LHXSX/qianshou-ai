"""
脚本目录 (Script Catalog) · 元数据层

设计要点 (P2 · 2026-05-24 · 完善计划第二阶段):
  1. catalog 是脚本展示信息的真相源 (name/desc/category/status/tags/version)
  2. 节点拉脚本仍走文件系统 (/api/v8/scripts/{name}) · catalog 不存源代码
  3. 启动时 ensure_table() 幂等建表 · 不依赖 alembic
  4. import_builtin() 把文件系统脚本批量 upsert 到 catalog (admin 一键导入)
  5. list/get/update/delete 全部不影响节点执行链路

字段语义:
  - status: active (可见可用) / disabled (隐藏不删) / archived (软删 · 仅 admin 看见)
  - source_kind: builtin (文件系统) / uploaded (后台上传) / external (外部 URL)
"""
from __future__ import annotations
import logging
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


# ── 表 DDL · 幂等 (CREATE TABLE IF NOT EXISTS) ────────────────────────
_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS we_script_catalog (
    id              BIGSERIAL PRIMARY KEY,
    task_type       TEXT        NOT NULL UNIQUE,
    name            TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    category        TEXT        NOT NULL DEFAULT 'general',
    status          TEXT        NOT NULL DEFAULT 'active',
    source_kind     TEXT        NOT NULL DEFAULT 'builtin',
    code_url        TEXT        NOT NULL,
    version         TEXT        NOT NULL DEFAULT '1.0.0',
    size_bytes      BIGINT      NOT NULL DEFAULT 0,
    tags            JSONB       NOT NULL DEFAULT '[]'::jsonb,
    pricing_ref     TEXT        DEFAULT NULL,
    used_count      BIGINT      NOT NULL DEFAULT 0,
    last_used_at    TIMESTAMPTZ DEFAULT NULL,
    created_by      BIGINT      REFERENCES we_accounts(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
"""

_CREATE_INDEX_STATUS_SQL = """
CREATE INDEX IF NOT EXISTS we_script_catalog_status_idx
    ON we_script_catalog (status, category)
    WHERE status = 'active'
"""

_CREATE_INDEX_CATEGORY_SQL = """
CREATE INDEX IF NOT EXISTS we_script_catalog_category_idx
    ON we_script_catalog (category)
"""


def ensure_table() -> None:
    """启动时调用 · 幂等建表 + 建索引 · 任何失败 log 后不抛 (兼容 sqlite 测试库)"""
    try:
        from platform_v8.storage import db as db_mod
        with db_mod.session_scope() as s:
            # PostgreSQL: 直接执行;  SQLite: JSONB / BIGSERIAL / TIMESTAMPTZ 不支持会报错
            dialect = s.bind.dialect.name if s.bind else "postgresql"
            if dialect != "postgresql":
                logger.info("script_catalog · 跳过建表 (非 postgresql · dialect=%s)", dialect)
                return
            s.execute(text(_CREATE_TABLE_SQL))
            s.execute(text(_CREATE_INDEX_STATUS_SQL))
            s.execute(text(_CREATE_INDEX_CATEGORY_SQL))
            s.commit()
        logger.info("script_catalog · ensure_table OK (we_script_catalog 就绪)")
    except Exception as exc:
        # 不抛 · 老库可能没 we_accounts FK · 让上层不阻塞 startup
        logger.warning("script_catalog · ensure_table 失败 (静默 · 后端继续启动): %s", exc)


# ── CRUD ──────────────────────────────────────────────────────────────

ALLOWED_STATUS = {"active", "disabled", "archived"}
ALLOWED_SOURCE_KINDS = {"builtin", "uploaded", "external"}


def _row_to_dict(row: Any) -> dict:
    """RowMapping → 干净 dict (时间转 ISO · tags 保持 list)"""
    d = dict(row)
    for k in ("created_at", "updated_at", "last_used_at"):
        if d.get(k) is not None and hasattr(d[k], "isoformat"):
            d[k] = d[k].isoformat()
    # tags 已经是 list (jsonb)
    if d.get("tags") is None:
        d["tags"] = []
    return d


def list_catalog(
    s: Session,
    *,
    status: Optional[str] = "active",
    category: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    """列脚本 catalog · 默认只返 active · q 模糊匹配 task_type/name/description"""
    where = []
    params: dict[str, Any] = {"limit": int(limit), "offset": int(offset)}
    if status:
        where.append("status = :status")
        params["status"] = status
    if category:
        where.append("category = :category")
        params["category"] = category
    if q:
        where.append("(task_type ILIKE :q OR name ILIKE :q OR description ILIKE :q)")
        params["q"] = f"%{q}%"
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    rows = s.execute(text(f"""
        SELECT id, task_type, name, description, category, status, source_kind,
               code_url, version, size_bytes, tags, pricing_ref, used_count,
               last_used_at, created_by, created_at, updated_at
        FROM we_script_catalog
        {where_sql}
        ORDER BY category, task_type
        LIMIT :limit OFFSET :offset
    """), params).mappings().all()
    return [_row_to_dict(r) for r in rows]


def get_by_task_type(s: Session, task_type: str) -> Optional[dict]:
    row = s.execute(text("""
        SELECT id, task_type, name, description, category, status, source_kind,
               code_url, version, size_bytes, tags, pricing_ref, used_count,
               last_used_at, created_by, created_at, updated_at
        FROM we_script_catalog
        WHERE task_type = :tt
    """), {"tt": task_type}).mappings().first()
    return _row_to_dict(row) if row else None


def get_by_id(s: Session, script_id: int) -> Optional[dict]:
    row = s.execute(text("""
        SELECT id, task_type, name, description, category, status, source_kind,
               code_url, version, size_bytes, tags, pricing_ref, used_count,
               last_used_at, created_by, created_at, updated_at
        FROM we_script_catalog
        WHERE id = :id
    """), {"id": int(script_id)}).mappings().first()
    return _row_to_dict(row) if row else None


def upsert(
    s: Session,
    *,
    task_type: str,
    name: str,
    code_url: str,
    description: str = "",
    category: str = "general",
    status: str = "active",
    source_kind: str = "builtin",
    version: str = "1.0.0",
    size_bytes: int = 0,
    tags: Optional[list[str]] = None,
    created_by: Optional[int] = None,
) -> dict:
    """
    幂等 upsert · 已存在则更新可变字段 (name/description/category/code_url/size_bytes/version)
    不动 status / tags / pricing_ref (这些只能通过 update_meta 改 · 避免覆盖管理员手改)
    """
    import json as _json
    if status not in ALLOWED_STATUS:
        raise ValueError(f"status 必须是 {ALLOWED_STATUS}")
    if source_kind not in ALLOWED_SOURCE_KINDS:
        raise ValueError(f"source_kind 必须是 {ALLOWED_SOURCE_KINDS}")

    tags_json = _json.dumps(list(tags or []))
    row = s.execute(text("""
        INSERT INTO we_script_catalog (
            task_type, name, description, category, status, source_kind,
            code_url, version, size_bytes, tags, created_by
        ) VALUES (
            :tt, :name, :desc, :cat, :status, :sk,
            :url, :ver, :size, CAST(:tags AS jsonb), :uid
        )
        ON CONFLICT (task_type) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            category = EXCLUDED.category,
            code_url = EXCLUDED.code_url,
            version = EXCLUDED.version,
            size_bytes = EXCLUDED.size_bytes,
            source_kind = EXCLUDED.source_kind,
            updated_at = NOW()
        RETURNING id, task_type, name, description, category, status, source_kind,
                  code_url, version, size_bytes, tags, pricing_ref, used_count,
                  last_used_at, created_by, created_at, updated_at
    """), {
        "tt": task_type, "name": name, "desc": description, "cat": category,
        "status": status, "sk": source_kind, "url": code_url, "ver": version,
        "size": int(size_bytes), "tags": tags_json, "uid": created_by,
    }).mappings().first()
    return _row_to_dict(row)


def update_meta(
    s: Session,
    script_id: int,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    category: Optional[str] = None,
    tags: Optional[list[str]] = None,
    version: Optional[str] = None,
    pricing_ref: Optional[str] = None,
) -> Optional[dict]:
    """admin 改展示信息 · 不改 status / code_url / source_kind"""
    import json as _json
    sets = []
    params: dict[str, Any] = {"id": int(script_id)}
    if name is not None:
        sets.append("name = :name")
        params["name"] = name
    if description is not None:
        sets.append("description = :desc")
        params["desc"] = description
    if category is not None:
        sets.append("category = :cat")
        params["cat"] = category
    if tags is not None:
        sets.append("tags = CAST(:tags AS jsonb)")
        params["tags"] = _json.dumps(list(tags))
    if version is not None:
        sets.append("version = :ver")
        params["ver"] = version
    if pricing_ref is not None:
        sets.append("pricing_ref = :pr")
        params["pr"] = pricing_ref or None
    if not sets:
        return get_by_id(s, script_id)
    sets.append("updated_at = NOW()")
    s.execute(text(f"""
        UPDATE we_script_catalog SET {", ".join(sets)}
        WHERE id = :id
    """), params)
    return get_by_id(s, script_id)


def update_status(s: Session, script_id: int, status: str) -> Optional[dict]:
    if status not in ALLOWED_STATUS:
        raise ValueError(f"status 必须是 {ALLOWED_STATUS}")
    s.execute(text("""
        UPDATE we_script_catalog
        SET status = :status, updated_at = NOW()
        WHERE id = :id
    """), {"id": int(script_id), "status": status})
    return get_by_id(s, script_id)


def archive(s: Session, script_id: int) -> Optional[dict]:
    """软删 → status='archived' · 不物理删除"""
    return update_status(s, script_id, "archived")


def count_all(s: Session, *, status: Optional[str] = None) -> int:
    where = "WHERE status = :status" if status else ""
    params: dict[str, Any] = {"status": status} if status else {}
    n = s.execute(text(f"SELECT COUNT(*) FROM we_script_catalog {where}"), params).scalar()
    return int(n or 0)
