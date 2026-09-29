"""Immutable native v2 assignment authority; no media bytes, pricing or retry writes.

The existing authenticated assignment channel and HMAC lease token carry this
server-owned metadata. A short device proof may renew without rebinding a lease.
"""
from __future__ import annotations
import re
from uuid import UUID
from sqlalchemy import select, update
from platform_v8.protocol.native_h3_review_v2 import TUPLE, validate_tuple
from platform_v8.storage import db
from platform_v8.storage.repo import shards_t, workloads_t, task_adapter_publications_t, workers_t
from . import task_adapter_publications as pubs
from . import native_h3_bindings_v2 as bindings
from .native_h3_device_configs import current_config

SCHEMA = "qianshou.native-h3-task-lease.v2"
FIELDS = {"schema", *TUPLE, "connection_id", "device_key_id", "workload_id", "shard_id", "attempt"}
_METADATA = "native_h3_device_leases"
_ACTIVE = ("DISPATCHED", "LEASED", "RUNNING", "VERIFYING")


def validate_lease(value):
    """Validate exact transport shape; this alone does not confer server authority."""
    if not isinstance(value, dict) or set(value) != FIELDS or value.get("schema") != SCHEMA:
        raise ValueError("native device lease fields invalid")
    validate_tuple(value)
    for name in ("publication_id", "connection_id", "workload_id", "shard_id"):
        if not isinstance(value[name], str) or str(UUID(value[name])) != value[name]:
            raise ValueError("native device lease identifier invalid")
    if (not isinstance(value["device_id"], str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,36}", value["device_id"])
            or not isinstance(value["device_key_id"], str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", value["device_key_id"])
            or type(value["attempt"]) is not int or not 1 <= value["attempt"] <= 9007199254740991):
        raise ValueError("native device lease participant invalid")
    return dict(value)


def _publication(s, task_type, worker_id, *, frozen_publication_id=None):
    from platform_v8.engine.task_registry import get_spec
    spec = get_spec(task_type)
    if spec is None or spec.adapter_input_contract != "h3-prompt-fixed-frame.v1":
        return None
    if frozen_publication_id is not None:
        row = pubs._get(s, frozen_publication_id, lock=True)
        definition = row.get("task_definition") or {}
        if (row["task_type"] != task_type or row["contract_version"] != "v2"
                or row["status"] != "approved" or not bindings.lifecycle.active(s,row["id"])
                or not isinstance(definition.get("nativeBinding"),dict)
                or definition["nativeBinding"].get("schema") != "qianshou.native-h3-execution-binding.v2"):
            raise pubs.PublicationConflict("已冻结原生投稿已失效，禁止改绑其他版本")
        return row
    rows = s.execute(select(task_adapter_publications_t).where(
        task_adapter_publications_t.c.task_type == task_type,
        task_adapter_publications_t.c.contract_version == "v2")).mappings().all()
    native = [dict(r) for r in rows if isinstance(r.get("task_definition"), dict)
              and isinstance(r["task_definition"].get("nativeBinding"), dict)
              and r["task_definition"]["nativeBinding"].get("schema") == "qianshou.native-h3-execution-binding.v2"]
    if not native:
        return None
    owner=s.execute(select(workers_t.c.owner_id).where(workers_t.c.id==worker_id)).scalar_one_or_none()
    if type(owner) is not int:
        raise pubs.PublicationConflict("原生派单设备没有当前作者身份")
    feed=bindings.current_bindings(s,owner_id=owner,worker_id=worker_id)
    caps=s.execute(select(workers_t.c.capabilities).where(workers_t.c.id==worker_id)).scalar_one()
    claims=(caps or {}).get("verified_task_adapters",[])
    advertised={a.get("publication_id") for a in claims if isinstance(a,dict) and a.get("task_type")==task_type
                and a.get("contract_version")=="v2"}
    authorized={b["publication_id"] for b in feed["bindings"] if b["task_type"]==task_type
                and b["publication_id"] in advertised}
    candidates=[row for row in native if row["id"] in authorized and row["owner_id"]==owner
                and row["status"]=="approved" and bindings.lifecycle.active(s,row["id"])]
    if len(candidates)!=1:
        raise pubs.PublicationConflict("原生任务缺少唯一已审核当前设备授权制品")
    return pubs._get(s,candidates[0]["id"],lock=True)


def _saved_lease(s, shard_id, worker_id, attempt):
    meta=s.execute(select(shards_t.c.metadata).where(shards_t.c.id==shard_id)).scalar_one_or_none()
    leases=(meta or {}).get(_METADATA,{})
    if not isinstance(leases,dict):
        raise pubs.PublicationConflict("原生派单身份历史无效")
    value=leases.get(worker_id+":"+str(attempt))
    return validate_lease(value) if value is not None else None


def _current(s, row, worker_id):
    feed = bindings.current_bindings(s, owner_id=row["owner_id"], worker_id=worker_id)
    matches = [b for b in feed["bindings"] if b["publication_id"] == row["id"]]
    if len(matches) != 1:
        raise pubs.PublicationConflict("当前原生设备证明不可用")
    b = matches[0]
    actual, head_key = current_config(s, row=row, worker_id=worker_id)
    connection = bindings.current_connection_id(worker_id, owner_id=row["owner_id"])
    if (not connection or any(b[k] != actual[k] for k in TUPLE)
            or b["device_key_id"] != head_key or b["connection_id"] != connection):
        raise pubs.PublicationConflict("当前原生设备配置或连接已变化")
    # Short proof SHA/nonce may renew for a busy existing lease. The acknowledged
    # immutable adapter source/private revision must still describe this same device.
    caps=s.execute(select(workers_t.c.capabilities).where(workers_t.c.id==worker_id)).scalar_one()
    claims=(caps or {}).get("verified_task_adapters",[])
    matching=[a for a in claims if isinstance(a,dict) and all(a.get(k)==b[k] for k in
        ("publication_id","task_type","capability_id","contract_version","contract_sha256",
         "artifact_digest","package_digest","local_owner_config_digest","device_binding_revision","native_binding"))]
    if len(matching)!=1:
        raise pubs.PublicationConflict("原生设备当前已确认执行声明与派单来源不同")
    return {**{k: b[k] for k in TUPLE}, "connection_id": connection, "device_key_id": head_key}


def _held(row, worker_id, attempt, workload_id, *, result=False):
    meta = row["metadata"] or {}
    participants = {str(row["worker_id"] or ""), str(row["lease_by_node"] or ""),
                    *(str(w) for w in meta.get("race_workers", []) if isinstance(w, str))}
    states = (*_ACTIVE, "DONE") if result else _ACTIVE
    if (worker_id not in participants or type(attempt) is not int or row["attempts"] != attempt
            or row["workload_id"] != workload_id or row["status"] not in states):
        raise pubs.PublicationConflict("原生任务租约不属于当前实际派单")


def assignment_lease(*, task_type, shard_id, workload_id, worker_id, attempt):
    """Persist once after assignment CAS; repeated/recovery builders cannot rebind it."""
    from platform_v8.engine.task_registry import get_spec
    spec = get_spec(task_type)
    if spec is None or spec.adapter_input_contract != "h3-prompt-fixed-frame.v1":
        return None
    with db.session_scope() as s:
        frozen = _saved_lease(s, shard_id, worker_id, attempt)
        pub = _publication(s, task_type, worker_id,
            frozen_publication_id=frozen["publication_id"] if frozen else None)
        if pub is None:
            return None
        row = s.execute(select(shards_t).where(shards_t.c.id == shard_id).with_for_update()).mappings().first()
        if row is None:
            raise pubs.PublicationConflict("原生任务分片不存在")
        _held(row, worker_id, attempt, workload_id)
        workload = s.execute(select(workloads_t.c.spec).where(workloads_t.c.id == workload_id)).scalar_one()
        if not isinstance(workload, dict) or workload.get("task_type") != task_type:
            raise pubs.PublicationConflict("原生任务合同不属于当前工作负载")
        current = {"schema": SCHEMA, **_current(s, pub, worker_id), "workload_id": workload_id,
                   "shard_id": shard_id, "attempt": attempt}
        validate_lease(current)
        meta = dict(row["metadata"] or {})
        leases = meta.get(_METADATA, {})
        if not isinstance(leases, dict) or len(leases) > 256:
            raise pubs.PublicationConflict("原生派单身份历史无效或超过上限")
        slot = worker_id + ":" + str(attempt)
        if slot in leases:
            saved = validate_lease(leases[slot])
            if saved != current:
                raise pubs.PublicationConflict("已派单原生身份已变化，禁止重绑或自动重跑")
            return saved
        if len(leases) >= 256:
            raise pubs.PublicationConflict("原生派单身份历史超过上限")
        meta[_METADATA] = {**leases, slot: current}
        s.execute(update(shards_t).where(shards_t.c.id == shard_id,
            shards_t.c.attempts == attempt).values(metadata=meta))
        # session_scope closes without implicit commit: persist before dispatch.
        s.commit()
        return current


def require_result_lease(s, *, task_type, shard_id, workload_id, worker_id, attempt):
    """Recheck frozen attempt authority before either external result/media entry."""
    from platform_v8.engine.task_registry import get_spec
    spec = get_spec(task_type)
    if spec is None or spec.adapter_input_contract != "h3-prompt-fixed-frame.v1":
        return
    frozen = _saved_lease(s, shard_id, worker_id, attempt)
    pub = _publication(s, task_type, worker_id,
        frozen_publication_id=frozen["publication_id"] if frozen else None)
    if pub is None:
        return
    row = s.execute(select(shards_t).where(shards_t.c.id == shard_id).with_for_update()).mappings().first()
    if row is None:
        raise pubs.PublicationConflict("原生结果分片不存在")
    _held(row, worker_id, attempt, workload_id, result=True)
    leases = (row["metadata"] or {}).get(_METADATA, {})
    if not isinstance(leases, dict):
        raise pubs.PublicationConflict("原生结果缺少实际派单身份")
    saved = validate_lease(leases.get(worker_id + ":" + str(attempt)))
    expected = {"schema": SCHEMA, **_current(s, pub, worker_id), "workload_id": workload_id,
                "shard_id": shard_id, "attempt": attempt}
    if saved != expected:
        raise pubs.PublicationConflict("原生结果配置版本、设备密钥或当前连接与派单不同")


def require_no_ordinary_inflight(s, *, publication, worker_id):
    """Configuration changes cannot invalidate an executing ordinary native lease."""
    # Read-only assignment guard; no cancellation, retry, settlement or intake-mode change.
    from sqlalchemy import JSON, case, cast, exists, func, literal, or_
    if s.get_bind().dialect.name == "postgresql":
        # Production metadata is JSONB while the shared ORM uses JSON.
        racers = cast(shards_t.c.metadata, JSON)["race_workers"]
        array = case((func.json_typeof(racers) == "array", racers),
                     else_=cast(literal("[]"), JSON))
        entries = func.json_array_elements_text(array).table_valued("value").alias("native_racers")
    else:
        array = case((func.json_type(shards_t.c.metadata, "$.race_workers") == "array",
                      func.json_extract(shards_t.c.metadata, "$.race_workers")), else_="[]")
        entries = func.json_each(array).table_valued("value").alias("native_racers")
    race_member = exists(select(1).select_from(entries).where(
        entries.c.value == worker_id).correlate(shards_t))
    rows = s.execute(select(shards_t).join(workloads_t, workloads_t.c.id == shards_t.c.workload_id).where(
        workloads_t.c.spec["task_type"].as_string() == publication["task_type"],
        shards_t.c.status.in_(_ACTIVE),
        or_(shards_t.c.worker_id == worker_id, shards_t.c.lease_by_node == worker_id,
            race_member)).limit(257)).mappings().all()
    if len(rows) > 256:
        raise pubs.PublicationConflict("当前原生任务数量超过有界核验上限")
    if rows:
        raise pubs.PublicationConflict("本机仍有实际原生任务租约，不能变更配置")
