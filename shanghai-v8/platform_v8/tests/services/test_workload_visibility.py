"""跨用户排单 / 接单可见性：发布人看自己的单，节点所有者能看到派到自己机器的单。"""
from __future__ import annotations

from sqlalchemy import create_engine, insert
from sqlalchemy.orm import sessionmaker

from platform_v8.core import Account, AccountRole, AccountStatus
from platform_v8.services.workloads import query as query_svc
from platform_v8.storage.repo import (
    WorkloadRepo,
    accounts_t,
    create_all_for_testing,
    shards_t,
    workers_t,
    workloads_t,
)


def _session_factory(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'vis.db'}", future=True)
    create_all_for_testing(engine)
    return sessionmaker(bind=engine, future=True, expire_on_commit=False)


def _acct(aid: int, name: str, *, admin: bool = False) -> Account:
    return Account(
        id=aid,
        username=name,
        email=f"{name}@t.com",
        password_hash="x",
        role=AccountRole.ADMIN if admin else AccountRole.PERSONAL,
        status=AccountStatus.ACTIVE,
    )


def test_assignee_sees_foreign_workload_in_list_and_get(tmp_path):
    Session = _session_factory(tmp_path)
    with Session() as s:
        s.execute(insert(accounts_t).values(
            username="pub", email="pub@t.com", password_hash="x",
            role="personal", status="active",
        ))
        s.execute(insert(accounts_t).values(
            username="node", email="node@t.com", password_hash="x",
            role="personal", status="active",
        ))
        s.execute(insert(accounts_t).values(
            username="stranger", email="str@t.com", password_hash="x",
            role="personal", status="active",
        ))
        s.execute(insert(workers_t).values(
            id="w-node", owner_id=2, name="mini", status="ONLINE", capabilities={},
        ))
        s.execute(insert(workloads_t).values(
            id="wl-cross", owner_id=1, name="跨户压缩", status="RUNNING",
            spec={"task_type": "image_compress"}, budget=1,
        ))
        s.execute(insert(workloads_t).values(
            id="wl-own", owner_id=2, name="节点自己的单", status="DONE",
            spec={"task_type": "word_to_text"}, budget=1,
        ))
        s.execute(insert(shards_t).values(
            id="sh-cross", workload_id="wl-cross", index=0, total=1,
            status="RUNNING", worker_id="w-node",
        ))
        s.commit()

        publisher, node, stranger = _acct(1, "pub"), _acct(2, "node"), _acct(3, "stranger")

        pub_ids = {w.id for w in query_svc.list_workloads(s, caller=publisher)}
        assert pub_ids == {"wl-cross"}

        node_ids = {w.id for w in query_svc.list_workloads(s, caller=node)}
        assert node_ids == {"wl-cross", "wl-own"}

        stranger_ids = {w.id for w in query_svc.list_workloads(s, caller=stranger)}
        assert stranger_ids == set()

        assert query_svc.get_workload(s, "wl-cross", caller=node).name == "跨户压缩"
        try:
            query_svc.get_workload(s, "wl-cross", caller=stranger)
            raise AssertionError("stranger should be denied")
        except query_svc.WorkloadAccessDenied:
            pass

        assert WorkloadRepo.account_has_assignment(s, "wl-cross", 2) is True
        assert WorkloadRepo.account_has_assignment(s, "wl-cross", 3) is False

        # 接单可见进度，但不能读别人派发的结果；自己派的单可以
        cross = query_svc.get_workload(s, "wl-cross", caller=node)
        own = query_svc.get_workload(s, "wl-own", caller=node)
        admin = _acct(99, "admin", admin=True)
        assert query_svc.can_read_result(cross, publisher) is True
        assert query_svc.can_read_result(cross, node) is False
        assert query_svc.can_read_result(cross, admin) is True
        assert query_svc.can_read_result(own, node) is True
        try:
            query_svc.require_result_access(cross, node)
            raise AssertionError("assignee should be denied foreign result")
        except query_svc.WorkloadResultDenied:
            pass
        query_svc.require_result_access(own, node)
