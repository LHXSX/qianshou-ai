"""Read-only, fail-closed catalogue for independently reviewed order skills.

This production slice deliberately has no purchase, entitlement, install, or
admin routes. Shanghai only returns control-plane metadata; it never serves
package or media bytes. A future sale rollout needs separate acceptance.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session

router = APIRouter(prefix="/api/v8/order-adapter-products", tags=["order-adapter-products"])

_PUBLISHED = text("""
    SELECT p.id, p.publication_id, p.owner_id, p.sale_price_yuan,
           q.task_type, q.name, q.description, q.category, q.version,
           q.artifact_digest, q.package_digest
      FROM we_order_adapter_products AS p
      JOIN we_task_adapter_publications AS q ON q.id = p.publication_id
     WHERE p.status = 'published'
       AND q.status = 'approved'
       AND p.currency = 'CNY' AND q.currency = 'CNY'
       AND p.owner_id = q.owner_id
       AND p.reviewer_id IS NOT NULL AND p.reviewed_at IS NOT NULL
       AND q.reviewer_id IS NOT NULL AND q.reviewed_at IS NOT NULL
       AND q.review_fingerprint IS NOT NULL
       AND q.task_type = 'bar_chart_svg_v1'
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT 100
""")


@router.get("", summary="只读查看已独立审核上架的接单技能")
def list_order_adapter_products(response: Response,
                                session: Session = Depends(get_session)) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    items = []
    for row in session.execute(_PUBLISHED).mappings():
        price = Decimal(row["sale_price_yuan"])
        if price < 0 or price >= 1_000_000:
            continue
        items.append({
            "id": row["id"],
            "publication_id": row["publication_id"],
            "owner_id": row["owner_id"],
            "task_type": row["task_type"],
            "name": row["name"],
            "description": row["description"],
            "category": row["category"],
            "version": row["version"],
            "artifact_digest": row["artifact_digest"],
            "reviewed_seller_runtime_digest": row["package_digest"],
            "sale_price_yuan": f"{price:.2f}",
            "currency": "CNY",
            "status": "published",
            "available_to_purchase": False,
            "archive_digest": None,
            "archive_size_bytes": None,
        })
    return {"items": items}
