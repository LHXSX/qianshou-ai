"""Offline configuration gates against an isolated synthetic Windows candidate.

This test never imports torch, starts Comfy, claims a GPU slot, or deletes a
path. Every synthetic file is under a fresh task work/ directory.
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import importlib.util
import hashlib
import json
import os
import subprocess
import tempfile
import types
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
WORK_ROOT = ROOT.parents[3] / "canonical-verification"


def load_preflight():
    source = ROOT / "tests" / "preflight_runtime.py"
    spec = importlib.util.spec_from_file_location("canonical_preflight_contract", source)
    if spec is None or spec.loader is None:
        raise AssertionError("preflight source cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def reject(operation, label: str) -> None:
    try:
        operation()
    except RuntimeError:
        print("PASS " + label + " rejected")
    else:
        raise AssertionError("preflight admitted " + label)


def main() -> None:
    preflight = load_preflight()
    WORK_ROOT.mkdir(exist_ok=True)
    if WORK_ROOT.is_symlink() or getattr(WORK_ROOT, "is_junction", lambda: False)():
        raise AssertionError("task test work root is redirected")
    stage = Path(tempfile.mkdtemp(prefix="preflight-contract-", dir=WORK_ROOT))
    directories = {
        "H3_COMFY_ROOT": stage / "workspace",
        "H3_COMFY_MODEL_ROOT": stage / "comfy-source",
        "H3_ADAPTER_INPUT_ROOT": stage / "input" / "LocalAPI",
        "H3_ADAPTER_OUTPUT_ROOT": stage / "output" / "MiniMax_H3" / "LocalAPI",
        "H3_JOBS_DIR": stage / "jobs",
        "H3_WORKFLOW_DIR": stage / "workflows",
    }
    for path in directories.values():
        path.mkdir(parents=True)
    slot = stage / "private-slot" / "slot.json"
    slot.parent.mkdir()
    slot.write_text(json.dumps({"occupant": "h3"}), encoding="utf-8")
    lock = slot.with_name(slot.name + ".lock")
    lock.write_bytes(b"\0")
    manifest = stage / "canonical-manifest.json"
    manifest.write_bytes((ROOT / "manifest.json").read_bytes())
    values = {name: str(path) for name, path in directories.items()}
    values.update({
        "GPU_SLOT_FILE": str(slot),
        "H3_CANONICAL_MANIFEST_PATH": str(manifest),
        "H3_MACHINE_LABEL": "synthetic-device",
        "H3_COMFY_BASE": "http://127.0.0.1:18189",
    })
    with patch.dict(os.environ, values):
        preflight.require_explicit_config()
        preflight.require_installed_manifest()
        preflight.require_candidate_source_root(directories["H3_COMFY_MODEL_ROOT"])
        assert directories["H3_COMFY_ROOT"] != directories["H3_COMFY_MODEL_ROOT"]
        print("PASS H3 slot and separate workspace/source roots")

        with patch.dict(os.environ, {"H3_COMFY_BASE": "http://localhost:18189"}):
            reject(preflight.require_explicit_config, "localhost alias")
        with patch.dict(os.environ, {"H3_COMFY_BASE": "http://127.0.0.1:65536"}):
            reject(preflight.require_explicit_config, "invalid loopback port")
        reject(lambda: preflight.require_candidate_source_root(directories["H3_COMFY_ROOT"]),
               "workspace used as Comfy source root")

        lock.unlink()
        reject(preflight.require_explicit_config, "uninitialized slot lock")
        lock.write_bytes(b"\0")
        slot.write_text(json.dumps({"occupant": "video"}), encoding="utf-8")
        reject(preflight.require_explicit_config, "unknown slot occupant")

    # Probe a separate Python process: import-path environment variables are
    # evaluated by the interpreter before any preflight module code executes.
    for name, value in (("PYTHONPATH", str(stage)), ("PYTHONHOME", sys.base_prefix)):
        child_env = os.environ.copy()
        for key in ("PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP"):
            child_env.pop(key, None)
        child_env["PYTHONNOUSERSITE"] = "1"
        child_env[name] = value
        child = subprocess.run(
            [sys.executable, "-B", str(ROOT / "tests" / "preflight_runtime.py"), "--mode", "api"],
            env=child_env, cwd=stage, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=20, check=False,
        )
        if child.returncode == 0 or name not in child.stderr:
            raise AssertionError(name + " injection was not explicitly rejected")
        print("PASS " + name + " process injection rejected")

    with patch.dict(os.environ, {"PYTHONNOUSERSITE": "1"}):
        preflight.require_python_source_paths()
        with patch.object(sys, "path", [str(ROOT / "tests"), str(stage)]):
            reject(preflight.require_python_source_paths, "external sys.path root")
        with patch.object(sys, "path", [str(ROOT / "tests"), str(Path(sys.prefix) / "unlocked-code")]):
            reject(preflight.require_python_source_paths, "unlocked path below interpreter prefix")
        # CPython's Windows venv adds its exact root to sys.path.  This does
        # not admit another directory beneath that root or any external tree.
        venv = stage / "candidate-venv"
        venv.mkdir()
        for name in ("Include", "Lib", "Scripts"):
            (venv / name).mkdir()
        (venv / "pyvenv.cfg").write_text("home = synthetic\n", encoding="utf-8")
        with patch.object(sys, "prefix", str(venv)):
            with patch.object(sys, "path", [str(ROOT / "tests"), str(venv)]):
                preflight.require_python_source_paths()
            print("PASS exact venv prefix sys.path admitted")
            with patch.object(sys, "path", [str(ROOT / "tests"), str(venv / "unlocked-code")]):
                reject(preflight.require_python_source_paths,
                       "unlocked path below synthetic venv prefix")
            (venv / "shadow.py").write_text("# synthetic\n", encoding="utf-8")
            with patch.object(sys, "path", [str(ROOT / "tests"), str(venv)]):
                reject(preflight.require_python_source_paths, "venv root module pollution")
            (venv / "shadow.py").unlink()
            (venv / "other-package").mkdir()
            with patch.object(sys, "path", [str(ROOT / "tests"), str(venv)]):
                reject(preflight.require_python_source_paths, "venv root package pollution")
        base = stage / "candidate-base"
        base.mkdir()
        for name in preflight.BASE_ROOT_ENTRIES:
            child = base / name
            if "." in name:
                child.write_bytes(b"synthetic")
            else:
                child.mkdir()
        with patch.object(sys, "prefix", str(base)), patch.object(sys, "base_prefix", str(base)):
            with patch.object(sys, "path", [str(ROOT / "tests"), str(base)]):
                preflight.require_python_source_paths()
                (base / "shadow.py").write_text("# synthetic\n", encoding="utf-8")
                reject(preflight.require_python_source_paths, "base Python root module pollution")

    engine_dir = stage / "Git" / "mingw64" / "bin"
    engine_dir.mkdir(parents=True)
    engine = engine_dir / "git.exe"
    engine.write_bytes(b"synthetic pinned Git engine")
    for name in ("git-upload-pack.exe", "git-receive-pack.exe", "git-upload-archive.exe"):
        os.link(engine, engine_dir / name)
    git_lock_data = {"externalExecutables": {"git": {
        "observedVersion": "2.54.0.windows.1",
        "observedSha256": hashlib.sha256(engine.read_bytes()).hexdigest(),
    }}}
    with patch.dict(os.environ, {"H3_CANONICAL_GIT_EXE": ""}):
        reject(lambda: preflight.require_fixed_git(git_lock_data), "missing pinned Git")
    with patch.dict(os.environ, {"H3_CANONICAL_GIT_EXE": str(engine),
                                  "GIT_DIR": str(stage / "hostile-git-dir")}), \
            patch.object(preflight.subprocess, "run", return_value=types.SimpleNamespace(
                returncode=0, stdout="git version 2.54.0.windows.1\n", stderr="")) as run:
        assert preflight.require_fixed_git(git_lock_data) == engine
        preflight.git_read(engine, git_lock_data["externalExecutables"]["git"]["observedSha256"],
                           stage, ["rev-parse", "HEAD"])
        assert "GIT_DIR" not in run.call_args.kwargs["env"]
        assert run.call_args.kwargs["env"]["GIT_CONFIG_NOSYSTEM"] == "1"
        assert "core.fsmonitor=false" in run.call_args.args[0]
        engine.write_bytes(b"synthetic changed Git engine")
        reject(lambda: preflight.require_fixed_git(git_lock_data), "changed Git engine bytes")
        engine.write_bytes(b"synthetic pinned Git engine")
        (engine_dir / "git-upload-archive.exe").unlink()
        reject(lambda: preflight.require_fixed_git(git_lock_data), "incomplete Git hardlink set")

    site = stage / "site-packages"
    site.mkdir()
    unexpected = site / "foreign.pth"
    unexpected.write_text("import foreign_hook\n", encoding="utf-8")
    reject(lambda: preflight.require_site_hooks(site, {}), "executable .pth hook")
    unexpected.unlink()
    shim = site / "distutils-precedence.pth"
    shim.write_bytes(
        b"import os; var = 'SETUPTOOLS_USE_DISTUTILS'; enabled = os.environ.get(var, 'local') == 'local'; "
        b"enabled and __import__('_distutils_hack').add_shim(); \n")
    preflight.require_site_hooks(site, {"setuptools": "82.0.1"})
    reject(lambda: preflight.require_site_hooks(site, {}), "setuptools shim without locked setuptools")
    shim.unlink()
    (site / "sitecustomize.py").write_text("# synthetic\n", encoding="utf-8")
    reject(lambda: preflight.require_site_hooks(site, {}), "sitecustomize startup code")

    foreign = types.SimpleNamespace(metadata={"Name": "foreign"}, version="1.0")
    with patch.object(preflight.importlib.metadata, "distributions", return_value=[foreign]):
        reject(lambda: preflight.require_distributions({}), "unlocked distribution")
    with patch.object(preflight.importlib.metadata, "distributions", return_value=[foreign, foreign]):
        reject(lambda: preflight.require_distributions({"foreign": "1.0"}),
               "duplicate distribution")

    print("preflight configuration contract controls completed")


if __name__ == "__main__":
    main()
