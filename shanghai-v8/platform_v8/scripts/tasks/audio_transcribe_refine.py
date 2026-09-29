#!/usr/bin/env python3
"""音频智能分析 · Whisper.cpp ASR (+ faster-whisper 兜底)

ASR 优先 whisper-cli（默认 ggml-base），输入先经 ffmpeg 统一转成 16kHz 单声道 WAV。
whisper-cli 若 GGML 原生崩溃 / 无 JSON 产出，自动 fallback 到 faster-whisper。
params.outputs 可多选: srt / dialogue（默认全选）。
协议：EC_PARAMS + EC_INPUT_DIR / stdin · 输出 result_files_b64。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time

MAX_AUDIO_BYTES = 512 * 1024 * 1024
DEFAULT_OUTPUTS = ("srt", "dialogue")
# Windows abort / STATUS_STACK_BUFFER_OVERRUN · whisper.cpp GGML_ASSERT 常见退出码
_GGML_CRASH_EXITS = {3221226505, -1073740791, 0xC0000409}


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "") or "{}"
    try:
        p = json.loads(raw)
        return p if isinstance(p, dict) else {}
    except Exception:
        return {}


def _processing_receipt(output_names: list[str]) -> dict:
    """Bind this per-file result to the server-issued input manifest."""
    path = os.environ.get("EC_INPUT_MANIFEST", "")
    if not path:
        return {}
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
        manifest = json.loads(raw)
        entries = manifest.get("entries")
        if not isinstance(entries, list) or len(entries) != 1:
            return {}
        # Match InputEntryV1.model_dump(): older dispatchers omitted optional
        # fields, but the verifier hashes the canonical Pydantic representation.
        for entry in entries:
            if isinstance(entry, dict):
                entry.setdefault("object_key", "")
                entry.setdefault("fetch_ref", "")
                entry.setdefault("sha256", "")
                entry.setdefault("content_type", "application/octet-stream")
                entry.setdefault("selector", {})
        digest = hashlib.sha256(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        input_id = str(entries[0].get("id") or "")
        if not input_id:
            return {}
        return {
            "schema": "processing_receipt.v1",
            "input_manifest_sha256": digest,
            "items": [{
                "input_id": input_id,
                "status": "succeeded",
                "outputs": [{"name": name} for name in sorted(output_names)],
            }],
        }
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return {}


def _fail(msg: str, exc: Exception | None = None, **extra) -> int:
    out = {
        "status": "failed",
        "contract_version": "1",
        "task_type": "audio_transcribe_refine",
        "error": msg,
        "elapsed_ms": 0,
    }
    if exc is not None:
        out["detail"] = f"{type(exc).__name__}: {exc}"
    out.update(extra)
    print(json.dumps(out, ensure_ascii=False))
    return 1


def _fmt_ts_srt(sec: float) -> str:
    ms = int(round(sec * 1000))
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{milli:03d}"


def _build_srt(segs: list[dict]) -> str:
    parts = []
    for i, s in enumerate(segs):
        parts.append(
            f"{i + 1}\n{_fmt_ts_srt(s['start'])} --> {_fmt_ts_srt(s['end'])}\n{s['text']}\n"
        )
    return "\n".join(parts)


def _build_dialogue_txt(segs: list[dict]) -> str:
    lines = []
    for s in segs:
        sp = s.get("speaker") or "SPEAKER_01"
        lines.append(f"[{_fmt_ts_srt(s['start'])[:8]}] {sp}: {s['text']}")
    return "\n".join(lines)


def _read_audio(p: dict) -> tuple[str, bytes] | None:
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if input_dir and os.path.isdir(input_dir):
        inputs: list[str] = []
        for root, _dirs, files in os.walk(input_dir):
            for name in sorted(files):
                # P2 节点会把输入身份合同写到同一临时目录；它不是音频。
                if name == "input_manifest.v1.json":
                    continue
                path = os.path.join(root, name)
                if not os.path.isfile(path):
                    continue
                inputs.append(path)
        # 每个 audio_transcribe_refine shard 恰好对应一个音频。若协议或节点下载
        # 逻辑把多个文件塞进同一目录，拒绝而非隐式只转写排序第一份。
        if len(inputs) > 1:
            raise ValueError(
                f"音频分片包含 {len(inputs)} 个输入文件；该任务每片只能处理一个文件"
            )
        if len(inputs) == 1:
            path = inputs[0]
            with open(path, "rb") as fh:
                return os.path.basename(path), fh.read()
    try:
        raw = sys.stdin.buffer.read()
    except Exception:
        raw = b""
    if raw:
        return "stdin.audio", raw
    b64 = p.get("audio_b64")
    if isinstance(b64, str) and b64:
        return "audio.bin", base64.b64decode(b64)
    return None


def _is_exe(path: str) -> bool:
    """Windows 上 os.access(X_OK) 偶发不可靠 · 有文件即可。"""
    if not path or not os.path.isfile(path):
        return False
    if sys.platform == "win32":
        return True
    return os.access(path, os.X_OK)


def _whisper_cli_path() -> str | None:
    """优先托管目录 · 再 which · 避免 PATH 上误找到 tiers/ffmpeg/bin 混装副本。"""
    for key in ("EC_WHISPER_CLI", "WHISPER_CLI"):
        p = os.environ.get(key, "").strip()
        if _is_exe(p):
            return p
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".qianshou", "whisper", "runtime", "bin", "whisper-cli"),
        os.path.join(home, ".qianshou", "runtime", "shims", "whisper-cli"),
    ]
    if sys.platform == "win32":
        candidates = [c if c.endswith(".exe") else c + ".exe" for c in candidates]
    for c in candidates:
        if _is_exe(c):
            return c
    for name in ("whisper-cli", "whisper"):
        found = shutil.which(name)
        if found and _is_exe(found):
            # 跳过 ffmpeg tier 里误放的 whisper-cli（DLL 混用风险）
            norm = os.path.normcase(found)
            if f"{os.sep}tiers{os.sep}ffmpeg{os.sep}bin{os.sep}" in norm:
                continue
            return found
    return None


def _whisper_model_path(model_size: str) -> str | None:
    name = f"ggml-{model_size}.bin"
    env = os.environ.get("EC_WHISPER_MODEL", "").strip()
    if env and os.path.isfile(env):
        return env
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".qianshou", "models", "whisper", name),
        os.path.join(home, ".qianshou", "whisper", "models", name),
        os.path.join(home, ".qianshou", "models", "faster-whisper", name),
        name,
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def _ffmpeg_bin() -> str | None:
    """解析客户端注入或当前运行时提供的 ffmpeg 可执行文件。"""
    env_path = (os.environ.get("EC_FFMPEG") or "").strip()
    if _is_exe(env_path):
        return env_path

    binaries_json = (os.environ.get("EC_TIER_BINARIES_JSON") or "").strip()
    if binaries_json:
        try:
            binaries = json.loads(binaries_json)
            managed_path = str(binaries.get("ffmpeg") or "").strip()
            if _is_exe(managed_path):
                return managed_path
        except (AttributeError, TypeError, json.JSONDecodeError):
            pass

    path_binary = shutil.which("ffmpeg")
    if path_binary and _is_exe(path_binary):
        return path_binary

    home = os.path.expanduser("~")
    managed_dirs = [
        os.path.join(home, ".qianshou", "runtime", "tiers", "ffmpeg", "bin"),
        os.path.join(home, ".qianshou", "runtime", "shims"),
        os.path.join(
            home,
            ".qianshou",
            "runtime",
            "venvs",
            "ffmpeg",
            "Lib",
            "site-packages",
            "imageio_ffmpeg",
            "binaries",
        ),
        os.path.join(
            home,
            ".qianshou",
            "runtime",
            "venvs",
            "ffmpeg",
            "lib",
            "site-packages",
            "imageio_ffmpeg",
            "binaries",
        ),
    ]
    for d in managed_dirs:
        if not os.path.isdir(d):
            continue
        direct = os.path.join(d, "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")
        if _is_exe(direct):
            return direct
        try:
            names = sorted(os.listdir(d), key=len, reverse=True)
        except OSError:
            continue
        for name in names:
            low = name.lower()
            if low.startswith("ffmpeg") and (
                low == "ffmpeg"
                or low == "ffmpeg.exe"
                or low.startswith("ffmpeg-")
                or low.startswith("ffmpeg.")
            ):
                cand = os.path.join(d, name)
                if _is_exe(cand):
                    return cand

    try:
        import imageio_ffmpeg

        bundled_path = imageio_ffmpeg.get_ffmpeg_exe()
        if bundled_path and _is_exe(bundled_path):
            return bundled_path
    except (ImportError, OSError):
        pass
    return None


def _speech_python() -> str | None:
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".qianshou", "runtime", "venvs", "speech", "Scripts", "python.exe"),
        os.path.join(home, ".qianshou", "runtime", "venvs", "speech", "bin", "python"),
        os.path.join(home, ".qianshou", "runtime", "venvs", "speech", "bin", "python3"),
    ]
    for c in candidates:
        if _is_exe(c):
            return c
    return None


def _parse_whisper_json(raw: str) -> tuple[list[dict], str]:
    """解析 whisper-cli -oj 输出。"""
    data = json.loads(raw)
    segs: list[dict] = []
    lang = "unknown"
    if isinstance(data, dict):
        lang = str(data.get("language") or data.get("result", {}).get("language") or "unknown")
        transcription = data.get("transcription") or data.get("segments") or []
        if isinstance(data.get("result"), dict) and not transcription:
            transcription = data["result"].get("transcription") or data["result"].get("segments") or []
        for s in transcription:
            if not isinstance(s, dict):
                continue
            text = (s.get("text") or "").strip()
            if not text:
                continue
            start = s.get("start")
            end = s.get("end")
            if start is None or end is None:
                offsets = s.get("offsets") or {}
                if isinstance(offsets, dict):
                    if "from" in offsets:
                        start = float(offsets["from"]) / 1000.0
                    if "to" in offsets:
                        end = float(offsets["to"]) / 1000.0
            try:
                start_f = float(start or 0)
                end_f = float(end or start_f)
            except (TypeError, ValueError):
                start_f, end_f = 0.0, 0.0
            segs.append(
                {
                    "start": round(start_f, 2),
                    "end": round(end_f, 2),
                    "text": text,
                    "speaker": "SPEAKER_01",
                }
            )
    return segs, lang


def _looks_like_ggml_crash(returncode: int | None, err: str) -> bool:
    if returncode in _GGML_CRASH_EXITS:
        return True
    if returncode is not None and (returncode & 0xFFFFFFFF) in _GGML_CRASH_EXITS:
        return True
    low = (err or "").lower()
    return "ggml_assert" in low or "ggml-backend.cpp" in low


def _whisper_cli_env(cli: str) -> dict:
    """固定 DLL 搜索到 cli 目录 · 强制 CPU · 剔除混装 whisper 的 ffmpeg tier bin。"""
    env = os.environ.copy()
    env["GGML_CUDA_DISABLE"] = "1"
    env["CUDA_VISIBLE_DEVICES"] = ""
    env["HIP_VISIBLE_DEVICES"] = ""
    cli_dir = os.path.dirname(os.path.abspath(cli))
    sep = os.pathsep
    parts: list[str] = [cli_dir]
    for p in (env.get("PATH") or "").split(sep):
        if not p:
            continue
        norm = os.path.normcase(os.path.abspath(p))
        if norm == os.path.normcase(cli_dir):
            continue
        # 避免 PATH 上的 tiers/ffmpeg/bin 抢加载 ggml/whisper DLL
        if f"{os.sep}tiers{os.sep}ffmpeg{os.sep}bin" in norm:
            continue
        parts.append(p)
    env["PATH"] = sep.join(parts)
    return env


def _transcribe_faster_whisper(wav_path: str, p: dict) -> tuple[list[dict], str, str]:
    """faster-whisper 兜底 · 当前解释器或 speech venv。"""
    model_size = str(p.get("whisper_model") or p.get("model") or "base").strip() or "base"
    if model_size not in {"tiny", "base", "small", "medium", "large"}:
        model_size = "base"
    lang = p.get("language") or None
    if isinstance(lang, str) and lang.strip() == "":
        lang = None

    download_root = os.path.expanduser("~/.qianshou/models/faster-whisper")
    os.makedirs(download_root, exist_ok=True)

    def _run_in_process() -> tuple[list[dict], str]:
        from faster_whisper import WhisperModel

        try:
            model = WhisperModel(
                model_size,
                device="cpu",
                compute_type="int8",
                download_root=download_root,
                local_files_only=True,
            )
        except Exception:
            if not (os.environ.get("HF_ENDPOINT") or "").strip():
                os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
            os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
            os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")
            model = WhisperModel(
                model_size,
                device="cpu",
                compute_type="int8",
                download_root=download_root,
            )
        segments, info = model.transcribe(
            wav_path,
            beam_size=int(p.get("beam_size", 5)),
            language=lang,
            vad_filter=bool(p.get("vad", True)),
        )
        segs = [
            {
                "start": round(s.start, 2),
                "end": round(s.end, 2),
                "text": (s.text or "").strip(),
                "speaker": "SPEAKER_01",
            }
            for s in segments
            if (s.text or "").strip()
        ]
        return segs, getattr(info, "language", "unknown")

    last: Exception | None = None
    try:
        segs, detected = _run_in_process()
        return segs, (detected if not lang else str(lang)), "faster-whisper"
    except ImportError:
        pass
    except Exception as exc:
        last = exc

    speech_py = _speech_python()
    if not speech_py:
        if last is not None:
            raise RuntimeError(f"faster-whisper 兜底失败 · {last}") from last
        raise RuntimeError("缺 faster-whisper · 且未找到 speech venv")

    import subprocess

    helper = r"""
import json, os, sys
wav, model_size, lang, download_root, beam, vad = sys.argv[1:7]
lang = None if lang in ("", "None", "null") else lang
vad = vad.lower() in ("1", "true", "yes", "on")
beam = int(beam)
from faster_whisper import WhisperModel
try:
    model = WhisperModel(model_size, device="cpu", compute_type="int8",
                         download_root=download_root, local_files_only=True)
except Exception:
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")
    model = WhisperModel(model_size, device="cpu", compute_type="int8",
                         download_root=download_root)
segments, info = model.transcribe(wav, beam_size=beam, language=lang, vad_filter=vad)
segs = [{"start": round(s.start, 2), "end": round(s.end, 2),
         "text": (s.text or "").strip(), "speaker": "SPEAKER_01"}
        for s in segments if (s.text or "").strip()]
print(json.dumps({"segs": segs, "lang": getattr(info, "language", "unknown")}, ensure_ascii=False))
"""
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(
        [
            speech_py,
            "-c",
            helper,
            wav_path,
            model_size,
            str(lang),
            download_root,
            str(int(p.get("beam_size", 5))),
            "1" if bool(p.get("vad", True)) else "0",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=int(p.get("asr_timeout_s") or 600),
        env=env,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()[:800]
        raise RuntimeError(f"faster-whisper 兜底失败 (exit={proc.returncode}) · {err or '无输出'}")
    raw = (proc.stdout or "").strip().splitlines()
    if not raw:
        raise RuntimeError("faster-whisper 兜底无输出")
    data = json.loads(raw[-1])
    segs = data.get("segs") or []
    detected = str(data.get("lang") or "unknown")
    return segs, (detected if not lang else str(lang)), "faster-whisper"


def _transcribe_whisper_cli(wav_path: str, p: dict, *, model_size: str, lang) -> tuple[list[dict], str, str]:
    import subprocess

    cli = _whisper_cli_path()
    if not cli:
        raise RuntimeError("未找到 whisper-cli · 请安装 whisper.cpp")
    model_path = _whisper_model_path(model_size)
    if not model_path:
        raise RuntimeError(f"未找到 ggml-{model_size}.bin · 请安装 Whisper {model_size} 模型")

    out_dir = tempfile.mkdtemp(prefix="ec-whisper-cli-")
    try:
        out_prefix = os.path.join(out_dir, "out")
        out_json = out_prefix + ".json"
        cmd = [
            cli,
            "-m", model_path,
            "-f", wav_path,
            "-of", out_prefix,
            "-oj",
            "-np",
            "-l", str(lang) if lang else "auto",
        ]
        cli_dir = os.path.dirname(os.path.abspath(cli))
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=int(p.get("asr_timeout_s") or 600),
            cwd=cli_dir,
            env=_whisper_cli_env(cli),
        )
        if os.path.isfile(out_json):
            with open(out_json, "r", encoding="utf-8") as fh:
                segs, detected = _parse_whisper_json(fh.read())
            if proc.returncode not in (0, None) and not segs:
                err = (proc.stderr or "").strip()[:500]
                raise RuntimeError(f"ASR 失败 (exit={proc.returncode}) · {err}")
            return segs, (detected if not lang else str(lang)), "whisper.cpp"

        raw_out = (proc.stdout or "").strip()
        if raw_out.startswith("{"):
            try:
                segs, detected = _parse_whisper_json(raw_out)
                return segs, detected if not lang else str(lang), "whisper.cpp"
            except Exception:
                pass
        err = (proc.stderr or proc.stdout or "").strip()[:800]
        raise RuntimeError(
            f"whisper-cli 未产出 JSON (exit={proc.returncode}) · {err or '无输出'}"
        )
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


def _transcribe(path: str, p: dict) -> tuple[list[dict], str, str]:
    """ffmpeg 预处理后 whisper-cli · 失败则 faster-whisper 兜底。"""
    import subprocess

    model_size = str(p.get("whisper_model") or p.get("model") or "base").strip() or "base"
    if model_size not in {"tiny", "base", "small", "medium", "large"}:
        model_size = "base"
    lang = p.get("language") or None
    if isinstance(lang, str) and lang.strip() == "":
        lang = None

    prefer = str(p.get("asr_backend") or "").strip().lower()
    out_dir = tempfile.mkdtemp(prefix="ec-whisper-")
    try:
        prepared_audio = os.path.join(out_dir, "input.wav")
        ffmpeg = _ffmpeg_bin()
        if not ffmpeg:
            raise RuntimeError("未找到 ffmpeg · 无法预处理音频")
        converted = subprocess.run(
            [
                ffmpeg, "-y", "-i", path,
                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
                prepared_audio,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=int(p.get("ffmpeg_timeout_s") or 300),
        )
        if converted.returncode != 0 or not os.path.isfile(prepared_audio):
            err = (converted.stderr or converted.stdout or "").strip()[-800:]
            raise RuntimeError(f"ffmpeg 音频预处理失败 · {err or converted.returncode}")

        if prefer in {"faster_whisper", "faster-whisper"}:
            return _transcribe_faster_whisper(prepared_audio, p)

        cli_err: Exception | None = None
        try:
            return _transcribe_whisper_cli(
                prepared_audio, p, model_size=model_size, lang=lang
            )
        except Exception as exc:
            cli_err = exc
            msg = str(exc)
            rc = None
            if "exit=" in msg:
                try:
                    rc = int(msg.split("exit=", 1)[1].split(")", 1)[0].split(" ")[0])
                except Exception:
                    rc = None
            # 无 cli / GGML崩溃 / 未产出 JSON → 走兜底；其它错误也尝试兜底一次
            allow_fallback = (
                prefer in {"", "auto", "whisper", "whisper.cpp", "whisper-cli"}
                and (
                    _looks_like_ggml_crash(rc, msg)
                    or "未找到 whisper-cli" in msg
                    or "未产出 JSON" in msg
                    or "ASR 失败" in msg
                )
            )
            if not allow_fallback:
                raise
            try:
                segs, detected, backend = _transcribe_faster_whisper(prepared_audio, p)
                # 兜底成功 · backend 标注来源
                return segs, detected, f"{backend}(fallback)"
            except Exception as fb_exc:
                raise RuntimeError(
                    f"{cli_err} · 且 faster-whisper 兜底失败: {fb_exc}"
                ) from fb_exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("音频处理超时") from exc
    except FileNotFoundError as exc:
        raise RuntimeError("whisper-cli 或 ffmpeg 无法执行") from exc
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


def _parse_outputs(p: dict) -> set[str]:
    """解析多选产出：srt / dialogue；旧 story 参数会被安全忽略。"""
    alias = {
        "srt": "srt",
        "subtitle": "srt",
        "subtitles": "srt",
        "字幕": "srt",
        "dialogue": "dialogue",
        "dialog": "dialogue",
        "txt": "dialogue",
        "text": "dialogue",
        "对话": "dialogue",
        "对话文本": "dialogue",
    }
    raw = p.get("outputs")
    if raw is None:
        raw = p.get("result_types")
    items: list = []
    if isinstance(raw, str):
        items = [x.strip() for x in raw.replace("|", ",").split(",") if x.strip()]
    elif isinstance(raw, (list, tuple)):
        items = list(raw)
    elif isinstance(raw, dict):
        items = [
            k for k, v in raw.items()
            if v is True or str(v).strip().lower() in ("1", "true", "yes", "on")
        ]
    out: set[str] = set()
    for it in items:
        key = alias.get(str(it).strip().lower()) or alias.get(str(it).strip())
        if key:
            out.add(key)
    if not out:
        out = set(DEFAULT_OUTPUTS)
    return out


def main() -> int:
    t0 = time.time()
    p = _params()
    try:
        got = _read_audio(p)
    except ValueError as exc:
        return _fail(str(exc))
    if not got:
        return _fail("无音频输入 · 检查 EC_INPUT_DIR / stdin / params.audio_b64")
    fname, audio_bytes = got
    if not audio_bytes:
        return _fail("音频数据为空")
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        return _fail("音频超过 512MiB 上限")

    outputs = _parse_outputs(p)

    tmp = tempfile.NamedTemporaryFile(suffix="_" + os.path.basename(fname), delete=False)
    try:
        tmp.write(audio_bytes)
        tmp.close()
        try:
            segs, lang, backend = _transcribe(tmp.name, p)
        except RuntimeError as exc:
            return _fail(str(exc), None, hint="请确认 whisper-cli、ggml 模型和 ffmpeg 已安装")
        except Exception as exc:
            return _fail("ASR 失败", exc)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    stem = os.path.splitext(os.path.basename(fname))[0] or "audio"
    srt = _build_srt(segs)
    dialogue = _build_dialogue_txt(segs)
    meta = {
        "filename": fname,
        "language": lang,
        "backend": backend,
        "segments_count": len(segs),
        "outputs": sorted(outputs),
        "segments": segs,
    }
    files: dict[str, str] = {}
    if "srt" in outputs:
        files[f"{stem}.srt"] = base64.b64encode(srt.encode("utf-8")).decode("ascii")
    if "dialogue" in outputs:
        files[f"{stem}_dialogue.txt"] = base64.b64encode(dialogue.encode("utf-8")).decode("ascii")
    files[f"{stem}.json"] = base64.b64encode(
        json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8")
    ).decode("ascii")

    labels = []
    if "srt" in outputs:
        labels.append("字幕")
    if "dialogue" in outputs:
        labels.append("对话")
    elapsed_ms = int((time.time() - t0) * 1000)
    report = {
        "status": "ok",
        "contract_version": "1",
        "task_type": "audio_transcribe_refine",
        "elapsed_ms": elapsed_ms,
        "result_files_b64": files,
        "processing_receipt": _processing_receipt(list(files)),
        "results": [
            {
                "filename": fname,
                "language": lang,
                "segments_count": len(segs),
                "backend": backend,
                "outputs": sorted(outputs),
            }
        ],
        "summary": {
            "total_files": 1,
            "segments": len(segs),
            "outputs": sorted(outputs),
        },
        "summary_text": (
            f"OK ASR {backend} · {len(segs)} 段 · 产出 {'+'.join(labels) or 'JSON'} · {elapsed_ms}ms"
        ),
    }
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
