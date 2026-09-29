"""
cpu_rank YAML 加载 / 查找 / 可替换路径 单测
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.economy import cpu_rank as cr
from platform_v8.services.economy import hw_scoring as hs


def setup_function(_fn=None):
    cr.reset_for_tests()


def teardown_function(_fn=None):
    cr.reset_for_tests()


def test_lookup_m4_vs_m4_max():
    m4 = cr.lookup("Apple M4")
    m4max = cr.lookup("Apple M4 Max")
    # 2026-09-17 数据变更（用户批准）：m4 由 B/0.572 提到 A/28 + 显式 coeff 0.760381
    assert m4 is not None and m4.grade == "A"
    assert m4max is not None and m4max.grade == "S"
    assert abs(m4.coeff - 0.760381) < 1e-6
    assert m4.coeff > 0.55  # 高于"未上报"兜底上限 ⇒ 诚实上报不再吃亏
    assert abs(m4max.coeff - 1.0) < 0.08  # S base ± within-grade
    assert m4max.coeff > m4.coeff


def test_lookup_longest_match_i9():
    hit = cr.lookup("Intel Core i9-14900KS")
    assert hit is not None
    assert hit.match == "i9-14900ks"
    assert hit.grade == "S"


def test_env_override_path(tmp_path, monkeypatch):
    custom = tmp_path / "custom_rank.yaml"
    custom.write_text(
        "version: 1\n"
        "grade_coeffs:\n  S: 1.0\n  A: 0.8\n  B: 0.6\n  C: 0.4\n"
        "entries:\n"
        "  - match: \"specialchip\"\n"
        "    grade: S\n"
        "    rank: 1\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("V8_CPU_RANK_PATH", str(custom))
    cr.reset_for_tests()
    hit = cr.lookup("My SpecialChip X")
    assert hit is not None
    assert hit.match == "specialchip"
    assert hit.grade == "S"
    assert hit.coeff == 1.0


def test_reload_cpu_rank(tmp_path):
    p = tmp_path / "r.yaml"
    p.write_text(
        "version: 1\ngrade_coeffs: {S: 1.0, A: 0.8, B: 0.6, C: 0.4}\n"
        "entries:\n  - {match: reloadchip, grade: A, rank: 1}\n",
        encoding="utf-8",
    )
    cr.reload_cpu_rank(p)
    assert cr.lookup("reloadchip").grade == "A"


def test_bad_yaml_falls_back_empty(tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text(":::: not yaml {{{", encoding="utf-8")
    table = cr.reload_cpu_rank(bad)
    assert table.entries == []
    assert cr.lookup("Apple M4") is None


def test_missing_file_falls_back_empty(tmp_path):
    table = cr.reload_cpu_rank(tmp_path / "nope.yaml")
    assert table.entries == []


def test_hw_scoring_yaml_detail():
    cr.reset_for_tests()  # default packaged yaml
    score, meta = hs._score_cpu_with_meta(10, "Apple M4 Max")
    assert meta["cpu_rank_source"] == "yaml"
    assert meta["cpu_rank_grade"] == "S"
    assert abs(score - meta["cpu_coeff"] * 100) < 0.01


def test_hw_scoring_fallback_coeff_cap():
    cr.reload_cpu_rank("/nonexistent/cpu_rank.yaml")
    score, meta = hs._score_cpu_with_meta(64, "TotallyUnknownCPU")
    assert meta["cpu_rank_source"] == "fallback"
    # 2026-09-17 用户批准：兜底上限 0.55 → 0.35（低于表内最弱档 C，避免"未知压过已知最弱"）
    assert meta["cpu_coeff"] <= 0.35
    assert meta["cpu_coeff"] == 0.35  # 64 核 → legacy 曲线满值，被 cap 钳到 0.35
    assert score == 100.0  # legacy core curve still full


# ── 2026-09-17 · 品牌串归一化(匹配前置层) ──────────────────────────────
# 数据来源: 生产 we_workers.capabilities->>'cpu_brand' 实际出现的 22 个品牌族
_PROD_BRANDS = (
    ("Apple M4", "m4", True),  # → m4 A 0.760381
    ("Apple M5 Pro", "m5 pro", True),  # → m5 pro S 0.93
    ("Apple Silicon", "", True),  # → apple silicon B 0.564
    ("12th Gen Intel(R) Core(TM) i7-12800HX", "i7-12800hx", True),  # → i7-12800hx B 0.578
    ("13th Gen Intel(R) Core(TM) i7-13620H", "i7-13620h", True),  # → i7-13620h B 0.576
    ("12th Gen Intel(R) Core(TM) i5-12450H", "i5-12450h", True),  # → i5-12450h B 0.566
    ("Intel(R) Core(TM) Ultra 9 275HX", "ultra 9 275hx", True),  # → ultra 9 275hx A 0.741
    ("Intel(R) Core(TM) Ultra 5 125H", "ultra 5 125h", True),  # → ultra 5 125h A 0.74
    ("Intel(R) Core(TM) i7-7700 CPU @ 3.60GHz", "i7-7700", True),  # → i7-7700 B 0.558
    ("Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz", "i7-9750h", True),  # → i7-9750h B 0.572
    ("Intel(R) Core(TM) i7-10510U CPU @ 1.80GHz", "i7-10510u", True),  # → i7-10510u B 0.56
    ("Intel(R) Core(TM) i5-14600K", "i5-14600k", True),  # → i5-14600k A 0.745
    ("Intel(R) Core(TM) i5-14600KF", "i5-14600kf", True),  # → i5-14600kf A 0.744
    ("11th Gen Intel(R) Core(TM) i5-11400F @ 2.60GHz", "i5-11400f", True),  # → i5-11400f B 0.568
    ("13th Gen Intel(R) Core(TM) i5-13400F", "i5-13400f", True),  # → i5-13400f B 0.569
    ("12th Gen Intel(R) Core(TM) i5-12400F", "i5-12400f", True),  # → i5-12400f B 0.57
    ("Intel(R) Xeon(R) CPU E5-2697 v4 @ 2.30GHz", "e5-2697 v4", True),  # → xeon e5-2697 v4 B 0.556
    ("AMD Ryzen 9 5950X 16-Core Processor", "ryzen 9 5950x", True),  # → ryzen 9 5950x A 0.743
    ("AMD Ryzen 7 7800X3D 8-Core Processor", "ryzen 7 7800x3d", True),  # → ryzen 7 7800x3d A 0.742
    ("AMD Ryzen Z1 Extreme", "", True),  # → ryzen z1 extreme B 0.565
    ("Intel(R) Core(TM) i9-14900HX", "i9-14900hx", True),  # → i9-14900hx A 0.746
    ("12th Gen Intel(R) Core(TM) i7-12650H", "i7-12650h", True),  # → i7-12650h B 0.574
)


def test_normalize_never_truncates_model_digits():
    """防"归一化过宽张冠李戴": 型号数字与后缀必须完整保留。"""
    s = "12th Gen Intel(R) Core(TM) i7-12800HX"
    assert cr.normalize_brand(s) == "intel i7-12800hx"
    tok = cr.model_token(s)
    assert tok == "i7-12800hx"
    assert tok != "i7-1280"      # 反例: 截断数字
    assert tok != "i7"           # 反例: 丢数字
    assert tok != "i7-12800h"    # 反例: 丢后缀
    hit = cr.lookup(s)  # 2026-09-17 起该型号已补入表（覆盖面补全）
    assert hit is not None and hit.match == "i7-12800hx"
    assert hit.grade == "B" and hit.coeff == 0.578


def test_model_token_and_match_production_brands():
    """表驱动: 生产实际 brand 串 → 归一 token + 是否命中。"""
    for brand, want_tok, want_hit in _PROD_BRANDS:
        tok = cr.model_token(brand)
        assert tok == want_tok, f"{brand!r}: token={tok!r} want={want_tok!r}"
        hit = cr.lookup(brand)
        assert (hit is not None) is want_hit, f"{brand!r}: unexpectedly hit={hit}"


def test_lookup_normalization_adds_separator_variant_match():
    """归一化层补上"仅分隔符/修饰不同"的写法(纯子串匹配做不到)。"""
    hit = cr.lookup("Intel Core i7 14700K")
    assert hit is not None
    assert hit.match == "i7-14700k"
    assert hit.source == "yaml-normalized"
    assert cr.lookup("12th Gen Intel(R) Core(TM) i9 14900KS").match == "i9-14900ks"


def test_lookup_existing_matches_unchanged():
    """零回归: 原有子串命中逐条不变。"""
    assert cr.lookup("Apple M4").coeff == 0.760381  # 2026-09-17 数据变更
    assert cr.lookup("Apple M5 Pro").grade == "S"
    assert cr.lookup("Apple M4 Max").match == "m4 max"
    assert cr.lookup("Intel Core i9-14900KS").match == "i9-14900ks"
    assert cr.lookup("Intel Core i9-14900KS").source == "yaml"


# ── 2026-09-17 · 显式 coeff 支持 + "诚实上报不劣于装死"不变量 ──────────────
import pytest


def _write(tmp_path, body: str):
    p = tmp_path / "t.yaml"
    p.write_text(body, encoding="utf-8")
    return p


def test_explicit_coeff_overrides_grade_formula(tmp_path):
    p = _write(tmp_path,
        "version: 1\ngrade_coeffs: {S: 1.0, A: 0.8, B: 0.6, C: 0.4}\n"
        "entries:\n"
        "  - {match: auto1, grade: B, rank: 1}\n"
        "  - {match: pinned, grade: B, rank: 2, coeff: 0.700000}\n")
    cr.reload_cpu_rank(p)
    assert cr.lookup("pinned").coeff == 0.7


def test_explicit_coeff_does_not_rescale_other_entries(tmp_path):
    """核心价值：新增一条显式条目，同档既有条目系数**零变化**。"""
    p1 = _write(tmp_path, "version: 1\ngrade_coeffs: {B: 0.6}\nentries:\n"
        "  - {match: a, grade: B, rank: 1}\n"
        "  - {match: b, grade: B, rank: 2}\n"
        "  - {match: c, grade: B, rank: 3}\n")
    cr.reload_cpu_rank(p1)
    before = {m: c for m, _g, _r, c in cr._ensure_table().entries}

    p2 = _write(tmp_path, "version: 1\ngrade_coeffs: {B: 0.6}\nentries:\n"
        "  - {match: a, grade: B, rank: 1}\n"
        "  - {match: b, grade: B, rank: 2}\n"
        "  - {match: c, grade: B, rank: 3}\n"
        "  - {match: d, grade: B, rank: 4, coeff: 0.550000}\n")
    cr.reload_cpu_rank(p2)
    after = {m: c for m, _g, _r, c in cr._ensure_table().entries}
    assert {k: after[k] for k in before} == before      # 既有三条 逐条不变
    assert after["d"] == 0.55


def test_mixed_explicit_and_auto_is_well_defined(tmp_path):
    """混用行为明确：auto 只按 auto 集合算 i/n；explicit 原值生效。"""
    p = _write(tmp_path, "version: 1\ngrade_coeffs: {B: 0.6}\nentries:\n"
        "  - {match: a, grade: B, rank: 1}\n"
        "  - {match: pin, grade: B, rank: 2, coeff: 0.5}\n"
        "  - {match: b, grade: B, rank: 3}\n")
    cr.reload_cpu_rank(p)
    d = {m: c for m, _g, _r, c in cr._ensure_table().entries}
    assert d["pin"] == 0.5
    assert d["a"] == 0.6 * (1 - 0.08 * 0 / 2) == 0.6
    assert d["b"] == round(0.6 * (1 - 0.08 * 1 / 2), 6)


@pytest.mark.parametrize("bad", ["-0.1", "1.5", '"high"'])
def test_invalid_explicit_coeff_is_loud_not_silent(tmp_path, bad):
    """非法 coeff(负/超1/非数) → 明确报错路径(table 退回空) · 不静默当成某个值。"""
    p = _write(tmp_path, "version: 1\ngrade_coeffs: {B: 0.6}\nentries:\n"
        f"  - {{match: bad, grade: B, rank: 1, coeff: {bad}}}\n")
    t = cr.reload_cpu_rank(p)
    assert t.entries == []          # 走 _empty_table 的告警路径(logger.error 带原因)
    assert cr.lookup("bad") is None


def test_invariant_reported_entries_never_lose_to_unreported():
    """不变量（2026-09-17 由 xfail 转正）：兜底上限降到 0.35 后，全表应无违反。"""
    """不变量：任何可被如实上报的条目，其 coeff 必须 >= 未上报兜底上限。"""
    cr.reset_for_tests()
    t = cr._ensure_table()
    losers = [(m, g, c) for m, g, r, c in t.entries if c < cr._FALLBACK_COEFF_CAP]
    assert not losers, (
        f"以下条目 coeff < 兜底上限 {cr._FALLBACK_COEFF_CAP} ⇒ 如实上报反而不如装死: {losers}"
    )
