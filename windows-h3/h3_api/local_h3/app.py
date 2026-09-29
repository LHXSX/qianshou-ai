"""Local MiniMax-H3 HTTP API (wraps ComfyUI on :8188)."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import pathlib
import urllib.request
from typing import Any, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import comfy, events, jobs, schemas, workflows

app = FastAPI(
    title="Local MiniMax H3 API",
    version="1.6.0",
    description="Submit T2VA/I2VA/FL2VA jobs to local ComfyUI MiniMax-H3 with gateway-compatible /v1/jobs. CLIP identity_1/2/3 lock any appearance (face / full-body / prop). save_frames extracts stills in the same Comfy graph (no ffmpeg).",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.state.qs_new4_controlled = False
app.state.verified_video_bytes = None


@app.middleware("http")
async def require_controlled_adapter(request: Request, call_next):
    if not app.state.qs_new4_controlled:
        return JSONResponse({"error": "QS_NEW4_CONTROLLED_ADAPTER_REQUIRED"}, status_code=503)
    return await call_next(request)


class GenerateBody(BaseModel):
    prompt: str = Field(..., description="H3 multimodal prompt text")
    negative: Optional[str] = None
    preset: str = Field("turbo4", description="turbo4|A|B|C|landscape_A|landscape_C")
    workflow: str = Field(
        "turbo4",
        description="Controlled adapter supports the fixed qs_new4 workflow only",
    )
    seconds: float = Field(5.0, ge=2.0, le=16.0)
    length: Optional[int] = Field(None, description="Override frame count (17k+5)")
    width: Optional[int] = None
    height: Optional[int] = None
    steps: Optional[int] = None
    model: Optional[str] = None
    seed: Optional[int] = None
    first_frame_rel: Optional[str] = Field(
        None, description="Existing Comfy input-relative path, e.g. LocalAPI/xxx/a.png"
    )
    last_frame_rel: Optional[str] = None
    save_frames: Optional[List[int]] = Field(
        None,
        description="H3 native frame extraction: frame indices (0-based, negatives from tail, max 16). "
        "2s→3 stills, 10s→15 stills (2/3s per picture). Same Comfy graph; GET /v1/jobs/{id}/frames/{index}",
    )
    sage_attention: Optional[str] = Field(
        None,
        description="off | legacy | auto | kernel name. Unset follows H3_SAGE (prod default legacy).",
    )


class WorkflowBody(BaseModel):
    id: str = Field(..., description="custom workflow id (alnum/_/-)")
    label: Optional[str] = None
    description: Optional[str] = None
    requires_first_frame: bool = False
    requires_last_frame: bool = False
    graph: dict[str, Any] = Field(..., description="Comfy API-format prompt graph; supports {{prompt}} etc.")
    placeholders: Optional[list[str]] = None


def _snapshot_payload(jid: str, job: dict, request: Optional[Request] = None) -> dict:
    fb = schemas.feedback_block(job, request)
    return {
        "type": "snapshot",
        "job_id": jid,
        "status": job.get("status"),
        "progress": fb["progress"],
        "percent": fb["progress"]["percent"],
        "phase": fb["progress"]["phase"],
        "message": fb["progress"].get("message"),
        "elapsed_sec": job.get("elapsed_sec"),
        "error": job.get("error"),
        "video_url": job.get("video_url"),
        "video_ready": fb["video_ready"],
        "feedback": fb,
    }


class RefImage(BaseModel):
    """Ordered reference image. Array index == <Picture N> in the prompt."""

    url: str = Field(..., description="data URI / base64 / http(s) URL / Comfy relative path")
    role: str = Field("ref", description="first|last keyframes; CLIP lock: identity|fullbody|prop|scene|support")
    name: Optional[str] = None


class GatewayJobBody(BaseModel):
    """External gateway submit body. Also accepts legacy generate fields."""

    prompt: str
    ref_images: Optional[List[RefImage]] = Field(
        None,
        description="Ordered picture list; wins over first_image/last_image/identity_images/images when present",
    )
    first_image: Optional[str] = Field(None, description="base64, data URI, http(s) URL, or Comfy relative path")
    last_image: Optional[str] = Field(None, description="same as first_image")
    duration_s: Optional[float] = Field(None, ge=2.0, le=16.0)
    seconds: Optional[float] = Field(None, ge=2.0, le=16.0)
    steps: Optional[int] = None
    seed: Optional[int] = None
    turbo: Optional[bool] = False
    upscale: Optional[bool] = False
    negative: Optional[str] = None
    preset: Optional[str] = None
    workflow: Optional[str] = None
    first_frame_rel: Optional[str] = None
    last_frame_rel: Optional[str] = None
    identity_images: Optional[List[Any]] = None
    images: Optional[List[Any]] = None
    save_frames: Optional[List[int]] = Field(
        None, description="H3 native frame extraction: 0-based frame indices saved as PNG in-graph (max 16; 10s→15 stills)"
    )
    sage_attention: Optional[str] = Field(
        None,
        description="off=no Sage node; legacy=prod (guider+scheduler); auto=guider only. Unset follows H3_SAGE.",
    )


_FIRST_ROLES = {"first", "start"}
_LAST_ROLES = {"last", "tail", "end"}
_CLIP_ROLES = {
    "identity", "face", "support", "lead", "costume", "fullbody", "body", "ref",
    "scene", "prop", "environment", "bg", "background",
}


def _identity_url(item: Any) -> Optional[str]:
    if item is None:
        return None
    if isinstance(item, str):
        return item.strip() or None
    if isinstance(item, dict):
        raw = item.get("url") or item.get("file") or item.get("image")
        return str(raw).strip() if raw else None
    return str(item).strip() or None


def _looks_relative_path(s: str) -> bool:
    if len(s) > 400:
        return False
    if s.startswith("http://") or s.startswith("https://") or s.startswith("data:"):
        return False
    return ("/" in s or "\\" in s) and " " not in s[:8]


def _materialize_image(jid: str, filename: str, raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if _looks_relative_path(s) and not s.startswith("data:"):
        return s.replace("\\", "/")
    try:
        if s.startswith("http://") or s.startswith("https://"):
            with urllib.request.urlopen(s, timeout=60) as r:
                data = r.read()
            return comfy.save_upload(jid, filename, data)
        payload = s
        if payload.startswith("data:") and "," in payload:
            payload = payload.split(",", 1)[1]
        data = base64.b64decode(payload, validate=False)
        if len(data) < 32:
            raise ValueError("decoded image too small")
        return comfy.save_upload(jid, filename, data)
    except Exception as e:
        raise HTTPException(400, f"invalid image {filename}: {e}") from e


def _preset_from_gateway(body: GatewayJobBody) -> str:
    if body.preset:
        return body.preset
    if body.upscale:
        return "landscape_C"
    if body.turbo is False:
        return "C"
    return "turbo4"


def _accepted_workflow(workflow: str) -> str:
    if workflows.get_workflow(workflow):
        return workflow
    return "turbo4"


def _workflow_from_gateway(body: GatewayJobBody) -> str:
    if body.workflow:
        return body.workflow
    if body.upscale or body.turbo is False:
        return "default"
    return "turbo4"


def _health_payload() -> dict:
    alive = comfy.comfy_alive()
    queue = {"running": 0, "pending": 0}
    if alive:
        try:
            q = comfy.comfy_queue()
            queue = {"running": int(q.get("running") or 0), "pending": int(q.get("pending") or 0)}
        except Exception:
            loc = jobs.local_queue_counts()
            queue = {"running": loc["running"], "pending": loc["pending"]}
    else:
        loc = jobs.local_queue_counts()
        queue = {"running": loc["running"], "pending": loc["pending"]}
    loaded = bool(alive)
    return {
        "ok": loaded,
        "status": "ok" if loaded else "down",
        "model": "h3",
        "loaded": loaded,
        "comfy": loaded,
        "comfy_base": comfy.COMFY_BASE,
        "queue": queue,
        "vram_free_gb": comfy.vram_free_gb(),
        "quant": "workflow-dependent",
        "model_profiles": {
            "turbo": {"model": comfy.TURBO4_MODEL, "lora": comfy.LORA_TURBO4, "loader": comfy.TURBO4_LOADER},
            "default": {key: value["model"] for key, value in comfy.PRESETS.items() if key != "turbo4"},
        },
        "presets": list(comfy.PRESETS.keys()),
        "workflows": [w["id"] for w in workflows.list_workflows()],
        "realtime": {
            "sse": "/v1/jobs/{id}/events",
            "ws": "/v1/jobs/{id}/ws",
            "progress": "/v1/jobs/{id}/progress",
        },
        "submit": "/v1/jobs",
        "legacy_submit": "/v1/generate",
        "instance": os.environ.get("H3_INSTANCE") or "prod",
        "sage_workflow": "turbo4_sage",
    }


@app.get("/health")
def health():
    return _health_payload()


@app.get("/v1/spec")
def api_spec(request: Request):
    root = schemas.base_url(request) or "http://127.0.0.1:8790"
    machine_label = (os.environ.get("H3_MACHINE_LABEL") or "").strip()
    if not machine_label:
        raise HTTPException(status_code=503, detail="H3_MACHINE_LABEL must be configured for this device")
    return {
        "name": "Local MiniMax H3 API",
        "version": app.version,
        "machine": machine_label,
        "model": {
            "family": "MiniMax-H3",
            "modes": ["t2va", "i2va", "fl2va"],
            "presets": comfy.PRESETS,
            "clip": comfy.CLIP_DEFAULT,
            "fps": comfy.FPS,
            "duration_s": {"min": 2, "max": 16, "default": 5},
        },
        "health": {
            "method": "GET",
            "path": "/health",
            "url": f"{root}/health",
            "returns": {
                "ok": "bool",
                "comfy": "bool — ComfyUI reachable",
                "queue": {"running": "int", "pending": "int"},
                "vram_free_gb": "float|null",
            },
        },
        "jobs": {
            "submit": {
                "method": "POST",
                "path": "/v1/jobs",
                "url": f"{root}/v1/jobs",
                "body": {
                    "prompt": "string required; passed to the model unmodified; >7000 chars rejected (no silent truncation)",
                    "ref_images": "optional [{url, role, name}]; first|last keyframes + up to 3 CLIP stills (identity/fullbody/prop/scene → identity_1/2/3). CLIP <Picture N> = first, then last, then those stills.",
                    "first_image": "optional base64 | data URI | http URL | Comfy relative path (legacy; ignored when ref_images present)",
                    "last_image": "optional same as first_image (legacy)",
                    "identity_images": "optional list of up to 3 stills when ref_images absent; CLIP-only appearance lock on identity_1/2/3 (face / full-body / prop)",
                    "save_frames": "optional [int]; H3 native frame extraction — saves those frame indices as PNG in the same Comfy graph, download via /v1/jobs/{id}/frames/{index}",
                    "duration_s": "float 2-16, default 5 (alias: seconds)",
                    "steps": "int optional; explicit steps override the preset's step count, other preset fields unchanged",
                    "seed": "int optional",
                    "turbo": "bool — turbo4 4-step LoRA 416x736 if true (default daily)",
                    "upscale": "bool — preset landscape_C, no LoRA, if true",
                    "preset": "optional turbo4|A|B|C|landscape_A|landscape_C; overrides turbo/upscale mapping",
                    "workflow": "qs_new4 through the controlled adapter",
                    "negative": "optional; appended verbatim as caller's negative, node adds no templates of its own",
                },
                "returns": {"job_id": "string", "refs_taken": "int — images actually fed", "refs_order": "list — 'role·name' in feed order", "node_took_ref_images": "bool, present when ref_images path was used"},
            },
            "legacy_submit": {"method": "POST", "path": "/v1/generate", "url": f"{root}/v1/generate"},
            "status": {
                "method": "GET",
                "path": "/v1/jobs/{id}",
                "returns": {
                    "job_id": "string",
                    "phase": "string",
                    "status": "queued|running|done|failed|cancelled",
                    "pct": "0-100",
                    "done": "bool",
                    "failed": "bool",
                    "cancelled": "bool",
                    "error": "string|null",
                    "video_url": "string|null",
                    "file_url": "string|null",
                },
            },
            "progress": {"method": "GET", "path": "/v1/jobs/{id}/progress"},
            "download": {
                "method": "GET",
                "path": "/v1/jobs/{id}/video",
                "url": f"{root}/v1/jobs/{{id}}/video",
                "note": "direct mp4 download when done",
            },
            "list": {"method": "GET", "path": "/v1/jobs"},
            "cancel": {
                "method": "POST",
                "path": "/v1/jobs/{id}/cancel",
                "url": f"{root}/v1/jobs/{{id}}/cancel",
                "note": "brake: drop Comfy queue item + POST /interrupt. status becomes cancelled (not failed). mid-sample usually stops; VAE/encode may take a few seconds.",
            },
            "events_sse": {"method": "GET", "path": "/v1/jobs/{id}/events"},
            "events_ws": {"method": "WS", "path": "/v1/jobs/{id}/ws"},
        },
        "parameters": {
            "prompt": "H3 multimodal prompt (integrated_multimodal_description / overall_soundscape / non_diegetic_music)",
            "duration_s": "mapped to H3 frame length 17k+5",
            "turbo": "daily turbo4: 416x736 nvfp4 + 4-step LoRA + native audio VAE, crf 19",
            "upscale": "HQ landscape_C 1280x704 fp8 28 steps, no LoRA",
            "default_preset": "fixed by the qs_new4 controlled adapter",
        },
    }


@app.get("/v1/presets")
def presets():
    return {
        "presets": comfy.PRESETS,
        "length_note": "frames = 17k+5, ~24fps; seconds mapped automatically",
    }


@app.get("/v1/workflows")
def list_workflows():
    return {"workflows": workflows.list_workflows()}


@app.get("/v1/workflows/{wf_id}")
def get_workflow(wf_id: str):
    wf = workflows.get_workflow(wf_id)
    if not wf:
        raise HTTPException(404, "workflow not found")
    out = {k: v for k, v in wf.items() if k != "graph"}
    if "graph" in wf:
        out["graph_nodes"] = len(wf["graph"])
        out["has_graph"] = True
    return out


@app.post("/v1/workflows")
def register_workflow(body: WorkflowBody):
    try:
        meta = workflows.save_custom_workflow(body.id, body.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return meta


@app.delete("/v1/workflows/{wf_id}")
def delete_workflow(wf_id: str):
    try:
        ok = workflows.delete_custom_workflow(wf_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not ok:
        raise HTTPException(404, "workflow not found")
    return {"deleted": wf_id}


@app.post("/v1/generate")
def generate(body: GenerateBody, request: Request):
    try:
        job = jobs.create_job(body.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    jobs.start_worker(job["id"])
    return schemas.job_summary(job, request)


@app.post("/v1/generate/upload")
async def generate_upload(
    request: Request,
    prompt: str = Form(...),
    negative: str = Form(""),
    preset: str = Form("turbo4"),
    workflow: str = Form("turbo4"),
    seconds: float = Form(5.0),
    seed: Optional[int] = Form(None),
    first_frame: Optional[UploadFile] = File(None),
    last_frame: Optional[UploadFile] = File(None),
):
    """I2VA/FL2VA helper: multipart upload first/last frame + prompt."""
    first_rel = last_rel = None
    create_wf = _accepted_workflow(workflow)
    try:
        job = jobs.create_job(
            {
                "prompt": prompt,
                "negative": negative or None,
                "preset": preset,
                "workflow": create_wf,
                "seconds": seconds,
                "seed": seed,
            }
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    jid = job["id"]
    if first_frame is not None:
        data = await first_frame.read()
        if data:
            first_rel = comfy.save_upload(jid, first_frame.filename or "first.png", data)
            job["first_frame_rel"] = first_rel
    if last_frame is not None:
        data = await last_frame.read()
        if data:
            last_rel = comfy.save_upload(jid, last_frame.filename or "last.png", data)
            job["last_frame_rel"] = last_rel
    job["workflow"] = workflow
    try:
        job["mode"] = workflows.resolve_mode(workflow, job.get("first_frame_rel"), job.get("last_frame_rel"))
    except ValueError as e:
        job["status"] = "failed"
        job["error"] = str(e)
        jobs.save_job(job)
        raise HTTPException(400, str(e)) from e
    jobs.save_job(job)
    jobs.start_worker(jid)
    return schemas.job_summary(job, request)


@app.post("/v1/jobs")
def create_gateway_job(body: GatewayJobBody, request: Request):
    """Gateway-standard submit. Returns {job_id}."""
    seconds = float(body.duration_s or body.seconds or 5.0)
    preset = _preset_from_gateway(body)
    workflow = _workflow_from_gateway(body)
    create_wf = _accepted_workflow(workflow)
    try:
        job = jobs.create_job(
            {
                "prompt": body.prompt,
                "negative": body.negative,
                "preset": preset,
                "workflow": create_wf,
                "seconds": seconds,
                "steps": body.steps,
                "seed": body.seed,
                "first_frame_rel": body.first_frame_rel,
                "last_frame_rel": body.last_frame_rel,
                "save_frames": body.save_frames,
                "sage_attention": body.sage_attention,
            }
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    jid = job["id"]
    refs_taken = 0
    first_item: Optional[tuple[str, str]] = None
    last_item: Optional[tuple[str, str]] = None
    ident_items: List[tuple[str, str]] = []
    try:
        if body.ref_images:
            # first/last = 像素关键帧；其余进 CLIP identity_1/2/3（锁人脸/全身/道具/景，最多 3 张）。
            # <Picture N>：first → last → identity_1..3。请按这个顺序发。
            for i, ref in enumerate(body.ref_images, 1):
                role = (ref.role or "ref").strip().lower()
                label = f"{role}·{ref.name or f'图{i}'}"
                if role in _FIRST_ROLES:
                    bucket = "first"
                elif role in _LAST_ROLES:
                    bucket = "last"
                elif role in _CLIP_ROLES:
                    bucket = "identity"
                else:
                    raise HTTPException(
                        400,
                        f"ref_images 第 {i} 张（{label}）：只接 first/last 关键帧，"
                        "以及最多 3 张 CLIP 锁图（identity/fullbody/prop/scene → identity_1/2/3）。",
                    )
                if bucket == "first" and first_item:
                    raise HTTPException(400, f"ref_images 第 {i} 张（{label}）重复声明 first，首帧只能一张")
                if bucket == "last" and last_item:
                    raise HTTPException(400, f"ref_images 第 {i} 张（{label}）重复声明 last，尾帧只能一张")
                if bucket == "identity" and len(ident_items) >= 3:
                    raise HTTPException(
                        400,
                        f"ref_images 第 {i} 张（{label}）：CLIP 锁图最多 3 张"
                        "（identity_1/2/3，可混锁人脸/全身/道具/景）。",
                    )
                try:
                    rel = _materialize_image(jid, f"pic{i}_{role}.png", ref.url)
                except HTTPException as e:
                    raise HTTPException(400, f"ref_images 第 {i} 张（{label}）解码/落盘失败：{e.detail}") from e
                if not rel:
                    raise HTTPException(400, f"ref_images 第 {i} 张（{label}）是空的")
                if bucket == "first":
                    first_item = (rel, label)
                elif bucket == "last":
                    last_item = (rel, label)
                else:
                    ident_items.append((rel, label))
                refs_taken += 1
            job["first_frame_rel"] = first_item[0] if first_item else None
            job["last_frame_rel"] = last_item[0] if last_item else None
            job["identity_frame_rels"] = [rel for rel, _ in ident_items]
            job["node_took_ref_images"] = True
        else:
            if body.first_image:
                rel = _materialize_image(jid, "first.png", body.first_image)
                if rel:
                    first_item = (rel, "first·first_image")
                    job["first_frame_rel"] = rel
                    refs_taken += 1
            elif body.images:
                head = body.images[0]
                url = head if isinstance(head, str) else None
                if url:
                    rel = _materialize_image(jid, "first.png", url)
                    if rel:
                        first_item = (rel, "first·images[0]")
                        job["first_frame_rel"] = rel
                        refs_taken += 1
                if len(body.images) > 1:
                    raise HTTPException(
                        400,
                        f"images 带了 {len(body.images)} 张：本节点只能把第一张当首帧，"
                        "多余的请用 ref_images 声明 first/last/identity。",
                    )
            if body.last_image:
                rel = _materialize_image(jid, "last.png", body.last_image)
                if rel:
                    last_item = (rel, "last·last_image")
                    job["last_frame_rel"] = rel
                    refs_taken += 1
            idents = list(body.identity_images or [])
            if len(idents) > 3:
                raise HTTPException(400, f"identity_images 带了 {len(idents)} 张，最多 3 张（identity_1/2/3）")
            for i, raw in enumerate(idents, 1):
                url = _identity_url(raw)
                if not url:
                    raise HTTPException(400, f"identity_images 第 {i} 张是空的")
                rel = _materialize_image(jid, f"ident{i}.png", url)
                if not rel:
                    raise HTTPException(400, f"identity_images 第 {i} 张解码失败")
                label = f"identity·identity_{i}"
                ident_items.append((rel, label))
                refs_taken += 1
            job["identity_frame_rels"] = [rel for rel, _ in ident_items]
        refs_order: List[str] = []
        if first_item:
            refs_order.append(first_item[1])
        if last_item:
            refs_order.append(last_item[1])
        refs_order.extend(label for _, label in ident_items)
    except HTTPException as e:
        job["status"] = "failed"
        job["error"] = str(e.detail)
        jobs.save_job(job)
        raise
    job["refs_taken"] = refs_taken
    job["refs_order"] = refs_order
    job["workflow"] = workflow
    try:
        job["mode"] = workflows.resolve_mode(workflow, job.get("first_frame_rel"), job.get("last_frame_rel"))
    except ValueError as e:
        job["status"] = "failed"
        job["error"] = str(e)
        jobs.save_job(job)
        raise HTTPException(400, str(e)) from e
    jobs.save_job(job)
    jobs.start_worker(jid)
    view = schemas.gateway_job_view(job, request)
    for k in ("refs_taken", "refs_order", "node_took_ref_images"):
        if k in job:
            view[k] = job[k]
    return {"job_id": jid, **view}


@app.get("/v1/jobs")
def list_jobs(request: Request, limit: int = 30):
    rows = jobs.list_jobs(limit=limit)
    return {"jobs": [schemas.job_summary(j, request) for j in rows]}


@app.get("/v1/jobs/{jid}")
def get_job(jid: str, request: Request):
    try:
        job = jobs.load_job(jid)
    except FileNotFoundError:
        raise HTTPException(404, "job not found") from None
    out = schemas.gateway_job_view(job, request)
    out["feedback"] = schemas.feedback_block(job, request)
    out["recent_events"] = events.history(jid, limit=20)
    out["workflow"] = job.get("workflow")
    out["mode"] = job.get("mode")
    out["preset"] = job.get("preset")
    for k in ("refs_taken", "refs_order", "node_took_ref_images", "save_frames", "frames"):
        if k in job:
            out[k] = job[k]
    return out


@app.post("/v1/jobs/{jid}/cancel")
def cancel_job(jid: str, request: Request):
    """Workbench brake: interrupt Comfy + mark the job cancelled."""
    try:
        job = jobs.cancel_job(jid)
    except FileNotFoundError:
        raise HTTPException(404, "job not found") from None
    out = schemas.gateway_job_view(job, request)
    out["ok"] = True
    out["cancel_requested"] = True
    out["already_done"] = job.get("status") == "done"
    return out


@app.get("/v1/jobs/{jid}/progress")
def get_job_progress(jid: str, request: Request):
    """Lightweight poll endpoint — returns unified feedback block only."""
    try:
        job = jobs.load_job(jid)
    except FileNotFoundError:
        raise HTTPException(404, "job not found") from None
    fb = schemas.feedback_block(job, request)
    fb["recent_events"] = events.history(jid, limit=10)
    fb["latest_event"] = events.latest(jid)
    return fb


@app.get("/v1/jobs/{jid}/events")
async def job_events_sse(jid: str, request: Request):
    """Server-Sent Events realtime feedback for a job."""
    try:
        jobs.load_job(jid)
    except FileNotFoundError:
        raise HTTPException(404, "job not found") from None

    async def gen():
        q = events.AsyncQueue(jid, loop=asyncio.get_running_loop())
        try:
            try:
                snap = jobs.load_job(jid)
                yield f"data: {json.dumps(_snapshot_payload(jid, snap, request), ensure_ascii=False)}\n\n"
            except Exception:
                pass
            while True:
                ev = await q.get(timeout=12.0)
                if ev is None:
                    yield ": keepalive\n\n"
                    try:
                        snap = jobs.load_job(jid)
                        if snap.get("status") in ("done", "failed", "cancelled"):
                            payload = _snapshot_payload(jid, snap, request)
                            payload["type"] = snap["status"]
                            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                            break
                    except Exception:
                        break
                    continue
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                if ev.get("type") in ("done", "failed", "cancelled") or ev.get("status") in ("done", "failed", "cancelled"):
                    break
        finally:
            q.close()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.websocket("/v1/jobs/{jid}/ws")
async def job_events_ws(websocket: WebSocket, jid: str):
    """WebSocket realtime feedback for a job."""
    try:
        jobs.load_job(jid)
    except FileNotFoundError:
        await websocket.close(code=4404)
        return
    await websocket.accept()
    q = events.AsyncQueue(jid, loop=asyncio.get_running_loop())
    try:
        snap = jobs.load_job(jid)
        await websocket.send_json(_snapshot_payload(jid, snap, None))
        while True:
            ev = await q.get(timeout=12.0)
            if ev is None:
                try:
                    snap = jobs.load_job(jid)
                    await websocket.send_json(
                        {
                            "type": "heartbeat",
                            "job_id": jid,
                            "status": snap.get("status"),
                            "progress": schemas.progress_view(snap),
                            "percent": (snap.get("progress") or {}).get("percent", 0),
                            "phase": (snap.get("progress") or {}).get("phase"),
                            "elapsed_sec": snap.get("elapsed_sec"),
                        }
                    )
                    if snap.get("status") in ("done", "failed", "cancelled"):
                        payload = _snapshot_payload(jid, snap, None)
                        payload["type"] = snap["status"]
                        await websocket.send_json(payload)
                        break
                except Exception:
                    break
                continue
            await websocket.send_json(ev)
            if ev.get("type") in ("done", "failed", "cancelled") or ev.get("status") in ("done", "failed", "cancelled"):
                break
    except WebSocketDisconnect:
        pass
    finally:
        q.close()


@app.get("/v1/jobs/{jid}/video")
def get_video(jid: str):
    if not jid.isascii() or not all(c.isalnum() or c in "_-" for c in jid):
        raise HTTPException(404, "job not found")
    try:
        job = jobs.load_job(jid)
    except FileNotFoundError:
        raise HTTPException(404, "job not found") from None
    if job.get("status") != "done" or not job.get("video"):
        raise HTTPException(409, f"job status={job.get('status')}")
    verify = app.state.verified_video_bytes
    if not callable(verify):
        raise HTTPException(503, "H3_VERIFIED_DELIVERY_REQUIRED")
    try:
        verified = verify(jid, job)
    except Exception as error:
        raise HTTPException(409, "H3_DELIVERY_RECEIPT_MISMATCH") from error
    if not isinstance(verified, bytes) or not verified or len(verified) > 16 * 1024 * 1024:
        raise HTTPException(409, "H3_DELIVERY_RECEIPT_MISMATCH")
    return Response(content=verified, media_type="video/mp4",
                    headers={"Content-Disposition": f'attachment; filename="{jid}.mp4"',
                             "Cache-Control": "no-store"})


@app.get("/v1/jobs/{jid}/frames")
def list_job_frames(jid: str):
    """H3 自带抽帧的产物清单（save_frames 指定的帧）。"""
    try:
        job = jobs.load_job(jid)
    except FileNotFoundError:
        raise HTTPException(404, "job not found") from None
    return {
        "job_id": jid,
        "status": job.get("status"),
        "save_frames": job.get("save_frames") or [],
        "frames": job.get("frames") or [],
    }


@app.get("/v1/jobs/{jid}/frames/{index}")
def get_job_frame(jid: str, index: int):
    try:
        job = jobs.load_job(jid)
    except FileNotFoundError:
        raise HTTPException(404, "job not found") from None
    for f in job.get("frames") or []:
        if int(f.get("index", -1)) == index:
            path = pathlib.Path(f["file"])
            if not path.exists():
                raise HTTPException(404, "frame file missing")
            return FileResponse(path, media_type="image/png", filename=f"{jid}_frame{index:04d}.png")
    raise HTTPException(404, f"frame {index} not found; save_frames={job.get('save_frames')}")
