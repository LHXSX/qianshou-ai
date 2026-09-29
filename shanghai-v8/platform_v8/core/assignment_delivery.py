"""Immutable evidence that an assignment reached a server-owned connection."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass(frozen=True)
class AssignmentDelivery:
    id: int
    shard_id: str
    workload_id: str
    worker_id: str
    attempt: int
    connection_id: str
    mode: str
    client_version: str = ""
    client_build: str = ""
    protocol_capabilities: list[str] = field(default_factory=list)
    assignment_manifest: dict[str, Any] = field(default_factory=dict)
    delivered_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc),
    )

    def protocol_metadata(self) -> dict[str, Any]:
        return {
            "client_version": self.client_version,
            "client_build": self.client_build,
            "protocol_capabilities": list(self.protocol_capabilities),
            "assignment_manifest": dict(self.assignment_manifest),
        }
