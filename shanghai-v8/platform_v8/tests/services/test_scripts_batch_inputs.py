"""技能广场只暴露已验证的批处理输入合同。"""
from __future__ import annotations

import asyncio
import sys
from dataclasses import replace

from platform_v8.api.v8.scripts import list_scripts
from platform_v8.engine.slicers import slice_workload
from platform_v8.engine import task_registry
from platform_v8.engine.task_registry import DEFAULT_SPEC, get_spec
from platform_v8.core import Workload, WorkloadSpec


def test_default_spec_does_not_advertise_unverified_batch_uploads():
    assert "multi_file" not in DEFAULT_SPEC.accepted_input_kinds
    assert "archive" not in DEFAULT_SPEC.accepted_input_kinds


def test_csv_to_json_has_batch_delivery_contract():
    spec = get_spec("csv_to_json")
    assert "multi_file" in spec.accepted_input_kinds
    assert "archive" in spec.accepted_input_kinds
    assert spec.slicer == "files_chunked"
    assert spec.aggregator == "zip_files"


def test_word_count_stays_single_input_until_its_script_contract_is_verified():
    spec = get_spec("word_count")
    assert "inline" in spec.accepted_input_kinds
    assert "single_file" in spec.accepted_input_kinds
    assert "multi_file" not in spec.accepted_input_kinds
    assert "archive" not in spec.accepted_input_kinds


def test_hash_collision_search_stays_single_text_only():
    spec = get_spec("hash_collision_search")
    assert spec.task_type == "hash_collision_search"
    assert "inline" in spec.accepted_input_kinds
    assert "single_file" in spec.accepted_input_kinds
    assert "multi_file" not in spec.accepted_input_kinds
    assert "archive" not in spec.accepted_input_kinds
    assert spec.max_shards_limit == 1
    assert spec.aggregator == "lines_merge"


def test_scripts_catalog_exposes_only_matching_batch_metadata():
    catalog = asyncio.run(list_scripts())
    items = catalog["items"]
    assert len(items) >= 80  # 广场约 86
    for item in items:
        accepted = item.get("accepted_input_kinds") or []
        if "multi_file" in accepted:
            assert item["batch_semantics"] != "none"
        if "archive" in accepted:
            assert item["archive_formats"]
    collision = next(i for i in items if i["task_type"] == "hash_collision_search")
    assert "multi_file" not in (collision.get("accepted_input_kinds") or [])
    assert "archive" not in (collision.get("accepted_input_kinds") or [])
    assert collision["settlement_policy"] == "artifact"


def test_multi_file_routes_to_files_chunked_for_verified_image_task():
    workload = Workload(
        spec=WorkloadSpec(
            task_type="image_compress",
            input_kind="multi_file",
            input_refs=[
                "https://oss.test/a.txt",
                "https://oss.test/b.txt",
                "https://oss.test/c.txt",
                "https://oss.test/d.txt",
            ],
            max_shards=10,
        )
    )
    shards = slice_workload(workload, n_workers=2)
    assert len(shards) == 2
    assert all(sh.metadata.get("slice_strategy") == "files_chunked"
                or "files_in_shard" in sh.metadata for sh in shards)


def test_image_compress_batch_kinds_unchanged():
    spec = get_spec("image_compress")
    assert spec.slicer == "files_chunked"
    assert "multi_file" in spec.accepted_input_kinds
    assert "archive" in spec.accepted_input_kinds


def test_missing_py7zr_is_not_advertised(monkeypatch):
    monkeypatch.setitem(sys.modules, "py7zr", None)
    assert task_registry.archive_7z_runtime_ready() is False
    base = replace(get_spec("csv_to_json"), archive_formats=())

    finalized = task_registry._finalize_input_contract(base)

    assert "7z" not in finalized.archive_formats
    assert "rar" not in finalized.archive_formats


def test_rar_is_never_advertised():
    for spec in task_registry.list_specs():
        assert "rar" not in {
            archive_format.lower()
            for archive_format in spec.archive_formats
        }
