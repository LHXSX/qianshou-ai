from __future__ import annotations

import importlib.util
import shutil
import zipfile
from pathlib import Path

import pytest

from platform_v8.core import Shard, ShardStatus, Worker, Workload, WorkloadSpec
from platform_v8.core.enums import WorkerStatus
from platform_v8.engine import planner
from platform_v8.engine.assignment_payload import build_assignment_payload
from platform_v8.engine.native_args_templates import render_native_args
from platform_v8.engine.slicers import slice_workload
from platform_v8.engine.task_registry import ShardCapacityError, get_spec
from platform_v8.services import archive_normalizer, oss_provider, storage_refs
from platform_v8.services.archive_normalizer import ArchiveNormalizationError
from platform_v8.services.workloads.submit import (
    SubmitWorkloadError,
    validate_submission_input_count,
)


def _load_task_script(name: str):
    path = Path(__file__).parents[2] / "scripts" / "tasks" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"{name}_contract_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("count, valid", [(1, False), (2, True), (3, False)])
def test_text_diff_submission_requires_exactly_two_files(count, valid):
    refs = [f"v8/account-1/input/{index}.txt" for index in range(count)]
    if valid:
        assert validate_submission_input_count(
            get_spec("text_diff"),
            input_kind="multi_file",
            input_ref="",
            input_refs=refs,
        ) == 2
    else:
        with pytest.raises(SubmitWorkloadError, match="text_diff"):
            validate_submission_input_count(
                get_spec("text_diff"),
                input_kind="multi_file",
                input_ref="",
                input_refs=refs,
            )


def test_docx_submission_and_archive_package_cardinality():
    spec = get_spec("docx_to_text")
    assert validate_submission_input_count(
        spec,
        input_kind="single_file",
        input_ref="v8/account-1/input/one.docx",
        input_refs=[],
    ) == 1
    with pytest.raises(SubmitWorkloadError, match="最多允许 20"):
        validate_submission_input_count(
            spec,
            input_kind="multi_file",
            input_ref="",
            input_refs=[f"v8/account-1/input/{i}.docx" for i in range(21)],
        )
    assert validate_submission_input_count(
        spec,
        input_kind="archive",
        input_ref="v8/account-1/input/docs.zip",
        input_refs=[],
    ) == 1


@pytest.mark.parametrize("count, succeeds", [(1, False), (2, True), (3, False)])
def test_text_diff_directory_never_drops_extra_files(
    tmp_path, monkeypatch, count, succeeds,
):
    for index in range(count):
        (tmp_path / f"{index}.txt").write_text(str(index))
    monkeypatch.setenv("EC_INPUT_DIR", str(tmp_path))
    script = _load_task_script("text_diff")
    if succeeds:
        assert script._read_from_dir() == ("0", "1")
    else:
        with pytest.raises(ValueError, match="恰好包含 2 个文件"):
            script._read_from_dir()


def test_docx_script_rejects_more_than_one_downloaded_input(tmp_path, monkeypatch):
    (tmp_path / "one.docx").write_bytes(b"one")
    (tmp_path / "two.docx").write_bytes(b"two")
    monkeypatch.setenv("EC_INPUT_DIR", str(tmp_path))
    with pytest.raises(ValueError, match="恰好包含 1 个"):
        _load_task_script("docx_to_text")._read_bytes()


def test_archive_member_limit_is_checked_before_upload(tmp_path, monkeypatch):
    source = tmp_path / "many.zip"
    with zipfile.ZipFile(source, "w") as zf:
        for index in range(21):
            zf.writestr(f"{index}.docx", b"docx")

    monkeypatch.setattr(
        storage_refs,
        "canonicalize_owned_reference",
        lambda _owner_id, key: key,
    )
    monkeypatch.setattr(
        archive_normalizer,
        "_download_archive",
        lambda _owner_id, _key, destination: shutil.copyfile(source, destination),
    )
    monkeypatch.setattr(
        archive_normalizer.shutil,
        "disk_usage",
        lambda _path: shutil._ntuple_diskusage(10**12, 0, 10**12),
    )
    uploads: list[str] = []
    monkeypatch.setattr(
        archive_normalizer,
        "_upload_member",
        lambda *_args, **_kwargs: uploads.append("uploaded") or "key",
    )

    with pytest.raises(ArchiveNormalizationError, match="最多允许 20"):
        archive_normalizer.normalize_archive_to_batch(
            owner_id=1,
            object_key="v8/account-1/input/many.zip",
            task_type="docx_to_text",
            max_shards=20,
        )
    assert uploads == []


def test_single_item_shards_queue_without_combining_files():
    workload = Workload(spec=WorkloadSpec(
        task_type="docx_to_text",
        input_kind="multi_file",
        input_refs=[f"v8/account-1/input/{i}.docx" for i in range(3)],
        max_shards=20,
    ))
    shards = slice_workload(workload, n_workers=1)
    assert len(shards) == 3
    assert all(shard.metadata["files_in_shard"] == 1 for shard in shards)
    assert all(shard.metadata["capacity_queued"] is True for shard in shards)


def test_single_item_scheduler_leaves_excess_shards_pending(monkeypatch):
    workload = Workload(spec=WorkloadSpec(
        task_type="docx_to_text",
        input_kind="multi_file",
        input_refs=[f"v8/account-1/input/{i}.docx" for i in range(3)],
        max_shards=20,
    ))
    shards = slice_workload(workload, n_workers=1)
    worker = Worker(
        id="worker-1",
        owner_id=1,
        name="only-worker",
        status=WorkerStatus.ONLINE,
        capability_score=1,
    )
    monkeypatch.setattr(planner, "_flag_enabled", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(
        planner, "_flag_enabled_silent", lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(
        planner,
        "_filter_by_learned_incapability",
        lambda workers, _workload: workers,
    )
    assignments = planner.schedule_assignments(
        shards,
        [worker],
        workload=workload,
    )
    assert len(assignments) == 1
    assert len(shards) - len(assignments) == 2


def test_image_compress_multi_file_keeps_one_shard_per_file_on_single_worker():
    workload = Workload(spec=WorkloadSpec(
        task_type="image_compress",
        input_kind="multi_file",
        input_refs=["v8/account-1/input/a.png", "v8/account-1/input/b.png"],
        max_shards=20,
    ))
    shards = slice_workload(workload, n_workers=1)
    assert len(shards) == 2
    assert [len(s.metadata.get("input_refs") or []) for s in shards] == [1, 1]


def test_text_diff_two_files_stay_in_one_shard():
    workload = Workload(spec=WorkloadSpec(
        task_type="text_diff",
        input_kind="multi_file",
        input_refs=["v8/account-1/input/a.txt", "v8/account-1/input/b.txt"],
        max_shards=2,
    ))
    shards = slice_workload(workload, n_workers=1)
    assert len(shards) == 1
    assert len(shards[0].metadata.get("input_refs") or []) == 2


def test_text_diff_manifest_names_stay_unique_when_client_sends_one_input_name():
    workload = Workload(spec=WorkloadSpec(
        task_type="text_diff",
        input_kind="multi_file",
        input_refs=[
            "v8/account-1/unassigned/input/5b20eb2a05d44938-321.txt",
            "v8/account-1/unassigned/input/89583c2001cf4e93-123.txt",
        ],
        params={"input_name": "321.txt", "input_count": 2},
        max_shards=1,
    ))
    shards = slice_workload(workload, n_workers=1)
    names = [e["name"] for e in shards[0].metadata["input_manifest"]["entries"]]
    assert len(names) == 2
    assert len(set(names)) == 2


def test_single_item_shards_fail_when_max_shards_cannot_hold_inputs():
    workload = Workload(spec=WorkloadSpec(
        task_type="docx_to_text",
        input_kind="multi_file",
        input_refs=[f"v8/account-1/input/{i}.docx" for i in range(3)],
        max_shards=2,
    ))
    with pytest.raises(ShardCapacityError, match="至少需要 3 个分片"):
        slice_workload(workload, n_workers=10)


def test_pdf_zero_based_half_open_range_renders_poppler_pages():
    args = render_native_args(
        task_type="pdf_to_text",
        slice_meta={"page_index_base": 0, "page_start": 2, "page_end": 4},
    )
    assert args[args.index("-f") + 1] == "3"
    assert args[args.index("-l") + 1] == "4"


@pytest.mark.parametrize(
    "slice_meta, expected",
    [
        ({"start_page": 2, "end_page": 4}, ("2", "4")),
        ({"page_start": 2, "page_end": 4}, ("2", "4")),
    ],
)
def test_pdf_historical_page_ranges_remain_compatible(slice_meta, expected):
    args = render_native_args(task_type="pdf_to_text", slice_meta=slice_meta)
    assert args[args.index("-f") + 1] == expected[0]
    assert args[args.index("-l") + 1] == expected[1]


class _Provider:
    def presign_get(self, key: str, *, expires: int):
        return {"url": f"https://objects.example.test/{key}?expires={expires}"}


def test_pdf_percentage_selector_falls_back_to_python(monkeypatch):
    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Provider())
    workload = Workload(
        id="workload-pdf",
        owner_id=1,
        spec=WorkloadSpec(
            task_type="pdf_to_text",
            input_kind="single_file",
            input_ref="v8/account-1/input/report.pdf",
            code_url="",
        ),
    )
    shard = Shard(
        id="shard-pdf",
        workload_id=workload.id,
        status=ShardStatus.PENDING,
        input_ref=workload.spec.input_ref,
        metadata={
            "input_kind": "single_file",
            "slice_meta": {"page_pct_start": 0.25, "page_pct_end": 0.5},
        },
    )
    payload = build_assignment_payload(shard, workload, worker_id="worker-1")
    assert payload.executor == "python3"
    assert payload.native_binary == ""
    assert payload.native_args == []
    assert payload.code_url.endswith("/api/v8/scripts/pdf_to_text.py")


def test_ocr_per_item_payload_keeps_refs_and_manifest(monkeypatch):
    monkeypatch.setattr(oss_provider, "get_oss_provider", lambda: _Provider())
    spec = get_spec("ocr_image")
    assert spec.executor.value == "onnx"
    workload = Workload(
        id="workload-ocr",
        owner_id=1,
        spec=WorkloadSpec(
            task_type="ocr_image",
            input_kind="multi_file",
            input_refs=[
                "v8/account-1/input/a.png",
                "v8/account-1/input/b.png",
            ],
            max_shards=10,
        ),
    )
    shard = slice_workload(workload, n_workers=1)[0]
    payload = build_assignment_payload(shard, workload, worker_id="worker-1")
    assert payload.executor == "onnx"
    # files_chunked 按片下发子集，不能把 workload 全量 refs 塞给每个节点
    assert len(payload.input_refs) == len(shard.metadata.get("input_refs") or [])
    assert 1 <= len(payload.input_refs) <= 2
    assert len(payload.input_manifest.get("entries") or []) == len(payload.input_refs)
