"""Owner/current-WS configuration enrollment with durable per-publication/device CAS revisions.

Registered configuration metadata is not sample verification or permission to run.
Old configuration revisions and enrollment signatures remain immutable history.
"""
from __future__ import annotations
import hashlib
import re
import secrets
import time
from uuid import UUID, uuid4
from sqlalchemy import Column, Integer, BigInteger, String, JSON, MetaData, Table, Uuid, insert, select, update
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature
from platform_v8.protocol.native_h3 import canonical
from platform_v8.protocol.native_h3_v2 import validate_definition, logical_binding_sha256
from platform_v8.protocol.native_h3_review_v2 import TUPLE, raw
from . import task_adapter_publications as pubs, publication_lifecycle as lifecycle
from . import native_h3_device_keys as keys
from .native_h3_bindings import current_connection_id, proofs_t

SCHEMA = "qianshou.native-h3-device-config-enrollment.v2"
PURPOSE = "qianshou:native-h3-device-config-enrollment.v2"
CONFIG_SCHEMA = "qianshou.native-h3-device-config.v2"
FIELDS = {"schema", "purpose", *TUPLE, "challenge_id", "nonce", "key_id", "connection_id",
          "expected_revision", "issued_at", "expires_at"}
_UUID = Uuid(as_uuid=False).with_variant(String(36), "sqlite")
metadata = MetaData()
configs_t = Table("we_native_h3_device_configs", metadata,
    Column("publication_id", String(36), primary_key=True), Column("device_id", _UUID, primary_key=True),
    Column("owner_id", Integer, nullable=False), Column("key_id", String(64), nullable=False),
    Column("logical_binding_sha256", String(64), nullable=False),
    Column("local_owner_config_digest", String(71), nullable=False),
    Column("device_binding_revision", BigInteger, nullable=False),
    Column("contract_sha256", String(64), nullable=False), Column("source_digest", String(71), nullable=False),
    Column("connection_id", String(36), nullable=False), Column("updated_at", Integer, nullable=False))
history_t = Table("we_native_h3_device_config_history", metadata,
    Column("publication_id", String(36), primary_key=True), Column("device_id", _UUID, primary_key=True),
    Column("device_binding_revision", BigInteger, primary_key=True), Column("owner_id", Integer, nullable=False),
    Column("local_owner_config_digest", String(71), nullable=False), Column("enrollment", JSON, nullable=False),
    Column("registered_at", Integer, nullable=False))
challenges_t = Table("we_native_h3_config_challenges", metadata,
    Column("id", String(36), primary_key=True), Column("publication_id", String(36), nullable=False),
    Column("owner_id", Integer, nullable=False), Column("device_id", _UUID, nullable=False),
    Column("payload", JSON, nullable=False), Column("issued_plan",JSON,nullable=False), Column("expires_at", Integer, nullable=False),
    Column("signature", String(86)), Column("observed_at", Integer), Column("consumed_at", Integer))


def _revision(value, *, absent=False):
    if type(value) is not int or not (0 if absent else 1) <= value <= 9007199254740991:
        raise pubs.PublicationError("设备配置版本无效")
    return value


def _publication(s, publication_id, owner_id, worker_id, *, lock=False):
    row = pubs._get(s, publication_id, lock=lock)
    if row["owner_id"] != owner_id:
        raise pubs.PublicationNotFound("投稿不属于当前账号")
    if row["status"] not in ("review", "approved") or not lifecycle.active(s, publication_id):
        raise pubs.PublicationConflict("仅当前待审或已审制品可以登记本机配置")
    definition = validate_definition(row)
    keys._online(s, owner_id, worker_id)
    connection = current_connection_id(worker_id, owner_id=owner_id)
    if not connection:
        raise pubs.PublicationConflict("本机配置尚未由当前连接见证")
    return row, definition, connection


def public_metadata(row, worker_id):
    """Derive stable public source and execution fields from the locked publication."""
    from .task_adapter_review_issuer import task_contract_sha256
    definition = validate_definition(row)
    spec = pubs._spec_for_row(row)
    if spec is None:
        raise pubs.PublicationError("原生H3 v2任务合同无效")
    return {"publication_id": row["id"], "owner_id": row["owner_id"], "device_id": worker_id,
            "task_type": row["task_type"], "capability_id": "video.render", "contract_version": "v2",
            "contract_sha256": task_contract_sha256(row, spec).removeprefix("sha256:"),
            "artifact_digest": row["artifact_digest"], "source_digest": row["artifact_digest"],
            "logical_binding_sha256": logical_binding_sha256(definition["nativeBinding"])}


def get_config(s, *, publication_id, owner_id, worker_id):
    """Read current CAS version only; no key registration, nonce, GPU or grant."""
    row, definition, connection = _publication(s, publication_id, owner_id, worker_id)
    saved = s.execute(select(configs_t).where(configs_t.c.publication_id == publication_id,
        configs_t.c.device_id == worker_id, configs_t.c.owner_id == owner_id)).mappings().first()
    digest = logical_binding_sha256(definition["nativeBinding"])
    if saved and saved["logical_binding_sha256"] != digest:
        raise pubs.PublicationConflict("公开执行合同已变化")
    return {"schema": CONFIG_SCHEMA, "publication_id": publication_id, "worker_id": worker_id,
            "logical_binding_sha256": digest,
            "local_owner_config_digest": saved["local_owner_config_digest"] if saved else None,
            "device_binding_revision": saved["device_binding_revision"] if saved else 0,
            "status": "registered" if saved else "absent"}


def current_config(s, *, row, worker_id, require_connection=True):
    saved = s.execute(select(configs_t).where(configs_t.c.publication_id == row["id"],
        configs_t.c.device_id == worker_id, configs_t.c.owner_id == row["owner_id"])).mappings().first()
    public = public_metadata(row, worker_id)
    if (not saved or saved["logical_binding_sha256"] != public["logical_binding_sha256"]
            or saved["contract_sha256"] != public["contract_sha256"]
            or saved["source_digest"] != public["source_digest"]):
        raise pubs.PublicationConflict("本机配置尚未登记到当前公开制品")
    _revision(saved["device_binding_revision"])
    keys.active_key(s, owner_id=row["owner_id"], worker_id=worker_id, key_id=saved["key_id"])
    if require_connection and saved["connection_id"] != current_connection_id(worker_id, owner_id=row["owner_id"]):
        raise pubs.PublicationConflict("本机配置尚未由当前连接重新见证")
    return {**public, "local_owner_config_digest": saved["local_owner_config_digest"],
            "device_binding_revision": saved["device_binding_revision"]}, saved["key_id"]


def challenge(s, *, publication_id, owner_id, worker_id, key_id, local_owner_config_digest, expected_revision):
    _revision(expected_revision, absent=True)
    if not isinstance(local_owner_config_digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", local_owner_config_digest):
        raise pubs.PublicationError("本机私有配置摘要无效")
    row, definition, connection = _publication(s, publication_id, owner_id, worker_id, lock=True)
    keys.active_key(s, owner_id=owner_id, worker_id=worker_id, key_id=key_id)
    saved = s.execute(select(configs_t).where(configs_t.c.publication_id == publication_id,
        configs_t.c.device_id == worker_id).with_for_update()).mappings().first()
    previous = saved["device_binding_revision"] if saved else 0
    public=public_metadata(row,worker_id)
    if saved and any(saved[k]!=public[k] for k in ('logical_binding_sha256','contract_sha256','source_digest')):
        raise pubs.PublicationConflict('已登记公开制品发生变化，请提交新的不可变投稿')
    if previous != expected_revision:
        raise pubs.PublicationConflict("本机配置版本已变化，请重新读取")
    unchanged = saved and saved["local_owner_config_digest"] == local_owner_config_digest and saved["key_id"] == key_id
    revision = previous if unchanged else previous + 1
    _revision(revision)
    now = int(time.time())
    if not unchanged:
        from .native_h3_task_lease import require_no_ordinary_inflight
        require_no_ordinary_inflight(s, publication=row, worker_id=worker_id)
        from .native_h3_review_samples import jobs_t
        active=s.execute(select(jobs_t.c.nonce).where(jobs_t.c.publication_id==publication_id,
            jobs_t.c.device_id==worker_id,jobs_t.c.expires_at>now,
            jobs_t.c.status.in_(['issued','upload_issued','decoded']))).first()
        if active:
            raise pubs.PublicationConflict('当前隔离样单尚未结束，不能变更设备配置')
    pending = s.execute(select(challenges_t).where(challenges_t.c.publication_id == publication_id,
        challenges_t.c.device_id == worker_id, challenges_t.c.expires_at > now,
        challenges_t.c.consumed_at.is_(None)).limit(9)).mappings().all()
    if len(pending) > 8:
        raise pubs.PublicationConflict("当前设备配置登记挑战超过上限")
    for old in pending:
        if old["payload"].get("connection_id") == connection and old["payload"].get("key_id") == key_id:
            raise pubs.PublicationConflict("当前设备已有待完成配置登记挑战")
        # Preserve issued bytes for audit; only stale pre-GPU enrollment is superseded.
        s.execute(update(challenges_t).where(challenges_t.c.id == old["id"],
            challenges_t.c.consumed_at.is_(None)).values(expires_at=now))
    p = {"schema": SCHEMA, "purpose": PURPOSE, **public_metadata(row, worker_id),
         "local_owner_config_digest": local_owner_config_digest, "device_binding_revision": revision,
         "challenge_id": str(uuid4()), "nonce": secrets.token_urlsafe(32), "key_id": key_id,
         "connection_id": connection, "expected_revision": expected_revision, "issued_at": now, "expires_at": now + 300}
    from .native_h3_review_samples import service, _roots
    from platform_v8.protocol.native_h3_review_v2 import signed, fresh
    envelope=service('/native-h3/device-config/challenge',
        {'schema':'qianshou.native-h3-device-config-request.v2','payload':p})
    try:
        issued=signed(envelope,_roots(),FIELDS);fresh(issued,now=now,ttl=300)
    except (ValueError,TypeError,KeyError,InvalidSignature) as exc:
        raise pubs.PublicationError('独立配置挑战签名无效') from exc
    if issued != p:
        raise pubs.PublicationError('独立配置挑战未绑定当前登记提案')
    s.execute(insert(challenges_t).values(id=p["challenge_id"],publication_id=publication_id,
        owner_id=owner_id,device_id=worker_id,payload=p,issued_plan=envelope,expires_at=p["expires_at"]))
    return envelope


def enrollment_context(s, *, publication_id, worker_id):
    """Private service read: independently bind issuer to current public tuple and CAS head."""
    row=pubs._get(s,publication_id)
    row, definition, connection=_publication(s,publication_id,row['owner_id'],worker_id)
    saved=s.execute(select(configs_t).where(configs_t.c.publication_id==publication_id,
        configs_t.c.device_id==worker_id)).mappings().first()
    return {**public_metadata(row,worker_id),'connection_id':connection,
            'device_binding_revision':saved['device_binding_revision'] if saved else 0,
            'local_owner_config_digest':saved['local_owner_config_digest'] if saved else None,
            'key_id':saved['key_id'] if saved else None}


def _verify(s, *, publication_id, owner_id, worker_id, challenge_id, signature):
    if str(UUID(challenge_id)) != challenge_id:
        raise pubs.PublicationError("本机配置挑战标识无效")
    saved = s.execute(select(challenges_t).where(challenges_t.c.id == challenge_id).with_for_update()).mappings().first()
    if not saved or saved["publication_id"] != publication_id or saved["owner_id"] != owner_id or saved["device_id"] != worker_id:
        raise pubs.PublicationNotFound("配置挑战不属于当前账号设备")
    p = saved["payload"]; now = int(time.time())
    from .native_h3_review_samples import _roots
    from platform_v8.protocol.native_h3_review_v2 import signed,fresh
    try:
        issued=signed(saved['issued_plan'],_roots(),FIELDS);fresh(issued,now=now,ttl=300)
    except (ValueError,TypeError,KeyError,InvalidSignature) as exc:
        raise pubs.PublicationError('原始独立配置挑战签名已失效') from exc
    if issued!=p:
        raise pubs.PublicationError('原始独立配置挑战签名已失效')
    row, definition, connection = _publication(s, publication_id, owner_id, worker_id, lock=True)
    if (saved["expires_at"] <= now or set(p) != FIELDS or p["schema"] != SCHEMA or p["purpose"] != PURPOSE or p["connection_id"] != connection
            or p["issued_at"] > now + 60 or p["expires_at"] <= now or not 0 < p["expires_at"] - p["issued_at"] <= 300
            or any(p[k] != v for k, v in public_metadata(row, worker_id).items())):
        raise pubs.PublicationConflict("本机配置挑战或当前连接已失效")
    key = keys.active_key(s, owner_id=owner_id, worker_id=worker_id, key_id=p["key_id"])
    try:
        Ed25519PublicKey.from_public_bytes(raw(key["public_key"], 32)).verify(raw(signature, 64), canonical(p))
    except Exception as exc:
        raise pubs.PublicationError("本机配置签名无效") from exc
    return saved, p, row, now


def witness(s, *, owner_id, worker_id, connection_id, payload):
    if not isinstance(payload, dict) or set(payload) != {"challenge_id", "signature"}:
        raise pubs.PublicationError("本机配置WS帧无效")
    saved = s.execute(select(challenges_t).where(challenges_t.c.id == payload["challenge_id"])).mappings().first()
    if not saved:
        raise pubs.PublicationNotFound("本机配置挑战不存在")
    saved, p, row, now = _verify(s, publication_id=saved["publication_id"], owner_id=owner_id,
        worker_id=worker_id, challenge_id=payload["challenge_id"], signature=payload["signature"])
    if p["connection_id"] != connection_id or saved["consumed_at"] is not None:
        raise pubs.PublicationConflict("配置签名未来自当前连接或已结束")
    if saved["signature"] is not None and saved["signature"] != payload["signature"]:
        raise pubs.PublicationConflict("配置挑战已有另一签名")
    s.execute(update(challenges_t).where(challenges_t.c.id == saved["id"], challenges_t.c.consumed_at.is_(None))
        .values(signature=payload["signature"], observed_at=now))


def register(s, *, publication_id, owner_id, worker_id, challenge_id, signature):
    saved, p, row, now = _verify(s, publication_id=publication_id, owner_id=owner_id,
        worker_id=worker_id, challenge_id=challenge_id, signature=signature)
    if saved["signature"] != signature or saved["observed_at"] is None:
        raise pubs.PublicationConflict("请先由当前连接见证本机配置签名")
    head = s.execute(select(configs_t).where(configs_t.c.publication_id == publication_id,
        configs_t.c.device_id == worker_id).with_for_update()).mappings().first()
    previous = head["device_binding_revision"] if head else 0
    if saved["consumed_at"] is not None:
        if (head and head["device_binding_revision"] == p["device_binding_revision"]
                and head["local_owner_config_digest"] == p["local_owner_config_digest"] and head["key_id"] == p["key_id"]):
            return get_config(s, publication_id=publication_id, owner_id=owner_id, worker_id=worker_id)
        raise pubs.PublicationConflict("旧登记挑战不能复活另一配置版本")
    if previous != p["expected_revision"]:
        raise pubs.PublicationConflict("本机配置版本已被另一登记更新")
    unchanged = head and head["local_owner_config_digest"] == p["local_owner_config_digest"] and head["key_id"] == p["key_id"]
    expected = previous if unchanged else previous + 1
    if expected != p["device_binding_revision"]:
        raise pubs.PublicationConflict("本机配置版本递增无效")
    if not unchanged:
        from .native_h3_task_lease import require_no_ordinary_inflight
        require_no_ordinary_inflight(s, publication=row, worker_id=worker_id)
    values = {"owner_id": owner_id, "key_id": p["key_id"], "logical_binding_sha256": p["logical_binding_sha256"],
              "local_owner_config_digest": p["local_owner_config_digest"], "device_binding_revision": expected,
              "contract_sha256": p["contract_sha256"], "source_digest": p["source_digest"],
              "connection_id": p["connection_id"], "updated_at": now}
    if head:
        changed = s.execute(update(configs_t).where(configs_t.c.publication_id == publication_id,
            configs_t.c.device_id == worker_id, configs_t.c.device_binding_revision == previous).values(**values))
        if changed.rowcount != 1:
            raise pubs.PublicationConflict("本机配置版本并发冲突")
    else:
        s.execute(insert(configs_t).values(publication_id=publication_id, device_id=worker_id, **values))
    if not unchanged:
        s.execute(insert(history_t).values(publication_id=publication_id, device_id=worker_id,
            device_binding_revision=expected, owner_id=owner_id, local_owner_config_digest=p["local_owner_config_digest"],
            enrollment={"key_id": p["key_id"], "payload": p, "signature": signature,
                "issued_plan":saved['issued_plan']}, registered_at=now))
        # Keep the old signed proof for audit but make it ineligible immediately.
        s.execute(update(proofs_t).where(proofs_t.c.publication_id == publication_id,
            proofs_t.c.device_id == worker_id).values(expires_at=now))
    s.execute(update(challenges_t).where(challenges_t.c.id == challenge_id,
        challenges_t.c.consumed_at.is_(None)).values(consumed_at=now))
    if current_connection_id(worker_id,owner_id=owner_id)!=p['connection_id']:
        raise pubs.PublicationConflict('配置登记期间当前连接已变化')
    return get_config(s, publication_id=publication_id, owner_id=owner_id, worker_id=worker_id)
