"""heartbeat 硬件清单合并测试"""
from __future__ import annotations

from platform_v8.services.workers.heartbeat import _build_cap_patch
from platform_v8.core.worker import WorkerCapabilities
from platform_v8.services.economy import hw_scoring


def test_build_cap_patch_merges_capabilities_full():
    patch = _build_cap_patch(
        None,
        None,
        {
            "uptime_sec": 12,
            "capabilities_full": {
                "cpu_brand": "Apple M4",
                "cpu_cores": 10,
                "total_memory_mb": 24576,
                "total_disk_mb": 512000,
                "free_disk_mb": 120000,
                "gpu_count": 1,
                "gpu_model": "Apple Silicon (Metal + MLX)",
                "os_version": "15.0",
                "bench_capability_score": 77.5,
                "bench_cpu_mb_per_sec": 900.0,
                "supports_metal": True,
                "evil_key": "should_drop",
            },
        },
    )
    assert patch["uptime_sec"] == 12
    assert patch["cpu_brand"] == "Apple M4"
    assert patch["total_disk_mb"] == 512000
    assert patch["bench_capability_score"] == 77.5
    assert patch["supports_metal"] is True
    assert "evil_key" not in patch


def test_build_cap_patch_merges_installed_apps():
    patch = _build_cap_patch(
        100,
        "running",
        {
            "capabilities_full": {
                "installed_apps": [{"slug": "qianshou-law", "name": "千手律所", "version": "1.0"}],
                "installed_skills": ["qianshou-law"],
                "cpu_cores": 10,
            },
        },
    )
    assert patch["installed_skills"] == ["qianshou-law"]
    assert patch["installed_apps"][0]["slug"] == "qianshou-law"
    assert patch["cpu_cores"] == 10


def test_build_cap_patch_keeps_throttle_pct():
    patch = _build_cap_patch(50, "throttled", {"uptime_sec": 1})
    assert patch["throttle_pct"] == 50
    assert patch["mode"] == "throttled"


def test_hw_scoring_uses_disk_when_present():
    caps = WorkerCapabilities(
        cpu_cores=8,
        cpu_brand="Intel",
        total_memory_mb=16384,
        total_disk_mb=512 * 1024,  # 512 GB → storage 80
        gpu_count=0,
    )
    result = hw_scoring.evaluate(caps)
    assert result.sub_scores["storage"] == 80.0
    # 有磁盘时应纳入综合分计算路径（至少 sub 有值）
    assert "storage" in result.sub_scores
