"""Optional workflow definitions for Local H3 API."""
from __future__ import annotations

import json
import copy
import os
from pathlib import Path
from typing import Any, Optional

from . import comfy

_workflow_dir_value = (os.environ.get("H3_WORKFLOW_DIR") or "").strip()
if not _workflow_dir_value:
    raise RuntimeError("H3_WORKFLOW_DIR must be explicitly configured outside the source tree")
WF_DIR = Path(_workflow_dir_value).expanduser()
if not WF_DIR.is_absolute() or not WF_DIR.is_dir():
    raise RuntimeError("H3_WORKFLOW_DIR must be an existing absolute directory")
WF_DIR = WF_DIR.resolve(strict=True)
if WF_DIR.is_relative_to(Path(__file__).resolve().parents[1]):
    raise RuntimeError("H3_WORKFLOW_DIR must be outside the installed source tree")

# The controlled qs_new4 adapter installs its sole fixed workflow at startup.
BUILTINS: dict[str, dict[str, Any]] = {}


def _custom_path(wf_id: str) -> Path:
    safe = "".join(c for c in wf_id if c.isalnum() or c in ("-", "_"))
    return WF_DIR / f"{safe}.json"


def list_workflows() -> list[dict]:
    return [dict(v) for v in BUILTINS.values()]


def get_workflow(wf_id: str) -> Optional[dict]:
    return dict(BUILTINS[wf_id]) if wf_id in BUILTINS else None


def save_custom_workflow(wf_id: str, payload: dict) -> dict:
    raise ValueError("Custom workflows are not supported by the canonical qs_new4 package")


def delete_custom_workflow(wf_id: str) -> bool:
    raise ValueError("Custom workflows are not supported by the canonical qs_new4 package")


def _replace_in_obj(obj: Any, mapping: dict[str, str]) -> Any:
    if isinstance(obj, str):
        out = obj
        for k, v in mapping.items():
            out = out.replace(k, v)
        # try coerce pure numeric replacements
        if out != obj:
            try:
                if out.isdigit() or (out.startswith("-") and out[1:].isdigit()):
                    return int(out)
                float(out)
                if "." in out:
                    return float(out)
            except Exception:
                pass
        return out
    if isinstance(obj, list):
        return [_replace_in_obj(x, mapping) for x in obj]
    if isinstance(obj, dict):
        return {k: _replace_in_obj(v, mapping) for k, v in obj.items()}
    return obj


def resolve_mode(workflow_id: str, first_rel: Optional[str], last_rel: Optional[str]) -> str:
    wf = get_workflow(workflow_id)
    if wf is None:
        raise ValueError("Only the fixed qs_new4 workflow is supported")
    wid = wf.get("id") or workflow_id
    if wid == "t2va":
        if first_rel or last_rel:
            raise ValueError("workflow t2va does not accept reference frames")
        return "t2va"
    if wid == "i2va":
        if not first_rel:
            raise ValueError("workflow i2va requires first_frame")
        if last_rel:
            raise ValueError("workflow i2va does not accept last_frame (use fl2va)")
        return "i2va"
    if wid == "fl2va":
        if not first_rel or not last_rel:
            raise ValueError("workflow fl2va requires first_frame and last_frame")
        return "fl2va"
    # turbo4 / default / custom: auto-switch like the Aiden 文-图-首尾帧 graph
    if first_rel and last_rel:
        return "fl2va"
    if first_rel:
        return "i2va"
    return "t2va"


def _use_turbo_lora(job: dict, wf: dict) -> bool:
    if job.get("preset") == "turbo4":
        return True
    if wf.get("turbo_lora"):
        return True
    wid = str(wf.get("id") or job.get("workflow") or "")
    return wid in ("turbo4", "turbo4_sage", "turbo4_sage_hq")


def resolve_model(workflow_id: str, preset_id: str, requested_model=None) -> str:
    wf = get_workflow(workflow_id)
    if wf is None:
        raise ValueError(f"unknown workflow: {workflow_id}")
    turbo = wf.get("kind") != "custom" and _use_turbo_lora({"preset": preset_id}, wf)
    model = requested_model or (comfy.TURBO4_MODEL if turbo else comfy.PRESETS[preset_id]["model"])
    if turbo and "pruned" in model.lower():
        raise ValueError("Turbo LoRA requires a non-pruned H3 base; cannot apply 2688-dimensional AdaLN to the pruned 8-dimensional basis")
    return model


def build_prompt_graph(job: dict) -> dict:
    """Build Comfy API prompt graph from job + selected workflow."""
    raise RuntimeError("Use the fixed qs_new4 graph builder in the controlled adapter")
    wf_id = job.get("workflow") or "turbo4"
    wf = get_workflow(wf_id) or BUILTINS["turbo4"]
    kind = wf.get("kind") or "builtin"
    turbo = _use_turbo_lora(job, wf)
    prefix = (
        f"MiniMax_H3/turbo4/{job['id']}/out" if turbo else f"MiniMax_H3/LocalAPI/{job['id']}/out"
    )
    first_rel = job.get("first_frame_rel")
    last_rel = job.get("last_frame_rel")
    ident_rels = [p for p in (job.get("identity_frame_rels") or []) if p][:3]

    if kind == "custom":
        mapping = {
            "{{prompt}}": job["prompt_full"],
            "{{negative}}": job.get("negative") or "",
            "{{width}}": str(job["width"]),
            "{{height}}": str(job["height"]),
            "{{length}}": str(job["length"]),
            "{{steps}}": str(job["steps"]),
            "{{seed}}": str(job.get("seed") if job.get("seed") is not None else 0),
            "{{model}}": job["model"],
            "{{clip}}": comfy.CLIP_DEFAULT,
            "{{filename_prefix}}": prefix,
            "{{first_frame}}": first_rel or "",
            "{{last_frame}}": last_rel or "",
            "{{identity_1}}": ident_rels[0] if len(ident_rels) > 0 else "",
            "{{identity_2}}": ident_rels[1] if len(ident_rels) > 1 else "",
            "{{identity_3}}": ident_rels[2] if len(ident_rels) > 2 else "",
        }
        graph = _replace_in_obj(copy.deepcopy(wf["graph"]), mapping)
        return graph

    preset = comfy.PRESETS.get(job["preset"], {})
    kwargs = dict(
        prompt=job["prompt_full"],
        width=job["width"],
        height=job["height"],
        length=job["length"],
        steps=job["steps"],
        model=job["model"],
        filename_prefix=prefix,
        save_frames=job.get("save_frames") or None,
        first_frame_rel=first_rel,
        last_frame_rel=last_rel,
        identity_rels=ident_rels,
        seed=job.get("seed"),
        crf=preset.get("crf", 14),
        turbo_lora=turbo,
    )
    if wf.get("sage_guider") or wf_id in ("turbo4_sage", "turbo4_sage_hq"):
        kwargs["sage_attention"] = str(wf.get("sage_kernel") or "auto")
        return comfy.build_graph_sage(**kwargs)
    return comfy.build_graph(**kwargs)
