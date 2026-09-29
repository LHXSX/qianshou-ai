"""
V8.2 RFC · 12 NATIVE task 的命令行参数模板系统
═══════════════════════════════════════════════════════════════════

服务端预渲染 native 命令行参数后下发给节点 · 节点 native_runner 只在
{input}/{output}/{tempdir} 3 个占位符处替换 · 不做任何命令拼接逻辑。

设计原则:
  1. 安全默认 · 每个 task 有合理默认参数(无需用户输入也能跑)
  2. params 覆写 · 用户在 workload.spec.params 可调任何参数
  3. 占位符固定 · {input}/{output}/{tempdir} 由客户端替换
  4. 黑盒输入 · 永远不让用户传完整 args(防注入)

调用入口:
  render_native_args(task_type="video_compress", params={"crf": 28}) →
    ["-y", "-i", "{input}", "-c:v", "libx264", "-preset", "medium",
     "-crf", "28", "{output}"]

每个 task_type 的 args 都做了 shell 转义 · 不会泄漏 RCE.
"""

from __future__ import annotations

import re
from typing import Any, Callable

__all__ = ["render_native_args", "list_supported_task_types"]


# ─────────────────────────────────────────────────────────────
# 工具函数
# ─────────────────────────────────────────────────────────────
_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9._\-+=:/]+$")


def _safe(value: Any, default: str = "") -> str:
    """白名单字符过滤 · 防 args 注入"""
    s = str(value) if value is not None else default
    if not _SAFE_TOKEN.match(s):
        return default
    return s


def _int(value: Any, default: int, lo: int = 0, hi: int = 10**6) -> int:
    try:
        v = int(value)
        return max(lo, min(hi, v))
    except (TypeError, ValueError):
        return default


def _str_in(value: Any, allowed: tuple[str, ...], default: str) -> str:
    s = str(value) if value is not None else ""
    return s if s in allowed else default


# ─────────────────────────────────────────────────────────────
# vips · 图像类(5 个 task)
# ─────────────────────────────────────────────────────────────
def _args_image_info(params: dict, slice_meta: dict) -> list[str]:
    """
    vipsheader -a input.jpg → 全部元信息(width/height/format/exif/...)
    用 vipsheader 替代 vips,得到结构化输出。
    """
    return ["-a", "{input}"]


_VIPS_VALID_FORMATS = ("jpg", "png", "webp", "tiff")


def _vips_output_ext(params: dict, default: str = "jpg") -> str:
    """params.format → 输出扩展名(白名单 · 防注入)"""
    fmt = _safe(params.get("format"), default).lower()
    return fmt if fmt in _VIPS_VALID_FORMATS else default


def _args_image_resize(params: dict, slice_meta: dict) -> list[str]:
    """
    vips thumbnail input.jpg output.jpg <width> [--height H]
    输出后缀由 params.format 决定(jpg/png/webp/tiff)· 默认 jpg
    """
    width = _int(params.get("width"), 800, lo=16, hi=8192)
    height = _int(params.get("height"), 0, lo=0, hi=8192)
    ext = _vips_output_ext(params)
    args = ["thumbnail", "{input}", f"{{output}}.{ext}", str(width)]
    if height > 0:
        args.extend(["--height", str(height)])
    return args


def _args_image_compress(params: dict, slice_meta: dict) -> list[str]:
    """
    vips jpegsave input.jpg output.jpg --Q=85
    用 copy 子命令做格式保持下的质量调整
    image_compress 默认 jpegsave · 输出是 jpg
    """
    quality = _int(params.get("quality"), 85, lo=10, hi=100)
    return ["jpegsave", "{input}", "{output}.jpg", f"--Q={quality}"]


def _args_image_convert(params: dict, slice_meta: dict) -> list[str]:
    """
    vips copy input.jpg output.png[Q=90]
    依赖输出后缀自动选 encoder · params.format 必填(jpg/png/webp/tiff)
    """
    quality = _int(params.get("quality"), 90, lo=10, hi=100)
    ext = _vips_output_ext(params, default="png")
    return ["copy", "{input}", f"{{output}}.{ext}[Q={quality}]"]


def _args_image_thumbnail(params: dict, slice_meta: dict) -> list[str]:
    """
    vips thumbnail input.jpg output.jpg <size>
    可与 image_resize 同 · 但走专用快路径
    """
    size = _int(params.get("size"), 256, lo=16, hi=2048)
    ext = _vips_output_ext(params)
    return ["thumbnail", "{input}", f"{{output}}.{ext}", str(size)]


# ─────────────────────────────────────────────────────────────
# ffmpeg/ffprobe · 音视频类(4 个 task)
# ─────────────────────────────────────────────────────────────
def _args_video_info(params: dict, slice_meta: dict) -> list[str]:
    """ffprobe -v error -show_format -show_streams -of json input.mp4"""
    return ["-v", "error", "-show_format", "-show_streams",
            "-of", "json", "{input}"]


def _args_video_compress(params: dict, slice_meta: dict) -> list[str]:
    """
    ffmpeg -y -i input.mp4 -ss <start> -to <end> -c:v libx264 -preset medium -crf 28 -c:a aac output.mp4
    duration_chunked 切片会塞 slice_meta.start_sec / end_sec
    """
    crf = _int(params.get("crf"), 28, lo=10, hi=51)
    preset = _str_in(
        params.get("preset"),
        ("ultrafast", "fast", "medium", "slow", "veryslow"),
        "medium",
    )
    args: list[str] = ["-nostdin", "-y", "-i", "{input}"]
    start = slice_meta.get("start_sec", slice_meta.get("start_s"))
    end = slice_meta.get("end_sec", slice_meta.get("end_s"))
    if start is not None:
        args.extend(["-ss", _safe(start, "0")])
    if end is not None:
        args.extend(["-to", _safe(end, "")])
    args.extend([
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-c:a", "aac", "-b:a", "128k",
        "{output}.mp4",
    ])
    return args


def _args_audio_extract(params: dict, slice_meta: dict) -> list[str]:
    """ffmpeg -y -i input.mp4 -vn -acodec libmp3lame -ab 192k output.mp3"""
    bitrate = _safe(params.get("bitrate"), "192k")
    if not bitrate.endswith("k") or not bitrate[:-1].isdigit():
        bitrate = "192k"
    return ["-nostdin", "-y", "-i", "{input}", "-vn",
            "-acodec", "libmp3lame", "-ab", bitrate, "{output}.mp3"]


def _args_audio_transcode(params: dict, slice_meta: dict) -> list[str]:
    """
    ffmpeg -y -i input.mp3 [-ss start -to end] -acodec libmp3lame -ab 192k output.mp3
    duration_chunked 切片会塞 slice_meta.start_sec / end_sec
    """
    codec = _str_in(
        params.get("codec"),
        ("libmp3lame", "aac", "libopus", "flac"),
        "libmp3lame",
    )
    bitrate = _safe(params.get("bitrate"), "192k")
    if not bitrate.endswith("k") or not bitrate[:-1].isdigit():
        bitrate = "192k"
    args: list[str] = ["-nostdin", "-y", "-i", "{input}"]
    start = slice_meta.get("start_sec")
    end = slice_meta.get("end_sec")
    if start is not None:
        args.extend(["-ss", _safe(start, "0")])
    if end is not None:
        args.extend(["-to", _safe(end, "")])
    # codec → 文件扩展名映射 (ffmpeg 从扩展名推断 muxer)
    ext_map = {"libmp3lame": "mp3", "aac": "m4a", "libopus": "opus", "flac": "flac"}
    ext = ext_map.get(codec, "mp3")
    args.extend(["-acodec", codec, "-ab", bitrate, f"{{output}}.{ext}"])
    return args


# ─────────────────────────────────────────────────────────────
# whisper.cpp · 语音转文字
# ─────────────────────────────────────────────────────────────
def _args_whisper_transcribe(params: dict, slice_meta: dict) -> list[str]:
    """
    whisper-cli -m models/ggml-base.bin -f input.wav -of {output} -oj -nt
    -oj 输出 json · -nt 不输出时间戳到 txt
    模型路径由客户端 paths::find_native_binary 同位置查找 · 或走 onnx_models_root
    """
    model = _safe(params.get("model"), "base")
    if model not in {"tiny", "base", "small", "medium", "large"}:
        model = "base"
    lang = _safe(params.get("language"), "auto")
    args = [
        "-m", f"ggml-{model}.bin",   # 客户端 native_runner 会在 tier_root/whisper-cli/ 找
        "-f", "{input}",
        "-of", "{output}",
        "-oj",                       # output JSON
        "-l", lang,
    ]
    start = slice_meta.get("start_sec")
    end = slice_meta.get("end_sec")
    if start is not None:
        args.extend(["--offset-t", _safe(int(float(start) * 1000), "0")])
    if end is not None and start is not None:
        try:
            duration_ms = int((float(end) - float(start)) * 1000)
            if duration_ms > 0:
                args.extend(["--duration", str(duration_ms)])
        except (TypeError, ValueError):
            pass
    return args


# ─────────────────────────────────────────────────────────────
# poppler · PDF 类(2 个 task)
# ─────────────────────────────────────────────────────────────
def _args_pdf_info(params: dict, slice_meta: dict) -> list[str]:
    """pdfinfo input.pdf"""
    return ["{input}"]


def _args_pdf_to_text(params: dict, slice_meta: dict) -> list[str]:
    """
    pdftotext [-f first -l last] [-layout|-raw] input.pdf output.txt
    历史 start_page/end_page 是 1-based 闭区间。
    page_start/page_end 在 page_index_base=0 时是 0-based 右开区间；
    无 base 的历史 payload 保持 1-based 闭区间。
    """
    args: list[str] = []
    start_page = slice_meta.get("start_page")
    end_page = slice_meta.get("end_page")
    if start_page is not None or end_page is not None:
        if start_page is not None:
            args.extend(["-f", str(_int(start_page, 1, lo=1, hi=99999))])
        if end_page is not None:
            args.extend(["-l", str(_int(end_page, 1, lo=1, hi=99999))])
    else:
        page_start = slice_meta.get("page_start")
        page_end = slice_meta.get("page_end")
        zero_based = slice_meta.get("page_index_base") == 0
        if page_start is not None:
            first = (
                _int(page_start, 0, lo=0, hi=99998) + 1
                if zero_based
                else _int(page_start, 1, lo=1, hi=99999)
            )
            args.extend(["-f", str(first)])
        if page_end is not None:
            # A zero-based exclusive end is numerically equal to poppler's
            # one-based inclusive last page: [2, 4) -> -f 3 -l 4.
            last = _int(page_end, 1, lo=1, hi=99999)
            args.extend(["-l", str(last)])
    layout = _str_in(params.get("layout"), ("layout", "raw", "table"), "layout")
    args.append(f"-{layout}")
    args.extend(["{input}", "{output}"])
    return args


# ─────────────────────────────────────────────────────────────
# Registry
# ─────────────────────────────────────────────────────────────
_TEMPLATES: dict[str, Callable[[dict, dict], list[str]]] = {
    # vips · 5(注意 image_info 用 vipsheader 不是 vips)
    "image_info":        _args_image_info,
    "image_resize":      _args_image_resize,
    "image_compress":    _args_image_compress,
    "image_convert":     _args_image_convert,
    "image_thumbnail":   _args_image_thumbnail,
    # ffmpeg · 4
    "video_info":        _args_video_info,
    "video_compress":    _args_video_compress,
    "audio_extract":     _args_audio_extract,
    "audio_transcode":   _args_audio_transcode,
    # whisper.cpp · 1
    "whisper_transcribe": _args_whisper_transcribe,
    # poppler · 2
    "pdf_info":          _args_pdf_info,
    "pdf_to_text":       _args_pdf_to_text,
}


def render_native_args(
    *,
    task_type: str,
    params: dict[str, Any] | None = None,
    slice_meta: dict[str, Any] | None = None,
) -> list[str]:
    """
    渲染 task_type 的 native 命令行参数.

    返回的 list 中 "{input}" / "{output}" / "{tempdir}" 由客户端
    native_runner 替换. 其他元素直接作为 binary 参数.

    没有对应模板 → 返回 [] (客户端 fallback Python3)
    """
    fn = _TEMPLATES.get(task_type)
    if fn is None:
        return []
    try:
        return fn(params or {}, slice_meta or {})
    except Exception:
        # 模板渲染失败 · 兜底空列表 · 客户端 fallback python3
        return []


def list_supported_task_types() -> list[str]:
    """供测试 · 列出所有有模板的 task_type"""
    return sorted(_TEMPLATES.keys())
