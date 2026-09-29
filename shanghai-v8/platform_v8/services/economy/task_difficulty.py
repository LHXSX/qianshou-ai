"""
NCE P3+ · 任务难度因子

设计要点:
  1. 不同 task_type 难度不同 · 信誉计算应加权
       hash_batch     0.3   (秒级 · 简单)
       word_count     0.4
       image_resize   0.6
       image_compress 0.7
       ocr            0.9
       (默认)         1.0
       video_compress 1.5
       video_transcode 2.0
       blender_render 2.5   (分钟级 · 重)
  
  2. 用法 (P3+):
       weighted_correctness = sum(d * done) / sum(d * total)
     即跑难任务的 DONE 更值钱 · 跑难任务的 FAILED 罚更重
  
  3. 不在表里 · 直接 Python 字典 (易扩展 · 后续可挪到 DB 表)
  
  4. 防注入: get_difficulty 对未识别 task_type 返默认 1.0
  
  5. P4 可演进:
     - SUCCESS_BONUS_CAP · 单次最大加分 (防巨刷)
     - FAILED_PENALTY_FLOOR · 单次最小扣分
     - 按节点能力调整 (S 档跑 blender 难度 1.5 · D 档跑 1.0)
"""
from __future__ import annotations
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# ════════════════════════════════════════════════════════════════════════════
# 难度表 (跟 PRD v1.2 §22 一致)
# ════════════════════════════════════════════════════════════════════════════

# 难度因子 · 跟 scripts/tasks 52 个 task_type 1:1 对齐 (2026-05-25 P4.17a 补全)
DIFFICULTY: dict[str, float] = {
    # ─── 0 极简 (毫秒-秒级 · 纯 CPU · 无 I/O 压力) ─────────────
    "base64_encode":      0.2,
    "base64_decode":      0.2,
    "url_check":          0.2,
    "url_parse":          0.2,
    "json_validate":      0.2,
    "encoding_detect":    0.2,
    "line_count":         0.3,
    "md5_batch":          0.3,
    "crc32_batch":        0.3,
    "hash_batch":         0.3,
    "image_info":         0.3,
    "pdf_info":           0.3,
    "video_info":         0.3,

    # ─── 1 简 (1-10s · 纯 CPU · 单文件) ─────────────────────────
    "word_count":         0.4,
    "dedup_lines":        0.4,
    "text_sort":          0.4,
    "text_split":         0.4,
    "text_diff":          0.4,
    "text_mask":          0.4,
    "text_replace":       0.4,
    "text_extract":       0.5,
    "regex_extract":      0.5,
    "json_filter":        0.5,
    "csv_to_json":        0.5,
    "field_stats":        0.5,
    "statistics_summary": 0.5,
    "pii_audit":          0.5,
    "pdf_to_text":        0.5,

    # ─── 2 中 (10-60s · CPU/低 GPU · 多文件) ────────────────────
    "image_resize":       0.6,
    "image_thumbnail":    0.6,
    "image_compress":     0.7,
    "image_convert":      0.7,
    "video_thumbnail":    0.7,
    "audio_extract":      0.7,
    "audio_transcode":    0.9,
    "fft_compute":        0.8,
    "pi_compute":         0.8,
    "monte_carlo":        0.9,
    "crawl_url_fetch":    0.5,
    "crawl_url_extract":  0.6,
    "crawl_batch_fetch":  0.9,

    # ─── 3 较重 (1-5 min · 需 GPU 或大内存) ────────────────────
    "ocr_image":          1.0,
    "pdf_ocr":            1.2,
    "embedding":          1.1,
    "llm_classify":       1.0,
    "llm_extract":        1.1,
    "llm_translate":      1.2,
    "llm_summarize":      1.3,
    "hash_collision_search": 1.4,

    # ─── 4 重 (5-30 min · GPU 必需 / 长文本 LLM) ───────────────
    "video_compress":     1.5,
    "image_caption":      1.6,
    "audio_transcribe_refine": 1.8,
    "video_analyze":      2.0,
    "llm_chat":           1.5,
    "whisper_transcribe": 1.7,
    "onnx_infer":         1.6,

    # ─── 5 极重 (30+ min · 高端 GPU + 大内存) ──────────────────
    "blender_render":     2.5,
}

# P4.17c · 每 task_type 的目标耗时基线 ms (用于 speed 子分标准化)
# 在该 elapsed_ms 下得 100 分 · 翻倍线性下降到 0 分 (50% 处 50 分)
# 缺失项 fallback 到 _default_target_ms (按 difficulty 推算)
TARGET_MS: dict[str, int] = {
    # 极简 (< 1s)
    "base64_encode":  300, "base64_decode": 300, "url_check": 500,
    "url_parse":      300, "json_validate": 300, "encoding_detect": 500,
    "line_count":     500, "md5_batch":    1000, "crc32_batch": 1000,
    "hash_batch":     1000, "image_info":    500, "pdf_info": 800,
    "video_info":     800,
    # 简
    "word_count":    1500, "dedup_lines": 1500, "text_sort": 1500,
    "text_split":    1500, "text_diff":   2000, "text_mask": 1500,
    "text_replace":  1500, "text_extract": 2000, "regex_extract": 2000,
    "json_filter":   2000, "csv_to_json":  2500, "field_stats": 2500,
    "statistics_summary": 2500, "pii_audit": 3000, "pdf_to_text": 3000,
    # 中
    "image_resize":  5000, "image_thumbnail": 5000, "image_compress": 8000,
    "image_convert": 8000, "video_thumbnail": 10000, "audio_extract": 15000,
    "audio_transcode": 30000, "fft_compute": 10000, "pi_compute": 10000,
    "monte_carlo":   20000, "crawl_url_fetch": 3000, "crawl_url_extract": 5000,
    "crawl_batch_fetch": 30000,
    # 较重
    "ocr_image":     60000, "pdf_ocr": 120000, "embedding": 30000,
    "llm_classify":  20000, "llm_extract": 30000, "llm_translate": 40000,
    "llm_summarize": 50000, "hash_collision_search": 90000,
    # 重
    "video_compress": 180000, "image_caption": 60000,
    "audio_transcribe_refine": 180000, "video_analyze": 300000,
    "llm_chat":       60000, "whisper_transcribe": 120000, "onnx_infer": 90000,
    # 极重
    "blender_render": 600000,
}

_DEFAULT_TARGET_MS = 10000  # 10s · 未识别 task_type 兜底

# 默认 (未识别 task_type)
DEFAULT_DIFFICULTY = 1.0

# 单次加分封顶 (防巨刷 · blender 一次只能加 2.5 分)
SUCCESS_BONUS_CAP = 3.0

# 单次扣分下限 (防误判 · 单次最多扣 1 分)
FAILED_PENALTY_MIN = 0.5


# ════════════════════════════════════════════════════════════════════════════
# 公共接口
# ════════════════════════════════════════════════════════════════════════════

def get_difficulty(task_type: str | None) -> float:
    """
    拿 task_type 难度系数 · 未识别返默认 1.0
    
    用法:
        d = get_difficulty('blender_render')   # 2.5
        d = get_difficulty('unknown_task')     # 1.0
    """
    if not task_type:
        return DEFAULT_DIFFICULTY
    return DIFFICULTY.get(task_type.lower(), DEFAULT_DIFFICULTY)


def success_delta(task_type: str | None) -> float:
    """
    任务 SUCCESS 时 · 信誉应加多少分 · 受难度因子 + 封顶约束
    
    return min(SUCCESS_BONUS_CAP, difficulty)
    """
    d = get_difficulty(task_type)
    return min(SUCCESS_BONUS_CAP, d)


def failed_delta(task_type: str | None) -> float:
    """
    任务 FAILED 时 · 信誉应扣多少分 · 受难度因子 + 下限约束
    
    return -max(FAILED_PENALTY_MIN, difficulty)
    """
    d = get_difficulty(task_type)
    return -max(FAILED_PENALTY_MIN, d)


def get_target_ms(task_type: str | None) -> int:
    """
    P4.17c · 拿 task_type 的目标耗时基线 (ms · speed 评分用)
    
    用法 (rep_scoring._score_speed):
        target = get_target_ms('image_resize')   # 5000
        actual = 4500
        score = 100 if actual <= target else max(0, 100 - (actual-target)/target * 100)
    """
    if not task_type:
        return _DEFAULT_TARGET_MS
    return TARGET_MS.get(task_type.lower(), _DEFAULT_TARGET_MS)


def list_all() -> dict[str, float]:
    """admin 查 / 报表用 · 返回全部已知 task_type 难度"""
    return dict(DIFFICULTY)


def categorize() -> dict[str, list[str]]:
    """按难度分组 · admin UI 用"""
    cats = {
        "trivial": [],   # < 0.5
        "easy":    [],   # 0.5 - 1.0
        "medium":  [],   # 1.0 - 1.5
        "heavy":   [],   # 1.5 - 2.0
        "extreme": [],   # >= 2.0
    }
    for t, d in DIFFICULTY.items():
        if d < 0.5:
            cats["trivial"].append(t)
        elif d < 1.0:
            cats["easy"].append(t)
        elif d < 1.5:
            cats["medium"].append(t)
        elif d < 2.0:
            cats["heavy"].append(t)
        else:
            cats["extreme"].append(t)
    return cats
