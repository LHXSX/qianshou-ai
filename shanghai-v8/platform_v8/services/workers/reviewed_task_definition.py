"""Build a bounded engine contract from a publication's reviewed declaration.

The author proposes policy IDs, never executable policy code. Independent
review signs the resulting task-contract digest. Runtime admission also needs
live package, sample, pricing and review evidence before registering the spec.
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

from platform_v8.engine.task_registry import TaskTypeSpec
from platform_v8.services.workloads.reviewed_json_shape import validate_shape_schema
from platform_v8.protocol.generic_file import FILE_POLICY, validate_file_schema

_SLUG = re.compile(r"[a-z][a-z0-9_.-]{2,99}\Z")
_FIELD = re.compile(r"[a-z][a-z0-9_.-]{0,63}\Z")
_POLICY = re.compile(r"[a-z][a-z0-9_.-]{2,99}\Z")
_SCHEMA = "qianshou.reviewed-task-definition.v1"


def candidate_spec(row: dict[str, Any]) -> TaskTypeSpec | None:
    """Parse a proposed single-shard inline contract; never grant readiness.

    The buyer-confirmed strategy admits new inline categories with a bounded
    output shape, while escrow remains frozen until the buyer accepts. It does
    not turn a shape check into an automatic semantic verdict.
    """
    definition = row.get("task_definition")
    if not isinstance(definition, dict):
        return None
    if definition.get("inputContract") == "h3-prompt-fixed-frame.v1" or "nativeBinding" in definition:
        from platform_v8.protocol.native_h3 import validate_definition
        if row.get("contract_version") == "v2":
            from platform_v8.protocol.native_h3_v2 import validate_definition
        try:
            native = validate_definition(row)
        except (ValueError, TypeError, UnicodeError, RecursionError):
            return None
        return TaskTypeSpec(
            task_type=row["task_type"], category="video", description=str(row.get("description", ""))[:1000],
            accepted_input_kinds=("inline",), default_input_kind="inline", slicer="single",
            aggregator="artifact_reference", runtimes=("python3",), requires_gpu=True,
            default_max_shards=1, max_shards_limit=1, settlement_policy="artifact", exact_input_kinds=True,
            requires_verified_adapter=True, adapter_capability_id="video.render", adapter_output_kind="artifact_ref",
            adapter_input_contract=native["inputContract"], adapter_result_strategy=native["resultStrategy"],
            parameter_schema=native["paramsSchema"], inline_input_form=native["inputSchema"],
            external_artifact_verifier_required=True,
        )
    try:
        if len(json.dumps(definition, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=False, allow_nan=False).encode("utf-8")) > 8192:
            return None
    except (TypeError, ValueError, UnicodeError, RecursionError):
        return None
    fields = {"schema", "taskType", "capabilityId", "category",
              "inputKinds", "outputKind", "inputContract",
              "resultStrategy", "paramsSchema", "inputSchema"}
    if (not isinstance(definition, dict)
            or not fields <= set(definition)
            or set(definition) - fields - {"outputSchema", "title", "description", "fileSchema"}
            or definition.get("schema") != _SCHEMA
            or definition.get("taskType") != row.get("task_type")
            or definition.get("capabilityId") != row.get("capability_id")
            or definition.get("category") != row.get("category")
            or definition.get("inputKinds") != row.get("input_kinds")
            or definition.get("outputKind") != row.get("output_kind")
            or not isinstance(row.get("task_type"), str)
            or not _SLUG.fullmatch(row["task_type"])
            or not isinstance(row.get("category"), str)
            or not _SLUG.fullmatch(row["category"])
            or not isinstance(row.get("capability_id"), str)
            or not _SLUG.fullmatch(row["capability_id"])
            or row.get("input_kinds") != ["inline"]
            or row.get("output_kind") not in {"inline_json", "artifact_ref"}
            or row.get("contract_version") != "v1"
            or not isinstance(definition.get("inputContract"), str)
            or not _POLICY.fullmatch(definition["inputContract"])
            or not isinstance(definition.get("resultStrategy"), str)
            or not _POLICY.fullmatch(definition["resultStrategy"])):
        return None
    for key, limit in (("title", 80), ("description", 500)):
        if key in definition and (not isinstance(definition[key], str)
                                  or not definition[key].strip()
                                  or len(definition[key]) > limit):
            return None
    params = definition["paramsSchema"]
    form = definition["inputSchema"]
    file_schema = {}
    if "fileSchema" in definition:
        if (definition["inputContract"] != "inline-json-bounded.v1"
                or definition["resultStrategy"] != FILE_POLICY or row["output_kind"] != "artifact_ref"):
            return None
        try:
            file_schema = validate_file_schema(definition["fileSchema"])
        except (ValueError, TypeError):
            return None
    elif row["output_kind"] != "inline_json" or definition["resultStrategy"] == FILE_POLICY:
        return None
    buyer_confirmed = definition["resultStrategy"] == "buyer-confirmed-structure.v1"
    if buyer_confirmed:
        if (definition["inputContract"] != "inline-json-bounded.v1"
                or "outputSchema" not in definition):
            return None
        try:
            output_schema = validate_shape_schema(definition["outputSchema"])
        except ValueError:
            return None
    else:
        if "outputSchema" in definition:
            return None
        output_schema = {}
    if (not isinstance(params, dict) or params.get("type") != "object"
            or params.get("additionalProperties") is not False
            or not isinstance(params.get("required"), list)
            or not isinstance(params.get("properties"), dict)
            or not isinstance(form, dict) or form.get("type") != "string"
            or type(form.get("maxLength")) is not int
            or not 1 <= form["maxLength"] <= 16384
            or not set(form).issubset({"type", "minLength", "maxLength",
                                       "contentMediaType", "title", "contentSchema"})
            or type(form.get("minLength", 0)) is not int
            or not 0 <= form.get("minLength", 0) <= form["maxLength"]
            or form.get("contentMediaType", "application/json") != "application/json"
            or not isinstance(form.get("title", ""), str)
            or len(form.get("title", "")) > 100):
        return None
    if len(json.dumps(form, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")) > 4096:
        return None
    if "contentSchema" in form:
        # JSON content remains the existing nonempty-object input contract.
        # Its field constraints travel inside the independently reviewed form.
        if (form.get("contentMediaType") != "application/json"
                or definition["inputContract"] != "inline-json-bounded.v1"):
            return None
        try:
            content_schema = validate_shape_schema(form["contentSchema"])
        except ValueError:
            return None
        if content_schema["type"] != "object":
            return None
    # Keep the declarative schema within the scalar subset enforced by
    # submit._validate_required_task_params; unsupported keywords are rejected
    # instead of becoming misleading UI-only promises.
    if set(params) != {"type", "required", "properties", "additionalProperties"}:
        return None
    if (len(params["properties"]) > 16 or len(params["required"]) > 16
            or any(not isinstance(name, str) or not _FIELD.fullmatch(name)
                   for name in params["required"])
            or len(set(params["required"])) != len(params["required"])
            or not set(params["required"]).issubset(params["properties"])):
        return None
    for name, rule in params["properties"].items():
        if (not isinstance(name, str) or not _FIELD.fullmatch(name)
                or not isinstance(rule, dict)
                or not isinstance(rule.get("type"), str)
                or rule["type"] not in {"string", "integer", "number", "boolean"}
                or not set(rule).issubset({"type", "minimum", "maximum", "minLength",
                                           "maxLength", "enum", "title"})):
            return None
        kind = rule["type"]
        if (not isinstance(rule.get("title", ""), str)
                or len(rule.get("title", "")) > 100
                or any(key in rule for key in ("minimum", "maximum"))
                and kind not in {"integer", "number"}
                or any(key in rule for key in ("minLength", "maxLength"))
                and kind != "string"):
            return None
        for key in ("minimum", "maximum"):
            if key in rule and (type(rule[key]) not in (int, float)
                                or not math.isfinite(rule[key])):
                return None
        for key in ("minLength", "maxLength"):
            if key in rule and (type(rule[key]) is not int
                                or not 0 <= rule[key] <= 16384):
                return None
        if ("minimum" in rule and "maximum" in rule
                and rule["minimum"] > rule["maximum"]):
            return None
        if ("minLength" in rule and "maxLength" in rule
                and rule["minLength"] > rule["maxLength"]):
            return None
        enum = rule.get("enum")
        if enum is not None and (not isinstance(enum, list) or not 1 <= len(enum) <= 32
                                 or any(type(value) is not {"string": str,
                                                             "integer": int,
                                                             "number": float,
                                                             "boolean": bool}[kind]
                                        and not (kind == "number" and type(value) is int)
                                        for value in enum)):
            return None
    if not isinstance(row.get("description"), str):
        return None
    if file_schema and (params["properties"] or params["required"]):
        # This initial ABI passes logical JSON and attachment slots, never user task params.
        return None
    return TaskTypeSpec(
        task_type=row["task_type"], category=row["category"],
        description=row["description"][:1000],
        accepted_input_kinds=("inline",), default_input_kind="inline",
        slicer="single", aggregator="artifact_reference" if file_schema else "inline_concat",
        runtimes=("python3",), default_max_shards=1, max_shards_limit=1,
        settlement_policy="artifact" if file_schema else "semantic", exact_input_kinds=True,
        requires_verified_adapter=True,
        adapter_capability_id=row["capability_id"],
        adapter_output_kind=row["output_kind"],
        adapter_input_contract=definition["inputContract"],
        adapter_result_strategy=definition["resultStrategy"],
        parameter_schema=params, inline_input_form=form,
        adapter_output_schema=output_schema,
        adapter_file_schema=file_schema,
        external_artifact_verifier_required=bool(file_schema),
    )
