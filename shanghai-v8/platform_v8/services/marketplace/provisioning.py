"""Marketplace device provision receipts.

Account entitlement (`we_installs`) and node installation are separate states.
Only an authenticated worker's matching ``control_result`` confirms the latter.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import insert, select, update
from sqlalchemy.orm import Session

from platform_v8.storage.repo import app_provisions_t

_ACTIONS = frozenset({"install_app", "uninstall_app"})
_AWAITING_RESULT = ("pending", "delivered", "delivery_failed")


def create_attempt(
    s: Session, *, control_id: str, user_id: int, worker_id: str,
    slug: str, version: str | None, action: str,
) -> None:
    if action not in _ACTIONS:
        raise ValueError(f"invalid marketplace control action: {action}")
    s.execute(insert(app_provisions_t).values(
        control_id=control_id,
        user_id=user_id,
        worker_id=worker_id,
        slug=slug,
        version=version,
        action=action,
        status="pending",
        delivered=None,
        result_ok=None,
        detail="",
    ))
    s.flush()


def record_delivery(s: Session, *, control_id: str, delivered: bool) -> None:
    """Record transport delivery only; never overwrite a quicker node result."""
    s.execute(
        update(app_provisions_t)
        .where(
            app_provisions_t.c.control_id == control_id,
            app_provisions_t.c.status == "pending",
        )
        .values(
            status="delivered" if delivered else "delivery_failed",
            delivered=delivered,
            updated_at=datetime.utcnow(),
        )
    )


def record_result(
    s: Session, *, worker_id: str, control_id: str,
    action: str, ok: bool, detail: str = "",
) -> bool:
    """Accept a result once, only for its original worker and action."""
    if action not in _ACTIONS:
        return False
    now = datetime.utcnow()
    status = ("installed" if action == "install_app" else "removed") if ok else "failed"
    changed = s.execute(
        update(app_provisions_t)
        .where(
            app_provisions_t.c.control_id == control_id,
            app_provisions_t.c.worker_id == worker_id,
            app_provisions_t.c.action == action,
            app_provisions_t.c.status.in_(_AWAITING_RESULT),
            app_provisions_t.c.result_ok.is_(None),
        )
        .values(
            status=status,
            delivered=True,
            result_ok=bool(ok),
            detail=(detail or "")[:2000],
            updated_at=now,
            completed_at=now,
        )
    ).rowcount
    return changed == 1


def record_result_from_worker(
    worker_id: str, control_id: str, action: str, ok: bool, detail: str = "",
) -> bool:
    """WS thread entry point; commit before reporting the receipt as accepted."""
    from platform_v8.storage.db import session_scope

    with session_scope() as s:
        accepted = record_result(
            s, worker_id=worker_id, control_id=control_id,
            action=action, ok=ok, detail=detail,
        )
        s.commit()
        return accepted


def get_attempt(s: Session, *, control_id: str, user_id: int) -> dict | None:
    row = s.execute(
        select(app_provisions_t).where(
            app_provisions_t.c.control_id == control_id,
            app_provisions_t.c.user_id == user_id,
        )
    ).mappings().first()
    if row is None:
        return None
    return {
        "control_id": row["control_id"],
        "worker_id": row["worker_id"],
        "slug": row["slug"],
        "version": row["version"],
        "action": row["action"],
        "status": row["status"],
        "delivered": row["delivered"],
        "result_ok": row["result_ok"],
        "device_installed": row["status"] == "installed",
        "detail": row["detail"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
    }
