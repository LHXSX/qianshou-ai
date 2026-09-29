"""Authenticated, metadata-only feed of approved native H3 device proofs.

The account cannot manufacture a proof, choose another owner, restore an
archived publication or treat a local self-test as independent device evidence.
Only a separate configured Guangzhou service may deposit a purpose signature.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
from typing import Any, Mapping
from uuid import UUID

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import Column, Integer, JSON, MetaData, String, Table, insert, select, update
from sqlalchemy.orm import Session
from sqlalchemy import Uuid

from platform_v8.protocol.native_h3 import canonical
from platform_v8.protocol.native_h3_v2 import validate_definition
from .native_h3_device_configs import current_config
from .native_h3_bindings import _worker, current_connection_id, purpose_roots, proofs_t
from platform_v8.services.workers import task_adapter_publications as publications
from platform_v8.services.workers import publication_lifecycle as lifecycle
from platform_v8.storage.repo import task_adapter_publications_t, workers_t, accounts_t

SCHEMA = "qianshou.native-h3-device-proof.v2"
PURPOSE = "qianshou:native-h3-device-attestor.v2"
_FIELDS = {"schema", "purpose", "publication_id", "owner_id", "device_id", "task_type", "capability_id",
           "contract_version", "contract_sha256", "artifact_digest", "source_digest", "logical_binding_sha256", "local_owner_config_digest", "device_binding_revision",
           "challenge_nonce", "challenge_input_sha256", "challenge_result_sha256", "result",
           "publication_status", "installation_state", "issued_at", "expires_at"}
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_KEY = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
_WORKER = re.compile(r"[A-Za-z0-9._:-]{1,36}\Z")
_NONCE = re.compile(r"[A-Za-z0-9_-]{43}\Z")
_UUID_TEXT = Uuid(as_uuid=False).with_variant(String(36), "sqlite")
proof_metadata = MetaData()
proofs_t = Table("we_native_h3_device_proofs", proof_metadata,
    Column("publication_id", String(36), primary_key=True),
    Column("device_id", _UUID_TEXT, primary_key=True),
    Column("owner_id", Integer, nullable=False), Column("connection_id", String(36), nullable=False),
    Column("proof", JSON, nullable=False),
    Column("expires_at", Integer, nullable=False), Column("updated_at", Integer, nullable=False))


def _binary(value: Any, length: int) -> bytes:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value) or len(value) > 128:
        raise publications.PublicationError("原生设备回执签名编码无效")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if len(decoded) != length or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode() != value:
        raise publications.PublicationError("原生设备回执签名长度无效")
    return decoded


def binding_metadata(s, row: dict[str, Any], *, worker_id: str) -> dict[str, Any]:
    """Combine an immutable public execution identity with this enrolled device revision."""
    definition = validate_definition(row)
    b, key_id = current_config(s, row=row, worker_id=worker_id)
    return {**b, "device_key_id": key_id, "connection_id": current_connection_id(worker_id, owner_id=row["owner_id"]),
            "input_kinds": ["inline"], "output_kind": "artifact_ref",
            "input_contract": definition["inputContract"], "result_strategy": definition["resultStrategy"],
            "package_digest": "sha256:" + b["logical_binding_sha256"],
            "task_definition_sha256": hashlib.sha256(canonical(definition)).hexdigest(),
            "native_binding": definition["nativeBinding"]}


def verify_proof(envelope: Any, expected: Mapping[str, Any], roots: Mapping[str, Ed25519PublicKey], *, now: int) -> dict:
    """Verify all twenty fields against authenticated, approved current metadata."""
    try:
        if (not isinstance(envelope, dict) or set(envelope) != {"key_id", "payload", "signature"}
                or len(canonical(envelope)) > 16384 or envelope.get("key_id") not in roots
                or not isinstance(envelope.get("payload"), dict) or set(envelope["payload"]) != _FIELDS):
            raise ValueError("proof fields invalid")
        payload = envelope["payload"]
        roots[envelope["key_id"]].verify(_binary(envelope["signature"], 64), canonical(payload))
        _binary(payload.get("challenge_nonce"), 32)
        pinned = {"schema": SCHEMA, "purpose": PURPOSE, "result": "pass",
                  "publication_status": "approved", "installation_state": "installed",
                  **{key: expected[key] for key in ("publication_id", "owner_id", "device_id", "task_type",
                     "capability_id", "contract_version", "contract_sha256", "artifact_digest", "source_digest", "logical_binding_sha256", "local_owner_config_digest", "device_binding_revision")}}
        if (any(payload.get(key) != value for key, value in pinned.items())
                or type(payload.get("owner_id")) is not int
                or type(payload.get("device_binding_revision")) is not int
                or not 1 <= payload["device_binding_revision"] <= 9007199254740991
                or payload["contract_version"] != "v2"
                or not isinstance(payload.get("local_owner_config_digest"), str)
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", payload["local_owner_config_digest"])
                or not isinstance(payload.get("challenge_nonce"), str) or not _NONCE.fullmatch(payload["challenge_nonce"])
                or any(not isinstance(payload.get(key), str) or not _SHA.fullmatch(payload[key])
                       for key in ("contract_sha256", "logical_binding_sha256", "challenge_input_sha256", "challenge_result_sha256"))
                or type(payload.get("issued_at")) is not int or type(payload.get("expires_at")) is not int
                or payload["issued_at"] > now + 60 or payload["expires_at"] <= now
                or not 0 < payload["expires_at"] - payload["issued_at"] <= 300):
            raise ValueError("proof binding or freshness invalid")
        return envelope
    except (ValueError, KeyError, TypeError, InvalidSignature) as exc:
        raise publications.PublicationError("原生H3设备回执未绑定当前账号、设备和已审核制品") from exc


def current_bindings(s: Session, *, owner_id: int, worker_id: str) -> dict:
    """Only return current active approvals whose independent proof verifies now; never write on GET."""
    _worker(s, owner_id, worker_id)
    roots = purpose_roots()
    items = []
    if roots:
        rows = s.execute(select(task_adapter_publications_t).where(
            task_adapter_publications_t.c.owner_id == owner_id,
            task_adapter_publications_t.c.status == "approved",
            task_adapter_publications_t.c.contract_version == "v2")).mappings().all()
        for raw in rows:
            row = dict(raw)
            if not lifecycle.active(s, row["id"]):
                continue
            saved = s.execute(select(proofs_t).where(proofs_t.c.publication_id == row["id"],
                proofs_t.c.device_id == worker_id, proofs_t.c.owner_id == owner_id)).mappings().first()
            if saved is None or saved["expires_at"] <= int(time.time()) or saved["connection_id"] != current_connection_id(worker_id, owner_id=owner_id):
                continue
            try:
                binding = binding_metadata(s, row, worker_id=worker_id)
                if publications._issues(s, row, row["review_evidence"] or {}, reviewer_id=row["reviewer_id"],
                                         require_runtime_pin=True):
                    continue
                proof = verify_proof(saved["proof"], binding, roots, now=int(time.time()))
            except (ValueError, publications.PublicationError):
                continue
            items.append({**binding, "device_proof": proof})
    return {"schema": "qianshou.native-h3-order-bindings.v2", "owner_id": owner_id,
            "worker_id": worker_id, "bindings": items}


def deposit(s: Session, *, publication_id: str, receipt: Any) -> dict:
    """Service-only ingress; authenticated endpoint must not expose this operation to authors."""
    row = publications._get(s, publication_id, lock=True)
    if row["status"] != "approved" or not lifecycle.active(s, publication_id):
        raise publications.PublicationConflict("仅当前已审核制品可存入接单设备证明")
    payload = receipt.get("payload") if isinstance(receipt, dict) else None
    worker_id = payload.get("device_id") if isinstance(payload, dict) else None
    _worker(s, row["owner_id"], worker_id)
    expected = binding_metadata(s, row, worker_id=worker_id)
    verified = verify_proof(receipt, expected, purpose_roots(), now=int(time.time()))
    connection_id = current_connection_id(worker_id, owner_id=row["owner_id"])
    if connection_id is None:
        raise publications.PublicationConflict("接单设备当前认证连接已断开")
    exists = s.execute(select(proofs_t).where(proofs_t.c.publication_id == publication_id,
        proofs_t.c.device_id == worker_id)).mappings().first()
    values = {"owner_id": row["owner_id"], "connection_id": connection_id, "proof": verified,
              "expires_at": verified["payload"]["expires_at"], "updated_at": int(time.time())}
    if exists:
        s.execute(update(proofs_t).where(proofs_t.c.publication_id == publication_id,
            proofs_t.c.device_id == worker_id).values(**values))
    else:
        s.execute(insert(proofs_t).values(publication_id=publication_id, device_id=worker_id, **values))
    s.flush()
    return {"schema": "qianshou.native-h3-device-proof-deposit.v2", "publication_id": publication_id,
            "device_id": worker_id, "proof_sha256": hashlib.sha256(canonical(verified)).hexdigest()}


def authorized_native_device(s:Session, *,publication:dict,worker_id:str,owner_id:int)->bool:
    """Server supply gate shared by PUSH/PULL/result, independent of Hello claims."""
    try:
        if (publication['status']!='approved' or publication['owner_id']!=owner_id
                or not lifecycle.active(s,publication['id'])):
            return False
        _worker(s,owner_id,worker_id)
        connection=current_connection_id(worker_id,owner_id=owner_id)
        if connection is None:return False
        saved=s.execute(select(proofs_t).where(proofs_t.c.publication_id==publication['id'],
            proofs_t.c.device_id==worker_id,proofs_t.c.owner_id==owner_id)).mappings().first()
        if saved is None or saved['connection_id']!=connection:return False
        expected=binding_metadata(s, publication,worker_id=worker_id)
        proof=verify_proof(saved['proof'],expected,purpose_roots(),now=int(time.time()))
        return saved['expires_at']==proof['payload']['expires_at']
    except (ValueError,KeyError,TypeError,publications.PublicationError):
        return False
