"""Fail-closed local Comfy process check for attested H3 submissions.

No private path or process command line is returned by the HTTP adapter. The
token only lets one job confirm that it used one unchanged local Comfy process.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen
from uuid import UUID

import psutil


class ComfyRuntimeError(RuntimeError):
    pass


MODEL_LOADER_NODES = frozenset(("3", "4", "11", "12", "31"))


def _json_sha256(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def comfy_accepted_graph_sha256(graph: dict) -> str:
    """Hash the graph after Comfy's known VHS frame_rate type coercion."""
    clone = deepcopy(graph)
    try:
        frame_rate = clone["27"]["inputs"]["frame_rate"]
        if type(frame_rate) not in (int, float) or frame_rate != 24:
            raise ComfyRuntimeError("Unexpected Comfy frame rate")
        clone["27"]["inputs"]["frame_rate"] = 24.0
    except (KeyError, TypeError) as error:
        raise ComfyRuntimeError("Comfy graph is missing its frame rate") from error
    return _json_sha256(clone)


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(str(left.resolve(strict=True))) == os.path.normcase(str(right.resolve(strict=True)))


def _option_path(argv: list[str], key: str, cwd: Path) -> Path:
    if argv.count(key) != 1:
        raise ComfyRuntimeError(f"Comfy must specify exactly one {key}")
    index = argv.index(key)
    if index + 1 >= len(argv) or argv[index + 1].startswith("--"):
        raise ComfyRuntimeError(f"Comfy {key} has no value")
    value = Path(argv[index + 1])
    return (value if value.is_absolute() else cwd / value).resolve(strict=True)


def measure_comfy_runtime(comfy_base: str, model_root: Path,
                          input_root: Path, output_root: Path) -> tuple[str, int]:
    """Return (opaque process token, boot time ns) for direct, cache-free Comfy.

    This assumes the installed Comfy main.py loads its default
    extra_model_paths.yaml and no CLI model-root override. The caller hashes
    all five resolved model files and checks their mtimes against boot time.
    """
    parsed = urlsplit(comfy_base)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1") or not parsed.port:
        raise ComfyRuntimeError("Attested Comfy endpoint must be direct loopback HTTP")
    try:
        listeners = [connection for connection in psutil.net_connections(kind="tcp")
                     if connection.status == psutil.CONN_LISTEN and connection.laddr
                     and connection.laddr.port == parsed.port
                     and connection.laddr.ip == parsed.hostname and connection.pid]
        pids = {connection.pid for connection in listeners}
        if len(pids) != 1:
            raise ComfyRuntimeError("Comfy listening process is ambiguous")
        process = psutil.Process(next(iter(pids)))
        cwd = Path(process.cwd()).resolve(strict=True)
        cmdline = process.cmdline()
        model_root = model_root.resolve(strict=True)
        if len(cmdline) < 2:
            raise ComfyRuntimeError("Comfy process command line is incomplete")
        scripts = [item for item in cmdline[1:] if item.replace("\\", "/").endswith("/main.py")]
        if len(scripts) != 1:
            raise ComfyRuntimeError("Endpoint is not a direct Comfy main.py process")
        script_arg = Path(scripts[0])
        script = script_arg if script_arg.is_absolute() else cwd / script_arg
        if not _same_path(script, model_root / "main.py"):
            raise ComfyRuntimeError("Comfy process uses a different installation")
        argv = cmdline[cmdline.index(scripts[0]):]
        if argv.count("--cache-none") != 1:
            raise ComfyRuntimeError("Comfy must run with --cache-none for attested jobs")
        if any(flag in argv for flag in ("--base-directory", "--models-directory",
                                          "--extra-model-paths-config")):
            raise ComfyRuntimeError("Unsupported Comfy model-root override")
        if not _same_path(_option_path(argv, "--input-directory", cwd), input_root):
            raise ComfyRuntimeError("Comfy input root differs from adapter")
        if not _same_path(_option_path(argv, "--output-directory", cwd), output_root):
            raise ComfyRuntimeError("Comfy output root differs from adapter")
        with urlopen(comfy_base.rstrip("/") + "/system_stats", timeout=5) as response:
            stats = json.load(response)
        if stats.get("system", {}).get("argv") != argv:
            raise ComfyRuntimeError("Comfy HTTP argv differs from listening process")
        snapshot = {
            "pid": process.pid,
            "createTime": process.create_time(),
            "exe": os.path.normcase(str(Path(process.exe()).resolve(strict=True))),
            "cwd": os.path.normcase(str(cwd)),
            "argv": argv,
        }
        return _json_sha256(snapshot), int(process.create_time() * 1_000_000_000)
    except ComfyRuntimeError:
        raise
    except (OSError, ValueError, psutil.Error, KeyError, TypeError) as error:
        raise ComfyRuntimeError("Comfy runtime identity is unavailable") from error


def verify_model_load_history(comfy_base: str, prompt_id: str,
                              expected_graph_sha256: str, runtime_token: str,
                              model_sha256: str) -> str:
    """Bind a completed prompt to a fresh execution of all five loaders.

    Comfy's history contains its actual submitted graph and execution_cached
    list. With --cache-none confirmed for the same process, a successful prompt
    whose five loader nodes were not cached has a distinct load generation.
    """
    try:
        if str(UUID(prompt_id)) != prompt_id:
            raise ComfyRuntimeError("Invalid Comfy prompt ID")
        with urlopen(comfy_base.rstrip("/") + "/history/" + prompt_id, timeout=10) as response:
            history = json.load(response)
        entry = history.get(prompt_id)
        if not isinstance(entry, dict):
            raise ComfyRuntimeError("Comfy history entry is missing")
        prompt = entry.get("prompt")
        if not isinstance(prompt, list) or len(prompt) < 3 or prompt[1] != prompt_id:
            raise ComfyRuntimeError("Comfy history prompt is malformed")
        graph = prompt[2]
        if not isinstance(graph, dict) or _json_sha256(graph) != expected_graph_sha256:
            raise ComfyRuntimeError("Comfy history graph differs from submitted graph")
        status = entry.get("status") or {}
        if status.get("status_str") != "success" or status.get("completed") is not True:
            raise ComfyRuntimeError("Comfy prompt did not complete successfully")
        events = status.get("messages") or []
        starts, successes = [], []
        cached = set()
        for event in events:
            if not isinstance(event, list) or len(event) != 2 or not isinstance(event[1], dict):
                continue
            kind, payload = event
            if payload.get("prompt_id") != prompt_id:
                continue
            if kind == "execution_start":
                starts.append(payload.get("timestamp"))
            elif kind == "execution_success":
                successes.append(payload.get("timestamp"))
            elif kind == "execution_cached":
                cached.update(str(node) for node in (payload.get("nodes") or []))
        if len(starts) != 1 or len(successes) != 1 or not isinstance(starts[0], int) or not isinstance(successes[0], int):
            raise ComfyRuntimeError("Comfy loader execution generation is unknown")
        if MODEL_LOADER_NODES & cached:
            raise ComfyRuntimeError("Comfy reused a cached H3 model loader")
        generation = {
            "schemaVersion": "qs.h3.model-load-generation.v1",
            "comfyRuntimeToken": runtime_token,
            "promptId": prompt_id,
            "graphInstanceSha256": expected_graph_sha256,
            "modelSha256": model_sha256,
            "loaderNodeIds": sorted(MODEL_LOADER_NODES, key=int),
            "executionStartMs": starts[0],
            "executionSuccessMs": successes[0],
        }
        return _json_sha256(generation)
    except ComfyRuntimeError:
        raise
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise ComfyRuntimeError("Comfy load generation is unavailable") from error
