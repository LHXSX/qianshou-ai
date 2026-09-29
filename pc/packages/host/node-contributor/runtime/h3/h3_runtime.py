#!/usr/bin/env python3
"""Fixed five-second H3 execution on the owner's compute node.

The actual graph/model identity comes from the loopback adapter's identity
protocol, not a UI workflow export. Paths come only from local owner config.
Media stays on this node until the Host's separately issued direct upload.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlencode, urlparse
import uuid

NEG = ("second person, crowd, extra figure, distant front-facing face, face drift, "
       "warm light, amber light, orange light, magenta light, purple light, sunset, "
       "warm color grade, on-screen text, subtitles, watermark, logo, image tearing, "
       "extra limbs, deformed hands, background music")
LIMIT = 16 * 1024 * 1024
HASH = re.compile(r"[a-f0-9]{64}\Z")
ROLES = {"audioVae", "clip", "lora", "unet", "videoVae"}
T0 = time.perf_counter()


class H3RuntimeError(ValueError):
    """A fixed runtime gate failed; never exposes owner paths in its code."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise H3RuntimeError("H3_LOOPBACK_REDIRECT_FORBIDDEN")


def regular(path: Path, limit: int = LIMIT) -> bytes:
    before = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= limit:
        raise H3RuntimeError("H3_LOCAL_FILE_INVALID")
    with path.open("rb") as file:
        opened = os.fstat(file.fileno())
        data = file.read(limit + 1)
        final_fd = os.fstat(file.fileno())
    after = path.lstat()
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    if len(data) != before.st_size or identity(before) != identity(opened) or identity(opened) != identity(final_fd) or identity(final_fd) != identity(after):
        raise H3RuntimeError("H3_LOCAL_FILE_CHANGED")
    return data


def adapter_base(raw: str) -> str:
    endpoint = urlparse(raw)
    if (endpoint.scheme != "http" or endpoint.hostname not in ("127.0.0.1", "::1")
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
            or endpoint.path not in ("", "/")):
        raise H3RuntimeError("H3_NODE_ADAPTER_MUST_BE_LOOPBACK")
    return raw.rstrip("/")


def http_json(base: str, path: str, body: dict | None = None, timeout: int = 30) -> dict:
    data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8") if body is not None else None
    request = urllib.request.Request(adapter_base(base) + path, method="POST" if data is not None else "GET",
                                     data=data, headers={"Content-Type": "application/json"})
    # Do not inherit a user/system proxy for localhost or follow a local redirect.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=timeout) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise H3RuntimeError("H3_ADAPTER_RESPONSE_TOO_LARGE")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise H3RuntimeError("H3_ADAPTER_RESPONSE_INVALID")
    return value


def recipe_identity(base: str, workflow: str, first: bytes) -> dict:
    if workflow != "qs_new4":
        raise H3RuntimeError("H3_ATTESTED_WORKFLOW_UNSUPPORTED")
    frame_sha = hashlib.sha256(first).hexdigest()
    negative_sha = hashlib.sha256(NEG.encode("utf-8")).hexdigest()
    value = http_json(base, "/v1/recipes/qs_new4/identity?" + urlencode({
        "firstFrameSha256": frame_sha, "negativeSha256": negative_sha}), timeout=180)
    expected_keys = {"schemaVersion", "workflow", "recipeVersion", "graphTemplateSha256", "builderSourceSha256",
                     "firstFrameSha256", "negativeSha256", "executionRecipeSha256", "modelSha256",
                     "modelSetSha256", "weightSha256ByRole"}
    hashes = ("graphTemplateSha256", "builderSourceSha256", "firstFrameSha256", "negativeSha256",
              "executionRecipeSha256", "modelSha256", "modelSetSha256")
    weights = value.get("weightSha256ByRole")
    if (set(value) != expected_keys or value["schemaVersion"] != "qs.h3.recipe-identity.v1"
            or value["workflow"] != workflow or not isinstance(value["recipeVersion"], str)
            or not 1 <= len(value["recipeVersion"]) <= 128
            or any(not isinstance(value[k], str) or not HASH.fullmatch(value[k]) for k in hashes)
            or value["firstFrameSha256"] != frame_sha or value["negativeSha256"] != negative_sha
            or value["modelSetSha256"] != value["modelSha256"] or not isinstance(weights, dict)
            or set(weights) != ROLES or any(not isinstance(v, str) or not HASH.fullmatch(v) for v in weights.values())):
        raise H3RuntimeError("H3_RECIPE_IDENTITY_INVALID")
    return {k: value[k] for k in ("executionRecipeSha256", "modelSha256")}


def cell_output(output_root: str, jid: str) -> tuple[Path, bytes]:
    if not isinstance(jid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", jid):
        raise H3RuntimeError("H3_JOB_ID_INVALID")
    root = Path(output_root)
    if not output_root or not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise H3RuntimeError("H3_OWNER_OUTPUT_ROOT_NOT_CONFIGURED")
    resolved = root.resolve()
    if os.path.normcase(str(root.absolute())) != os.path.normcase(str(resolved)):
        raise H3RuntimeError("H3_OWNER_OUTPUT_ROOT_INVALID")
    folder = root / jid
    output = folder / "result.mp4"
    if (folder.is_symlink() or output.is_symlink() or not output.is_file()
            or not output.resolve().is_relative_to(resolved)
            or os.path.normcase(str(output.resolve())) != os.path.normcase(str(output.absolute()))):
        raise H3RuntimeError("H3_LOCAL_OUTPUT_MISSING")
    # Bound reads and reject a concurrently replaced/growing adapter artifact.
    return output.resolve(), regular(output)


def job_identity(completed: dict, expected: dict) -> dict:
    value = completed.get("recipe_identity")
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "expected", "actual", "attested"}:
        raise H3RuntimeError("H3_ACTUAL_EXECUTION_IDENTITY_MISSING")
    actual = value["actual"]
    if (completed.get("status") != "done" or value["schemaVersion"] != "qs.h3.job-identity.v1"
            or value["attested"] is not True or value["expected"] != expected
            or not isinstance(actual, dict) or set(actual) != {
                "executionRecipeSha256", "modelSha256", "modelSetSha256", "graphInstanceSha256"}
            or any(not isinstance(v, str) or not HASH.fullmatch(v) for v in actual.values())
            or actual["modelSetSha256"] != expected["modelSha256"]
            or any(actual[k] != expected[k] for k in expected)):
        raise H3RuntimeError("H3_ACTUAL_EXECUTION_IDENTITY_MISMATCH")
    return dict(expected)


def generate(params: dict, environment: dict) -> dict:
    base = adapter_base(environment.get("H3_ADAPTER_BASE", ""))
    root = Path(environment.get("EC_OUTPUT_DIR", ""))
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise H3RuntimeError("H3_NODE_OUTPUT_DIRECTORY_REQUIRED")
    output_root = environment.get("H3_ADAPTER_OUTPUT_ROOT", "")
    adapter_output = Path(output_root)
    if (not output_root or not adapter_output.is_absolute() or adapter_output.is_symlink() or not adapter_output.is_dir()
            or os.path.normcase(str(adapter_output.absolute())) != os.path.normcase(str(adapter_output.resolve()))):
        raise H3RuntimeError("H3_OWNER_OUTPUT_ROOT_INVALID")
    prompt = params.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.strip()) > 7000:
        raise H3RuntimeError("H3_PROMPT_INVALID")
    if type(params.get("seconds")) is not int or params["seconds"] != 5:
        raise H3RuntimeError("H3_PUBLIC_DURATION_MUST_BE_FIVE_SECONDS")
    workflow = params.get("workflow")
    if workflow != "qs_new4":
        raise H3RuntimeError("H3_ATTESTED_WORKFLOW_UNSUPPORTED")
    first_path = Path(str(params.get("image_path", "")))
    if not first_path.is_absolute():
        raise H3RuntimeError("H3_OWNER_FIRST_FRAME_NOT_CONFIGURED")
    first = regular(first_path)
    if not first.startswith(b"\x89PNG\r\n\x1a\n"):
        raise H3RuntimeError("H3_OWNER_FIRST_FRAME_INVALID")
    expected = {"executionRecipeSha256": environment.get("H3_EXPECTED_EXECUTION_RECIPE_SHA256", ""),
                "modelSha256": environment.get("H3_EXPECTED_MODEL_SHA256", "")}
    if any(not HASH.fullmatch(value) for value in expected.values()):
        raise H3RuntimeError("H3_EXPECTED_EXECUTION_IDENTITY_REQUIRED")
    health = http_json(base, "/health", timeout=15)
    if health.get("ok") is not True or workflow not in health.get("workflows", []):
        raise H3RuntimeError("H3_OWNER_WORKFLOW_UNAVAILABLE")
    if recipe_identity(base, workflow, first) != expected:
        raise H3RuntimeError("H3_EXECUTION_IDENTITY_CHANGED")
    if params.get("dry_run") is True:
        return {"status": "ok", "dry_run": True, "generation_executed": False,
                "execution_identity": expected}
    seed = params.get("seed", int(time.time()) % 2000000000 or 1)
    if type(seed) is not int or not 1 <= seed <= 2147483647:
        raise H3RuntimeError("H3_SEED_INVALID")
    job = http_json(base, "/v1/jobs", {"workflow": workflow, "steps": 4, "tier": None,
        "preset": "landscape_C", "seconds": 5, "prompt": prompt.strip(), "negative": NEG, "seed": seed,
        "expected": expected, "ref_images": [{"url": "data:image/png;base64," + base64.b64encode(first).decode("ascii"),
                                               "role": "first", "name": "h3_runtime_first"}]}, timeout=180)
    jid = job.get("id")
    if not isinstance(jid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", jid):
        raise H3RuntimeError("H3_JOB_ID_INVALID")
    deadline = time.monotonic() + 1200
    while time.monotonic() < deadline:
        completed = http_json(base, "/v1/jobs/" + jid, timeout=20)
        if completed.get("status") == "done":
            actual = job_identity(completed, expected)
            break
        if completed.get("status") in ("failed", "cancelled"):
            raise H3RuntimeError("H3_NODE_GENERATION_FAILED")
        time.sleep(2)
    else:
        raise H3RuntimeError("H3_NODE_GENERATION_TIMEOUT")
    _, source_bytes = cell_output(environment.get("H3_ADAPTER_OUTPUT_ROOT", ""), jid)
    final = root / ("h3_5s_" + uuid.uuid4().hex[:8] + ".mp4")
    private_source = root / ("h3_input_" + uuid.uuid4().hex + ".mp4")
    descriptor = os.open(private_source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as captured:
            captured.write(source_bytes)
        # Encode only this stable snapshot, never reopen the shared adapter result.
        subprocess.run([environment["H3_FFMPEG"], "-v", "error", "-y", "-i", str(private_source),
                        "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", "-c:a", "aac",
                        "-b:a", "256k", "-movflags", "+faststart", str(final)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=600)
    finally:
        private_source.unlink(missing_ok=True)
    data = regular(final)
    if recipe_identity(base, workflow, regular(first_path)) != expected:
        raise H3RuntimeError("H3_EXECUTION_IDENTITY_CHANGED")
    return {"status": "ok", "video_path": str(final), "execution_identity": actual,
            "summary": {"seconds": 5, "size_bytes": len(data)}}


def main() -> int:
    try:
        params = json.loads(os.environ.get("EC_PARAMS", "{}"))
        if not isinstance(params, dict):
            raise H3RuntimeError("H3_INPUT_PARAMETER_UNSUPPORTED")
        result = generate(params, dict(os.environ))
        result.update(schema_version="v1", task_type="h3_runtime", elapsed_ms=int((time.perf_counter() - T0) * 1000))
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, H3RuntimeError) else "H3_NODE_RUNTIME_FAILED"
        print(json.dumps({"status": "error", "schema_version": "v1", "task_type": "h3_runtime",
                          "reason": reason, "failure_class": "script_error"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
