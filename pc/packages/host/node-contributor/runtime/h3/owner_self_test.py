#!/usr/bin/env python3
"""Explicit owner-only H3 local trial; this script never places or charges an order.

Run with --run-local-trial, an absolute owner config, prompt and output directory.
An online adapter alone cannot write a ready receipt. The fixed node entry must
produce actual five-second video bytes verified by the owner's ffprobe.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlparse

ENTRY_SHA = "9af9d263aa8b9d9e68c73e6b5686de86a43df10e208add88df24064efd2f4467"
RUNTIME_SHA = "cf977bcf259901274cf2b44016fa0964f59b661c8d663b75a08f4dbe45c66e52"
KEYS = {"schema", "pythonPath", "ffmpegPath", "ffprobePath", "entryPath", "runtimePath",
        "firstFramePath", "workflowPath", "modelPath", "workflow", "adapterBase", "selfTestReceiptPath", "outputRoot"}
LIMIT = 16 * 1024 * 1024


def regular(path: str, limit: int) -> bytes:
    """Read a bounded regular file from the explicit owner's configuration."""
    file = Path(path)
    stat = file.lstat()
    if file.is_symlink() or not file.is_file() or not 0 < stat.st_size <= limit:
        raise ValueError("H3_LOCAL_FILE_INVALID")
    with file.open("rb") as opened:
        before_fd = os.fstat(opened.fileno())
        data = opened.read(limit + 1)
        after_fd = os.fstat(opened.fileno())
    after = file.lstat()
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    if len(data) != stat.st_size or identity(stat) != identity(before_fd) or identity(before_fd) != identity(after_fd) or identity(after_fd) != identity(after):
        raise ValueError("H3_LOCAL_FILE_CHANGED")
    return data


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def prepare(config_path: str) -> tuple[dict, str]:
    """Bind the configured source, model file, workflow and first frame to the receipt."""
    config = json.loads(regular(config_path, 16 * 1024))
    if not isinstance(config, dict) or set(config) != KEYS or config["schema"] != "qianshou.h3-owner.v1":
        raise ValueError("H3_OWNER_CONFIG_INVALID")
    for key in KEYS:
        if key.endswith("Path") and (not isinstance(config[key], str) or not Path(config[key]).is_absolute()):
            raise ValueError("H3_OWNER_CONFIG_INVALID")
    output = Path(config["outputRoot"])
    if (not output.is_absolute() or not output.is_dir() or output.is_symlink()
            or os.path.normcase(str(output.absolute())) != os.path.normcase(str(output.resolve()))):
        raise ValueError("H3_OWNER_OUTPUT_ROOT_INVALID")
    endpoint = urlparse(config["adapterBase"])
    if (endpoint.scheme != "http" or endpoint.hostname not in ("127.0.0.1", "::1")
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
            or endpoint.path not in ("", "/")):
        raise ValueError("H3_NODE_ADAPTER_MUST_BE_LOOPBACK")
    if not isinstance(config["workflow"], str) or not re.fullmatch(r"qs_[A-Za-z0-9_-]{1,96}", config["workflow"]):
        raise ValueError("H3_OWNER_WORKFLOW_INVALID")
    first = regular(config["firstFramePath"], LIMIT)
    if not first.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("H3_OWNER_FIRST_FRAME_INVALID")
    if (sha(regular(config["entryPath"], 256 * 1024)) != ENTRY_SHA
            or sha(regular(config["runtimePath"], 256 * 1024)) != RUNTIME_SHA):
        raise ValueError("H3_RUNTIME_SOURCE_CHANGED")
    workflow = regular(config["workflowPath"], 2 * 1024 * 1024)
    if not isinstance(json.loads(workflow), dict):
        raise ValueError("H3_OWNER_WORKFLOW_INVALID")
    model = Path(config["modelPath"])
    stat = model.lstat()
    if model.is_symlink() or not model.is_file() or stat.st_size < 1:
        raise ValueError("H3_OWNER_MODEL_NOT_INSTALLED")
    for key in ("pythonPath", "ffmpegPath", "ffprobePath"):
        if not Path(config[key]).is_file() or not os.access(config[key], os.X_OK):
            raise ValueError("H3_LOCAL_EXECUTABLE_UNAVAILABLE")
    identity = dict(config, firstSha256=sha(first), workflowSha256=sha(workflow),
                    modelSize=stat.st_size, modelMtimeMs=stat.st_mtime_ns // 1_000_000)
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return config, sha(encoded)


def verify_video(path: str, ffprobe: str) -> dict:
    """Probe actual streams and bind the exact output bytes, including the five-second duration."""
    data = regular(path, LIMIT)
    if data[4:8] != b"ftyp":
        raise ValueError("H3_LOCAL_OUTPUT_INVALID")
    probe = subprocess.run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
                           capture_output=True, check=True, timeout=20)
    metadata = json.loads(probe.stdout)
    duration = float(metadata.get("format", {}).get("duration", 0))
    valid = any(stream.get("codec_type") == "video" and stream.get("codec_name") in ("h264", "hevc", "av1")
                and stream.get("width", 0) > 0 and stream.get("height", 0) > 0
                for stream in metadata.get("streams", []))
    if not 4.8 <= duration <= 5.3 or not valid or data != regular(path, LIMIT):
        raise ValueError("H3_LOCAL_OUTPUT_INVALID")
    return {"bytes": len(data), "sha256": sha(data)}


def trial(config_path: str, prompt: str, output_directory: str) -> dict:
    """Execute one explicitly requested local generation, never a preparation-only run."""
    config, identity = prepare(config_path)
    if not prompt.strip() or len(prompt.strip()) > 7000:
        raise ValueError("H3_PROMPT_INVALID")
    root = Path(output_directory)
    if not root.is_absolute():
        raise ValueError("H3_NODE_OUTPUT_DIRECTORY_REQUIRED")
    root.mkdir(parents=True, exist_ok=True)
    # The fixed, byte-pinned module only defines bounded loopback protocol helpers.
    spec = importlib.util.spec_from_file_location("qianshou_pinned_h3_runtime", config["runtimePath"])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    health = module.http_json(config["adapterBase"], "/health", timeout=15)
    actual = module.recipe_identity(config["adapterBase"], config["workflow"], regular(config["firstFramePath"], LIMIT))
    if health.get("ok") is not True or config["workflow"] not in health.get("workflows", []):
        raise ValueError("H3_OWNER_WORKFLOW_UNAVAILABLE")
    environment = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "TEMP", "TMP") if key in os.environ}
    environment.update(EC_PARAMS=json.dumps({"prompt": prompt.strip(), "seconds": 5, "seed": 1}),
                       EC_OUTPUT_DIR=str(root.resolve()), H3_RUNTIME_SCRIPT=config["runtimePath"],
                       H3_ADAPTER_BASE=config["adapterBase"].rstrip("/"), H3_FIRST_FRAME_PATH=config["firstFramePath"],
                       H3_WORKFLOW=config["workflow"], H3_FFMPEG=config["ffmpegPath"],
                       H3_ADAPTER_OUTPUT_ROOT=config["outputRoot"],
                       H3_EXPECTED_EXECUTION_RECIPE_SHA256=actual["executionRecipeSha256"],
                       H3_EXPECTED_MODEL_SHA256=actual["modelSha256"])
    executed = subprocess.run([config["pythonPath"], config["entryPath"]], env=environment,
                              capture_output=True, check=True, timeout=1500)
    if len(executed.stdout) > 65536:
        raise ValueError("H3_GENERATION_FAILED")
    result = json.loads(executed.stdout)
    if result.get("status") != "ok" or result.get("delivery_state") != "pending_node_upload" or result.get("execution_identity") != actual:
        raise ValueError("H3_GENERATION_FAILED")
    video = Path(result["video_path"]).resolve()
    if not video.is_relative_to(root.resolve()):
        raise ValueError("H3_LOCAL_OUTPUT_OUTSIDE_WORKSPACE")
    proof = verify_video(str(video), config["ffprobePath"])
    if proof != {"bytes": result["local_output"]["size_bytes"], "sha256": result["local_output"]["sha256"]}:
        raise ValueError("H3_LOCAL_OUTPUT_CHANGED")
    if (prepare(config_path)[1] != identity or module.recipe_identity(config["adapterBase"], config["workflow"],
            regular(config["firstFramePath"], LIMIT)) != actual):
        raise ValueError("H3_OWNER_CONFIGURATION_CHANGED")
    native_identity = dict(ownerIdentity=identity, **actual)
    encoded = json.dumps(native_identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    binding = dict(runtimeAbi="qianshou.order-runtime.native-h3.v1",
                   runtime=dict(engine="h3", version="h3-runtime-v1", entrySha256=ENTRY_SHA, runtimeSha256=RUNTIME_SHA),
                   ownerConfigDigest="sha256:" + sha(encoded), **actual)
    receipt = dict(schema="qianshou.h3-self-test.v1", generationExecuted=True,
                   ownerIdentity=identity, nativeBinding=binding, videoPath=str(video), **proof)
    target = Path(config["selfTestReceiptPath"])
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink():
        raise ValueError("H3_LOCAL_FILE_INVALID")
    descriptor, temporary_path = tempfile.mkstemp(prefix="h3-self-test-", suffix=".json", dir=target.parent)
    temporary = Path(temporary_path)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as written:
            written.write(json.dumps(receipt, ensure_ascii=False, indent=2))
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-local-trial", action="store_true", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--output-directory", required=True)
    arguments = parser.parse_args()
    print(json.dumps(trial(arguments.config, arguments.prompt, arguments.output_directory), ensure_ascii=False))
