"""
单元测试 · V8.2 native_args_templates
═══════════════════════════════════════════════════════════════

验证:
  1. 12 个 NATIVE task 全部有模板
  2. 占位符 {input}/{output} 都正确出现
  3. params 注入有效(crf/quality/bitrate 等)
  4. slice_meta 注入有效(start_sec/end_sec/start_page/end_page)
  5. 安全过滤(注入恶意字符返回 default)
"""

from __future__ import annotations

import pytest

from platform_v8.engine.native_args_templates import (
    render_native_args,
    list_supported_task_types,
)


# ════════════════════════════════════════════════════════════════
# 1. 12 个 NATIVE task 全部覆盖
# ════════════════════════════════════════════════════════════════
def test_all_native_tasks_have_template():
    supported = set(list_supported_task_types())
    expected = {
        "image_info", "image_resize", "image_compress",
        "image_convert", "image_thumbnail",
        "video_info", "video_compress", "audio_extract",
        "audio_transcode", "whisper_transcribe",
        "pdf_info", "pdf_to_text",
    }
    assert supported == expected, f"missing or extra: {supported ^ expected}"


def test_unknown_task_returns_empty():
    assert render_native_args(task_type="not_exist") == []


# ════════════════════════════════════════════════════════════════
# 2. 占位符校验
# ════════════════════════════════════════════════════════════════
class TestPlaceholders:
    def test_image_resize_has_input_output(self):
        args = render_native_args(task_type="image_resize")
        assert "{input}" in args
        # vips: {output}.jpg(后缀决定 encoder)
        assert any(a.startswith("{output}") for a in args), f"got: {args}"

    def test_image_convert_format_param(self):
        # image_convert · params.format 指定输出格式
        args = render_native_args(task_type="image_convert", params={"format": "png"})
        assert any("{output}.png" in a for a in args), f"got: {args}"

    def test_image_convert_format_default_png(self):
        args = render_native_args(task_type="image_convert")
        assert any("{output}.png" in a for a in args), f"got: {args}"

    def test_image_convert_format_invalid_falls_back(self):
        # 非白名单格式 → fallback default(png)
        args = render_native_args(task_type="image_convert", params={"format": "; rm -rf /"})
        assert any("{output}.png" in a for a in args), f"got: {args}"
        assert not any("rm" in a or "/" in a.replace("{output}", "") for a in args)

    def test_image_resize_format_webp(self):
        args = render_native_args(task_type="image_resize", params={"format": "webp"})
        assert any("{output}.webp" in a for a in args), f"got: {args}"

    def test_video_compress_has_input_output(self):
        args = render_native_args(task_type="video_compress")
        assert "{input}" in args
        # {output} 占位符 · 带扩展名(节点 native_runner 按扩展名解析 output 文件)
        assert any(a.startswith("{output}") for a in args), f"got: {args}"

    def test_pdf_to_text_has_input_output(self):
        args = render_native_args(task_type="pdf_to_text")
        assert "{input}" in args
        # pdftotext 用 - 输出到 stdout · 或带文件名 · 这里宽松检查
        assert any("{output}" in a or a == "-" for a in args), f"got: {args}"

    def test_pdf_info_has_input(self):
        # pdfinfo 只读 input · 不写 output(返回 stdout)
        args = render_native_args(task_type="pdf_info")
        assert args == ["{input}"]

    def test_video_info_has_input(self):
        # ffprobe 只读 input · 返回 json 到 stdout
        args = render_native_args(task_type="video_info")
        assert "{input}" in args
        assert "{output}" not in args


# ════════════════════════════════════════════════════════════════
# 3. params 注入
# ════════════════════════════════════════════════════════════════
class TestParamsInjection:
    def test_image_resize_width(self):
        args = render_native_args(task_type="image_resize",
                                  params={"width": 1024})
        assert "1024" in args

    def test_image_resize_default_width(self):
        args = render_native_args(task_type="image_resize")
        assert "800" in args  # default

    def test_image_compress_quality(self):
        args = render_native_args(task_type="image_compress",
                                  params={"quality": 60})
        assert "--Q=60" in args

    def test_video_compress_crf(self):
        args = render_native_args(task_type="video_compress",
                                  params={"crf": 18})
        assert "18" in args
        # check it's after -crf
        idx = args.index("-crf")
        assert args[idx + 1] == "18"

    def test_video_compress_preset(self):
        args = render_native_args(task_type="video_compress",
                                  params={"preset": "fast"})
        assert "fast" in args

    def test_video_compress_invalid_preset_falls_back(self):
        args = render_native_args(task_type="video_compress",
                                  params={"preset": "; rm -rf /"})
        assert "medium" in args  # default

    def test_audio_extract_bitrate(self):
        args = render_native_args(task_type="audio_extract",
                                  params={"bitrate": "320k"})
        assert "320k" in args

    def test_audio_extract_invalid_bitrate_falls_back(self):
        args = render_native_args(task_type="audio_extract",
                                  params={"bitrate": "invalid"})
        assert "192k" in args  # default

    def test_pdf_to_text_layout(self):
        args = render_native_args(task_type="pdf_to_text",
                                  params={"layout": "raw"})
        assert "-raw" in args

    def test_whisper_model_size(self):
        args = render_native_args(task_type="whisper_transcribe",
                                  params={"model": "large"})
        assert "ggml-large.bin" in args

    def test_whisper_invalid_model_falls_back(self):
        args = render_native_args(task_type="whisper_transcribe",
                                  params={"model": "/etc/passwd"})
        assert "ggml-base.bin" in args


# ════════════════════════════════════════════════════════════════
# 4. slice_meta 注入(duration_chunked / pages_chunked)
# ════════════════════════════════════════════════════════════════
class TestSliceMetaInjection:
    def test_video_compress_start_end(self):
        args = render_native_args(
            task_type="video_compress",
            slice_meta={"start_sec": 10, "end_sec": 30},
        )
        assert "-ss" in args
        assert "-to" in args
        # check values
        idx = args.index("-ss")
        assert args[idx + 1] == "10"
        idx = args.index("-to")
        assert args[idx + 1] == "30"

    def test_pdf_to_text_page_range(self):
        args = render_native_args(
            task_type="pdf_to_text",
            slice_meta={"start_page": 5, "end_page": 10},
        )
        assert "-f" in args
        assert "-l" in args
        idx = args.index("-f")
        assert args[idx + 1] == "5"
        idx = args.index("-l")
        assert args[idx + 1] == "10"


# ════════════════════════════════════════════════════════════════
# 5. 安全过滤(防注入)
# ════════════════════════════════════════════════════════════════
class TestSecurity:
    def test_int_oob_returns_default(self):
        args = render_native_args(task_type="image_resize",
                                  params={"width": 99999})
        # capped at 8192
        assert "8192" in args

    def test_int_negative_returns_min(self):
        args = render_native_args(task_type="image_resize",
                                  params={"width": -100})
        assert "16" in args  # lo bound

    def test_string_injection_blocked(self):
        args = render_native_args(
            task_type="video_compress",
            params={"preset": "fast; rm -rf /"},
        )
        # 注入字符的整字符串无法通过白名单 · fallback default
        assert "medium" in args
        assert "fast; rm -rf /" not in args

    def test_unknown_task_safe(self):
        args = render_native_args(
            task_type="rm_rf_root",
            params={"any": "rm -rf /"},
        )
        assert args == []


# ════════════════════════════════════════════════════════════════
# 6. broker 集成: render → 注入 ShardAssignPayload
# ════════════════════════════════════════════════════════════════
def test_render_does_not_crash_on_real_task_types():
    """全部模板都能跑出至少 2 个 args(input + output 或 input only)"""
    for tt in list_supported_task_types():
        args = render_native_args(task_type=tt)
        assert len(args) >= 1, f"{tt} renders empty args"
        # 必有 {input}
        assert any("{input}" in a for a in args), f"{tt} missing {{input}}"
