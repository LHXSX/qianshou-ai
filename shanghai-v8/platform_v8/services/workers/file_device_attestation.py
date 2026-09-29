"""Separately purpose-pinned file device proof; author rights and self-tests cannot replace it."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
from urllib.parse import urlsplit
from uuid import uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from sqlalchemy import select

from platform_v8.protocol.generic_file import FILE_ABI, FILE_POLICY, canonical, file_schema_sha256
from platform_v8.services.workers import order_adapter_products as products
from platform_v8.services.workers import task_adapter_publications as publications
from platform_v8.services.workers.task_adapter_review_issuer import task_contract_sha256
from platform_v8.storage.repo import (order_adapter_device_installs_t as installs_t,
    order_adapter_entitlements_t as entitlements_t, order_adapter_products_t as products_t,
    order_adapter_remote_challenges_t as challenges_t)

PURPOSE = "qianshou:file-device-attestor"
REQUEST_SCHEMA = "qianshou.order-adapter-file-challenge-request.v1"
PLAN_SCHEMA = "qianshou.order-adapter-file-challenge-plan.v1"
RECEIPT_SCHEMA = "qianshou.order-adapter-file-challenge.v1"
HEALTH_SCHEMA = "qianshou.file-device-attestor-health.v1"
_SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
_BINDING_BASE = {"schema", "purpose", "verification_policy", "contract_sha256", "file_schema_sha256", "file_schema"}
_BINDING_PROOF = {"attachment_manifest_sha256", "output_manifest_sha256", "file_bytes_verified"}


def request_binding(publication: dict) -> dict:
    spec = publications._spec_for_row(publication)
    if spec is None or not spec.adapter_file_schema:
        raise ValueError("publication has no reviewed file ABI")
    return {"schema": FILE_ABI, "purpose": PURPOSE, "verification_policy": FILE_POLICY,
            "contract_sha256": task_contract_sha256(publication, spec),
            "file_schema_sha256": file_schema_sha256(spec.adapter_file_schema), "file_schema": spec.adapter_file_schema}


def validate_binding(publication: dict, binding: object, *, proof: bool) -> bool:
    try:
        expected = request_binding(publication)
        return bool(isinstance(binding, dict) and set(binding) == _BINDING_BASE | (_BINDING_PROOF if proof else set())
                    and all(binding[key] == value for key, value in expected.items())
                    and (not proof or (binding["file_bytes_verified"] is True
                         and all(isinstance(binding[key], str) and _SHA.fullmatch(binding[key])
                                 for key in ("attachment_manifest_sha256", "output_manifest_sha256")))))
    except (TypeError, ValueError):
        return False


def file_install_roots() -> dict[str, Ed25519PublicKey]:
    """Only public deployment roots; reject reuse of a normal install or result-byte key."""
    try:
        raw = os.getenv("V8_ORDER_ADAPTER_FILE_INSTALL_RECEIPT_ROOTS", "")
        if not raw or len(raw) > 8192:
            return {}
        rows = json.loads(raw)
        if not isinstance(rows, dict) or not 1 <= len(rows) <= 8:
            return {}
        seen = {key.public_bytes(Encoding.Raw, PublicFormat.Raw) for key in products._install_roots().values()}
        byte_public = os.getenv("V8_EXTERNAL_FILE_VERIFIER_PUBLIC_KEY", "")
        if byte_public:
            seen.add(publications._b64decode(byte_public, 32))
        roots = {}
        for key_id, encoded in rows.items():
            if not isinstance(key_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", key_id):
                return {}
            public = publications._b64decode(encoded, 32)
            if public in seen:
                return {}
            seen.add(public)
            roots[key_id] = Ed25519PublicKey.from_public_bytes(public)
        return roots
    except (TypeError, ValueError):
        return {}


def signed_file_payload(envelope: object, fields: set | frozenset) -> dict:
    if (not isinstance(envelope, dict) or set(envelope) != {"key_id", "payload", "signature"}
            or not isinstance(envelope.get("payload"), dict)
            or set(envelope["payload"]) != set(fields) | {"file_binding"}
            or len(canonical(envelope)) > 8192):
        raise ValueError("file device receipt fields invalid")
    key = file_install_roots().get(envelope["key_id"])
    if key is None:
        raise ValueError("file device purpose signer not enrolled")
    try:
        key.verify(publications._b64decode(envelope["signature"], 64), canonical(envelope["payload"]))
    except (InvalidSignature, ValueError, TypeError) as exc:
        raise ValueError("file device signature invalid") from exc
    return envelope["payload"]


def file_attestor_config():
    from platform_v8.services.external_media_verifier import _Config
    roots = file_install_roots()
    url = os.getenv("V8_ORDER_ADAPTER_FILE_INSTALL_ATTESTOR_URL", "").rstrip("/")
    token = os.getenv("V8_ORDER_ADAPTER_FILE_INSTALL_ATTESTOR_TOKEN", "")
    key_id = os.getenv("V8_ORDER_ADAPTER_FILE_INSTALL_ATTESTOR_KEY_ID", "")
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.port not in {None, 443}
                or len(url) > 2048 or not 32 <= len(token) <= 2048 or key_id not in roots):
            return None
        return _Config(url, token, key_id, roots[key_id], None)
    except ValueError:
        return None


def file_attestor_ready() -> bool:
    from platform_v8.services.external_media_verifier import _post, _signed_payload
    config = file_attestor_config()
    if config is None:
        return False
    nonce = str(uuid4())
    try:
        payload = _signed_payload(config, _post(config, "/health", {
            "schema": "qianshou.order-adapter-attestor-health-request.v1", "nonce": nonce}),
            schema=HEALTH_SCHEMA, nonce=nonce)
        return bool(payload.get("purpose") == PURPOSE and payload.get("schema") == HEALTH_SCHEMA
                    and payload.get("status") == "ready" and payload.get("file_abi") == FILE_ABI
                    and payload.get("verification_policy") == FILE_POLICY
                    and payload.get("challenge_schema") == RECEIPT_SCHEMA
                    and isinstance(payload.get("checks"), dict)
                    and all(payload["checks"].get(key) is True for key in (
                        "pinned_archive_verified", "randomized_node_execution", "independent_result_verified",
                        "online_node_bound", "receipt_signing_ready")))
    except Exception:
        return False


def authorized_file_device(session, *, worker, publication: dict, contract_sha256: str) -> bool:
    """Same path for a paid buyer and an author zero-price entitlement; no owner shortcut."""
    try:
        if request_binding(publication)["contract_sha256"] != contract_sha256:
            return False
        rows = session.execute(select(installs_t.c.signed_receipt, installs_t.c.runtime_digest,
            installs_t.c.receipt_key_id, installs_t.c.entitlement_id,
            products_t.c.id.label("product_id")).select_from(installs_t.join(entitlements_t,
                installs_t.c.entitlement_id == entitlements_t.c.id).join(products_t,
                entitlements_t.c.product_id == products_t.c.id)).where(
            installs_t.c.device_id == str(worker.id), installs_t.c.revoked_at.is_(None),
            entitlements_t.c.buyer_id == int(worker.owner_id), entitlements_t.c.status == "installed",
            products_t.c.publication_id == publication["id"], products_t.c.status == "published")).mappings().all()
        from platform_v8.services.workers.order_adapter_remote_challenges import _RECEIPT_FIELDS
        for row in rows:
            receipt = row["signed_receipt"]
            payload = signed_file_payload(receipt, _RECEIPT_FIELDS)
            if (payload["schema"] != RECEIPT_SCHEMA or payload["result"] != "passed"
                    or not validate_binding(publication, payload["file_binding"], proof=True)
                    or payload["entitlement_id"] != row["entitlement_id"]
                    or payload["product_id"] != row["product_id"] or payload["buyer_id"] != worker.owner_id
                    or payload["publication_id"] != publication["id"] or payload["device_id"] != str(worker.id)
                    or payload["runtime_digest"] != row["runtime_digest"]
                    or receipt["key_id"] != row["receipt_key_id"]
                    or payload["artifact_digest"] != publication["artifact_digest"]
                    or payload["reviewed_seller_runtime_digest"] != publication["package_digest"]):
                continue
            product = products._get(session, row["product_id"])
            manifest, issues = products._issues(session, product, publication)
            if (issues or manifest is None or payload["archive_digest"] != manifest["archive_digest"]
                    or payload["archive_version_id"] != manifest["archive_version_id"]):
                continue
            consumed = session.execute(select(challenges_t).where(
                challenges_t.c.nonce == payload["challenge_nonce"], challenges_t.c.status == "passed",
                challenges_t.c.entitlement_id == row["entitlement_id"], challenges_t.c.worker_id == str(worker.id),
                challenges_t.c.receipt_sha256 == "sha256:" + hashlib.sha256(canonical(receipt)).hexdigest()
            )).mappings().first()
            if consumed is not None:
                return True
        return False
    except (ValueError, TypeError, KeyError):
        return False
