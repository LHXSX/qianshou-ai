from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import Response

from platform_v8.api.v8 import developer, workloads
from platform_v8.core import Workload, WorkloadSpec, WorkloadStatus
from platform_v8.services.workloads import submit as submit_svc


def test_workloads_archive_uses_status_aware_start(monkeypatch):
    workload = Workload(
        id="00000000-0000-4000-8000-000000000001",
        owner_id=7,
        name="Archive batch",
        spec=WorkloadSpec(
            task_type="csv_to_json",
            input_kind="archive",
            input_ref="v8/account-7/input/archive.zip",
        ),
        status=WorkloadStatus.NORMALIZING,
        budget=Decimal("1"),
    )
    monkeypatch.setattr(
        submit_svc,
        "submit_workload",
        lambda *_args, **_kwargs: workload,
    )
    scheduled = []
    bg = SimpleNamespace(
        add_task=lambda callback, *args: scheduled.append((callback, args))
    )
    body = SimpleNamespace(
        name="Archive batch",
        spec=SimpleNamespace(model_dump=lambda: {}),
        budget=Decimal("1"),
    )
    request = SimpleNamespace(
        headers={},
        client=SimpleNamespace(host="127.0.0.1"),
        state=SimpleNamespace(trace_id="trace"),
    )
    response = Response()
    current = SimpleNamespace(id=7, is_admin=False)

    workloads.submit_endpoint(
        body,
        request,
        bg,
        response,
        SimpleNamespace(),
        current,
    )

    assert response.status_code == 202
    assert scheduled == [
        (
            workloads._async_wrap,
            (
                workloads.start_submitted_workload,
                workload.id,
            ),
        )
    ]


@pytest.mark.asyncio
async def test_developer_start_adapter_uses_status_aware_start(monkeypatch):
    called = []

    async def _start(workload_id):
        called.append(workload_id)

    monkeypatch.setattr(developer, "start_submitted_workload", _start)

    await developer._start_workload("developer-archive-id")

    assert called == ["developer-archive-id"]


@pytest.mark.asyncio
async def test_developer_archive_submission_uses_start_adapter(monkeypatch):
    workload = Workload(
        id="00000000-0000-4000-8000-000000000002",
        owner_id=7,
        name="Developer archive",
        spec=WorkloadSpec(
            task_type="csv_to_json",
            input_kind="archive",
            input_ref="v8/account-7/input/archive.zip",
        ),
        status=WorkloadStatus.NORMALIZING,
        budget=Decimal("1"),
    )
    task_spec = SimpleNamespace(
        task_type="csv_to_json",
        runtimes=("python3",),
        description="CSV",
    )
    monkeypatch.setattr(
        developer,
        "_validate_task_input",
        lambda *_args: (
            task_spec,
            ["v8/account-7/input/archive.zip"],
        ),
    )
    monkeypatch.setattr(developer, "_lock_idempotency", lambda *_args: None)
    monkeypatch.setattr(
        developer.DeveloperTaskRepo,
        "get_idempotency",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        developer.DeveloperTaskRepo,
        "reserve_idempotency",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        developer.DeveloperTaskRepo,
        "bind_idempotency_workload",
        lambda *_args, **_kwargs: None,
    )
    captured = {}

    def _submit(_session, inp):
        captured["spec"] = inp.spec_dict
        return workload

    monkeypatch.setattr(submit_svc, "submit_workload", _submit)
    scheduled = []
    bg = SimpleNamespace(
        add_task=lambda callback, *args: scheduled.append((callback, args))
    )
    body = developer.DeveloperTaskCreateIn(
        task_type="csv_to_json",
        input_kind="archive",
        input_ref="v8/account-7/input/archive.zip",
        idempotency_key="archive-once",
        budget=Decimal("1"),
    )
    request = SimpleNamespace(
        client=SimpleNamespace(host="127.0.0.1"),
        state=SimpleNamespace(trace_id="trace"),
    )
    current = SimpleNamespace(id=7, is_admin=False)

    await developer.create_developer_task(
        body,
        request,
        bg,
        current,
        SimpleNamespace(),
    )

    assert captured["spec"]["input_kind"] == "archive"
    assert captured["spec"]["input_ref"] == "v8/account-7/input/archive.zip"
    assert scheduled == [
        (developer._start_workload, (workload.id,))
    ]
