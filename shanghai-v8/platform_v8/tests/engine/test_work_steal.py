"""工作窃取 / 抢单 · select_steal_candidates + steal_dispatched CAS"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import create_engine, insert, select
from sqlalchemy.orm import sessionmaker

from platform_v8.core import ShardStatus
from platform_v8.core.shard import Shard
from platform_v8.engine.lifecycle import (
    select_race_candidates,
    select_steal_candidates,
)
from sqlalchemy import select

from platform_v8.storage.repo import (
    ShardRepo,
    accounts_t,
    create_all_for_testing,
    shards_t,
    workloads_t,
)


@dataclass
class _FakeShard:
    id: str
    worker_id: str | None
    status: ShardStatus
    index: int = 0
    dispatched_at: datetime | None = None
    started_at: datetime | None = None
    metadata: dict | None = None


def test_default_max_attempts_is_10():
    assert Shard().max_attempts == 10


def test_select_steals_excess_dispatched_without_idle():
    """无 idle 声明时: 同节点多片只拆冗余,保留最早 1 片。"""
    now = datetime(2026, 7, 22, 12, 0, 0)
    t0 = now - timedelta(seconds=30)
    t1 = now - timedelta(seconds=20)
    shards = [
        _FakeShard("a", "w1", ShardStatus.DISPATCHED, index=0, dispatched_at=t0),
        _FakeShard("b", "w1", ShardStatus.DISPATCHED, index=1, dispatched_at=t1),
        _FakeShard("c", "w2", ShardStatus.RUNNING, index=2, dispatched_at=t0),
        _FakeShard("d", "w3", ShardStatus.DONE, index=3, dispatched_at=t0),
    ]
    stolen = select_steal_candidates(shards, idle_worker_id=None, now=now)
    assert [s.id for s in stolen] == ["b"]


def test_idle_grabs_all_others_dispatched():
    """抢单: 空闲节点可立即抢走他人全部未开跑 DISPATCHED。"""
    now = datetime(2026, 7, 22, 12, 0, 0)
    t0 = now - timedelta(seconds=1)
    shards = [
        _FakeShard("a", "w1", ShardStatus.DISPATCHED, index=0, dispatched_at=t0),
        _FakeShard("b", "w1", ShardStatus.DISPATCHED, index=1, dispatched_at=t0),
        _FakeShard("c", "w2", ShardStatus.DISPATCHED, index=2, dispatched_at=t0),
        _FakeShard("done", "w3", ShardStatus.DONE, index=3, dispatched_at=t0),
        _FakeShard("run", "w4", ShardStatus.RUNNING, index=4, dispatched_at=t0),
    ]
    stolen = select_steal_candidates(shards, idle_worker_id="idle", now=now, grace_s=0)
    assert [s.id for s in stolen] == ["a", "b", "c"]


def test_select_single_dispatched_respects_grace():
    now = datetime(2026, 7, 22, 12, 0, 0)
    fresh = now - timedelta(seconds=2)
    old = now - timedelta(seconds=20)
    shards = [
        _FakeShard("fresh", "w1", ShardStatus.DISPATCHED, index=0, dispatched_at=fresh),
        _FakeShard("old", "w2", ShardStatus.DISPATCHED, index=1, dispatched_at=old),
    ]
    assert select_steal_candidates(shards, idle_worker_id=None, now=now) == []
    stolen = select_steal_candidates(shards, idle_worker_id="w9", now=now, grace_s=8)
    assert [s.id for s in stolen] == ["old"]


def test_select_does_not_steal_from_idle_worker_own_queue():
    now = datetime(2026, 7, 22, 12, 0, 0)
    old = now - timedelta(seconds=30)
    shards = [
        _FakeShard("only", "idle", ShardStatus.DISPATCHED, index=0, dispatched_at=old),
    ]
    assert select_steal_candidates(shards, idle_worker_id="idle", now=now) == []


def _session_factory(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'steal.db'}", future=True)
    create_all_for_testing(engine)
    return sessionmaker(bind=engine, future=True, expire_on_commit=False)


def test_steal_dispatched_cas_only_dispatched(tmp_path):
    Session = _session_factory(tmp_path)
    now = datetime.utcnow()
    with Session() as s:
        s.execute(insert(accounts_t).values(
            username="u", email="u@t.com", password_hash="x",
            role="personal", status="active",
        ))
        s.execute(insert(workloads_t).values(
            id="wl1", owner_id=1, name="t", status="RUNNING",
            spec={"task_type": "image_caption"}, budget=0,
        ))
        s.execute(insert(shards_t).values(
            id="sh-d", workload_id="wl1", index=0, total=2,
            status="DISPATCHED", worker_id="w-old",
            input_ref="a", attempts=1, max_attempts=10,
            dispatched_at=now,
        ))
        s.execute(insert(shards_t).values(
            id="sh-d2", workload_id="wl1", index=1, total=2,
            status="DISPATCHED", worker_id="w-old",
            input_ref="a2", attempts=1, max_attempts=10,
            dispatched_at=now,
        ))
        s.execute(insert(shards_t).values(
            id="sh-r", workload_id="wl1", index=2, total=3,
            status="RUNNING", worker_id="w-run",
            input_ref="b", attempts=1, max_attempts=10,
            dispatched_at=now, started_at=now,
        ))
        s.commit()

        assert ShardRepo.steal_dispatched(s, "sh-d2", expected_worker_id="other") is False
        assert ShardRepo.steal_dispatched(s, "sh-d2", expected_worker_id="w-old") is True
        assert ShardRepo.steal_dispatched(s, "sh-r", expected_worker_id="w-run") is False
        s.commit()
        sh = ShardRepo.by_id(s, "sh-d2")
        assert sh.status == ShardStatus.PENDING
        assert sh.worker_id is None


def test_race_prefers_heavy_and_allows_immediate():
    now = datetime(2026, 7, 22, 12, 0, 0)
    age0 = now
    age10 = now - timedelta(seconds=10)
    light = _FakeShard(
        "light", "busy", ShardStatus.RUNNING, index=0,
        dispatched_at=age10, started_at=age10, metadata={},
    )
    heavy = _FakeShard(
        "heavy", "busy2", ShardStatus.RUNNING, index=1,
        dispatched_at=age0, started_at=age0,
        metadata={"page_part_total": 6, "dispatch_weight": 1100},
    )
    raced = select_race_candidates(
        [light, heavy], idle_worker_id="idle", now=now, min_age_s=0,
    )
    assert [s.id for s in raced] == ["heavy", "light"]


def test_heavy_shard_priority_when_grabbing():
    now = datetime(2026, 7, 22, 12, 0, 0)
    age4 = now - timedelta(seconds=4)
    shards = [
        _FakeShard(
            "light", "w1", ShardStatus.DISPATCHED, index=0, dispatched_at=age4,
            metadata={"dispatch_weight": 10},
        ),
        _FakeShard(
            "heavy", "w2", ShardStatus.DISPATCHED, index=1, dispatched_at=age4,
            metadata={"dispatch_weight": 1200, "page_part_total": 4},
        ),
    ]
    stolen = select_steal_candidates(shards, idle_worker_id="idle", now=now, grace_s=0)
    assert [s.id for s in stolen] == ["heavy", "light"]


def test_mark_done_race_winner(tmp_path):
    Session = _session_factory(tmp_path)
    now = datetime.utcnow()
    with Session() as s:
        s.execute(insert(accounts_t).values(
            username="u3", email="u3@t.com", password_hash="x",
            role="personal", status="active",
        ))
        s.execute(insert(workloads_t).values(
            id="wl3", owner_id=1, name="t", status="RUNNING",
            spec={"task_type": "image_caption"}, budget=0,
        ))
        s.execute(insert(shards_t).values(
            id="sh-race", workload_id="wl3", index=0, total=1,
            status="RUNNING", worker_id="owner",
            input_ref="a", attempts=1, max_attempts=10,
            dispatched_at=now, started_at=now,
            metadata={"race_workers": ["racer"]},
        ))
        s.commit()

    with Session() as s:
        assert ShardRepo.mark_done(
            s, "sh-race", output_ref="ok", expected_worker_id="racer"
        ) is True
        s.commit()
    with Session() as s:
        sh = ShardRepo.by_id(s, "sh-race")
        assert sh.status == ShardStatus.DONE
        assert sh.worker_id == "racer"
        # 败者迟到
        assert ShardRepo.mark_done(
            s, "sh-race", output_ref="late", expected_worker_id="owner"
        ) is False
        s.commit()


def test_mark_failed_allows_active_and_pending(tmp_path):
    """PENDING/DISPATCHED/RUNNING/LEASED 均可 FAILED（含 attempts 用尽兜底）。"""
    Session = _session_factory(tmp_path)
    now = datetime.utcnow()
    with Session() as s:
        s.execute(insert(accounts_t).values(
            username="u-mf-ok", email="mf-ok@t.com", password_hash="x",
            role="personal", status="active",
        ))
        s.execute(insert(workloads_t).values(
            id="wl-mf-ok", owner_id=1, name="mf-ok", status="RUNNING",
            spec={"task_type": "image_caption"}, budget=0,
        ))
        for idx, (sid, st) in enumerate((
            ("sh-pending", "PENDING"),
            ("sh-dispatched", "DISPATCHED"),
            ("sh-running", "RUNNING"),
            ("sh-leased", "LEASED"),
        )):
            s.execute(insert(shards_t).values(
                id=sid, workload_id="wl-mf-ok", index=idx, total=4,
                status=st, worker_id="w1" if st != "PENDING" else None,
                input_ref=f"in-{idx}", attempts=1, max_attempts=10,
                dispatched_at=now if st != "PENDING" else None,
                started_at=now if st in ("RUNNING", "LEASED") else None,
            ))
        s.commit()

    for sid, st in (
        ("sh-pending", "PENDING"),
        ("sh-dispatched", "DISPATCHED"),
        ("sh-running", "RUNNING"),
        ("sh-leased", "LEASED"),
    ):
        with Session() as s:
            assert ShardRepo.mark_failed(
                s, sid, error=f"fail-{st}", failure_class="node",
            ) is True
            s.commit()
        with Session() as s:
            sh = ShardRepo.by_id(s, sid)
            assert sh is not None
            assert sh.status == ShardStatus.FAILED
            assert sh.error == f"fail-{st}"
            row = s.execute(
                select(shards_t.c.failure_class).where(shards_t.c.id == sid)
            ).one()
            assert row.failure_class == "node"


def test_mark_failed_rejects_done_cancelled_and_already_failed(tmp_path):
    """迟到失败帧不得覆盖 DONE / CANCELLED / 已 FAILED。"""
    Session = _session_factory(tmp_path)
    now = datetime.utcnow()
    with Session() as s:
        s.execute(insert(accounts_t).values(
            username="u-mf2", email="mf2@t.com", password_hash="x",
            role="personal", status="active",
        ))
        s.execute(insert(workloads_t).values(
            id="wl-mf2", owner_id=1, name="mf2", status="RUNNING",
            spec={"task_type": "image_caption"}, budget=0,
        ))
        s.execute(insert(shards_t).values(
            id="sh-done", workload_id="wl-mf2", index=0, total=3,
            status="DONE", worker_id="w1", output_ref="out-ok",
            input_ref="a", attempts=1, max_attempts=10,
            dispatched_at=now, started_at=now, completed_at=now,
            error="",
        ))
        s.execute(insert(shards_t).values(
            id="sh-cancel", workload_id="wl-mf2", index=1, total=3,
            status="CANCELLED", worker_id=None,
            input_ref="b", attempts=0, max_attempts=10,
            error="",
        ))
        s.execute(insert(shards_t).values(
            id="sh-failed", workload_id="wl-mf2", index=2, total=3,
            status="FAILED", worker_id="w2",
            input_ref="c", attempts=3, max_attempts=10,
            dispatched_at=now, completed_at=now,
            error="first-fail", failure_class="timeout",
        ))
        s.commit()

    with Session() as s:
        assert ShardRepo.mark_failed(s, "sh-done", error="late-fail") is False
        assert ShardRepo.mark_failed(s, "sh-cancel", error="late-fail") is False
        assert ShardRepo.mark_failed(s, "sh-failed", error="overwrite") is False
        s.commit()

    with Session() as s:
        done = ShardRepo.by_id(s, "sh-done")
        assert done.status == ShardStatus.DONE
        assert done.output_ref == "out-ok"
        assert (done.error or "") == ""

        cancelled = ShardRepo.by_id(s, "sh-cancel")
        assert cancelled.status == ShardStatus.CANCELLED

        failed = ShardRepo.by_id(s, "sh-failed")
        assert failed.status == ShardStatus.FAILED
        assert failed.error == "first-fail"
        row = s.execute(
            select(shards_t.c.failure_class).where(shards_t.c.id == "sh-failed")
        ).one()
        assert row.failure_class == "timeout"


def test_steal_and_race_are_noop_when_flags_off(monkeypatch):
    """flag 关闭时两条通道必须直接返回 0 且不碰 DB ·
    on_shard_completed_redispatch 退化为纯 PENDING 重派。"""
    import asyncio

    from platform_v8.engine import lifecycle
    from platform_v8.services.ops import feature_flags

    monkeypatch.setattr(feature_flags, "is_enabled", lambda *a, **k: False)

    def _boom(*a, **k):  # DB 一旦被访问就说明 flag 守门失效
        raise AssertionError("flag 关闭时不应访问 DB")

    monkeypatch.setattr(ShardRepo, "by_workload", _boom)

    assert asyncio.run(
        lifecycle._steal_dispatched_impl("wl-x", idle_worker_id="idle")
    ) == 0
    assert asyncio.run(
        lifecycle._race_running_impl("wl-x", idle_worker_id="idle")
    ) == 0


def test_race_requires_idle_worker():
    """没有空闲节点时不发起任何竞速（避免无谓双烧算力）。"""
    import asyncio

    from platform_v8.engine import lifecycle

    now = datetime(2026, 7, 22, 12, 0, 0)
    running = _FakeShard(
        "r", "busy", ShardStatus.RUNNING, index=0,
        dispatched_at=now, started_at=now, metadata={},
    )
    assert select_race_candidates([running], idle_worker_id=None, now=now) == []
    assert asyncio.run(lifecycle._race_running_impl("wl-y", idle_worker_id=None)) == 0


def test_mark_running_rejects_pending(tmp_path):
    Session = _session_factory(tmp_path)
    with Session() as s:
        s.execute(insert(accounts_t).values(
            username="u2", email="u2@t.com", password_hash="x",
            role="personal", status="active",
        ))
        s.execute(insert(workloads_t).values(
            id="wl2", owner_id=1, name="t", status="RUNNING",
            spec={"task_type": "image_caption"}, budget=0,
        ))
        s.execute(insert(shards_t).values(
            id="sh-x", workload_id="wl2", index=0, total=1,
            status="PENDING", worker_id=None,
            input_ref="a", attempts=1, max_attempts=10,
        ))
        s.commit()

    with Session() as s:
        assert ShardRepo.mark_running(s, "sh-x", expected_worker_id="w1") is False
        s.commit()


def test_mark_failed_allows_active_and_pending(tmp_path):
    """PENDING/DISPATCHED/RUNNING/LEASED 均可 FAILED（含 attempts 用尽兜底）。"""
    Session = _session_factory(tmp_path)
    now = datetime.utcnow()
    with Session() as s:
        s.execute(insert(accounts_t).values(
            username="u-mf-ok", email="mf-ok@t.com", password_hash="x",
            role="personal", status="active",
        ))
        s.execute(insert(workloads_t).values(
            id="wl-mf-ok", owner_id=1, name="mf-ok", status="RUNNING",
            spec={"task_type": "image_caption"}, budget=0,
        ))
        for idx, (sid, st) in enumerate((
            ("sh-pending", "PENDING"),
            ("sh-dispatched", "DISPATCHED"),
            ("sh-running", "RUNNING"),
            ("sh-leased", "LEASED"),
        )):
            s.execute(insert(shards_t).values(
                id=sid, workload_id="wl-mf-ok", index=idx, total=4,
                status=st, worker_id="w1" if st != "PENDING" else None,
                input_ref=f"in-{idx}", attempts=1, max_attempts=10,
                dispatched_at=now if st != "PENDING" else None,
                started_at=now if st in ("RUNNING", "LEASED") else None,
            ))
        s.commit()

    for sid, st in (
        ("sh-pending", "PENDING"),
        ("sh-dispatched", "DISPATCHED"),
        ("sh-running", "RUNNING"),
        ("sh-leased", "LEASED"),
    ):
        with Session() as s:
            assert ShardRepo.mark_failed(
                s, sid, error=f"fail-{st}", failure_class="node",
            ) is True
            s.commit()
        with Session() as s:
            sh = ShardRepo.by_id(s, sid)
            assert sh is not None
            assert sh.status == ShardStatus.FAILED
            assert sh.error == f"fail-{st}"
            row = s.execute(
                select(shards_t.c.failure_class).where(shards_t.c.id == sid)
            ).one()
            assert row.failure_class == "node"


def test_mark_failed_rejects_done_cancelled_and_already_failed(tmp_path):
    """迟到失败帧不得覆盖 DONE / CANCELLED / 已 FAILED。"""
    Session = _session_factory(tmp_path)
    now = datetime.utcnow()
    with Session() as s:
        s.execute(insert(accounts_t).values(
            username="u-mf2", email="mf2@t.com", password_hash="x",
            role="personal", status="active",
        ))
        s.execute(insert(workloads_t).values(
            id="wl-mf2", owner_id=1, name="mf2", status="RUNNING",
            spec={"task_type": "image_caption"}, budget=0,
        ))
        s.execute(insert(shards_t).values(
            id="sh-done", workload_id="wl-mf2", index=0, total=3,
            status="DONE", worker_id="w1", output_ref="out-ok",
            input_ref="a", attempts=1, max_attempts=10,
            dispatched_at=now, started_at=now, completed_at=now,
            error="",
        ))
        s.execute(insert(shards_t).values(
            id="sh-cancel", workload_id="wl-mf2", index=1, total=3,
            status="CANCELLED", worker_id=None,
            input_ref="b", attempts=0, max_attempts=10,
            error="",
        ))
        s.execute(insert(shards_t).values(
            id="sh-failed", workload_id="wl-mf2", index=2, total=3,
            status="FAILED", worker_id="w2",
            input_ref="c", attempts=3, max_attempts=10,
            dispatched_at=now, completed_at=now,
            error="first-fail", failure_class="timeout",
        ))
        s.commit()

    with Session() as s:
        assert ShardRepo.mark_failed(s, "sh-done", error="late-fail") is False
        assert ShardRepo.mark_failed(s, "sh-cancel", error="late-fail") is False
        assert ShardRepo.mark_failed(s, "sh-failed", error="overwrite") is False
        s.commit()

    with Session() as s:
        done = ShardRepo.by_id(s, "sh-done")
        assert done.status == ShardStatus.DONE
        assert done.output_ref == "out-ok"
        assert (done.error or "") == ""

        cancelled = ShardRepo.by_id(s, "sh-cancel")
        assert cancelled.status == ShardStatus.CANCELLED

        failed = ShardRepo.by_id(s, "sh-failed")
        assert failed.status == ShardStatus.FAILED
        assert failed.error == "first-fail"
        row = s.execute(
            select(shards_t.c.failure_class).where(shards_t.c.id == "sh-failed")
        ).one()
        assert row.failure_class == "timeout"
