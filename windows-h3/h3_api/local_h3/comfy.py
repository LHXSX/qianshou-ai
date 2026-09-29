"""ComfyUI MiniMax-H3 client helpers for the local API."""
from __future__ import annotations

import json
import math
import os
import random
import re
import shutil
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional
from .stage_progress import node_counters

COMFY_BASE = (os.environ.get("H3_COMFY_BASE") or "").strip()
if not re.fullmatch(r"http://(?:127\.0\.0\.1|\[::1\]):[0-9]{2,5}", COMFY_BASE):
    raise RuntimeError("H3_COMFY_BASE must be an explicitly configured loopback HTTP URL")
if not 1 <= int(COMFY_BASE.rsplit(":", 1)[1]) <= 65535:
    raise RuntimeError("H3_COMFY_BASE port is invalid")


def _required_directory(name: str) -> Path:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        raise RuntimeError(f"{name} must be explicitly configured for this device")
    path = Path(raw).expanduser()
    if not path.is_absolute() or not path.is_dir():
        raise RuntimeError(f"{name} must be an existing absolute directory")
    return path.resolve(strict=True)


COMFY_ROOT = _required_directory("H3_COMFY_ROOT")
OUT_ROOT = _required_directory("H3_ADAPTER_OUTPUT_ROOT")
INP_ROOT = _required_directory("H3_ADAPTER_INPUT_ROOT")
if OUT_ROOT.is_relative_to(Path(__file__).resolve().parents[1]) or INP_ROOT.is_relative_to(Path(__file__).resolve().parents[1]):
    raise RuntimeError("H3 adapter input and output directories must be outside the installed source tree")
if OUT_ROOT.name != "LocalAPI" or OUT_ROOT.parent.name != "MiniMax_H3":
    raise RuntimeError("H3_ADAPTER_OUTPUT_ROOT must name the MiniMax_H3/LocalAPI result directory")
if INP_ROOT.name != "LocalAPI":
    raise RuntimeError("H3_ADAPTER_INPUT_ROOT must name the LocalAPI input directory")
CLIP_DEFAULT = os.environ.get("H3_CLIP", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors")
VAE_VIDEO = "minimax_h3_video_vae_fp16.safetensors"
VAE_AUDIO = "minimax_h3_audio_vae_fp32.safetensors"
LORA_TURBO4 = os.environ.get(
    "H3_TURBO4_LORA",
    "minimax_h3_turbo_4步加速_comfyui.safetensors",
)
TURBO4_MODEL = os.environ.get("H3_TURBO4_MODEL", "minimax_h3_fl2va_int8_convrot.safetensors")
TURBO4_LOADER = "LoraLoaderBypassModelOnly"
FPS = 24
TURBO4_IDS = ("turbo4", "turbo4_sage", "turbo4_sage_hq")
# The installed KJNodes class name retains its upstream spelling.
_SAGE_NODE = "PathchSageAttentionKJ"

# Historical presets remain internal to the gateway; only qs_new4 is exposed.
PRESETS = {
    "turbo4": {
        "label": "legacy 4-step LoRA",
        "width": 416,
        "height": 736,
        "steps": 4,
        "model": "MiniMax_H3_FL2VA_pruned_nvfp4.safetensors",
        "crf": 19,
        "turbo_lora": True,
    },
    "A": {
        "label": "fast",
        "width": 480,
        "height": 832,
        "steps": 20,
        "model": "MiniMax_H3_FL2VA_pruned_nvfp4.safetensors",
        "crf": 16,
    },
    "B": {
        "label": "balanced",
        "width": 576,
        "height": 1024,
        "steps": 24,
        "model": "minimax_h3_fl2va_pruned_fp8_scaled.safetensors",
        "crf": 14,
    },
    "C": {
        "label": "hq",
        "width": 640,
        "height": 1152,
        "steps": 28,
        "model": "minimax_h3_fl2va_pruned_fp8_scaled.safetensors",
        "crf": 14,
    },
    "landscape_A": {
        "label": "fast 16:9",
        "width": 832,
        "height": 480,
        "steps": 20,
        "model": "MiniMax_H3_FL2VA_pruned_nvfp4.safetensors",
        "crf": 16,
    },
    "landscape_C": {
        "label": "hq 16:9",
        "width": 1280,
        "height": 704,
        "steps": 28,
        "model": "minimax_h3_fl2va_pruned_fp8_scaled.safetensors",
        "crf": 14,
    },
}


def h3_length(seconds: float) -> int:
    """Nearest valid MiniMax-H3 frame count: 17k+5, clamped to trained range."""
    need = max(1, int(math.ceil(float(seconds) * FPS - 1e-9)))
    k = max(1, int(math.ceil((need - 5) / 17.0)))
    length = 17 * k + 5
    return min(362, max(56, length))


def http_json(path: str, data: Any = None, timeout: float = 60) -> dict:
    url = COMFY_BASE.rstrip("/") + path
    try:
        if data is None:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return json.loads(r.read())
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json; charset=utf-8"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if path == "/prompt" and e.code == 409:
            try:
                error = json.loads(e.read(4097))
            except (ValueError, UnicodeError):
                error = None
            if (isinstance(error, dict) and
                    isinstance(error.get("error"), dict) and
                    error["error"].get("type") == "qs_h3_source_identity_changed"):
                raise RuntimeError("H3_COMFY_PROCESS_IDENTITY_CHANGED") from e
        raise RuntimeError(f"Comfy request was rejected with HTTP {e.code}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Comfy unreachable at {COMFY_BASE}: {e}") from e


def comfy_alive(timeout: float = 3.0) -> bool:
    try:
        http_json("/system_stats", timeout=timeout)
        return True
    except Exception:
        return False


def comfy_queue() -> dict:
    q = http_json("/queue", timeout=10)
    if (not isinstance(q, dict) or
            not isinstance(q.get("queue_running"), list) or
            not isinstance(q.get("queue_pending"), list)):
        raise RuntimeError("Comfy queue response is invalid; refusing H3 submission")
    return {
        "running": len(q["queue_running"]),
        "pending": len(q["queue_pending"]),
    }


def vram_free_gb() -> Optional[float]:
    """Free GPU memory in GiB (first NVIDIA GPU). None if nvidia-smi unavailable."""
    try:
        import subprocess

        r = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.free",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=4,
            check=False,
        )
        if r.returncode != 0:
            return None
        line = (r.stdout or "").strip().splitlines()[0]
        mib = float(line.strip().split()[0])
        return round(mib / 1024.0, 2)
    except Exception:
        return None


def build_graph(
    *,
    prompt: str,
    width: int,
    height: int,
    length: int,
    steps: int,
    model: str,
    filename_prefix: str,
    save_frames: Optional[list[int]] = None,
    first_frame_rel: Optional[str] = None,
    last_frame_rel: Optional[str] = None,
    identity_rels: Optional[list[str]] = None,
    seed: Optional[int] = None,
    crf: int = 14,
    clip_name: str = CLIP_DEFAULT,
    turbo_lora: bool = False,
    lora_name: str = LORA_TURBO4,
    lora_strength: float = 1.0,
) -> dict:
    """FL2VA graph; turbo_lora uses the installed four-step loader (node 31).

    Native stereo audio is always decoded (Audio VAE) and muxed by VHS — not a
    separate TTS/music pass. Optional first/last LoadImage turns T2VA into I2VA/FL2VA.
    identity_1/2/3 are CLIP-only stills (not keyframes) on MiniMaxH3ImageToVideo.
    CLIP <Picture N> order is first, then last, then identity_1..3.
    """
    noise_seed = int(seed) if seed is not None else random.randint(1, 2_000_000_000)
    i2v: dict[str, Any] = {
        "clip": ["12", 0],
        "vae": ["3", 0],
        "prompt": prompt,
        "width": int(width),
        "height": int(height),
        "length": int(length),
    }
    model_ref = ["31", 0] if turbo_lora else ["11", 0]
    graph: dict[str, Any] = {
        "12": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": clip_name, "type": "minimax", "device": "default"},
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_VIDEO}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_AUDIO}},
        "11": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": model, "weight_dtype": "default"},
        },
        "1": {
            "class_type": "BasicScheduler",
            "inputs": {"model": model_ref, "scheduler": "simple", "steps": int(steps), "denoise": 1.0},
        },
        "6": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "10": {
            "class_type": "BasicGuider",
            "inputs": {"model": model_ref, "conditioning": ["2", 0]},
        },
        "13": {"class_type": "RandomNoise", "inputs": {"noise_seed": noise_seed}},
        "2": {"class_type": "MiniMaxH3ImageToVideo", "inputs": i2v},
        "7": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["13", 0],
                "guider": ["10", 0],
                "sampler": ["6", 0],
                "sigmas": ["1", 0],
                "latent_image": ["2", 1],
            },
        },
        "30": {
            "class_type": "LayerUtility: PurgeVRAM V2",
            "inputs": {"anything": ["7", 0], "purge_cache": True, "purge_models": True},
        },
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["30", 0], "vae": ["3", 0]}},
        "5": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["30", 0], "vae": ["4", 0]}},
        "27": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "images": ["9", 0],
                "audio": ["5", 0],
                "frame_rate": FPS,
                "loop_count": 0,
                "filename_prefix": filename_prefix,
                "format": "video/h264-mp4",
                "pix_fmt": "yuv420p",
                "crf": int(crf),
                "save_metadata": True,
                "trim_to_audio": False,
                "pingpong": False,
                "save_output": True,
            },
        },
    }
    if turbo_lora:
        if "pruned" in model.lower():
            raise ValueError("Turbo LoRA requires the non-pruned H3 time basis; pruned base rejected before submission")
        graph["31"] = {
            "class_type": TURBO4_LOADER,
            "inputs": {
                "model": ["11", 0],
                "lora_name": lora_name,
                "strength_model": float(lora_strength),
            },
        }
    if first_frame_rel:
        i2v["first_frame"] = ["100", 0]
        graph["100"] = {
            "class_type": "LoadImage",
            "inputs": {"image": first_frame_rel.replace("\\", "/")},
        }
    if last_frame_rel:
        i2v["last_frame"] = ["101", 0]
        graph["101"] = {
            "class_type": "LoadImage",
            "inputs": {"image": last_frame_rel.replace("\\", "/")},
        }
    idents = [p for p in (identity_rels or []) if p][:3]
    for i, rel in enumerate(idents):
        nid = str(102 + i)
        i2v[f"identity_{i + 1}"] = [nid, 0]
        graph[nid] = {
            "class_type": "LoadImage",
            "inputs": {"image": str(rel).replace("\\", "/")},
        }
    # H3 自带抽帧：同一张图里从 VAEDecode（节点 9）的帧批里切指定帧存 PNG，
    # 不用 ffmpeg。文件名带 _frameNNNN 供 find_frames 对号。
    for k, idx in enumerate(save_frames or []):
        sel = str(200 + k * 2)
        sav = str(201 + k * 2)
        graph[sel] = {
            "class_type": "ImageFromBatch",
            "inputs": {"image": ["9", 0], "batch_index": int(idx), "length": 1},
        }
        graph[sav] = {
            "class_type": "SaveImage",
            "inputs": {"images": [sel, 0], "filename_prefix": f"{filename_prefix}_frame{int(idx):04d}"},
        }
    return graph


def _attach_io(
    graph: dict[str, Any],
    i2v: dict[str, Any],
    *,
    first_frame_rel: Optional[str],
    last_frame_rel: Optional[str],
    identity_rels: Optional[list[str]],
    save_frames: Optional[list[int]],
    filename_prefix: str,
) -> None:
    if first_frame_rel:
        i2v["first_frame"] = ["100", 0]
        graph["100"] = {
            "class_type": "LoadImage",
            "inputs": {"image": first_frame_rel.replace("\\", "/")},
        }
    if last_frame_rel:
        i2v["last_frame"] = ["101", 0]
        graph["101"] = {
            "class_type": "LoadImage",
            "inputs": {"image": last_frame_rel.replace("\\", "/")},
        }
    idents = [p for p in (identity_rels or []) if p][:3]
    for i, rel in enumerate(idents):
        nid = str(102 + i)
        i2v[f"identity_{i + 1}"] = [nid, 0]
        graph[nid] = {
            "class_type": "LoadImage",
            "inputs": {"image": str(rel).replace("\\", "/")},
        }
    for k, idx in enumerate(save_frames or []):
        sel = str(200 + k * 2)
        sav = str(201 + k * 2)
        graph[sel] = {
            "class_type": "ImageFromBatch",
            "inputs": {"image": ["9", 0], "batch_index": int(idx), "length": 1},
        }
        graph[sav] = {
            "class_type": "SaveImage",
            "inputs": {"images": [sel, 0], "filename_prefix": f"{filename_prefix}_frame{int(idx):04d}"},
        }


def build_graph_sage(
    *,
    prompt: str,
    width: int,
    height: int,
    length: int,
    steps: int,
    model: str,
    filename_prefix: str,
    save_frames: Optional[list[int]] = None,
    first_frame_rel: Optional[str] = None,
    last_frame_rel: Optional[str] = None,
    identity_rels: Optional[list[str]] = None,
    seed: Optional[int] = None,
    crf: int = 14,
    clip_name: str = CLIP_DEFAULT,
    turbo_lora: bool = True,
    lora_name: str = LORA_TURBO4,
    lora_strength: float = 1.0,
    sage_attention: str = "auto",
) -> dict:
    """New workflow turbo4_sage: independent graph, Sage on guider only.

    UNET (+ optional LoRA) → PathchSageAttentionKJ → BasicGuider.
    BasicScheduler stays on the unwrapped model. allow_compile=false.
    kernel: auto (fast, PV fp8 on sm_120) or sageattn_qk_int8_pv_fp16_cuda (HQ).
    """
    if turbo_lora and "pruned" in model.lower():
        raise ValueError("Turbo LoRA requires the non-pruned H3 time basis; pruned base rejected before submission")
    noise_seed = int(seed) if seed is not None else random.randint(1, 2_000_000_000)
    i2v: dict[str, Any] = {
        "clip": ["12", 0],
        "vae": ["3", 0],
        "prompt": prompt,
        "width": int(width),
        "height": int(height),
        "length": int(length),
    }
    raw_model = ["31", 0] if turbo_lora else ["11", 0]
    graph: dict[str, Any] = {
        "12": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": clip_name, "type": "minimax", "device": "default"},
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_VIDEO}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_AUDIO}},
        "11": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": model, "weight_dtype": "default"},
        },
        "40": {
            "class_type": _SAGE_NODE,
            "inputs": {
                "model": raw_model,
                "sage_attention": sage_attention or "auto",
                "allow_compile": False,
            },
        },
        "1": {
            "class_type": "BasicScheduler",
            "inputs": {"model": raw_model, "scheduler": "simple", "steps": int(steps), "denoise": 1.0},
        },
        "6": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "10": {
            "class_type": "BasicGuider",
            "inputs": {"model": ["40", 0], "conditioning": ["2", 0]},
        },
        "13": {"class_type": "RandomNoise", "inputs": {"noise_seed": noise_seed}},
        "2": {"class_type": "MiniMaxH3ImageToVideo", "inputs": i2v},
        "7": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["13", 0],
                "guider": ["10", 0],
                "sampler": ["6", 0],
                "sigmas": ["1", 0],
                "latent_image": ["2", 1],
            },
        },
        "30": {
            "class_type": "LayerUtility: PurgeVRAM V2",
            "inputs": {"anything": ["7", 0], "purge_cache": True, "purge_models": True},
        },
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["30", 0], "vae": ["3", 0]}},
        "5": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["30", 0], "vae": ["4", 0]}},
        "27": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "images": ["9", 0],
                "audio": ["5", 0],
                "frame_rate": FPS,
                "loop_count": 0,
                "filename_prefix": filename_prefix,
                "format": "video/h264-mp4",
                "pix_fmt": "yuv420p",
                "crf": int(crf),
                "save_metadata": True,
                "trim_to_audio": False,
                "pingpong": False,
                "save_output": True,
            },
        },
    }
    if turbo_lora:
        graph["31"] = {
            "class_type": TURBO4_LOADER,
            "inputs": {
                "model": ["11", 0],
                "lora_name": lora_name,
                "strength_model": float(lora_strength),
            },
        }
    _attach_io(
        graph,
        i2v,
        first_frame_rel=first_frame_rel,
        last_frame_rel=last_frame_rel,
        identity_rels=identity_rels,
        save_frames=save_frames,
        filename_prefix=filename_prefix,
    )
    return graph


def interrupt() -> None:
    """Brake the running Comfy graph. Empty 200 is success."""
    url = COMFY_BASE.rstrip("/") + "/interrupt"
    req = urllib.request.Request(
        url, data=b"{}", headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


def delete_queued(prompt_id: str) -> None:
    """Drop a pending/running prompt from Comfy's queue."""
    if not prompt_id:
        return
    http_json("/queue", {"delete": [prompt_id]}, timeout=10)


def submit_graph(graph: dict, client_id: str = "local-h3-api", *,
                 qs_h3_expected_process_token: str) -> str:
    if (not isinstance(qs_h3_expected_process_token, str) or
            not re.fullmatch(r"[0-9a-f]{64}", qs_h3_expected_process_token)):
        raise RuntimeError("Canonical Comfy process token is required for graph admission")
    resp = http_json("/prompt", {
        "client_id": client_id, "prompt": graph,
        "qs_h3_expected_process_token": qs_h3_expected_process_token,
    }, timeout=90)
    if not resp.get("prompt_id") or resp.get("node_errors"):
        raise RuntimeError(resp)
    return resp["prompt_id"]


def _ws_url(client_id: str) -> str:
    base = COMFY_BASE.rstrip("/")
    if base.startswith("https://"):
        ws = "wss://" + base[len("https://") :]
    elif base.startswith("http://"):
        ws = "ws://" + base[len("http://") :]
    else:
        ws = "ws://" + base
    return f"{ws}/ws?clientId={client_id}"


class ComfyProgressWatcher:
    """Connect Comfy websocket BEFORE submit to capture full progress."""

    def __init__(self, client_id: str, on_event: Optional[Any] = None):
        self.client_id = client_id
        self.on_event = on_event
        self._stop = False
        self._ws = None
        self._thread: Optional[threading.Thread] = None
        self._active_prompt_id: Optional[str] = None

    def start(self) -> None:
        try:
            import websocket  # noqa: F401
        except ImportError:
            if self.on_event:
                self.on_event({"type": "ws_warn", "message": "websocket-client not installed; polling only"})
            return
        self._thread = threading.Thread(target=self._loop, daemon=True, name=f"comfy-ws-{self.client_id[:12]}")
        self._thread.start()
        # brief wait for socket connect
        for _ in range(20):
            if self._ws is not None:
                break
            time.sleep(0.05)

    def set_prompt_id(self, prompt_id: str) -> None:
        self._active_prompt_id = prompt_id

    def stop(self) -> None:
        self._stop = True
        try:
            if self._ws:
                self._ws.close()
        except Exception:
            pass

    def _should_accept(self, data: dict) -> bool:
        pid = data.get("prompt_id")
        if self._active_prompt_id:
            if pid:
                return pid == self._active_prompt_id
            # Comfy often omits prompt_id on progress events for the active client
            return True
        # before prompt_id is set, accept events on this dedicated client socket
        return True

    def _emit(self, ev: dict) -> None:
        if self.on_event:
            try:
                self.on_event(ev)
            except Exception:
                pass

    def _loop(self) -> None:
        try:
            import websocket  # type: ignore

            ws = websocket.WebSocket()
            ws.settimeout(5)
            ws.connect(_ws_url(self.client_id))
            self._ws = ws
            while not self._stop:
                try:
                    raw = ws.recv()
                except Exception:
                    continue
                if not raw or not isinstance(raw, str):
                    continue
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                mtype = msg.get("type")
                data = msg.get("data") or {}
                if not self._should_accept(data):
                    continue
                if mtype == "progress":
                    value, mx, pct = node_counters(data.get("value"), data.get("max"))
                    self._emit(
                        {
                            "type": "progress",
                            "value": value,
                            "max": mx,
                            "percent": pct,
                            "node": data.get("node"),
                        }
                    )
                elif mtype == "executing":
                    self._emit({"type": "executing", "node": data.get("node")})
                elif mtype == "execution_cached":
                    self._emit({"type": "cached", "nodes": data.get("nodes")})
                elif mtype in ("execution_start", "status"):
                    self._emit({"type": mtype, "data": data})
                elif mtype in ("execution_error", "execution_interrupted"):
                    self._emit({"type": "error", "data": data})
        except Exception as e:
            self._emit({"type": "ws_warn", "message": str(e)[:300]})


def wait_prompt(
    prompt_id: str,
    timeout: float = 9000,
    poll: float = 2.0,
    client_id: Optional[str] = None,
    on_event: Optional[Any] = None,
    watcher: Optional[ComfyProgressWatcher] = None,
    should_abort: Optional[Any] = None,
) -> dict:
    """Wait for Comfy history; stream progress via pre-connected websocket watcher."""
    t0 = time.time()

    def _cb(ev: dict) -> None:
        if on_event:
            try:
                on_event(ev)
            except Exception:
                pass

    if watcher:
        watcher.set_prompt_id(prompt_id)

    try:
        last_queue = None
        while time.time() - t0 < timeout:
            if should_abort and should_abort():
                try:
                    delete_queued(prompt_id)
                except Exception:
                    pass
                try:
                    interrupt()
                except Exception:
                    pass
                raise RuntimeError("cancelled")
            try:
                hist = http_json("/history/" + prompt_id, timeout=60)
            except Exception:
                time.sleep(poll)
                continue
            if prompt_id in hist:
                _cb({"type": "history", "status": (hist[prompt_id].get("status") or {}).get("status_str")})
                return hist[prompt_id]

            # fallback progress via queue position when WS unavailable
            if on_event:
                try:
                    q = http_json("/queue", timeout=10)
                    running = q.get("queue_running") or []
                    pending = q.get("queue_pending") or []
                    pos = None
                    state = "waiting"
                    for item in running:
                        if len(item) > 1 and item[1] == prompt_id:
                            pos = 0
                            state = "running"
                            break
                    if pos is None:
                        for i, item in enumerate(pending):
                            if len(item) > 1 and item[1] == prompt_id:
                                pos = i + 1
                                state = "pending"
                                break
                    snap = (state, pos, len(running), len(pending))
                    if snap != last_queue:
                        last_queue = snap
                        _cb(
                            {
                                "type": "queue",
                                "queue_state": state,
                                "queue_position": pos,
                                "queue_running": len(running),
                                "queue_pending": len(pending),
                            }
                        )
                except Exception:
                    pass
                _cb({"type": "heartbeat", "elapsed_sec": round(time.time() - t0, 1)})
            time.sleep(poll)
        raise TimeoutError(prompt_id)
    finally:
        if watcher:
            watcher.stop()


def find_frames(entry: dict) -> list[str]:
    """Collect SaveImage PNG outputs (H3 native frame extraction) from a history entry."""
    out: list[str] = []
    for o in (entry.get("outputs") or {}).values():
        for img in o.get("images") or []:
            if (img.get("type") or "output") != "output":
                continue
            name = img.get("filename") or ""
            if "_frame" not in name:
                continue
            fp = COMFY_ROOT / "output" / (img.get("subfolder") or "") / name
            if fp.exists():
                out.append(str(fp))
    return out


def find_video(entry: dict, fallback_dir: Optional[Path] = None) -> Optional[str]:
    for o in (entry.get("outputs") or {}).values():
        for g in o.get("gifs") or []:
            fp = g.get("fullpath")
            if fp and os.path.exists(fp) and str(fp).lower().endswith(".mp4"):
                return fp
        for img in o.get("images") or []:
            # some builds only list images; ignore
            pass
    if fallback_dir and fallback_dir.exists():
        cands = sorted(fallback_dir.glob("**/*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
        return str(cands[0]) if cands else None
    return None


def save_upload(job_id: str, filename: str, data: bytes) -> str:
    """Save bytes under Comfy input/LocalAPI/<job_id>/ and return relative path for LoadImage."""
    dest_dir = INP_ROOT / job_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    safe = Path(filename).name
    path = dest_dir / safe
    path.write_bytes(data)
    # LoadImage path is relative to Comfy input/
    return f"LocalAPI/{job_id}/{safe}"


def copy_output(src: str, job_id: str, name: str = "result.mp4") -> Path:
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    dest_dir = OUT_ROOT / job_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / name
    shutil.copy2(src, dest)
    return dest
