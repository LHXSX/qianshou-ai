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

from platform_v8.protocol.native_h3 import canonical, validate_definition
from platform_v8.services.workers import task_adapter_publications as publications
from platform_v8.services.workers import publication_lifecycle as lifecycle
from platform_v8.storage.repo import task_adapter_publications_t, workers_t, accounts_t

SCHEMA = "qianshou.native-h3-device-proof.v1"
PURPOSE = "qianshou:native-h3-device-attestor"
_FIELDS = {"schema", "purpose", "publication_id", "owner_id", "device_id", "task_type", "capability_id",
           "contract_version", "contract_sha256", "artifact_digest", "source_digest", "config_digest",
           "challenge_nonce", "challenge_input_sha256", "challenge_result_sha256", "result",
           "publication_status", "installation_state", "issued_at", "expires_at"}
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_KEY = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
_WORKER = re.compile(r"[A-Za-z0-9._:-]{1,36}\Z")
_NONCE = re.compile(r"[A-Za-z0-9_-]{32,128}\Z")
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


def purpose_roots() -> dict[str, Ed25519PublicKey]:
    """Operator enrollment only; no request-supplied public key or general-purpose fallback."""
    raw = os.getenv("V8_NATIVE_H3_DEVICE_ATTESTOR_PUBLIC_KEYS", "")
    forbidden = os.getenv("V8_NATIVE_H3_DEVICE_ATTESTOR_FORBIDDEN_PUBLIC_KEYS", "")
    if not raw:
        return {}
    try:
        if not forbidden or len(raw) > 8192 or len(forbidden) > 16384:
            raise ValueError("purpose roots unavailable")
        def unique(pairs):
            values = {}
            for key, value in pairs:
                if key in values:
                    raise ValueError("duplicate purpose root")
                values[key] = value
            return values
        values, rejected = json.loads(raw, object_pairs_hook=unique), json.loads(forbidden, object_pairs_hook=unique)
        if (not isinstance(values, dict) or not 1 <= len(values) <= 8
                or not isinstance(rejected, dict) or not 1 <= len(rejected) <= 64):
            raise ValueError("purpose roots invalid")
        disallowed = {_binary(value, 32) for value in rejected.values()}
        roots = {}
        seen = set()
        for key, value in values.items():
            binary = _binary(value, 32)
            if not isinstance(key, str) or not _KEY.fullmatch(key) or binary in disallowed or binary in seen:
                raise ValueError("H3 and other signing purposes share a key")
            roots[key] = Ed25519PublicKey.from_public_bytes(binary)
            seen.add(binary)
        return roots
    except (ValueError, TypeError, UnicodeError, publications.PublicationError) as exc:
        raise publications.PublicationError("未配置独立原生H3设备验签信任根") from exc


def binding_metadata(row: dict[str, Any], *, worker_id: str) -> dict[str, Any]:
    """Bind source bytes, private owner configuration and the server execution contract separately."""
    definition = validate_definition(row)
    spec = publications._spec_for_row(row)
    if spec is None:
        raise publications.PublicationError("原生H3任务合同无效")
    from platform_v8.services.workers.task_adapter_review_issuer import task_contract_sha256
    return {"publication_id": row["id"], "owner_id": row["owner_id"], "device_id": worker_id,
            "task_type": row["task_type"], "capability_id": "video.render", "input_kinds": ["inline"],
            "output_kind": "artifact_ref", "contract_version": "v1",
            "input_contract": definition["inputContract"], "result_strategy": definition["resultStrategy"],
            "artifact_digest": row["artifact_digest"], "source_digest": row["artifact_digest"],
            "package_digest": row["package_digest"], "config_digest": definition["nativeBinding"]["ownerConfigDigest"],
            "task_definition_sha256": hashlib.sha256(canonical(definition)).hexdigest(),
            "contract_sha256": task_contract_sha256(row, spec).removeprefix("sha256:"),
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
        pinned = {"schema": SCHEMA, "purpose": PURPOSE, "result": "pass",
                  "publication_status": "approved", "installation_state": "installed",
                  **{key: expected[key] for key in ("publication_id", "owner_id", "device_id", "task_type",
                     "capability_id", "contract_version", "contract_sha256", "artifact_digest", "source_digest", "config_digest")}}
        if (any(payload.get(key) != value for key, value in pinned.items())
                or type(payload.get("owner_id")) is not int
                or not isinstance(payload.get("challenge_nonce"), str) or not _NONCE.fullmatch(payload["challenge_nonce"])
                or any(not isinstance(payload.get(key), str) or not _SHA.fullmatch(payload[key])
                       for key in ("contract_sha256", "challenge_input_sha256", "challenge_result_sha256"))
                or type(payload.get("issued_at")) is not int or type(payload.get("expires_at")) is not int
                or payload["issued_at"] > now + 60 or payload["expires_at"] <= now
                or not 0 < payload["expires_at"] - payload["issued_at"] <= 300):
            raise ValueError("proof binding or freshness invalid")
        return envelope
    except (ValueError, KeyError, TypeError, InvalidSignature) as exc:
        raise publications.PublicationError("原生H3设备回执未绑定当前账号、设备和已审核制品") from exc


def _worker(s: Session, owner_id: int, worker_id: str) -> dict:
    if not isinstance(worker_id, str) or not _WORKER.fullmatch(worker_id):
        raise publications.PublicationError("设备编号无效")
    row = s.execute(select(workers_t).where(workers_t.c.id == worker_id)).mappings().first()
    if row is None or row["owner_id"] != owner_id:
        raise publications.PublicationNotFound("当前账号没有此设备")
    if s.execute(select(accounts_t.c.status).where(accounts_t.c.id==owner_id)).scalar_one_or_none() != "active":
        raise publications.PublicationConflict("当前设备所属账号已停用")
    from datetime import datetime, timezone
    disabled_until=row.get("disabled_until")
    if disabled_until is not None and disabled_until.tzinfo is None:
        disabled_until=disabled_until.replace(tzinfo=timezone.utc)
    if (row.get("disabled_at") is not None or row.get("onboarding_status") in {"disabled","banned"}
            or disabled_until is not None and disabled_until>datetime.now(timezone.utc)):
        raise publications.PublicationConflict("当前设备已停用")
    return dict(row)


_CONNECTION_PREFIX = "v8:native-h3:connection:"
_CONNECTION_TTL = 120


def _connection_redis():
    from platform_v8.storage import kv
    return kv.get_redis()


def _connection_value(owner_id: int, connection_id: str) -> str:
    if type(owner_id) is not int or owner_id < 1 or str(UUID(connection_id)) != connection_id:
        raise ValueError("authenticated connection identity invalid")
    return canonical({"owner_id": owner_id, "connection_id": connection_id}).decode()


def observe_connection(worker_id: str, *, owner_id: int, connection_id: str) -> bool:
    """Authenticated WS only; shared last-authenticated connection with a bounded liveness TTL."""
    try:
        if not _WORKER.fullmatch(worker_id):
            return False
        redis = _connection_redis()
        return bool(redis and redis.set(_CONNECTION_PREFIX + worker_id,
            _connection_value(owner_id, connection_id), ex=_CONNECTION_TTL))
    except Exception:
        return False


def renew_connection(worker_id: str, *, owner_id: int, connection_id: str) -> bool:
    """An old socket cannot renew or replace a new socket's authoritative record."""
    try:
        redis = _connection_redis()
        return bool(redis and redis.eval(
            "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('EXPIRE',KEYS[1],ARGV[2]) else return 0 end",
            1, _CONNECTION_PREFIX + worker_id, _connection_value(owner_id, connection_id), _CONNECTION_TTL))
    except Exception:
        return False


def close_connection(worker_id: str, *, owner_id: int, connection_id: str) -> bool:
    """Atomically retire this connection and its online score, never a replacement."""
    try:
        redis = _connection_redis()
        return bool(redis and redis.eval(
            "if redis.call('GET',KEYS[1]) == ARGV[1] then "
            "redis.call('ZREM',KEYS[2],ARGV[2]); "
            "return redis.call('DEL',KEYS[1]) else return 0 end",
            2, _CONNECTION_PREFIX + worker_id, "v8:worker:hb",
            _connection_value(owner_id, connection_id), worker_id))
    except Exception:
        return False


def current_connection_id(worker_id: str, *, owner_id: int | None = None) -> str | None:
    """Read shared Redis WS truth; no local broker, request UUID or stale fallback."""
    try:
        if not _WORKER.fullmatch(worker_id):
            return None
        redis = _connection_redis()
        value = redis.get(_CONNECTION_PREFIX + worker_id) if redis else None
        if value is None or len(value) > 256:
            return None
        data = json.loads(value)
        if (not isinstance(data, dict) or set(data) != {"owner_id", "connection_id"}
                or type(data["owner_id"]) is not int or data["owner_id"] < 1
                or owner_id is not None and data["owner_id"] != owner_id
                or str(UUID(data["connection_id"])) != data["connection_id"]):
            return None
        return data["connection_id"]
    except Exception:
        return None


def current_bindings(s: Session, *, owner_id: int, worker_id: str) -> dict:
    """Only return current active approvals whose independent proof verifies now; never write on GET."""
    _worker(s, owner_id, worker_id)
    roots = purpose_roots()
    items = []
    if roots:
        rows = s.execute(select(task_adapter_publications_t).where(
            task_adapter_publications_t.c.owner_id == owner_id,
            task_adapter_publications_t.c.status == "approved")).mappings().all()
        for raw in rows:
            row = dict(raw)
            if not lifecycle.active(s, row["id"]):
                continue
            saved = s.execute(select(proofs_t).where(proofs_t.c.publication_id == row["id"],
                proofs_t.c.device_id == worker_id, proofs_t.c.owner_id == owner_id)).mappings().first()
            if saved is None or saved["connection_id"] != current_connection_id(worker_id, owner_id=owner_id):
                continue
            try:
                binding = binding_metadata(row, worker_id=worker_id)
                if publications._issues(s, row, row["review_evidence"] or {}, reviewer_id=row["reviewer_id"],
                                         require_runtime_pin=True):
                    continue
                proof = verify_proof(saved["proof"], binding, roots, now=int(time.time()))
            except (ValueError, publications.PublicationError):
                continue
            items.append({**binding, "device_proof": proof})
    return {"schema": "qianshou.native-h3-order-bindings.v1", "owner_id": owner_id,
            "worker_id": worker_id, "bindings": items}


def deposit(s: Session, *, publication_id: str, receipt: Any) -> dict:
    """Service-only ingress; authenticated endpoint must not expose this operation to authors."""
    row = publications._get(s, publication_id, lock=True)
    if row["status"] != "approved" or not lifecycle.active(s, publication_id):
        raise publications.PublicationConflict("仅当前已审核制品可存入接单设备证明")
    payload = receipt.get("payload") if isinstance(receipt, dict) else None
    worker_id = payload.get("device_id") if isinstance(payload, dict) else None
    _worker(s, row["owner_id"], worker_id)
    expected = binding_metadata(row, worker_id=worker_id)
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
    return {"schema": "qianshou.native-h3-device-proof-deposit.v1", "publication_id": publication_id,
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
        expected=binding_metadata(publication,worker_id=worker_id)
        proof=verify_proof(saved['proof'],expected,purpose_roots(),now=int(time.time()))
        return saved['expires_at']==proof['payload']['expires_at']
    except (ValueError,KeyError,TypeError,publications.PublicationError):
        return False
