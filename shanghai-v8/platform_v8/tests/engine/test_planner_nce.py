"""
NCE P1 · planner.py 单测 (排序 + flag + 影子模式)

覆盖:
  1. flag OFF 时 · 排序跟改造前等价 (零回归 · 守住老业务)
  2. flag ON 时 · NCE 排序优先 reputation 高的
  3. 短板放大: load 高的不能赢
  4. 影子模式 · audit 写入不阻塞 (mock DB 异常也能继续)
  5. composite_score 边界 (load=1 / reputation=0 / capability=0)
  6. fail-safe: feature_flags 异常 · 退回老排序

跑法:
  pytest platform_v8/tests/engine/test_planner_nce.py -v
  或 python platform_v8/tests/engine/test_planner_nce.py
"""
from __future__ import annotations
import sys
import uuid
from pathlib import Path
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.core import Worker, Shard, ShardStatus
from platform_v8.core.enums import WorkerStatus
from platform_v8.core.worker import WorkerCapabilities
from platform_v8.engine import planner


def _mk_worker(load=0.3, reputation=0.5, capability_score=50.0, name="w",
               rep_main=None, hw_tier="B", cpu_brand="", cpu_cores=8,
               throttle_pct=100, gpu_count=0, gpu_model="", vram_mb=0):
    """造一个 Worker · 简化版
    
    rep_main 默认从 reputation 推算 (NCE 体系 planner 实际读 rep_main 而非老 reputation)
    """
    from datetime import datetime, timedelta, timezone
    return Worker(
        id=str(uuid.uuid4()),
        owner_id=1,
        name=name,
        status=WorkerStatus.ONLINE,
        capabilities=WorkerCapabilities(
            cpu_brand=cpu_brand,
            cpu_cores=cpu_cores,
            throttle_pct=throttle_pct,
            gpu_count=gpu_count,
            gpu_model=gpu_model,
            vram_mb=vram_mb,
        ),
        load=load,
        active_shards=0,
        reputation=reputation,
        capability_score=capability_score,
        rep_main=int(reputation * 100) if rep_main is None else rep_main,
        hw_tier=hw_tier,
        # 老节点 · 不触发 P4.11 冷启动加成 (避免测试干扰)
        registered_at=datetime.now(timezone.utc) - timedelta(days=30),
    )


def _mk_shard():
    return Shard(
        workload_id=str(uuid.uuid4()),
        index=0,
        total=1,
        status=ShardStatus.PENDING,
        input_ref="test://input",
    )


# ════════════════════════════════════════════════════════════════════
# 1. _sort_workers_old 跟改造前完全等价
# ════════════════════════════════════════════════════════════════════

def test_sort_old_equals_load_ascending():
    a = _mk_worker(load=0.9, name="a-high")
    b = _mk_worker(load=0.1, name="b-low")
    c = _mk_worker(load=0.5, name="c-mid")
    out = planner._sort_workers_old([a, b, c])
    assert [w.name for w in out] == ["b-low", "c-mid", "a-high"]


# ════════════════════════════════════════════════════════════════════
# 2. NCE v1 排序 · reputation 起作用
# ════════════════════════════════════════════════════════════════════

def test_nce_v1_high_rep_wins_on_equal_load():
    """同负载下 · 高信誉优先"""
    a = _mk_worker(load=0.3, reputation=0.3, capability_score=80, name="low-rep")
    b = _mk_worker(load=0.3, reputation=0.9, capability_score=80, name="high-rep")
    out = planner._sort_workers_nce_v1([a, b])
    assert out[0].name == "high-rep"


def test_nce_v1_low_load_wins_over_high_rep():
    """高负载强降权 · 空闲弱机可反超忙碌强机"""
    # 同 power/rep/contrib · load 主导
    a = _mk_worker(load=0.05, reputation=0.5, cpu_brand="UnknownCPU", cpu_cores=4)
    b = _mk_worker(load=0.95, reputation=1.0, cpu_brand="UnknownCPU", cpu_cores=4)
    out = planner._sort_workers_nce_v1([a, b])
    assert out[0].load == 0.05


def test_nce_v1_composite_score_formula():
    """精确验算 v2: 100*power*contrib*rep_factor*(1-load)^1.5"""
    planner._ctx_requires_gpu = False
    w = _mk_worker(
        load=0.3, reputation=0.8, cpu_brand="UnknownXYZ", cpu_cores=0, throttle_pct=100,
    )
    # Unknown + 0 cores → power=0 → score=0
    assert planner._composite_score_nce_v1(w) == 0.0

    w2 = _mk_worker(
        load=0.0, reputation=1.0, cpu_brand="Apple M4 Max", cpu_cores=16, throttle_pct=100,
    )
    power = planner._worker_power(w2)
    rep_factor = 0.4 + 0.6 * 1.0
    expected = 100.0 * power * 1.0 * rep_factor * (1.0 ** 1.5)
    actual = planner._composite_score_nce_v1(w2)
    assert abs(actual - expected) < 0.05, f"expected={expected} actual={actual} power={power}"


def test_nce_v1_boundary_values():
    """边界: load=1 → 主项 0 · 不应崩溃"""
    w = _mk_worker(load=1.0, reputation=0.0, cpu_brand="Apple M4 Max", cpu_cores=16)
    assert abs(planner._composite_score_nce_v1(w)) < 0.001

    w2 = _mk_worker(load=0.0, reputation=1.0, cpu_brand="Apple M4 Max", cpu_cores=16)
    assert planner._composite_score_nce_v1(w2) > 50


def test_nce_v1_clamp_invalid_inputs():
    """负数 load 钳制为 0 · 不抛异常"""
    w = _mk_worker(load=-0.5, reputation=1.0, cpu_brand="Apple M4 Max", cpu_cores=16)
    s = planner._composite_score_nce_v1(w)
    assert s > 0


# ════════════════════════════════════════════════════════════════════
# 3. flag OFF · 走老排序 (零回归 · 这是 P1 的核心承诺)
# ════════════════════════════════════════════════════════════════════

def test_schedule_with_all_flags_off_uses_old_sort():
    """flag 全 OFF · 排序按 load 升序 · 跟改造前完全等价"""
    # 高负载 + 高信誉 vs 低负载 + 低信誉
    high_load_high_rep = _mk_worker(load=0.8, reputation=0.9, name="A")
    low_load_low_rep = _mk_worker(load=0.1, reputation=0.1, name="B")
    workers = [high_load_high_rep, low_load_low_rep]
    shards = [_mk_shard()]

    # mock flag 全部 OFF
    with patch.object(planner, "_flag_enabled", return_value=False):
        # mock _log_planner_decision_safe (避免 DB 调用)
        with patch.object(planner, "_log_planner_decision_safe"):
            assignments = planner.schedule_assignments(
                shards, workers, workload=None
            )

    # 老排序按 load 升序 · 应选 B (load=0.1)
    assert len(assignments) == 1
    assert assignments[0].worker_id == low_load_low_rep.id


def test_schedule_cross_owner_workers_not_filtered():
    """账号 A 的任务可派给账号 B 的节点 · 调度不按 owner 隔离"""
    class FakeSpec:
        task_type = "hash_batch"
        required_software = []
        min_memory_mb = 0
        requires_gpu = False
        executor = "python3"

    class FakeWorkload:
        owner_id = 3  # Test1
        spec = FakeSpec()

    # 仅异账号节点在线且更空闲
    foreign = _mk_worker(load=0.05, reputation=0.5, name="owner-B")
    foreign.owner_id = 4
    own = _mk_worker(load=0.9, reputation=0.5, name="owner-A")
    own.owner_id = 3
    shards = [_mk_shard()]

    with patch.object(planner, "_flag_enabled", return_value=False):
        with patch.object(planner, "_log_planner_decision_safe"):
            assignments = planner.schedule_assignments(
                shards, [own, foreign], workload=FakeWorkload()
            )

    assert len(assignments) == 1
    assert assignments[0].worker_id == foreign.id


def test_schedule_with_flag_on_uses_nce_sort():
    """flag ON · 排序按 NCE composite_score · 高信誉可能逆转"""
    # 同 load · 信誉差异极大
    w1 = _mk_worker(load=0.3, reputation=0.1, name="low-rep")
    w2 = _mk_worker(load=0.3, reputation=0.9, name="high-rep")
    shards = [_mk_shard()]

    def fake_flag(name, owner_id):
        return name == "nce_planner_use_reputation"

    with patch.object(planner, "_flag_enabled", side_effect=fake_flag):
        with patch.object(planner, "_log_planner_decision_safe"):
            assignments = planner.schedule_assignments(
                shards, [w1, w2], workload=None
            )

    # NCE 排序选高 reputation
    assert assignments[0].worker_id == w2.id


# ════════════════════════════════════════════════════════════════════
# 4. 影子模式 audit 不阻塞 (DB 异常时派单照样成)
# ════════════════════════════════════════════════════════════════════

def test_shadow_mode_db_exception_does_not_block_dispatch():
    """影子写 DB 抛异常 · 派单照样完成 · 这是 fail-safe 核心"""
    workers = [_mk_worker(load=0.1, name="A"), _mk_worker(load=0.9, name="B")]
    shards = [_mk_shard()]

    def fake_flag(name, owner_id):
        return name == "nce_planner_shadow_mode"

    # 让 _log_planner_decision_impl 抛异常 · 但 _safe 应吞下
    with patch.object(planner, "_flag_enabled", side_effect=fake_flag):
        with patch.object(planner, "_log_planner_decision_impl",
                          side_effect=Exception("simulated DB down")):
            assignments = planner.schedule_assignments(
                shards, workers, workload=None
            )

    # 派单仍成 (老排序选低 load)
    assert len(assignments) == 1
    assert assignments[0].worker_id == workers[0].id  # A · load=0.1


def test_fail_safe_when_feature_flag_module_breaks():
    """feature_flags 模块整体异常 · 退回老排序 · 不崩"""
    workers = [_mk_worker(load=0.5, name="X")]
    shards = [_mk_shard()]

    # 让 _flag_enabled 抛异常 · 模拟 feature_flags 模块挂
    with patch.object(planner, "_flag_enabled",
                      side_effect=Exception("feature_flags down")):
        # _flag_enabled 自己有 try/except · 抛了应返 False
        # 这个测试主要验证 flag 异常不传染到 schedule_assignments
        # 但因为 mock 直接 raise 不走 try/except · 我们做反向验证:
        # 真实情况是 _flag_enabled 函数自己捕获 · 这里改为直接验证 _flag_enabled fail-safe
        pass

    # 改用真实调用 · mock ff.is_enabled 抛错
    with patch("platform_v8.services.ops.feature_flags.is_enabled",
               side_effect=Exception("inner err")):
        result = planner._flag_enabled("nce_anything", 1)
    assert result is False, "fail-safe 应返 False"


# ════════════════════════════════════════════════════════════════════
# 5. 排序对照 (新旧算法在常见场景下选择对比)
# ════════════════════════════════════════════════════════════════════

def test_nce_v1_strong_cpu_beats_weak_same_load():
    """同 idle · YAML 强机 (M4 Max) 分高于弱机 (M4)"""
    planner._ctx_requires_gpu = False
    weak = _mk_worker(load=0.0, reputation=0.6, name="m4",
                      cpu_brand="Apple M4", cpu_cores=10)
    strong = _mk_worker(load=0.0, reputation=0.6, name="m4max",
                        cpu_brand="Apple M4 Max", cpu_cores=16)
    assert planner._composite_score_nce_v1(strong) > planner._composite_score_nce_v1(weak)
    out = planner._sort_workers_nce_v1([weak, strong])
    assert out[0].name == "m4max"


def test_nce_v1_throttle_halves_weight():
    """throttle 50% 相对 100% 降权"""
    planner._ctx_requires_gpu = False
    full = _mk_worker(load=0.0, reputation=0.6, cpu_brand="Apple M4 Max",
                      cpu_cores=16, throttle_pct=100, name="full")
    half = _mk_worker(load=0.0, reputation=0.6, cpu_brand="Apple M4 Max",
                      cpu_cores=16, throttle_pct=50, name="half")
    s_full = planner._composite_score_nce_v1(full)
    s_half = planner._composite_score_nce_v1(half)
    assert abs(s_half / s_full - 0.5) < 0.02


def test_nce_v1_busy_strong_loses_to_idle_weak():
    """高 load 强机可被空闲弱机反超"""
    planner._ctx_requires_gpu = False
    busy = _mk_worker(load=0.9, reputation=0.6, name="busy-strong",
                      cpu_brand="Apple M4 Max", cpu_cores=16)
    idle = _mk_worker(load=0.0, reputation=0.6, name="idle-weak",
                      cpu_brand="Apple M4", cpu_cores=10)
    out = planner._sort_workers_nce_v1([busy, idle])
    assert out[0].name == "idle-weak"


def test_hw_tier_filter_no_workload():
    """workload=None · 不过滤 · 全部留下"""
    a = _mk_worker(name="A"); a.hw_tier = "D"
    b = _mk_worker(name="B"); b.hw_tier = "S"
    out = planner._filter_by_hw_tier([a, b], workload=None)
    assert len(out) == 2


def test_hw_tier_filter_by_difficulty_heavy():
    """blender_render (难度 2.5) · 应只留 S/A/B · 排 C/D"""
    class FakeSpec: task_type = "blender_render"
    class FakeWorkload: spec = FakeSpec()

    workers = []
    for tier in ["S", "A", "B", "C", "D"]:
        w = _mk_worker(name=f"w-{tier}")
        w.hw_tier = tier
        workers.append(w)

    out = planner._filter_by_hw_tier(workers, workload=FakeWorkload())
    tiers = [w.hw_tier for w in out]
    assert "S" in tiers and "A" in tiers and "B" in tiers
    assert "C" not in tiers
    assert "D" not in tiers


def test_hw_tier_filter_by_difficulty_medium():
    """audio_transcode (难度 0.9 < 1.0) · 不过滤 (轻任务全档可用)"""
    class FakeSpec: task_type = "audio_transcode"
    class FakeWorkload: spec = FakeSpec()

    workers = []
    for tier in ["A", "B", "C", "D"]:
        w = _mk_worker(name=f"w-{tier}")
        w.hw_tier = tier
        workers.append(w)

    out = planner._filter_by_hw_tier(workers, workload=FakeWorkload())
    assert len(out) == 4  # 全留 · 0.9 < 1.0


def test_hw_tier_filter_explicit_spec_required():
    """spec.required_hw_tier = "A" · 强制只留 S/A"""
    class FakeSpec:
        task_type = "hash_batch"   # 难度 0.3 · 本不过滤
        required_hw_tier = "A"     # 但显式要求 A
    class FakeWorkload: spec = FakeSpec()

    workers = []
    for tier in ["S", "A", "B", "C", "D"]:
        w = _mk_worker(name=f"w-{tier}")
        w.hw_tier = tier
        workers.append(w)

    out = planner._filter_by_hw_tier(workers, workload=FakeWorkload())
    tiers = [w.hw_tier for w in out]
    assert tiers == ["S", "A"]


def test_required_hw_tier_difficulty_thresholds():
    """验证难度阈值: >= 2.0 → B · >= 1.0 → C · < 1.0 → None"""
    def _mk_wl(task_type):
        class _Spec: pass
        _Spec.task_type = task_type
        class _Wl: spec = _Spec()
        return _Wl()

    assert planner._required_hw_tier_for_workload(_mk_wl("blender_render")) == "B"      # 2.5
    assert planner._required_hw_tier_for_workload(_mk_wl("video_compress")) == "C"      # 1.5
    assert planner._required_hw_tier_for_workload(_mk_wl("pdf_ocr")) == "C"             # 1.2
    assert planner._required_hw_tier_for_workload(_mk_wl("ocr_image")) == "C"           # 1.0
    assert planner._required_hw_tier_for_workload(_mk_wl("audio_transcode")) is None    # 0.9
    assert planner._required_hw_tier_for_workload(_mk_wl("hash_batch")) is None         # 0.3


def test_old_vs_new_disagree_in_realistic_scenario():
    """
    真实场景: 4 个节点不同 load/rep（同 power）
    老排序只看 load；新排序 = power×contrib×rep×(1-load)^1.5
    """
    a = _mk_worker(load=0.1, reputation=0.2, capability_score=0, name="a",
                   cpu_brand="UnknownCPU", cpu_cores=8)
    b = _mk_worker(load=0.4, reputation=0.9, capability_score=0, name="b",
                   cpu_brand="UnknownCPU", cpu_cores=8)
    c = _mk_worker(load=0.2, reputation=0.95, capability_score=0, name="c",
                   cpu_brand="UnknownCPU", cpu_cores=8)
    d = _mk_worker(load=0.5, reputation=0.95, capability_score=0, name="d",
                   cpu_brand="UnknownCPU", cpu_cores=8)

    old_order = planner._sort_workers_old([a, b, c, d])
    new_order = planner._sort_workers_nce_v1([a, b, c, d])

    # 老: a(0.1), c(0.2), b(0.4), d(0.5)
    assert [w.name for w in old_order] == ["a", "c", "b", "d"]
    # 新: c 最高 (高 rep + 较低 load)，d 最低 (高 load)
    assert new_order[0].name == "c"
    assert new_order[-1].name == "d"
    assert [w.name for w in new_order] != [w.name for w in old_order]


# ════════════════════════════════════════════════════════════════════
# main · standalone
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
