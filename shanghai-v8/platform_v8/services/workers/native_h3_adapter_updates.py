"""Same authenticated socket, server-verified native adapter metadata only.

The update cannot approve a publication, enroll a key, issue presence, run a
sample, or change supply permission. It reuses already stored current proof.
"""
from __future__ import annotations

import hashlib
import re
from uuid import UUID

from sqlalchemy import select

from platform_v8.protocol.native_h3 import ABI, canonical, validate_binding
from platform_v8.storage.repo import WorkerRepo, workers_t, task_adapter_publications_t
from . import native_h3_bindings as bindings
from . import native_h3_bindings_v2 as bindings_v2
from platform_v8.protocol.native_h3_v2 import validate_binding as validate_binding_v2
from . import task_adapter_publications as publications

FIELDS = {"task_type", "capability_id", "input_kinds", "output_kind", "contract_version",
          "artifact_digest", "package_digest", "installation_state", "health", "self_test",
          "publication_id", "contract_sha256", "native_binding", "device_proof_sha256"}


def _uuid(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError("noncanonical UUID")
    except (ValueError, TypeError, AttributeError) as exc:
        raise publications.PublicationError("原生能力同步编号无效") from exc
    return value


def validate_payload(payload):
    """Reject unbounded input and caller-supplied identity before querying storage."""
    if (not isinstance(payload, dict) or set(payload) != {"request_id", "adapters"}
            or len(canonical(payload)) > 32768 or not isinstance(payload["adapters"], list)
            or len(payload["adapters"]) > 16):
        raise publications.PublicationError("原生能力同步帧无效")
    _uuid(payload["request_id"])
    seen_tasks, seen_publications = set(), set()
    for row in payload["adapters"]:
        if (not isinstance(row, dict) or set(row) != (FIELDS | {"local_owner_config_digest", "device_binding_revision"} if row.get("contract_version") == "v2" else FIELDS)
                or not isinstance(row.get("task_type"), str)
                or not isinstance(row.get("publication_id"), str)
                or row["task_type"] in seen_tasks or row.get("publication_id") in seen_publications
                or row.get("capability_id") != "video.render" or row.get("input_kinds") != ["inline"]
                or row.get("output_kind") != "artifact_ref" or row.get("contract_version") not in {"v1", "v2"}
                or row.get("installation_state") != "installed" or row.get("health") != "verified"
                or row.get("self_test") != "passed"):
            raise publications.PublicationError("原生能力同步声明无效")
        _uuid(row["publication_id"])
        if row["contract_version"] == "v2":
            validate_binding_v2(row["native_binding"])
            if (not isinstance(row["local_owner_config_digest"],str)
                    or not re.fullmatch(r"sha256:[0-9a-f]{64}",row["local_owner_config_digest"])
                    or type(row["device_binding_revision"]) is not int
                    or not 1<=row["device_binding_revision"]<=9007199254740991):
                raise publications.PublicationError("原生v2设备配置版本无效")
        else:
            validate_binding(row["native_binding"])
        if (len(row["task_type"]) > 100
                or any(not isinstance(row[k], str) or not bindings._SHA.fullmatch(row[k])
                       for k in ("contract_sha256", "device_proof_sha256"))
                or any(not isinstance(row[k], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", row[k])
                       for k in ("artifact_digest", "package_digest"))):
            raise publications.PublicationError("原生能力同步摘要无效")
        seen_tasks.add(row["task_type"])
        seen_publications.add(row["publication_id"])
    return payload


def _claim(binding):
    """Generate compatibility fields from platform approval, never client booleans."""
    claim = {"publication_id": binding["publication_id"], "task_type": binding["task_type"],
            "capability_id": "video.render", "input_kinds": ["inline"], "output_kind": "artifact_ref",
            "contract_version": binding["contract_version"], "artifact_digest": binding["artifact_digest"],
            "package_digest": binding["package_digest"], "installation_state": "installed",
            "health": "verified", "self_test": "passed", "contract_sha256": binding["contract_sha256"],
            "native_binding": binding["native_binding"],
            "device_proof_sha256": hashlib.sha256(canonical(binding["device_proof"]["payload"])).hexdigest()}

    if binding['contract_version']=='v2':
        claim.update({k:binding[k] for k in ('local_owner_config_digest','device_binding_revision')})
    return claim


def _current_bindings(s,*,owner_id,worker_id):
    return (bindings.current_bindings(s,owner_id=owner_id,worker_id=worker_id)['bindings']+
            bindings_v2.current_bindings(s,owner_id=owner_id,worker_id=worker_id)['bindings'])


def _require_current(owner_id, worker_id, connection_id):
    if (type(owner_id) is not int or owner_id < 1
            or bindings.current_connection_id(worker_id, owner_id=owner_id) != connection_id):
        raise publications.PublicationConflict("原生能力同步未来自当前认证连接")


def apply_update(s, *, owner_id, worker_id, connection_id, payload):
    """Atomically replace native declarations on this socket; retain other capabilities."""
    validate_payload(payload)
    _uuid(connection_id)
    _require_current(owner_id, worker_id, connection_id)
    worker = s.execute(select(workers_t).where(workers_t.c.id == worker_id).with_for_update()).mappings().first()
    bindings._worker(s, owner_id, worker_id)
    if worker is None or worker["status"] != "ONLINE":
        raise publications.PublicationConflict("当前设备未在线")
    capabilities = worker["capabilities"]
    if (not isinstance(capabilities, dict) or not isinstance(capabilities.get("protocol_capabilities"), list)
            or "task-adapters.v1" not in capabilities.get("protocol_capabilities", [])):
        raise publications.PublicationConflict("当前设备未协商原生任务声明协议")
    current = _current_bindings(s, owner_id=owner_id, worker_id=worker_id)
    by_publication = {item["publication_id"]: item for item in current}
    claims = []
    for requested in payload["adapters"]:
        binding = by_publication.get(requested["publication_id"])
        if binding is None or requested != _claim(binding):
            raise publications.PublicationConflict("原生能力未绑定当前已审核制品及设备证明")
        claims.append(_claim(binding))
    old_adapters = capabilities.get("verified_task_adapters", [])
    old_ads = capabilities.get("provided_capabilities", [])
    if (not isinstance(old_adapters, list) or len(old_adapters) > 128
            or not isinstance(old_ads, list) or len(old_ads) > 128):
        raise publications.PublicationConflict("当前能力清单不可核验")
    # Identify old native tasks from authored contracts, including revoked ones.
    # A task name prefix or caller-supplied metadata cannot erase a generic adapter.
    old_types = {item.get("task_type") for item in old_adapters
                 if isinstance(item, dict) and isinstance(item.get("task_type"), str)}
    native_types = set()
    if old_types:
        for task_type, definition in s.execute(select(task_adapter_publications_t.c.task_type,
                task_adapter_publications_t.c.task_definition).where(task_adapter_publications_t.c.task_type.in_(old_types))):
            if (isinstance(definition, dict) and isinstance(definition.get("nativeBinding"), dict)
                    and definition["nativeBinding"].get("runtimeAbi") in (ABI, "qianshou.order-runtime.native-h3.v2")):
                native_types.add(task_type)
    preserved = [item for item in old_adapters
                 if not isinstance(item, dict) or item.get("task_type") not in native_types]
    if len(preserved) + len(claims) > 128:
        raise publications.PublicationConflict("原生能力同步超过任务清单上限")
    merged = preserved + claims
    ads = list(old_ads)
    if native_types or claims:
        if any(isinstance(item, dict) and item.get("capability_id") == "video.render" for item in merged):
            if not any((item == "video.render" or isinstance(item, dict) and item.get("name") == "video.render") for item in ads):
                ads.append({"name": "video.render", "version": "1.0.0", "health": "ok",
                            "provider": "qianshou.native-h3-approved"})
        else:
            # Plain Hello video ads may describe a fixed/generic video runner.
            # Remove only the native advertisement this service owns.
            ads = [item for item in ads if item != {"name": "video.render", "version": "1.0.0",
                "health": "ok", "provider": "qianshou.native-h3-approved"}]
    if len(ads) > 128:
        raise publications.PublicationConflict("原生能力同步超过能力清单上限")
    _require_current(owner_id, worker_id, connection_id)
    if not WorkerRepo.update_capabilities(s, worker_id, {
            "verified_task_adapters": merged, "provided_capabilities": ads}):
        raise publications.PublicationConflict("当前设备能力同步未写入")
    s.flush()
    _require_current(owner_id, worker_id, connection_id)
    if claims:
        fresh = {item["publication_id"]: _claim(item) for item in
                 _current_bindings(s, owner_id=owner_id, worker_id=worker_id)}
        if any(fresh.get(item["publication_id"]) != item for item in claims):
            raise publications.PublicationConflict("原生能力同步期间审核或设备证明已变更")
    return {"request_id": payload["request_id"], "connection_id": connection_id,
            "status": "accepted", "task_types": [item["task_type"] for item in claims]}
