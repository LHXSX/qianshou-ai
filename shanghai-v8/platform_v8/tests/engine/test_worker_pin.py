"""requirements.worker_ids / allowed_worker_ids 硬 pin 单测。"""
from __future__ import annotations
import sys
import uuid
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.core import Worker, Workload, WorkloadSpec
from platform_v8.core.enums import WorkerStatus
from platform_v8.core.worker import WorkerCapabilities
from platform_v8.engine.planner import (
    pinned_worker_ids,
    _filter_by_worker_pin,
    _filter_by_requirements,
)


def _mk_worker(owner_id=1, wid=None):
    return Worker(
        id=wid or str(uuid.uuid4()),
        owner_id=owner_id,
        name="w",
        status=WorkerStatus.ONLINE,
        capabilities=WorkerCapabilities(),
        load=0.1,
        active_shards=0,
        reputation=0.5,
        capability_score=50.0,
    )


def _mk_wl(owner_id=1, req=None, task_type="pdf_ocr"):
    return Workload(
        id=str(uuid.uuid4()),
        owner_id=owner_id,
        name="pin-test",
        budget=0,
        spec=WorkloadSpec(
            task_type=task_type,
            code_url="https://example.com/x.py",
            input_ref="https://example.com/a.pdf",
            requirements=dict(req or {}),
        ),
    )


def test_pinned_worker_ids_none_when_absent():
    assert pinned_worker_ids(_mk_wl(req={})) is None
    assert pinned_worker_ids(_mk_wl(req={"min_cpu": 1})) is None


def test_pinned_worker_ids_union():
    a, b, c = "aa", "bb", "cc"
    pin = pinned_worker_ids(_mk_wl(req={"worker_ids": [a, b], "allowed_worker_ids": [b, c]}))
    assert pin == {a, b, c}


def test_filter_pin_keeps_only_listed_same_owner():
    w1 = _mk_worker(owner_id=7, wid="w1")
    w2 = _mk_worker(owner_id=7, wid="w2")
    foreign = _mk_worker(owner_id=99, wid="w1")  # 同 ID 不可能，另造
    foreign = _mk_worker(owner_id=99, wid="fx")
    pinned_other_owner = _mk_worker(owner_id=99, wid="w2")
    wl = _mk_wl(owner_id=7, req={"worker_ids": ["w1", "w2"]})
    out = _filter_by_worker_pin([w1, w2, foreign, pinned_other_owner], wl)
    assert {w.id for w in out} == {"w1", "w2"}


def test_filter_pin_empty_list_blocks_all():
    w1 = _mk_worker(wid="w1")
    wl = _mk_wl(req={"worker_ids": []})
    assert pinned_worker_ids(wl) == set()
    assert _filter_by_worker_pin([w1], wl) == []


def test_filter_by_requirements_applies_pin_even_without_software():
    """无软件硬要求的 task · 旧逻辑会直接 return 全员；pin 必须先生效。"""
    mine = _mk_worker(owner_id=1, wid="mine")
    other = _mk_worker(owner_id=2, wid="other")
    wl = _mk_wl(
        owner_id=1,
        req={"worker_ids": ["mine"], "allowed_worker_ids": ["mine"]},
        task_type="__pin_test_no_caps__",
    )
    out = _filter_by_requirements([mine, other], wl)
    assert [w.id for w in out] == ["mine"]
