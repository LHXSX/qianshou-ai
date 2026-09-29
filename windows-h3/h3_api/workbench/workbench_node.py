"""Controlled canonical qs_new4/E_light4_sage five-second H3 adapter."""
import argparse
import asyncio
import base64
import binascii
from contextvars import ContextVar
import hashlib
import hmac
import importlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import psutil

if not sys.dont_write_bytecode:
    raise RuntimeError("Canonical H3 adapter must start with Python -B")

from graphs import SPECS, build
from recipe_identity import RecipeIdentityError, build_identity, verify_actual_graph
from runtime_attestation import (ComfyRuntimeError, comfy_accepted_graph_sha256,
                                 measure_comfy_runtime, parse_pyvenv_base_executable,
                                 python_runtime_sha256, verify_model_load_history,
                                 verify_prepared_venv_receipt)
from source_manifest import (FrozenBinary, FrozenOptionalFile, RuntimeSourceManifest,
                             SourceManifestError, _checked_bytes)
from runner import request as comfy_request

WORKFLOW = "qs_new4"
SPEC = SPECS["E_light4_sage"]
PROFILE_SPECS = {WORKFLOW: SPEC}
BASE_WORKFLOWS = frozenset()
FLASH_FRAMES = (7, 22, 36, 51, 65)
PROFILE_SECONDS = {WORKFLOW: (5,)}
CATALOG_VERSION = "1.0.0-rc.1"
_submission_identity = ContextVar("h3_submission_identity", default=None)
_ready_graph = ContextVar("h3_ready_graph", default=None)
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
REQUIRED_COMFY_CLASSES = ("MiniMaxH3ImageToVideo", "PathchSageAttentionKJ",
                          "QSH3BenchmarkDualClock")


def verify_required_object_info(base, fetch=None):
    """Query only the three fixed node schemas; full Comfy object_info is unbounded."""
    get = comfy_request if fetch is None else fetch
    for class_type in REQUIRED_COMFY_CLASSES:
        info = get(base, "/object_info/" + class_type)
        if (not isinstance(info, dict) or set(info) != {class_type} or
                not isinstance(info[class_type], dict)):
            raise RuntimeError("Measured runtime node schema is unavailable")


def _identity_sha256(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def owner_runtime_identity(config_sha, model_paths_sha, api_process_private,
                           comfy_runtime_token, source_attestation):
    """Return only digests; process tokens and private configuration stay local."""
    if any(not isinstance(value, str) or not _SHA256.fullmatch(value)
           for value in (config_sha, model_paths_sha, comfy_runtime_token)):
        raise RecipeIdentityError("H3 owner configuration or process identity is invalid")
    if not isinstance(api_process_private, dict) or not isinstance(source_attestation, dict):
        raise RecipeIdentityError("H3 owner runtime is unavailable")
    for field in ("sourceManifestSha256", "classOriginSha256", "comfyFfmpegSha256",
                  "deliveryFfmpegSha256", "pythonRuntimeSha256"):
        value = source_attestation.get(field)
        if not isinstance(value, str) or not _SHA256.fullmatch(value):
            raise RecipeIdentityError("H3 owner runtime source identity is invalid")
    comfy_process_token = source_attestation.get("processToken")
    if not isinstance(comfy_process_token, str) or not comfy_process_token:
        raise RecipeIdentityError("H3 Comfy process identity is unavailable")
    if (type(source_attestation.get("queueAdmissionGuardVersion")) is not int or
            source_attestation["queueAdmissionGuardVersion"] != 1):
        raise RecipeIdentityError("H3 Comfy queue admission guard is unavailable")
    result = {
        "schemaVersion": "qs.h3.owner-runtime-identity.v1",
        "ownerConfigDigest": _identity_sha256({
            "schemaVersion": "qs.h3.owner-config.v1",
            "installConfigSha256": config_sha,
            "modelPathConfigSha256": model_paths_sha,
        }),
        "apiProcessWitnessSha256": _identity_sha256({
            "schemaVersion": "qs.h3.api-process.v1", **api_process_private}),
        "comfyProcessWitnessSha256": _identity_sha256({
            "schemaVersion": "qs.h3.comfy-process.v1",
            "attestorProcessToken": comfy_process_token,
            "runtimeProcessToken": comfy_runtime_token,
            "pythonRuntimeSha256": source_attestation["pythonRuntimeSha256"],
            "queueAdmissionGuardVersion": 1,
        }),
        "queueAdmissionGuardVersion": 1,
        "sourceManifestSha256": source_attestation["sourceManifestSha256"],
        "classOriginSha256": source_attestation["classOriginSha256"],
        "comfyFfmpegSha256": source_attestation["comfyFfmpegSha256"],
        "deliveryFfmpegSha256": source_attestation["deliveryFfmpegSha256"],
    }
    result["ownerRuntimeWitnessSha256"] = _identity_sha256(result)
    return result


def verify_owner_config_binding(raw_config, paths, scalars):
    """Reject a private install config that does not describe this process."""
    if len(raw_config) > 1024 * 1024:
        raise RecipeIdentityError("H3 owner configuration is unavailable")
    try:
        config = json.loads(raw_config.decode("utf-8"))
        if (not isinstance(config, dict) or type(config.get("schemaVersion")) is not int or
                config["schemaVersion"] != 1 or
                config.get("scope") != "qs_new4/E_light4_sage"):
            raise ValueError("wrong schema")
        for key, expected in paths.items():
            value = config.get(key)
            if not isinstance(value, str) or not Path(value).is_absolute():
                raise ValueError("missing path")
            if os.path.normcase(str(Path(value).resolve(strict=True))) != os.path.normcase(
                    str(Path(expected).resolve(strict=True))):
                raise ValueError("different path")
        if any(config.get(key) != expected for key, expected in scalars.items()):
            raise ValueError("different configuration")
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        raise RecipeIdentityError("H3 owner configuration differs from the running node") from error
    return config


def verify_owner_runtime_witness(expected, current):
    actual = current.get("ownerRuntimeWitnessSha256") if isinstance(current, dict) else None
    if (not isinstance(expected, str) or not _SHA256.fullmatch(expected) or
            not isinstance(actual, str) or not _SHA256.fullmatch(actual) or
            not hmac.compare_digest(expected, actual)):
        raise RecipeIdentityError("H3_OWNER_RUNTIME_WITNESS_MISMATCH")
    return current
FLASH_CONTRACT = {
    "id": "qs.h3.flash.static5@1.0.0-rc.1",
    "durationSeconds": 3,
    "fps": 24,
    "rawFrames": 73,
    "outputCount": 5,
    "saveFrames": list(FLASH_FRAMES),
    "motionPolicy": "static-hard-cut",
}


def profile(seconds, workflow=WORKFLOW):
    if not isinstance(workflow, str) or workflow not in PROFILE_SPECS:
        raise ValueError("Explicit supported workflow required; no fallback")
    if isinstance(seconds, bool) or seconds not in PROFILE_SECONDS[workflow]:
        raise ValueError("Only the fixed five-second qs_new4 cell is admitted")
    return {"workflow": workflow, "steps": PROFILE_SPECS[workflow].steps, "tier": None,
            "preset": "landscape_C", "seconds": seconds}


def spec_for_job(job):
    expected = profile(job.get("seconds"), job.get("workflow"))
    if job.get("steps") != expected["steps"]:
        raise ValueError("Workflow and steps must match the explicit recipe")
    spec = PROFILE_SPECS[job["workflow"]]
    if job["workflow"] in BASE_WORKFLOWS:
        if type(job.get("steps")) is not int or job.get("lora_loader"):
            raise ValueError("Base comparison requires exact steps and no LoRA")
        if job["seconds"] == 3:
            if job.get("save_frames") != list(FLASH_FRAMES):
                raise ValueError("Base flash requires the five ordered native frame indices")
            if any(job.get(key) for key in ("ref_images", "first_image", "last_image", "identity_images",
                                           "first_frame_rel", "last_frame_rel", "identity_frame_rels")):
                raise ValueError("Base flash is text-only")
        if any(job.get(key, value) != value for key, value in (
                ("length", 73 if job["seconds"] == 3 else 124),
                ("width", spec.width), ("height", spec.height), ("model", spec.model))):
            raise ValueError("Base dimensions, frame count and full INT8 model are fixed")
    return spec


def recipe_metadata(workflow):
    spec = PROFILE_SPECS[workflow]
    result = {"recipe": spec.name, "lora": spec.lora if spec.turbo_lora else None,
              "turbo_lora": spec.turbo_lora, "sampler": spec.sampler,
              "scheduler": "dual_clock" if spec.shift is not None else "simple",
              "shift_video": spec.shift if spec.shift is not None else 12.0, "shift_audio": 3,
              "attention": "sage" if spec.sage else "default",
              "supported_seconds": list(PROFILE_SECONDS[workflow]),
              "flash_only": False}
    if workflow in BASE_WORKFLOWS:
        result.update(validation_status="experimental-unverified", flash_save_frames=list(FLASH_FRAMES),
                      comparison_group="full-int8-no-lora-sage-768p")
    return result


def model_profiles(model):
    return {workflow: {"model": spec.model or model,
                       "steps": spec.steps, "width": spec.width, "height": spec.height,
                       **recipe_metadata(workflow)}
            for workflow, spec in PROFILE_SPECS.items()}


def production_spec(base_url="http://127.0.0.1:8790"):
    machine_label = (os.environ.get("H3_MACHINE_LABEL") or "").strip()
    if not machine_label:
        raise RuntimeError("H3_MACHINE_LABEL must be configured for this device")
    return {
        "name": "Qianshou H3 qs_new4 controlled node adapter",
        "version": "0.1.0-canonical.20260927",
        "catalogVersion": CATALOG_VERSION,
        "machine": machine_label,
        "output": {"width": 1344, "height": 768, "fps": 24,
                   "rawFrames5s": 124, "deliveryFrames5s": 120},
        "modelProfiles": model_profiles("minimax_h3_fl2va_int8_convrot.safetensors"),
        "jobs": {
            "submit": {
                "method": "POST", "path": "/v1/jobs", "url": f"{base_url}/v1/jobs",
                "allowedFields": ["prompt", "negative", "preset", "workflow", "seconds",
                                  "steps", "seed", "save_frames", "ref_images", "expected",
                                  "ownerRuntimeWitnessSha256"],
                "requiresExplicitSeed": True,
                "requiresFirstFrameForCell": True,
            },
            "recipeIdentity": {"method": "GET", "path": "/v1/recipes/qs_new4/identity",
                               "query": []},
            "ownerRuntimeIdentity": {"method": "GET", "path": "/v1/owner-runtime/identity",
                                     "query": []},
            "status": {"method": "GET", "path": "/v1/jobs/{id}"},
            "progress": {"method": "GET", "path": "/v1/jobs/{id}/progress"},
            "events": {"method": "GET", "path": "/v1/jobs/{id}/events"},
            "cancel": {"method": "POST", "path": "/v1/jobs/{id}/cancel"},
            "video": {"method": "GET", "path": "/v1/jobs/{id}/video"},
        },
    }


def fed_profile(job):
    spec_for_job(job)
    return {**profile(job["seconds"], job["workflow"]),
            **{key: job[key] for key in ("steps", "preset", "width", "height", "model", "seed")},
            "generated_frames": job["length"], "delivery_frames": 120 if job["seconds"] == 5 else 73,
            **recipe_metadata(job["workflow"]),
            "version": "0.1.0-canonical.20260927"}


def attested_request(body):
    """Accept only the fixed five-second, single-PNG native binding."""
    expected = body.get("expected")
    if expected is None:
        raise ValueError("H3_EXPECTED_IDENTITY_REQUIRED")
    if not isinstance(expected, dict) or set(expected) != {"executionRecipeSha256", "modelSha256"}:
        raise ValueError("H3_EXPECTED_IDENTITY_INVALID")
    if any(not isinstance(value, str) or not _SHA256.fullmatch(value)
           for value in expected.values()):
        raise ValueError("H3_EXPECTED_IDENTITY_INVALID")
    owner_witness = body.get("ownerRuntimeWitnessSha256")
    if not isinstance(owner_witness, str) or not _SHA256.fullmatch(owner_witness):
        raise ValueError("H3_OWNER_RUNTIME_WITNESS_REQUIRED")
    if body.get("workflow") != WORKFLOW or body.get("seconds") != 5 or body.get("steps") != 4:
        raise ValueError("H3_ATTESTED_PROFILE_INVALID")
    if body.get("save_frames") not in (None, []):
        raise ValueError("H3_ATTESTED_EXTRA_FRAMES_FORBIDDEN")
    if any(body.get(key) for key in ("first_image", "last_image", "identity_images", "images")):
        raise ValueError("H3_ATTESTED_EXTRA_IMAGES_FORBIDDEN")
    refs = body.get("ref_images")
    if not isinstance(refs, list) or len(refs) != 1 or not isinstance(refs[0], dict):
        raise ValueError("H3_ATTESTED_SINGLE_FIRST_FRAME_REQUIRED")
    ref = refs[0]
    url = ref.get("url")
    if ref.get("role") != "first" or not isinstance(url, str) or not url.startswith("data:image/png;base64,"):
        raise ValueError("H3_ATTESTED_SINGLE_FIRST_FRAME_REQUIRED")
    try:
        frame = base64.b64decode(url.split(",", 1)[1], validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("H3_ATTESTED_FIRST_FRAME_INVALID") from None
    if not 8 < len(frame) <= 16 * 1024 * 1024 or not frame.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("H3_ATTESTED_FIRST_FRAME_INVALID")
    negative = body.get("negative") or ""
    if not isinstance(negative, str):
        raise ValueError("H3_ATTESTED_NEGATIVE_INVALID")
    return {
        "expected": dict(expected),
        "ownerRuntimeWitnessSha256": owner_witness,
        "firstFrameSha256": hashlib.sha256(frame).hexdigest(),
        "negativeSha256": hashlib.sha256(negative.encode("utf-8")).hexdigest(),
    }


def validate_payload(body):
    if not isinstance(body, dict):
        raise ValueError("Object required")
    if type(body.get("seconds")) is not int or body["seconds"] != 5:
        raise ValueError("Only the fixed five-second qs_new4 cell is admitted")
    if type(body.get("steps")) is not int or body["steps"] != 4:
        raise ValueError("Only the fixed E_light4_sage four-step recipe is admitted")
    expected = profile(body["seconds"], body.get("workflow"))
    if any(body.get(k) != v for k, v in expected.items()):
        raise ValueError("Explicit matching workflow profile required; no fallback")
    allowed = set(profile(5)) | {"prompt", "negative", "seed", "save_frames", "expected",
                               "ownerRuntimeWitnessSha256",
                               "ref_images", "first_image", "last_image", "identity_images"}
    if set(body) - allowed:
        raise ValueError("Unsupported request fields")
    if not isinstance(body.get("prompt"), str) or not 1 <= len(body["prompt"].strip()) <= 7000:
        raise ValueError("Explicit bounded prompt required")
    if not isinstance(body.get("negative", ""), str) or len(body.get("negative", "")) > 3000:
        raise ValueError("Invalid negative prompt")
    if type(body.get("seed")) is not int or not 0 <= body["seed"] <= 2147483647:
        raise ValueError("Explicit reproducible seed required")
    images = list(body.get("ref_images") or [])
    if len(images) > 5 or (body["seconds"] == 3 and images):
        raise ValueError("Invalid image references")
    if body["seconds"] == 5 and not any(isinstance(v, dict) and v.get("role") == "first" for v in images):
        raise ValueError("Cell requires an ordered first-frame reference")
    for image in images:
        if not isinstance(image, dict) or not isinstance(image.get("url"), str) or not re.match(
                r"^data:image/(png|jpeg|webp);base64,", image["url"]):
            raise ValueError("Only embedded image bytes are admitted; no remote or local paths")
    # The gateway prefers ref_images. Reject ambiguous legacy references rather
    # than permitting its fallback URL/path loader to access another destination.
    if not images and any(body.get(k) for k in ("first_image", "last_image", "identity_images")):
        raise ValueError("Use ordered embedded ref_images")
    frames = body.get("save_frames") or []
    length = 73 if body["seconds"] == 3 else 124
    if not isinstance(frames, list) or len(frames) > 16 or any(type(v) is not int or not 0 <= v < length for v in frames):
        raise ValueError("Invalid native frame indices")
    if body["workflow"] in BASE_WORKFLOWS:
        spec_for_job(body)
    return attested_request(body)


def normalize_attested_gateway_job(req, attested):
    """Restore the fixed integer duration after the gateway's float conversion.

    The raw JSON integer was checked by validate_payload before this request
    acquired its per-request attestation. Never normalize an unattested caller.
    """
    if (attested is None or not isinstance(attested.get("expected"), dict) or
            not isinstance(attested.get("ownerRuntimeWitnessSha256"), str) or
            not _SHA256.fullmatch(attested["ownerRuntimeWitnessSha256"])):
        raise RecipeIdentityError("H3_EXPECTED_IDENTITY_REQUIRED")
    if type(req.get("seconds")) is not float or req["seconds"] != 5.0:
        raise ValueError("Only the fixed five-second qs_new4 cell is admitted")
    return {**req, "seconds": 5}


def delivery_command(source, destination, ffmpeg):
    """CRF quality target with a conservative five-second VBV delivery ceiling.

    The 16 Mbit/s rate plus 16 Mbit buffer allows at most roughly 12 MB of
    video over five seconds, leaving several MiB for AAC and MP4 overhead.
    The final receipt still enforces the exact 16 MiB byte limit.
    """
    return [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
               "-i", str(source), "-map", "0:v:0", "-map", "0:a:0",
               "-vf", "trim=end_frame=120,setpts=PTS-STARTPTS",
               "-af", "atrim=end=5,asetpts=PTS-STARTPTS", "-c:v", "libx264",
               "-preset", "fast", "-crf", "14", "-maxrate:v", "16M",
               "-bufsize:v", "16M", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
               str(destination)]


def trim_delivery(source, destination, ffmpeg):
    command = delivery_command(source, destination, ffmpeg)
    subprocess.run(command, check=True, capture_output=True, timeout=120)
    try:
        size = Path(destination).stat().st_size
    except OSError as error:
        raise RecipeIdentityError("H3 fixed delivery is unavailable") from error
    if not 0 < size <= 16 * 1024 * 1024:
        raise RecipeIdentityError("H3 fixed delivery exceeds the verified media limit")


def read_receipted_video_bytes(jobs_root, jid, job):
    """Return only bounded MP4 bytes verified against the final job receipt."""
    if not isinstance(jid, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", jid):
        raise RecipeIdentityError("Invalid H3 job ID")
    receipt = (job.get("recipe_identity") or {}).get("actualAfterFinalDelivery")
    if (job.get("status") != "done" or job.get("id") != jid or
            not isinstance(receipt, dict)):
        raise RecipeIdentityError("H3 delivery receipt is unavailable")
    size, expected_sha = receipt.get("deliverySize"), receipt.get("deliverySha256")
    if (type(size) is not int or not 0 < size <= 16 * 1024 * 1024 or
            not isinstance(expected_sha, str) or not _SHA256.fullmatch(expected_sha)):
        raise RecipeIdentityError("H3 delivery receipt is invalid")
    media = Path(jobs_root) / jid / "result.mp4"
    if Path(job.get("video") or "") != media:
        raise RecipeIdentityError("H3 delivery path differs from the fixed job output")
    try:
        raw, _generation = _checked_bytes(media, media, max_bytes=16 * 1024 * 1024)
    except (OSError, SourceManifestError) as error:
        raise RecipeIdentityError("H3 delivery media could not be verified") from error
    if len(raw) != size or not hmac.compare_digest(hashlib.sha256(raw).hexdigest(), expected_sha):
        raise RecipeIdentityError("H3 delivery media differs from the final receipt")
    return raw


def create_app(api_root, root, out, ffmpeg, listen_port):
    if not (os.environ.get("H3_MACHINE_LABEL") or "").strip():
        raise RecipeIdentityError("H3_MACHINE_LABEL must be configured for this device")
    if not Path(api_root).is_absolute() or not Path(root).is_absolute() or not Path(out).is_absolute():
        raise RecipeIdentityError("API, Comfy and output installation roots must be absolute")
    api_root, root, out = (Path(p).resolve(strict=True) for p in (api_root, root, out))
    if out.is_relative_to(api_root):
        raise RecipeIdentityError("H3 output root must be outside the installed source tree")
    comfy_base = (os.environ.get("H3_COMFY_BASE") or "").strip()
    if not re.fullmatch(r"http://(?:127\.0\.0\.1|\[::1\]):[0-9]{2,5}", comfy_base):
        raise RecipeIdentityError("H3_COMFY_BASE must be explicitly configured as loopback HTTP")
    if not 1 <= int(comfy_base.rsplit(":", 1)[1]) <= 65535:
        raise RecipeIdentityError("H3_COMFY_BASE port is invalid")
    adapter_input_value = (os.environ.get("H3_ADAPTER_INPUT_ROOT") or "").strip()
    adapter_output_value = (os.environ.get("H3_ADAPTER_OUTPUT_ROOT") or "").strip()
    if not adapter_input_value or not adapter_output_value:
        raise RecipeIdentityError("Explicit H3_ADAPTER_INPUT_ROOT and H3_ADAPTER_OUTPUT_ROOT are required")
    adapter_input_root, adapter_output_root = (Path(p) for p in
                                              (adapter_input_value, adapter_output_value))
    if not adapter_input_root.is_absolute() or not adapter_output_root.is_absolute():
        raise RecipeIdentityError("H3 adapter input and output roots must be absolute")
    adapter_input_root = adapter_input_root.resolve(strict=True)
    adapter_output_root = adapter_output_root.resolve(strict=True)
    if adapter_input_root.name != "LocalAPI":
        raise RecipeIdentityError("H3_ADAPTER_INPUT_ROOT must be the LocalAPI input directory")
    if adapter_output_root.name != "LocalAPI" or adapter_output_root.parent.name != "MiniMax_H3":
        raise RecipeIdentityError("H3_ADAPTER_OUTPUT_ROOT must be the qs_new4 result directory")
    input_root = adapter_input_root.parent
    output_root = adapter_output_root.parent.parent
    model_root_value = (os.environ.get("H3_COMFY_MODEL_ROOT") or "").strip()
    if not model_root_value or not Path(model_root_value).is_absolute():
        raise RecipeIdentityError("H3_COMFY_MODEL_ROOT must be an explicit absolute Comfy source root")
    model_root = Path(model_root_value).resolve(strict=True)
    if not model_root.is_dir():
        raise RecipeIdentityError("H3_COMFY_MODEL_ROOT must be an existing directory")
    slot_file_value = (os.environ.get("GPU_SLOT_FILE") or "").strip()
    if not slot_file_value or not Path(slot_file_value).is_absolute():
        raise RecipeIdentityError("GPU_SLOT_FILE must be explicitly configured as an absolute shared lock path")
    if not (api_root / "gpu_slot.py").is_file():
        raise RecipeIdentityError("Bundled GPU slot module is missing")
    manifest_value = (os.environ.get("H3_CANONICAL_MANIFEST_PATH") or "").strip()
    manifest_path = api_root / "canonical-manifest.json"
    if not manifest_value or not Path(manifest_value).is_absolute() or Path(manifest_value) != manifest_path:
        raise RecipeIdentityError("H3_CANONICAL_MANIFEST_PATH must name the installed canonical manifest")
    owner_config_value = (os.environ.get("H3_CANONICAL_CONFIG_PATH") or "").strip()
    owner_config_path = api_root.parent.parent / "private" / "config.json"
    if (not owner_config_value or not Path(owner_config_value).is_absolute() or
            Path(owner_config_value) != owner_config_path):
        raise RecipeIdentityError("H3_CANONICAL_CONFIG_PATH must name this installation's private config")
    try:
        source_manifest = RuntimeSourceManifest(api_root, model_root, manifest_path)
        delivery_encoder = FrozenBinary(Path(ffmpeg))
        private_model_paths = FrozenOptionalFile(model_root / "extra_model_paths.yaml")
        owner_config_file = FrozenBinary(owner_config_path)
        model_paths_sha = private_model_paths.check()
        if model_paths_sha is None:
            raise RecipeIdentityError("H3 private model-path configuration is required")
        raw_owner_config, _generation = owner_config_file._held.read()
        owner_config = verify_owner_config_binding(raw_owner_config, {
            "apiRoot": api_root, "comfyRoot": root, "apiPython": sys.executable,
            "ffmpeg": ffmpeg, "gpuSlotFile": slot_file_value,
            "inputRoot": input_root, "outputRoot": output_root, "adapterRoot": out,
        }, {
            "sourceManifestSha256": source_manifest.sha256,
            "modelPathConfigSha256": model_paths_sha,
            "comfyPort": int(comfy_base.rsplit(":", 1)[1]),
            "apiPort": listen_port,
            "machineLabel": os.environ["H3_MACHINE_LABEL"],
        })
        comfy_python_value = owner_config.get("comfyPython")
        if not isinstance(comfy_python_value, str) or not Path(comfy_python_value).is_absolute():
            raise RecipeIdentityError("Configured Comfy Python interpreter is unavailable")
        comfy_python_binary = FrozenBinary(Path(comfy_python_value))
        pyvenv_binary = FrozenBinary(comfy_python_binary.path.parent.parent / "pyvenv.cfg")
        cfg_raw, _cfg_generation = pyvenv_binary._held.read()
        base_python_binary = FrozenBinary(parse_pyvenv_base_executable(cfg_raw))
        receipt_value = owner_config.get("preparedReceiptPath")
        receipt_sha = owner_config.get("preparedReceiptSha256")
        if (not isinstance(receipt_value, str) or not Path(receipt_value).is_absolute() or
                not isinstance(receipt_sha, str) or not _SHA256.fullmatch(receipt_sha)):
            raise RecipeIdentityError("Prepared Comfy Python receipt is unavailable")
        prepared_receipt = FrozenBinary(Path(receipt_value))
        if not hmac.compare_digest(prepared_receipt.check(), receipt_sha):
            raise RecipeIdentityError("Prepared Comfy Python receipt changed")
        receipt_raw, _receipt_generation = prepared_receipt._held.read()
        verify_prepared_venv_receipt(
            receipt_raw, comfy_python_binary.path,
            comfy_python_binary.sha256, comfy_python_binary.first_generation[2],
            pyvenv_binary.sha256, pyvenv_binary.first_generation[2])
    except SourceManifestError as error:
        raise RecipeIdentityError(str(error)) from error

    def current_python_runtime_sha():
        try:
            if not hmac.compare_digest(prepared_receipt.check(), receipt_sha):
                raise RecipeIdentityError("Prepared Comfy Python receipt changed")
            venv_sha = comfy_python_binary.check()
            cfg_sha = pyvenv_binary.check()
            base_sha = base_python_binary.check()
            cfg_now, _generation = pyvenv_binary._held.read()
            if not os.path.samefile(parse_pyvenv_base_executable(cfg_now), base_python_binary.path):
                raise RecipeIdentityError("Comfy venv base image changed")
            return python_runtime_sha256(
                comfy_python_binary.path, comfy_python_binary.first_generation, venv_sha,
                pyvenv_binary.path, pyvenv_binary.first_generation, cfg_sha,
                base_python_binary.path, base_python_binary.first_generation, base_sha)
        except (ComfyRuntimeError, SourceManifestError) as error:
            raise RecipeIdentityError("Prepared Comfy Python runtime is unavailable") from error

    def current_attestation():
        try:
            expected_python_runtime_sha = current_python_runtime_sha()
            source_manifest.check()
            encoder_sha = delivery_encoder.check()
            private_model_paths.check()
            response = comfy_request(comfy_base, "/qs-h3/v1/source-attestation", {
                "schemaVersion": 1,
                "sourceManifestSha256": source_manifest.sha256,
                "classTypes": list(source_manifest.required_graph_class_types),
            })
            origins = response.get("classOrigins")
            if (response.get("schemaVersion") != 1 or
                    type(response.get("queueAdmissionGuardVersion")) is not int or
                    response["queueAdmissionGuardVersion"] != 1 or
                    response.get("sourceManifestSha256") != source_manifest.sha256 or
                    not isinstance(response.get("processToken"), str) or not response["processToken"] or
                    not isinstance(origins, list) or
                    not all(isinstance(row, dict) and
                            set(row) == {"classType", "moduleName", "classQualname", "moduleRelativePath",
                                         "sourceOrigin", "sourceRawSha256", "sourceSize",
                                         "methodRelativePath", "methodSourceRawSha256",
                                         "methodSourceSize"}
                            for row in origins) or
                    [row.get("classType") for row in origins] !=
                    list(source_manifest.required_graph_class_types)):
                raise RecipeIdentityError("Comfy source attestation response is incomplete")
            class_sha = response.get("classOriginSha256")
            comfy_ffmpeg_sha = response.get("ffmpegSha256")
            python_runtime_sha = response.get("pythonRuntimeSha256")
            if (not isinstance(class_sha, str) or not _SHA256.fullmatch(class_sha) or
                    not isinstance(comfy_ffmpeg_sha, str) or not _SHA256.fullmatch(comfy_ffmpeg_sha) or
                    not isinstance(python_runtime_sha, str) or
                    not hmac.compare_digest(python_runtime_sha, expected_python_runtime_sha)):
                raise RecipeIdentityError("Comfy class or encoder identity is invalid")
            origin_bytes = json.dumps(origins, ensure_ascii=False, sort_keys=True,
                                      separators=(",", ":"), allow_nan=False).encode("utf-8")
            if not hmac.compare_digest(hashlib.sha256(origin_bytes).hexdigest(), class_sha):
                raise RecipeIdentityError("Comfy class origin digest is invalid")
            result = {"processToken": response["processToken"],
                      "queueAdmissionGuardVersion": 1,
                      "sourceManifestSha256": source_manifest.sha256,
                      "classOriginSha256": class_sha,
                      "pythonRuntimeSha256": python_runtime_sha,
                      "comfyFfmpegSha256": comfy_ffmpeg_sha,
                      "deliveryFfmpegSha256": encoder_sha}
            if first_attestation is not None and result != first_attestation:
                raise RecipeIdentityError("Comfy or delivery runtime changed; restart and self-test")
            return result
        except RecipeIdentityError:
            raise
        except (OSError, ValueError, KeyError, TypeError, SourceManifestError) as error:
            raise RecipeIdentityError("Canonical runtime source attestation is unavailable") from error

    first_attestation = None
    first_attestation = current_attestation()
    os.environ.update(H3_COMFY_BASE=comfy_base, H3_COMFY_ROOT=str(root),
                      H3_ADAPTER_INPUT_ROOT=str(adapter_input_root),
                      H3_ADAPTER_OUTPUT_ROOT=str(adapter_output_root),
                      H3_JOBS_DIR=str(out / "jobs"), H3_INSTANCE="qs-new4-workbench-test")
    sys.path.insert(0, str(api_root))
    gateway = importlib.import_module("local_h3.app")
    comfy, jobs, workflows, schemas = gateway.comfy, gateway.jobs, gateway.workflows, gateway.schemas
    # Comfy may use a separately configured output directory. Do not infer it
    # from this workstation's drive letter or from the jobs metadata directory.
    comfy.OUT_ROOT = adapter_output_root
    def find_frames(entry):
        found = []
        for node_output in (entry.get("outputs") or {}).values():
            for item in node_output.get("images") or []:
                if (item.get("type") or "output") != "output":
                    continue
                name = item.get("filename") or ""
                if "_frame" not in name:
                    continue
                candidate = (output_root / (item.get("subfolder") or "") / name).resolve()
                if candidate.is_relative_to(output_root) and candidate.is_file():
                    found.append(str(candidate))
        return found
    comfy.find_frames = find_frames
    source_paths = {
        "adapter": Path(__file__),
        "graphBuilder": api_root / "workbench" / "graphs.py",
        "identity": Path(__file__).with_name("recipe_identity.py"),
        "runtimeAttestation": Path(__file__).with_name("runtime_attestation.py"),
        "comfyGraph": api_root / "local_h3" / "comfy.py",
        "gateway": api_root / "local_h3" / "app.py",
        "jobs": api_root / "local_h3" / "jobs.py",
        "gpuSlot": api_root / "gpu_slot.py",
        "schemas": api_root / "local_h3" / "schemas.py",
        "workflows": api_root / "local_h3" / "workflows.py",
    }
    if model_root is not None:
        source_paths.update({
            "comfyMain": model_root / "main.py",
            "comfyFolderPaths": model_root / "folder_paths.py",
            "comfyExecution": model_root / "execution.py",
            "comfyCaching": model_root / "comfy_execution" / "caching.py",
            "comfyCliArgs": model_root / "comfy" / "cli_args.py",
            "dualClockNode": model_root / "custom_nodes" / "h3_benchmark_sampler" / "__init__.py",
            "dualClockSampling": model_root / "custom_nodes" / "h3_benchmark_sampler" / "sampling.py",
            "dualClockCore": model_root / "custom_nodes" / "h3_benchmark_sampler" / "core.py",
            "h3ComfyNodes": model_root / "comfy_extras" / "nodes_minimax_h3.py",
            "sageNode": model_root / "custom_nodes" / "ComfyUI-KJNodes" / "nodes" / "model_optimization_nodes.py",
        })
        extra_paths = model_root / "extra_model_paths.yaml"
        if extra_paths.is_file():
            source_paths["comfyExtraModelPaths"] = extra_paths

    source_snapshot = {}
    for role, source in source_paths.items():
        source_snapshot[role] = hashlib.sha256(Path(source).read_bytes()).hexdigest()
    initial_identity = build_identity(api_root, model_root, source_paths,
                                      source_manifest_sha256=source_manifest.sha256,
                                      class_origin_sha256=first_attestation["classOriginSha256"],
                                      output_root=output_root, force_hash=True)

    def runtime_identity():
        try:
            current_python_runtime_sha()
            interpreter_sha = comfy_python_binary.check()
            base_sha = base_python_binary.check()
            result = measure_comfy_runtime(
                comfy_base, model_root, input_root, output_root,
                comfy_python_binary.path, comfy_python_binary.first_generation,
                interpreter_sha, base_python_binary.path,
                base_python_binary.first_generation, base_sha)
            if (comfy_python_binary.check() != interpreter_sha or
                    base_python_binary.check() != base_sha):
                raise RecipeIdentityError("Comfy Python interpreter changed during process check")
            current_python_runtime_sha()
            return result
        except (ComfyRuntimeError, SourceManifestError) as error:
            raise RecipeIdentityError(str(error)) from error

    api_process_private = {
        "bootNonce": secrets.token_hex(32),
        "pid": os.getpid(),
        "bootNs": int(psutil.Process(os.getpid()).create_time() * 1_000_000_000),
    }
    first_owner_runtime_identity = None

    def current_owner_runtime_identity():
        try:
            config_sha = owner_config_file.check()
            model_paths_sha = private_model_paths.check()
            if model_paths_sha is None:
                raise RecipeIdentityError("H3 private model-path configuration is unavailable")
            comfy_token, _boot_ns = runtime_identity()
            identity = owner_runtime_identity(config_sha, model_paths_sha, api_process_private,
                                              comfy_token, current_attestation())
            if (first_owner_runtime_identity is not None and
                    identity != first_owner_runtime_identity):
                raise RecipeIdentityError("H3 owner runtime changed; restart and self-test")
            return identity
        except SourceManifestError as error:
            raise RecipeIdentityError("H3 owner runtime configuration is unavailable") from error

    first_owner_runtime_identity = current_owner_runtime_identity()

    def current_identity(*, force_hash=False):
        if model_root is None or not model_root.is_absolute():
            raise RecipeIdentityError("H3_COMFY_MODEL_ROOT is not configured")
        _runtime_token, boot_ns = runtime_identity()
        attestation = current_attestation()
        try:
            for role, source in source_paths.items():
                if hashlib.sha256(Path(source).read_bytes()).hexdigest() != source_snapshot[role]:
                    raise RecipeIdentityError("Loaded H3 recipe source changed; restart adapter")
                loaded_by_comfy = role in {"comfyMain", "comfyFolderPaths", "comfyExecution",
                                           "comfyCaching", "comfyCliArgs", "comfyExtraModelPaths",
                                           "dualClockNode", "dualClockSampling", "dualClockCore",
                                           "h3ComfyNodes", "sageNode"}
                if loaded_by_comfy and Path(source).stat().st_mtime_ns > boot_ns:
                    raise RecipeIdentityError("Comfy recipe source changed after its process started")
        except OSError as error:
            raise RecipeIdentityError("Loaded H3 recipe source is unavailable") from error
        measured = build_identity(api_root, model_root, source_paths,
                                  source_manifest_sha256=attestation["sourceManifestSha256"],
                                  class_origin_sha256=attestation["classOriginSha256"],
                                  output_root=output_root, force_hash=force_hash)
        if measured.model_sha256 != initial_identity.model_sha256:
            raise RecipeIdentityError("H3 model bytes changed; restart Comfy and adapter")
        if any(mtime > boot_ns for mtime in measured.model_asset_mtime_ns.values()):
            raise RecipeIdentityError("H3 model changed after Comfy started; restart Comfy")
        return measured
    workflows.WF_DIR = out / "workflows"
    workflows.WF_DIR.mkdir(parents=True, exist_ok=True)
    workflows.BUILTINS = {workflow: {"id": workflow, "kind": "builtin", **recipe_metadata(workflow),
                                    "label": (f"Unverified base{spec.steps} flash/cell / full INT8 / no LoRA / 768p / Sage"
                                              if workflow in BASE_WORKFLOWS else
                                              f"Experimental new{spec.steps} / INT8 / 768p / T8 6:3 / Sage")}
                         for workflow, spec in PROFILE_SPECS.items()}
    original_create, original_view, original_copy = jobs.create_job, schemas.gateway_job_view, comfy.copy_output
    original_submit = comfy.submit_graph
    original_health = gateway._health_payload

    def health_payload():
        result = original_health()
        result.update(quant="full-int8", presets=["landscape_C"], workflows=list(PROFILE_SPECS),
                      model_profiles=model_profiles(comfy.TURBO4_MODEL),
                      realtime={"sse": "/v1/jobs/{id}/events", "progress": "/v1/jobs/{id}/progress"},
                      sage_workflow=WORKFLOW)
        result.pop("legacy_submit", None)
        return result

    gateway._health_payload = health_payload

    def new_job(req):
        attested = _submission_identity.get()
        req = normalize_attested_gateway_job(req, attested)
        verify_owner_runtime_witness(attested["ownerRuntimeWitnessSha256"],
                                     current_owner_runtime_identity())
        current_attestation()
        spec = spec_for_job(req)
        req = {**req, "width": spec.width, "height": spec.height, "model": spec.model or comfy.TURBO4_MODEL}
        if req["seconds"] == 5:
            req["save_frames"] = sorted(set(req.get("save_frames") or []) | {0, 119, 123})
        job = original_create(req)
        job["fed"] = fed_profile(job)
        # start_worker() runs in another thread. Persist verified values before
        # the gateway can launch it; never use a process-global slot.
        job["recipe_identity"] = {
            "schemaVersion": "qs.h3.job-identity.canonical-vnext",
            "expected": attested["expected"],
            "ownerRuntimeWitnessSha256": attested["ownerRuntimeWitnessSha256"],
            "ownerRuntimeAtQueue": attested["ownerRuntimeAtQueue"],
            "firstFrameSha256": attested["firstFrameSha256"],
            "negativeSha256": attested["negativeSha256"],
            "checkedAtQueue": attested["checkedAtQueue"],
            "comfyRuntimeToken": attested["comfyRuntimeToken"],
            "sourceAttestationAtQueue": attested["sourceAttestationAtQueue"],
        }
        jobs.save_job(job)
        return job

    def prompt_graph(job):
        attested = job.get("recipe_identity")
        if not isinstance(attested, dict) or attested.get("schemaVersion") != "qs.h3.job-identity.canonical-vnext":
            raise RecipeIdentityError("H3_EXPECTED_IDENTITY_REQUIRED")
        verify_owner_runtime_witness(attested.get("ownerRuntimeWitnessSha256"),
                                     current_owner_runtime_identity())
        spec = spec_for_job(job)
        graph, recipe = build(api_root, spec, job["seed"],
                              f"MiniMax_H3/LocalAPI/{job['id']}/out", job.get("first_frame_rel"),
                              frames=job["length"], prompt=job["prompt_full"],
                              save_frames=job["save_frames"], last_reference=job.get("last_frame_rel"),
                              identity_references=job.get("identity_frame_rels"))
        graph_classes = sorted({node.get("class_type") for node in graph.values() if isinstance(node, dict)})
        if graph_classes != list(source_manifest.required_graph_class_types):
            raise RecipeIdentityError("Actual qs_new4 graph class set differs from the canonical manifest")
        if attested is not None:
            if current_attestation() != attested.get("sourceAttestationAtQueue"):
                raise RecipeIdentityError("Canonical runtime changed after queue receipt")
            token, _boot_ns = runtime_identity()
            if not hmac.compare_digest(token, attested["comfyRuntimeToken"]):
                raise RecipeIdentityError("Comfy process changed before submit")
            negative = job.get("negative") or ""
            full = job["prompt"].rstrip() + ("\n\nNegative: " + negative if negative else "")
            if job.get("prompt_full") != full:
                raise RecipeIdentityError("The fixed negative prompt changed")
            negative_sha = hashlib.sha256(negative.encode("utf-8")).hexdigest()
            if not hmac.compare_digest(negative_sha, attested["negativeSha256"]):
                raise RecipeIdentityError("The fixed negative prompt changed")
            relative = job.get("first_frame_rel")
            if not isinstance(relative, str) or not relative:
                raise RecipeIdentityError("The fixed first frame is missing")
            first_path = (input_root / relative).resolve(strict=True)
            if not first_path.is_relative_to(input_root) or not first_path.is_file():
                raise RecipeIdentityError("The fixed first frame escaped Comfy input")
            if not 8 < first_path.stat().st_size <= 16 * 1024 * 1024:
                raise RecipeIdentityError("The fixed first frame is invalid")
            first_bytes = first_path.read_bytes()
            if not first_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
                raise RecipeIdentityError("The fixed first frame is invalid")
            first_sha = hashlib.sha256(first_bytes).hexdigest()
            if not hmac.compare_digest(first_sha, attested["firstFrameSha256"]):
                raise RecipeIdentityError("The fixed first frame changed after submit")
            identity = current_identity(force_hash=True)
            token, _boot_ns = runtime_identity()
            if not hmac.compare_digest(token, attested["comfyRuntimeToken"]):
                raise RecipeIdentityError("Comfy process changed during recipe check")
            actual = identity.identity_for(first_sha, negative_sha)
            verify_actual_graph(graph, identity.graph_sha256)
            if any(not hmac.compare_digest(actual[key], attested["expected"][key])
                   for key in ("executionRecipeSha256", "modelSha256")):
                raise RecipeIdentityError("The measured recipe or model changed before Comfy submit")
            attested["actualBeforeComfySubmit"] = {
                **actual,
                "sourceAttestation": current_attestation(),
                "graphInstanceSha256": hashlib.sha256(json.dumps(
                    graph, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                ).encode("utf-8")).hexdigest(),
                "comfyAcceptedGraphSha256": comfy_accepted_graph_sha256(graph),
            }
        folder = jobs.JOBS_DIR / job["id"]
        for name, value in (("graph.json", graph), ("recipe.json", recipe)):
            (folder / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        job["fed"] = fed_profile(job)
        jobs.save_job(job)
        _ready_graph.set({"sha256": attested["actualBeforeComfySubmit"]["graphInstanceSha256"],
                          "jobId": job["id"], "expected": attested["expected"],
                          "ownerRuntimeWitnessSha256": attested["ownerRuntimeWitnessSha256"]})
        return graph

    def controlled_submit_graph(graph, client_id="local-h3-api"):
        ready = _ready_graph.get()
        _ready_graph.set(None)
        if not isinstance(ready, dict) or client_id != f"h3api-{ready.get('jobId')}":
            raise RecipeIdentityError("H3 graph has no validated job submission")
        digest = hashlib.sha256(json.dumps(graph, ensure_ascii=False, sort_keys=True,
                                           separators=(",", ":")).encode("utf-8")).hexdigest()
        if not hmac.compare_digest(digest, ready["sha256"]):
            raise RecipeIdentityError("H3 graph changed between validation and Comfy submit")
        verify_owner_runtime_witness(ready.get("ownerRuntimeWitnessSha256"),
                                     current_owner_runtime_identity())
        current = current_identity(force_hash=True).public_identity()
        if any(not hmac.compare_digest(current[key], ready["expected"][key])
               for key in ("executionRecipeSha256", "modelSha256")):
            raise RecipeIdentityError("H3 expected recipe changed before Comfy accepted the job")
        accepted_process = current_attestation()["processToken"]
        return original_submit(graph, client_id=client_id,
                               qs_h3_expected_process_token=accepted_process)

    def copy_delivery(src, jid, filename):
        source = Path(src).resolve(strict=True)
        if not source.is_relative_to(output_root):
            raise RecipeIdentityError("Comfy output is outside the configured output root")
        job = jobs.load_job(jid)
        attested = job.get("recipe_identity")
        if not isinstance(attested, dict) or not attested.get("actualBeforeComfySubmit"):
            raise RecipeIdentityError("H3 job has no actual pre-GPU identity")
        verify_owner_runtime_witness(attested.get("ownerRuntimeWitnessSha256"),
                                     current_owner_runtime_identity())
        if attested is not None:
            token, _boot_ns = runtime_identity()
            if not hmac.compare_digest(token, attested["comfyRuntimeToken"]):
                raise RecipeIdentityError("Comfy process changed during render")
            post = current_identity(force_hash=True).identity_for(
                attested["firstFrameSha256"], attested["negativeSha256"])
            before = attested.get("actualBeforeComfySubmit") or {}
            if any(not hmac.compare_digest(post[key], before.get(key, ""))
                   for key in ("executionRecipeSha256", "modelSha256")):
                raise RecipeIdentityError("H3 recipe or model changed during render")
            generation = verify_model_load_history(
                comfy_base, job["comfy_prompt_id"], before["comfyAcceptedGraphSha256"],
                token, post["modelSha256"])
            end_token, _boot_ns = runtime_identity()
            if not hmac.compare_digest(end_token, token):
                raise RecipeIdentityError("Comfy process changed during load-generation check")
            attested["actualAfterComfySubmit"] = {
                **post, "graphInstanceSha256": before["graphInstanceSha256"],
                "comfyAcceptedGraphSha256": before["comfyAcceptedGraphSha256"],
                "comfyModelLoadGenerationSha256": generation,
                "sourceAttestation": current_attestation(),
            }
            jobs.save_job(job)
        copied = original_copy(src, jid, filename)
        if job["seconds"] == 5 and filename == "result.mp4":
            raw = jobs.JOBS_DIR / jid / "raw-124-frames.mp4"
            shutil.copy2(copied, raw)
            delivery = copied.with_name("delivery-120-frames.mp4")
            trim_delivery(raw, delivery, ffmpeg)
            return delivery
        return copied

    def final_attestation_check(job, delivered_file):
        """Run after final trim/copy and frame collection, before status=done."""
        attested = job.get("recipe_identity")
        if not isinstance(attested, dict) or not attested.get("actualAfterComfySubmit"):
            raise RecipeIdentityError("H3 final delivery lacks the measured recipe")
        verify_owner_runtime_witness(attested.get("ownerRuntimeWitnessSha256"),
                                     current_owner_runtime_identity())
        token, _boot_ns = runtime_identity()
        if not hmac.compare_digest(token, attested["comfyRuntimeToken"]):
            raise RecipeIdentityError("Comfy process changed before delivery")
        post = current_identity(force_hash=True).identity_for(
            attested["firstFrameSha256"], attested["negativeSha256"])
        if any(not hmac.compare_digest(post[key], attested["expected"][key])
               for key in ("executionRecipeSha256", "modelSha256")):
            raise RecipeIdentityError("H3 recipe changed before final delivery")
        if any(not hmac.compare_digest(post[key], attested["actualAfterComfySubmit"][key])
               for key in ("executionRecipeSha256", "modelSha256", "sourceManifestSha256",
                           "classOriginSha256")):
            raise RecipeIdentityError("H3 measured runtime changed before final delivery")
        media = jobs.JOBS_DIR / job["id"] / "result.mp4"
        if Path(delivered_file) != media:
            raise RecipeIdentityError("H3 final media path differs from the fixed job output")
        try:
            media_bytes, _generation = _checked_bytes(media, media, max_bytes=16 * 1024 * 1024)
        except SourceManifestError as error:
            raise RecipeIdentityError("H3 final media physical identity is unavailable") from error
        if not media_bytes:
            raise RecipeIdentityError("H3 final media is empty")
        attested["actualAfterFinalDelivery"] = {
            **post,
            "sourceAttestation": current_attestation(),
            "ownerRuntimeWitnessSha256": attested["ownerRuntimeWitnessSha256"],
            "deliverySize": len(media_bytes),
            "deliverySha256": hashlib.sha256(media_bytes).hexdigest(),
        }
        job["recipe_identity"] = attested

    def verified_video_bytes(jid, job):
        return read_receipted_video_bytes(jobs.JOBS_DIR, jid, job)

    def view(job, request=None):
        result = {**original_view(job, request), "fed": job.get("fed")}
        attested = job.get("recipe_identity")
        if attested is not None:
            completed = (job.get("status") == "done" and bool(job.get("video"))
                         and bool(job.get("comfy_prompt_id"))
                         and isinstance(attested.get("ownerRuntimeWitnessSha256"), str)
                         and bool(attested.get("actualAfterFinalDelivery"))
                         and (attested["actualAfterFinalDelivery"].get("ownerRuntimeWitnessSha256") ==
                              attested["ownerRuntimeWitnessSha256"]))
            actual = attested.get("actualAfterFinalDelivery") or {}
            result["recipe_identity"] = {
                "schemaVersion": attested["schemaVersion"],
                "expected": attested["expected"],
                "ownerRuntimeWitnessSha256": attested.get("ownerRuntimeWitnessSha256"),
                "actual": {key: actual[key] for key in (
                    "executionRecipeSha256", "modelSha256", "modelSetSha256",
                     "sourceManifestSha256", "classOriginSha256",
                     "ownerRuntimeWitnessSha256", "deliverySha256", "deliverySize")} if completed else None,
                "attested": completed,
            }
            if completed:
                result["comfy_model_load_generation_sha256"] = (
                    attested["actualAfterComfySubmit"]["comfyModelLoadGenerationSha256"])
                result["recipe_identity"]["actual"].update({
                    "comfyFfmpegSha256": actual["sourceAttestation"]["comfyFfmpegSha256"],
                    "deliveryFfmpegSha256": actual["sourceAttestation"]["deliveryFfmpegSha256"],
                })
        return result

    original_claim_gpu = jobs._claim_h3_gpu

    def claim_idle():
        q = comfy.comfy_queue()
        if q.get("running") or q.get("pending"):
            raise RuntimeError("Comfy queue became busy; no competing submission")
        lease = original_claim_gpu()
        try:
            q = comfy.comfy_queue()
            if q.get("running") or q.get("pending"):
                raise RuntimeError("Comfy queue became busy after GPU slot claim")
            return lease
        except Exception:
            lease.__exit__(None, None, None)
            raise

    jobs.create_job, workflows.build_prompt_graph = new_job, prompt_graph
    comfy.submit_graph = controlled_submit_graph
    jobs._final_attestation_check = final_attestation_check
    gateway.app.state.verified_video_bytes = verified_video_bytes
    comfy.copy_output, schemas.gateway_job_view = copy_delivery, view
    jobs._claim_h3_gpu = claim_idle
    from fastapi.responses import JSONResponse
    lock = asyncio.Lock()

    @gateway.app.get("/v1/recipes/qs_new4/identity")
    def get_qs_new4_identity():
        try:
            current = current_identity()
            bound = current.public_identity()
        except RecipeIdentityError:
            return JSONResponse({"error": "H3_RECIPE_IDENTITY_UNAVAILABLE"}, status_code=503)
        return JSONResponse({
            "schemaVersion": "qs.h3.recipe-identity.canonical-vnext",
            "workflow": WORKFLOW,
            "recipeVersion": CATALOG_VERSION,
            "graphTemplateSha256": current.graph_sha256,
            **bound,
            "weightSha256ByRole": dict(current.model_asset_sha256),
        }, headers={"Cache-Control": "no-store"})

    @gateway.app.get("/v1/owner-runtime/identity")
    def get_owner_runtime_identity():
        try:
            current = current_owner_runtime_identity()
        except RecipeIdentityError:
            return JSONResponse({"error": "H3_OWNER_RUNTIME_UNAVAILABLE"}, status_code=503)
        return JSONResponse(current, headers={"Cache-Control": "no-store"})

    @gateway.app.middleware("http")
    async def integration_guard(request, call_next):
        if request.client.host not in ("127.0.0.1", "::1") or request.headers.get("origin"):
            return JSONResponse({"error": "Local server-to-server integration only"}, status_code=403)
        path = request.url.path
        if path in ("/v1/recipes/qs_new4/identity", "/v1/owner-runtime/identity"):
            if request.method != "GET":
                return JSONResponse({"error": "Mutation disabled"}, status_code=405)
            return await call_next(request)
        if not re.fullmatch(r"/(health|v1/(spec|workflows|jobs(?:/[A-Za-z0-9_-]+(?:/(?:progress|events|video|cancel|frames(?:/\d+)?))?)?))", path):
            return JSONResponse({"error": "Route disabled in isolated test node"}, status_code=404)
        if request.method == "GET" and path == "/v1/spec":
            return JSONResponse(production_spec(str(request.base_url).rstrip("/")))
        if request.method == "POST" and path == "/v1/jobs":
            async with lock:
                if any(j.get("status") in ("running", "queued") for j in jobs.list_jobs(limit=100)):
                    return JSONResponse({"error": "Node worker busy"}, status_code=409)
                try:
                    raw = await request.body()
                    if len(raw) > 32 * 1024 * 1024:
                        raise ValueError("Request exceeds limit")
                    body = json.loads(raw)
                    attested = validate_payload(body)
                except (ValueError, TypeError) as error:
                    return JSONResponse({"error": str(error)}, status_code=400)
                try:
                    comfy_token, _boot_ns = runtime_identity()
                    owner_runtime = current_owner_runtime_identity()
                    current = await asyncio.to_thread(current_identity)
                    actual = current.identity_for(attested["firstFrameSha256"], attested["negativeSha256"])
                except RecipeIdentityError:
                    return JSONResponse({"error": "H3_RECIPE_IDENTITY_UNAVAILABLE"}, status_code=503)
                if not hmac.compare_digest(owner_runtime["ownerRuntimeWitnessSha256"],
                                           attested["ownerRuntimeWitnessSha256"]):
                    return JSONResponse({"error": "H3_OWNER_RUNTIME_WITNESS_MISMATCH"}, status_code=409)
                if any(not hmac.compare_digest(actual[key], attested["expected"][key])
                       for key in ("executionRecipeSha256", "modelSha256")):
                    return JSONResponse({"error": "H3_RECIPE_IDENTITY_MISMATCH"}, status_code=409)
                attested["checkedAtQueue"] = actual
                attested["ownerRuntimeAtQueue"] = owner_runtime
                attested["comfyRuntimeToken"] = comfy_token
                attested["sourceAttestationAtQueue"] = current_attestation()
                token = _submission_identity.set(attested)
                try:
                    return await call_next(request)
                finally:
                    _submission_identity.reset(token)
        if request.method not in ("GET", "HEAD") and not (request.method == "POST" and path.endswith("/cancel")):
            return JSONResponse({"error": "Mutation disabled"}, status_code=405)
        return await call_next(request)
    jobs._CONTROLLED_ADAPTER_ENABLED = True
    gateway.app.state.qs_new4_controlled = True
    return gateway.app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-root", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--listen-port", type=int, required=True)
    parser.add_argument("--serve-authorized-test", action="store_true", required=True)
    args = parser.parse_args()
    if not 1 <= args.listen_port <= 65535:
        raise RuntimeError("Explicit loopback listen port is invalid")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg required for exact five-second delivery")
    from runner import idle, verify_sources
    verify_sources(args.root)
    comfy_base = (os.environ.get("H3_COMFY_BASE") or "").strip()
    if not re.fullmatch(r"http://(?:127\.0\.0\.1|\[::1\]):[0-9]{2,5}", comfy_base):
        raise RuntimeError("H3_COMFY_BASE must be explicitly configured as loopback HTTP")
    if not idle(comfy_base):
        raise RuntimeError("Comfy is busy")
    verify_required_object_info(comfy_base)
    args.out.mkdir(parents=True, exist_ok=True)
    lockfile = args.out / "canonical-adapter.lock"
    with lockfile.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps({"pid": os.getpid(), "owner": "workbench-qs-new4", "out": str(args.out)}))
    try:
        import uvicorn
        uvicorn.run(create_app(args.api_root, args.root, args.out, ffmpeg, args.listen_port),
                    host="127.0.0.1", port=args.listen_port)
    finally:
        lockfile.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
