from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine, func, insert, select, update
from sqlalchemy.orm import Session

from platform_v8.storage.repo import (
    AssignmentDeliveryRepo,
    assignment_deliveries_t,
    create_all_for_testing,
    shards_t,
    workers_t,
    workloads_t,
)
from platform_v8.services.workers.register import RegisterWorkerInput, register_worker


def _session() -> Session:
    engine = create_engine("sqlite:///:memory:", future=True)
    create_all_for_testing(engine)
    session = Session(engine)
    session.execute(insert(workers_t).values(
        id="worker-1",
        owner_id=1,
        name="worker",
        status="ONLINE",
        capabilities={},
    ))
    session.execute(insert(workloads_t).values(
        id="workload-1",
        owner_id=1,
        name="workload",
        spec={"task_type": "noop", "runtime": "python3"},
        status="RUNNING",
        budget=0,
    ))
    session.execute(insert(shards_t).values(
        id="shard-1",
        workload_id="workload-1",
        status="DISPATCHED",
        worker_id="worker-1",
        attempts=1,
    ))
    session.commit()
    return session


def _record(session: Session, *, attempt: int, connection_id: str):
    return AssignmentDeliveryRepo.record_after_send(
        session,
        shard_id="shard-1",
        workload_id="workload-1",
        worker_id="worker-1",
        attempt=attempt,
        connection_id=connection_id,
        mode="push",
        client_version="8.0.9",
        protocol_capabilities=["legacy-result"],
        assignment_manifest={
            "input_kind": "multi_file",
            "input_manifest": {"schema": "input_manifest.v1"},
        },
    )


def test_record_is_idempotent_and_never_commits():
    with _session() as session:
        _record(session, attempt=1, connection_id="rollback-connection")
        session.rollback()
        assert session.scalar(
            select(func.count()).select_from(assignment_deliveries_t)
        ) == 0

        first = _record(session, attempt=1, connection_id="connection-a")
        duplicate = _record(session, attempt=1, connection_id="connection-a")
        assert first.id == duplicate.id
        assert first.assignment_manifest["input_kind"] == "multi_file"
        assert first.assignment_manifest["input_manifest"]["schema"] == (
            "input_manifest.v1"
        )
        assert session.scalar(
            select(func.count()).select_from(assignment_deliveries_t)
        ) == 1


def test_current_delivery_is_connection_isolated_and_attempt_ambiguity_fails_closed():
    with _session() as session:
        _record(session, attempt=1, connection_id="connection-a")
        assert AssignmentDeliveryRepo.has_unambiguous_current_delivery(
            session,
            shard_id="shard-1",
            worker_id="worker-1",
            connection_id="connection-a",
        )

        _record(session, attempt=2, connection_id="connection-a")
        session.execute(
            update(shards_t)
            .where(shards_t.c.id == "shard-1")
            .values(attempts=2)
        )
        assert [
            row.attempt
            for row in AssignmentDeliveryRepo.get_current_for_connection(
                session,
                "connection-a",
                shard_id="shard-1",
                worker_id="worker-1",
            )
        ] == [2]
        assert not AssignmentDeliveryRepo.has_unambiguous_current_delivery(
            session,
            shard_id="shard-1",
            worker_id="worker-1",
            connection_id="connection-a",
        )
        assert [
            row.attempt
            for row in AssignmentDeliveryRepo.attempt_history_for_shard_worker(
                session,
                shard_id="shard-1",
                worker_id="worker-1",
            )
        ] == [2, 1]

        _record(session, attempt=2, connection_id="connection-b")
        assert AssignmentDeliveryRepo.has_unambiguous_current_delivery(
            session,
            shard_id="shard-1",
            worker_id="worker-1",
            connection_id="connection-b",
        )
        assert not AssignmentDeliveryRepo.has_unambiguous_current_delivery(
            session,
            shard_id="shard-1",
            worker_id="worker-1",
            connection_id="connection-a",
        )
        assert {
            row.connection_id
            for row in AssignmentDeliveryRepo.get_current_for_connection(
                session, "connection-b",
            )
        } == {"connection-b"}


def test_disconnect_cleanup_retains_audit_by_default():
    with _session() as session:
        _record(session, attempt=1, connection_id="connection-a")
        assert AssignmentDeliveryRepo.cleanup_connection(
            session, "connection-a",
        ) == 0
        assert session.scalar(
            select(func.count()).select_from(assignment_deliveries_t)
        ) == 1
        assert AssignmentDeliveryRepo.cleanup_connection(
            session,
            "connection-a",
            retain_audit=False,
            delivered_before=datetime.now(timezone.utc) + timedelta(seconds=1),
        ) == 1


def test_worker_registration_merges_protocol_metadata_without_new_columns():
    with _session() as session:
        register_worker(session, RegisterWorkerInput(
            worker_id="worker-1",
            owner_id=1,
            name="legacy",
            capabilities={"cpu_cores": 4},
            client_version="8.0.9",
        ))
        row = session.execute(
            select(workers_t).where(workers_t.c.id == "worker-1")
        ).one()
        assert row.client_version == "8.0.9"
        assert row.capabilities["cpu_cores"] == 4
        assert row.capabilities["protocol_legacy"] is True

        register_worker(session, RegisterWorkerInput(
            worker_id="worker-1",
            owner_id=1,
            name="modern",
            capabilities={"cpu_cores": 8},
            client_version="8.3.0",
            client_build="20260813.1",
            protocol_capabilities=["assignment-token.v1"],
        ))
        row = session.execute(
            select(workers_t).where(workers_t.c.id == "worker-1")
        ).one()
        assert row.client_version == "8.3.0"
        assert row.capabilities == {
            "cpu_cores": 8,
            "client_build": "20260813.1",
            "protocol_capabilities": ["assignment-token.v1"],
            "protocol_legacy": False,
            "protocol_profile": "lease_inline_v1",
            "protocol_profile_source": "hello_capabilities",
        }
