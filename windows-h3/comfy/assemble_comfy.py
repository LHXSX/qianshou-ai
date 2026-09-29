"""Assemble the pinned qs_new4/E_light4_sage Comfy source in a NEW directory.

This fetches only vendor Git source. It never reads model/config/media locations,
starts Comfy, imports the source, or runs a GPU job. Failed builds are left for
inspection; the script does not delete or overwrite an existing output directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib
from urllib.parse import urlsplit


HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE / "vendor-lock.json").read_text(encoding="utf-8"))
VENDOR_ORDER = ("comfyui", "kjnodes", "layerstyle", "videohelpersuite")
EXTRA_FILES = (
    "additions/comfy/minimax_lora_guard.py",
    "custom_nodes/h3_benchmark_sampler/__init__.py",
    "custom_nodes/h3_benchmark_sampler/core.py",
    "custom_nodes/h3_benchmark_sampler/sampling.py",
    "custom_nodes/h3_benchmark_sampler/LICENSE",
    "custom_nodes/h3_benchmark_sampler/COPYING",
    "custom_nodes/qs_h3_source_attestor/__init__.py",
    "custom_nodes/qs_h3_source_attestor/attestor.py",
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def lf_sha256(data: bytes) -> str:
    return sha256(data.replace(b"\r\n", b"\n"))


def run_git(*args: str, cwd: Path | None = None) -> str:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_LFS_SKIP_SMUDGE"] = "1"
    result = subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace", check=False,
    )
    if result.returncode:
        # Git output can include URL credentials or private paths. Keep it local.
        raise RuntimeError(f"Git operation failed (exit {result.returncode}): {args[0]}")
    return result.stdout.rstrip("\r\n")


def origin_key(url: str) -> tuple[str, str]:
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != "github.com" or parts.username or parts.password:
        raise ValueError("Vendor origin is not the pinned public GitHub HTTPS origin")
    return parts.hostname, parts.path.removesuffix(".git").rstrip("/").lower()


def source_for(vendor: str, explicit: str | None) -> str:
    expected = LOCK["vendors"][vendor]["origin"]
    if explicit is None:
        return expected
    path = Path(explicit).expanduser().resolve(strict=True)
    if not path.is_dir():
        raise ValueError(f"{vendor}: local source is not a directory")
    actual_origin = run_git("-C", str(path), "remote", "get-url", "origin")
    if origin_key(actual_origin) != origin_key(expected):
        raise ValueError(f"{vendor}: local source origin does not match the pinned vendor")
    run_git("-C", str(path), "cat-file", "-e", LOCK["vendors"][vendor]["commit"] + "^{commit}")
    return str(path)


def verify_vendor(root: Path, vendor: str) -> None:
    record = LOCK["vendors"][vendor]
    if run_git("-C", str(root), "rev-parse", "HEAD") != record["commit"]:
        raise ValueError(f"{vendor}: commit mismatch")
    if run_git("-C", str(root), "rev-parse", "HEAD^{tree}") != record["tree"]:
        raise ValueError(f"{vendor}: source tree mismatch")
    if lf_sha256((root / "LICENSE").read_bytes()) != record["licenseSha256"]:
        raise ValueError(f"{vendor}: license mismatch")
    metadata = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    if metadata["project"]["version"] != record["version"]:
        raise ValueError(f"{vendor}: version mismatch")


def apply_vendor_patch(root: Path, vendor: str) -> None:
    record = LOCK["vendors"][vendor]
    if "patch" not in record:
        return
    patch = HERE / record["patch"]
    if sha256(patch.read_bytes()) != record["patchSha256"]:
        raise ValueError(f"{vendor}: patch bytes changed")
    run_git("-C", str(root), "apply", "--check", "--", str(patch))
    run_git("-C", str(root), "apply", "--", str(patch))


def verify_source_bytes(output: Path) -> None:
    guard = HERE / "additions/comfy/minimax_lora_guard.py"
    guard_rel = Path("comfy/minimax_lora_guard.py")
    extra_sources = {guard_rel.as_posix(): guard}
    extra_sources.update({
        rel: HERE / rel for rel in EXTRA_FILES if rel.startswith("custom_nodes/")
    })
    for rel, source in extra_sources.items():
        expected = LOCK["targetSha256"][rel]
        if sha256(source.read_bytes()) != expected:
            raise ValueError(f"Package source hash changed: {rel}")
        target = output / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())

    for rel, expected in LOCK["targetSha256"].items():
        target = output / rel
        data = target.read_bytes()
        if sha256(data) != expected or lf_sha256(data) != expected:
            raise ValueError(f"Assembled source hash mismatch: {rel}")
        if target.suffix == ".py":
            # Syntax only: no import, exec, pyc, service start, or GPU access.
            compile(data, rel, "exec")


def verify_node_closure(output: Path) -> None:
    required = {
        "comfy_extras/nodes_minimax_h3.py": "MiniMaxH3ImageToVideo",
        "comfy_extras/nodes_lora_debug.py": "LoraLoaderBypassModelOnly",
        "custom_nodes/h3_benchmark_sampler/__init__.py": "QSH3BenchmarkDualClock",
        "custom_nodes/qs_h3_source_attestor/__init__.py": "/qs-h3/v1/source-attestation",
        "server.py": "qs_h3_prompt_guard_required_v1",
        "custom_nodes/ComfyUI-KJNodes/__init__.py": "model_optimization_nodes",
        "custom_nodes/ComfyUI-KJNodes/nodes/model_optimization_nodes.py": "PathchSageAttentionKJ",
        "custom_nodes/ComfyUI_LayerStyle/__init__.py": "import_module",
        "custom_nodes/ComfyUI_LayerStyle/py/purge_vram.py": "LayerUtility: PurgeVRAM V2",
        "custom_nodes/ComfyUI-VideoHelperSuite/__init__.py": "videohelpersuite.nodes",
        "custom_nodes/ComfyUI-VideoHelperSuite/videohelpersuite/nodes.py": "VHS_VideoCombine",
    }
    for rel, symbol in required.items():
        data = (output / rel).read_text(encoding="utf-8")
        if symbol not in data:
            raise ValueError(f"Required node registration missing: {rel}")


def verify_only_expected_changes(output: Path) -> None:
    expected_status = {
        "comfyui": {
            " M comfy/ops.py", " M comfy/sd.py", " M comfy/weight_adapter/bypass.py",
            " M comfy_extras/nodes_minimax_h3.py", " M server.py", "?? comfy/minimax_lora_guard.py",
        },
        "kjnodes": {" M nodes/model_optimization_nodes.py"},
        "layerstyle": set(),
        "videohelpersuite": set(),
    }
    for vendor in VENDOR_ORDER:
        root = output / LOCK["vendors"][vendor]["destination"]
        actual = set(run_git("-C", str(root), "status", "--porcelain=v1", "--untracked-files=all").splitlines())
        if actual != expected_status[vendor]:
            raise ValueError(f"{vendor}: unexpected source modification or untracked file")
        tracked_python = {
            rel for rel in run_git("-C", str(root), "ls-files", "-z", "--", "*.py").split("\0") if rel
        }
        actual_python = {
            path.relative_to(root).as_posix() for path in root.rglob("*.py")
            if ".git" not in path.relative_to(root).parts
            and (vendor != "comfyui" or path.relative_to(root).parts[0] != "custom_nodes")
        }
        if vendor == "comfyui":
            tracked_python = {rel for rel in tracked_python if not rel.startswith("custom_nodes/")}
            tracked_python.add("comfy/minimax_lora_guard.py")
        if actual_python != tracked_python:
            raise ValueError(f"{vendor}: Python import tree differs from pinned source")

    custom_nodes = output / "custom_nodes"
    baseline = set(run_git("-C", str(output), "ls-tree", "--name-only", "HEAD:custom_nodes").splitlines())
    expected = baseline | {
        "ComfyUI-KJNodes", "ComfyUI_LayerStyle", "ComfyUI-VideoHelperSuite", "h3_benchmark_sampler",
        "qs_h3_source_attestor",
    }
    if {entry.name for entry in custom_nodes.iterdir()} != expected:
        raise ValueError("Unexpected custom node directory or file")
    sampler = custom_nodes / "h3_benchmark_sampler"
    if {entry.name for entry in sampler.iterdir()} != {
        "__init__.py", "core.py", "sampling.py", "LICENSE", "COPYING",
    }:
        raise ValueError("Unexpected H3 sampler file")
    if {entry.name for entry in (custom_nodes / "qs_h3_source_attestor").iterdir()} != {
        "__init__.py", "attestor.py",
    }:
        raise ValueError("Unexpected H3 attestor file")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New, explicit Comfy source directory")
    for vendor in VENDOR_ORDER:
        parser.add_argument(f"--{vendor}-source", help=f"Existing local {vendor} Git clone (otherwise pinned public origin)")
    args = parser.parse_args()
    output = args.output.expanduser().resolve(strict=False)
    if output.exists() or output.is_symlink():
        parser.error("Output must not exist; existing source and user data are never overwritten")
    if HERE == output or HERE in output.parents:
        parser.error("Output must be outside the canonical package directory")

    sources = {name: source_for(name, getattr(args, f"{name}_source")) for name in VENDOR_ORDER}
    for source in sources.values():
        if Path(source).is_dir() and Path(source) in output.parents:
            parser.error("Output must not be inside a vendor source checkout")
    output.parent.mkdir(parents=True, exist_ok=True)
    for vendor in VENDOR_ORDER:
        record = LOCK["vendors"][vendor]
        destination = output / record["destination"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        run_git("-c", "core.autocrlf=false", "clone", "--no-checkout", "--no-hardlinks", "--", sources[vendor], str(destination))
        run_git("-C", str(destination), "config", "--local", "core.autocrlf", "false")
        run_git("-C", str(destination), "-c", "core.autocrlf=false", "checkout", "--detach", record["commit"])
        run_git("-C", str(destination), "remote", "set-url", "origin", record["origin"])
        if run_git("-C", str(destination), "status", "--porcelain=v1", "--untracked-files=all"):
            raise ValueError(f"{vendor}: newly checked out vendor tree is not clean")
        verify_vendor(destination, vendor)
        apply_vendor_patch(destination, vendor)

    verify_source_bytes(output)
    verify_node_closure(output)
    verify_only_expected_changes(output)
    print("Pinned qs_new4 Comfy source assembled and statically verified; no runtime/GPU validation performed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, SyntaxError) as exc:
        # Avoid echoing command output or source contents, which may contain private data.
        print(f"Assembly rejected: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
