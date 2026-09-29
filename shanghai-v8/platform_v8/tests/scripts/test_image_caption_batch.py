import importlib.util
import json
from pathlib import Path

from platform_v8.core import Workload, WorkloadSpec
from platform_v8.engine.slicers import slice_workload
from platform_v8.engine.task_registry import get_spec


SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "scripts"
    / "tasks"
    / "image_caption.py"
)


def _load_script():
    spec = importlib.util.spec_from_file_location("image_caption_batch", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_image_caption_multi_file_splits_eight_images_across_two_workers():
    workload = Workload(
        spec=WorkloadSpec(
            task_type="image_caption",
            input_kind="multi_file",
            input_refs=[f"https://oss.test/{i}.jpg" for i in range(8)],
            max_shards=8,
        )
    )

    shards = slice_workload(workload, n_workers=2)

    assert len(shards) == 2
    assert [sh.metadata["files_in_shard"] for sh in shards] == [4, 4]
    assert shards[0].metadata["input_refs"] == [
        f"https://oss.test/{i}.jpg" for i in range(4)
    ]
    assert shards[1].metadata["input_refs"] == [
        f"https://oss.test/{i}.jpg" for i in range(4, 8)
    ]


def test_image_caption_archive_is_accepted_and_sliced_by_worker_count():
    assert "archive" in get_spec("image_caption").accepted_input_kinds
    workload = Workload(
        spec=WorkloadSpec(
            task_type="image_caption",
            input_kind="archive",
            input_ref="https://oss.test/images.zip",
            max_shards=8,
        )
    )

    shards = slice_workload(workload, n_workers=2)

    assert len(shards) == 2
    assert shards[0].metadata["slice_meta"] == {
        "file_idx_pct_start": 0.0,
        "file_idx_pct_end": 0.5,
    }
    assert shards[1].metadata["slice_meta"] == {
        "file_idx_pct_start": 0.5,
        "file_idx_pct_end": 1.0,
    }


def test_image_caption_reads_nested_archive_slice(tmp_path, monkeypatch):
    (tmp_path / "nested").mkdir()
    (tmp_path / "a.jpg").write_bytes(b"a")
    (tmp_path / "nested" / "b.png").write_bytes(b"b")
    (tmp_path / "nested" / "ignore.txt").write_text("ignore")
    monkeypatch.setenv("EC_INPUT_DIR", str(tmp_path))
    monkeypatch.setenv(
        "EC_SLICE_META",
        json.dumps({"file_idx_start": 1, "file_idx_end": 2}),
    )

    params = {}
    inputs = _load_script()._read_inputs(params)

    assert inputs == [("nested/b.png", b"b")]
    assert "_empty_archive_slice" not in params


def test_image_caption_marks_empty_archive_slice_as_success_candidate(
    tmp_path, monkeypatch
):
    (tmp_path / "only.jpg").write_bytes(b"image")
    monkeypatch.setenv("EC_INPUT_DIR", str(tmp_path))
    monkeypatch.setenv(
        "EC_SLICE_META",
        json.dumps({"file_idx_pct_start": 0.0, "file_idx_pct_end": 0.5}),
    )

    params = {}
    inputs = _load_script()._read_inputs(params)

    assert inputs == []
    assert params["_empty_archive_slice"] is True
