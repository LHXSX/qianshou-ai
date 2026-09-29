from __future__ import annotations

import base64
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from platform_v8.core import Workload, WorkloadSpec
from platform_v8.engine.slicers import slice_workload
from platform_v8.engine.task_registry import get_spec


SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"
IMAGE_TASKS = (
    "image_info",
    "image_resize",
    "image_compress",
    "image_convert",
    "image_thumbnail",
    "image_caption",
)
LOCAL_PROCESSING_TASKS = IMAGE_TASKS[:-1]
HAS_PILLOW = importlib.util.find_spec("PIL") is not None
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMA"
    "ASsJTYQAAAAASUVORK5CYII="
)


@pytest.mark.parametrize("task_type", IMAGE_TASKS)
def test_all_image_tasks_balance_eight_files_across_two_workers(task_type: str):
    spec = get_spec(task_type)
    assert "multi_file" in spec.accepted_input_kinds
    assert "archive" in spec.accepted_input_kinds
    assert spec.slicer == "files_chunked"
    assert spec.max_shards_limit > 1

    workload = Workload(spec=WorkloadSpec(
        task_type=task_type,
        input_kind="multi_file",
        input_refs=[f"https://oss.test/{i}.png" for i in range(8)],
        max_shards=spec.max_shards_limit,
    ))
    shards = slice_workload(workload, n_workers=2)

    assert len(shards) == 2
    assert [sh.metadata["files_in_shard"] for sh in shards] == [4, 4]


@pytest.mark.parametrize("task_type", IMAGE_TASKS)
def test_all_image_archives_use_exact_file_ranges(task_type: str):
    spec = get_spec(task_type)
    workload = Workload(spec=WorkloadSpec(
        task_type=task_type,
        input_kind="archive",
        input_ref="https://oss.test/images.zip",
        params={"total_files": 8},
        max_shards=spec.max_shards_limit,
    ))
    shards = slice_workload(workload, n_workers=2)

    assert len(shards) == 2
    assert [
        (
            sh.metadata["slice_meta"]["file_idx_start"],
            sh.metadata["slice_meta"]["file_idx_end"],
        )
        for sh in shards
    ] == [(0, 4), (4, 8)]


def _make_images(root: Path) -> None:
    (root / "nested").mkdir()
    for index in range(4):
        directory = root if index < 2 else root / "nested"
        (directory / f"{index}.png").write_bytes(PNG_BYTES)


def _run_archive_task(task_type: str, root: Path, start: int, end: int) -> dict:
    params = {
        "image_resize": {"width": 8},
        "image_compress": {"quality": 80},
        "image_convert": {"format": "PNG"},
        "image_thumbnail": {"size": 8},
        "image_info": {},
    }[task_type]
    env = os.environ.copy()
    env.update({
        "EC_INPUT_KIND": "archive",
        "EC_INPUT_DIR": str(root),
        "EC_PARAMS": json.dumps(params),
        "EC_SLICE_META": json.dumps({
            "file_idx_start": start,
            "file_idx_end": end,
        }),
    })
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / f"{task_type}.py")],
        text=True,
        capture_output=True,
        env=env,
        timeout=20,
    )
    output = json.loads(proc.stdout.strip().splitlines()[-1])
    assert proc.returncode == 0, (proc.stderr, output)
    return output


@pytest.mark.parametrize("task_type", LOCAL_PROCESSING_TASKS)
@pytest.mark.skipif(not HAS_PILLOW, reason="Pillow optional runtime dependency")
def test_image_archive_scripts_process_only_assigned_files(task_type: str, tmp_path: Path):
    _make_images(tmp_path)

    output = _run_archive_task(task_type, tmp_path, 1, 3)

    assert output["status"] == "ok"
    assert output["summary"]["total_files"] == 2
    assert len(output["results"]) == 2


@pytest.mark.parametrize("task_type", LOCAL_PROCESSING_TASKS)
@pytest.mark.skipif(not HAS_PILLOW, reason="Pillow optional runtime dependency")
def test_image_archive_scripts_accept_empty_slice(task_type: str, tmp_path: Path):
    _make_images(tmp_path)

    output = _run_archive_task(task_type, tmp_path, 0, 0)

    assert output["status"] == "ok"
    assert output["summary"]["total_files"] == 0
    assert output["results"] == []
