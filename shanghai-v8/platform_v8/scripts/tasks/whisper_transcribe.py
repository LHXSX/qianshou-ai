#!/usr/bin/env python3
"""whisper_transcribe — 语音转文字 (企业级 · 2026-06-07 S5 升级)

支持:
  - stdin binary / EC_INPUT_DIR (single_file 或 multi_file)
  - faster-whisper 主路径 + openai-whisper fallback
  - 自动语言检测 + language hint
  - VAD 过滤静音(faster-whisper 内置)
  - 多字幕格式输出: SRT / VTT / plain text / JSON segments
  - 详细错误回路 (含 ffmpeg/cuda 缺失提示)

参数 (EC_PARAMS):
  model          str     tiny/base/small/medium/large-v3 (默认 base)
  quality        str     企业端快捷档: fast / standard / precise
                         (未显式传 model 时映射为 tiny/base/small + beam)
  language       str     语言 hint · 留空自动 (zh/en/ja ...)
  format         str     输出: srt / vtt / text|txt / json / all (默认 all)
  vad            bool    VAD 过滤静音 (默认 true · 长音频提速 30%)
  beam_size      int     beam 搜索 (默认 5 · 越大越准越慢)
  temperature    float   采样温度 0-1 (默认 0)
  device         str     cpu / cuda / auto (默认 auto)
  compute_type   str     int8 / float16 / float32 (默认 int8 · CPU 友好)
"""
import base64
import json
import os
import sys
import tempfile
import time


MAX_AUDIO_BYTES = 512 * 1024 * 1024
MAX_OUTPUT_CHARS = 5_000_000

# 企业端「识别质量」→ model / beam（显式 model 优先）
_QUALITY_PRESETS = {
    "fast": {"model": "tiny", "beam_size": 1},
    "standard": {"model": "base", "beam_size": 5},
    "precise": {"model": "small", "beam_size": 8},
}


def _slice_window() -> tuple[float | None, float | None]:
    """兼容 duration slicer 的 start_s/end_s 与 start_sec/end_sec。"""
    try:
        meta = json.loads(os.environ.get("EC_SLICE_META", "{}") or "{}")
    except json.JSONDecodeError:
        return None, None
    if not isinstance(meta, dict):
        return None, None
    try:
        start = meta.get("start_s", meta.get("start_sec"))
        end = meta.get("end_s", meta.get("end_sec"))
        return (
            float(start) if start is not None else None,
            float(end) if end is not None else None,
        )
    except (TypeError, ValueError):
        return None, None


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _fail(msg: str, exc=None, hint: str = ""):
    err = str(exc) if exc else msg
    out = {
        "status": "failed", "task_type": "whisper_transcribe",
        "error": err, "summary_text": "❌ " + msg,
    }
    if hint:
        out["hint"] = hint
    print(json.dumps(out, ensure_ascii=False))
    return 1


def _read_audio_inputs(p: dict) -> list:
    """返 [(filename, bytes), ...] · 支持 multi_file / single_file / inline / stdin"""
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    input_kind = os.environ.get("EC_INPUT_KIND", "")

    _AUDIO_EXTS = (".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac", ".webm",
                   ".mp4", ".mov", ".mkv")  # 含含视频 · ffmpeg 自动抽音

    if input_kind == "multi_file" and input_dir and os.path.isdir(input_dir):
        out = []
        for fname in sorted(os.listdir(input_dir)):
            fp = os.path.join(input_dir, fname)
            if os.path.isfile(fp) and fname.lower().endswith(_AUDIO_EXTS):
                with open(fp, "rb") as fh:
                    out.append((fname, fh.read()))
        return out

    if input_dir and os.path.isdir(input_dir):
        for fname in os.listdir(input_dir):
            fp = os.path.join(input_dir, fname)
            if os.path.isfile(fp):
                with open(fp, "rb") as fh:
                    return [(fname, fh.read())]

    # stdin
    try:
        raw = sys.stdin.buffer.read()
    except Exception:
        raw = b""
    if not raw:
        return []
    if raw[:1] in (b"{", b"["):
        try:
            obj = json.loads(raw.decode("utf-8"))
            if isinstance(obj, dict):
                if obj.get("audio_b64"):
                    p.update(obj.get("params", {}))
                    return [("inline.bin", base64.b64decode(obj["audio_b64"]))]
                # 反向覆盖 params(若 stdin 是 {params:...} 形态)
                p.update(obj.get("params", {}))
        except Exception:
            pass
    return [("stdin.bin", raw)]


def _fmt_ts_srt(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s_full = t % 60
    s = int(s_full)
    ms = int((s_full - s) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _fmt_ts_vtt(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s_full = t % 60
    s = int(s_full)
    ms = int((s_full - s) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def _build_srt(segs: list) -> str:
    parts = []
    for i, s in enumerate(segs):
        parts.append(f"{i+1}\n{_fmt_ts_srt(s['start'])} --> {_fmt_ts_srt(s['end'])}\n{s['text']}\n")
    return "\n".join(parts)


def _build_vtt(segs: list) -> str:
    parts = ["WEBVTT\n"]
    for s in segs:
        parts.append(f"{_fmt_ts_vtt(s['start'])} --> {_fmt_ts_vtt(s['end'])}\n{s['text']}\n")
    return "\n".join(parts)


def _resolve_model_beam(p: dict) -> tuple[str, int]:
    """显式 model/beam_size 优先；否则按 quality 快捷档映射。"""
    quality = str(p.get("quality") or "").strip().lower()
    preset = _QUALITY_PRESETS.get(quality) or {}
    model_size = p.get("model") or preset.get("model") or "base"
    if p.get("beam_size") is not None:
        beam_size = int(p.get("beam_size"))
    else:
        beam_size = int(preset.get("beam_size") or 5)
    return str(model_size), beam_size


def _transcribe_one(audio_path: str, p: dict) -> tuple:
    """返 (segments, detected_lang, backend)"""
    model_size, beam_size = _resolve_model_beam(p)
    lang = p.get("language") or None
    temperature = float(p.get("temperature", 0))
    vad = bool(p.get("vad", True))
    device = p.get("device", "auto")
    compute_type = p.get("compute_type", "int8")

    try:
        from faster_whisper import WhisperModel
        # auto device
        actual_device = device
        if device == "auto":
            try:
                import torch
                actual_device = "cuda" if torch.cuda.is_available() else "cpu"
            except ImportError:
                actual_device = "cpu"
        model = WhisperModel(model_size, device=actual_device, compute_type=compute_type)
        segments, info = model.transcribe(
            audio_path, beam_size=beam_size, language=lang,
            temperature=temperature, vad_filter=vad,
        )
        segs = [{
            "start": round(s.start, 2),
            "end": round(s.end, 2),
            "text": (s.text or "").strip(),
        } for s in segments]
        return segs, info.language, "faster-whisper"
    except ImportError:
        pass

    # fallback openai-whisper
    try:
        import whisper as _whisper
    except ImportError:
        raise ImportError("缺 faster-whisper · 推荐: pip install faster-whisper")

    model = _whisper.load_model(model_size)
    r = model.transcribe(audio_path, language=lang, temperature=temperature)
    segs = [{
        "start": round(s["start"], 2),
        "end": round(s["end"], 2),
        "text": (s["text"] or "").strip(),
    } for s in r["segments"]]
    return segs, r.get("language", "unknown"), "openai-whisper"


def main():
    t0 = time.time()
    p = _params()
    slice_start, slice_end = _slice_window()
    inputs = _read_audio_inputs(p)
    if not inputs:
        return _fail("无音频输入 · 检查 EC_INPUT_DIR / stdin / params.audio_b64",
                     hint="支持格式: mp3/m4a/wav/flac/mp4/mov/mkv 等(ffmpeg 自动抽音)")

    fmt_out = (p.get("format") or "all").lower()
    if fmt_out in ("txt", "plain", "plaintext"):
        fmt_out = "text"
    if fmt_out not in ("srt", "vtt", "text", "json", "all"):
        fmt_out = "all"

    results = []
    errors = []
    total_chars = 0
    total_segments = 0
    backend_used = None
    languages = set()

    for fname, audio_bytes in inputs:
        if not audio_bytes:
            errors.append({"filename": fname, "error": "数据为空"})
            continue
        if len(audio_bytes) > MAX_AUDIO_BYTES:
            errors.append({"filename": fname, "error": "音频超过 512MiB 上限"})
            continue
        tmp = tempfile.NamedTemporaryFile(suffix="_" + os.path.basename(fname), delete=False)
        try:
            tmp.write(audio_bytes)
            tmp.close()
            try:
                segs, lang, backend = _transcribe_one(tmp.name, p)
            except ImportError as exc:
                return _fail("缺音频识别库", exc,
                             hint="pip install faster-whisper (推荐 · int8 CPU 即可跑)")
            backend_used = backend
            languages.add(lang)
            if slice_start is not None or slice_end is not None:
                segs = [
                    segment for segment in segs
                    if (slice_start is None or segment["end"] > slice_start)
                    and (slice_end is None or segment["start"] < slice_end)
                ]
            full_text = " ".join(s["text"] for s in segs if s["text"])[:MAX_OUTPUT_CHARS]
            entry = {
                "filename": fname,
                "language": lang,
                "segments_count": len(segs),
                "chars": len(full_text),
                "duration_sec": round(segs[-1]["end"], 2) if segs else 0,
            }
            if fmt_out in ("text", "all"):
                entry["text"] = full_text
            if fmt_out in ("srt", "all"):
                entry["srt"] = _build_srt(segs)
            if fmt_out in ("vtt", "all"):
                entry["vtt"] = _build_vtt(segs)
            if fmt_out in ("json", "all"):
                entry["segments"] = segs
            results.append(entry)
            total_chars += len(full_text)
            total_segments += len(segs)
        except Exception as exc:
            errors.append({"filename": fname, "error": str(exc)[:200]})
        finally:
            try:
                os.unlink(tmp.name)
            except Exception:
                pass

    elapsed_ms = int((time.time() - t0) * 1000)
    ok_n = len(results)
    if ok_n == 0:
        return _fail("所有文件识别失败", hint=str(errors[:3]))

    result_text = "\n\n".join(
        result.get("text", "")
        for result in results
        if result.get("text")
    )[:MAX_OUTPUT_CHARS]
    print(json.dumps({
        "status": "ok",
        "schema_version": "v1",
        "task_type": "whisper_transcribe",
        "elapsed_ms": elapsed_ms,
        "results": results,
        "result_text": result_text,
        "errors": errors,
        "summary": {
            "model": p.get("model", "base"),
            "backend": backend_used,
            "format": fmt_out,
            "files_total": len(inputs),
            "files_ok": ok_n,
            "files_failed": len(errors),
            "total_segments": total_segments,
            "total_chars": total_chars,
            "languages_detected": sorted(languages),
        },
        "summary_text": "✅ {ok}/{tot} 音频 · {seg} 段 · {ch:,} 字 · {ms}ms · {bk}".format(
            ok=ok_n, tot=len(inputs), seg=total_segments,
            ch=total_chars, ms=elapsed_ms, bk=backend_used,
        ),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
