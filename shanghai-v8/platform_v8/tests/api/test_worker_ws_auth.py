"""Offline Worker WS authorization checks against a real SQLite login session."""
from __future__ import annotations

import asyncio
import hashlib
from contextlib import contextmanager
from datetime import datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketDisconnect, WebSocketState

from platform_v8.api.v8 import ws as worker_ws_mod
from platform_v8.engine import broker, gateway, lifecycle
from platform_v8.core import WorkerStatus
from platform_v8.protocol import ws_schema
from platform_v8.services.auth import revocation, token
from platform_v8.services.workers import native_h3_bindings
from platform_v8.storage import db
from platform_v8.storage.repo import AccountRepo, AuthSessionRepo, WorkerRepo, create_all_for_testing


class FakeWorkerSocket:
    def __init__(self, access_token: str, *, worker_id: str | None = None):
        self.headers = {"sec-websocket-protocol": ws_schema.SUBPROTOCOL}
        self.application_state = WebSocketState.CONNECTING
        self.sent: list[dict] = []
        self.close_code: int | None = None
        self.closed = asyncio.Event()
        self.frames: asyncio.Queue[str | None] = asyncio.Queue()
        self.feed(ws_schema.Hello(payload=ws_schema.HelloPayload(
            client_version="8.0.0", os="test", worker_id=worker_id,
        )).model_dump_json())
        self.feed(ws_schema.Auth(payload=ws_schema.AuthPayload(
            access_token=access_token, name="offline test node",
        )).model_dump_json())

    def feed(self, frame: str | None) -> None:
        self.frames.put_nowait(frame)

    async def accept(self, *, subprotocol: str | None = None) -> None:
        self.application_state = WebSocketState.CONNECTED

    async def receive_text(self) -> str:
        frame = await self.frames.get()
        if frame is None:
            raise WebSocketDisconnect(code=1000)
        return frame

    async def send_text(self, raw: str) -> None:
        import json
        self.sent.append(json.loads(raw))

    async def close(self, *, code: int = 1000, reason: str = "") -> None:
        self.close_code = code
        self.application_state = WebSocketState.DISCONNECTED
        self.closed.set()


@pytest.fixture
def auth_state(tmp_path, monkeypatch):
    monkeypatch.setenv("V8_JWT_SECRET", "worker-ws-tests-use-a-long-non-production-secret")
    engine = create_engine(
        f"sqlite:///{tmp_path / 'worker-auth.db'}",
        connect_args={"check_same_thread": False},
    )
    create_all_for_testing(engine)
    sid = str(uuid4())
    with Session(engine) as session:
        account = AccountRepo.create(
            session, username="worker-test", email="worker-test@example.com",
            password_hash="not-used-in-this-test",
        )
        AuthSessionRepo.create(
            session, session_id=sid, account_id=account.id,
            device_id=None, device_name="test", device_type="desktop",
            browser="test", os_name="test", user_agent="test", client_ip=None,
        )
        pair = token.issue_token_pair(
            account_id=account.id, role="personal", session_id=sid,
        )
        refresh = token.verify_token(pair.refresh_token, expected_kind="refresh")
        assert AuthSessionRepo.initialize_refresh(
            session, sid, account.id,
            refresh_jti_hash=hashlib.sha256(refresh.jti.encode()).hexdigest(),
            refresh_expires_at=datetime.utcfromtimestamp(refresh.exp),
        )
        session.commit()
        account_id = account.id

    @contextmanager
    def _scope():
        with Session(engine) as session:
            yield session

    revoked_jtis: set[str] = set()
    monkeypatch.setattr(db, "session_scope", _scope)
    monkeypatch.setattr(
        revocation, "is_jti_revoked", lambda jti: jti in revoked_jtis,
    )
    try:
        yield SimpleNamespace(
            engine=engine, account_id=account_id, sid=sid,
            pair=pair, revoked_jtis=revoked_jtis,
        )
    finally:
        engine.dispose()


@pytest.fixture
def worker_stubs(monkeypatch, auth_state):
    worker_id = str(uuid4())
    current: dict[str, object] = {}
    registered = asyncio.Event()
    offline: list[str] = []
    heartbeat: list[str] = []
    register_calls: list[str] = []
    recover_calls: list[str] = []

    def _register(_session, inp):
        register_calls.append(inp.worker_id)
        return SimpleNamespace(id=inp.worker_id, owner_id=auth_state.account_id)

    async def _register_session(wid, socket, **kwargs):
        assert kwargs["recover"] is False
        current["metadata"] = SimpleNamespace(
            ws=socket, connection_id=kwargs["connection_id"],
        )

    async def _resume_session(wid, socket):
        recover_calls.append(wid)

    async def _unregister_session(wid, socket):
        metadata = current.get("metadata")
        if metadata is None or metadata.ws is not socket:
            return False
        current.pop("metadata")
        return True

    async def _fire_online(_wid, _owner):
        registered.set()
        return None

    monkeypatch.setattr(worker_ws_mod.register_svc, "register_worker", _register)
    monkeypatch.setattr(worker_ws_mod.broker_mod, "register_session", _register_session)
    monkeypatch.setattr(worker_ws_mod.broker_mod, "resume_session", _resume_session)
    monkeypatch.setattr(worker_ws_mod.broker_mod, "unregister_session", _unregister_session)
    monkeypatch.setattr(
        worker_ws_mod.broker_mod, "get_session_metadata",
        lambda _wid: current.get("metadata"),
    )
    monkeypatch.setattr(worker_ws_mod.registry_mod, "invalidate_cache", lambda **_kw: None)
    monkeypatch.setattr(worker_ws_mod.registry_mod, "fire_worker_online", _fire_online)
    monkeypatch.setattr(worker_ws_mod.gateway_mod, "multi_enabled", lambda: False)
    monkeypatch.setattr(native_h3_bindings, "observe_connection", lambda *_a, **_kw: False)
    monkeypatch.setattr(
        worker_ws_mod.hb_svc, "mark_offline",
        lambda _s, wid, **_kw: offline.append(wid),
    )
    monkeypatch.setattr(
        worker_ws_mod.hb_svc, "heartbeat",
        lambda _s, wid, **_kw: heartbeat.append(wid),
    )
    return SimpleNamespace(
        worker_id=worker_id, current=current, registered=registered,
        offline=offline, heartbeat=heartbeat, register_calls=register_calls,
        recover_calls=recover_calls,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["refresh", "agent", "user", "sidless", "revoked_jti", "revoked_session"])
async def test_worker_ws_rejects_non_access_or_revoked_credentials(
    kind, auth_state, worker_stubs,
):
    access = auth_state.pair.access_token
    if kind == "refresh":
        access = auth_state.pair.refresh_token
    elif kind in {"agent", "user"}:
        access = token._sign(
            account_id=auth_state.account_id, role="personal", kind=kind,
            ttl_s=900, session_id=auth_state.sid,
        )
    elif kind == "sidless":
        access = token.issue_token_pair(
            account_id=auth_state.account_id, role="personal",
        ).access_token
    elif kind == "revoked_jti":
        auth_state.revoked_jtis.add(token.verify_token(access).jti)
    elif kind == "revoked_session":
        with Session(auth_state.engine) as session:
            assert AuthSessionRepo.revoke(session, auth_state.sid, auth_state.account_id)
            session.commit()

    socket = FakeWorkerSocket(access, worker_id=worker_stubs.worker_id)
    await worker_ws_mod.worker_ws(socket)

    assert socket.close_code == 4401
    assert socket.sent[-1]["type"] == "err"
    assert worker_stubs.register_calls == []
    assert worker_stubs.current == {}


@pytest.mark.asyncio
async def test_worker_ws_access_registers_then_idle_session_revoke_closes(
    auth_state, worker_stubs, monkeypatch,
):
    monkeypatch.setattr(worker_ws_mod, "AUTH_RECHECK_S", 0.02)
    socket = FakeWorkerSocket(
        auth_state.pair.access_token, worker_id=worker_stubs.worker_id,
    )
    task = asyncio.create_task(worker_ws_mod.worker_ws(socket))
    await asyncio.wait_for(worker_stubs.registered.wait(), timeout=2)
    assert any(frame["type"] == "auth_ok" for frame in socket.sent)
    assert worker_stubs.register_calls == [worker_stubs.worker_id]

    with Session(auth_state.engine) as session:
        assert AuthSessionRepo.revoke(session, auth_state.sid, auth_state.account_id)
        session.commit()
    await asyncio.wait_for(socket.closed.wait(), timeout=2)
    await asyncio.wait_for(task, timeout=2)

    assert socket.close_code == 4401
    assert worker_stubs.offline == []  # heartbeat reaper owns DB offline state


@pytest.mark.asyncio
async def test_revoked_jti_cannot_submit_heartbeat_on_existing_socket(
    auth_state, worker_stubs,
):
    socket = FakeWorkerSocket(
        auth_state.pair.access_token, worker_id=worker_stubs.worker_id,
    )
    task = asyncio.create_task(worker_ws_mod.worker_ws(socket))
    await asyncio.wait_for(worker_stubs.registered.wait(), timeout=2)
    auth_state.revoked_jtis.add(token.verify_token(auth_state.pair.access_token).jti)
    socket.feed(ws_schema.Hb(payload=ws_schema.HbPayload()).model_dump_json())
    await asyncio.wait_for(task, timeout=2)

    assert socket.close_code == 4401
    assert worker_stubs.heartbeat == []


@pytest.mark.asyncio
async def test_auth_recheck_outage_fails_closed_before_heartbeat(
    auth_state, worker_stubs, monkeypatch,
):
    socket = FakeWorkerSocket(
        auth_state.pair.access_token, worker_id=worker_stubs.worker_id,
    )
    task = asyncio.create_task(worker_ws_mod.worker_ws(socket))
    await asyncio.wait_for(worker_stubs.registered.wait(), timeout=2)

    def _unavailable(*_args):
        raise RuntimeError("offline test database unavailable")

    monkeypatch.setattr(worker_ws_mod, "_validate_connected_worker_access", _unavailable)
    socket.feed(ws_schema.Hb(payload=ws_schema.HbPayload()).model_dump_json())
    await asyncio.wait_for(task, timeout=2)

    assert socket.close_code == 1011
    assert worker_stubs.heartbeat == []


@pytest.mark.asyncio
async def test_revocation_during_registration_prevents_recovery(
    auth_state, worker_stubs, monkeypatch,
):
    original = worker_ws_mod.broker_mod.register_session

    async def _register_then_revoke(wid, socket, **kwargs):
        await original(wid, socket, **kwargs)
        auth_state.revoked_jtis.add(token.verify_token(auth_state.pair.access_token).jti)

    monkeypatch.setattr(worker_ws_mod.broker_mod, "register_session", _register_then_revoke)
    socket = FakeWorkerSocket(
        auth_state.pair.access_token, worker_id=worker_stubs.worker_id,
    )
    await worker_ws_mod.worker_ws(socket)

    assert socket.close_code == 4401
    assert worker_stubs.recover_calls == []


@pytest.mark.asyncio
async def test_reconnected_socket_replaces_old_without_marking_worker_offline(
    auth_state, worker_stubs,
):
    old = FakeWorkerSocket(
        auth_state.pair.access_token, worker_id=worker_stubs.worker_id,
    )
    old_task = asyncio.create_task(worker_ws_mod.worker_ws(old))
    await asyncio.wait_for(worker_stubs.registered.wait(), timeout=2)
    worker_stubs.registered.clear()

    new = FakeWorkerSocket(
        auth_state.pair.access_token, worker_id=worker_stubs.worker_id,
    )
    new_task = asyncio.create_task(worker_ws_mod.worker_ws(new))
    await asyncio.wait_for(worker_stubs.registered.wait(), timeout=2)
    old.feed(ws_schema.Hb(payload=ws_schema.HbPayload()).model_dump_json())
    await asyncio.wait_for(old_task, timeout=2)

    assert old.close_code == 4409
    assert worker_stubs.heartbeat == []
    assert worker_stubs.offline == []
    assert worker_stubs.current["metadata"].ws is new

    new.feed(None)
    await asyncio.wait_for(new_task, timeout=2)
    assert worker_stubs.offline == []


@pytest.mark.asyncio
async def test_cross_gateway_replacement_rejects_old_socket(
    auth_state, worker_stubs, monkeypatch,
):
    shared_id: dict[str, str] = {}

    def _observe(_wid, *, owner_id, connection_id):
        shared_id["current"] = connection_id
        return True

    monkeypatch.setattr(native_h3_bindings, "observe_connection", _observe)
    monkeypatch.setattr(
        native_h3_bindings, "current_connection_id",
        lambda *_args, **_kwargs: shared_id.get("current"),
    )
    monkeypatch.setattr(
        native_h3_bindings, "close_connection", lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(worker_ws_mod.gateway_mod, "multi_enabled", lambda: True)

    socket = FakeWorkerSocket(
        auth_state.pair.access_token, worker_id=worker_stubs.worker_id,
    )
    task = asyncio.create_task(worker_ws_mod.worker_ws(socket))
    await asyncio.wait_for(worker_stubs.registered.wait(), timeout=2)
    shared_id["current"] = str(uuid4())
    socket.feed(ws_schema.Hb(payload=ws_schema.HbPayload()).model_dump_json())
    await asyncio.wait_for(task, timeout=2)

    assert socket.close_code == 4409
    assert worker_stubs.heartbeat == []
    assert worker_stubs.offline == []


@pytest.mark.asyncio
async def test_multi_gateway_refuses_unrecorded_worker_connection(
    auth_state, worker_stubs, monkeypatch,
):
    monkeypatch.setattr(worker_ws_mod.gateway_mod, "multi_enabled", lambda: True)
    socket = FakeWorkerSocket(
        auth_state.pair.access_token, worker_id=worker_stubs.worker_id,
    )
    await worker_ws_mod.worker_ws(socket)

    assert socket.close_code == 1011
    assert worker_stubs.current == {}
    assert worker_stubs.offline == []
    assert worker_stubs.recover_calls == []


@pytest.mark.asyncio
async def test_broker_unregister_reports_superseded_socket(monkeypatch):
    worker_id = str(uuid4())
    old = object()
    new = object()
    monkeypatch.setattr(gateway, "multi_enabled", lambda: False)
    spawned = []
    def _unexpected_spawn(coro):
        spawned.append(coro)
        coro.close()
    monkeypatch.setattr(broker, "_spawn", _unexpected_spawn)
    broker._ws_sessions[worker_id] = new
    try:
        assert await broker.unregister_session(worker_id, old) is False
        assert broker._ws_sessions[worker_id] is new
        assert await broker.unregister_session(worker_id, new) is True
        assert worker_id not in broker._ws_sessions
        assert spawned == []  # no unsafe instant shard reclaim
    finally:
        broker._ws_sessions.pop(worker_id, None)
        broker._ws_session_metadata.pop(worker_id, None)


def test_gateway_owner_clear_is_connection_specific(monkeypatch):
    """An old socket must not delete a newer socket on the same gateway."""
    class FakeRedis:
        def __init__(self):
            self.values = {}

        def hset(self, key, field, value):
            self.values[(key, field)] = value

        def hget(self, key, field):
            return self.values.get((key, field))

        def eval(self, _script, _keys, key, field, expected):
            if self.hget(key, field) == expected:
                self.values.pop((key, field), None)
                return 1
            return 0

    fake = FakeRedis()
    monkeypatch.setattr(gateway, "_redis", lambda: fake)
    monkeypatch.setattr(gateway, "gateway_id", lambda: "test-gateway")
    worker_id = str(uuid4())
    old, new = str(uuid4()), str(uuid4())

    gateway.set_owner(worker_id, connection_id=old)
    gateway.set_owner(worker_id, connection_id=new)
    gateway.clear_owner(worker_id, connection_id=old)
    assert gateway.get_owner(worker_id) == "test-gateway"
    gateway.clear_owner(worker_id, connection_id=new)
    assert gateway.get_owner(worker_id) is None


@pytest.mark.asyncio
async def test_real_broker_registration_keeps_new_gateway_owner(monkeypatch):
    """Exercise the broker's actual register/unregister path with Redis CAS."""
    class FakeRedis:
        def __init__(self):
            self.values = {}

        def hset(self, key, field, value):
            self.values[(key, field)] = value

        def hget(self, key, field):
            return self.values.get((key, field))

        def eval(self, _script, _keys, key, field, expected):
            if self.hget(key, field) == expected:
                self.values.pop((key, field), None)
                return 1
            return 0

    fake = FakeRedis()
    monkeypatch.setattr(gateway, "_redis", lambda: fake)
    monkeypatch.setattr(gateway, "multi_enabled", lambda: True)
    monkeypatch.setattr(gateway, "gateway_id", lambda: "gateway-A")
    monkeypatch.setattr(broker, "_spawn", lambda coro: coro.close())
    worker_id, old_id, new_id = str(uuid4()), str(uuid4()), str(uuid4())
    old, new = object(), object()
    try:
        await broker.register_session(worker_id, old, connection_id=old_id, recover=False)
        await broker.register_session(worker_id, new, connection_id=new_id, recover=False)
        assert await broker.unregister_session(worker_id, old) is False
        assert gateway.get_owner(worker_id) == "gateway-A"
        assert await broker.unregister_session(worker_id, new) is True
        assert gateway.get_owner(worker_id) is None
    finally:
        broker._ws_sessions.pop(worker_id, None)
        broker._ws_session_metadata.pop(worker_id, None)


@pytest.mark.asyncio
async def test_broker_refuses_outbound_work_on_superseded_gateway_socket(monkeypatch):
    class OutboundSocket:
        def __init__(self):
            self.sent = []

        async def send_text(self, frame):
            self.sent.append(frame)

    worker_id, old_id, new_id = str(uuid4()), str(uuid4()), str(uuid4())
    socket = OutboundSocket()
    monkeypatch.setattr(gateway, "multi_enabled", lambda: True)
    monkeypatch.setattr(gateway, "set_owner", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gateway, "clear_owner", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        native_h3_bindings, "current_connection_id", lambda _wid: new_id,
    )
    async def _noop(*_args):
        return None
    monkeypatch.setattr(broker, "_recover_pending_shards", _noop)
    monkeypatch.setattr(broker, "_retry_waiting_workloads", _noop)
    try:
        await broker.register_session(
            worker_id, socket, connection_id=old_id, recover=False,
        )
        await broker.resume_session(worker_id, socket)
        assert await broker._local_send(worker_id, '{"type":"shard_assign"}') is False
        assert socket.sent == []
        assert worker_id not in broker._ws_sessions
    finally:
        broker._ws_sessions.pop(worker_id, None)
        broker._ws_session_metadata.pop(worker_id, None)
        broker._ws_session_ready.pop(worker_id, None)


@pytest.mark.asyncio
async def test_broker_does_not_dispatch_before_post_registration_auth(monkeypatch):
    class OutboundSocket:
        def __init__(self):
            self.sent = []

        async def send_text(self, frame):
            self.sent.append(frame)

    worker_id = str(uuid4())
    socket = OutboundSocket()
    monkeypatch.setattr(gateway, "multi_enabled", lambda: False)
    async def _noop(*_args):
        return None
    monkeypatch.setattr(broker, "_recover_pending_shards", _noop)
    monkeypatch.setattr(broker, "_retry_waiting_workloads", _noop)
    try:
        await broker.register_session(
            worker_id, socket, connection_id=str(uuid4()), recover=False,
        )
        assert await broker._local_send(worker_id, '{"type":"shard_assign"}') is False
        assert socket.sent == []
        await broker.resume_session(worker_id, socket)
        assert await broker._local_send(worker_id, '{"type":"shard_assign"}') is True
        assert socket.sent == ['{"type":"shard_assign"}']
    finally:
        broker._ws_sessions.pop(worker_id, None)
        broker._ws_session_metadata.pop(worker_id, None)
        broker._ws_session_ready.pop(worker_id, None)


def test_shared_connection_close_preserves_replacement_online_score(monkeypatch):
    """The real native close function must delete key and score in one CAS."""
    class FakeRedis:
        def __init__(self):
            self.values = {}
            self.online = set()
            self.eval_calls = 0

        def set(self, key, value, *, ex):
            self.values[key] = value
            return True

        def eval(self, script, numkeys, connection_key, online_key, expected, worker_id):
            self.eval_calls += 1
            assert numkeys == 2
            assert online_key == "v8:worker:hb"
            assert "ZREM" in script and "DEL" in script
            if self.values.get(connection_key) != expected:
                return 0
            self.online.discard(worker_id)
            self.values.pop(connection_key, None)
            return 1

    fake = FakeRedis()
    monkeypatch.setattr(native_h3_bindings, "_connection_redis", lambda: fake)
    worker_id, old, new = str(uuid4()), str(uuid4()), str(uuid4())
    assert native_h3_bindings.observe_connection(worker_id, owner_id=1, connection_id=old)
    fake.online.add(worker_id)
    assert native_h3_bindings.observe_connection(worker_id, owner_id=1, connection_id=new)
    assert not native_h3_bindings.close_connection(worker_id, owner_id=1, connection_id=old)
    assert worker_id in fake.online
    assert native_h3_bindings.close_connection(worker_id, owner_id=1, connection_id=new)
    assert worker_id not in fake.online
    assert fake.eval_calls == 2


@pytest.mark.asyncio
async def test_queued_reclaim_skips_same_process_reconnect(monkeypatch):
    worker_id = str(uuid4())
    broker._ws_sessions[worker_id] = object()
    monkeypatch.setattr(gateway, "get_owner", lambda _wid: None)
    monkeypatch.setattr(db, "session_scope", lambda: pytest.fail("reclaim queried DB"))
    try:
        await broker._reclaim_offline_worker_shards(worker_id)
    finally:
        broker._ws_sessions.pop(worker_id, None)


@pytest.mark.asyncio
async def test_queued_reclaim_skips_new_shared_connection(monkeypatch):
    worker_id, old, new = str(uuid4()), str(uuid4()), str(uuid4())
    monkeypatch.setattr(gateway, "get_owner", lambda _wid: None)
    monkeypatch.setattr(db, "session_scope", lambda: pytest.fail("reclaim queried DB"))
    monkeypatch.setattr(
        native_h3_bindings, "current_connection_id", lambda _wid: new,
    )
    await broker._reclaim_offline_worker_shards(worker_id, connection_id=old)


@pytest.mark.asyncio
async def test_reaper_cas_preserves_worker_reconnected_after_stale_scan(
    auth_state, monkeypatch,
):
    worker_id = str(uuid4())
    with Session(auth_state.engine) as session:
        WorkerRepo.upsert(
            session, worker_id=worker_id, owner_id=auth_state.account_id,
            name="freshly reconnected", capabilities={}, status=WorkerStatus.ONLINE,
        )
        session.commit()

    @contextmanager
    def _racing_scope():
        with Session(auth_state.engine) as session:
            class RacingSession:
                first = True

                def execute(self, statement, *args, **kwargs):
                    if self.first:
                        self.first = False
                        # SELECT saw an old row; by UPDATE time the stored row
                        # has already been refreshed by a new registration.
                        return SimpleNamespace(all=lambda: [SimpleNamespace(
                            id=worker_id, owner_id=auth_state.account_id,
                        )])
                    return session.execute(statement, *args, **kwargs)

                def commit(self):
                    session.commit()

            yield RacingSession()

    monkeypatch.setattr(db, "session_scope", _racing_scope)
    result = await lifecycle.reap_stale_workers(ttl_seconds=60)
    assert result == {"reaped": 0}
    with Session(auth_state.engine) as session:
        assert WorkerRepo.by_id(session, worker_id).status is WorkerStatus.ONLINE
