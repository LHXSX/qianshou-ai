"""Versioned path-free H3 execution identity; private device configuration is separate."""
from __future__ import annotations

import hashlib
import re
from typing import Any
from .native_h3 import INPUT_CONTRACT, RESULT_STRATEGY, canonical, _title

ABI = "qianshou.order-runtime.native-h3.v2"
RUNTIME = {"engine": "h3", "version": "h3-runtime-v2",
           "entrySha256": "47e701742c3f4a38845e562ab7d578cb4de16877f9f13f60dca35d509ba860b8",
           "runtimeSha256": "2c4690b84aefc3fcf036de2b9ccc73f4b68fca33560b208123a9c5ffff239bdf"}


BINDING_SCHEMA = "qianshou.native-h3-execution-binding.v2"
DECLARATION_SCHEMA = "qianshou.native-h3-binding.v2"
DEFINITION_SCHEMA = "qianshou.reviewed-task-definition.v2"
BINDING_FIELDS = {"schema", "runtimeAbi", "runtime", "executionRecipeSha256", "modelSha256", "firstFrameSha256"}
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_SLUG = re.compile(r"[a-z][a-z0-9_.-]{2,99}\Z")


def validate_binding(value: Any) -> dict[str, Any]:
    """Require actual fixed recipe, five-weight-set and PNG byte digests without paths."""
    if (not isinstance(value, dict) or set(value) != BINDING_FIELDS
            or value.get("schema") != BINDING_SCHEMA or value.get("runtimeAbi") != ABI
            or value.get("runtime") != RUNTIME
            or any(not isinstance(value.get(key), str) or not _SHA.fullmatch(value[key])
                   for key in ("executionRecipeSha256", "modelSha256", "firstFrameSha256"))):
        raise ValueError("native H3 v2 logical execution identity invalid")
    return value


def logical_binding_sha256(binding: Any) -> str:
    """Hash only the six public execution fields using canonical JSON, never private paths."""
    return hashlib.sha256(canonical(validate_binding(binding))).hexdigest()


def validate_definition(row: dict[str, Any]) -> dict[str, Any]:
    """Accept only a v2 single-shard fixed-frame, five-second ordinary-text video contract."""
    value = row.get("task_definition")
    required = {"schema", "taskType", "capabilityId", "category", "inputKinds", "outputKind",
                "inputContract", "resultStrategy", "paramsSchema", "inputSchema", "nativeBinding"}
    if (not isinstance(value, dict) or not required <= set(value)
            or set(value) - required - {"title", "description"}
            or value.get("schema") != DEFINITION_SCHEMA or row.get("contract_version") != "v2"
            or value.get("taskType") != row.get("task_type")
            or not isinstance(row.get("task_type"), str) or not _SLUG.fullmatch(row["task_type"])
            or value.get("capabilityId") != row.get("capability_id") or row.get("capability_id") != "video.render"
            or value.get("category") != row.get("category") or row.get("category") != "video"
            or value.get("inputKinds") != row.get("input_kinds") or row.get("input_kinds") != ["inline"]
            or value.get("outputKind") != row.get("output_kind") or row.get("output_kind") != "artifact_ref"
            or value.get("inputContract") != INPUT_CONTRACT or value.get("resultStrategy") != RESULT_STRATEGY
            or len(canonical(value)) > 8192):
        raise ValueError("native H3 v2 declaration differs from fixed policy")
    digest = logical_binding_sha256(value["nativeBinding"])
    if "package_digest" in row and row["package_digest"] != "sha256:" + digest:
        raise ValueError("native H3 v2 package digest is not its public execution identity")
    for name, limit in (("title", 80), ("description", 500)):
        if name in value and (not isinstance(value[name], str) or not value[name].strip() or len(value[name]) > limit):
            raise ValueError("native H3 v2 presentation invalid")
    form = _title(value["inputSchema"])
    if (form != {"type": "string", "minLength": 1, "maxLength": 7000, "contentMediaType": "text/plain"}
            or type(form.get("minLength")) is not int or type(form.get("maxLength")) is not int):
        raise ValueError("native H3 v2 requires bounded ordinary text")
    params = value["paramsSchema"]
    if (not isinstance(params, dict) or set(params) != {"type", "required", "properties", "additionalProperties"}
            or params.get("type") != "object" or params.get("additionalProperties") is not False
            or params.get("required") not in ([], ["seconds"])
            or not isinstance(params.get("properties"), dict) or set(params["properties"]) != {"seconds", "seed"}
            or _title(params["properties"]["seconds"]) != {"type": "integer", "enum": [5], "minimum": 5, "maximum": 5}
            or _title(params["properties"]["seed"]) != {"type": "integer", "minimum": 1, "maximum": 2147483647}
            or type(params["properties"]["seconds"]["enum"][0]) is not int
            or type(params["properties"]["seed"]["minimum"]) is not int
            or type(params["properties"]["seed"]["maximum"]) is not int):
        raise ValueError("native H3 v2 parameters are fixed five seconds and optional seed")
    return value


def validate_declaration(value: Any, row: dict[str, Any]) -> dict[str, Any]:
    """Inspect exactly thirteen path-free fields in the signed four-file package."""
    binding = validate_definition(row)["nativeBinding"]
    expected = {"schema": DECLARATION_SCHEMA,
                **{key: binding[key] for key in BINDING_FIELDS - {"schema"}},
                "taskType": row["task_type"], "capabilityId": "video.render", "inputKinds": ["inline"],
                "outputKind": "artifact_ref", "contractVersion": "v2", "category": "video",
                "platformDispatchable": True}
    if not isinstance(value,dict) or value.get("platformDispatchable") is not True or value != expected:
        raise ValueError("native H3 v2 package includes unsupported fields or private configuration")
    return value
