"""files_pages_chunked：multi_file PDF 按文件再按页切开。"""
from __future__ import annotations

from platform_v8.core import Workload, WorkloadSpec
from platform_v8.engine.slicers import slice_workload
from platform_v8.engine.slicers.files_pages_chunked import _allocate_slots


def test_allocate_slots_guarantees_one_per_file():
    assert _allocate_slots(3, 3, None) == [1, 1, 1]
    assert sum(_allocate_slots(2, 10, [17_000_000, 700_000])) == 10
    # 大文件应分到更多片
    slots = _allocate_slots(2, 10, [17_000_000, 700_000])
    assert slots[0] > slots[1]
    assert min(slots) >= 1


def test_pdf_to_text_multi_file_splits_pages_across_workers():
    workload = Workload(spec=WorkloadSpec(
        task_type="pdf_to_text",
        input_kind="multi_file",
        input_refs=[
            "https://oss.test/a.pdf",
            "https://oss.test/b.pdf",
        ],
        params={
            "input_sizes": [17_000_000, 700_000],
            "file_page_counts": [100, 10],
        },
        max_shards=20,
    ))
    shards = slice_workload(workload, n_workers=10)

    assert len(shards) == 10
    assert all(sh.metadata["slice_strategy"] == "files_pages_chunked" for sh in shards)
    assert all(sh.metadata["files_in_shard"] == 1 for sh in shards)

    by_file: dict[str, list] = {}
    for sh in shards:
        ref = sh.metadata["input_refs"][0]
        by_file.setdefault(ref, []).append(sh.metadata["slice_meta"])

    assert set(by_file) == set(workload.spec.input_refs)
    # 大文件拿到更多页片
    assert len(by_file["https://oss.test/a.pdf"]) > len(by_file["https://oss.test/b.pdf"])
    # 真页数切片应有 page_start/page_end
    for metas in by_file.values():
        for meta in metas:
            assert meta.get("page_index_base") == 0
            assert "page_start" in meta and "page_end" in meta
            assert meta["page_end"] > meta["page_start"]


def test_pdf_to_text_multi_file_uses_percent_when_pages_unknown():
    workload = Workload(spec=WorkloadSpec(
        task_type="pdf_to_text",
        input_kind="multi_file",
        input_refs=["https://oss.test/a.pdf", "https://oss.test/b.pdf"],
        max_shards=20,
    ))
    shards = slice_workload(workload, n_workers=4)
    assert len(shards) == 4
    metas = [sh.metadata["slice_meta"] for sh in shards]
    assert all("page_pct_start" in m and "page_pct_end" in m for m in metas)


def test_pdf_to_text_many_files_falls_back_to_files_chunked():
    """文件数多于可用片槽时，只能按文件装箱，不再按页。"""
    refs = [f"https://oss.test/{i}.pdf" for i in range(8)]
    workload = Workload(spec=WorkloadSpec(
        task_type="pdf_to_text",
        input_kind="multi_file",
        input_refs=refs,
        max_shards=20,
    ))
    shards = slice_workload(workload, n_workers=2)
    assert len(shards) == 2
    assert all(sh.metadata["slice_strategy"] == "files_chunked" for sh in shards)


def test_pdf_to_text_single_file_still_uses_pages_chunked():
    workload = Workload(spec=WorkloadSpec(
        task_type="pdf_to_text",
        input_kind="single_file",
        input_ref="https://oss.test/only.pdf",
        params={"total_pages": 40},
        max_shards=20,
    ))
    shards = slice_workload(workload, n_workers=4)
    assert len(shards) == 4
    assert all(sh.metadata["slice_strategy"] == "pages_chunked" for sh in shards)
