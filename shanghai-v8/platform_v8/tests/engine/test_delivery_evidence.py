from __future__ import annotations

import asyncio
from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest

from platform_v8.engine import broker
from platform_v8.protocol import ws_schema as wsp
from platform_v8.storage.repo import AssignmentDeliveryRepo


class _WebSocket:
    def __init__(self, *, fail: bool = False):
        self.fail = fail
        self.sent: list[str] = []

    async def send_text(self, frame: str) -> None:
        if self.fail:
            raise RuntimeError("socket closed")
        self.sent.append(frame)


@pytest.fixture(autouse=True)
def _clean_sessions():
    broker._ws_sessions.clear()
    broker._ws_session_metadata.clear()
    broker._ws_session_ready.clear()
    yield
    broker._ws_sessions.clear()
    broker._ws_session_metadata.clear()
    broker._ws_session_ready.clear()


def _install_session(ws: _WebSocket, *, connection_id: str = "connection-1"):
    broker._ws_sessions["worker-1"] = ws
    broker._ws_session_ready["worker-1"] = ws
    broker._ws_session_metadata["worker-1"] = broker.WorkerSessionMetadata(
        ws=ws,
        connection_id=connection_id,
        client_version="8.0.9",
        client_build="legacy-build",
        protocol_capabilities=("legacy-result",),
        protocol_mode="legacy",
    )


def _payload(*, shard_id: str = "shard-1", attempt: int = 3):
    return wsp.ShardAssignPayload(
        shard_id=shard_id,
        workload_id="workload-1",
        attempt=attempt,
        task_type="noop",
    )


@pytest.mark.parametrize(
    ("source", "frame", "expected_mode"),
    [
        ("dispatch", wsp.ShardAssign(payload=_payload()).model_dump_json(), "push"),
        (
            "pull",
            wsp.build_pull_assign(shards=[_payload()]),
            "pull",
        ),
        ("race", wsp.ShardAssign(payload=_payload()).model_dump_json(), "race"),
        (
            "recover",
            wsp.ShardAssign(payload=_payload()).model_dump_json(),
            "recovery",
        ),
    ],
)
def test_all_assignment_send_paths_record_after_socket_success(
    monkeypatch, source, frame, expected_mode,
):
    ws = _WebSocket()
    _install_session(ws)
    recorded: list[dict] = []

    @contextmanager
    def _scope():
        session = MagicMock()
        yield session

    def _record(_session, **kwargs):
        assert ws.sent
        recorded.append(kwargs)
        return MagicMock()

    monkeypatch.setattr(broker.db_mod, "session_scope", _scope)
    monkeypatch.setattr(AssignmentDeliveryRepo, "record_after_send", _record)

    assert asyncio.run(
        broker.push_to_worker("worker-1", frame, source=source)
    )
    assert len(recorded) == 1
    assignment_manifest = recorded[0].pop("assignment_manifest")
    assert recorded[0] == {
        "shard_id": "shard-1",
        "workload_id": "workload-1",
        "worker_id": "worker-1",
        "attempt": 3,
        "connection_id": "connection-1",
        "mode": expected_mode,
        "client_version": "8.0.9",
        "client_build": "legacy-build",
        "protocol_capabilities": ("legacy-result",),
    }
    assert assignment_manifest == {
        "task_type": "noop",
        "input_kind": "single_file",
        "input_manifest": {},
        "input_refs_count": 0,
        "executor": "",
        "code_url_present": False,
        "capability_profile": "legacy_inline",
    }


def test_cross_gateway_local_delivery_records_receiver_connection(monkeypatch):
    """The gateway subscriber records evidence where send_text really succeeds."""
    ws = _WebSocket()
    _install_session(ws, connection_id="receiver-connection")
    recorded: list[dict] = []

    @contextmanager
    def _scope():
        yield MagicMock()

    monkeypatch.setattr(broker.db_mod, "session_scope", _scope)
    monkeypatch.setattr(
        AssignmentDeliveryRepo,
        "record_after_send",
        lambda _session, **kwargs: recorded.append(kwargs),
    )

    frame = wsp.build_pull_assign(shards=[
        _payload(shard_id="shard-cross-gateway", attempt=4),
    ])
    assert asyncio.run(
        broker._local_send(
            "worker-1",
            frame,
            idem_key="shard-cross-gateway",
            source="pull",
        )
    )
    assert ws.sent == [frame]
    assert len(recorded) == 1
    assert recorded[0]["connection_id"] == "receiver-connection"
    assert recorded[0]["shard_id"] == "shard-cross-gateway"
    assert recorded[0]["attempt"] == 4
    assert recorded[0]["mode"] == "pull"


def test_send_failure_never_records(monkeypatch):
    ws = _WebSocket(fail=True)
    _install_session(ws)
    recorded = MagicMock()
    monkeypatch.setattr(AssignmentDeliveryRepo, "record_after_send", recorded)
    monkeypatch.setattr(broker, "unregister_session", AsyncMock())

    assert not asyncio.run(
        broker.push_to_worker(
            "worker-1",
            wsp.ShardAssign(payload=_payload()).model_dump_json(),
            source="dispatch",
        )
    )
    recorded.assert_not_called()


def test_missing_server_connection_context_fails_closed(monkeypatch):
    ws = _WebSocket()
    broker._ws_sessions["worker-1"] = ws
    recorded = MagicMock()
    monkeypatch.setattr(AssignmentDeliveryRepo, "record_after_send", recorded)

    assert not asyncio.run(
        broker.push_to_worker(
            "worker-1",
            wsp.ShardAssign(payload=_payload()).model_dump_json(),
            source="dispatch",
        )
    )
    recorded.assert_not_called()
