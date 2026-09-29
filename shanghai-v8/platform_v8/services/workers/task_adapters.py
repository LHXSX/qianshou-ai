"""Exact task adapter gate for nodes opting in to ``task-adapters.v1``.

An installed skill or plugin is only a local inventory item.  The node may
advertise an adapter after it has loaded the implementation and run its own
bounded contract fixture.  This is a node attestation, not a platform result
receipt: result verification and settlement remain separate gates.

Only control metadata is exchanged here.  File input references and artifact
bytes stay on the existing node/storage path, never in this advertisement.
Legacy workers that do not opt in retain their existing planner path.
"""
from __future__ import annotations

import re
from typing import Any


PROTOCOL = "task-adapters.v1"
INPUT_KINDS = frozenset({
    "inline", "single_file", "multi_file", "archive", "stream", "params_only",
})
OUTPUT_KINDS = frozenset({
    "inline_json", "inline_text", "artifact_ref", "artifact_manifest",
})
_TASK_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]{0,99}\Z")
_CAPABILITY_NAME = re.compile(r"[a-z][a-z0-9_.-]{0,99}\Z")
_CONTRACT_VERSION = re.compile(r"v[1-9][0-9]{0,3}\Z")
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
_HEALTHY = frozenset({"healthy", "ok", "ready", "loaded", "available", "warm"})


def _capabilities(worker: Any) -> Any:
    if isinstance(worker, dict):
        return worker.get("capabilities") or {}
    return getattr(worker, "capabilities", None)


def _field(capabilities: Any, name: str) -> Any:
    if isinstance(capabilities, dict):
        return capabilities.get(name)
    return getattr(capabilities, name, None)


def opted_in(worker: Any) -> bool:
    """The extra token does not alter the existing result-protocol profile."""
    tokens = _field(_capabilities(worker), "protocol_capabilities")
    return isinstance(tokens, (list, tuple)) and PROTOCOL in tokens


def _advertises_capability(capabilities: Any, capability_id: str) -> bool:
    ads = _field(capabilities, "provided_capabilities")
    if not isinstance(ads, (list, tuple)):
        return False
    for ad in ads[:128]:
        if isinstance(ad, str):
            if ad == capability_id:
                return True
            continue
        if not isinstance(ad, dict) or ad.get("name") != capability_id:
            continue
        if str(ad.get("health") or "").lower() in _HEALTHY:
            return True
    return False


def _valid_adapter(adapter: Any, capabilities: Any) -> bool:
    if not isinstance(adapter, dict):
        return False
    task_type = adapter.get("task_type")
    capability_id = adapter.get("capability_id")
    input_kinds = adapter.get("input_kinds")
    output_kind = adapter.get("output_kind")
    contract_version = adapter.get("contract_version")
    digest = adapter.get("artifact_digest")
    package_digest = adapter.get("package_digest")
    if not isinstance(task_type, str) or not _TASK_NAME.fullmatch(task_type):
        return False
    if not isinstance(capability_id, str) or not _CAPABILITY_NAME.fullmatch(capability_id):
        return False
    if not _advertises_capability(capabilities, capability_id):
        return False
    if (
        not isinstance(input_kinds, list) or not 1 <= len(input_kinds) <= len(INPUT_KINDS)
        or any(not isinstance(kind, str) or kind not in INPUT_KINDS for kind in input_kinds)
        or len(set(input_kinds)) != len(input_kinds)
    ):
        return False
    if not isinstance(output_kind, str) or output_kind not in OUTPUT_KINDS:
        return False
    if not isinstance(contract_version, str) or not _CONTRACT_VERSION.fullmatch(contract_version):
        return False
    if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
        return False
    if package_digest is not None and (
        not isinstance(package_digest, str) or not _DIGEST.fullmatch(package_digest)
    ):
        return False
    install_state = adapter.get("installation_state")
    return (
        isinstance(install_state, str) and install_state in {"installed", "builtin"}
        and adapter.get("health") == "verified"
        and adapter.get("self_test") == "passed"
    )


def matches(
    worker: Any,
    *,
    task_type: str,
    input_kind: str,
    require_verified: bool = False,
    capability_id: str = "",
    output_kind: str = "",
    contract_version: str = "",
    artifact_digest: str = "",
    package_digest: str = "",
) -> bool:
    """Fail closed for an opted-in node unless one exact, healthy adapter fits.

    Package source and ownership are intentionally absent: purchased, imported,
    and authored implementations use the same execution proof.  Owner permission
    remains a live local admission decision and the existing heartbeat pause.
    """
    if not opted_in(worker):
        return not require_verified
    if require_verified and (
        not _DIGEST.fullmatch(artifact_digest)
        or not _DIGEST.fullmatch(package_digest)
    ):
        return False
    if not task_type or input_kind not in INPUT_KINDS:
        return False
    capabilities = _capabilities(worker)
    adapters = _field(capabilities, "verified_task_adapters")
    if not isinstance(adapters, list) or len(adapters) > 128:
        return False
    return any(
        _valid_adapter(adapter, capabilities)
        and adapter["task_type"] == task_type
        and (not capability_id or adapter["capability_id"] == capability_id)
        and input_kind in adapter["input_kinds"]
        and (not output_kind or adapter["output_kind"] == output_kind)
        and (not contract_version or adapter["contract_version"] == contract_version)
        and (not artifact_digest or adapter["artifact_digest"] == artifact_digest)
        and (not package_digest or adapter.get("package_digest") == package_digest)
        for adapter in adapters
    )
