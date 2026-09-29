#!/usr/bin/env python3
"""Five-second H3 node entry with an author-owned first frame and workflow.

Run on the compute PC only. H3_FIRST_FRAME_PATH and H3_WORKFLOW are local
owner configuration; buyers provide inline prompt text, seconds=5 and an
optional seed. The fixed H3 runner talks only to this node's loopback adapter.
Local generation does not constitute upload, buyer delivery or settlement.
Install h3_runtime.py alongside this entry or bind H3_RUNTIME_SCRIPT locally.
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import re
import stat
import sys
from urllib.parse import urlparse


class H3NodeInputError(ValueError):
    """Input or node configuration cannot execute this public contract."""


def prepare_node_request(params: dict, inline: str, environment: dict) -> dict:
    """Bind buyer text to owner-local model settings without accepting paths."""
    forbidden = {"image_path", "workflow", "adapter", "adapter_url", "dry_run"}
    if forbidden.intersection(params):
        raise H3NodeInputError("H3_BUYER_NODE_CONFIGURATION_FORBIDDEN")
    allowed = {"prompt", "inline_input", "seconds", "seed"}
    if any(key not in allowed for key in params):
        raise H3NodeInputError("H3_INPUT_PARAMETER_UNSUPPORTED")
    prompt = params.get("prompt") or params.get("inline_input") or inline
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.strip()) > 7000:
        raise H3NodeInputError("H3_PROMPT_INVALID")
    seconds = params.get("seconds", 5)
    if type(seconds) is not int or seconds != 5:
        raise H3NodeInputError("H3_PUBLIC_DURATION_MUST_BE_FIVE_SECONDS")
    seed = params.get("seed")
    if seed is not None and (type(seed) is not int or not 1 <= seed <= 2147483647):
        raise H3NodeInputError("H3_SEED_INVALID")
    endpoint = urlparse(environment.get("H3_ADAPTER_BASE", "http://127.0.0.1:8790"))
    if (endpoint.scheme != "http" or endpoint.hostname not in ("127.0.0.1", "::1")
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
            or endpoint.path not in ("", "/")):
        raise H3NodeInputError("H3_NODE_ADAPTER_MUST_BE_LOOPBACK")
    raw_first = environment.get("H3_FIRST_FRAME_PATH", "")
    first = Path(raw_first)
    if not raw_first or not first.is_absolute() or not first.is_file():
        raise H3NodeInputError("H3_OWNER_FIRST_FRAME_NOT_CONFIGURED")
    if first.suffix.lower() != ".png" or not 0 < first.stat().st_size <= 16 * 1024 * 1024:
        raise H3NodeInputError("H3_OWNER_FIRST_FRAME_INVALID")
    with first.open("rb") as image:
        if image.read(8) != b"\x89PNG\r\n\x1a\n":
            raise H3NodeInputError("H3_OWNER_FIRST_FRAME_INVALID")
    workflow = environment.get("H3_WORKFLOW", "")
    if not isinstance(workflow, str) or not workflow.startswith("qs_") or len(workflow) > 100:
        raise H3NodeInputError("H3_OWNER_WORKFLOW_INVALID")
    result = {"prompt": prompt.strip(), "seconds": 5,
              "workflow": workflow, "image_path": str(first.resolve())}
    if seed is not None:
        result["seed"] = seed
    return result


def local_generation_result(result: dict, output_directory: str) -> dict:
    """Describe actual bytes for the worker's uploader; never invent a receipt."""
    raw_output = Path(str(result.get("video_path") or ""))
    if not raw_output.is_absolute() or raw_output.is_symlink():
        raise H3NodeInputError("H3_LOCAL_OUTPUT_INVALID")
    output = raw_output.resolve()
    root = Path(output_directory).resolve()
    if not output.is_relative_to(root) or not output.is_file() or output.suffix.lower() != ".mp4":
        raise H3NodeInputError("H3_LOCAL_OUTPUT_MISSING")
    identity = result.get("execution_identity")
    expected = {"executionRecipeSha256": os.environ.get("H3_EXPECTED_EXECUTION_RECIPE_SHA256", ""),
                "modelSha256": os.environ.get("H3_EXPECTED_MODEL_SHA256", "")}
    if (not isinstance(identity, dict) or set(identity) != set(expected)
            or any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in expected.values())
            or identity != expected):
        raise H3NodeInputError("H3_ACTUAL_EXECUTION_IDENTITY_MISMATCH")
    before = output.lstat()
    size = before.st_size
    if output.is_symlink() or not stat.S_ISREG(before.st_mode) or not 0 < size <= 16 * 1024 * 1024:
        raise H3NodeInputError("H3_LOCAL_OUTPUT_INVALID")
    digest = hashlib.sha256()
    total = 0
    with output.open("rb") as artifact:
        opened = os.fstat(artifact.fileno())
        if (before.st_dev, before.st_ino, size) != (opened.st_dev, opened.st_ino, opened.st_size):
            raise H3NodeInputError("H3_LOCAL_OUTPUT_CHANGED")
        for block in iter(lambda: artifact.read(1024 * 1024), b""):
            total += len(block)
            if total > 16 * 1024 * 1024:
                raise H3NodeInputError("H3_LOCAL_OUTPUT_INVALID")
            digest.update(block)
        after_fd = os.fstat(artifact.fileno())
    after = output.lstat()
    if (total != size or (before.st_dev, before.st_ino, size, before.st_mtime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            or (opened.st_dev, opened.st_ino, size, opened.st_mtime_ns)
            != (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns)):
        raise H3NodeInputError("H3_LOCAL_OUTPUT_CHANGED")
    return {"status": "ok", "schema_version": "v1", "task_type": "video_generate",
            "elapsed_ms": result.get("elapsed_ms"), "video_path": str(output),
            "summary": {"seconds": 5, "size_bytes": size},
            "local_output": {"name": output.name, "mime_type": "video/mp4",
                             "size_bytes": size, "sha256": digest.hexdigest()},
            "execution_identity": identity, "delivery_state": "pending_node_upload"}


def main() -> int:
    """Run the existing H3 engine and emit its bounded node-side result."""
    try:
        params = json.loads(os.environ.get("EC_PARAMS", "{}"))
        if not isinstance(params, dict):
            raise H3NodeInputError("H3_INPUT_PARAMETER_UNSUPPORTED")
        inline = ""
        if not params.get("prompt") and not params.get("inline_input"):
            inline = sys.stdin.read(7001)
        prepared = prepare_node_request(params, inline, dict(os.environ))
        output_directory = os.environ.get("EC_OUTPUT_DIR", "")
        if not output_directory or not Path(output_directory).is_absolute():
            raise H3NodeInputError("H3_NODE_OUTPUT_DIRECTORY_REQUIRED")
        runtime = Path(os.environ.get("H3_RUNTIME_SCRIPT") or Path(__file__).with_name("h3_runtime.py"))
        if not runtime.is_absolute() or not runtime.is_file():
            raise H3NodeInputError("H3_NODE_RUNTIME_SCRIPT_NOT_INSTALLED")
        # Owner preparation checks health and the fixed image without a GPU
        # job. Buyers cannot select this through task parameters.
        preparation_only = os.environ.get("H3_PREPARATION_ONLY") == "1"
        if preparation_only:
            prepared["dry_run"] = True
        os.environ["EC_PARAMS"] = json.dumps(prepared, ensure_ascii=False)
        output = io.StringIO()
        code = 0
        with contextlib.redirect_stdout(output):
            try:
                runpy.run_path(str(runtime), run_name="__main__")
            except SystemExit as stopped:
                code = stopped.code if type(stopped.code) is int else 1
        result = json.loads(output.getvalue())
        if code != 0 or result.get("status") != "ok":
            print(json.dumps({"status": "error", "schema_version": "v1",
                              "task_type": "video_generate", "reason": "H3_NODE_GENERATION_FAILED",
                              "failure_class": result.get("failure_class", "script_error")}))
            return 1
        if preparation_only:
            result = {"status": "prepared", "schema_version": "v1", "task_type": "video_generate",
                      "generation_executed": False, "delivery_state": "not_started"}
        else:
            result = local_generation_result(result, output_directory)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (H3NodeInputError, ValueError, OSError) as failure:
        reason = str(failure) if isinstance(failure, H3NodeInputError) else "H3_NODE_ENTRY_FAILED"
        print(json.dumps({"status": "error", "schema_version": "v1", "task_type": "video_generate",
                          "reason": reason, "failure_class": "missing_dep"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
