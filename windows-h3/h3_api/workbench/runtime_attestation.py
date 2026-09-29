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


def _private_file_record(path: Path, generation: tuple[int, int, int, int], sha256: str) -> dict:
    if (not path.is_absolute() or len(generation) != 4 or
            not isinstance(sha256, str) or len(sha256) != 64):
        raise ComfyRuntimeError("Python runtime file identity is unavailable")
    return {"path": os.path.normcase(str(path.resolve(strict=True))),
            "generation": list(generation), "sha256": sha256}


def parse_pyvenv_base_executable(raw: bytes) -> Path:
    """Get the OS image selected by a prepared Windows venv without executing it."""
    if not isinstance(raw, bytes) or len(raw) > 65536:
        raise ComfyRuntimeError("Prepared Python venv configuration is invalid")
    try:
        lines = raw.decode("utf-8-sig").splitlines()
        values = [value.strip() for line in lines if "=" in line
                  for key, value in [line.split("=", 1)] if key.strip().lower() == "executable"]
    except UnicodeError as error:
        raise ComfyRuntimeError("Prepared Python venv configuration is invalid") from error
    if len(values) != 1 or not Path(values[0]).is_absolute():
        raise ComfyRuntimeError("Prepared Python venv base executable is unavailable")
    return Path(values[0])


def verify_prepared_venv_receipt(raw: bytes, configured_python: Path,
                                 venv_sha256: str, venv_size: int,
                                 cfg_sha256: str, cfg_size: int) -> None:
    """Bind the running venv files to the installer's private prepared receipt."""
    try:
        document = json.loads(raw.decode("utf-8"))
        interpreter = document["interpreters"]["comfyPython"]
        files = document["environments"]["comfy"]["files"]
        if (not isinstance(interpreter, str) or
                not _same_path(Path(interpreter), configured_python) or
                not isinstance(files, list)):
            raise ValueError("wrong prepared interpreter")
        selected = {row.get("path"): row for row in files if isinstance(row, dict)
                    and row.get("path") in ("Scripts/python.exe", "pyvenv.cfg")}
        if (len(selected) != 2 or
                selected["Scripts/python.exe"].get("sha256") != venv_sha256 or
                selected["Scripts/python.exe"].get("size") != venv_size or
                selected["pyvenv.cfg"].get("sha256") != cfg_sha256 or
                selected["pyvenv.cfg"].get("size") != cfg_size):
            raise ValueError("prepared venv file pins differ")
    except (OSError, UnicodeError, ValueError, KeyError, TypeError) as error:
        raise ComfyRuntimeError("Prepared Comfy Python receipt differs from runtime") from error


def python_runtime_sha256(venv_python: Path, venv_generation: tuple[int, int, int, int],
                          venv_sha256: str, pyvenv_cfg: Path,
                          cfg_generation: tuple[int, int, int, int], cfg_sha256: str,
                          base_python: Path, base_generation: tuple[int, int, int, int],
                          base_sha256: str) -> str:
    """Private same-machine identity shared with the in-process Comfy attestor."""
    prefix = venv_python.parent.parent
    if (venv_python.name.casefold() != "python.exe" or
            venv_python.parent.name.casefold() != "scripts" or
            not _same_path(pyvenv_cfg, prefix / "pyvenv.cfg")):
        raise ComfyRuntimeError("Configured Comfy interpreter is not a prepared venv")
    return _json_sha256({
        "schemaVersion": "qs.h3.python-runtime.v1",
        "sysPrefix": os.path.normcase(str(prefix.resolve(strict=True))),
        "sysExecutable": _private_file_record(venv_python, venv_generation, venv_sha256),
        "pyvenvCfg": _private_file_record(pyvenv_cfg, cfg_generation, cfg_sha256),
        "baseExecutable": _private_file_record(base_python, base_generation, base_sha256),
    })


def verify_comfy_interpreter(process, cmdline: list[str], configured_python: Path,
                             configured_generation: tuple[int, int, int, int],
                             base_python: Path,
                             base_generation: tuple[int, int, int, int]) -> str:
    """Bind the OS image/argv to the venv's pinned *base* Python executable.

    Windows venv launchers can report sys.executable=venv/Scripts/python.exe
    inside the process while psutil.exe()/argv[0] identify the base Python.
    The separate in-process attestor binds sys.executable and sys.prefix to the
    configured venv. Neither matching bytes nor basename proves file identity.
    """
    if (not isinstance(configured_python, Path) or not configured_python.is_absolute() or
            not isinstance(base_python, Path) or not base_python.is_absolute() or
            len(configured_generation) != 4 or len(base_generation) != 4 or not cmdline):
        raise ComfyRuntimeError("Configured Comfy interpreter identity is unavailable")
    image = Path(process.exe())
    command = Path(cmdline[0])
    for candidate in (image, command):
        if (not candidate.is_absolute() or
                not _same_path(candidate, base_python) or
                not os.path.samefile(candidate, base_python)):
            raise ComfyRuntimeError("Comfy process uses a different Python interpreter")
        details = candidate.stat()
        generation = (details.st_dev, details.st_ino, details.st_size, details.st_mtime_ns)
        if generation != base_generation:
            raise ComfyRuntimeError("Comfy interpreter file generation changed")
    details = configured_python.stat()
    if (details.st_dev, details.st_ino, details.st_size, details.st_mtime_ns) != configured_generation:
        raise ComfyRuntimeError("Comfy venv interpreter file generation changed")
    return os.path.normcase(str(base_python.resolve(strict=True)))


def _option_path(argv: list[str], key: str, cwd: Path) -> Path:
    if argv.count(key) != 1:
        raise ComfyRuntimeError(f"Comfy must specify exactly one {key}")
    index = argv.index(key)
    if index + 1 >= len(argv) or argv[index + 1].startswith("--"):
        raise ComfyRuntimeError(f"Comfy {key} has no value")
    value = Path(argv[index + 1])
    return (value if value.is_absolute() else cwd / value).resolve(strict=True)


def measure_comfy_runtime(comfy_base: str, model_root: Path,
                          input_root: Path, output_root: Path,
                          configured_python: Path,
                          configured_generation: tuple[int, int, int, int],
                          configured_python_sha256: str,
                          base_python: Path,
                          base_generation: tuple[int, int, int, int],
                          base_python_sha256: str) -> tuple[str, int]:
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
        image = verify_comfy_interpreter(process, cmdline, configured_python,
                                         configured_generation, base_python, base_generation)
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
            "exe": image,
            "exeGeneration": base_generation,
            "exeSha256": base_python_sha256,
            "venvGeneration": configured_generation,
            "venvSha256": configured_python_sha256,
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
