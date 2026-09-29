from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from platform_v8.core import Workload, WorkloadStatus
from platform_v8.storage.repo import WorkloadRepo, create_all_for_testing


def test_terminal_transition_is_compare_and_swap():
    engine = create_engine("sqlite:///:memory:", future=True)
    create_all_for_testing(engine)
    with Session(engine) as session:
        workload = Workload(owner_id=1, status=WorkloadStatus.RUNNING)
        WorkloadRepo.create(session, workload)
        session.commit()

        assert WorkloadRepo.transition_status(
            session,
            workload.id,
            WorkloadStatus.CANCELLED,
            expected_statuses=(WorkloadStatus.RUNNING, WorkloadStatus.AGGREGATING),
        )
        session.commit()
        assert not WorkloadRepo.transition_status(
            session,
            workload.id,
            WorkloadStatus.DONE,
            expected_statuses=(WorkloadStatus.AGGREGATING,),
        )
