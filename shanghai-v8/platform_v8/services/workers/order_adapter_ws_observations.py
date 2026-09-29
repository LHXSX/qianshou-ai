"""One-use challenge result observed on an authenticated worker WebSocket.

Shanghai stores only bounded hashes and session metadata. The independent
attestor checks this record against its own random input and sandbox output.
This proves an online worker answered a challenge, not physical disk state.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import (BigInteger, Column, DateTime, Index,
                        MetaData, String, Table, Uuid, insert, select)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from platform_v8.storage.repo import order_adapter_remote_challenges_t as challenges_t

metadata = MetaData()
_UUID_TEXT = Uuid(as_uuid=False).with_variant(String(36), "sqlite")
observations_t = Table(
    "we_order_adapter_ws_observations", metadata,
    Column("nonce", String(36), primary_key=True),
    Column("worker_id", _UUID_TEXT, nullable=False),
    Column("buyer_id", BigInteger, nullable=False),
    Column("connection_id", String(36), nullable=False),
    Column("input_digest", String(71), nullable=False),
    Column("output_digest", String(71), nullable=False),
    Column("runtime_digest", String(71), nullable=False),
    Column("artifact_digest", String(71), nullable=False),
    Column("observed_at", DateTime(timezone=True), nullable=False),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    Index("we_order_adapter_ws_observations_expiry_idx", "expires_at"),
)
_SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")


class ObservationError(ValueError):
    pass


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _uuid(value: Any) -> bool:
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def record_from_worker_ws(s: Session, *, worker_id: str, owner_id: int,
                          connection_id: str, payload: dict[str, Any]) -> None:
    """Record a single response only from the already authenticated WS loop."""
    if (not _uuid(worker_id) or type(owner_id) is not int or owner_id < 1
            or not _uuid(connection_id) or not isinstance(payload, dict)
            or set(payload) != {"challenge_nonce", "input_digest", "output_digest",
                                "runtime_digest", "artifact_digest"}
            or not _uuid(payload["challenge_nonce"])
            or any(not isinstance(payload[field], str)
                   or not _SHA.fullmatch(payload[field]) for field in (
                       "input_digest", "output_digest", "runtime_digest", "artifact_digest"))):
        raise ObservationError("worker challenge observation invalid")
    now = datetime.now(timezone.utc)
    challenge = s.execute(select(challenges_t).where(
        challenges_t.c.nonce == payload["challenge_nonce"]).with_for_update()).mappings().first()
    if (challenge is None or challenge["status"] != "issued"
            or challenge["worker_id"] != worker_id
            or challenge["buyer_id"] != owner_id
            or challenge["challenge_input_sha256"] != payload["input_digest"]
            or challenge["artifact_digest"] != payload["artifact_digest"]
            or _utc(challenge["expires_at"]) <= now
            or not isinstance(challenge["signed_plan"], dict)
            or not isinstance(challenge["signed_plan"].get("payload"), dict)
            or challenge["signed_plan"]["payload"].get("challenge_nonce") != payload["challenge_nonce"]):
        raise ObservationError("worker challenge is not issued for this online session")
    try:
        s.execute(insert(observations_t).values(
            nonce=payload["challenge_nonce"], worker_id=worker_id,
            buyer_id=owner_id, connection_id=connection_id,
            input_digest=payload["input_digest"], output_digest=payload["output_digest"],
            runtime_digest=payload["runtime_digest"], artifact_digest=payload["artifact_digest"],
            observed_at=now, expires_at=challenge["expires_at"],
        ))
    except IntegrityError as exc:
        raise ObservationError("worker challenge already observed") from exc


def read_for_attestor(s: Session, *, nonce: str, device_id: str) -> dict[str, Any] | None:
    """Return one recent record; no user task bytes or account token leave Shanghai."""
    if not _uuid(nonce) or not _uuid(device_id):
        return None
    row = s.execute(select(observations_t).where(
        observations_t.c.nonce == nonce,
        observations_t.c.worker_id == device_id)).mappings().first()
    if row is None or _utc(row["expires_at"]) <= datetime.now(timezone.utc):
        return None
    return {"schema": "qianshou.order-adapter-ws-observation.v1",
            "nonce": row["nonce"], "device_id": row["worker_id"],
            "input_digest": row["input_digest"], "output_digest": row["output_digest"],
            "runtime_digest": row["runtime_digest"],
            "installed_artifact_digest": row["artifact_digest"],
            "observed_at": int(_utc(row["observed_at"]).timestamp()),
            "session_bound": True}


def probe_storage(s: Session) -> bool:
    """Fail the attestor's live health check when the observation table is absent."""
    try:
        s.execute(select(observations_t.c.nonce).limit(1)).first()
        return True
    except Exception:
        return False
