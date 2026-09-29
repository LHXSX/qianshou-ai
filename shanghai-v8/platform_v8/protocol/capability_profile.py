"""Single source of truth for worker result-protocol capabilities.

Profiles describe verified wire behaviour, not client releases.  Explicit
hello capabilities seed a new negotiated session; historical clients start at
the minimum compatible profile and can only move upward after server-validated
frames are observed.
"""
from __future__ import annotations

from enum import Enum
from typing import Iterable


class CapabilityProfile(str, Enum):
    UNSUPPORTED = "unsupported"
    LEGACY_INLINE = "legacy_inline"
    LEGACY_OWNED_REF = "legacy_owned_ref"
    LEASE_INLINE_V1 = "lease_inline_v1"
    SECURE_ARTIFACT_V1 = "secure_artifact_v1"


_RANK = {
    CapabilityProfile.UNSUPPORTED: 0,
    CapabilityProfile.LEGACY_INLINE: 1,
    CapabilityProfile.LEGACY_OWNED_REF: 2,
    CapabilityProfile.LEASE_INLINE_V1: 3,
    CapabilityProfile.SECURE_ARTIFACT_V1: 4,
}
_EXPLICIT = {profile.value: profile for profile in CapabilityProfile}
_SECURE_ALIASES = {
    "artifact.v1",
    "artifact_v1",
    "result.artifact.v1",
    "result_artifact_v1",
}
_LEASE_ALIASES = {
    "assignment-token.v1",
    "lease.v1",
    "lease_token",
    "lease_token_v1",
    "progress_lease.v1",
    "result.lease.v1",
}


def parse_profile(value: object) -> CapabilityProfile:
    if isinstance(value, CapabilityProfile):
        return value
    return _EXPLICIT.get(
        str(value or "").strip().lower(),
        CapabilityProfile.UNSUPPORTED,
    )


def profile_from_hello(
    protocol_capabilities: Iterable[object] | None,
) -> CapabilityProfile:
    """Resolve only declared protocol facts; never inspect client_version.

    Missing capabilities identify the historical protocol baseline.  A present
    but unknown/conflicting declaration is fail-safe ``unsupported``.
    """
    if protocol_capabilities is None:
        return CapabilityProfile.LEGACY_INLINE
    tokens = {
        str(item or "").strip().lower()
        for item in protocol_capabilities
        if str(item or "").strip()
    }
    explicit = {_EXPLICIT[token] for token in tokens if token in _EXPLICIT}
    explicit.discard(CapabilityProfile.UNSUPPORTED)
    if len(explicit) > 1:
        return CapabilityProfile.UNSUPPORTED
    if len(explicit) == 1:
        return next(iter(explicit))
    if tokens & _SECURE_ALIASES and tokens & _LEASE_ALIASES:
        return CapabilityProfile.SECURE_ARTIFACT_V1
    if tokens & _LEASE_ALIASES:
        return CapabilityProfile.LEASE_INLINE_V1
    return CapabilityProfile.UNSUPPORTED


def merge_observation(
    current: object,
    observed: object,
) -> CapabilityProfile:
    """Idempotent monotonic merge of server-validated observations."""
    current_profile = parse_profile(current)
    observed_profile = parse_profile(observed)
    if _RANK[observed_profile] <= _RANK[current_profile]:
        return current_profile
    return observed_profile


def is_legacy_profile(value: object) -> bool:
    return parse_profile(value) in {
        CapabilityProfile.LEGACY_INLINE,
        CapabilityProfile.LEGACY_OWNED_REF,
    }


def observation_for_legacy_shape(shape: object) -> CapabilityProfile:
    value = getattr(shape, "value", shape)
    if str(value) in {"result_object_key", "result_oss_url"}:
        return CapabilityProfile.LEGACY_OWNED_REF
    return CapabilityProfile.LEGACY_INLINE
