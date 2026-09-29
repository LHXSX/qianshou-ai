"""Data-only admission for the fixed, five-second H3 native binding.

The private first frame, model paths and executable commands never belong in
this declaration. Actual graph/model byte digests are separately pinned; a
directory listing, model stat or arbitrary workflow JSON is not their source.
"""
from __future__ import annotations

import json
import re
from typing import Any

ABI = "qianshou.order-runtime.native-h3.v1"
SCHEMA = "qianshou.native-h3-binding.v1"
INPUT_CONTRACT = "h3-prompt-fixed-frame.v1"
RESULT_STRATEGY = "external-media.v1"
INVENTORY = "qianshou.native-binding-package.v1"
FILES = ("local-adapter.json", "package.json", "pnpm-lock.yaml", "task-definition.json")
MAX_INPUT_BYTES = 32 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
RUNTIME = {"engine": "h3", "version": "h3-runtime-v1",
           "entrySha256": "9af9d263aa8b9d9e68c73e6b5686de86a43df10e208add88df24064efd2f4467",
           "runtimeSha256": "cf977bcf259901274cf2b44016fa0964f59b661c8d663b75a08f4dbe45c66e52"}
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
_SLUG = re.compile(r"[a-z][a-z0-9_.-]{2,99}\Z")


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def validate_binding(value: Any) -> dict[str, Any]:
    """Validate public metadata, without granting device or publication readiness."""
    if (not isinstance(value, dict) or set(value) != {
            "runtimeAbi", "runtime", "ownerConfigDigest", "executionRecipeSha256", "modelSha256"}
            or value.get("runtimeAbi") != ABI or value.get("runtime") != RUNTIME
            or not isinstance(value.get("ownerConfigDigest"), str)
            or not _DIGEST.fullmatch(value["ownerConfigDigest"])
            or any(not isinstance(value.get(name), str) or not _SHA.fullmatch(value[name])
                   for name in ("executionRecipeSha256", "modelSha256"))):
        raise ValueError("fixed native H3 binding or actual graph/model digests missing")
    return value


def _title(rule: Any) -> Any:
    if not isinstance(rule, dict):
        raise ValueError("native H3 field schema invalid")
    if "title" in rule and (not isinstance(rule["title"], str) or not 1 <= len(rule["title"]) <= 100):
        raise ValueError("native H3 field title invalid")
    return {key: value for key, value in rule.items() if key != "title"}


def validate_definition(row: dict[str, Any]) -> dict[str, Any]:
    """Only this policy can propose an external MP4 native task, never arbitrary code."""
    value = row.get("task_definition")
    required = {"schema", "taskType", "capabilityId", "category", "inputKinds", "outputKind",
                "inputContract", "resultStrategy", "paramsSchema", "inputSchema", "nativeBinding"}
    if (not isinstance(value, dict) or not required <= set(value)
            or set(value) - required - {"title", "description"}
            or value.get("schema") != "qianshou.reviewed-task-definition.v1"
            or value.get("taskType") != row.get("task_type")
            or not isinstance(row.get("task_type"), str) or not _SLUG.fullmatch(row["task_type"])
            or value.get("capabilityId") != row.get("capability_id") or row.get("capability_id") != "video.render"
            or value.get("category") != row.get("category") or row.get("category") != "video"
            or value.get("inputKinds") != row.get("input_kinds") or row.get("input_kinds") != ["inline"]
            or value.get("outputKind") != row.get("output_kind") or row.get("output_kind") != "artifact_ref"
            or row.get("contract_version") != "v1"
            or value.get("inputContract") != INPUT_CONTRACT or value.get("resultStrategy") != RESULT_STRATEGY
            or len(canonical(value)) > 8192):
        raise ValueError("native H3 declaration differs from its fixed platform policy")
    binding = validate_binding(value["nativeBinding"])
    if "package_digest" in row and row["package_digest"] != binding["ownerConfigDigest"]:
        raise ValueError("native H3 owner configuration differs from publication")
    for name, limit in (("title", 80), ("description", 500)):
        if name in value and (not isinstance(value[name], str) or not value[name].strip()
                              or len(value[name]) > limit):
            raise ValueError("native H3 presentation invalid")
    form = _title(value["inputSchema"])
    if (form != {"type": "string", "minLength": 1, "maxLength": 7000,
                 "contentMediaType": "text/plain"}
            or type(form.get("minLength")) is not int or type(form.get("maxLength")) is not int):
        raise ValueError("native H3 requires a bounded ordinary text prompt")
    params = value["paramsSchema"]
    if (not isinstance(params, dict) or set(params) != {
            "type", "required", "properties", "additionalProperties"}
            or params.get("type") != "object" or params.get("additionalProperties") is not False
            or params.get("required") not in ([], ["seconds"])
            or not isinstance(params.get("properties"), dict)
            or set(params["properties"]) != {"seconds", "seed"}
            or _title(params["properties"]["seconds"]) != {"type": "integer", "enum": [5], "minimum": 5, "maximum": 5}
            or _title(params["properties"]["seed"]) != {
                "type": "integer", "minimum": 1, "maximum": 2147483647}
            or type(params["properties"]["seconds"]["enum"][0]) is not int
            or type(params["properties"]["seed"]["minimum"]) is not int
            or type(params["properties"]["seed"]["maximum"]) is not int):
        raise ValueError("native H3 task parameters must be five seconds and optional seed")
    return value


def validate_declaration(value: Any, row: dict[str, Any]) -> dict[str, Any]:
    """Inspect exactly the public binding fields from the signed four-file archive."""
    definition = validate_definition(row)
    binding = definition["nativeBinding"]
    expected = {"schema": SCHEMA, "runtimeAbi": ABI, "taskType": row["task_type"],
                "capabilityId": "video.render", "inputKinds": ["inline"], "outputKind": "artifact_ref",
                "contractVersion": "v1", "category": "video", "platformDispatchable": True,
                **{key: binding[key] for key in ("ownerConfigDigest", "runtime", "executionRecipeSha256", "modelSha256")}}
    if value != expected:
        raise ValueError("native H3 package contains unsupported code, paths or binding fields")
    return value


def validate_order(*, input_kind: str, inline_input: Any, params: Any) -> dict[str, Any]:
    """Accept buyer text only; first frame and model configuration remain private to the owner."""
    if (input_kind != "inline" or not isinstance(inline_input, str)
            or not 1 <= len(inline_input) <= 7000 or not inline_input.strip()
            or not isinstance(params, dict) or set(params) - {"seconds", "seed"}
            or ("seconds" in params and (type(params["seconds"]) is not int or params["seconds"] != 5))
            or ("seed" in params and (type(params["seed"]) is not int or not 1 <= params["seed"] <= 2147483647))):
        raise ValueError("H3只接受视频描述、固定5秒和可选随机种子")
    if len(inline_input.encode("utf-8")) > MAX_INPUT_BYTES:
        raise ValueError("H3视频描述超过输入上限")
    return {"prompt": inline_input.strip(), "seconds": 5,
            **({"seed": params["seed"]} if "seed" in params else {})}


def validate_recipe(*, input_kind: str, inline_input: Any, params: Any) -> dict[str, Any]:
    """Verify the persisted internal JSON recipe using the same public text policy."""
    if input_kind != "inline" or not isinstance(inline_input, str) or params != {"output_format": "mp4"}:
        raise ValueError("native H3 persisted recipe parameters invalid")
    if len(inline_input.encode("utf-8")) > MAX_INPUT_BYTES:
        raise ValueError("native H3 persisted recipe exceeds limit")
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate native H3 recipe field")
            value[key] = item
        return value
    value = json.loads(inline_input, object_pairs_hook=unique,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite recipe")))
    if not isinstance(value, dict) or "prompt" not in value or set(value) - {"prompt", "seconds", "seed"}:
        raise ValueError("native H3 persisted recipe contains unsupported fields")
    return validate_order(input_kind="inline", inline_input=value["prompt"],
                          params={key: item for key, item in value.items() if key != "prompt"})
