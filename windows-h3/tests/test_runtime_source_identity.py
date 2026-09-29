"""Isolated negative controls for the runtime source identity verifier.

The test creates unique directories under this task's work/ area and leaves
them there. It never imports Comfy, starts a service, or touches a live install.
Run with ``python -B`` so the source kit receives no bytecode output.
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_VERIFIER = ROOT / "h3_api" / "workbench" / "source_manifest.py"
WORK_ROOT = ROOT.parents[3] / "canonical-verification"
EXCLUDES = (
    ".git",
    "custom_nodes/ComfyUI-KJNodes/.git",
    "custom_nodes/ComfyUI_LayerStyle/.git",
    "custom_nodes/ComfyUI-VideoHelperSuite/.git",
    "models", "input", "output", "temp", "user",
)


def load_verifier():
    spec = importlib.util.spec_from_file_location("canonical_source_manifest_test", SOURCE_VERIFIER)
    if spec is None or spec.loader is None:
        raise AssertionError("runtime verifier source is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def identity(area: str, path: str, data: bytes) -> dict:
    return {
        "area": area,
        "path": path,
        "origin": "isolated-synthetic-source",
        "size": len(data),
        "rawSha256": hashlib.sha256(data).hexdigest(),
    }


def make_case(name: str, module):
    WORK_ROOT.mkdir(exist_ok=True)
    if WORK_ROOT.is_symlink() or getattr(WORK_ROOT, "is_junction", lambda: False)():
        raise AssertionError("test work root is redirected")
    stage = Path(tempfile.mkdtemp(prefix=f"source-{name}-", dir=WORK_ROOT))
    api = stage / "api"
    comfy = stage / "comfy"
    formats = comfy / "custom_nodes" / "ComfyUI-VideoHelperSuite" / "video_formats"
    api.mkdir()
    formats.mkdir(parents=True)
    api_bytes = b"VALUE = 1\n"
    comfy_bytes = b"NODE = object\n"
    json_bytes = b'{"extension":"mp4"}\n'
    api_file = api / "fixed.py"
    comfy_file = comfy / "main.py"
    format_file = formats / "h264-mp4.json"
    api_file.write_bytes(api_bytes)
    comfy_file.write_bytes(comfy_bytes)
    format_file.write_bytes(json_bytes)
    document = {
        "schemaVersion": 1,
        "runtimeSourceFiles": [
            identity("comfy", "main.py", comfy_bytes),
            identity("h3_api", "fixed.py", api_bytes),
        ],
        "runtimeAuxiliaryFiles": [identity(
            "comfy", "custom_nodes/ComfyUI-VideoHelperSuite/video_formats/h264-mp4.json", json_bytes
        )],
        "runtimeInventoryRoots": [
            {"area": "h3_api", "relativeDir": ".", "extension": ".py", "recursive": True},
            {"area": "comfy", "relativeDir": ".", "extension": ".py", "recursive": True},
        ],
        "runtimeInventoryExcludeDirs": [
            {"area": "comfy", "relativeDir": value} for value in EXCLUDES
        ],
        "runtimeAuxiliaryInventoryDirs": [{
            "area": "comfy",
            "relativeDir": "custom_nodes/ComfyUI-VideoHelperSuite/video_formats",
            "extension": ".json",
            "recursive": False,
        }],
        "requiredGraphClassTypes": ["SyntheticNode"],
    }
    manifest = stage / "manifest.json"
    manifest.write_bytes((json.dumps(document, sort_keys=True) + "\n").encode("utf-8"))
    verified = module.RuntimeSourceManifest(api, comfy, manifest)
    assert verified.check() == hashlib.sha256(manifest.read_bytes()).hexdigest()
    return stage, verified, api_file, comfy_file, format_file


def expect_reject(name: str, verifier, module) -> None:
    try:
        verifier.check()
    except module.SourceManifestError:
        print("PASS " + name)
    else:
        raise AssertionError("runtime verifier admitted " + name)


def mutate_or_block(name: str, operation, verifier, module) -> None:
    try:
        operation()
    except PermissionError:
        # On Windows the verifier holds source handles with FILE_SHARE_READ;
        # normal writes and rename/delete should be rejected by the kernel.
        print("PASS " + name + " blocked by held source handle")
    else:
        expect_reject(name, verifier, module)


def main() -> None:
    module = load_verifier()

    stage, verified, api_file, comfy_file, format_file = make_case("source-add", module)
    (stage / "comfy" / "custom_nodes" / "unexpected.py").write_bytes(b"UNEXPECTED = 1\n")
    expect_reject("added source", verified, module)

    _, verified, api_file, _, _ = make_case("source-delete", module)
    mutate_or_block("deleted source", api_file.unlink, verified, module)

    _, verified, api_file, _, _ = make_case("source-retouch", module)
    previous = api_file.stat()
    mutate_or_block(
        "same bytes with new generation",
        lambda: os.utime(api_file, ns=(previous.st_atime_ns, previous.st_mtime_ns + 2_000_000_000)),
        verified, module,
    )

    stage, verified, _, comfy_file, _ = make_case("source-hardlink", module)
    mutate_or_block(
        "hard-linked source with unchanged bytes",
        lambda: os.link(comfy_file, stage / "outside-hardlink.txt"), verified, module,
    )

    stage, verified, api_file, _, _ = make_case("source-symlink", module)
    outside = stage / "outside-symlink-target.txt"
    outside.write_bytes(api_file.read_bytes())
    try:
        api_file.unlink()
    except OSError as error:
        if isinstance(error, PermissionError):
            print("PASS source replacement blocked by held source handle")
            print("UNTESTED dynamic leaf symlink creation: source could not be removed")
        else:
            raise
    else:
        try:
            os.symlink(outside, api_file)
        except OSError as error:
            if getattr(error, "winerror", None) == 1314:
                print("UNTESTED dynamic leaf symlink creation: Windows privilege 1314")
            else:
                raise
        else:
            expect_reject("linked source with unchanged bytes", verified, module)

    # A parent directory can be switched to a junction without changing any
    # external bytes. This is a distinct oracle from replacing a leaf source.
    stage, verified, _, _, format_file = make_case("parent-junction", module)
    format_dir = format_file.parent
    outside = stage / "outside-formats"
    outside.mkdir()
    outside_copy = outside / format_file.name
    outside_copy.write_bytes(format_file.read_bytes())
    outside_sha = hashlib.sha256(outside_copy.read_bytes()).hexdigest()
    archived_dir = stage / "archived-formats"
    physical_work = WORK_ROOT.resolve(strict=True)
    if not all(path.resolve(strict=False).is_relative_to(physical_work)
               for path in (stage, format_dir, outside, archived_dir)):
        raise AssertionError("synthetic junction paths escaped task work root")
    try:
        format_dir.rename(archived_dir)
    except PermissionError:
        print("PASS parent junction swap blocked by held source handle")
    else:
        if os.name != "nt":
            os.symlink(outside, format_dir, target_is_directory=True)
        else:
            created = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(format_dir), str(outside)],
                capture_output=True, text=True, timeout=10, check=False,
            )
            if created.returncode != 0:
                raise AssertionError("synthetic parent junction could not be created")
        expect_reject("parent junction to same baseline bytes", verified, module)
        if hashlib.sha256(outside_copy.read_bytes()).hexdigest() != outside_sha:
            raise AssertionError("external synthetic source changed during junction check")
        print("PASS parent junction external bytes unchanged")

    stage, verified, _, _, format_file = make_case("format-add", module)
    (format_file.parent / "unexpected.json").write_bytes(b"{}\n")
    expect_reject("added video format", verified, module)

    _, verified, _, _, format_file = make_case("format-delete", module)
    format_file.unlink()
    expect_reject("deleted video format", verified, module)

    print("runtime source identity synthetic controls completed")


if __name__ == "__main__":
    main()
