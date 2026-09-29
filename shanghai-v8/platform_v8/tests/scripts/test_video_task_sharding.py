"""视频多文件 / 体积均衡 / hybrid 切片与脚本区间测试。"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from platform_v8.core import Workload, WorkloadSpec
from platform_v8.engine.slicers import slice_workload
from platform_v8.engine.slicers.files_chunked import pack_by_size
from platform_v8.engine.task_registry import get_spec
from platform_v8.services.workloads.submit import _resolve_max_shards


SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"
MB = 1024 * 1024


def test_pack_by_size_balances_uneven_loads():
    files = [f"v{i}.mp4" for i in range(8)]
    sizes = [10 * MB, 90 * MB, 12 * MB, 85 * MB, 11 * MB, 80 * MB, 13 * MB, 70 * MB]
    buckets = pack_by_size(files, sizes, 2)
    loads = [sum(s for _, s in b) for b in buckets]
    assert len(buckets) == 2
    assert abs(loads[0] - loads[1]) < max(loads) * 0.35


def test_files_chunked_size_balance_for_video_info():
    sizes = [10 * MB, 90 * MB, 12 * MB, 85 * MB, 11 * MB, 80 * MB, 13 * MB, 70 * MB]
    workload = Workload(spec=WorkloadSpec(
        task_type="video_info",
        input_kind="multi_file",
        input_refs=[f"https://oss.test/{i}.mp4" for i in range(8)],
        params={"input_sizes": sizes},
        max_shards=20,
    ))
    shards = slice_workload(workload, n_workers=2)
    assert len(shards) == 2
    loads = [int(sh.metadata.get("bytes_in_shard") or 0) for sh in shards]
    assert abs(loads[0] - loads[1]) < max(loads) * 0.35
    assert sum(sh.metadata["files_in_shard"] for sh in shards) == 8


def test_video_compress_single_file_duration_two_shards():
    workload = Workload(spec=WorkloadSpec(
        task_type="video_compress",
        input_kind="single_file",
        input_ref="https://oss.test/big.mp4",
        max_shards=10,
    ))
    shards = slice_workload(workload, n_workers=2)
    assert len(shards) == 2
    assert all(
        (sh.metadata.get("slice_strategy") == "duration_chunked"
         or "start_pct" in (sh.metadata.get("slice_meta") or {}))
        for sh in shards
    )
    pcts = [
        (
            sh.metadata["slice_meta"].get("start_pct"),
            sh.metadata["slice_meta"].get("end_pct"),
        )
        for sh in shards
    ]
    assert pcts == [(0.0, 0.5), (0.5, 1.0)]


def test_video_compress_hybrid_oversized_splits_duration():
    # 一个超大 + 若干小文件 · 超大应拆时长段
    sizes = [200 * MB, 5 * MB, 6 * MB, 7 * MB]
    refs = [f"https://oss.test/{i}.mp4" for i in range(4)]
    workload = Workload(spec=WorkloadSpec(
        task_type="video_compress",
        input_kind="multi_file",
        input_refs=refs,
        params={"input_sizes": sizes},
        max_shards=10,
    ))
    shards = slice_workload(workload, n_workers=4)
    duration = [
        sh for sh in shards
        if sh.metadata.get("slice_strategy") == "duration_chunked"
    ]
    whole = [
        sh for sh in shards
        if sh.metadata.get("slice_strategy") == "files_chunked"
    ]
    assert len(duration) >= 2
    assert all(
        (sh.metadata.get("source_ref") == refs[0]
         or (sh.metadata.get("slice_meta") or {}).get("source_ref") == refs[0])
        for sh in duration
    )
    assert whole
    whole_refs = []
    for sh in whole:
        whole_refs.extend(sh.metadata.get("input_refs") or [])
    assert set(whole_refs) == set(refs[1:])


def test_video_info_thumbnail_registry_and_catalog_contract():
    for task_type in ("video_info", "video_thumbnail"):
        spec = get_spec(task_type)
        assert "multi_file" in spec.accepted_input_kinds
        assert "archive" in spec.accepted_input_kinds
        assert spec.slicer == "files_chunked"
        assert spec.max_shards_limit == 20
        assert _resolve_max_shards({}, spec) == 20

    compress = get_spec("video_compress")
    assert compress.slicer == "video_hybrid"
    assert compress.aggregator == "video_outputs"
    assert "multi_file" in compress.accepted_input_kinds

    view = get_spec("video_view")
    assert view.slicer == "single"
    assert view.max_shards_limit == 1
    repurpose = get_spec("video_repurpose")
    assert repurpose.max_shards_limit == 1


def test_video_archive_size_balanced_ranges():
    sizes = [10 * MB, 90 * MB, 12 * MB, 85 * MB]
    workload = Workload(spec=WorkloadSpec(
        task_type="video_info",
        input_kind="archive",
        input_ref="https://oss.test/videos.zip",
        params={"total_files": 4, "input_sizes": sizes},
        max_shards=20,
    ))
    shards = slice_workload(workload, n_workers=2)
    assert len(shards) == 2
    loads = [
        int((sh.metadata.get("slice_meta") or {}).get("bytes_in_shard") or 0)
        for sh in shards
    ]
    assert abs(loads[0] - loads[1]) < max(loads) * 0.35
    all_indices = []
    for sh in shards:
        meta = sh.metadata["slice_meta"]
        if "file_indices" in meta:
            all_indices.extend(meta["file_indices"])
        else:
            all_indices.extend(range(meta["file_idx_start"], meta["file_idx_end"]))
    assert sorted(all_indices) == [0, 1, 2, 3]


def test_video_info_script_empty_shard(tmp_path: Path):
    # 空区间 · 目录有视频但不在分片范围
    for i in range(2):
        (tmp_path / f"{i}.mp4").write_bytes(b"\x00" * 2048)
    env = os.environ.copy()
    env.update({
        "EC_INPUT_KIND": "archive",
        "EC_INPUT_DIR": str(tmp_path),
        "EC_PARAMS": "{}",
        "EC_SLICE_META": json.dumps({"file_idx_start": 2, "file_idx_end": 2}),
    })
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "video_info.py")],
        text=True,
        capture_output=True,
        env=env,
        timeout=20,
    )
    # 空分片：无文件可选 → results 空但 status ok
    output = json.loads(proc.stdout.strip().splitlines()[-1])
    assert proc.returncode == 0, (proc.stderr, output)
    assert output["status"] == "ok"
    assert output.get("results") == []


def test_video_compress_slice_window_pct(monkeypatch, tmp_path: Path):
    spec = importlib.util.spec_from_file_location(
        "video_compress_under_test", SCRIPTS_DIR / "video_compress.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    # 避免执行时依赖路径问题
    sys.modules["video_compress_under_test"] = module
    spec.loader.exec_module(module)

    fake = tmp_path / "clip.mp4"
    fake.write_bytes(b"\x00" * 100)
    monkeypatch.setenv(
        "EC_SLICE_META",
        json.dumps({"start_pct": 0.25, "end_pct": 0.75}),
    )
    monkeypatch.setattr(module, "_probe_duration", lambda _p: 100.0)
    assert module._slice_window(str(fake)) == (25.0, 75.0)
