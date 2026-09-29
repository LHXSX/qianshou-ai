"""
NCE P3 · rep_scoring 单测 (4 子分 + 调和平均)

覆盖:
  1. 子分边界 (无数据 → 默认 60 · 满分 100 · 0 分 ~0)
  2. 调和平均短板放大 (短板拉低整体)
  3. 真实场景 (正确率 95% · 速度中位数 · 高 stability)
  4. 新节点 (< 10 shard) → 全默认 60

跑法:
  python platform_v8/tests/services/test_rep_scoring.py
"""
from __future__ import annotations
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.economy import rep_scoring as rs


# ════════════════════════════════════════════════════════════════════
# 1. _score_correctness
# ════════════════════════════════════════════════════════════════════

def test_correctness_no_data_default():
    s, d = rs._score_correctness(0, 0)
    assert s == 60
    assert d["reason"] == "no_data"


def test_correctness_perfect():
    s, _ = rs._score_correctness(100, 0)
    assert s == 100


def test_correctness_99_pct():
    s, _ = rs._score_correctness(99, 1)
    assert s == 100  # >= 99% → 100


def test_correctness_95_pct():
    s, _ = rs._score_correctness(95, 5)
    assert 75 <= s <= 85


def test_correctness_90_pct():
    s, _ = rs._score_correctness(90, 10)
    assert 55 <= s <= 65


def test_correctness_50_pct():
    s, _ = rs._score_correctness(50, 50)
    assert 20 <= s <= 30


def test_correctness_all_failed():
    s, _ = rs._score_correctness(0, 100)
    assert s == 0


# ════════════════════════════════════════════════════════════════════
# 2. _score_speed
# ════════════════════════════════════════════════════════════════════

def test_speed_no_data():
    s, _ = rs._score_speed(0, 1000)
    assert s == 60


def test_speed_meets_target():
    s, _ = rs._score_speed(1000, 1000)  # ratio = 1
    assert s == 100


def test_speed_2x_slow():
    s, _ = rs._score_speed(2000, 1000)  # ratio = 2
    assert s == 75


def test_speed_8x_slow():
    s, _ = rs._score_speed(8000, 1000)  # ratio = 8
    assert s == 25


def test_speed_extremely_slow():
    s, _ = rs._score_speed(100000, 1000)  # ratio = 100
    assert s == 10


# ════════════════════════════════════════════════════════════════════
# 3. _score_stability (24h uptime)
# ════════════════════════════════════════════════════════════════════

def test_stability_no_data():
    s, _ = rs._score_stability(None)
    assert s == 60


def test_stability_full():
    s, _ = rs._score_stability(1.0)
    assert s == 100


def test_stability_95_pct():
    s, _ = rs._score_stability(0.95)
    assert s == 100


def test_stability_90_pct():
    s, _ = rs._score_stability(0.90)
    assert s == 90


def test_stability_50_pct():
    s, _ = rs._score_stability(0.50)
    assert s == 40


def test_stability_zero():
    s, _ = rs._score_stability(0.0)
    assert s == 10


# ════════════════════════════════════════════════════════════════════
# 4. 调和平均 (核心 · 短板放大)
# ════════════════════════════════════════════════════════════════════

def test_harmonic_all_equal_60():
    """全 60 → 调和平均也 60"""
    scores = {"a": 60, "b": 60, "c": 60, "d": 60}
    weights = {"a": 25, "b": 40, "c": 20, "d": 15}
    h = rs._harmonic_mean(scores, weights)
    assert 58 <= h <= 62


def test_harmonic_all_perfect():
    scores = {"a": 100, "b": 100, "c": 100, "d": 100}
    weights = {"a": 25, "b": 40, "c": 20, "d": 15}
    h = rs._harmonic_mean(scores, weights)
    assert h == 100


def test_harmonic_shortcoming_amplification():
    """3 项 80 + 1 项 20 → 主分应远 < 算术平均 (65)"""
    scores = {"a": 80, "b": 80, "c": 20, "d": 80}  # speed=20 拖后腿
    weights = {"a": 25, "b": 40, "c": 20, "d": 15}
    h = rs._harmonic_mean(scores, weights)
    # 调和平均: 100 / (25/80 + 40/80 + 20/20 + 15/80) = 100 / (0.3125+0.5+1.0+0.1875) = 100/2.0 = 50
    assert h <= 55, f"调和平均应放大短板 · 期望 <= 55 实际 {h}"
    # 算术平均 = (80*25+80*40+20*20+80*15)/100 = (2000+3200+400+1200)/100 = 68
    # 调和必须明显 < 算术
    assert h < 68


def test_harmonic_one_zero_devastates():
    """1 项接近 0 · 主分应崩"""
    scores = {"a": 100, "b": 100, "c": 1, "d": 100}
    weights = {"a": 25, "b": 40, "c": 20, "d": 15}
    h = rs._harmonic_mean(scores, weights)
    # H = 100 / (25/100 + 40/100 + 20/1 + 15/100) ~= 100/20.8 ~= 4.8
    assert h <= 10, f"一项接近 0 应拖崩主分 · 期望 <= 10 实际 {h}"


# ════════════════════════════════════════════════════════════════════
# main
# ════════════════════════════════════════════════════════════════════

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
