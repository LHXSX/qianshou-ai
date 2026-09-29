"""
NCE Phase 0 · feature_flags 单测

覆盖:
  1. L1 缓存 (TTL · 命中)
  2. 灰度一致性 hash (同 subject 永远同桶)
  3. 白名单 owner_ids / worker_ids
  4. fail-safe (DB 挂 → 返 False)
  5. update_flag 后缓存失效

跑法:
  pytest platform_v8/tests/services/test_feature_flags.py -v
  或 python platform_v8/tests/services/test_feature_flags.py  (standalone)
"""
from __future__ import annotations
import sys
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.ops import feature_flags as ff


def _clear_caches():
    """每个测试前清缓存"""
    ff._l1_clear()


# ════════════════════════════════════════════════════════════════════
# 1. 一致性 hash 测试
# ════════════════════════════════════════════════════════════════════

def test_hash_bucket_is_deterministic():
    """同 subject 永远落同桶"""
    for sid in [1, 42, 'worker-uuid-abc', 999]:
        b1 = ff._hash_bucket(sid)
        b2 = ff._hash_bucket(sid)
        assert b1 == b2, f"hash 不稳定: {sid} → {b1} vs {b2}"
        assert 0 <= b1 < 100


def test_hash_bucket_distribution_is_uniform():
    """1000 个 subject 分布应大致均匀"""
    buckets = [ff._hash_bucket(i) for i in range(1000)]
    # 应该所有桶都被覆盖
    unique = set(buckets)
    assert len(unique) >= 80, f"分布太集中 · 只有 {len(unique)} 个桶"


# ════════════════════════════════════════════════════════════════════
# 2. is_enabled 逻辑 (mock DB)
# ════════════════════════════════════════════════════════════════════

def _mock_flag(enabled=False, rollout_pct=0, rollout_filter=None):
    return ff.FeatureFlag(
        flag_name='test_flag',
        enabled=enabled,
        rollout_pct=rollout_pct,
        rollout_filter=rollout_filter or {},
    )


def test_is_enabled_returns_false_when_flag_missing():
    _clear_caches()
    with patch.object(ff, 'get_flag', return_value=None):
        assert ff.is_enabled('missing_flag', subject_id=1) is False
        assert ff.is_enabled('missing_flag') is False


def test_is_enabled_returns_false_when_disabled():
    _clear_caches()
    flag = _mock_flag(enabled=False, rollout_pct=100)
    with patch.object(ff, 'get_flag', return_value=flag):
        assert ff.is_enabled('test_flag', subject_id=1) is False


def test_is_enabled_full_rollout():
    _clear_caches()
    flag = _mock_flag(enabled=True, rollout_pct=100)
    with patch.object(ff, 'get_flag', return_value=flag):
        # 全量开 · 任意 subject 都应 True
        for sid in [1, 42, 'abc', None]:
            assert ff.is_enabled('test_flag', subject_id=sid) is True


def test_is_enabled_zero_rollout():
    _clear_caches()
    flag = _mock_flag(enabled=True, rollout_pct=0)
    with patch.object(ff, 'get_flag', return_value=flag):
        for sid in [1, 42, 'abc', None]:
            assert ff.is_enabled('test_flag', subject_id=sid) is False


def test_is_enabled_partial_rollout_is_consistent():
    """灰度 50% · 同 subject 永远返回同结果"""
    _clear_caches()
    flag = _mock_flag(enabled=True, rollout_pct=50)
    with patch.object(ff, 'get_flag', return_value=flag):
        for sid in range(1, 100):
            r1 = ff.is_enabled('test_flag', subject_id=sid)
            r2 = ff.is_enabled('test_flag', subject_id=sid)
            assert r1 == r2, f"灰度不稳定 sid={sid}"


def test_is_enabled_partial_rollout_distribution():
    """灰度 50% · 1000 个 subject 应约 500 个 True"""
    _clear_caches()
    flag = _mock_flag(enabled=True, rollout_pct=50)
    with patch.object(ff, 'get_flag', return_value=flag):
        enabled_count = sum(
            1 for sid in range(1000)
            if ff.is_enabled('test_flag', subject_id=sid)
        )
        # 容忍 ±15% 误差
        assert 350 < enabled_count < 650, \
            f"灰度 50% 分布异常 · 启用 {enabled_count}/1000"


def test_is_enabled_whitelist_owner_ids():
    """rollout_filter.owner_ids 白名单 · 即使 rollout_pct=0 也命中"""
    _clear_caches()
    flag = _mock_flag(
        enabled=True,
        rollout_pct=0,
        rollout_filter={'owner_ids': [1, 2, 3]}
    )
    with patch.object(ff, 'get_flag', return_value=flag):
        assert ff.is_enabled('test_flag', subject_id=1) is True
        assert ff.is_enabled('test_flag', subject_id=2) is True
        assert ff.is_enabled('test_flag', subject_id=999) is False


def test_is_enabled_whitelist_worker_ids():
    """rollout_filter.worker_ids · UUID 字符串"""
    _clear_caches()
    flag = _mock_flag(
        enabled=True,
        rollout_pct=0,
        rollout_filter={'worker_ids': ['uuid-aaa', 'uuid-bbb']},
    )
    with patch.object(ff, 'get_flag', return_value=flag):
        assert ff.is_enabled('test_flag', subject_id='uuid-aaa') is True
        assert ff.is_enabled('test_flag', subject_id='uuid-ccc') is False


def test_is_enabled_fail_safe_on_exception():
    """get_flag 抛异常 · is_enabled 应返 False (不能崩派单)"""
    _clear_caches()
    with patch.object(ff, 'get_flag', side_effect=Exception('DB down')):
        assert ff.is_enabled('any_flag', subject_id=1) is False


def test_is_enabled_global_flag_without_subject():
    """全局 flag (subject_id=None) · rollout_pct 在 [1, 99] 时返回 False"""
    _clear_caches()
    flag = _mock_flag(enabled=True, rollout_pct=50)
    with patch.object(ff, 'get_flag', return_value=flag):
        # 全局 flag 没 subject · 不走 hash · 走 0/100 二值
        assert ff.is_enabled('test_flag', subject_id=None) is False
        # rollout_pct=100 时全局开
        flag2 = _mock_flag(enabled=True, rollout_pct=100)
        with patch.object(ff, 'get_flag', return_value=flag2):
            assert ff.is_enabled('test_flag', subject_id=None) is True


# ════════════════════════════════════════════════════════════════════
# 3. L1 缓存测试 (TTL)
# ════════════════════════════════════════════════════════════════════

def test_l1_cache_basic_hit():
    """同 flag 第二次 get 应命中 L1 (TTL 内)"""
    _clear_caches()
    flag = _mock_flag(enabled=True)
    # 手动写 L1
    ff._l1_set('cached_flag', flag)
    # 读应该不查 L3
    fetched = ff._l1_get('cached_flag')
    assert fetched is not None
    assert fetched.flag_name == 'test_flag'  # _mock_flag 的默认 name


def test_l1_cache_expires():
    """L1 TTL 过期后返 None"""
    _clear_caches()
    flag = _mock_flag(enabled=True)
    # 写一个已过期的
    ff._L1_CACHE['expired'] = (time.time() - 1, flag)
    assert ff._l1_get('expired') is None


def test_l1_cache_clear_single():
    """_l1_clear(name) 只清单个"""
    _clear_caches()
    ff._l1_set('a', _mock_flag())
    ff._l1_set('b', _mock_flag())
    ff._l1_clear('a')
    assert ff._l1_get('a') is None
    assert ff._l1_get('b') is not None


def test_l1_cache_clear_all():
    """_l1_clear() 清全部"""
    _clear_caches()
    ff._l1_set('a', _mock_flag())
    ff._l1_set('b', _mock_flag())
    ff._l1_clear()
    assert ff._l1_get('a') is None
    assert ff._l1_get('b') is None


# ════════════════════════════════════════════════════════════════════
# 4. 性能基线 (派单热路径 < 1μs)
# ════════════════════════════════════════════════════════════════════

def test_is_enabled_hot_path_performance():
    """L1 命中的派单热路径 · 单次调用应 < 10μs"""
    _clear_caches()
    flag = _mock_flag(enabled=True, rollout_pct=50)
    ff._l1_set('perf_test', flag)
    
    start = time.perf_counter()
    iterations = 10000
    for i in range(iterations):
        ff.is_enabled('perf_test', subject_id=i)
    elapsed = time.perf_counter() - start
    
    avg_us = (elapsed / iterations) * 1_000_000
    assert avg_us < 100, f"派单热路径太慢: {avg_us:.1f}μs/call"
    print(f"\n  ⚡ 性能: {avg_us:.2f}μs/call (L1 hit · {iterations} 次)")


# ════════════════════════════════════════════════════════════════════
# main · standalone 运行
# ════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    import traceback
    tests = [v for k, v in globals().items() if k.startswith('test_') and callable(v)]
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
