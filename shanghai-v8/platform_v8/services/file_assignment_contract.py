"""Metadata-only file assignment projection; object credentials and bytes are never included."""
from __future__ import annotations

import hashlib
import json
import re
from uuid import UUID

from platform_v8.protocol.artifact import ArtifactV1, validate_artifact_against_context
from platform_v8.protocol.generic_file import canonical, file_schema_sha256, validate_file_schema

BINDING_KEY = "_file_attachment_bindings"
BINDING_SCHEMA = "qianshou.file-attachment-bindings.v1"
_FIELDS = {"schema", "account_id", "task_type", "contract_sha256", "file_schema_sha256", "attachments", "bindings_sha256"}
_ARTIFACT_FIELDS = {"schema", "account_id", "workload_id", "shard_id", "result_id", "object_key",
                    "object_version_id", "filename", "size_bytes", "content_type", "sha256"}
_SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
_HEX = re.compile(r"[0-9a-f]{64}\Z")
_SLOT = re.compile(r"[a-z][a-z0-9_]{0,31}\Z")


def _uuid(value: object) -> bool:
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (TypeError, ValueError):
        return False


def validate_file_assignment_contract(value: object, *, account_id: int | None = None,
                                      task_type: str | None = None, file_schema: dict | None = None) -> dict:
    """Validate an exact unsigned frozen metadata digest and return an independent JSON copy."""
    if (not isinstance(value, dict) or set(value) != _FIELDS or value["schema"] != BINDING_SCHEMA
            or type(value["account_id"]) is not int or value["account_id"] < 1
            or not isinstance(value["task_type"], str) or not 1 <= len(value["task_type"]) <= 128
            or not isinstance(value["contract_sha256"], str) or not _SHA.fullmatch(value["contract_sha256"])
            or not isinstance(value["file_schema_sha256"], str) or not _HEX.fullmatch(value["file_schema_sha256"])
            or not isinstance(value["bindings_sha256"], str) or not _SHA.fullmatch(value["bindings_sha256"])
            or (account_id is not None and value["account_id"] != account_id)
            or (task_type is not None and value["task_type"] != task_type)):
        raise ValueError("文件派单冻结字段无效")
    unsigned = {key: item for key, item in value.items() if key != "bindings_sha256"}
    encoded = canonical(value)
    if (len(encoded) > 8192 or value["bindings_sha256"] != "sha256:" + hashlib.sha256(canonical(unsigned)).hexdigest()
            or not isinstance(value["attachments"], dict) or len(value["attachments"]) > 1
            or any(not isinstance(name, str) or not _SLOT.fullmatch(name) for name in value["attachments"])):
        raise ValueError("文件派单冻结摘要或附件槽无效")
    schema = validate_file_schema(file_schema) if file_schema is not None else None
    slots = {slot["name"]: slot for slot in schema["inputs"]} if schema else {}
    if schema and (value["file_schema_sha256"] != file_schema_sha256(schema)
                   or set(value["attachments"]) != set(slots)):
        raise ValueError("文件派单与当前审核声明不一致")
    for name, item in value["attachments"].items():
        if not isinstance(item, dict) or set(item) != {"source", "artifact"}:
            raise ValueError("文件派单附件必须仅含来源和产物元数据")
        source, raw = item["source"], item["artifact"]
        if (not isinstance(source, dict) or set(source) != {"workload_id", "shard_id", "result_id"}
                or not all(_uuid(identifier) for identifier in source.values())
                or not isinstance(raw, dict) or set(raw) != _ARTIFACT_FIELDS
                or raw.get("schema") != "artifact.v1" or type(raw.get("size_bytes")) is not int
                or raw["size_bytes"] < 1 or type(raw.get("account_id")) is not int
                or not isinstance(raw.get("object_version_id"), str)
                or raw["object_version_id"].lower() == "null"
                or any(raw.get(key) != source[key] for key in source)):
            raise ValueError("文件派单附件来源或精确版本无效")
        artifact = ArtifactV1.model_validate(raw)
        if artifact.model_dump(by_alias=True) != raw:
            raise ValueError("文件派单产物元数据必须是冻结的规范值")
        validate_artifact_against_context(artifact, account_id=value["account_id"],
                                          workload_id=source["workload_id"], shard_id=source["shard_id"])
        if schema and (artifact.size_bytes > slots[name]["maxBytes"]
                       or artifact.content_type not in slots[name]["contentTypes"]):
            raise ValueError("文件派单附件超出审核声明")
    return json.loads(encoded)


def project_file_assignment_contract(workload, *, task_type: str) -> dict | None:
    """Only reviewed file tasks receive frozen metadata; ordinary assignments receive no field."""
    requirements = workload.spec.requirements or {}
    from platform_v8.engine.task_registry import TASK_REGISTRY, get_spec
    known = TASK_REGISTRY.get(task_type)
    raw_reviewed = requirements.get("_reviewed_task_contract")
    reviewed = raw_reviewed if isinstance(raw_reviewed, dict) else {}
    if (BINDING_KEY not in requirements and not reviewed.get("file_schema_sha256")
            and not getattr(known, "adapter_file_schema", None)):
        return None
    spec = get_spec(task_type)
    schema = getattr(spec, "adapter_file_schema", None)
    if (not schema or task_type != workload.spec.task_type
            or getattr(spec, "adapter_input_contract", "") == "__blocked__"
            or not isinstance(raw_reviewed, dict) or reviewed.get("schema") != "qianshou.reviewed-workload-contract.v1"
            or reviewed.get("file_schema_sha256") != file_schema_sha256(schema)):
        raise ValueError("文件派单缺少当前已审核声明")
    frozen = validate_file_assignment_contract(requirements.get(BINDING_KEY), account_id=int(workload.owner_id),
                                                task_type=task_type, file_schema=schema)
    if frozen["contract_sha256"] != reviewed.get("contract_sha256"):
        raise ValueError("文件派单摘要与冻结审核合同不一致")
    return frozen
