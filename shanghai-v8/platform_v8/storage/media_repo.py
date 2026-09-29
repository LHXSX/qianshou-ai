"""Durable media control metadata. All writes share the caller's transaction.

An ambiguous dispatch is reconciled, never resent. One workload can settle one
immutable result revision; a later delivery failure cannot allocate an attempt.
"""
from __future__ import annotations

from sqlalchemy import (Table, Column, String, Integer, BigInteger, JSON,
                        UniqueConstraint, select, insert, update)
from platform_v8.storage.repo import metadata

requests_t = Table(
    "we_media_requests", metadata,
    Column("workload_id", String(36), primary_key=True),
    Column("owner_id", BigInteger, nullable=False),
    Column("request_id", String(128), nullable=False),
    Column("spec_sha256", String(64), nullable=False),
    Column("quote_id", String(64), nullable=False),
    Column("authorization_id", String(36), nullable=False),
    Column("authorization", JSON, nullable=False),
    UniqueConstraint("owner_id", "request_id", name="we_media_request_owner_uq"),
)
attempts_t = Table(
    "we_media_attempts", metadata,
    Column("attempt_id", String(36), primary_key=True),
    Column("task_id", String(36), nullable=False, unique=True),
    Column("worker_id", String(36), nullable=False),
    Column("device_id", String(128), nullable=False),
    Column("worker_owner_id", BigInteger, nullable=False),
    Column("connection_epoch", BigInteger, nullable=False),
    Column("lease_epoch", Integer, nullable=False),
    Column("lease_expires_at", BigInteger, nullable=False),
    Column("envelope", JSON, nullable=False),
    Column("state", String(32), nullable=False),
    Column("event_sequence", BigInteger, nullable=False, default=0),
    Column("result_revision", String(128)),
)
outbox_t = Table(
    "we_media_outbox", metadata,
    Column("id", String(128), primary_key=True),
    Column("attempt_id", String(36), nullable=False),
    Column("operation", String(24), nullable=False),
    Column("payload", JSON, nullable=False),
    Column("state", String(24), nullable=False, default="pending"),
    Column("claimed_at", BigInteger, nullable=False, default=0),
)
events_t = Table(
    "we_media_events", metadata,
    Column("sequence", BigInteger, primary_key=True),
    Column("event_sha256", String(64), nullable=False),
    Column("payload", JSON, nullable=False),
    Column("disposition", String(32), nullable=False),
)
settlements_t = Table(
    "we_media_settlements", metadata,
    Column("workload_id", String(36), primary_key=True),
    Column("attempt_id", String(36), nullable=False, unique=True),
    Column("result_revision", String(128), nullable=False),
    Column("billable_result_revision", String(64), nullable=False, unique=True),
    Column("verdict_sha256", String(64), nullable=False),
    Column("receipt", JSON, nullable=False),
)
objects_t = Table(
    "we_media_objects", metadata,
    Column("id", String(128), primary_key=True),
    Column("account_id", BigInteger, nullable=False),
    Column("asset_id", String(36), nullable=False),
    Column("purpose", String(24), nullable=False),
    Column("object_key", String(1024), nullable=False, unique=True),
    Column("sha256", String(64), nullable=False),
    Column("size_bytes", BigInteger, nullable=False),
    Column("content_type", String(64), nullable=False),
    Column("declaration", JSON, nullable=False),
    Column("object_version_id", String(200)),
    Column("retention_until", BigInteger, nullable=False),
)


def row_dict(row):
    return dict(row._mapping) if row is not None else None


class MediaRepo:
    @staticmethod
    def request(s, owner_id, request_id):
        return row_dict(s.execute(select(requests_t).where(
            requests_t.c.owner_id == owner_id, requests_t.c.request_id == request_id
        ).with_for_update()).one_or_none())

    @staticmethod
    def request_by_task(s, task_id):
        return row_dict(s.execute(select(requests_t).where(
            requests_t.c.workload_id == task_id)).one_or_none())

    @staticmethod
    def attempt(s, task_id, *, lock=False):
        query = select(attempts_t).where(attempts_t.c.task_id == task_id)
        if lock:
            query = query.with_for_update()
        return row_dict(s.execute(query).one_or_none())

    @staticmethod
    def add_attempt(s, values):
        existing = MediaRepo.attempt(s, values["task_id"], lock=True)
        if existing:
            return existing  # never mutate the original device/lease/contract
        s.execute(insert(attempts_t).values(**values))
        MediaRepo.enqueue(s, values["attempt_id"], "dispatch", values["envelope"])
        return MediaRepo.attempt(s, values["task_id"])

    @staticmethod
    def enqueue(s, attempt_id, operation, payload):
        key = f"{attempt_id}:{operation}"
        existing = s.execute(select(outbox_t).where(outbox_t.c.id == key)).one_or_none()
        if existing:
            if existing.payload != payload:
                raise ValueError("media outbox immutable payload conflict")
            return key
        s.execute(insert(outbox_t).values(id=key, attempt_id=attempt_id,
                  operation=operation, payload=payload, state="pending", claimed_at=0))
        return key

    @staticmethod
    def claim(s, key, now):
        # One worker gets the send right. Crash after claim becomes UNKNOWN;
        # dispatch is never changed back to pending by a timeout/restart.
        return s.execute(update(outbox_t).where(outbox_t.c.id == key,
            outbox_t.c.state == "pending").values(state="sending", claimed_at=now)).rowcount == 1

    @staticmethod
    def pending_operations(s, now):
        return [row_dict(r) for r in s.execute(select(outbox_t).where(
            outbox_t.c.state.in_(["pending", "unknown", "sending"])
        ).order_by(outbox_t.c.id).limit(100))
        if r.state != "sending" or r.claimed_at < now - 30]

    @staticmethod
    def complete_operation(s, key, *, state):
        s.execute(update(outbox_t).where(outbox_t.c.id == key).values(state=state))

    @staticmethod
    def settlement(s, workload_id):
        return row_dict(s.execute(select(settlements_t).where(
            settlements_t.c.workload_id == workload_id)).one_or_none())
