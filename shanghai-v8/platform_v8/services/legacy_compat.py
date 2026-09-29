"""Feature gates for the bounded legacy result compatibility path."""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from enum import Enum
from typing import Any


ACCEPT_FLAG = "legacy_result_adapter_accept"
SETTLE_FLAG = "legacy_result_adapter_settle"
KILL_FLAG = "legacy_result_adapter_kill_switch"


class GateMode(str, Enum):
    OFF = "off"
    SHADOW = "shadow"
    ON = "on"


@dataclass(frozen=True)
class GateDecision:
    name: str
    mode: GateMode
    worker_id: str
    bucket: int
    rollout_pct: int
    source: str

    @property
    def allows(self) -> bool:
        return self.mode == GateMode.ON and self.bucket < self.rollout_pct

    def audit(self) -> dict[str, Any]:
        return {
            "gate": self.name,
            "mode": self.mode.value,
            "bucket": self.bucket,
            "rollout_pct": self.rollout_pct,
            "source": self.source,
            "allowed": self.allows,
        }


def stable_worker_bucket(worker_id: object) -> int:
    raw = str(worker_id or "").encode("utf-8")
    return int.from_bytes(hashlib.sha256(raw).digest()[:8], "big") % 100


def _bool_env(name: str) -> bool | None:
    raw = os.getenv(name)
    if raw is None:
        return None
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on", "enabled"}:
        return True
    if value in {"0", "false", "no", "off", "disabled", ""}:
        return False
    return None


def kill_switch_active(*, session: Any = None) -> bool:
    env_name = "V8_LEGACY_RESULT_ADAPTER_KILL_SWITCH"
    if os.getenv(env_name) is not None:
        env = _bool_env(env_name)
        return True if env is None else env
    try:
        from platform_v8.services.ops import feature_flags

        flag = feature_flags.get_flag(KILL_FLAG, session=session)
    except Exception:
        flag = None
    return bool(flag is not None and flag.enabled)


def _parse_env_gate(raw: str) -> tuple[GateMode, int] | None:
    value = raw.strip().lower()
    if value in {"off", "false", "disabled", "0"}:
        return GateMode.OFF, 0
    if value in {"shadow", "observe"}:
        return GateMode.SHADOW, 100
    if value in {"on", "true", "enabled", "1", "100"}:
        return GateMode.ON, 100
    try:
        pct = max(0, min(100, int(value.rstrip("%"))))
    except ValueError:
        return None
    return (GateMode.ON if pct > 0 else GateMode.OFF), pct


def gate_decision(
    name: str,
    worker_id: object,
    *,
    session: Any = None,
) -> GateDecision:
    worker = str(worker_id or "")
    bucket = stable_worker_bucket(worker)
    if kill_switch_active(session=session):
        return GateDecision(
            name=name,
            mode=GateMode.OFF,
            worker_id=worker,
            bucket=bucket,
            rollout_pct=0,
            source="kill_switch",
        )

    env_name = f"V8_{name.upper()}"
    raw = os.getenv(env_name)
    if raw is not None:
        parsed = _parse_env_gate(raw)
        if parsed is None:
            return GateDecision(
                name=name,
                mode=GateMode.OFF,
                worker_id=worker,
                bucket=bucket,
                rollout_pct=0,
                source="invalid_env",
            )
        mode, pct = parsed
        return GateDecision(name, mode, worker, bucket, pct, "env")

    try:
        from platform_v8.services.ops import feature_flags

        flag = feature_flags.get_flag(name, session=session)
    except Exception:
        flag = None
    if flag is None:
        # Compatibility is enabled by default; the kill switch remains an
        # independent fail-closed emergency control.
        return GateDecision(name, GateMode.ON, worker, bucket, 100, "default")
    mode_raw = str((flag.rollout_filter or {}).get("mode") or "").lower()
    if mode_raw == GateMode.SHADOW.value:
        mode = GateMode.SHADOW
    elif not flag.enabled:
        mode = GateMode.OFF
    else:
        mode = GateMode.ON
    pct = max(0, min(100, int(flag.rollout_pct or 0)))
    return GateDecision(name, mode, worker, bucket, pct, "feature_flag")


def accept_decision(worker_id: object, *, session: Any = None) -> GateDecision:
    return gate_decision(ACCEPT_FLAG, worker_id, session=session)


def settle_decision(worker_id: object, *, session: Any = None) -> GateDecision:
    return gate_decision(SETTLE_FLAG, worker_id, session=session)
