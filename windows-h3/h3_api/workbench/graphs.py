"""Experimental graphs built from the installed gateway, without editing it."""
from dataclasses import asdict, dataclass
import importlib
import sys


# No benchmark story or buyer material belongs in the distributable source.
# A caller must supply the buyer's prompt for every graph.
PROMPT = ""


@dataclass(frozen=True)
class Spec:
    name: str
    steps: int
    width: int = 1280
    height: int = 704
    sage: bool = False
    lora: str | None = None
    shift: float | None = None
    sampler: str = "res_multistep"
    model: str | None = None
    turbo_lora: bool = True


SPECS = {
    "E_light4_sage": Spec("E_light4_sage", 4, 1344, 768, sage=True,
                         lora="minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors",
                         shift=6.0, sampler="t8_dual_clock_euler"),
}


def sigma_schedule(steps, shift):
    return [shift * q / (1 + (shift - 1) * q)
            for q in ((steps - i) / steps for i in range(steps))] + [0.0]


def build(api_root, spec, seed, prefix, reference="benchmark-first.png", *,
          frames=124, prompt=PROMPT, save_frames=None, last_reference=None,
          identity_references=None):
    if type(spec.turbo_lora) is not bool or (not spec.turbo_lora and (
            spec.lora is not None or spec.shift is not None)):
        raise ValueError("No-LoRA specs cannot request a LoRA or the adapter-only dual clock")
    if frames < 5 or frames > 362 or frames % 17 != 5:
        raise ValueError("Frames must use H3's 17k+5 grid within 5..362")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("An explicit nonempty prompt is required")
    identities = list(identity_references or [])
    if len(identities) > 3 or any(not isinstance(v, str) or not v for v in identities):
        raise ValueError("At most three explicit CLIP reference paths are supported")
    if save_frames is not None and (
        not save_frames or any(type(i) is not int or not 0 <= i < frames for i in save_frames)
        or len(set(save_frames)) != len(save_frames)
    ):
        raise ValueError("Native frame indices must be unique integers inside the frame grid")
    sys.path.insert(0, str(api_root))
    comfy = importlib.import_module("local_h3.comfy")
    builder = comfy.build_graph_sage if spec.sage else comfy.build_graph
    samples = [0, 24, 48, 72, 96, 123] if frames == 124 else sorted(
        {i * (frames - 1) // 5 for i in range(6)})
    if save_frames is not None:
        samples = list(save_frames)
    options = dict(prompt=prompt, width=spec.width, height=spec.height,
                   length=frames, steps=spec.steps,
                   model=comfy.TURBO4_MODEL if spec.turbo_lora else (spec.model or comfy.TURBO4_MODEL),
                   filename_prefix=prefix, first_frame_rel=reference,
                   last_frame_rel=last_reference, identity_rels=identities,
                   seed=seed, crf=14, turbo_lora=spec.turbo_lora,
                   save_frames=samples)
    if spec.lora:
        options["lora_name"] = spec.lora
    graph = builder(**options)
    if spec.model:
        if spec.turbo_lora and (not spec.lora or spec.shift != 6.0):
            raise ValueError("An alternate base requires the shape-checked new adapter")
        graph["11"]["inputs"]["unet_name"] = spec.model
    if spec.shift is not None:
        graph.pop("1", None)
        graph.pop("6", None)
        graph["42"] = {"class_type": "QSH3BenchmarkDualClock", "inputs": {
            "model": ["31", 0], "av_latent": ["2", 1], "steps": spec.steps,
            "shift_video": spec.shift, "shift_audio": 3.0}}
        graph["7"]["inputs"].update(sampler=["42", 1], sigmas=["42", 2])
        graph["10"]["inputs"]["model"] = ["42", 0]
        if spec.sage:
            graph["40"]["inputs"]["model"] = ["42", 0]
            graph["10"]["inputs"]["model"] = ["40", 0]
        sigmas = sigma_schedule(spec.steps, spec.shift)
    else:
        graph["6"]["inputs"]["sampler_name"] = spec.sampler
        sigmas = None
    return graph, {**asdict(spec), "seed": seed, "frames": frames,
                   "video_shift": spec.shift or 12.0, "audio_shift": 3.0,
                   "expected_video_sigmas": sigmas,
                   "model": spec.model or comfy.TURBO4_MODEL,
                   "lora_file": options.get("lora_name", comfy.LORA_TURBO4) if spec.turbo_lora else None,
                   **({"validation_status": "experimental-unverified"}
                      if spec.name in ("I_base12_sage", "J_base28_sage") else {})}
