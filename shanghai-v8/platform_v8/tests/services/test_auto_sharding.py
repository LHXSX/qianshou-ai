import asyncio
import json

import pytest

from platform_v8.api.v8.scripts import list_scripts
from platform_v8.core import Shard, Workload, WorkloadSpec
from platform_v8.engine.aggregators.manifest_only import aggregate_manifest_only
from platform_v8.engine.slicers import slice_workload
from platform_v8.engine.task_registry import get_spec
from platform_v8.services.workloads.submit import _resolve_max_shards


def test_auto_sharding_uses_registry_limit_for_splittable_tasks():
    spec = get_spec("image_compress")

    assert _resolve_max_shards({"max_shards": 1}, spec) == 20


def test_auto_sharding_keeps_unsplittable_tasks_single():
    spec = get_spec("video_view")

    assert _resolve_max_shards({}, spec) == 1


def test_video_info_auto_sharding_uses_multi_file_limit():
    spec = get_spec("video_info")

    assert _resolve_max_shards({}, spec) == 20
    assert "multi_file" in spec.accepted_input_kinds
    assert spec.slicer == "files_chunked"


def test_auto_sharding_can_be_explicitly_disabled_and_capped():
    spec = get_spec("image_compress")

    assert _resolve_max_shards(
        {"auto_shard": False, "max_shards": 3}, spec
    ) == 3
    assert _resolve_max_shards(
        {"auto_shard": False, "max_shards": 999}, spec
    ) == 20


def test_image_compress_eight_files_are_balanced_across_two_workers():
    workload = Workload(
        spec=WorkloadSpec(
            task_type="image_compress",
            input_kind="multi_file",
            input_refs=[f"https://oss.test/{i}.jpg" for i in range(8)],
            max_shards=_resolve_max_shards({}, get_spec("image_compress")),
        )
    )

    shards = slice_workload(workload, n_workers=2)

    assert len(shards) == 2
    assert [sh.metadata["files_in_shard"] for sh in shards] == [4, 4]


def test_scripts_catalog_exposes_backend_sharding_contract():
    catalog = asyncio.run(list_scripts())
    image_compress = next(
        item for item in catalog["items"]
        if item["task_type"] == "image_compress"
    )

    assert image_compress["slicer"] == "files_chunked"
    assert image_compress["max_shards_limit"] == 20
    assert "multi_file" in image_compress["accepted_input_kinds"]

    video_compress = next(
        item for item in catalog["items"]
        if item["task_type"] == "video_compress"
    )
    assert video_compress["slicer"] == "video_hybrid"
    assert video_compress["max_shards_limit"] == 10
    assert "multi_file" in video_compress["accepted_input_kinds"]
    assert "archive" in video_compress["accepted_input_kinds"]

    video_info = next(
        item for item in catalog["items"]
        if item["task_type"] == "video_info"
    )
    assert video_info["slicer"] == "files_chunked"
    assert video_info["max_shards_limit"] == 20
    assert "multi_file" in video_info["accepted_input_kinds"]

def test_registered_list_task_splits_params_across_workers():
    workload = Workload(
        spec=WorkloadSpec(
            task_type="llm_translate",
            input_kind="params_only",
            params={"texts": [f"text-{i}" for i in range(8)], "target": "英文"},
            max_shards=_resolve_max_shards({}, get_spec("llm_translate")),
        )
    )

    shards = slice_workload(workload, n_workers=2)

    assert len(shards) == 2
    assert [len(sh.metadata["params"]["texts"]) for sh in shards] == [4, 4]


@pytest.mark.parametrize("task_type", ["price_monitor", "stock_monitor"])
def test_monitor_urls_are_balanced_across_workers(task_type: str):
    workload = Workload(
        spec=WorkloadSpec(
            task_type=task_type,
            input_kind="params_only",
            params={"urls": [f"https://shop.test/{i}" for i in range(8)]},
            max_shards=_resolve_max_shards({}, get_spec(task_type)),
        )
    )

    shards = slice_workload(workload, n_workers=2)

    assert len(shards) == 2
    assert [len(sh.metadata["params"]["urls"]) for sh in shards] == [4, 4]


def test_manifest_aggregator_accepts_legacy_result_lists():
    workload = Workload(spec=WorkloadSpec(task_type="llm_translate"))
    shards = [
        Shard(
            workload_id=workload.id,
            index=0,
            output_ref=json.dumps({
                "result": [{"src": "一", "dst": "one"}],
                "summary": {"translated": 1},
            }),
        ),
        Shard(
            workload_id=workload.id,
            index=1,
            output_ref=json.dumps({
                "results": [{"src": "二", "dst": "two"}],
                "summary": {"translated": 1},
            }),
        ),
    ]

    result = aggregate_manifest_only(workload, shards)
    manifest = json.loads(result.output_ref)

    assert len(manifest["results"]) == 2
    assert manifest["summary"]["translated"] == 2
