#!/usr/bin/env python3
"""视频智能解析 · ffmpeg 抽音/抽帧 + Whisper ASR + 本机 LLM 文本/视觉

对齐 /Users/yu/Projects/RAG/mp4 流水线（跨平台用 faster-whisper）。
本机推理默认 llama.cpp (llama-server · OpenAI 兼容)；云端接口预留 llm_backend=cloud。
params.outputs 可多选: srt / dialogue / vision / story（默认全选）。
协议：EC_PARAMS + EC_INPUT_DIR / stdin · 输出 result_files_b64。

派发要求：节点具备 ffmpeg + faster_whisper + local_llm（及所选文本/视觉模型）。
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error

MAX_VIDEO_BYTES = 1024 * 1024 * 1024
DEFAULT_OUTPUTS = ("srt", "dialogue", "vision", "story")
DEFAULT_TEXT_MODEL = "qwen2.5"
DEFAULT_VISION_MODEL = "qwen2.5-vl"
VIDEO_EXTS = (
    ".mp4", ".mov", ".mkv", ".avi", ".webm", ".flv", ".m4v", ".mpeg", ".mpg",
)


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "") or "{}"
    try:
        p = json.loads(raw)
        return p if isinstance(p, dict) else {}
    except Exception:
        return {}


def _fail(msg: str, exc: Exception | None = None, **extra) -> int:
    out = {
        "status": "failed",
        "contract_version": "1",
        "task_type": "video_analyze",
        "error": msg,
        "elapsed_ms": 0,
        "summary_text": f"❌ {msg}",
    }
    if exc is not None:
        out["detail"] = f"{type(exc).__name__}: {exc}"
    out.update(extra)
    print(json.dumps(out, ensure_ascii=False))
    return 1


def _as_bool(v, default: bool = True) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    s = str(v).strip().lower()
    if s in ("0", "false", "no", "off", ""):
        return False
    if s in ("1", "true", "yes", "on"):
        return True
    return default


def _parse_outputs(p: dict) -> set[str]:
    alias = {
        "srt": "srt",
        "subtitle": "srt",
        "字幕": "srt",
        "dialogue": "dialogue",
        "dialog": "dialogue",
        "txt": "dialogue",
        "text": "dialogue",
        "对话": "dialogue",
        "对话文本": "dialogue",
        "vision": "vision",
        "frames": "vision",
        "画面": "vision",
        "画面描述": "vision",
        "story": "story",
        "event": "story",
        "事件": "story",
        "事情经过": "story",
        "事件梳理": "story",
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
        items = [k for k, v in raw.items() if _as_bool(v, False)]
    out: set[str] = set()
    for it in items:
        key = alias.get(str(it).strip().lower()) or alias.get(str(it).strip())
        if key:
            out.add(key)
    if not out:
        out = set(DEFAULT_OUTPUTS)
    return out


def _which(name: str) -> str | None:
    """优先 EC_* 环境变量（客户端注入）· 再 PATH · 再千手托管目录。"""
    env_key = {
        "ffmpeg": "EC_FFMPEG",
        "ffprobe": "EC_FFPROBE",
    }.get(name)
    if env_key:
        env_path = (os.environ.get(env_key) or "").strip()
        if env_path and os.path.isfile(env_path) and os.access(env_path, os.X_OK):
            return env_path

    path = shutil.which(name)
    if path:
        return path

    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".qianshou", "runtime", "shims", name),
        os.path.join(home, ".qianshou", "runtime", "tiers", "ffmpeg", "bin", name),
        f"/opt/homebrew/bin/{name}",
        f"/usr/local/bin/{name}",
    ]
    # imageio-ffmpeg 静态包：文件名常为 ffmpeg-macos-aarch64-v*
    if name == "ffmpeg":
        for root in (
            os.path.join(home, ".qianshou", "runtime", "venvs", "ffmpeg"),
            os.path.join(home, ".qianshou", "runtime", "envs", "image"),
        ):
            binaries = os.path.join(
                root, "lib", "python3.11", "site-packages", "imageio_ffmpeg", "binaries"
            )
            if os.path.isdir(binaries):
                for fn in sorted(os.listdir(binaries)):
                    if fn.startswith("ffmpeg") and not fn.endswith(".json"):
                        candidates.append(os.path.join(binaries, fn))
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def _read_video(p: dict) -> tuple[str, bytes] | None:
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if input_dir and os.path.isdir(input_dir):
        for root, _dirs, files in os.walk(input_dir):
            for name in sorted(files):
                low = name.lower()
                if not any(low.endswith(ext) for ext in VIDEO_EXTS):
                    # 单文件任务也可能没有扩展名 · 取第一个常规文件
                    if "." in name:
                        continue
                path = os.path.join(root, name)
                if not os.path.isfile(path):
                    continue
                with open(path, "rb") as fh:
                    return name, fh.read()
        # 兜底：任意第一个文件
        for root, _dirs, files in os.walk(input_dir):
            for name in sorted(files):
                path = os.path.join(root, name)
                if os.path.isfile(path):
                    with open(path, "rb") as fh:
                        return name, fh.read()
    try:
        raw = sys.stdin.buffer.read()
    except Exception:
        raw = b""
    if raw:
        return "stdin.mp4", raw
    b64 = p.get("video_b64") or p.get("file_b64")
    if isinstance(b64, str) and b64:
        return "video.bin", base64.b64decode(b64)
    return None


def _fmt_ts(sec: float, srt: bool = True) -> str:
    ms = int(round(float(sec) * 1000))
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    sep = "," if srt else "."
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{milli:03d}"


def _build_srt(segs: list[dict]) -> str:
    parts = []
    for i, s in enumerate(segs):
        sfx = s.get("sfx") or []
        sfx_s = f" [音效: {'；'.join(sfx)}]" if sfx else ""
        body = f"{s.get('speaker') or 'SPEAKER_01'}: {s['text']}{sfx_s}"
        parts.append(
            f"{i + 1}\n{_fmt_ts(s['start'])} --> {_fmt_ts(s['end'])}\n{body}\n"
        )
    return "\n".join(parts)


def _build_dialogue_txt(segs: list[dict]) -> str:
    lines = []
    prev = None
    for s in segs:
        sp = s.get("speaker") or "SPEAKER_01"
        if prev and sp != prev:
            lines.append("")
        lines.append(f"[{_fmt_ts(s['start'], srt=False)[:8]}] {sp}: {s['text']}")
        for sfx in s.get("sfx") or []:
            lines.append(f"[音效] {sfx}")
        prev = sp
    return "\n".join(lines)


def _extract_audio(src: str, wav_out: str, max_seconds: float | None) -> None:
    ffmpeg = _which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("未找到 ffmpeg · brew install ffmpeg")
    cmd = [
        ffmpeg, "-y", "-i", src,
        "-ac", "1", "-ar", "16000", "-vn",
    ]
    if max_seconds and max_seconds > 0:
        cmd.extend(["-t", str(max_seconds)])
    cmd.append(wav_out)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-800:] if r.stderr else "ffmpeg 抽音频失败")


def _extract_frames(
    src: str,
    frames_dir: str,
    interval_sec: float,
    max_seconds: float | None,
    max_frames: int,
) -> list[tuple[float, str]]:
    ffmpeg = _which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("未找到 ffmpeg")
    os.makedirs(frames_dir, exist_ok=True)
    interval = max(0.5, float(interval_sec))
    fps = 1.0 / interval
    pattern = os.path.join(frames_dir, "frame_%04d.jpg")
    cmd = [ffmpeg, "-y", "-i", src]
    if max_seconds and max_seconds > 0:
        cmd.extend(["-t", str(max_seconds)])
    cmd.extend(["-vf", f"fps={fps}", "-q:v", "3", pattern])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-800:] if r.stderr else "ffmpeg 抽帧失败")

    files = sorted(
        f for f in os.listdir(frames_dir) if f.startswith("frame_") and f.endswith(".jpg")
    )
    if max_frames > 0 and len(files) > max_frames:
        step = len(files) / max_frames
        files = [files[int(i * step)] for i in range(max_frames)]

    result: list[tuple[float, str]] = []
    for f in files:
        m = re.search(r"(\d+)$", os.path.splitext(f)[0])
        idx = int(m.group(1)) - 1 if m else len(result)
        result.append((max(0.0, idx * interval), os.path.join(frames_dir, f)))
    return result


def _transcribe(path: str, p: dict) -> tuple[list[dict], str, str]:
    model_size = p.get("whisper_model") or p.get("model") or "base"
    lang = p.get("language") or None
    if lang == "":
        lang = None
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise ImportError("缺 faster-whisper · pip install faster-whisper") from exc

    device = "cpu"
    try:
        import torch

        if torch.cuda.is_available():
            device = "cuda"
    except ImportError:
        pass

    download_root = os.path.expanduser("~/.qianshou/models/faster-whisper")
    os.makedirs(download_root, exist_ok=True)
    try:
        model = WhisperModel(
            str(model_size),
            device=device,
            compute_type="int8",
            download_root=download_root,
            local_files_only=True,
        )
    except Exception:
        try:
            model = WhisperModel(
                str(model_size),
                device=device,
                compute_type="int8",
                download_root=download_root,
            )
        except Exception as exc:
            raise RuntimeError(
                f"ASR 模型加载失败 ({model_size}) · download_root={download_root} · {exc}"
            ) from exc
    segments, info = model.transcribe(
        path,
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
            "sfx": [],
        }
        for s in segments
        if (s.text or "").strip()
    ]
    return segs, getattr(info, "language", "unknown"), "faster-whisper"


def _assign_speakers(segs: list[dict]) -> list[dict]:
    if not segs:
        return segs
    speaker_idx = 1
    out: list[dict] = []
    for i, seg in enumerate(segs):
        if i > 0 and (seg["start"] - segs[i - 1]["end"]) >= 2.0:
            speaker_idx = 2 if speaker_idx == 1 else 1
        row = dict(seg)
        row["speaker"] = f"SPEAKER_{speaker_idx:02d}"
        out.append(row)
    return out


def _detect_sfx(segs: list[dict], min_gap: float = 1.2) -> list[dict]:
    if not segs:
        return segs
    out: list[dict] = []
    for i, seg in enumerate(segs):
        row = dict(seg)
        row["sfx"] = list(seg.get("sfx") or [])
        if i > 0:
            gap = seg["start"] - segs[i - 1]["end"]
            if gap >= min_gap:
                label = "较长停顿/可能音效或环境声"
                if gap >= 3.0:
                    label = "明显间断（音效/背景/转场）"
                if out:
                    out[-1]["sfx"] = list(out[-1].get("sfx") or []) + [f"{label} ≈{gap:.1f}s"]
        out.append(row)
    return out


def _llm_host(p: dict) -> str:
    from _llm_client import resolve_base_url

    return resolve_base_url(p)


_LLM_CTX: dict = {"api_key": ""}


def _llm_chat(
    messages: list[dict],
    model: str,
    host: str,
    temperature: float = 0.2,
    timeout: int = 600,
) -> str:
    from _llm_client import chat_completion

    return chat_completion(
        messages=messages,
        model=model,
        base_url=host,
        api_key=str(_LLM_CTX.get("api_key") or ""),
        temperature=temperature,
        timeout=timeout,
    )


def _llm_generate(
    prompt: str, model: str, host: str, temperature: float = 0.2, images: list[str] | None = None
) -> str:
    message: dict = {"role": "user", "content": prompt}
    if images:
        message["images"] = images
    return _llm_chat([message], model=model, host=host, temperature=temperature)


def _strip_fence(raw: str) -> str:
    raw = raw.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, flags=re.I)
    return m.group(1).strip() if m else raw


def _parse_corrections(raw: str, n: int) -> list[str]:
    cleaned = _strip_fence(raw)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        m = re.search(r"\[[\s\S]*\]", cleaned)
        if not m:
            return [""] * n
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            return [""] * n
    if not isinstance(data, list):
        return [""] * n
    mapped: dict[int, str] = {}
    for i, item in enumerate(data):
        if isinstance(item, dict):
            idx = int(item.get("id") or (i + 1))
            text = str(item.get("text") or "").strip()
            if text:
                mapped[idx] = text
        elif isinstance(item, str) and item.strip():
            mapped[i + 1] = item.strip()
    return [mapped.get(i, "") for i in range(1, n + 1)]


def _analyze(segs: list[dict], model: str, host: str, domain_hint: str) -> str:
    preview = "\n".join(f"{i + 1}. {s['text']}" for i, s in enumerate(segs[:40]))
    hint = domain_hint.strip() or "中文口播/影视对白"
    prompt = f"""你是中文语音转写质量分析助手。下面是 ASR 初稿（可能有同音错字）。
场景提示：{hint}

请分析并输出简洁中文要点（不要输出 JSON）：
1. 整体在说什么
2. 反复出现的人名/外号/地名（给出你认为正确的写法）
3. 明显同音误识或不通顺处（举例）
4. 校对时应保留的口语词

转写初稿：
{preview}
"""
    try:
        return _llm_generate(prompt, model, host, temperature=0.3).strip()
    except Exception:
        return ""


def _correct(
    segs: list[dict], model: str, host: str, domain_hint: str, notes: str
) -> list[dict]:
    hint = domain_hint.strip() or "中文口语"
    batch_size = 8
    out: list[dict] = []
    for start in range(0, len(segs), batch_size):
        batch = segs[start : start + batch_size]
        payload = [
            {"id": i + 1, "speaker": s.get("speaker") or "SPEAKER_01", "text": s["text"]}
            for i, s in enumerate(batch)
        ]
        prompt = f"""你是中文 ASR 纠错编辑。根据语境笔记，纠正同音错字、明显不通顺处。
规则：
- 保留口语，不要改成书面语
- 不要扩写、不要删减条目数量，不要合并/拆分句子
- 人名/外号尽量与语境笔记一致
- 实在不确定在词后加[?]
- 只输出 JSON 数组，不要其他说明。格式：
[{{"id":1,"text":"校对后文本"}}, ...]

场景：{hint}

语境笔记：
{(notes or "（无）")[:2500]}

待校对：
{json.dumps(payload, ensure_ascii=False)}
"""
        try:
            raw = _llm_generate(prompt, model, host, temperature=0.15)
            parsed = _parse_corrections(raw, len(batch))
        except Exception:
            out.extend(batch)
            continue
        for seg, text in zip(batch, parsed):
            fixed = dict(seg)
            if text:
                fixed["text"] = text
            out.append(fixed)
    return out


def _caption_frames(
    frames: list[tuple[float, str]], model: str, host: str, domain_hint: str
) -> list[dict]:
    hint = domain_hint.strip() or "中文视频画面"
    captions: list[dict] = []
    for t, path in frames:
        prompt = f"""用一两句中文描述这张视频截图里看得见的内容。
场景提示：{hint}
要求：客观、具体；提到人物外貌/动作、场景、字幕（若有）；不要编造听不见的对白。"""
        try:
            with open(path, "rb") as fh:
                b64 = base64.b64encode(fh.read()).decode("ascii")
            text = _llm_generate(
                prompt, model=model, host=host, temperature=0.2, images=[b64]
            )
        except Exception as exc:
            text = f"（描述失败：{exc}）"
        captions.append({"time": round(t, 2), "caption": (text or "").strip()})
    return captions


def _summarize_av_story(
    segs: list[dict], captions: list[dict], model: str, host: str, domain_hint: str
) -> str:
    max_lines = 80
    if len(segs) <= max_lines:
        chosen = segs
    else:
        head_n, tail_n = 30, 20
        mid_n = max_lines - head_n - tail_n
        mid_start = max(0, (len(segs) - mid_n) // 2)
        chosen = segs[:head_n] + segs[mid_start : mid_start + mid_n] + segs[-tail_n:]

    dialogue = "\n".join(
        f"[{_fmt_ts(float(s.get('start') or 0), srt=False)[:8]}] "
        f"{s.get('speaker') or 'SPEAKER_01'}: {s.get('text') or ''}"
        + (f"  / 音效: {'；'.join(s.get('sfx') or [])}" if s.get("sfx") else "")
        for s in chosen
    )
    visual = "\n".join(
        f"[{_fmt_ts(float(c.get('time') or 0), srt=False)[:8]}] {c.get('caption') or ''}"
        for c in captions[:80]
    )
    hint = (domain_hint or "").strip() or "中文视频"
    prompt = f"""你是视频内容梳理助手。下面有「对白转写」和「关键帧画面描述」。
请输出「事情经过」文稿，综合音视频信息，不要改写原对话列表。

场景提示：{hint}

请按以下结构用中文写：
## 一句话概述
## 涉及人物
## 时间线
（按先后分点；可同时引用画面与对白；带大概时间码）
## 画面与对白如何对应
（哪些段落主要靠画面、哪些靠对白）
## 冲突/诉求
## 不确定点
（转写或画面描述可能不准之处）

要求：客观归纳，不要编造材料里没有的事实。

对白：
{dialogue or "（无对白）"}

画面时间线：
{visual or "（无画面描述）"}
"""
    return _llm_generate(prompt, model, host, temperature=0.35).strip()


def main() -> int:
    t0 = time.time()
    p = _params()
    got = _read_video(p)
    if not got:
        return _fail("无视频输入 · 检查 EC_INPUT_DIR / stdin / params.video_b64")
    fname, video_bytes = got
    if not video_bytes:
        return _fail("视频数据为空")
    if len(video_bytes) > MAX_VIDEO_BYTES:
        return _fail("视频超过 1GiB 上限")

    outputs = _parse_outputs(p)
    use_llm = _as_bool(p.get("use_llm", True), True)
    use_vision = _as_bool(p.get("use_vision", True), True)
    if "story" in outputs:
        use_llm = True
    if "vision" in outputs:
        use_vision = True
    # 未勾选 vision/story 且显式关视觉时，可跳过抽帧
    if "vision" not in outputs and "story" not in outputs and not _as_bool(p.get("use_vision", True), True):
        use_vision = False

    text_model_req = str(
        p.get("ollama_model") or p.get("text_model") or p.get("model") or ""
    ).strip()
    vision_model_req = str(p.get("vision_model") or "").strip()
    domain_hint = str(p.get("domain_hint") or "")
    host = _llm_host(p)
    from _llm_client import resolve_api_key, unreachable_hint

    _LLM_CTX["api_key"] = resolve_api_key(p)
    frame_interval = float(p.get("frame_interval") or 5.0)
    max_frames = int(p.get("max_frames") or 24)
    max_seconds_raw = p.get("max_seconds")
    try:
        max_seconds = float(max_seconds_raw) if max_seconds_raw not in (None, "", 0, "0") else None
    except (TypeError, ValueError):
        max_seconds = None

    need_vision = use_vision and ("vision" in outputs or "story" in outputs)
    text_model = text_model_req
    vision_model = vision_model_req or text_model_req
    if use_llm or need_vision:
        try:
            from _llm_pick import list_local_models, resolve_model

            have = list_local_models(host, api_key=_LLM_CTX["api_key"])
            if use_llm:
                text_model = resolve_model(
                    text_model_req,
                    kind="text",
                    host=host,
                    have=have,
                    api_key=_LLM_CTX["api_key"],
                    params=p,
                )
            if need_vision:
                vision_model = resolve_model(
                    vision_model_req or text_model_req,
                    kind="vision",
                    host=host,
                    have=have,
                    api_key=_LLM_CTX["api_key"],
                    params=p,
                )
        except Exception as exc:
            return _fail(
                str(exc) or "LLM 模型选择失败",
                None if isinstance(exc, RuntimeError) else exc,
            )
    segs: list[dict] = []
    captions: list[dict] = []
    notes = ""
    story = ""
    lang = "unknown"
    backend = "faster-whisper"

    suffix = os.path.splitext(fname)[1] or ".mp4"
    work = tempfile.mkdtemp(prefix="video_analyze_")
    try:
        src_path = os.path.join(work, "input" + suffix)
        with open(src_path, "wb") as fh:
            fh.write(video_bytes)

        wav_path = os.path.join(work, "audio_16k_mono.wav")
        try:
            _extract_audio(src_path, wav_path, max_seconds)
        except Exception as exc:
            return _fail("抽音频失败", exc)

        try:
            segs, lang, backend = _transcribe(wav_path, p)
        except ImportError as exc:
            return _fail("缺音频识别库", exc, hint="pip install faster-whisper")
        except Exception as exc:
            return _fail("ASR 失败", exc)

        segs = _assign_speakers(segs)
        segs = _detect_sfx(segs)

        if use_llm and segs:
            try:
                notes = _analyze(segs, text_model, host, domain_hint)
                segs = _correct(segs, text_model, host, domain_hint, notes)
            except urllib.error.URLError as exc:
                return _fail(unreachable_hint(exc), exc)
            except Exception as exc:
                return _fail("LLM 校对失败", exc)

        if need_vision:
            frames_dir = os.path.join(work, "frames")
            try:
                frames = _extract_frames(
                    src_path, frames_dir, frame_interval, max_seconds, max_frames
                )
                captions = _caption_frames(frames, vision_model, host, domain_hint)
            except urllib.error.URLError as exc:
                return _fail(unreachable_hint(exc), exc)
            except Exception as exc:
                return _fail("画面描述失败", exc)

        if "story" in outputs:
            if not segs and not captions:
                story = "（无可用对白/画面，无法梳理事情经过）"
            else:
                try:
                    story = _summarize_av_story(
                        segs, captions, text_model, host, domain_hint
                    )
                except urllib.error.URLError as exc:
                    return _fail(unreachable_hint(exc), exc)
                except Exception as exc:
                    return _fail("事情经过梳理失败", exc)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    stem = os.path.splitext(os.path.basename(fname))[0] or "video"
    srt = _build_srt(segs)
    dialogue = _build_dialogue_txt(segs)
    vision_txt = "\n".join(
        f"[{_fmt_ts(float(c.get('time') or 0), srt=False)[:8]}] {c.get('caption') or ''}"
        for c in captions
    )

    meta = {
        "filename": fname,
        "language": lang,
        "backend": backend,
        "segments_count": len(segs),
        "frames_count": len(captions),
        "use_llm": use_llm,
        "use_vision": need_vision,
        "llm_backend": str(p.get("llm_backend") or "local"),
        "text_model": text_model if use_llm else "",
        "vision_model": vision_model if need_vision else "",
        "ollama_model": text_model if use_llm else "",  # 过渡双写
        "frame_interval": frame_interval,
        "max_frames": max_frames,
        "max_seconds": max_seconds,
        "outputs": sorted(outputs),
        "analysis_notes": notes[:4000],
        "story": story[:8000] if story else "",
        "segments": segs,
        "captions": captions,
    }

    files: dict[str, str] = {}
    if "srt" in outputs:
        files[f"{stem}.srt"] = base64.b64encode(srt.encode("utf-8")).decode("ascii")
    if "dialogue" in outputs:
        files[f"{stem}_dialogue.txt"] = base64.b64encode(dialogue.encode("utf-8")).decode(
            "ascii"
        )
    if "vision" in outputs:
        files[f"{stem}_vision.txt"] = base64.b64encode(vision_txt.encode("utf-8")).decode(
            "ascii"
        )
        files[f"{stem}_vision.json"] = base64.b64encode(
            json.dumps(captions, ensure_ascii=False, indent=2).encode("utf-8")
        ).decode("ascii")
    if "story" in outputs:
        files[f"{stem}_story.txt"] = base64.b64encode((story or "").encode("utf-8")).decode(
            "ascii"
        )
    files[f"{stem}.json"] = base64.b64encode(
        json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8")
    ).decode("ascii")

    labels = []
    if "srt" in outputs:
        labels.append("字幕")
    if "dialogue" in outputs:
        labels.append("对话")
    if "vision" in outputs:
        labels.append("画面")
    if "story" in outputs:
        labels.append("事情经过")

    elapsed_ms = int((time.time() - t0) * 1000)
    report = {
        "status": "ok",
        "contract_version": "1",
        "task_type": "video_analyze",
        "elapsed_ms": elapsed_ms,
        "result_files_b64": files,
        "results": [
            {
                "filename": fname,
                "language": lang,
                "segments_count": len(segs),
                "frames_count": len(captions),
                "backend": backend,
                "outputs": sorted(outputs),
            }
        ],
        "summary": {
            "total_files": 1,
            "segments": len(segs),
            "frames": len(captions),
            "use_llm": use_llm,
            "use_vision": need_vision,
            "outputs": sorted(outputs),
        },
        "summary_text": (
            f"✓ 视频解析 {backend} · {len(segs)} 段对白 · {len(captions)} 帧画面"
            f" · 产出 {'+'.join(labels) or 'JSON'}"
            + (f" · 文本 {text_model}" if use_llm else "")
            + (f" · 视觉 {vision_model}" if need_vision else "")
            + f" · {elapsed_ms}ms"
        ),
    }
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
