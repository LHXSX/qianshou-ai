"""Local, path-free identity for the measured qs_new4 five-second H3 recipe.

This module intentionally has no HTTP routes and never submits GPU work.  The
8790 adapter can call :func:`build_identity` and compare the resulting values
with an independently pinned owner binding before accepting a render.  Model
bytes and local paths are never returned by the public result.

The process-local SHA cache is keyed by a strict file identity (volume/inode,
size, high-resolution times and mode).  A caller that needs to rule out a
same-stat in-place rewrite must use ``force_hash=True`` for that check.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import hashlib
import hmac
import importlib
import importlib.util
import json
import os
from pathlib import Path, PureWindowsPath
import re
import sys
from threading import RLock
from typing import Mapping


SCHEMA_VERSION = "qs.h3.recipe-identity.canonical-vnext"
MODEL_DIGEST_SCHEMA_VERSION = "qs.h3.recipe-identity.v1"
RUNTIME_ABI = "qs.h3.canonical.qs_new4.vnext"
WORKFLOW = "qs_new4"
SAVE_FRAMES = (0, 119, 123)
MODEL_ROLES = ("audioVae", "clip", "lora", "unet", "videoVae")
_HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_HASH_LOCK = RLock()
_IMPORT_LOCK = RLock()
_HASH_CACHE: dict[tuple[str, tuple[int, ...]], str] = {}


class RecipeIdentityError(RuntimeError):
    """The local recipe could not be identified or did not match its binding."""


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _check_sha256(value: str, field: str) -> str:
    if not isinstance(value, str) or not _HEX_SHA256.fullmatch(value):
        raise RecipeIdentityError(f"{field} must be a lowercase SHA-256 hex digest")
    return value


def _file_identity(stat: os.stat_result) -> tuple[int, ...]:
    # On Windows, some Python runtimes report different st_ctime_ns values
    # through fstat(handle) and stat(path) for the same NTFS file.  Birth time
    # is stable across both calls; mtime/size/file ID still detect ordinary
    # replacement and edits.  force_hash handles deliberate same-stat rewrites.
    creation_ns = getattr(stat, "st_birthtime_ns", stat.st_ctime_ns)
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns,
            creation_ns, stat.st_mode,
            getattr(stat, "st_file_attributes", 0),
            getattr(stat, "st_reparse_tag", 0))


def _hash_file(path: Path, *, force_hash: bool) -> str:
    """Hash bytes, rejecting a file replaced or changed during the read."""
    try:
        resolved = path.resolve(strict=True)
        with resolved.open("rb") as stream:
            before = _file_identity(os.fstat(stream.fileno()))
            key = (os.path.normcase(str(resolved)), before)
            if not force_hash:
                with _HASH_LOCK:
                    cached = _HASH_CACHE.get(key)
                if cached is not None and _file_identity(resolved.stat()) == before:
                    return cached
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                digest.update(chunk)
            after = _file_identity(os.fstat(stream.fileno()))
        if after != before or _file_identity(resolved.stat()) != before:
            raise RecipeIdentityError("A recipe input changed while being hashed")
        if path.resolve(strict=True) != resolved:
            raise RecipeIdentityError("A recipe input link changed while being hashed")
        result = digest.hexdigest()
        with _HASH_LOCK:
            # A model can be replaced between calls; do not retain old identities.
            for prior in tuple(_HASH_CACHE):
                if prior[0] == key[0] and prior != key:
                    del _HASH_CACHE[prior]
            _HASH_CACHE[key] = result
        return result
    except RecipeIdentityError:
        raise
    except (OSError, ValueError) as error:
        raise RecipeIdentityError("A recipe input could not be read") from error


def _transport_path(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 512 or "\x00" in value:
        raise RecipeIdentityError(f"Invalid {field}")
    normalized = value.replace("\\", "/")
    if (normalized.startswith("/") or PureWindowsPath(value).drive
            or any(part in ("", ".", "..") for part in normalized.split("/"))):
        raise RecipeIdentityError(f"Invalid {field}")
    return normalized


def canonical_graph_sha256(graph: dict) -> str:
    """Hash the actual Comfy API graph, masking only seven transport/request leaves.

    The first-frame *path* is transport metadata; its PNG byte SHA-256 must be
    supplied separately to ``RecipeIdentity.identity_for``.  Likewise the
    buyer prompt and seed are dynamic, while fixed negative text is separately
    bound by its UTF-8 SHA-256.  Static graph fields remain in the digest.
    """
    if not isinstance(graph, dict):
        raise RecipeIdentityError("Comfy graph must be an object")
    try:
        clone = deepcopy(graph)
        prompt = clone["2"]["inputs"]["prompt"]
        seed = clone["13"]["inputs"]["noise_seed"]
        first_frame = clone["100"]["inputs"]["image"]
        output_prefix = clone["27"]["inputs"]["filename_prefix"]
        frame_rate = clone["27"]["inputs"]["frame_rate"]
        if not isinstance(prompt, str) or not prompt.strip() or type(seed) is not int:
            raise RecipeIdentityError("Invalid buyer prompt or seed in Comfy graph")
        if type(frame_rate) not in (int, float) or frame_rate != 24:
            raise RecipeIdentityError("Unexpected qs_new4 frame rate")
        # This Comfy version coerces VHS frame_rate from 24 to 24.0 during
        # validation. Hash the effective graph value seen in prompt history.
        clone["27"]["inputs"]["frame_rate"] = 24.0
        _transport_path(first_frame, "first-frame transport path")
        output_prefix = _transport_path(output_prefix, "output transport prefix")
        for node, frame in (("201", 0), ("203", 119), ("205", 123)):
            actual = clone[node]["inputs"]["filename_prefix"]
            if actual != f"{output_prefix}_frame{frame:04d}":
                raise RecipeIdentityError("Frame output prefix differs from the main output")
        clone["2"]["inputs"]["prompt"] = "<buyer-prompt>"
        clone["13"]["inputs"]["noise_seed"] = "<buyer-seed>"
        clone["100"]["inputs"]["image"] = "<fixed-first-frame-path>"
        clone["27"]["inputs"]["filename_prefix"] = "<output-prefix>"
        for node, frame in (("201", 0), ("203", 119), ("205", 123)):
            clone[node]["inputs"]["filename_prefix"] = f"<output-prefix>_frame{frame:04d}"
        return _sha256(_json_bytes(clone))
    except RecipeIdentityError:
        raise
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        raise RecipeIdentityError("Comfy graph is missing fixed qs_new4 fields") from error


def verify_actual_graph(graph: dict, expected_graph_sha: str) -> str:
    """Return its canonical SHA on an exact match; otherwise fail closed."""
    expected = _check_sha256(expected_graph_sha, "expected_graph_sha")
    actual = canonical_graph_sha256(graph)
    if not hmac.compare_digest(actual, expected):
        raise RecipeIdentityError("Actual Comfy graph differs from the pinned qs_new4 graph")
    return actual


def _reference_graph(api_root: Path) -> dict:
    """Use the same graphs.build path that the live 8790 prompt_graph calls."""
    graph_file = api_root / "workbench" / "graphs.py"
    comfy_file = (api_root / "local_h3" / "comfy.py").resolve(strict=True)
    if not graph_file.is_file():
        raise RecipeIdentityError("The qs_new4 graph builder is missing")
    with _IMPORT_LOCK:
        # graphs.build imports local_h3.comfy.  Refuse a process that already
        # imported a different copy instead of fingerprinting the wrong graph.
        preloaded = sys.modules.get("local_h3.comfy")
        if preloaded is not None and Path(preloaded.__file__).resolve() != comfy_file:
            raise RecipeIdentityError("The loaded H3 graph runtime is not the requested API root")
        root_text = str(api_root)
        sys.path.insert(0, root_text)
        try:
            comfy = importlib.import_module("local_h3.comfy")
            if Path(comfy.__file__).resolve() != comfy_file:
                raise RecipeIdentityError("The loaded H3 graph runtime is not the requested API root")
            module_name = "_qs_h3_recipe_identity_graphs"
            spec = importlib.util.spec_from_file_location(module_name, graph_file)
            if spec is None or spec.loader is None:
                raise RecipeIdentityError("The qs_new4 graph builder cannot be loaded")
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            try:
                spec.loader.exec_module(module)
                graph, _recipe = module.build(
                    api_root, module.SPECS["E_light4_sage"], 0,
                    "identity/output", "identity/first.png",
                    frames=124, prompt="identity buyer prompt",
                    save_frames=list(SAVE_FRAMES))
            finally:
                sys.modules.pop(module_name, None)
            return graph
        except (ImportError, KeyError, OSError, ValueError) as error:
            raise RecipeIdentityError("The qs_new4 graph could not be built") from error
        finally:
            sys.path.remove(root_text)


def _model_names(graph: dict) -> dict[str, tuple[str, str]]:
    required = {
        "unet": ("11", "UNETLoader", "unet_name", "diffusion_models"),
        "clip": ("12", "CLIPLoader", "clip_name", "text_encoders"),
        "videoVae": ("3", "VAELoader", "vae_name", "vae"),
        "audioVae": ("4", "VAELoader", "vae_name", "vae"),
        "lora": ("31", "LoraLoaderBypassModelOnly", "lora_name", "loras"),
    }
    result = {}
    for role, (node_id, node_type, field, category) in required.items():
        try:
            node = graph[node_id]
            name = node["inputs"][field]
            if node["class_type"] != node_type:
                raise RecipeIdentityError(f"Unexpected qs_new4 {role} loader")
            if (not isinstance(name, str) or not name.lower().endswith(".safetensors")
                    or name != Path(name).name or name != PureWindowsPath(name).name):
                raise RecipeIdentityError(f"Invalid qs_new4 {role} model name")
            result[role] = (category, name)
        except (KeyError, TypeError) as error:
            raise RecipeIdentityError(f"Missing qs_new4 {role} model") from error
    return result


def _model_roots(comfy_root: Path) -> dict[str, list[Path]]:
    models = comfy_root / "models"
    roots = {
        "diffusion_models": [models / "unet", models / "diffusion_models"],
        "text_encoders": [models / "text_encoders", models / "clip"],
        "vae": [models / "vae"],
        "loras": [models / "loras"],
    }
    # Comfy main.py automatically loads this exact filename. CLI extra config
    # paths are rejected by runtime_attestation until modeled explicitly.
    configs = (comfy_root / "extra_model_paths.yaml",)
    if any(path.is_file() for path in configs):
        try:
            import yaml
        except ImportError as error:
            raise RecipeIdentityError("PyYAML is required to resolve Comfy model paths") from error
    for config_path in configs:
        if not config_path.is_file():
            continue
        try:
            config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
            if not isinstance(config, dict):
                raise RecipeIdentityError("Invalid Comfy model path config")
            for section in config.values():
                if section is None:
                    continue
                if not isinstance(section, dict):
                    raise RecipeIdentityError("Invalid Comfy model path section")
                base = section.get("base_path")
                if base is not None:
                    if not isinstance(base, str):
                        raise RecipeIdentityError("Invalid Comfy model base path")
                    expanded = Path(os.path.expandvars(os.path.expanduser(base)))
                    base_path = expanded if expanded.is_absolute() else config_path.parent / expanded
                else:
                    base_path = config_path.parent
                for category, value in section.items():
                    category = {"unet": "diffusion_models", "clip": "text_encoders"}.get(category, category)
                    if category not in roots:
                        continue
                    if not isinstance(value, str):
                        raise RecipeIdentityError("Invalid Comfy model category path")
                    for line in value.splitlines():
                        subpath = line.strip()
                        if not subpath:
                            continue
                        expanded = Path(os.path.expandvars(os.path.expanduser(subpath)))
                        roots[category].append(expanded if expanded.is_absolute() else base_path / expanded)
        except RecipeIdentityError:
            raise
        except (OSError, ValueError, yaml.YAMLError) as error:
            raise RecipeIdentityError("Comfy model path config could not be read") from error
    return roots


def _resolve_model(roots: list[Path], name: str, role: str) -> Path:
    matches: dict[str, Path] = {}
    for root in roots:
        candidate = root / name
        if candidate.is_file():
            actual = candidate.resolve(strict=True)
            matches[os.path.normcase(str(actual))] = actual
    if len(matches) != 1:
        reason = "missing" if not matches else "ambiguous across Comfy model paths"
        raise RecipeIdentityError(f"qs_new4 {role} model is {reason}")
    return next(iter(matches.values()))


def _source_digest(source_paths: Mapping[str, os.PathLike | str] | list[os.PathLike | str] | tuple[os.PathLike | str, ...],
                   *, force_hash: bool) -> str:
    if isinstance(source_paths, Mapping):
        pairs = [(str(role), Path(path)) for role, path in source_paths.items()]
        if len({role for role, _path in pairs}) != len(pairs):
            raise RecipeIdentityError("Duplicate source roles")
        pairs.sort(key=lambda pair: pair[0])
    elif isinstance(source_paths, (list, tuple)):
        pairs = [(f"source{i:03d}", Path(path)) for i, path in enumerate(source_paths)]
    else:
        raise RecipeIdentityError("source_paths must be a role map or ordered list")
    if not pairs:
        raise RecipeIdentityError("At least one source file is required")
    rows = [{"role": role, "sha256": _hash_file(path, force_hash=force_hash)}
            for role, path in pairs]
    return _sha256(_json_bytes(rows))


def canonical_model_sha256(model_rows: list[dict[str, str]]) -> str:
    """Combine the five actual model byte hashes into nativeBinding.modelSha256.

    Asset names are graph loader names, never local paths.  The fixed role
    order and JSON encoding are part of the public qs_new4 identity contract.
    """
    if not isinstance(model_rows, list) or len(model_rows) != len(MODEL_ROLES):
        raise RecipeIdentityError("Exactly five qs_new4 model assets are required")
    by_role: dict[str, dict[str, str]] = {}
    for row in model_rows:
        if not isinstance(row, dict) or set(row) != {"role", "name", "sha256"}:
            raise RecipeIdentityError("Invalid qs_new4 model asset row")
        role, name, digest = row["role"], row["name"], row["sha256"]
        if role not in MODEL_ROLES or role in by_role:
            raise RecipeIdentityError("Unexpected or repeated qs_new4 model role")
        if (not isinstance(name, str) or not name.lower().endswith(".safetensors")
                or name != Path(name).name or name != PureWindowsPath(name).name):
            raise RecipeIdentityError("Invalid qs_new4 model asset name")
        _check_sha256(digest, f"{role} sha256")
        by_role[role] = {"role": role, "name": name, "sha256": digest}
    if set(by_role) != set(MODEL_ROLES):
        raise RecipeIdentityError("A qs_new4 model role is missing")
    return _sha256(_json_bytes({"schemaVersion": MODEL_DIGEST_SCHEMA_VERSION,
                                "assets": [by_role[role] for role in MODEL_ROLES]}))


@dataclass(frozen=True)
class RecipeIdentity:
    graph_sha256: str
    model_sha256: str
    model_set_sha256: str
    source_sha256: str
    source_manifest_sha256: str
    class_origin_sha256: str
    model_asset_sha256: Mapping[str, str]
    model_asset_mtime_ns: Mapping[str, int]

    def identity_for(self, first_frame_sha256: str, negative_sha256: str) -> dict[str, str]:
        """Return the path-independent public recipe and verify private inputs.

        Callers must hash the *actual* fixed PNG bytes and the exact negative
        UTF-8 text at render time.  Passing owner-supplied digest strings alone
        does not verify those local inputs.
        """
        _check_sha256(first_frame_sha256, "first_frame_sha256")
        _check_sha256(negative_sha256, "negative_sha256")
        return self.public_identity()

    def public_identity(self) -> dict[str, str]:
        """Return the fixed logic contract without device or buyer inputs."""
        recipe = {
            "schemaVersion": SCHEMA_VERSION,
            "workflow": WORKFLOW,
            "seconds": 5,
            "graphSha256": self.graph_sha256,
            "modelSha256": self.model_sha256,
            "sourceManifestSha256": self.source_manifest_sha256,
            "classOriginSha256": self.class_origin_sha256,
            "runtimeAbi": RUNTIME_ABI,
        }
        return {
            "executionRecipeSha256": _sha256(_json_bytes(recipe)),
            "modelSha256": self.model_sha256,
            "modelSetSha256": self.model_set_sha256,
            "sourceManifestSha256": self.source_manifest_sha256,
            "classOriginSha256": self.class_origin_sha256,
            "graphSha256": self.graph_sha256,
            "runtimeAbi": RUNTIME_ABI,
        }


def build_identity(api_root: os.PathLike | str, comfy_root: os.PathLike | str,
                   source_paths: Mapping[str, os.PathLike | str] | list[os.PathLike | str] | tuple[os.PathLike | str, ...],
                   *, source_manifest_sha256: str, class_origin_sha256: str,
                   output_root: os.PathLike | str | None = None,
                   force_hash: bool = False) -> RecipeIdentity:
    """Identify the exact local qs_new4 graph and its five Comfy model files.

    ``comfy_root`` means the *Comfy installation/model root* used by the
    running Comfy process.  It contains ``models`` and optionally
    ``extra_model_paths.yaml``.  It is not the adapter's ``H3_COMFY_ROOT``
    input/output directory, which can be a separate local workspace.
    Conflicting same-name files fail closed.  No model bytes, absolute paths
    or owner configuration are returned.
    """
    try:
        api_root = Path(api_root).resolve(strict=True)
        comfy_root = Path(comfy_root).resolve(strict=True)
    except (OSError, ValueError) as error:
        raise RecipeIdentityError("The H3 API or Comfy root is unavailable") from error
    graph = _reference_graph(api_root)
    graph_sha = canonical_graph_sha256(graph)
    roots = _model_roots(comfy_root)
    if output_root is not None:
        output_root = Path(output_root).resolve(strict=True)
        # Comfy main.py appends these save/output locations to model search.
        # Duplicate basenames in any configured location fail closed below.
        roots["text_encoders"].append(output_root / "clip")
        for category in ("diffusion_models", "vae", "loras"):
            roots[category].append(output_root / category)
    model_rows = []
    model_digests: dict[str, str] = {}
    model_mtimes: dict[str, int] = {}
    for role, (category, name) in sorted(_model_names(graph).items()):
        asset = _resolve_model(roots[category], name, role)
        asset_sha = _hash_file(asset, force_hash=force_hash)
        model_digests[role] = asset_sha
        model_mtimes[role] = asset.stat().st_mtime_ns
        model_rows.append({"role": role, "name": name, "sha256": asset_sha})
    model_sha = canonical_model_sha256(model_rows)
    source_sha = _source_digest(source_paths, force_hash=force_hash)
    source_manifest_sha256 = _check_sha256(source_manifest_sha256, "source_manifest_sha256")
    class_origin_sha256 = _check_sha256(class_origin_sha256, "class_origin_sha256")
    # modelSetSha256 is a compatibility alias; both fields bind the same five
    # byte-level model digests, never a filename, size, or mtime alone.
    return RecipeIdentity(graph_sha, model_sha, model_sha,
                          source_sha, source_manifest_sha256, class_origin_sha256,
                          model_digests, model_mtimes)
