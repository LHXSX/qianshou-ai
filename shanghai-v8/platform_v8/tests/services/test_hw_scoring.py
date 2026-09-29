"""
NCE P2 · hw_scoring 单测

覆盖:
  1. 子分边界 (0 cores · 0 ram · 0 gpu)
  2. 真实节点配置对应合理档位
     - Apple M4 16GB 12GB VRAM → B
     - Apple M5 Pro 48GB 36GB VRAM → A
     - Intel Ultra 9 24c 196GB + 16GB NVIDIA → A
     - 旗舰 (4090 · 128GB · M5 Max) → S
     - 入门 (i3 · 4GB · 无 GPU) → D
  3. 档位归类 (阈值边界 90/75/60/45/0)
  4. 多卡加成
  5. 品牌识别 (字符串匹配 case-insensitive)

跑法:
  python platform_v8/tests/services/test_hw_scoring.py
"""
from __future__ import annotations
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.economy import hw_scoring as hs
from platform_v8.core.worker import WorkerCapabilities


def _caps(**kwargs):
    """造一个 WorkerCapabilities · 默认全 0"""
    return WorkerCapabilities(**kwargs)


# ════════════════════════════════════════════════════════════════════
# 1. 子分边界
# ════════════════════════════════════════════════════════════════════

def test_score_cpu_zero_cores():
    assert hs._score_cpu(0, "") == 0


def test_score_cpu_curve():
    # 4 核 ≈ 20  · 8 核 ≈ 50  · 16 核 ≈ 80
    assert 18 <= hs._score_cpu(4, "") <= 22
    assert 48 <= hs._score_cpu(8, "") <= 52
    assert 78 <= hs._score_cpu(16, "") <= 82
    # 32+ 核饱和到 100
    assert hs._score_cpu(64, "") == 100


def test_score_cpu_brand_bonus():
    # 未进 YAML 的品牌仍走 legacy bonus (Xeon W-)
    base = hs._score_cpu_legacy(10, "")
    bonus = hs._score_cpu_legacy(10, "Intel Xeon W-3400")
    assert bonus > base
    assert bonus - base >= 8


def test_score_cpu_yaml_overrides_legacy():
    # YAML 命中 M4 Max → S 档系数，不再用核心数曲线
    score = hs._score_cpu(10, "Apple M4 Max")
    assert 90 <= score <= 100
    _s, meta = hs._score_cpu_with_meta(10, "Apple M4 Max")
    assert meta.get("cpu_rank_source") == "yaml"
    assert meta.get("cpu_rank_grade") == "S"

def test_score_ram_zero():
    assert hs._score_ram(0) == 0


def test_score_ram_curve():
    # 16GB = 50, 32GB = 70, 64GB = 85
    assert 48 <= hs._score_ram(16 * 1024) <= 52
    assert 68 <= hs._score_ram(32 * 1024) <= 72
    assert 83 <= hs._score_ram(64 * 1024) <= 87
    # 256GB 饱和
    assert hs._score_ram(256 * 1024) == 100


def test_score_gpu_no_gpu():
    # 无 GPU 应给最低 5 分 (CPU-only 任务可用)
    assert hs._score_gpu(0, 0, "") == 5


def test_score_gpu_low_vram():
    # 4GB VRAM ≈ 30
    s = hs._score_gpu(1, 4 * 1024, "")
    assert 28 <= s <= 32


def test_score_gpu_high_vram():
    # 24GB VRAM ≈ 90 + brand bonus
    s = hs._score_gpu(1, 24 * 1024, "RTX 4090")
    assert s >= 95  # 90 base + 20 bonus = 110 → cap 100


def test_score_gpu_multi_card():
    # 2 卡 4080 (16GB · 加 5 多卡)
    s1 = hs._score_gpu(1, 16 * 1024, "RTX 4080")  # 75 + 15 = 90
    s2 = hs._score_gpu(2, 16 * 1024, "RTX 4080")  # 75 + 15 + 5 = 95
    assert s2 > s1


# ════════════════════════════════════════════════════════════════════
# 2. 真实节点配置 (3 个生产节点 + 2 个推演)
# ════════════════════════════════════════════════════════════════════

def test_real_apple_m4_16gb():
    """生产节点 cffe2a36 · Apple M4 10c 16GB · 12GB Apple GPU"""
    caps = _caps(
        cpu_cores=10,
        cpu_brand="Apple M4",
        total_memory_mb=16384,
        gpu_count=1,
        gpu_model="Apple Silicon (Metal + MLX)",
        vram_mb=12288,
    )
    r = hs.evaluate(caps)
    # M4 10c · 16G RAM · 12G VRAM · 应当 B 或 C (主流入门)
    assert r.hw_tier in ("B", "C"), f"expected B/C got {r.hw_tier} · score={r.hw_score}"
    assert 45 <= r.hw_score <= 75
    print(f"\n  Apple M4 → tier={r.hw_tier} score={r.hw_score} sub={r.sub_scores}")


def test_real_apple_m5_pro_48gb():
    """生产节点 af47f7bb · Apple M5 Pro 18c 48GB · 36GB Apple GPU"""
    caps = _caps(
        cpu_cores=18,
        cpu_brand="Apple M5 Pro",
        total_memory_mb=49152,
        gpu_count=1,
        gpu_model="Apple Silicon (Metal + MLX)",
        vram_mb=36864,
    )
    r = hs.evaluate(caps)
    # M5 Pro 高端 · 48G RAM · 36G VRAM · 应 A 档
    assert r.hw_tier in ("A", "S"), f"expected A/S got {r.hw_tier} · score={r.hw_score}"
    assert r.hw_score >= 75
    print(f"\n  Apple M5 Pro → tier={r.hw_tier} score={r.hw_score} sub={r.sub_scores}")


def test_real_intel_ultra_9_24c_196gb_nvidia():
    """生产节点 LAPTOP-L3KB91D8 · Intel Ultra 9 275HX 24c 196GB · NVIDIA 16GB"""
    caps = _caps(
        cpu_cores=24,
        cpu_brand="Intel(R) Core(TM) Ultra 9 275HX",
        total_memory_mb=196029,
        gpu_count=1,
        gpu_model="NVIDIA (CUDA)",  # 不知具体型号 · 没匹配 bonus
        vram_mb=16303,
    )
    r = hs.evaluate(caps)
    # Ultra 9 24c + 196GB + 16G NVIDIA · 应 A 档
    assert r.hw_tier in ("A", "S"), f"expected A/S got {r.hw_tier} · score={r.hw_score}"
    assert r.hw_score >= 75
    print(f"\n  Intel Ultra 9 + NVIDIA → tier={r.hw_tier} score={r.hw_score} sub={r.sub_scores}")


def test_flagship_rtx_4090_128gb():
    """旗舰 · RTX 4090 + Threadripper Pro + 128GB · 应 S 档"""
    caps = _caps(
        cpu_cores=32,
        cpu_brand="AMD Ryzen Threadripper PRO 7995WX",
        total_memory_mb=128 * 1024,
        gpu_count=1,
        gpu_model="NVIDIA RTX 4090",
        vram_mb=24 * 1024,
    )
    r = hs.evaluate(caps)
    assert r.hw_tier == "S", f"expected S got {r.hw_tier} · score={r.hw_score}"
    print(f"\n  RTX 4090 旗舰 → tier={r.hw_tier} score={r.hw_score} sub={r.sub_scores}")


def test_entry_level_no_gpu():
    """入门 · i3 4c · 4GB · 无 GPU · 应 D 档"""
    caps = _caps(
        cpu_cores=4,
        cpu_brand="Intel Core i3-1115G4",
        total_memory_mb=4096,
        gpu_count=0,
    )
    r = hs.evaluate(caps)
    assert r.hw_tier == "D", f"expected D got {r.hw_tier} · score={r.hw_score}"
    print(f"\n  入门机 → tier={r.hw_tier} score={r.hw_score} sub={r.sub_scores}")


# ════════════════════════════════════════════════════════════════════
# 3. 档位归类
# ════════════════════════════════════════════════════════════════════

def test_tier_thresholds_exact():
    assert hs._tier_for_score(95) == "S"
    assert hs._tier_for_score(90) == "S"  # 边界
    assert hs._tier_for_score(89.99) == "A"
    assert hs._tier_for_score(75) == "A"
    assert hs._tier_for_score(74.99) == "B"
    assert hs._tier_for_score(60) == "B"
    assert hs._tier_for_score(45) == "C"
    assert hs._tier_for_score(44.99) == "D"
    assert hs._tier_for_score(0) == "D"


# ════════════════════════════════════════════════════════════════════
# 4. None / 空 capabilities 不应崩
# ════════════════════════════════════════════════════════════════════

def test_evaluate_none_caps():
    r = hs.evaluate(None)
    assert r.hw_tier == "D"
    assert r.hw_score == 0


def test_evaluate_empty_caps():
    r = hs.evaluate(WorkerCapabilities())
    # 2026-06-24 · 综合分只对实测维度(CPU/RAM/GPU)归一化加权,不再被 storage/network
    # 占位常量 50 垫高。全 0 机器: (0*30 + 0*25 + 5*35) / 90 ≈ 1.94 · tier D。
    assert r.hw_tier == "D"
    assert 0 <= r.hw_score <= 5


def test_evaluate_no_placeholder_dilution():
    """2026-06-24 回归 · CPU/RAM/GPU 满分的机器综合分应达 100,不被 storage/network
    占位常量(50)稀释到 ~95。"""
    full = WorkerCapabilities(
        cpu_cores=64, cpu_brand="Threadripper PRO",
        total_memory_mb=512 * 1024, gpu_count=4, vram_mb=80 * 1024, gpu_model="H100",
    )
    r = hs.evaluate(full)
    assert r.sub_scores["cpu"] == 100 and r.sub_scores["ram"] == 100 and r.sub_scores["gpu"] == 100
    assert r.hw_score == 100  # 归一化加权: (100*30+100*25+100*35)/90 = 100
    assert r.hw_tier == "S"


# ════════════════════════════════════════════════════════════════════
# 5. 字段名兜底 (老节点用 memory_gb · 新节点用 total_memory_mb)
# ════════════════════════════════════════════════════════════════════

def test_fallback_memory_gb_to_mb():
    """老节点只有 memory_gb · evaluate 应自动转换"""
    caps = _caps(cpu_cores=8, memory_gb=16, gpu_count=0)  # 不传 total_memory_mb
    r = hs.evaluate(caps)
    # RAM 应识别为 16GB · 子分 ≈ 50
    assert 45 <= r.sub_scores["ram"] <= 55


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
