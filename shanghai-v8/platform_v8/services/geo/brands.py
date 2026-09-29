"""
GEO 监测 · 品牌库 CRUD (W2-3)

对应表 we_geo_brands · 一个 customer 多个 brand · brand 含 aliases (NLP 用)
"""
from __future__ import annotations
import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

from .schemas import GeoBrand, GeoBrandCreate, GeoBrandUpdate

logger = logging.getLogger(__name__)


# ════════════════════════════════════════════════════════════════
# CRUD
# ════════════════════════════════════════════════════════════════
def create_brand(s: Session, *, customer_id: int, data: GeoBrandCreate) -> GeoBrand:
    """创建品牌 · 同客户同名报 ValueError"""
    row = s.execute(
        text(
            "INSERT INTO we_geo_brands "
            "(customer_id, brand_name, brand_aliases, category, metadata) "
            "VALUES (:cid, :name, CAST(:aliases AS JSONB), :cat, CAST(:meta AS JSONB)) "
            "ON CONFLICT (customer_id, brand_name) DO NOTHING "
            "RETURNING id, customer_id, brand_name, brand_aliases, category, metadata, created_at"
        ),
        {
            "cid": customer_id,
            "name": data.brand_name,
            "aliases": _to_json(data.brand_aliases),
            "cat": data.category,
            "meta": _to_json(data.metadata),
        },
    ).mappings().first()
    if row is None:
        raise ValueError(f"品牌 '{data.brand_name}' 已存在 (customer={customer_id})")
    return _row_to_brand(row)


def get_brand(s: Session, brand_id: int, *, customer_id: int | None = None) -> GeoBrand | None:
    """查单品牌 · customer_id 非空时校验所有权"""
    where = ["id = :id"]
    params: dict = {"id": brand_id}
    if customer_id is not None:
        where.append("customer_id = :cid")
        params["cid"] = customer_id
    row = s.execute(
        text(
            "SELECT id, customer_id, brand_name, brand_aliases, category, metadata, created_at "
            f"FROM we_geo_brands WHERE {' AND '.join(where)}"
        ),
        params,
    ).mappings().first()
    return _row_to_brand(row) if row else None


def list_brands(s: Session, *, customer_id: int, limit: int = 100) -> list[GeoBrand]:
    rows = s.execute(
        text(
            "SELECT id, customer_id, brand_name, brand_aliases, category, metadata, created_at "
            "FROM we_geo_brands WHERE customer_id = :cid "
            "ORDER BY created_at DESC LIMIT :limit"
        ),
        {"cid": customer_id, "limit": limit},
    ).mappings().all()
    return [_row_to_brand(r) for r in rows]


def update_brand(s: Session, brand_id: int, *,
                 customer_id: int, data: GeoBrandUpdate) -> GeoBrand | None:
    """改品牌 (CAS 校验 customer_id · 防越权)"""
    updates: list[str] = []
    params: dict = {"id": brand_id, "cid": customer_id}
    if data.brand_aliases is not None:
        updates.append("brand_aliases = CAST(:aliases AS JSONB)")
        params["aliases"] = _to_json(data.brand_aliases)
    if data.category is not None:
        updates.append("category = :cat")
        params["cat"] = data.category
    if data.metadata is not None:
        updates.append("metadata = CAST(:meta AS JSONB)")
        params["meta"] = _to_json(data.metadata)
    if not updates:
        return get_brand(s, brand_id, customer_id=customer_id)
    row = s.execute(
        text(
            f"UPDATE we_geo_brands SET {', '.join(updates)} "
            "WHERE id = :id AND customer_id = :cid "
            "RETURNING id, customer_id, brand_name, brand_aliases, category, metadata, created_at"
        ),
        params,
    ).mappings().first()
    return _row_to_brand(row) if row else None


def delete_brand(s: Session, brand_id: int, *, customer_id: int) -> bool:
    """删品牌 (CAS) · 注意级联到 we_geo_observations (FK)"""
    result = s.execute(
        text("DELETE FROM we_geo_brands WHERE id = :id AND customer_id = :cid"),
        {"id": brand_id, "cid": customer_id},
    )
    return result.rowcount > 0


# ════════════════════════════════════════════════════════════════
# helpers
# ════════════════════════════════════════════════════════════════
def _to_json(obj) -> str:
    import json as _json
    return _json.dumps(obj or [] if isinstance(obj, list) else obj or {})


def _row_to_brand(row) -> GeoBrand:
    import json as _json
    aliases = row["brand_aliases"]
    if isinstance(aliases, str):
        aliases = _json.loads(aliases)
    md = row["metadata"]
    if isinstance(md, str):
        md = _json.loads(md)
    return GeoBrand(
        id=row["id"],
        customer_id=row["customer_id"],
        brand_name=row["brand_name"],
        brand_aliases=aliases or [],
        category=row["category"],
        metadata=md or {},
        created_at=row["created_at"],
    )
