"""
NCE P3+ · task_difficulty 单测

覆盖:
  - 已知 task_type 难度对应正确 (hash=0.3 · blender=2.5)
  - 未知 task_type 默认 1.0
  - 大小写不敏感
  - SUCCESS_BONUS_CAP / FAILED_PENALTY_MIN 封顶约束
  - categorize 分组正确
"""
from __future__ import annotations
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.economy import task_difficulty as td


def test_known_difficulties():
    assert td.get_difficulty("hash_batch") == 0.3
    assert td.get_difficulty("word_count") == 0.4
    assert td.get_difficulty("image_resize") == 0.6
    assert td.get_difficulty("ocr_image") == 1.0  # P4.17a · 按 scripts/tasks 实际名
    assert td.get_difficulty("video_compress") == 1.5
    assert td.get_difficulty("blender_render") == 2.5


def test_unknown_task_default():
    assert td.get_difficulty("unknown_xxx") == 1.0
    assert td.get_difficulty("") == 1.0
    assert td.get_difficulty(None) == 1.0


def test_case_insensitive():
    assert td.get_difficulty("HASH_BATCH") == 0.3
    assert td.get_difficulty("Blender_Render") == 2.5


def test_success_delta_capped():
    """success_delta 封顶 SUCCESS_BONUS_CAP=3.0"""
    assert td.success_delta("hash_batch") == 0.3
    assert td.success_delta("blender_render") == 2.5
    # 即使我们手工放个超大值 · 也被封顶
    td.DIFFICULTY["super_heavy_test"] = 10.0
    try:
        assert td.success_delta("super_heavy_test") == 3.0  # 封到 3
    finally:
        del td.DIFFICULTY["super_heavy_test"]


def test_failed_delta_min():
    """failed_delta 下限 FAILED_PENALTY_MIN=0.5"""
    assert td.failed_delta("hash_batch") == -0.5    # 0.3 < 0.5 · 取 -0.5
    assert td.failed_delta("blender_render") == -2.5  # 2.5 > 0.5 · 取 -2.5


def test_categorize():
    cats = td.categorize()
    assert "trivial" in cats
    assert "easy" in cats
    assert "medium" in cats
    assert "heavy" in cats
    assert "extreme" in cats
    # hash_batch 应在 trivial
    assert "hash_batch" in cats["trivial"]
    # blender 应在 extreme
    assert "blender_render" in cats["extreme"]


if __name__ == "__main__":
    import traceback
    tests = [v for k, v in globals().items()
             if k.startswith("test_") and callable(v)]
    print(f"运行 {len(tests)} 个测试...\n")
    passed = failed = 0
    for t in tests:
        try:
            t()
            print(f"  ✅ {t.__name__}")
            passed += 1
        except Exception as exc:
            print(f"  ❌ {t.__name__}: {exc}")
            traceback.print_exc()
            failed += 1
    print(f"\n{'=' * 60}")
    print(f"  通过: {passed} · 失败: {failed} · 总: {len(tests)}")
    sys.exit(0 if failed == 0 else 1)
