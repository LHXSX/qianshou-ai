"""P7 Capability Registry CTS · 双读 / 映射 / 不误替代未映射 software"""
from __future__ import annotations

from platform_v8.core.worker import WorkerCapabilities
from platform_v8.tests.engine.test_planner_nce import _mk_worker
from platform_v8.engine.capabilities import (
    MVP_NAMES,
    advertised_names,
    repair_tiers_for,
    resolve_required,
    split_software_requirements,
    worker_matches_requirements,
    worker_matches_v2_capabilities,
)
from platform_v8.engine.task_registry import get_spec


def test_mvp_frozen():
    assert "media.probe" in MVP_NAMES
    assert "media.transform" in MVP_NAMES
    assert "image.transform" in MVP_NAMES
    assert "doc.pdf.text" in MVP_NAMES


def test_pdf_task_resolves_capability_not_venv_path():
    spec = get_spec("pdf_to_text")
    caps = resolve_required(spec)
    assert caps == [{"name": "doc.pdf.text", "version": "1.0.0"}]


def test_excel_and_ffmpeg_tasks():
    assert resolve_required(get_spec("excel_export")) == [{"name": "data.table.read", "version": "1.0.0"}]
    names = {c["name"] for c in resolve_required(get_spec("video_info"))}
    assert names == {"media.probe"}
    assert {c["name"] for c in resolve_required(get_spec("video_compress"))} == {"media.transform"}
    assert {c["name"] for c in resolve_required(get_spec("audio_extract"))} == {"media.transform"}


def test_whisper_keeps_unmapped_software():
    unmapped, caps = split_software_requirements(("ffmpeg", "whisper"))
    assert unmapped == {"whisper"}
    assert caps == {"media.probe"}


def test_old_node_inferred_from_tier():
    cap = WorkerCapabilities(runtime_tiers=["lite"], software=[])
    assert "doc.pdf.text" in advertised_names(cap)
    assert "data.table.read" in advertised_names(cap)
    assert "media.probe" not in advertised_names(cap)


def test_dual_read_capability_without_software():
    only_cap = WorkerCapabilities(
        provided_capabilities=[{"name": "doc.pdf.text", "version": "1.0", "health": "healthy"}],
        software=[],
    )
    assert worker_matches_requirements(only_cap, ("pymupdf",))
    old = WorkerCapabilities(software=["pymupdf"])
    assert worker_matches_requirements(old, ("pymupdf",))
    empty = WorkerCapabilities(software=["pillow"])
    assert not worker_matches_requirements(empty, ("pymupdf",))


def test_whisper_not_satisfied_by_media_probe_alone():
    probe_only = WorkerCapabilities(
        provided_capabilities=[{"name": "media.probe", "health": "healthy"}],
        software=["ffmpeg"],
    )
    assert not worker_matches_requirements(probe_only, ("ffmpeg", "whisper"))
    full = WorkerCapabilities(software=["ffmpeg", "whisper"])
    assert worker_matches_requirements(full, ("ffmpeg", "whisper"))


def test_quarantined_capability_not_counted():
    cap = WorkerCapabilities(
        provided_capabilities=[{"name": "doc.pdf.text", "health": "quarantined"}],
        software=[],
    )
    assert "doc.pdf.text" not in advertised_names(cap)


def test_repair_tiers():
    assert repair_tiers_for(["media.probe", "doc.pdf.text"]) == ["ffmpeg", "lite"]


def test_planner_dual_read():
    from platform_v8.core import Workload, WorkloadSpec
    from platform_v8.engine.planner import _filter_by_requirements

    wl = Workload(id="w1", owner_id=1, spec=WorkloadSpec(task_type="pdf_to_text"))
    old = _mk_worker(name="old")
    old.capabilities = WorkerCapabilities(software=["pymupdf"])
    cap_only = _mk_worker(name="cap")
    cap_only.capabilities = WorkerCapabilities(
        provided_capabilities=[{"name": "doc.pdf.text", "health": "healthy"}],
    )
    none = _mk_worker(name="none")
    none.capabilities = WorkerCapabilities(software=["pillow"])
    out = _filter_by_requirements([old, cap_only, none], wl)
    assert {w.name for w in out} == {"old", "cap"}


def test_hard_provided_ignores_software_and_tier():
    soft = WorkerCapabilities(software=["pymupdf"], runtime_tiers=["lite"])
    assert "doc.pdf.text" in advertised_names(soft)
    assert "doc.pdf.text" not in advertised_names(soft, hard_provided_only=True)

    hard = WorkerCapabilities(
        provided_capabilities=[{"name": "doc.pdf.text", "health": "healthy"}],
        software=[],
    )
    assert "doc.pdf.text" in advertised_names(hard, hard_provided_only=True)
    assert worker_matches_v2_capabilities(hard, [{"name": "doc.pdf.text"}])
    assert not worker_matches_v2_capabilities(soft, [{"name": "doc.pdf.text"}])


def test_filter_by_runtime_v2_respects_gray_flag(monkeypatch):
    from platform_v8.core import Workload, WorkloadSpec
    from platform_v8.engine.planner import _filter_by_runtime_v2

    monkeypatch.delenv("EDGE_PLANNER_RUNTIME_V2", raising=False)
    wl = Workload(
        id="w1",
        owner_id=1,
        spec=WorkloadSpec(task_type="pdf_to_text", execution_model="runtime_v2"),
    )
    soft = _mk_worker(name="soft")
    soft.capabilities = WorkerCapabilities(software=["pymupdf"], runtime_tiers=["lite"])
    hard = _mk_worker(name="hard")
    hard.capabilities = WorkerCapabilities(
        provided_capabilities=[{"name": "doc.pdf.text", "health": "healthy"}],
    )
    # 灰度关：零回归，不过滤
    out_off = _filter_by_runtime_v2([soft, hard], wl)
    assert {w.name for w in out_off} == {"soft", "hard"}

    monkeypatch.setenv("EDGE_PLANNER_RUNTIME_V2", "1")
    out_on = _filter_by_runtime_v2([soft, hard], wl)
    assert {w.name for w in out_on} == {"hard"}

    # 无 V2 广告节点：fail-open 给旧千手节点，避免 WAITING
    out_soft = _filter_by_runtime_v2([soft], wl)
    assert {w.name for w in out_soft} == {"soft"}

    # Legacy workload：即使开关开也不走硬过滤
    legacy = Workload(id="w2", owner_id=1, spec=WorkloadSpec(task_type="pdf_to_text"))
    out_legacy = _filter_by_runtime_v2([soft, hard], legacy)
    assert {w.name for w in out_legacy} == {"soft", "hard"}
