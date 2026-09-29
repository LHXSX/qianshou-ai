"""Offline byte-only validation used by the explicit Windows V2 upgrader.

It compiles all twenty measured roles and imports only the three fixed identity
modules from their frozen bytes. It never imports an API gateway or Comfy graph,
starts services, resolves model files, or turns a V1 receipt into V2 evidence.
"""
from __future__ import annotations

import ast
import base64
import hashlib
import json
import re
import sys
import types

ROLES = frozenset({"adapter", "graphBuilder", "identity", "identityV2", "runtimeAttestation",
    "comfyGraph", "gateway", "jobs", "schemas", "workflows", "comfyMain", "comfyFolderPaths",
    "comfyExecution", "comfyCaching", "comfyCliArgs", "dualClockNode", "dualClockSampling",
    "dualClockCore", "h3ComfyNodes", "sageNode"})
HEX = re.compile(r"[0-9a-f]{64}\Z")
EXPECTED_PATHS = {
    "adapter": ("api", "workbench/workbench_node.py"),
    "graphBuilder": ("api", "workbench/graphs.py"),
    "identity": ("api", "workbench/recipe_identity.py"),
    "identityV2": ("api", "workbench/recipe_identity_v2.py"),
    "runtimeAttestation": ("api", "workbench/runtime_attestation.py"),
    "comfyGraph": ("api", "local_h3/comfy.py"), "gateway": ("api", "local_h3/app.py"),
    "jobs": ("api", "local_h3/jobs.py"), "schemas": ("api", "local_h3/schemas.py"),
    "workflows": ("api", "local_h3/workflows.py"), "comfyMain": ("comfy", "main.py"),
    "comfyFolderPaths": ("comfy", "folder_paths.py"), "comfyExecution": ("comfy", "execution.py"),
    "comfyCaching": ("comfy", "comfy_execution/caching.py"), "comfyCliArgs": ("comfy", "comfy/cli_args.py"),
    "dualClockNode": ("comfy", "custom_nodes/h3_benchmark_sampler/__init__.py"),
    "dualClockSampling": ("comfy", "custom_nodes/h3_benchmark_sampler/sampling.py"),
    "dualClockCore": ("comfy", "custom_nodes/h3_benchmark_sampler/core.py"),
    "h3ComfyNodes": ("comfy", "comfy_extras/nodes_minimax_h3.py"),
    "sageNode": ("comfy", "custom_nodes/ComfyUI-KJNodes/nodes/model_optimization_nodes.py"),
}


def validate(payload: dict, *, import_modules: bool = True) -> dict:
    """Validate trusted caller pins and byte closure without importing services."""
    if sys.version_info < (3, 11):
        raise ValueError("Python 3.11 or newer required")
    if not isinstance(payload, dict) or set(payload) != {"schema", "phase", "records"}:
        raise ValueError("Invalid offline validation envelope")
    if payload["schema"] != "qianshou.h3-v2-install-validation.v1" or payload["phase"] not in ("baseline", "target"):
        raise ValueError("Invalid offline validation phase")
    rows = payload["records"]
    if not isinstance(rows, list) or len(rows) != 20:
        raise ValueError("Exact twenty measured source roles required")
    content = {}
    trees = {}
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {"role", "root", "path", "sha256", "base64"}
                or row["role"] not in ROLES or row["role"] in content
                or (row["root"], row["path"]) != EXPECTED_PATHS[row["role"]]
                or not isinstance(row["sha256"], str) or not HEX.fullmatch(row["sha256"])):
            raise ValueError("Unknown, duplicate, unpinned or redirected source role")
        data = base64.b64decode(row["base64"], validate=True)
        if not 0 < len(data) <= 4 * 1024 * 1024 or b"\r" in data:
            raise ValueError("Canonical source must be bounded LF bytes")
        if hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise ValueError("Frozen source bytes no longer match pin")
        compile(data, row["path"], "exec")
        content[row["role"]] = data
        trees[row["role"]] = ast.parse(data, row["path"])
    if set(content) != ROLES:
        raise ValueError("Source role closure missing")
    adapter = trees["adapter"]
    imports = {n.module for n in ast.walk(adapter) if isinstance(n, ast.ImportFrom)}
    required = {"graphs", "recipe_identity", "runtime_attestation"}
    if payload["phase"] == "target":
        required.add("recipe_identity_v2")
        literals = {n.value for n in ast.walk(adapter) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
        if not {"/v2/recipes/qs_new4/identity", "/v2/jobs", "qs.h3.job-identity.v2", "qs.h3.execution-expected.v2"} <= literals:
            raise ValueError("Explicit V2 route/schema contract missing")
        functions = {n.name for n in adapter.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
        if not {"attested_request", "attested_request_v2", "create_app", "main"} <= functions:
            raise ValueError("Version-forked adapter functions missing")
    if not required <= imports:
        raise ValueError("Adapter identity imports missing")
    if import_modules:
        import yaml  # Require the actual YAML dependency without reading private configuration.
        # Only these three fixed, reviewed modules are imported. Neither a
        # graph builder, service gateway nor a Comfy package is executed.
        names = (("identity", "recipe_identity"), ("runtimeAttestation", "runtime_attestation"),
                 ("identityV2", "recipe_identity_v2"))
        prior = {name: sys.modules.get(name) for _role, name in names}
        try:
            for role, name in names:
                module = types.ModuleType(name)
                module.__file__ = "frozen-bytes/" + EXPECTED_PATHS[role][1]
                sys.modules[name] = module
                exec(compile(content[role], module.__file__, "exec"), module.__dict__)
            if sys.modules["recipe_identity"].SCHEMA_VERSION != "qs.h3.recipe-identity.v1":
                raise ValueError("V1 schema changed")
            v2 = sys.modules["recipe_identity_v2"]
            if v2.SCHEMA_VERSION != "qs.h3.recipe-identity.v2" or v2.CODE_ROLES != ROLES:
                raise ValueError("V2 identity source contract changed")
        finally:
            for _role, name in names:
                if prior[name] is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = prior[name]
    return {"schema": "qianshou.h3-v2-install-validation-result.v1", "phase": payload["phase"],
            "compiledRoles": 20, "importedIdentityModules": 3 if import_modules else 0,
            "staticRouteContract": True, "servicesStarted": False, "gpuExecuted": False}


if __name__ == "__main__":
    raw = sys.stdin.buffer.read(32 * 1024 * 1024 + 1)
    if len(raw) > 32 * 1024 * 1024:
        raise ValueError("Validation envelope too large")
    print(json.dumps(validate(json.loads(raw)), separators=(",", ":")))
