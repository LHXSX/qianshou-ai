"""Job store + background workers for local H3 API."""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from . import comfy, events, workflows
from .stage_progress import GraphProgress

_jobs_dir_value = (os.environ.get("H3_JOBS_DIR") or "").strip()
if not _jobs_dir_value:
    raise RuntimeError("H3_JOBS_DIR must be configured outside the installed source tree")
JOBS_DIR = Path(_jobs_dir_value).expanduser()
if not JOBS_DIR.is_absolute():
    raise RuntimeError("H3_JOBS_DIR must be an absolute path")
if JOBS_DIR.resolve().is_relative_to(Path(__file__).resolve().parents[1]):
    raise RuntimeError("H3_JOBS_DIR must be outside the installed source tree")
JOBS_DIR.mkdir(parents=True, exist_ok=True)
JOBS_DIR = JOBS_DIR.resolve(strict=True)

_lock = threading.Lock()
_workers: dict[str, threading.Thread] = {}
_job_locks_guard = threading.Lock()
_job_locks: dict[str, threading.RLock] = {}
_last_disk_save: dict[str, float] = {}
_CONTROLLED_ADAPTER_ENABLED = False
_final_attestation_check = None  # installed only by the controlled adapter


def _job_lock(jid: str) -> threading.RLock:
    with _job_locks_guard:
        lk = _job_locks.get(jid)
        if lk is None:
            lk = threading.RLock()
            _job_locks[jid] = lk
        return lk


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def new_id() -> str:
    return time.strftime("%Y%m%d_%H%M%S_") + uuid.uuid4().hex[:8]


def job_path(jid: str) -> Path:
    return JOBS_DIR / jid / "job.json"


def _read_job_file(jid: str) -> dict:
    p = job_path(jid)
    if not p.exists():
        raise FileNotFoundError(jid)
    return json.loads(p.read_text(encoding="utf-8"))


def save_job(job: dict) -> None:
    """Persist job JSON; serialized per job to avoid Windows replace races."""
    jid = job["id"]
    d = JOBS_DIR / jid
    d.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(job, ensure_ascii=False, indent=2)
    target = job_path(jid)
    with _job_lock(jid):
        last_err: Optional[Exception] = None
        for attempt in range(10):
            tmp = d / f"job.json.{uuid.uuid4().hex[:8]}.tmp"
            try:
                tmp.write_text(payload, encoding="utf-8")
                tmp.replace(target)
                _last_disk_save[jid] = time.time()
                return
            except (PermissionError, OSError) as e:
                last_err = e
                time.sleep(0.05 * (attempt + 1))
            finally:
                try:
                    tmp.unlink(missing_ok=True)
                except Exception:
                    pass
        if last_err:
            raise last_err


def load_job(jid: str) -> dict:
    with _job_lock(jid):
        return _read_job_file(jid)


def _maybe_save_job(job: dict, *, min_interval: float = 2.0) -> None:
    """Throttle frequent heartbeat writes while keeping realtime events."""
    jid = job["id"]
    now = time.time()
    if now - _last_disk_save.get(jid, 0.0) >= min_interval:
        save_job(job)


def _emit(job: dict, **fields: Any) -> None:
    prog = job.get("progress") or {}
    ev = {
        "job_id": job["id"],
        "status": job.get("status"),
        "progress": prog,
        "percent": prog.get("percent", 0),
        "phase": prog.get("phase"),
        "elapsed_sec": job.get("elapsed_sec"),
        "message": fields.pop("message", None),
        "type": fields.pop("type", "update"),
    }
    ev.update(fields)
    events.publish(job["id"], ev)


def _set_progress(job: dict, **kwargs: Any) -> None:
    prog = dict(job.get("progress") or {})
    prog.update(kwargs)
    job["progress"] = prog


def create_job(req: dict) -> dict:
    if not _CONTROLLED_ADAPTER_ENABLED:
        raise RuntimeError("QS_NEW4_CONTROLLED_ADAPTER_REQUIRED")
    if (req.get("workflow") != "qs_new4" or type(req.get("seconds")) is not int or
            req["seconds"] != 5 or type(req.get("steps")) is not int or req["steps"] != 4):
        raise ValueError("Only qs_new4/E_light4_sage fixed five-second jobs are supported")
    workflow_id = str(req.get("workflow") or "turbo4").strip() or "turbo4"
    raw = str(req.get("preset") or "").strip()
    if not raw:
        raw = "turbo4" if workflow_id in ("turbo4", "turbo4_sage", "turbo4_sage_hq", "default", "t2va", "i2va", "fl2va") else "C"
    preset_id = raw if raw in comfy.PRESETS else raw.upper()
    if preset_id not in comfy.PRESETS:
        raise ValueError(f"unknown preset: {req.get('preset')}; choose from {list(comfy.PRESETS)}")

    if workflows.get_workflow(workflow_id) is None:
        raise ValueError(f"unknown workflow: {workflow_id}; GET /v1/workflows")

    preset = comfy.PRESETS[preset_id]
    seconds = float(req.get("seconds") or 5.0)
    length = int(req.get("length") or comfy.h3_length(seconds))
    width = int(req.get("width") or preset["width"])
    height = int(req.get("height") or preset["height"])
    steps = int(req.get("steps") or preset["steps"])
    model = workflows.resolve_model(workflow_id, preset_id, req.get("model"))
    prompt = (req.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    if len(prompt) > 7000:
        # 契约：超上限整单退回，不静默截断（截掉的往往是声景和配乐段）
        raise ValueError(f"提示词 {len(prompt)} 字符超上限 7000，节点不截断，请上游精简")

    save_frames: list[int] = []
    for n in (req.get("save_frames") or [])[:16]:
        try:
            idx = int(n)
        except (TypeError, ValueError):
            raise ValueError(f"save_frames 里 {n!r} 不是帧号整数")
        if idx < 0:
            idx += length
        if not (0 <= idx < length):
            raise ValueError(f"save_frames 帧号 {n} 超出范围（本单 {length} 帧，0..{length - 1}）")
        if idx not in save_frames:
            save_frames.append(idx)

    first_rel = req.get("first_frame_rel")
    last_rel = req.get("last_frame_rel")
    if req.get("has_first_frame") and not first_rel:
        # placeholder until upload fills it
        pass
    mode = workflows.resolve_mode(workflow_id, first_rel, last_rel)

    jid = new_id()
    job = {
        "id": jid,
        "created": _now(),
        "status": "queued",
        "error": None,
        "preset": preset_id,
        "workflow": workflow_id,
        "prompt": prompt,
        "negative": req.get("negative") or "",
        "seconds": seconds,
        "length": length,
        "width": width,
        "height": height,
        "steps": steps,
        "model": model,
        "lora_loader": comfy.TURBO4_LOADER if workflows.get_workflow(workflow_id).get("kind") != "custom" and workflows._use_turbo_lora({"preset": preset_id}, workflows.get_workflow(workflow_id)) else None,
        "seed": req.get("seed"),
        "mode": mode,
        "first_frame_rel": first_rel,
        "last_frame_rel": last_rel,
        "identity_frame_rels": [p for p in (req.get("identity_frame_rels") or []) if p][:3],
        "save_frames": save_frames,
        "frames": [],
        "comfy_prompt_id": None,
        "comfy_client_id": None,
        "cancel_requested": False,
        "video": None,
        "video_url": None,
        "elapsed_sec": None,
        "progress": {"percent": None, "value": None, "max": None, "node": None, "class_type": None, "phase": "queued", "message": "queued", "progress_scope": "node", "indeterminate": True},
        "events_url": f"/v1/jobs/{jid}/events",
        "ws_url": f"/v1/jobs/{jid}/ws",
        "progress_url": f"/v1/jobs/{jid}/progress",
        "recent_events": [],
        "log": [],
    }
    if job["negative"]:
        job["prompt_full"] = prompt.rstrip() + "\n\nNegative: " + job["negative"]
    else:
        job["prompt_full"] = prompt
    save_job(job)
    _emit(job, type="queued", message="job created")
    return job


def _append_log(job: dict, msg: str) -> None:
    job["log"].append(f"[{_now()}] {msg}")
    save_job(job)


def _claim_h3_gpu():
    """Return an entered GPU reservation held until the worker exits."""
    slot_file = (os.environ.get("GPU_SLOT_FILE") or "").strip()
    if not slot_file or not Path(slot_file).is_absolute():
        raise RuntimeError("GPU_SLOT_FILE must be explicitly configured as an absolute shared lock path")
    try:
        import gpu_slot
    except ImportError as error:
        raise RuntimeError("Required gpu_slot module is unavailable; refusing H3 GPU claim") from error
    bundled_slot = Path(__file__).resolve().parents[1] / "gpu_slot.py"
    slot_source = getattr(gpu_slot, "__file__", None)
    if not bundled_slot.is_file() or not slot_source or Path(slot_source).resolve() != bundled_slot.resolve():
        raise RuntimeError("Required gpu_slot module is not the bundled audited source")
    GpuBusy, reserve = gpu_slot.GpuBusy, gpu_slot.reserve
    lease = reserve("h3", comfy.COMFY_BASE)
    try:
        lease.__enter__()
    except GpuBusy as e:
        raise RuntimeError(f"GPU busy occupant={e.occupant}") from e
    return lease


def _run(jid: str) -> None:
    if not _CONTROLLED_ADAPTER_ENABLED:
        raise RuntimeError("QS_NEW4_CONTROLLED_ADAPTER_REQUIRED")
    t0 = time.time()
    client_id = f"h3api-{jid}"
    gpu_lease = None
    try:
        job = load_job(jid)
        receipt = job.get("recipe_identity")
        if (not isinstance(receipt, dict) or
                receipt.get("schemaVersion") != "qs.h3.job-identity.canonical-vnext" or
                not isinstance(receipt.get("expected"), dict) or
                not isinstance(receipt.get("checkedAtQueue"), dict)):
            raise RuntimeError("H3_EXPECTED_IDENTITY_REQUIRED")
        job["status"] = "running"
        job["comfy_client_id"] = client_id
        _set_progress(job, percent=None, value=None, max=None, node=None, class_type=None, phase="starting", progress_scope="node", indeterminate=True, message="worker started")
        save_job(job)
        _emit(job, type="running", message="worker started")

        if is_cancelled(jid):
            raise JobCancelled("cancelled before start")
        if not comfy.comfy_alive():
            raise RuntimeError("ComfyUI is not reachable at " + comfy.COMFY_BASE)
        gpu_lease = _claim_h3_gpu()
        if is_cancelled(jid):
            raise JobCancelled("cancelled after gpu claim")

        # re-validate mode after uploads may have set frames
        job["mode"] = workflows.resolve_mode(
            job.get("workflow") or "default",
            job.get("first_frame_rel"),
            job.get("last_frame_rel"),
        )
        save_job(job)

        graph = workflows.build_prompt_graph(job)
        graph_progress = GraphProgress(graph)
        _append_log(
            job,
            f"submit wf={job.get('workflow')} mode={job['mode']} "
            f"{job['width']}x{job['height']} len={job['length']} steps={job['steps']}",
        )
        _emit(job, type="submit", message="submitting to Comfy")

        def on_event(ev: dict) -> None:
            with _job_lock(jid):
                try:
                    j = _read_job_file(jid)
                except Exception:
                    return
                if j.get("status") in ("done", "failed", "cancelled"):
                    return
                et = ev.get("type")
                if et in ("progress", "executing", "execution_start", "queue"):
                    update = graph_progress.consume(ev)
                    if update is None:
                        return
                    _set_progress(j, **update)
                    j["elapsed_sec"] = round(time.time() - t0, 1)
                    save_job(j)
                    _emit(j, type=et, node=j["progress"].get("node"), message=j["progress"].get("message"))
                elif et == "heartbeat":
                    j["elapsed_sec"] = ev.get("elapsed_sec") or round(time.time() - t0, 1)
                    _maybe_save_job(j)
                    _emit(j, type="heartbeat", message=f"elapsed {j['elapsed_sec']}s")
                elif et == "error":
                    _emit(j, type="comfy_error", message=str(ev.get("data"))[:500])
                elif et == "ws_warn":
                    _append_log(j, "ws_warn " + str(ev.get("message")))

        watcher = comfy.ComfyProgressWatcher(client_id, on_event=on_event)
        watcher.start()

        if is_cancelled(jid):
            raise JobCancelled("cancelled before submit")
        pid = comfy.submit_graph(graph, client_id=client_id)
        with _job_lock(jid):
            job = load_job(jid)
            job["comfy_prompt_id"] = pid
            if job.get("cancel_requested"):
                try:
                    comfy.delete_queued(pid)
                    comfy.interrupt()
                except Exception:
                    pass
                raise JobCancelled("cancelled at submit")
            if not graph_progress.has_node_activity:
                _set_progress(job, percent=None, value=None, max=None, node=None, class_type=None,
                              phase="queued_comfy", progress_scope="node", indeterminate=True,
                              message=f"comfy queued {pid[:8]}")
            save_job(job)
            _append_log(job, "queued " + pid)
            _emit(job, type="comfy_queued", prompt_id=pid, message=pid)

        entry = comfy.wait_prompt(
            pid, client_id=client_id, on_event=on_event, poll=2.0, watcher=watcher,
            should_abort=lambda: is_cancelled(jid),
        )
        if is_cancelled(jid):
            raise JobCancelled("cancelled during sample")
        st = (entry.get("status") or {}).get("status_str")
        if st != "success":
            messages = json.dumps(entry.get("status"), ensure_ascii=False)
            if "execution_interrupted" in messages or is_cancelled(jid):
                raise JobCancelled("Comfy interrupted")
            raise RuntimeError(messages[:1500])

        out_dir = comfy.OUT_ROOT / jid
        src = comfy.find_video(entry, out_dir)
        if not src:
            raise RuntimeError("Comfy finished but no mp4 found")
        dest = comfy.copy_output(src, jid, "result.mp4")
        job_copy = JOBS_DIR / jid / "result.mp4"
        job_copy.write_bytes(dest.read_bytes())

        job = load_job(jid)
        # H3 自带抽帧：图里 SaveImage 存的 PNG 按 _frameNNNN 对号收进单目录
        frames_meta: list[dict] = []
        want = [int(n) for n in (job.get("save_frames") or [])]
        if want:
            found = comfy.find_frames(entry)
            fdir = JOBS_DIR / jid / "frames"
            fdir.mkdir(parents=True, exist_ok=True)
            for idx in want:
                tag = f"_frame{idx:04d}"
                src_png = next((p for p in found if tag in Path(p).name), None)
                if not src_png:
                    _append_log(job, f"frame {idx} missing in Comfy outputs")
                    continue
                dst = fdir / f"frame_{idx:04d}.png"
                dst.write_bytes(Path(src_png).read_bytes())
                frames_meta.append({
                    "index": idx,
                    "file": str(dst),
                    "url": f"/v1/jobs/{jid}/frames/{idx}",
                })
        job["frames"] = frames_meta
        if _final_attestation_check is None:
            raise RuntimeError("H3_FINAL_ATTESTATION_REQUIRED")
        _final_attestation_check(job, job_copy)
        job["status"] = "done"
        job["video"] = str(job_copy)
        job["video_url"] = f"/v1/jobs/{jid}/video"
        job["elapsed_sec"] = round(time.time() - t0, 1)
        _set_progress(job, percent=None, value=None, max=None, node=None, class_type=None, phase="done", progress_scope="node", indeterminate=False, message="completed")
        _append_log(job, f"done {job_copy}")
        save_job(job)
        _emit(job, type="done", message="completed", video_url=job["video_url"])
    except JobCancelled as e:
        try:
            job = load_job(jid)
        except Exception:
            return
        job["elapsed_sec"] = round(time.time() - t0, 1)
        _mark_cancelled(job, str(e) or "cancelled by user")
    except Exception as e:
        try:
            job = load_job(jid)
        except Exception:
            return
        if is_cancelled(jid) or "cancelled" in str(e).lower() or "execution_interrupted" in str(e):
            job["elapsed_sec"] = round(time.time() - t0, 1)
            _mark_cancelled(job, "cancelled by user")
            return
        job["status"] = "failed"
        job["error"] = str(e)[:2000]
        job["elapsed_sec"] = round(time.time() - t0, 1)
        _set_progress(job, percent=None, value=None, max=None, node=None, class_type=None,
                      phase="failed", progress_scope="node", indeterminate=False, message=str(e)[:200])
        _append_log(job, "failed: " + str(e)[:500])
        save_job(job)
        _emit(job, type="failed", message=str(e)[:500])
    finally:
        try:
            if gpu_lease is not None:
                gpu_lease.__exit__(None, None, None)
        finally:
            with _lock:
                _workers.pop(jid, None)


class JobCancelled(Exception):
    pass


def is_cancelled(jid: str) -> bool:
    try:
        j = _read_job_file(jid)
    except Exception:
        return False
    return bool(j.get("cancel_requested")) or j.get("status") == "cancelled"


def _mark_cancelled(job: dict, why: str = "cancelled by user") -> dict:
    job["cancel_requested"] = True
    job["status"] = "cancelled"
    job["error"] = why
    _set_progress(job, percent=None, value=None, max=None, node=None, class_type=None, phase="cancelled", progress_scope="node", indeterminate=False, message="已刹车")
    _append_log(job, why)
    save_job(job)
    _emit(job, type="cancelled", message="已刹车")
    return job


def cancel_job(jid: str) -> dict:
    """User brake: drop Comfy queue item + interrupt sampler. Marks cancelled."""
    job = load_job(jid)
    if job.get("status") == "done":
        return job
    if job.get("status") == "cancelled":
        return job
    job["cancel_requested"] = True
    save_job(job)
    pid = job.get("comfy_prompt_id")
    errs = []
    if pid:
        try:
            comfy.delete_queued(pid)
        except Exception as e:
            errs.append(f"queue:{e}")
    try:
        comfy.interrupt()
    except Exception as e:
        errs.append(f"interrupt:{e}")
    if errs:
        job["cancel_error"] = "; ".join(errs)[:300]
        save_job(job)
    worker_alive = False
    with _lock:
        t = _workers.get(jid)
        worker_alive = bool(t and t.is_alive())
    if job.get("status") in ("queued", "starting", "failed") or not pid or not worker_alive:
        return _mark_cancelled(job)
    # running + worker alive: wait_prompt will see the flag and finish as cancelled
    _append_log(job, "cancel requested")
    save_job(job)
    _emit(job, type="cancel_requested", message="刹车已发给 Comfy")
    return job


def start_worker(jid: str) -> None:
    if not _CONTROLLED_ADAPTER_ENABLED:
        raise RuntimeError("QS_NEW4_CONTROLLED_ADAPTER_REQUIRED")
    with _lock:
        if jid in _workers and _workers[jid].is_alive():
            return
        t = threading.Thread(target=_run, args=(jid,), daemon=True, name=f"h3-{jid}")
        _workers[jid] = t
        t.start()


def local_queue_counts() -> dict:
    running = pending = 0
    for j in list_jobs(limit=200):
        st = j.get("status")
        if st == "running":
            running += 1
        elif st in ("queued", "starting"):
            pending += 1
    return {"running": running, "pending": pending}


def list_jobs(limit: int = 30) -> list[dict]:
    rows = []
    if not JOBS_DIR.exists():
        return rows
    dirs = sorted(JOBS_DIR.iterdir(), key=lambda p: p.name, reverse=True)
    for d in dirs[:limit]:
        jp = d / "job.json"
        if jp.exists():
            try:
                rows.append(json.loads(jp.read_text(encoding="utf-8")))
            except Exception:
                pass
    return rows
