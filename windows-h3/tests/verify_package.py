"""Offline integrity, source-safety and import-closure checks for the fixed H3 source kit.

This tool never imports the running H3 API or ComfyUI and never touches their
installation directories. It reads only this source kit and uses an isolated
temporary directory for the small import smoke test.
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import argparse
import ast
import hashlib
import importlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "manifest.json"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
BLOCKED_NAMES = re.compile(
    r"(?:^|/)(?:\.env(?:\..*)?|extra_model_paths\.ya?ml|owner\.config(?:\..*)?|"
    r".*\.(?:safetensors|ckpt|pt|pth|bin|mp4|mov|mkv|png|jpe?g|webp|wav|mp3|log|key|pem))$",
    re.IGNORECASE,
)
PRIVATE_PATH = re.compile(
    rb"(?i)(?:\b[A-Z]:[\\/]|/(?:opt|home|Users|mnt|media)/|\\\\[^\\\s]+\\[^\\\s]+)"
)
SECRET = re.compile(
    rb"(?i)(?:-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|"
    rb"\b(?:sk-[A-Za-z0-9_-]{20,}|LTAI[A-Za-z0-9]{16,})\b|"
    rb"\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['\"][A-Za-z0-9_./+=-]{12,}['\"])"
)


def fail(message: str) -> None:
    raise AssertionError(message)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_bytes(path: Path) -> bytes:
    data = path.read_bytes()
    if b"\x00" in data:
        fail(f"binary content forbidden: {path.relative_to(ROOT).as_posix()}")
    if b"\r" in data.replace(b"\r\n", b""):
        fail(f"lone CR forbidden: {path.relative_to(ROOT).as_posix()}")
    return data


def safe_relative_path(value: str) -> Path:
    posix = PurePosixPath(value)
    if posix.is_absolute() or not value or "\\" in value or any(p in ("", ".", "..") for p in posix.parts):
        fail(f"unsafe manifest path: {value!r}")
    return ROOT.joinpath(*posix.parts)


def verify_manifest() -> tuple[dict, list[Path]]:
    obj = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if obj.get("schemaVersion") != 1 or obj.get("scope") != "qs_new4/E_light4_sage":
        fail("unsupported manifest schema or recipe scope")
    vendors = obj.get("vendors")
    if not isinstance(vendors, list) or {v.get("name") for v in vendors} != {
        "ComfyUI", "ComfyUI-KJNodes", "ComfyUI_LayerStyle", "ComfyUI-VideoHelperSuite"
    }:
        fail("four pinned vendor trees required")
    for vendor in vendors:
        if not re.fullmatch(r"[0-9a-f]{40}", vendor.get("commit", "")) or not re.fullmatch(
            r"[0-9a-f]{40}", vendor.get("tree", "")
        ):
            fail(f"vendor commit/tree pin missing: {vendor.get('name')}")
        if not vendor.get("origin", "").startswith("https://github.com/") or not vendor.get("license"):
            fail(f"vendor origin/license missing: {vendor.get('name')}")
    vendor_lock = json.loads((ROOT / "comfy" / "vendor-lock.json").read_text(encoding="utf-8"))
    vendor_keys = {
        "ComfyUI": "comfyui",
        "ComfyUI-KJNodes": "kjnodes",
        "ComfyUI_LayerStyle": "layerstyle",
        "ComfyUI-VideoHelperSuite": "videohelpersuite",
    }
    for vendor in vendors:
        locked = vendor_lock["vendors"][vendor_keys[vendor["name"]]]
        for field in ("origin", "commit", "tree", "version", "license", "licenseSha256"):
            if vendor.get(field) != locked.get(field):
                fail(f"vendor manifest/lock mismatch: {vendor['name']}:{field}")
        expected_patch = "comfy/" + locked["patch"] if locked.get("patch") else None
        if vendor.get("patchPath") != expected_patch or vendor.get("patchSha256") != locked.get("patchSha256"):
            fail(f"vendor patch manifest/lock mismatch: {vendor['name']}")
    for kind in ("liveBaseline10", "canonicalTarget10"):
        roles = obj.get(kind)
        if not isinstance(roles, list) or len(roles) != 10 or len({r.get("role") for r in roles}) != 10:
            fail(f"{kind} must contain ten unique roles")
        for role in roles:
            rel = role.get("path", "")
            if not rel or "\\" in rel or PurePosixPath(rel).is_absolute() or ".." in PurePosixPath(rel).parts:
                fail(f"unsafe role path in {kind}")
            if not SHA256.fullmatch(role.get("rawSha256", "")) or not SHA256.fullmatch(role.get("lfSha256", "")):
                fail(f"malformed role hash in {kind}: {role.get('role')}")
    if {r["role"] for r in obj["liveBaseline10"]} != {r["role"] for r in obj["canonicalTarget10"]}:
        fail("live/canonical role sets differ")
    class_types = obj.get("requiredGraphClassTypes")
    if not isinstance(class_types, list) or len(class_types) != 17 or class_types != sorted(set(class_types)):
        fail("fixed graph class-type inventory is incomplete or unsorted")
    if obj.get("runtimeInventoryRoots") != [
        {"area": "h3_api", "relativeDir": ".", "extension": ".py", "recursive": True},
        {"area": "comfy", "relativeDir": ".", "extension": ".py", "recursive": True},
    ]:
        fail("runtime Python inventory roots changed")
    expected_excludes = [
        {"area": "comfy", "relativeDir": path} for path in (
            ".git", "custom_nodes/ComfyUI-KJNodes/.git",
            "custom_nodes/ComfyUI_LayerStyle/.git",
            "custom_nodes/ComfyUI-VideoHelperSuite/.git",
            "models", "input", "output", "temp", "user",
        )
    ]
    if obj.get("runtimeInventoryExcludeDirs") != expected_excludes:
        fail("runtime inventory exclusions changed")
    expected_aux_root = [{
        "area": "comfy", "relativeDir": "custom_nodes/ComfyUI-VideoHelperSuite/video_formats",
        "extension": ".json", "recursive": False,
    }]
    if obj.get("runtimeAuxiliaryInventoryDirs") != expected_aux_root:
        fail("VHS runtime auxiliary inventory root changed")
    for field in ("runtimeSourceFiles", "runtimeAuxiliaryFiles"):
        rows = obj.get(field)
        if not isinstance(rows, list) or not rows or rows != sorted(rows, key=lambda r: (r["area"], r["path"])):
            fail(f"{field} missing or unsorted")
        identities = set()
        for row in rows:
            area, rel = row.get("area"), row.get("path", "")
            if area not in ("h3_api", "comfy") or not rel or "\\" in rel or PurePosixPath(rel).is_absolute() or ".." in PurePosixPath(rel).parts:
                fail(f"unsafe runtime source path in {field}")
            identity = (area, rel)
            if identity in identities:
                fail(f"duplicate runtime source in {field}")
            identities.add(identity)
            if not isinstance(row.get("origin"), str) or not row["origin"] or not isinstance(row.get("size"), int) or row["size"] < 0:
                fail(f"runtime source origin/size missing in {field}: {identity}")
            if not SHA256.fullmatch(row.get("rawSha256", "")):
                fail(f"runtime source SHA malformed in {field}: {identity}")
    if len(obj["runtimeAuxiliaryFiles"]) != 13 or any(row["area"] != "comfy" or not row["path"].startswith("custom_nodes/ComfyUI-VideoHelperSuite/video_formats/") or not row["path"].endswith(".json") for row in obj["runtimeAuxiliaryFiles"]):
        fail("VHS full 13-JSON auxiliary inventory missing")
    for role in obj["canonicalTarget10"]:
        target = vendor_lock["targetSha256"].get(role["path"])
        if target is not None and role["rawSha256"] != target:
            fail(f"canonical role/vendor-lock SHA mismatch: {role['role']}")
    records = obj.get("files")
    if not isinstance(records, list) or not records:
        fail("manifest must list source files")
    abi = obj.get("runtimeAbi")
    if abi != "qs.h3.canonical.qs_new4.vnext":
        fail("canonical runtime ABI pin differs")
    identity_tree = ast.parse((ROOT / "h3_api/workbench/recipe_identity.py").read_bytes())
    declared_abi = [
        node.value.value for node in identity_tree.body
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
        and any(isinstance(target, ast.Name) and target.id == "RUNTIME_ABI" for target in node.targets)
    ]
    if declared_abi != [abi]:
        fail("manifest runtime ABI differs from the actual recipe identity source")
    pin_paths = {
        "entrySha256": "h3_api/workbench/workbench_node.py",
        "runnerSha256": "h3_api/workbench/runner.py",
        "identitySha256": "h3_api/workbench/recipe_identity.py",
        "sourceVerifierSha256": "h3_api/workbench/source_manifest.py",
        "comfyAttestorSha256": "comfy/custom_nodes/qs_h3_source_attestor/attestor.py",
    }
    for field, relative in pin_paths.items():
        if not SHA256.fullmatch(obj.get(field, "")) or digest((ROOT / relative).read_bytes()) != obj[field]:
            fail(f"canonical runtime pin differs: {field}")
    paths: list[Path] = []
    seen: set[str] = set()
    for record in records:
        rel = record["path"]
        path = safe_relative_path(rel)
        if rel in seen:
            fail(f"duplicate manifest path: {rel}")
        seen.add(rel)
        if not path.is_file() or path.is_symlink() or path.stat().st_nlink != 1:
            fail(f"missing or linked file: {rel}")
        if BLOCKED_NAMES.search(rel):
            fail(f"forbidden private, model, media or log filename: {rel}")
        if record.get("required") is not True:
            fail(f"file must declare required=true: {rel}")
        origin = record.get("origin")
        if not isinstance(origin, dict) or not all(origin.get(k) for k in ("project", "version", "license")):
            fail(f"missing origin/version/license: {rel}")
        for field in ("sourceRawSha256", "sourceLfSha256", "archiveRawSha256", "archiveLfSha256"):
            if not SHA256.fullmatch(record.get(field, "")):
                fail(f"missing or malformed {field}: {rel}")
        patch_sha = record.get("patchSha256")
        if patch_sha is not None and not SHA256.fullmatch(patch_sha):
            fail(f"malformed patchSha256: {rel}")
        if record["sourceRawSha256"] != record["archiveRawSha256"] and not record.get("changeKind"):
            fail(f"changed source needs a changeKind: {rel}")
        data = source_bytes(path)
        if record.get("size") != len(data):
            fail(f"archive byte size mismatch: {rel}")
        if digest(data) != record["archiveRawSha256"]:
            fail(f"raw SHA mismatch: {rel}")
        if digest(data.replace(b"\r\n", b"\n")) != record["archiveLfSha256"]:
            fail(f"LF SHA mismatch: {rel}")
        paths.append(path)

    # No unaccounted source, test, patch or license file may enter the kit.
    actual = {
        p.relative_to(ROOT).as_posix()
        for p in ROOT.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts
    }
    allowed = seen | {"manifest.json"}
    if actual != allowed:
        fail(f"manifest file set differs: missing={sorted(allowed-actual)}, unlisted={sorted(actual-allowed)}")
    return obj, paths


def verify_runtime_sources(obj: dict, comfy_root: Path) -> None:
    if comfy_root.is_symlink() or (hasattr(comfy_root, "is_junction") and comfy_root.is_junction()):
        fail("assembled Comfy root is redirected")
    roots = {"h3_api": ROOT / "h3_api", "comfy": comfy_root.resolve(strict=True)}
    excludes = {
        area: {row["relativeDir"] for row in obj["runtimeInventoryExcludeDirs"] if row["area"] == area}
        for area in roots
    }
    actual: set[tuple[str, str]] = set()
    for area, root in roots.items():
        for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
            current_path = Path(current)
            kept = []
            for dirname in dirs:
                child = current_path / dirname
                rel = child.relative_to(root).as_posix()
                if rel in excludes[area] or (area == "h3_api" and rel == "tests"):
                    continue
                if child.is_symlink() or (hasattr(child, "is_junction") and child.is_junction()):
                    fail(f"linked runtime source directory: {area}/{rel}")
                kept.append(dirname)
            dirs[:] = kept
            for filename in files:
                if not filename.endswith(".py") or (area == "h3_api" and filename == "assemble.py" and current_path == root):
                    continue
                path = current_path / filename
                rel = path.relative_to(root).as_posix()
                if not path.is_file() or path.is_symlink() or path.stat().st_nlink != 1:
                    fail(f"linked/missing runtime Python source: {area}/{rel}")
                actual.add((area, rel))
    expected = {(row["area"], row["path"]) for row in obj["runtimeSourceFiles"]}
    if actual != expected:
        fail(f"runtime Python inventory differs: missing={len(expected-actual)} extra={len(actual-expected)}")
    for row in obj["runtimeSourceFiles"]:
        path = roots[row["area"]].joinpath(*row["path"].split("/"))
        data = path.read_bytes()
        if len(data) != row["size"] or digest(data) != row["rawSha256"]:
            fail(f"runtime source hash/size mismatch: {row['area']}/{row['path']}")
    auxiliary_root = roots["comfy"] / "custom_nodes" / "ComfyUI-VideoHelperSuite" / "video_formats"
    if not auxiliary_root.is_dir() or auxiliary_root.is_symlink() or (hasattr(auxiliary_root, "is_junction") and auxiliary_root.is_junction()):
        fail("VHS video_formats directory missing/linked")
    actual_aux = {p.relative_to(roots["comfy"]).as_posix() for p in auxiliary_root.iterdir() if p.is_file() and p.suffix == ".json"}
    expected_aux = {row["path"] for row in obj["runtimeAuxiliaryFiles"]}
    if actual_aux != expected_aux or len(list(auxiliary_root.iterdir())) != len(expected_aux):
        fail("VHS JSON inventory differs")
    for row in obj["runtimeAuxiliaryFiles"]:
        path = roots["comfy"].joinpath(*row["path"].split("/"))
        if not path.is_file() or path.is_symlink() or path.stat().st_nlink != 1:
            fail("VHS JSON missing/linked")
        data = path.read_bytes()
        if len(data) != row["size"] or digest(data) != row["rawSha256"]:
            fail("VHS JSON hash/size mismatch")
    print(f"runtime inventory verified: {len(expected)} Python sources and {len(expected_aux)} VHS JSON files")


def verify_text_safety(paths: list[Path]) -> None:
    for path in paths:
        rel = path.relative_to(ROOT).as_posix()
        data = source_bytes(path)
        # The detector's own regex literals necessarily contain forbidden
        # examples. Exclude only those three assignments, then scan the rest
        # of this file just like every other archive text file.
        if rel == "tests/verify_package.py":
            source = data.decode("utf-8")
            tree = ast.parse(source, filename=rel)
            for node in tree.body:
                if not isinstance(node, ast.Assign):
                    continue
                if not any(isinstance(target, ast.Name) and target.id in
                           {"BLOCKED_NAMES", "PRIVATE_PATH", "SECRET"} for target in node.targets):
                    continue
                segment = ast.get_source_segment(source, node)
                if not segment:
                    fail("security detector source cannot be isolated")
                source = source.replace(segment, "", 1)
            data = source.encode("utf-8")
        if PRIVATE_PATH.search(data):
            fail(f"possible machine-specific path in {rel}")
        if SECRET.search(data):
            fail(f"possible credential in {rel}")


def verify_python_syntax(paths: list[Path]) -> None:
    for path in paths:
        if path.suffix != ".py":
            continue
        rel = path.relative_to(ROOT).as_posix()
        data = source_bytes(path)
        compile(data, rel, "exec")
        ast.parse(data, filename=rel)


def verify_h3_relative_imports(paths: list[Path]) -> None:
    py = [p for p in paths if p.suffix == ".py" and p.relative_to(ROOT).parts[0] == "h3_api"]
    modules: set[str] = set()
    for path in py:
        parts = list(path.relative_to(ROOT / "h3_api").with_suffix("").parts)
        if parts[-1] == "__init__":
            parts.pop()
        modules.update(".".join(parts[:i]) for i in range(1, len(parts) + 1))
    for path in py:
        rel_parts = list(path.relative_to(ROOT / "h3_api").with_suffix("").parts)
        package = rel_parts[:-1] if rel_parts[-1] != "__init__" else rel_parts[:-1]
        tree = ast.parse(source_bytes(path), filename=path.as_posix())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split(".")[0] in {"local_h3", "workbench", "gpu_slot"} and alias.name not in modules:
                        fail(f"missing local import {alias.name}: {path.relative_to(ROOT).as_posix()}:{node.lineno}")
                continue
            if not isinstance(node, ast.ImportFrom):
                continue
            if node.level == 0:
                base_name = node.module or ""
                if base_name.split(".")[0] in {"local_h3", "workbench", "gpu_slot"} and base_name not in modules:
                    fail(f"missing local import {base_name}: {path.relative_to(ROOT).as_posix()}:{node.lineno}")
                continue
            if node.level > len(package):
                fail(f"relative import escapes package: {path.relative_to(ROOT).as_posix()}:{node.lineno}")
            base = package[: len(package) - node.level + 1]
            if node.module:
                base.extend(node.module.split("."))
            base_name = ".".join(base)
            if base_name not in modules:
                fail(f"missing relative import {base_name}: {path.relative_to(ROOT).as_posix()}:{node.lineno}")
            for alias in node.names:
                child = f"{base_name}.{alias.name}"
                if child in modules:
                    continue
                # Ordinary symbol imports are resolved by Python at runtime.
    print(f"relative-import closure: {len(py)} H3 Python files verified")


def verify_api_distribution_declarations(paths: list[Path]) -> None:
    lock = json.loads((ROOT / "dependencies.lock.json").read_text(encoding="utf-8"))
    external = {
        "fastapi": "fastapi",
        "pydantic": "pydantic",
        "psutil": "psutil",
        "yaml": "pyyaml",
        "websocket": "websocket-client",
        "uvicorn": "uvicorn",
    }
    internal = {"local_h3", "workbench", "gpu_slot", "graphs", "runner", "workbench_node", "recipe_identity", "runtime_attestation", "source_manifest"}
    for path in paths:
        rel = path.relative_to(ROOT).as_posix()
        if not rel.startswith("h3_api/") or not rel.endswith(".py") or "/tests/" in rel:
            continue
        for node in ast.walk(ast.parse(source_bytes(path), filename=rel)):
            imports = []
            if isinstance(node, ast.Import):
                imports = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                imports = [node.module]
            for target in imports:
                top = target.split(".")[0]
                if top in sys.stdlib_module_names or top in internal:
                    continue
                distribution = external.get(top)
                if distribution is None or distribution not in lock["api"]:
                    fail(f"undeclared API external import {top}: {rel}:{node.lineno}")
    for required in ("python-multipart", "fastapi", "pydantic", "uvicorn", "pyyaml", "psutil", "websocket-client"):
        if required not in lock["api"]:
            fail(f"API runtime distribution pin missing: {required}")


def synthetic_import_smoke(paths: list[Path]) -> None:
    """Import the fixed H3 modules from a private copy, never from live install."""
    h3 = ROOT / "h3_api"
    if not h3.is_dir():
        fail("h3_api source missing")
    # Keep test artifacts under this task's work/ directory. Never recursively
    # delete a pathname after handles close: a concurrent junction swap could
    # otherwise redirect cleanup. This check copies only manifest-listed files.
    work_root = ROOT.parents[3] / "canonical-verification"
    work_root.mkdir(exist_ok=True)
    if work_root.is_symlink() or (hasattr(work_root, "is_junction") and work_root.is_junction()):
        fail("verification work root is a reparse point")
    stage = Path(tempfile.mkdtemp(prefix="h3-import-", dir=work_root))
    dst = stage / "h3_api"
    for source in paths:
        if source.relative_to(ROOT).parts[0] != "h3_api":
            continue
        target = stage / source.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as writer:
            writer.write(source.read_bytes())
    local_dirs = {
        "H3_COMFY_ROOT": stage / "comfy",
        "H3_ADAPTER_INPUT_ROOT": stage / "input" / "LocalAPI",
        "H3_ADAPTER_OUTPUT_ROOT": stage / "output" / "MiniMax_H3" / "LocalAPI",
        "H3_JOBS_DIR": stage / "jobs",
        "H3_WORKFLOW_DIR": stage / "workflows",
    }
    for directory in local_dirs.values():
        directory.mkdir(parents=True, exist_ok=False)
    code = "\n".join(
        (
            "import importlib, pathlib, socket, sys",
            "def no_network(*args, **kwargs): raise RuntimeError('network is forbidden in import smoke')",
            "socket.socket.connect = no_network",
            "source = pathlib.Path(" + repr(str(dst)) + ").resolve(strict=True)",
            "sys.path[:0] = [str(source / 'workbench'), str(source)]",
            "import graphs, runner, workbench_node, gpu_slot",
            "modules = [graphs, runner, workbench_node, gpu_slot]",
            "for name in ('local_h3.app', 'local_h3.comfy', 'local_h3.jobs', 'local_h3.workflows', 'local_h3.events', 'local_h3.schemas', 'local_h3.stage_progress'):",
            "    modules.append(importlib.import_module(name))",
            "assert all(pathlib.Path(module.__file__).resolve(strict=True).is_relative_to(source) for module in modules)",
            "assert len(importlib.import_module('local_h3.app').app.routes) > 0",
            "assert workbench_node.profile(5, 'qs_new4')['workflow'] == 'qs_new4'",
            "for workflow, seconds in (('qs_new8', 5), ('qs_new4', 3)):",
            "    try: workbench_node.profile(seconds, workflow)",
            "    except ValueError: pass",
            "    else: raise AssertionError('unsupported workflow/duration was admitted')",
            "print('isolated full imports passed')",
        )
    )
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONNOUSERSITE"] = "1"
    env["CUDA_VISIBLE_DEVICES"] = ""
    env.pop("PYTHONPATH", None)
    env["H3_COMFY_BASE"] = "http://127.0.0.1:18189"
    env["H3_COMFY_MODEL_ROOT"] = str(local_dirs["H3_COMFY_ROOT"])
    env["H3_MACHINE_LABEL"] = "canonical-import-smoke"
    env["GPU_SLOT_FILE"] = str(stage / "slot.json")
    env.update({name: str(directory) for name, directory in local_dirs.items()})
    result = subprocess.run(
        [sys.executable, "-B", "-c", code],
        cwd=stage,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr[-700:].replace(str(stage), "<isolated-stage>")
        fail(f"isolated full import failed (exit {result.returncode}): {detail}")
    if result.stdout.strip() != "isolated full imports passed":
        fail("unexpected isolated import output")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-import", action="store_true", help="run integrity and static checks only")
    parser.add_argument("--comfy-assembled", type=Path, help="verify a new isolated Comfy source assembly; never use a live installation")
    args = parser.parse_args()
    obj, paths = verify_manifest()
    verify_text_safety(paths + [MANIFEST])
    verify_python_syntax(paths)
    verify_h3_relative_imports(paths)
    verify_api_distribution_declarations(paths)
    if args.comfy_assembled is not None:
        verify_runtime_sources(obj, args.comfy_assembled)
    if not args.skip_import:
        synthetic_import_smoke(paths)
    print(f"canonical source kit verified: {len(paths)} files, scope={obj['scope']}")


if __name__ == "__main__":
    main()
