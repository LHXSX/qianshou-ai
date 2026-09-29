"""Copy the pinned canonical H3 API sources into one new installation root.

This copies source only. Runtime paths, credentials, models, and user data are
configured separately by the device owner; this command never starts a worker.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re


SOURCE_ROOT = Path(__file__).resolve().parent
MANIFEST = SOURCE_ROOT.parent / "manifest.json"
FILES = frozenset({
    "h3_api/gpu_slot.py",
    "h3_api/workbench/graphs.py",
    "h3_api/workbench/recipe_identity.py",
    "h3_api/workbench/runner.py",
    "h3_api/workbench/runtime_attestation.py",
    "h3_api/workbench/source_manifest.py",
    "h3_api/workbench/workbench_node.py",
    "h3_api/local_h3/__init__.py",
    "h3_api/local_h3/__main__.py",
    "h3_api/local_h3/app.py",
    "h3_api/local_h3/comfy.py",
    "h3_api/local_h3/events.py",
    "h3_api/local_h3/jobs.py",
    "h3_api/local_h3/schemas.py",
    "h3_api/local_h3/stage_progress.py",
    "h3_api/local_h3/workflows.py",
})
SHA = re.compile(r"[0-9a-f]{64}\Z")


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _manifest_sources() -> tuple[dict[str, tuple[bytes, str]], bytes]:
    if MANIFEST.is_symlink() or not MANIFEST.is_file():
        raise RuntimeError("Bundled canonical manifest is missing or redirected")
    manifest_bytes = MANIFEST.read_bytes()
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("files"), list):
        raise RuntimeError("Unsupported canonical manifest")
    listed = {}
    for entry in manifest["files"]:
        if not isinstance(entry, dict):
            raise RuntimeError("Invalid canonical manifest entry")
        name = entry.get("path")
        if name not in FILES:
            continue
        if name in listed:
            raise RuntimeError("Duplicate canonical source in manifest")
        raw_sha = entry.get("archiveRawSha256")
        lf_sha = entry.get("archiveLfSha256")
        if not isinstance(raw_sha, str) or not SHA.fullmatch(raw_sha) or not isinstance(lf_sha, str) or not SHA.fullmatch(lf_sha):
            raise RuntimeError("Canonical source digest is missing")
        source = SOURCE_ROOT.parent / Path(name)
        if source.is_symlink() or not source.is_file() or source.resolve().is_relative_to(SOURCE_ROOT.parent) is False:
            raise RuntimeError("Canonical source is missing or redirected")
        data = source.read_bytes()
        if _digest(data) != raw_sha or _digest(data.replace(b"\r\n", b"\n")) != lf_sha:
            raise RuntimeError("Canonical source bytes differ from the manifest")
        listed[name] = (data, raw_sha)
    if set(listed) != FILES:
        raise RuntimeError("Canonical API source set is incomplete")
    return listed, manifest_bytes


def assemble(target: Path) -> None:
    if not target.is_absolute():
        raise RuntimeError("Target must be an explicit absolute new directory")
    if target.exists() or target.is_symlink():
        raise RuntimeError("Target already exists; existing or dirty installations are refused")
    parent = target.parent
    if not parent.is_dir():
        raise RuntimeError("Target parent must already exist")
    if any(p.is_symlink() or getattr(p, "is_junction", lambda: False)()
           for p in (parent, *parent.parents)):
        raise RuntimeError("Redirected target parents are refused")
    resolved_target = target.resolve(strict=False)
    if resolved_target.is_relative_to(SOURCE_ROOT.parent):
        raise RuntimeError("Target must be outside the canonical source checkout")

    sources, manifest_bytes = _manifest_sources()  # verify every archive byte before creating target
    target.mkdir()  # atomic refusal if another process created it
    try:
        for name in sorted(FILES):
            data, expected = sources[name]
            relative = Path(name).relative_to("h3_api")
            dest = target / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open("xb") as handle:
                handle.write(data)
            if _digest(dest.read_bytes()) != expected:
                raise RuntimeError("Installed canonical source failed its byte digest")
        with (target / "canonical-manifest.json").open("xb") as handle:
            handle.write(manifest_bytes)
        if _digest((target / "canonical-manifest.json").read_bytes()) != _digest(manifest_bytes):
            raise RuntimeError("Installed canonical manifest changed during assembly")
        for name, (_, expected) in sources.items():
            relative = Path(name).relative_to("h3_api")
            if _digest((target / relative).read_bytes()) != expected:
                raise RuntimeError("Installed canonical source changed during final verification")
    except Exception as error:
        raise RuntimeError("Assembly failed; inspect the new partial target before retrying") from error


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", type=Path, required=True, help="new absolute H3 API source root")
    args = parser.parse_args()
    assemble(args.target)
    print(f"Assembled and SHA256-verified {len(FILES)} canonical H3 API source files")


if __name__ == "__main__":
    main()
