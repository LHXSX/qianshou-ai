"""Explicit V2 recipe identity with private model routing separated from code.

V1 raw source hashing remains in recipe_identity.py. V2 validates the known
Comfy YAML routing syntax, resolves all five actual loaders without ambiguity,
and hashes routing paths only into local_config_sha256. Raw YAML and source
snapshots still have to remain unchanged across each executing job.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import stat
from typing import Mapping

import recipe_identity as v1

SCHEMA_VERSION = "qs.h3.recipe-identity.v2"
CONFIG_SCHEMA = "qs.h3.local-model-config.v2"
YAML_LIMIT = 64 * 1024
CODE_ROLES = frozenset({"adapter", "graphBuilder", "identity", "identityV2", "runtimeAttestation",
    "comfyGraph", "gateway", "jobs", "schemas", "workflows", "comfyMain", "comfyFolderPaths",
    "comfyExecution", "comfyCaching", "comfyCliArgs", "dualClockNode", "dualClockSampling",
    "dualClockCore", "h3ComfyNodes", "sageNode"})
CATEGORIES = {"unet": "diffusion_models", "diffusion_models": "diffusion_models",
              "clip": "text_encoders", "text_encoders": "text_encoders", "vae": "vae", "loras": "loras"}


def _regular_config(path: Path) -> tuple[bytes, str]:
    before = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= YAML_LIMIT:
        raise v1.RecipeIdentityError("Invalid Comfy model path config file")
    digest = v1._hash_file(path, force_hash=True)
    with path.open("rb") as stream:
        data = stream.read(YAML_LIMIT + 1)
        opened = v1._file_identity(os.fstat(stream.fileno()))
    if (len(data) != before.st_size or opened != v1._file_identity(before)
            or opened != v1._file_identity(path.lstat()) or v1._sha256(data) != digest):
        raise v1.RecipeIdentityError("Comfy model path config changed during read")
    return data, digest


def _parse_config(data: bytes) -> dict:
    try:
        import yaml
    except ImportError as error:
        raise v1.RecipeIdentityError("PyYAML is required to resolve Comfy model paths") from error

    class StrictLoader(yaml.SafeLoader):
        def compose_node(self, parent, index):
            if self.check_event(yaml.AliasEvent):
                raise v1.RecipeIdentityError("Comfy model path aliases are unsupported")
            return super().compose_node(parent, index)

        def construct_mapping(self, node, deep=False):
            if not isinstance(node, yaml.MappingNode):
                raise v1.RecipeIdentityError("Invalid Comfy model path mapping")
            result = {}
            for key_node, value_node in node.value:
                key = self.construct_object(key_node, deep=deep)
                if not isinstance(key, str) or key in result:
                    raise v1.RecipeIdentityError("Invalid or repeated Comfy model path key")
                result[key] = self.construct_object(value_node, deep=deep)
            return result

    try:
        config = yaml.load(data.decode("utf-8"), Loader=StrictLoader)
    except v1.RecipeIdentityError:
        raise
    except (UnicodeError, yaml.YAMLError, ValueError, TypeError) as error:
        raise v1.RecipeIdentityError("Invalid Comfy model path YAML") from error
    if not isinstance(config, dict) or len(config) > 32:
        raise v1.RecipeIdentityError("Invalid Comfy model path config")
    for name, section in config.items():
        if not name or len(name) > 128 or not isinstance(section, dict) or not section:
            raise v1.RecipeIdentityError("Invalid Comfy model path section")
        if set(section) - {"base_path", "is_default", *CATEGORIES}:
            raise v1.RecipeIdentityError("Unsupported Comfy model path setting")
        if "is_default" in section and type(section["is_default"]) is not bool:
            raise v1.RecipeIdentityError("Invalid Comfy model path priority")
        for key, value in section.items():
            if key == "is_default":
                continue
            if not isinstance(value, str) or not value.strip() or len(value) > 4096 or "\x00" in value:
                raise v1.RecipeIdentityError("Invalid Comfy model category path")
            if key == "base_path" and len(value.splitlines()) != 1:
                raise v1.RecipeIdentityError("Invalid Comfy model base path")
    return config


def model_roots_v2(comfy_root: Path) -> tuple[dict[str, list[Path]], str | None]:
    """Resolve only supported routing fields; ambiguous loader names fail later."""
    models = comfy_root / "models"
    roots = {"diffusion_models": [models / "unet", models / "diffusion_models"],
             "text_encoders": [models / "text_encoders", models / "clip"],
             "vae": [models / "vae"], "loras": [models / "loras"]}
    config_path = comfy_root / "extra_model_paths.yaml"
    if not config_path.exists() and not config_path.is_symlink():
        return roots, None
    data, yaml_sha = _regular_config(config_path)
    config = _parse_config(data)
    count = 0
    for section in config.values():
        base = section.get("base_path")
        if base is None:
            base_path = config_path.parent
        else:
            expanded = Path(os.path.expandvars(os.path.expanduser(base)))
            base_path = expanded if expanded.is_absolute() else config_path.parent / expanded
        for key, value in section.items():
            category = CATEGORIES.get(key)
            if category is None:
                continue
            for line in value.splitlines():
                subpath = line.strip()
                if not subpath:
                    continue
                count += 1
                if count > 128 or len(subpath) > 1024:
                    raise v1.RecipeIdentityError("Comfy model routing exceeds the supported bound")
                expanded = Path(os.path.expandvars(os.path.expanduser(subpath)))
                roots[category].append(expanded if expanded.is_absolute() else base_path / expanded)
    return roots, yaml_sha


@dataclass(frozen=True)
class ModelConfigSnapshot:
    path: Path
    data: bytes | None
    physical_path: Path | None
    file_identity: tuple[int, ...] | None

    def assert_current(self, comfy_boot_ns: int) -> None:
        """Reject creation, deletion, replacement, or a post-boot YAML edit."""
        if self.data is None:
            if self.path.exists() or self.path.is_symlink():
                raise v1.RecipeIdentityError("Comfy model routing appeared after adapter startup")
            return
        try:
            data, _digest = _regular_config(self.path)
            if (data != self.data or self.path.resolve(strict=True) != self.physical_path
                    or v1._file_identity(self.path.lstat()) != self.file_identity):
                raise v1.RecipeIdentityError("Comfy model routing changed after adapter startup")
            if self.path.stat().st_mtime_ns > comfy_boot_ns:
                raise v1.RecipeIdentityError("Comfy model routing changed after Comfy started")
        except OSError as error:
            raise v1.RecipeIdentityError("Comfy model routing is unavailable") from error


def freeze_model_config(comfy_root: Path) -> ModelConfigSnapshot:
    """Freeze the optional YAML's presence and validated bytes at adapter startup."""
    path = comfy_root / "extra_model_paths.yaml"
    if not path.exists() and not path.is_symlink():
        return ModelConfigSnapshot(path, None, None, None)
    data, _digest = _regular_config(path)
    _parse_config(data)
    return ModelConfigSnapshot(path, data, path.resolve(strict=True), v1._file_identity(path.lstat()))


@dataclass(frozen=True)
class RecipeIdentityV2:
    graph_sha256: str
    model_sha256: str
    model_set_sha256: str
    source_sha256: str
    model_asset_sha256: Mapping[str, str]
    model_asset_mtime_ns: Mapping[str, int]
    local_config_sha256: str

    def identity_for(self, first_frame_sha256: str, negative_sha256: str) -> dict[str, str]:
        frame = v1._check_sha256(first_frame_sha256, "first_frame_sha256")
        negative = v1._check_sha256(negative_sha256, "negative_sha256")
        recipe = {"schemaVersion": SCHEMA_VERSION, "workflow": v1.WORKFLOW, "seconds": 5,
                  "graphSha256": self.graph_sha256, "sourceSha256": self.source_sha256,
                  "modelSha256": self.model_sha256, "firstFrameSha256": frame, "negativeSha256": negative}
        return {"executionRecipeSha256": v1._sha256(v1._json_bytes(recipe)),
                "modelSha256": self.model_sha256, "modelSetSha256": self.model_set_sha256,
                "firstFrameSha256": frame, "localConfigSha256": self.local_config_sha256}


def build_identity_v2(api_root: os.PathLike | str, comfy_root: os.PathLike | str,
                      source_paths: Mapping[str, os.PathLike | str], *,
                      output_root: os.PathLike | str | None = None,
                      force_hash: bool = False) -> RecipeIdentityV2:
    """Hash code and measured five loaders publicly; keep routing facts private."""
    api_root = Path(api_root).resolve(strict=True)
    comfy_root = Path(comfy_root).resolve(strict=True)
    if not isinstance(source_paths, Mapping) or set(source_paths) not in (CODE_ROLES, CODE_ROLES | {"comfyExtraModelPaths"}):
        raise v1.RecipeIdentityError("The V2 execution source roles are incomplete")
    roots, yaml_sha = model_roots_v2(comfy_root)
    config_path = comfy_root / "extra_model_paths.yaml"
    if (yaml_sha is None) != ("comfyExtraModelPaths" not in source_paths):
        raise v1.RecipeIdentityError("The V2 model routing snapshot is incomplete")
    if yaml_sha is not None and Path(source_paths["comfyExtraModelPaths"]).resolve(strict=True) != config_path.resolve(strict=True):
        raise v1.RecipeIdentityError("The V2 model routing snapshot differs from Comfy")
    if output_root is not None:
        output_root = Path(output_root).resolve(strict=True)
        roots["text_encoders"].append(output_root / "clip")
        for category in ("diffusion_models", "vae", "loras"):
            roots[category].append(output_root / category)
    graph = v1._reference_graph(api_root)
    graph_sha = v1.canonical_graph_sha256(graph)
    rows, private_models = [], []
    model_digests, model_mtimes = {}, {}
    for role, (category, name) in sorted(v1._model_names(graph).items()):
        asset = v1._resolve_model(roots[category], name, role)
        digest = v1._hash_file(asset, force_hash=force_hash)
        model_digests[role], model_mtimes[role] = digest, asset.stat().st_mtime_ns
        rows.append({"role": role, "name": name, "sha256": digest})
        private_models.append({"role": role, "name": name, "sha256": digest,
                               "path": os.path.normcase(str(asset))})
    model_sha = v1.canonical_model_sha256(rows)
    public_sources = {role: source_paths[role] for role in CODE_ROLES}
    source_sha = v1._source_digest(public_sources, force_hash=force_hash)
    private = {"schema": CONFIG_SCHEMA, "comfyRoot": os.path.normcase(str(comfy_root)),
               "yamlSha256": yaml_sha, "models": private_models,
               "sourcePaths": {role: os.path.normcase(str(Path(path).resolve(strict=True)))
                               for role, path in sorted(source_paths.items())},
               "outputRoot": None if output_root is None else os.path.normcase(str(output_root))}
    if yaml_sha is None:
        if config_path.exists() or config_path.is_symlink():
            raise v1.RecipeIdentityError("Comfy model routing appeared during identity calculation")
    elif _regular_config(config_path)[1] != yaml_sha:
        raise v1.RecipeIdentityError("Comfy model routing changed during identity calculation")
    return RecipeIdentityV2(graph_sha, model_sha, model_sha, source_sha, model_digests, model_mtimes,
                            v1._sha256(v1._json_bytes(private)))
