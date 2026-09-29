"""Audited, reversible listing visibility; never delete contracts or money history."""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (Boolean, CheckConstraint, Column, DateTime, Integer,
                        MetaData, String, Table, column, exists, insert, select,
                        table, text, update)
from sqlalchemy.orm import Session

from platform_v8.storage.repo import AuditRepo, shards_t, workloads_t

# Lightweight control-plane projections keep this module independent of signed
# package verification. The migration owns the physical FK and CHECK constraints.
publications = table("we_task_adapter_publications", column("id"), column("owner_id"),
                     column("name"), column("task_type"), column("status"),
                     column("artifact_digest"), column("updated_at"))
products = table("we_order_adapter_products", column("id"), column("publication_id"),
                 column("status"))
entitlements = table("we_order_adapter_entitlements", column("product_id"), column("status"))
states = Table(
    "we_task_adapter_publication_lifecycle", MetaData(),
    Column("publication_id", String(36), primary_key=True),
    Column("state", String(12), nullable=False, default="active"),
    Column("archived", Boolean, nullable=False, default=False),
    Column("revision", Integer, nullable=False, default=0),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    CheckConstraint("state IN ('active','withdrawn','delisted')"),
    CheckConstraint("revision >= 0"),
)
_TERMINAL = ("DONE", "FAILED", "CANCELLED")
_ACTIONS = ("withdraw", "delist", "archive", "restore")


class LifecycleError(ValueError):
    """Stable status/code for a client-safe lifecycle rejection."""
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status, self.code = status, code


def lock_task(s: Session, task_type: str) -> None:
    """Serialize order admission and hiding under the same transaction lock."""
    if s.get_bind().dialect.name == "postgresql":
        key = int.from_bytes(hashlib.sha256(
            ("publication-lifecycle:" + task_type).encode()).digest()[:8], "big", signed=True)
        s.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})


def active_clause(publication_id: Any) -> Any:
    return ~exists(select(states.c.publication_id).where(
        states.c.publication_id == publication_id,
        (states.c.state != "active") | states.c.archived))


def active(s: Session, publication_id: str) -> bool:
    return bool(s.execute(select(active_clause(publication_id))).scalar_one())


def require_active(s: Session, publication_id: str) -> None:
    if not active(s, publication_id):
        raise LifecycleError(409, "PUBLICATION_NOT_ACTIVE")


def product_admission(s: Session, product_id: str) -> None:
    row = s.execute(select(publications.c.id, publications.c.task_type).select_from(
        products.join(publications, products.c.publication_id == publications.c.id))
        .where(products.c.id == product_id)).mappings().first()
    if row is not None:
        lock_task(s, row["task_type"])
        require_active(s, row["id"])


def _state(s: Session, publication_id: str) -> dict[str, Any]:
    row = s.execute(select(states).where(states.c.publication_id == publication_id)).mappings().first()
    return dict(row) if row is not None else {"state": "active", "archived": False, "revision": 0}


def _blocking(s: Session, row: dict[str, Any]) -> list[str]:
    # Contracts are task-bound, so conservatively protect every live order for
    # this task, including unknown states and quarantined results.
    task = workloads_t.c.spec["task_type"].as_string() == row["task_type"]
    pending = s.execute(select(workloads_t.c.id).where(
        task, workloads_t.c.status.notin_(_TERMINAL)).limit(1)).first()
    shard = s.execute(select(shards_t.c.id).select_from(shards_t.join(
        workloads_t, shards_t.c.workload_id == workloads_t.c.id)).where(
            task, shards_t.c.status.notin_(_TERMINAL)).limit(1)).first()
    installing = s.execute(select(entitlements.c.product_id).select_from(
        entitlements.join(products, entitlements.c.product_id == products.c.id)).where(
            products.c.publication_id == row["id"],
            entitlements.c.status == "pending_install").limit(1)).first()
    return (["active-orders"] if pending is not None or shard is not None else []) + (
        ["pending-install"] if installing is not None else [])


def project(s: Session, row: dict[str, Any]) -> dict[str, Any]:
    state = _state(s, row["id"])
    reasons = _blocking(s, row)
    if state["archived"]:
        allowed = ["restore"]
    else:
        allowed = []
        if state["state"] == "active" and row["status"] == "review":
            allowed.append("withdraw")
        if not reasons:
            if state["state"] == "active" and row["status"] == "approved":
                allowed.append("delist")
            allowed.append("archive")
    return {"state": state["state"], "archived": bool(state["archived"]),
            "revision": state["revision"], "allowed_actions": allowed,
            "blocking_reasons": reasons}


def receipt(s: Session, row: dict[str, Any]) -> dict[str, Any]:
    product = s.execute(select(products.c.id, products.c.status).where(
        products.c.publication_id == row["id"])).mappings().first()
    lifecycle = project(s, row)
    return {"publication_id": row["id"], "owner_id": row["owner_id"],
            "name": row["name"], "task_type": row["task_type"], "status": row["status"],
            "artifact_digest": row["artifact_digest"],
            "market_product_id": product["id"] if product else None,
            "market_product_status": ("suspended" if lifecycle["state"] == "delisted"
                else product["status"]) if product else None,
            "lifecycle": lifecycle}


def managed(s: Session, *, owner_id: int | None = None,
            include_archived: bool = True) -> dict[str, Any]:
    query = select(publications)
    if owner_id is not None:
        query = query.where(publications.c.owner_id == owner_id)
    if not include_archived:
        query = query.where(~exists(select(states.c.publication_id).where(
            states.c.publication_id == publications.c.id, states.c.archived)))
    rows = s.execute(query.order_by(publications.c.updated_at.desc(), publications.c.id)
                     .limit(100)).mappings().all()
    return {"items": [receipt(s, dict(row)) for row in rows]}


def manage(s: Session, *, publication_id: str, actor_id: int, admin: bool,
           action: str, expected_revision: int, note: str) -> dict[str, Any]:
    if (action not in _ACTIONS or type(expected_revision) is not int
            or expected_revision < 0 or not isinstance(note, str) or not 1 <= len(note.strip()) <= 500):
        raise LifecycleError(400, "PUBLICATION_LIFECYCLE_INVALID")
    candidate = s.execute(select(publications).where(publications.c.id == publication_id))
    row = candidate.mappings().first()
    if row is None or (not admin and row["owner_id"] != actor_id):
        raise LifecycleError(404, "PUBLICATION_NOT_FOUND")
    lock_task(s, row["task_type"])
    row = dict(s.execute(select(publications).where(
        publications.c.id == publication_id).with_for_update()).mappings().one())
    state = _state(s, publication_id)
    if state["revision"] != expected_revision:
        raise LifecycleError(409, "PUBLICATION_LIFECYCLE_STALE")
    projected = project(s, row)
    if action not in projected["allowed_actions"]:
        code = ("PUBLICATION_ACTIVE_ORDERS" if "active-orders" in projected["blocking_reasons"]
                else "PUBLICATION_PENDING_INSTALL" if "pending-install" in projected["blocking_reasons"]
                else "PUBLICATION_ACTION_NOT_ALLOWED")
        raise LifecycleError(409, code)
    next_state = state["state"]
    archived = state["archived"]
    if action == "withdraw":
        next_state = "withdrawn"
    elif action == "delist":
        next_state = "delisted"
    elif action == "archive":
        archived = True
        if next_state == "active":
            next_state = "withdrawn" if row["status"] == "review" else "delisted"
    else:
        archived = False
    values = {"state": next_state, "archived": archived,
              "revision": expected_revision + 1, "updated_at": datetime.now(timezone.utc)}
    if expected_revision == 0:
        s.execute(insert(states).values(publication_id=publication_id, **values))
    else:
        changed = s.execute(update(states).where(states.c.publication_id == publication_id,
            states.c.revision == expected_revision).values(**values))
        if changed.rowcount != 1:
            raise LifecycleError(409, "PUBLICATION_LIFECYCLE_STALE")
    AuditRepo.write(s, action="task_adapter_publication.lifecycle." + action,
                    actor_account_id=actor_id, actor_kind="admin" if admin else "account",
                    target_kind="task_adapter_pub", target_id=publication_id,
                    detail={"note": note.strip(), "before": {"state": state["state"],
                            "archived": state["archived"], "revision": state["revision"]},
                            "after": {"state": next_state, "archived": archived,
                                      "revision": expected_revision + 1}})
    return receipt(s, row)
