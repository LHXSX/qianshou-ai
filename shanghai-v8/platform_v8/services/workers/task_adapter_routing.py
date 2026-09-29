"""Server-owned routing admission for reviewed task adapters.

The node's adapter advertisement is a compatibility observation, never an
authorization. An author needs the live approved publication; a buyer needs a
settled entitlement and an independently signed, device-bound remote challenge
record. This module does not treat a local self-test or an old install receipt
as a remote challenge pass.
"""
from __future__ import annotations

import re
from typing import Any
from uuid import UUID

from cryptography.exceptions import InvalidSignature
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from platform_v8.services.workers import order_adapter_products as products
from platform_v8.services.workers import task_adapter_publications as publications
from platform_v8.services.workers import task_adapters
from platform_v8.services.workers.task_adapters import matches
from platform_v8.storage.repo import (
    order_adapter_device_installs_t as installs_t,
    order_adapter_entitlements_t as entitlements_t,
    order_adapter_products_t as products_t,
    task_adapter_publications_t as publications_t,
)

_SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
_CHALLENGE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
_REMOTE_CHALLENGE_SCHEMA = "qianshou.order-adapter-remote-challenge.v1"
_RECEIPT_FIELDS = frozenset({
    "schema", "result", "entitlement_id", "product_id", "buyer_id",
    "publication_id", "device_id", "archive_digest", "archive_version_id",
    "artifact_digest", "reviewed_seller_runtime_digest", "runtime_digest",
    "challenge_nonce", "challenge_input_sha256", "challenge_result_sha256",
    "issued_at", "expires_at",
})


def _identity(worker: Any) -> tuple[str, int] | None:
    worker_id = getattr(worker, "id", None)
    owner_id = getattr(worker, "owner_id", None)
    if (not isinstance(worker_id, (str, UUID)) or not str(worker_id)
            or type(owner_id) is not int or owner_id < 1):
        return None
    return str(worker_id), owner_id


def _buyer_remote_challenge_passed(s: Session, *, worker_id: str,
                                   buyer_id: int, publication: dict[str, Any]) -> bool:
    candidate = s.execute(select(
        installs_t.c.signed_receipt, installs_t.c.runtime_digest,
        installs_t.c.receipt_key_id,
        entitlements_t.c.id.label("entitlement_id"),
        entitlements_t.c.status.label("entitlement_status"),
        products_t.c.id.label("product_id"),
        products_t.c.status.label("product_status"),
    ).select_from(installs_t.join(
        entitlements_t, installs_t.c.entitlement_id == entitlements_t.c.id
    ).join(products_t, entitlements_t.c.product_id == products_t.c.id)).where(
        installs_t.c.device_id == worker_id,
        installs_t.c.revoked_at.is_(None),
        entitlements_t.c.buyer_id == buyer_id,
        entitlements_t.c.status == "installed",
        products_t.c.publication_id == publication["id"],
        products_t.c.status == "published",
    ).limit(1)).mappings().first()
    if candidate is None:
        return False
    receipt = candidate["signed_receipt"]
    if (not isinstance(receipt, dict)
            or set(receipt) != {"key_id", "payload", "signature"}
            or not isinstance(receipt["key_id"], str)
            or not isinstance(receipt.get("payload"), dict)
            or set(receipt["payload"]) != _RECEIPT_FIELDS
            or receipt["key_id"] != candidate["receipt_key_id"]):
        return False
    key = products._install_roots().get(receipt["key_id"])
    if key is None:
        return False
    try:
        signed = publications._b64decode(receipt["signature"], 64)
        key.verify(signed, products._canonical(receipt["payload"]))
        product = products._get(s, candidate["product_id"])
        manifest, issues = products._issues(s, product, publication)
        if issues or manifest is None:
            return False
        payload = receipt["payload"]
        return bool(
            payload["schema"] == _REMOTE_CHALLENGE_SCHEMA
            and payload["result"] == "passed"
            and payload["entitlement_id"] == candidate["entitlement_id"]
            and payload["product_id"] == candidate["product_id"]
            and type(payload["buyer_id"]) is int and payload["buyer_id"] == buyer_id
            and payload["publication_id"] == publication["id"]
            and payload["device_id"] == worker_id
            and payload["archive_digest"] == manifest["archive_digest"]
            and payload["archive_version_id"] == manifest["archive_version_id"]
            and payload["artifact_digest"] == publication["artifact_digest"]
            and payload["reviewed_seller_runtime_digest"] == publication["package_digest"]
            and payload["runtime_digest"] == candidate["runtime_digest"]
            and isinstance(payload["runtime_digest"], str)
            and _SHA.fullmatch(payload["runtime_digest"])
            and isinstance(payload["challenge_nonce"], str)
            and _CHALLENGE.fullmatch(payload["challenge_nonce"])
            and isinstance(payload["challenge_input_sha256"], str)
            and _SHA.fullmatch(payload["challenge_input_sha256"])
            and isinstance(payload["challenge_result_sha256"], str)
            and _SHA.fullmatch(payload["challenge_result_sha256"])
            and type(payload["issued_at"]) is int
            and type(payload["expires_at"]) is int
            and 0 < payload["expires_at"] - payload["issued_at"] <= 600
        )
    except (InvalidSignature, KeyError, TypeError, ValueError):
        return False


def can_route_reviewed_adapter(s: Session, worker: Any, *, task_type: str,
                               input_kind: str, capability_id: str,
                               output_kind: str, renew_lock: bool = False) -> bool:
    """Require exact compatibility and one of two server-held supply rights.

    This is called by both PUSH selection and PULL assignment, and again on
    result admission. Exceptions fail closed at the call sites.
    """
    identity = _identity(worker)
    if identity is None or not task_type:
        return False
    worker_id, owner_id = identity
    adapters = task_adapters._field(task_adapters._capabilities(worker),
                                    "verified_task_adapters")
    if not isinstance(adapters, list) or len(adapters) > 128:
        return False
    # Advertisement metadata only narrows the search. Each candidate still
    # needs a live platform review and server-held author/buyer permission.
    advertised = set()
    for adapter in adapters:
        if (not isinstance(adapter, dict) or adapter.get("task_type") != task_type
                or adapter.get("capability_id") != capability_id
                or adapter.get("output_kind") != output_kind
                or not isinstance(adapter.get("input_kinds"), list)
                or input_kind not in adapter["input_kinds"]):
            continue
        artifact = adapter.get("artifact_digest")
        package = adapter.get("package_digest")
        contract = adapter.get("contract_version")
        if (isinstance(artifact, str) and _SHA.fullmatch(artifact)
                and isinstance(package, str) and _SHA.fullmatch(package)
                and isinstance(contract, str) and len(contract) <= 8):
            advertised.add((artifact, package, contract))
    buyer_publications = select(products_t.c.publication_id).select_from(
        products_t.join(entitlements_t,
                        entitlements_t.c.product_id == products_t.c.id).join(
            installs_t, installs_t.c.entitlement_id == entitlements_t.c.id)
    ).where(
        products_t.c.status == "published",
        entitlements_t.c.status == "installed",
        entitlements_t.c.buyer_id == owner_id,
        installs_t.c.device_id == worker_id,
        installs_t.c.revoked_at.is_(None),
    )
    for artifact, package, contract in advertised:
        rows = s.execute(select(publications_t).where(
            publications_t.c.task_type == task_type,
            publications_t.c.status == "approved",
            publications_t.c.capability_id == capability_id,
            publications_t.c.output_kind == output_kind,
            publications_t.c.contract_version == contract,
            publications_t.c.artifact_digest == artifact,
            publications_t.c.package_digest == package,
            or_(publications_t.c.owner_id == owner_id,
                publications_t.c.id.in_(buyer_publications)),
        )).mappings().all()
        for row in rows:
            publication = dict(row)
            if (not isinstance(publication["input_kinds"], list)
                    or input_kind not in publication["input_kinds"]
                    or not matches(worker, task_type=task_type, input_kind=input_kind,
                                   require_verified=True, capability_id=capability_id,
                                   output_kind=output_kind,
                                   contract_version=publication["contract_version"],
                                   artifact_digest=publication["artifact_digest"],
                                   package_digest=publication["package_digest"])):
                continue
            definition = publication.get("task_definition")
            native_source = bool(isinstance(definition, dict)
                and isinstance(definition.get("nativeBinding"), dict)
                and definition["nativeBinding"].get("runtimeAbi") in ("qianshou.order-runtime.native-h3.v1", "qianshou.order-runtime.native-h3.v2"))
            if native_source:
                from platform_v8.services.workers.native_h3_bindings import authorized_native_device
                if publication["contract_version"] == "v2":
                    from platform_v8.services.workers.native_h3_bindings_v2 import authorized_native_device
                if not authorized_native_device(s, publication=publication,
                        worker_id=worker_id, owner_id=owner_id):
                    continue
            file_source = bool(getattr(publications._spec_for_row(publication), "adapter_file_schema", None))
            if file_source:
                from platform_v8.services.workers.file_device_attestation import authorized_file_device, request_binding
                if not authorized_file_device(s, worker=worker, publication=publication,
                        contract_sha256=request_binding(publication)["contract_sha256"]):
                    continue
            if (not native_source and not file_source and owner_id != publication["owner_id"]
                    and not _buyer_remote_challenge_passed(
                        s, worker_id=worker_id, buyer_id=owner_id,
                        publication=publication)):
                continue
            state = publications.readiness_for_publication(
                s, publication["id"], renew_lock=renew_lock)
            if state["ready"] and state["publication_id"] == publication["id"]:
                return True
    return False
