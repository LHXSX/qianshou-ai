"""Shared response helpers for Local H3 API."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import Request


def base_url(request: Optional[Request]) -> str:
    if request is None:
        return ""
    # honor reverse proxy
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}".rstrip("/")


def abs_url(request: Optional[Request], path: str) -> str:
    if not path:
        return path
    if path.startswith("http://") or path.startswith("https://"):
        return path
    root = base_url(request)
    if not root:
        return path
    return root + (path if path.startswith("/") else "/" + path)


def progress_view(job: dict) -> dict:
    prog = job.get("progress") or {}
    return {
        "percent": prog.get("percent", 0),
        "value": prog.get("value", 0),
        "max": prog.get("max") or job.get("steps") or 0,
        "node": prog.get("node"),
        "phase": prog.get("phase") or job.get("status") or "unknown",
        "message": prog.get("message"),
    }


def feedback_block(job: dict, request: Optional[Request] = None) -> dict:
    jid = job["id"]
    paths = {
        "poll": f"/v1/jobs/{jid}",
        "progress": f"/v1/jobs/{jid}/progress",
        "events": f"/v1/jobs/{jid}/events",
        "ws": f"/v1/jobs/{jid}/ws",
        "video": job.get("video_url") or f"/v1/jobs/{jid}/video",
    }
    urls = {k: abs_url(request, v) for k, v in paths.items()}
    return {
        "job_id": jid,
        "status": job.get("status"),
        "progress": progress_view(job),
        "elapsed_sec": job.get("elapsed_sec"),
        "error": job.get("error"),
        "video_ready": job.get("status") == "done" and bool(job.get("video")),
        "paths": paths,
        "urls": urls,
        "realtime": {
            "sse": paths["events"],
            "websocket": paths["ws"],
            "sse_url": urls["events"],
            "websocket_url": urls["ws"].replace("http://", "ws://").replace("https://", "wss://"),
        },
    }


def gateway_job_view(job: dict, request: Optional[Request] = None) -> dict:
    """Compact status the external gateway expects."""
    jid = job["id"]
    prog = progress_view(job)
    status = job.get("status")
    done = status == "done" and bool(job.get("video"))
    failed = status == "failed"
    cancelled = status == "cancelled"
    video_path = f"/v1/jobs/{jid}/video"
    video_url = abs_url(request, video_path) if done else None
    return {
        "job_id": jid,
        "id": jid,
        "phase": prog.get("phase") or status or "unknown",
        "status": status,
        "pct": prog.get("percent") or 0,
        "percent": prog.get("percent") or 0,
        "done": done,
        "failed": failed,
        "cancelled": cancelled,
        "error": job.get("error"),
        "video_url": video_url,
        "file_url": video_url,
        "elapsed_sec": job.get("elapsed_sec"),
        "progress": prog,
    }


def job_summary(job: dict, request: Optional[Request] = None) -> dict:
    fb = feedback_block(job, request)
    return {
        "id": job["id"],
        "status": job.get("status"),
        "workflow": job.get("workflow"),
        "mode": job.get("mode"),
        "preset": job.get("preset"),
        "created": job.get("created"),
        "elapsed_sec": job.get("elapsed_sec"),
        "length": job.get("length"),
        "size": f"{job.get('width')}x{job.get('height')}" if job.get("width") else None,
        "steps": job.get("steps"),
        "comfy_prompt_id": job.get("comfy_prompt_id"),
        "error": job.get("error"),
        "progress": fb["progress"],
        "feedback": fb,
        # legacy aliases — keep for older clients
        "poll": fb["paths"]["poll"],
        "events": fb["paths"]["events"],
        "events_url": fb["paths"]["events"],
        "ws": fb["paths"]["ws"],
        "ws_url": fb["paths"]["ws"],
        "progress_url": fb["paths"]["progress"],
        "video": fb["paths"]["video"],
        "video_url": job.get("video_url") or fb["paths"]["video"],
    }
