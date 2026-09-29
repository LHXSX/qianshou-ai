"""Opt-in new4/new8 recipes and unverified base12/base28 sampling comparisons.

Reuses the installed job, reference, progress and media handlers in one isolated
process; it does not edit the installed gateway or advertise legacy workflows.
"""
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
import shutil
import subprocess
import sys

from graphs import SPECS, build
from recipe_identity import RecipeIdentityError, build_identity, verify_actual_graph
from runtime_attestation import (ComfyRuntimeError, comfy_accepted_graph_sha256,
                                 measure_comfy_runtime, verify_model_load_history)

WORKFLOW = "qs_new4"
SPEC = SPECS["E_light4_sage"]
PROFILE_SPECS = {WORKFLOW: SPEC, "qs_new8": SPECS["F_light8_sage"],
                 "qs_base12": SPECS["I_base12_sage"], "qs_base28": SPECS["J_base28_sage"]}
BASE_WORKFLOWS = frozenset(("qs_base12", "qs_base28"))
FLASH_FRAMES = (7, 22, 36, 51, 65)
PROFILE_SECONDS = {workflow: (3, 5) for workflow in PROFILE_SPECS}
CATALOG_VERSION = "1.0.0-rc.1"
_submission_identity = ContextVar("h3_submission_identity", default=None)
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
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
        raise ValueError("Only 3-second flash or 5-second cells are admitted")
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
    return {
        "name": "Qianshou H3 four-profile node adapter",
        "version": "0.1.0-test.20260909",
        "catalogVersion": CATALOG_VERSION,
        "machine": "5080",
        "output": {"width": 1344, "height": 768, "fps": 24,
                   "rawFrames5s": 124, "deliveryFrames5s": 120},
        "flashContract": FLASH_CONTRACT,
        "modelProfiles": model_profiles("minimax_h3_fl2va_int8_convrot.safetensors"),
        "jobs": {
            "submit": {
                "method": "POST", "path": "/v1/jobs", "url": f"{base_url}/v1/jobs",
                "allowedFields": ["prompt", "negative", "preset", "workflow", "seconds",
                                  "steps", "seed", "save_frames", "ref_images", "expected"],
                "requiresExplicitSeed": True,
                "requiresFirstFrameForCell": True,
            },
            "recipeIdentity": {"method": "GET", "path": "/v1/recipes/qs_new4/identity",
                               "query": ["firstFrameSha256", "negativeSha256"]},
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
            "version": "0.1.0-test.20260908"}


def attested_request(body):
    """Accept only the fixed five-second, single-PNG native binding."""
    expected = body.get("expected")
    if expected is None:
        return None
    if not isinstance(expected, dict) or set(expected) != {"executionRecipeSha256", "modelSha256"}:
        raise ValueError("H3_EXPECTED_IDENTITY_INVALID")
    if any(not isinstance(value, str) or not _SHA256.fullmatch(value)
           for value in expected.values()):
        raise ValueError("H3_EXPECTED_IDENTITY_INVALID")
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
        "firstFrameSha256": hashlib.sha256(frame).hexdigest(),
        "negativeSha256": hashlib.sha256(negative.encode("utf-8")).hexdigest(),
    }


def validate_payload(body):
    if not isinstance(body, dict):
        raise ValueError("Object required")
    if body.get("seconds") not in (3, 5) or isinstance(body.get("seconds"), bool):
        raise ValueError("Only 3-second flash or 5-second cells are admitted")
    expected = profile(body["seconds"], body.get("workflow"))
    if any(body.get(k) != v for k, v in expected.items()):
        raise ValueError("Explicit matching workflow profile required; no fallback")
    allowed = set(profile(3)) | {"prompt", "negative", "seed", "save_frames", "expected",
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


def trim_delivery(source, destination, ffmpeg):
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
               "-i", str(source), "-map", "0:v:0", "-map", "0:a:0",
               "-vf", "trim=end_frame=120,setpts=PTS-STARTPTS",
               "-af", "atrim=end=5,asetpts=PTS-STARTPTS", "-c:v", "libx264",
               "-preset", "fast", "-crf", "14", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-movflags", "+faststart", str(destination)]
    subprocess.run(command, check=True, capture_output=True, timeout=120)


def create_app(api_root, root, out, ffmpeg):
    comfy_base = os.environ.get("H3_COMFY_BASE", "http://127.0.0.1:8189")
    if not re.fullmatch(r"http://(?:127\.0\.0\.1|\[::1\]):[0-9]{2,5}", comfy_base):
        raise RecipeIdentityError("H3_COMFY_BASE must be loopback HTTP")
    adapter_output_value = os.environ.get("H3_ADAPTER_OUTPUT_ROOT")
    adapter_output_root = (Path(adapter_output_value) if adapter_output_value
                           else root / "output" / "MiniMax_H3" / "LocalAPI")
    if not adapter_output_root.is_absolute():
        raise RecipeIdentityError("H3_ADAPTER_OUTPUT_ROOT must be absolute")
    adapter_output_root = adapter_output_root.resolve(strict=True)
    if adapter_output_root.name != "LocalAPI" or adapter_output_root.parent.name != "MiniMax_H3":
        raise RecipeIdentityError("H3_ADAPTER_OUTPUT_ROOT must be the qs_new4 result directory")
    output_root = adapter_output_root.parent.parent
    os.environ.update(H3_COMFY_BASE=comfy_base, H3_COMFY_ROOT=str(root),
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
    model_root_value = os.environ.get("H3_COMFY_MODEL_ROOT", "")
    model_root = Path(model_root_value) if model_root_value else None
    source_paths = {
        "adapter": Path(__file__),
        "graphBuilder": api_root / "workbench" / "graphs.py",
        "identity": Path(__file__).with_name("recipe_identity.py"),
        "runtimeAttestation": Path(__file__).with_name("runtime_attestation.py"),
        "comfyGraph": api_root / "local_h3" / "comfy.py",
        "gateway": api_root / "local_h3" / "app.py",
        "jobs": api_root / "local_h3" / "jobs.py",
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
    initial_identity = (build_identity(api_root, model_root, source_paths,
                                       output_root=output_root, force_hash=True)
                        if model_root is not None and model_root.is_absolute() else None)

    def runtime_identity():
        try:
            return measure_comfy_runtime(comfy_base, model_root, root / "input", output_root)
        except ComfyRuntimeError as error:
            raise RecipeIdentityError(str(error)) from error

    def current_identity(*, force_hash=False):
        if model_root is None or not model_root.is_absolute():
            raise RecipeIdentityError("H3_COMFY_MODEL_ROOT is not configured")
        _runtime_token, boot_ns = runtime_identity()
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
        spec = spec_for_job(req)
        req = {**req, "width": spec.width, "height": spec.height, "model": spec.model or comfy.TURBO4_MODEL}
        if req["seconds"] == 5:
            req["save_frames"] = sorted(set(req.get("save_frames") or []) | {0, 119, 123})
        job = original_create(req)
        job["fed"] = fed_profile(job)
        attested = _submission_identity.get()
        if attested is not None:
            # start_worker() runs in another thread. Persist the checked values
            # before the gateway can launch it; never use a process-global slot.
            job["recipe_identity"] = {
                "schemaVersion": "qs.h3.job-identity.v1",
                "expected": attested["expected"],
                "firstFrameSha256": attested["firstFrameSha256"],
                "negativeSha256": attested["negativeSha256"],
                "checkedAtQueue": attested["checkedAtQueue"],
                "comfyRuntimeToken": attested["comfyRuntimeToken"],
            }
        jobs.save_job(job)
        return job

    def prompt_graph(job):
        spec = spec_for_job(job)
        graph, recipe = build(api_root, spec, job["seed"],
                              f"MiniMax_H3/LocalAPI/{job['id']}/out", job.get("first_frame_rel"),
                              frames=job["length"], prompt=job["prompt_full"],
                              save_frames=job["save_frames"], last_reference=job.get("last_frame_rel"),
                              identity_references=job.get("identity_frame_rels"))
        attested = job.get("recipe_identity")
        if attested is not None:
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
            input_root = (root / "input").resolve(strict=True)
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
        return graph

    def copy_delivery(src, jid, filename):
        source = Path(src).resolve(strict=True)
        if not source.is_relative_to(output_root):
            raise RecipeIdentityError("Comfy output is outside the configured output root")
        job = jobs.load_job(jid)
        attested = job.get("recipe_identity")
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

    def view(job, request=None):
        result = {**original_view(job, request), "fed": job.get("fed")}
        attested = job.get("recipe_identity")
        if attested is not None:
            completed = (job.get("status") == "done" and bool(job.get("video"))
                         and bool(job.get("comfy_prompt_id"))
                         and bool(attested.get("actualAfterComfySubmit")))
            actual = attested.get("actualAfterComfySubmit") or {}
            result["recipe_identity"] = {
                "schemaVersion": attested["schemaVersion"],
                "expected": attested["expected"],
                "actual": {key: actual[key] for key in (
                    "executionRecipeSha256", "modelSha256", "modelSetSha256",
                    "graphInstanceSha256")} if completed else None,
                "attested": completed,
            }
            if completed:
                result["comfy_model_load_generation_sha256"] = actual["comfyModelLoadGenerationSha256"]
        return result

    def claim_idle():
        q = comfy.comfy_queue()
        if q.get("running") or q.get("pending"):
            raise RuntimeError("Comfy queue became busy; no competing submission")

    jobs.create_job, workflows.build_prompt_graph = new_job, prompt_graph
    comfy.copy_output, schemas.gateway_job_view = copy_delivery, view
    jobs._claim_h3_gpu = claim_idle
    from fastapi.responses import JSONResponse
    lock = asyncio.Lock()

    @gateway.app.get("/v1/recipes/qs_new4/identity")
    def get_qs_new4_identity(firstFrameSha256: str, negativeSha256: str):
        try:
            current = current_identity()
            bound = current.identity_for(firstFrameSha256, negativeSha256)
        except RecipeIdentityError:
            return JSONResponse({"error": "H3_RECIPE_IDENTITY_UNAVAILABLE"}, status_code=503)
        return JSONResponse({
            "schemaVersion": "qs.h3.recipe-identity.v1",
            "workflow": WORKFLOW,
            "recipeVersion": CATALOG_VERSION,
            "graphTemplateSha256": current.graph_sha256,
            "builderSourceSha256": current.source_sha256,
            "firstFrameSha256": firstFrameSha256,
            "negativeSha256": negativeSha256,
            **bound,
            "weightSha256ByRole": dict(current.model_asset_sha256),
        }, headers={"Cache-Control": "no-store"})

    @gateway.app.middleware("http")
    async def integration_guard(request, call_next):
        if request.client.host not in ("127.0.0.1", "::1") or request.headers.get("origin"):
            return JSONResponse({"error": "Local server-to-server integration only"}, status_code=403)
        path = request.url.path
        if path == "/v1/recipes/qs_new4/identity":
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
                if attested is None:
                    return await call_next(request)
                try:
                    comfy_token, _boot_ns = runtime_identity()
                    current = await asyncio.to_thread(current_identity)
                    actual = current.identity_for(attested["firstFrameSha256"], attested["negativeSha256"])
                except RecipeIdentityError:
                    return JSONResponse({"error": "H3_RECIPE_IDENTITY_UNAVAILABLE"}, status_code=503)
                if any(not hmac.compare_digest(actual[key], attested["expected"][key])
                       for key in ("executionRecipeSha256", "modelSha256")):
                    return JSONResponse({"error": "H3_RECIPE_IDENTITY_MISMATCH"}, status_code=409)
                attested["checkedAtQueue"] = actual
                attested["comfyRuntimeToken"] = comfy_token
                token = _submission_identity.set(attested)
                try:
                    return await call_next(request)
                finally:
                    _submission_identity.reset(token)
        if request.method not in ("GET", "HEAD") and not (request.method == "POST" and path.endswith("/cancel")):
            return JSONResponse({"error": "Mutation disabled"}, status_code=405)
        return await call_next(request)
    return gateway.app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-root", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--serve-authorized-test", action="store_true", required=True)
    args = parser.parse_args()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg required for exact five-second delivery")
    from runner import idle, request, verify_sources
    verify_sources(args.root)
    comfy_base = os.environ.get("H3_COMFY_BASE", "http://127.0.0.1:8189")
    if not idle(comfy_base):
        raise RuntimeError("Comfy is busy")
    info = request(comfy_base, "/object_info")
    required = {"QSH3BenchmarkDualClock", "MiniMaxH3ImageToVideo", "PathchSageAttentionKJ"}
    if not required.issubset(info):
        raise RuntimeError("Measured runtime nodes are missing")
    args.out.mkdir(parents=True, exist_ok=True)
    fingerprints = {name: hashlib.sha256((args.api_root / "local_h3" / name).read_bytes()).hexdigest()
                    for name in ("app.py", "jobs.py", "schemas.py", "workflows.py", "comfy.py")}
    (args.out / "source-fingerprints.json").write_text(json.dumps(fingerprints, indent=2), encoding="utf-8")
    lockfile = args.root / "benchmark.lock"
    with lockfile.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps({"pid": os.getpid(), "owner": "workbench-qs-new4", "out": str(args.out)}))
    try:
        import uvicorn
        uvicorn.run(create_app(args.api_root, args.root, args.out, ffmpeg), host="127.0.0.1", port=8790)
    finally:
        lockfile.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
