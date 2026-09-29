"""Isolated HTTP + SQLite receipts. Fixture prices/devices are not official supply."""
from __future__ import annotations
import base64
import json
import threading
import time
from contextlib import contextmanager
from copy import deepcopy
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, func, update
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from platform_v8.api.deps import get_current_account, get_session as api_get_session
from platform_v8.api.v8 import economy, workloads, media
from platform_v8.core import AccountRole
from platform_v8.storage import db
from platform_v8.storage.repo import (AccountRepo, WorkerRepo, WorkloadRepo, create_all_for_testing,
                                    ledger_t, accounts_t, workers_t, workloads_t, ShardRepo)
from platform_v8.core import Shard, ShardStatus
from platform_v8.storage.media_repo import MediaRepo, attempts_t, requests_t, settlements_t, outbox_t
from platform_v8.services import media_channel as channel, media_profiles
from platform_v8.services import media_storage
from platform_v8.services.economy import ledger, split
from platform_v8.services.workloads.submit import submit_workload, SubmitInput, SubmitWorkloadError


@pytest.fixture
def rig(tmp_path, monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    create_all_for_testing(engine)
    @contextmanager
    def sessions():
        with Session(engine, expire_on_commit=False) as s:
            try:
                yield s
                s.commit()
            except Exception:
                s.rollback()
                raise
    monkeypatch.setattr(db, "session_scope", sessions)
    monkeypatch.setenv("V8_JWT_SECRET", "fixture-ticket-secret-for-isolated-tests-123456789")
    monkeypatch.setenv("V8_MEDIA_RESULT_BUCKET", "fixture-media-1234")
    keys = {}
    for role, prefix in (("gateway", "V8_MEDIA_GUANGZHOU"), ("catalog", "V8_MEDIA_CATALOG"),
                         ("upload", "V8_MEDIA_UPLOAD"), ("order", "V8_MEDIA_ORDER"),
                         ("authorization", "V8_MEDIA_AUTHORIZATION"), ("viewer", "V8_MEDIA_VIEWER")):
        key = Ed25519PrivateKey.generate()
        keys[role] = key
        private = tmp_path / (role + ".key")
        private.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                             serialization.NoEncryption()))
        private.chmod(0o600)
        public = tmp_path / (role + ".pub")
        public.write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
        monkeypatch.setenv(prefix + "_KEY_ID", "fixture-" + role)
        monkeypatch.setenv(prefix + "_PRIVATE_KEY_FILE", str(private))
        monkeypatch.setenv(prefix + "_PUBLIC_KEY_FILE", str(public))
    token = tmp_path / "service.token"
    token.write_text("fixture-service-auth-only-12345678901234567890")
    token.chmod(0o600)
    monkeypatch.setenv("V8_MEDIA_SERVICE_TOKEN_FILE", str(token))
    monkeypatch.setenv("V8_MEDIA_SERVICE_INBOUND_TOKEN_FILE", str(token))
    monkeypatch.setenv("V8_MEDIA_STORAGE_WRITE_SERVICE_INBOUND_TOKEN_FILE", str(token))
    monkeypatch.setenv("V8_MEDIA_STORAGE_READ_SERVICE_INBOUND_TOKEN_FILE", str(token))
    monkeypatch.setattr(media_storage, "_primary", lambda: SimpleNamespace())
    profile = {"profile_id": "fixture.video.fast", "profile_version": 1, "capability": "video",
        "mode": "text_to_video", "quality": "fast", "orientation": "landscape", "width": 1344, "height": 768,
        "steps": 4, "fps": 24, "allowed_seconds": [3, 5], "input_roles": [], "max_assets": 0,
        "model_id": "fixture-model", "model_sha256": "a" * 64, "workflow_id": "fixture-workflow",
        "workflow_sha256": "b" * 64, "validation_receipt_sha256": "c" * 64,
        "min_vram_mb": 8192, "min_memory_mb": 16384, "timeout_s": 900,
        "price_version": 1, "price_unit": "second", "unit_price_yuan": "0.50", "min_charge_yuan": "0.10", "enabled": True}
    spec = {"task_type": "video_generate", "input_kind": "params_only", "media_input": {
        "capability": "video", "mode": "text_to_video", "quality": "fast", "orientation": "landscape",
        "seconds": 5, "prompt": "fixture untouched prompt", "negative_prompt": "", "assets": [],
        "profile_id": profile["profile_id"], "profile_version": 1}}
    with sessions() as s:
        platform = AccountRepo.create(s, username="fixture-platform", email="p@fixture.test", password_hash="fixture", role=AccountRole.ADMIN)
        buyer = AccountRepo.create(s, username="fixture-buyer", email="b@fixture.test", password_hash="fixture")
        owner = AccountRepo.create(s, username="fixture-owner", email="o@fixture.test", password_hash="fixture")
        ledger.deposit(s, account_id=buyer.id, amount=Decimal("20"), idempotent_key="fixture-initial-deposit")
        worker_id = str(uuid4())
        WorkerRepo.upsert(s, worker_id=worker_id, owner_id=owner.id, name="fixture verified device",
            capabilities={"gpu_count": 1, "gpu_model": "fixture RTX 4060", "vram_mb": 8192,
                "total_memory_mb": 16384, "contribute_mode": "active", "throttle_pct": 100})
        now = int(time.time())
        identity = {k: profile[k] for k in channel.IDENTITY}
        binding = {**identity, "worker_id": worker_id, "owner_id": owner.id,
            "device_id": "fixture-device", "gateway_owner_id": str(owner.id), "enabled": True,
            "gpu_model": "fixture RTX 4060", "vram_mb": 8192,
            "hardware_qualification": "rtx_4060_or_better_verified", "p90_execution_seconds": 100,
            "max_concurrent": 1, "max_task_seconds": 900, "authorized_until": now + 3600, "verified_until": now + 3600}
        channel.kv_set(s, media_profiles.DEVICE_BINDINGS_KEY, [binding])
        channel.kv_set(s, "economy:settings:v1", {"version": 1, "media_profiles": [profile]})
    monkeypatch.setattr(split, "load_config_from_env", lambda: split.SplitConfig(platform_account_id=platform.id))
    state = {"dispatches": [], "tasks": {}, "events": [], "settlements": [], "ack": 0,
             "drop_dispatch_reply": False, "drop_task_reply": False, "drop_settlement_reply": False,
             "ready": True, "catalog_profiles": [profile], "catalog_version": 1, "verified_requests": [],
             "qualified_profiles": [{**identity, "deviceId": "fixture-device", "ownerId": str(owner.id),
                "executor_sha256": "d" * 64, "worker_id": worker_id, "authorized_until": now + 3600,
                "verified_until": now + 3600, "p90_execution_seconds": 100, "max_task_seconds": 900,
                "gpu_model": "fixture RTX 4060", "vram_mb": 8192, "total_memory_mb": 16384,
                "max_concurrent": 1, "hardware_qualification": "rtx_4060_or_better_verified"}]}
    def signed(payload, role="gateway"):
        return {"key_id": "fixture-" + role, "payload": payload,
            "signature": base64.urlsafe_b64encode(keys[role].sign(channel.canonical(payload))).rstrip(b"=").decode()}
    node = {"deviceId": "fixture-device", "ownerId": str(owner.id), "capabilityRevision": "fixture-capability-v1",
        "connectionEpoch": 1, "online": True, "media_exchange_ready": True,
        "media_profiles": [identity], "free_vram_mb": 8192, "max_media_concurrent": 1,
        "media_available_seconds": 900, "freeSlots": 1}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            if self.headers.get("Authorization") != "Bearer " + token.read_text():
                self.send_error(401)
                return
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            route = self.path.removeprefix("/internal/media/")
            now = int(time.time())
            if route == "profiles":
                response = {"catalog": signed({"schema": "qianshou.formal-media-catalog.v1",
                    "purpose": "qianshou:formal-media-catalog", "nonce": body["nonce"],
                    "catalog_version": state["catalog_version"], "profiles": state["catalog_profiles"],
                    "issued_at": now, "expires_at": now + 300}, "catalog")}
            elif route == "devices/verified":
                response = {"qualification": signed({"schema": "qianshou.formal-media-directory-qualification.v1",
                    "purpose": "qianshou:formal-media-directory-qualification", "nonce": body["nonce"],
                    "profiles": state["qualified_profiles"], "issued_at": now, "expires_at": now + 30})}
            elif route == "preflight":
                response = {"preflight": signed({"schema": "qianshou.formal-media-preflight.v1",
                    "purpose": "qianshou:formal-media-preflight", "nonce": body["nonce"],
                    "status": "ready" if state["ready"] else "unavailable", "bucket": "fixture-media-1234",
                    "profiles": [{k: p[k] for k in channel.IDENTITY} for p in state["catalog_profiles"]],
                    "features": {k: state["ready"] for k in channel.FEATURES},
                    "missing_integrations": [], "issued_at": now, "expires_at": now + 30})}
            elif route == "nodes":
                response = {"ok": True, "nodes": [node]}
            elif route == "dispatch":
                state["dispatches"].append(body)
                state["tasks"][body["taskId"]] = deepcopy(body)
                if state["drop_dispatch_reply"]:
                    self.close_connection = True
                    return
                response = {"ok": True, "sequence": len(state["dispatches"])}
            elif route == "task":
                if state["drop_task_reply"]:
                    self.close_connection = True
                    return
                if body["taskId"] not in state["tasks"]:
                    self.send_error(404)
                    return
                response = {"ok": True, "task": state["tasks"][body["taskId"]]}
            elif route == "events/read":
                response = {"ok": True, "events": [e for e in state["events"] if e["sequence"] > body["afterSequence"]][:body["limit"]]}
            elif route == "events/ack":
                state["ack"] = body["sequence"]
                response = {"ok": True}
            elif route == "settlement":
                state["settlements"].append(body)
                state["tasks"][body["taskId"]]["settlement"] = body
                if state["drop_settlement_reply"]:
                    self.close_connection = True
                    return
                response = {"ok": True}
            elif route == "cancel":
                response = {"ok": True}
            elif route == "assets/admit":
                if body["accountId"] != buyer.id or any(a["asset_id"] != "fixture-first" or a["sha256"] != "d" * 64 for a in body["assets"]):
                    self.send_error(403)
                    return
                response = {"admission": signed({"schema": "qianshou.formal-media-assets-admission.v1",
                    "purpose": "qianshou:formal-media-assets-admission", "nonce": body["nonce"],
                    "accountId": body["accountId"], "assets": [{**a, "object_key": "fixture/first.png",
                        "object_version_id": "fixture-input-version", "size_bytes": 1024,
                        "content_type": "image/png", "retention_until": now + 3600} for a in body["assets"]],
                    "issued_at": now, "expires_at": now + 60})}
            elif route == "results/verify":
                state["verified_requests"].append(body)
                response = {"ok": True, "published": True}
            else:
                self.send_error(404)
                return
            raw = channel.canonical(response)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("V8_MEDIA_SERVICE_BASE_URL", f"http://127.0.0.1:{server.server_port}")
    app = FastAPI()
    app.include_router(economy.router)
    app.include_router(workloads.router)
    app.include_router(media.router)
    def session_dep():
        with sessions() as s:
            yield s
    app.dependency_overrides[db.get_session] = session_dep
    app.dependency_overrides[api_get_session] = session_dep
    app.dependency_overrides[get_current_account] = lambda: buyer
    async def no_background(_):
        pass
    monkeypatch.setattr(workloads, "start_submitted_workload", no_background)
    channel.poll_once(session_scope=sessions)
    with TestClient(app) as http:
        yield {"http": http, "sessions": sessions, "spec": spec, "profile": profile,
            "buyer": buyer, "owner": owner, "platform": platform, "worker_id": worker_id,
            "state": state, "signed": signed, "node": node, "binding": binding, "keys": keys,
            "app": app}
    server.shutdown()
    server.server_close()
    engine.dispose()


def submitted(rig, request_id="fixture-request"):
    estimate = rig["http"].post("/api/v8/economy/estimate", json={"spec": rig["spec"]})
    assert estimate.status_code == 200, estimate.text
    quote = estimate.json()
    body = {"request_id": request_id, "name": "fixture video", "spec": rig["spec"],
            "budget": quote["recommended_budget"], "quote_token": quote["quote_token"]}
    response = rig["http"].post("/api/v8/workloads", json=body)
    assert response.status_code == 201, response.text
    return response.json()["id"], body


def result_event(rig, task_id, *, sequence=1, overrides=None, old=False):
    with rig["sessions"]() as s:
        a = MediaRepo.attempt(s, task_id)
        w = WorkloadRepo.by_id(s, task_id)
    now = int(time.time())
    asset_id = str(uuid4())
    object_key = f"v8/account-{w.owner_id}/workload-{task_id}/shard-{a['attempt_id']}/result/{asset_id}/result.mp4"
    payload = {"schema": "qianshou.formal-media-result.v1", "purpose": "qianshou:formal-media-result",
        "taskId": task_id, "attemptId": a["attempt_id"], "deviceId": a["device_id"], "ownerId": str(w.owner_id),
        "leaseEpoch": a["lease_epoch"], "plan_sha256": w.spec.media_profile["plan_sha256"],
        "profile_id": w.spec.media_profile["profile_id"], "profile_version": 1, "status": "verified",
        "resultRevision": "e" * 64, "billableResultRevision": "e" * 64, "assetId": asset_id,
        "file": {"object_key": object_key, "object_version_id": "fixture-version",
            "sha256": "f" * 64, "size_bytes": 1024, "content_type": "video/mp4", "width": 1344,
            "height": 768, "fps_num": 24, "fps_den": 1, "seconds_ms": 5000},
        "reason": None, "issued_at": now - 120 if old else now, "expires_at": now - 60 if old else now + 300}
    payload.update(overrides or {})
    with rig["sessions"]() as s:
        media_storage._freeze(s, "result:" + a["attempt_id"], {"account_id": w.owner_id, "asset_id": asset_id,
            "purpose": "result", "object_key": object_key, "sha256": "f" * 64, "size_bytes": 1024,
            "content_type": "video/mp4", "declaration": {"fixture": True}, "retention_until": now + 172800},
            version="fixture-version")
    envelope = rig["signed"](payload)
    rig["state"]["tasks"][task_id]["verdict"] = envelope
    return {"sequence": sequence, "source": "verdict", "deviceId": a["device_id"], "taskId": task_id,
            "attemptId": a["attempt_id"], "leaseEpoch": a["lease_epoch"], "nodeEventSequence": 0,
            "occurredAt": None, "payload": {"verdict": envelope}}


def test_real_http_submit_replay_one_escrow_and_owner_query(rig):
    task_id, body = submitted(rig)
    replay = rig["http"].post("/api/v8/workloads", json=body)
    assert replay.status_code == 201 and replay.json()["id"] == task_id
    replay_decimal = rig["http"].post("/api/v8/workloads", json={**body, "budget": "2.5000"})
    assert replay_decimal.status_code == 201 and replay_decimal.json()["id"] == task_id
    assert rig["http"].get("/api/v8/media/tasks", params={"request_id": body["request_id"]}).json()["taskId"] == task_id
    with rig["sessions"]() as s:
        assert s.scalar(select(func.count()).select_from(ledger_t).where(ledger_t.c.idempotent_key == "escrow:" + task_id)) == 1
        assert AccountRepo.by_id(s, rig["buyer"].id).balance == Decimal("17.50")
    altered = deepcopy(body)
    altered["spec"]["media_input"]["prompt"] = "changed"
    assert rig["http"].post("/api/v8/workloads", json=altered).status_code == 400
    rig["app"].dependency_overrides[get_current_account] = lambda: rig["owner"]
    assert rig["http"].get("/api/v8/media/tasks/" + task_id).status_code == 404
    assert rig["http"].get("/api/v8/media/tasks", params={"request_id": body["request_id"]}).status_code == 404


def test_ordinary_shard_or_existing_media_attempt_reserves_device_despite_heartbeat_reset(rig):
    task_id, _ = submitted(rig)
    with rig["sessions"]() as s:
        shard = Shard(workload_id=task_id, worker_id=rig["worker_id"], status=ShardStatus.RUNNING)
        ShardRepo.create_batch(s, [shard])
        assert channel.stage_dispatch(s, task_id) is None
        channel.project_directory(s, {"nodes": [rig["node"]]})
        assert WorkerRepo.by_id(s, rig["worker_id"]).active_shards == 1
        # This synthetic ordinary lease can end; the media task then claims its
        # original single slot. An old heartbeat cannot free that durable lease.
        from platform_v8.storage.repo import shards_t
        s.execute(update(shards_t).where(shards_t.c.id == shard.id).values(status="DONE"))
        s.execute(update(workers_t).where(workers_t.c.id == rig["worker_id"]).values(active_shards=0))
        original = channel.stage_dispatch(s, task_id)
        assert original is not None
    with rig["sessions"]() as s:
        s.execute(update(workers_t).where(workers_t.c.id == rig["worker_id"]).values(active_shards=0))
    other_id, _ = submitted(rig, "second-device-request")
    with rig["sessions"]() as s:
        assert channel.stage_dispatch(s, other_id) is None
        assert MediaRepo.attempt(s, task_id)["attempt_id"] == original["attempt_id"]
    assert not rig["state"]["dispatches"]


def test_unknown_dispatch_reconciles_original_without_resending_after_restart(rig):
    task_id, _ = submitted(rig)
    rig["state"]["drop_dispatch_reply"] = True
    rig["state"]["drop_task_reply"] = True
    channel.poll_once(session_scope=rig["sessions"])
    assert len(rig["state"]["dispatches"]) == 1
    with rig["sessions"]() as s:
        a = MediaRepo.attempt(s, task_id)
        assert s.execute(select(outbox_t.c.state).where(outbox_t.c.id == a["attempt_id"] + ":dispatch")).scalar() == "unknown"
    # New HTTP client and fresh sessions recover durable state, not a second lease.
    rig["state"]["drop_task_reply"] = False
    channel.poll_once(client=channel.GatewayClient(), session_scope=rig["sessions"])
    assert len(rig["state"]["dispatches"]) == 1
    with rig["sessions"]() as s:
        assert MediaRepo.attempt(s, task_id)["attempt_id"] == a["attempt_id"]
        assert s.execute(select(outbox_t.c.state).where(outbox_t.c.id == a["attempt_id"] + ":dispatch")).scalar() == "complete"


def test_unknown_dispatch_404_keeps_same_attempt_and_escrow(rig):
    task_id, _ = submitted(rig)
    channel.poll_once(session_scope=rig["sessions"])
    with rig["sessions"]() as s:
        a = MediaRepo.attempt(s, task_id)
        MediaRepo.complete_operation(s, a["attempt_id"] + ":dispatch", state="unknown")
    rig["state"]["tasks"].clear()
    channel.poll_once(session_scope=rig["sessions"])
    channel.poll_once(session_scope=rig["sessions"])
    assert len(rig["state"]["dispatches"]) == 1
    with rig["sessions"]() as s:
        assert MediaRepo.attempt(s, task_id)["attempt_id"] == a["attempt_id"]
        assert AccountRepo.by_id(s, rig["buyer"].id).balance == Decimal("17.50")


def test_duplicate_verdict_settles_once_then_delivery_only(rig):
    task_id, _ = submitted(rig)
    channel.poll_once(session_scope=rig["sessions"])
    event = result_event(rig, task_id)
    rig["state"]["events"] = [event]
    rig["state"]["drop_settlement_reply"] = True
    channel.poll_once(session_scope=rig["sessions"])
    with rig["sessions"]() as s:
        assert WorkloadRepo.by_id(s, task_id).status.value == "DONE"
        assert MediaRepo.settlement(s, task_id)["result_revision"] == "e" * 64
        paid = s.scalar(select(func.count()).select_from(ledger_t).where(ledger_t.c.workload_id == task_id))
    # Replay a signed persisted verdict with another feed sequence; no second charge/reward.
    event2 = deepcopy(event)
    event2["sequence"] = 2
    rig["state"]["events"].append(event2)
    rig["state"]["drop_settlement_reply"] = False
    channel.poll_once(session_scope=rig["sessions"])
    with rig["sessions"]() as s:
        assert s.scalar(select(func.count()).select_from(ledger_t).where(ledger_t.c.workload_id == task_id)) == paid
        assert s.scalar(select(func.count()).select_from(settlements_t)) == 1
        assert AccountRepo.by_id(s, rig["owner"].id).balance == Decimal("1.6250")
    status = rig["http"].get("/api/v8/media/tasks/" + task_id).json()
    assert status["status"] == "DONE" and status["phase"] == "settled"
    assert status["resultMetadata"]["secondsMs"] == 5000
    encoded_grant = status["viewerReceipt"]
    grant = json.loads(base64.urlsafe_b64decode(encoded_grant + "=" * (-len(encoded_grant) % 4)))
    rig["keys"]["viewer"].public_key().verify(base64.urlsafe_b64decode(grant["signature"] + "=="), channel.canonical(grant["payload"]))
    assert grant["payload"]["account_id"] == rig["buyer"].id and grant["payload"]["object_version_id"] == "fixture-version"
    assert len(rig["state"]["dispatches"]) == 1 and rig["state"]["ack"] == 2


def test_historical_persisted_signed_verdict_recovers_without_regeneration(rig):
    task_id, _ = submitted(rig)
    channel.poll_once(session_scope=rig["sessions"])
    rig["state"]["events"] = [result_event(rig, task_id, old=True)]
    channel.poll_once(session_scope=rig["sessions"])
    assert rig["http"].get("/api/v8/media/tasks/" + task_id).json()["status"] == "DONE"
    assert len(rig["state"]["dispatches"]) == 1


@pytest.mark.parametrize("change", [{"ownerId": "999"}, {"leaseEpoch": 2}, {"plan_sha256": "0" * 64},
                                   {"deviceId": "other-device"}, {"billableResultRevision": "0" * 64}])
def test_signed_wrong_owner_lease_plan_or_revision_never_settles(rig, change):
    task_id, _ = submitted(rig)
    channel.poll_once(session_scope=rig["sessions"])
    rig["state"]["events"] = [result_event(rig, task_id, overrides=change)]
    with pytest.raises(media_profiles.MediaProfileError):
        channel.poll_once(session_scope=rig["sessions"])
    with rig["sessions"]() as s:
        assert MediaRepo.settlement(s, task_id) is None
        assert AccountRepo.by_id(s, rig["owner"].id).balance == 0
    assert rig["state"]["ack"] == 0


def test_untrusted_owner_mapping_and_self_report_cannot_open_quote(rig):
    with rig["sessions"]() as s:
        channel.kv_set(s, media_profiles.DEVICE_BINDINGS_KEY, [{**rig["binding"], "gateway_owner_id": "other-owner"}])
    assert rig["http"].post("/api/v8/economy/estimate", json={"spec": rig["spec"]}).status_code == 503
    rig["state"]["qualified_profiles"] = []
    channel.poll_once(session_scope=rig["sessions"])
    response = rig["http"].post("/api/v8/economy/estimate", json={"spec": rig["spec"]})
    assert response.status_code == 503
    with rig["sessions"]() as s:
        assert s.scalar(select(func.count()).select_from(requests_t)) == 0


def test_official_qualification_expiry_and_cross_owner_mapping_fail_closed(rig):
    with rig["sessions"]() as s:
        record = channel.kv_get(s, "media:directory-qualification:v1")
        payload = deepcopy(record["qualification"]["payload"])
        payload.update(issued_at=int(time.time()) - 60, expires_at=int(time.time()) - 30)
        record["qualification"] = rig["signed"](payload)
        channel.kv_set(s, "media:directory-qualification:v1", record)
    assert rig["http"].post("/api/v8/economy/estimate", json={"spec": rig["spec"]}).status_code == 503
    rig["state"]["qualified_profiles"][0]["ownerId"] = str(rig["buyer"].id)
    channel.poll_once(session_scope=rig["sessions"])
    assert rig["http"].post("/api/v8/economy/estimate", json={"spec": rig["spec"]}).status_code == 503
    with rig["sessions"]() as s:
        assert channel.load_device_bindings(s) == []


def test_submit_transaction_rollback_releases_idempotency_and_funds(rig, monkeypatch):
    estimate = rig["http"].post("/api/v8/economy/estimate", json={"spec": rig["spec"]}).json()
    original = ledger.escrow_hold
    def fail_after_hold(*args, **kwargs):
        original(*args, **kwargs)
        raise ValueError("fixture downstream fault")
    monkeypatch.setattr(ledger, "escrow_hold", fail_after_hold)
    with pytest.raises(SubmitWorkloadError):
        with rig["sessions"]() as s:
            submit_workload(s, SubmitInput(owner_id=rig["buyer"].id, name="fixture", spec_dict=rig["spec"],
                budget=Decimal("2.50"), quote_token=estimate["quote_token"], request_id="fixture-rollback"))
    with rig["sessions"]() as s:
        assert s.scalar(select(func.count()).select_from(requests_t)) == 0
        assert AccountRepo.by_id(s, rig["buyer"].id).balance == Decimal("20")


def test_preflight_bucket_or_expiry_failure_closes_quote_without_ledger(rig):
    with rig["sessions"]() as s:
        preflight = channel.kv_get(s, channel.PREFLIGHT_KEY)
        preflight["payload"]["bucket"] = "attacker-bucket"
        channel.kv_set(s, channel.PREFLIGHT_KEY, rig["signed"](preflight["payload"]))
    response = rig["http"].post("/api/v8/economy/estimate", json={"spec": rig["spec"]})
    assert response.status_code == 503
    with rig["sessions"]() as s:
        assert s.scalar(select(func.count()).select_from(requests_t)) == 0


def test_signed_catalog_cannot_rewrite_existing_price_or_allow_manual_injection(rig):
    nonce = str(uuid4())
    now = int(time.time())
    bad_profile = {**rig["profile"], "unit_price_yuan": "0.01"}
    catalog = rig["signed"]({"schema": "qianshou.formal-media-catalog.v1", "purpose": "qianshou:formal-media-catalog",
        "nonce": nonce, "catalog_version": 2, "profiles": [bad_profile], "issued_at": now, "expires_at": now + 300}, "catalog")
    with pytest.raises(media_profiles.MediaProfileError, match="不可改写"):
        with rig["sessions"]() as s:
            channel.sync_catalog(s, catalog, nonce=nonce)
    with rig["sessions"]() as s:
        settings = channel.kv_get(s, "economy:settings:v1")
        settings["media_profiles"] = [bad_profile]
        channel.kv_set(s, "economy:settings:v1", settings)
    response = rig["http"].post("/api/v8/economy/estimate", json={"spec": rig["spec"]})
    assert response.status_code == 503


def test_catalog_sync_updates_price_only_as_a_new_official_version(rig):
    profile2 = {**rig["profile"], "profile_version": 2, "price_version": 2, "unit_price_yuan": "0.75"}
    rig["state"]["catalog_profiles"].append(profile2)
    rig["state"]["catalog_version"] = 2
    identity = {k: profile2[k] for k in channel.IDENTITY}
    rig["node"]["media_profiles"].append(identity)
    rig["state"]["qualified_profiles"].append({**rig["state"]["qualified_profiles"][0], **identity})
    with rig["sessions"]() as s:
        channel.kv_set(s, media_profiles.DEVICE_BINDINGS_KEY, [rig["binding"], {**rig["binding"], **identity}])
    channel.poll_once(session_scope=rig["sessions"])
    spec2 = deepcopy(rig["spec"])
    spec2["media_input"]["profile_version"] = 2
    response = rig["http"].post("/api/v8/economy/estimate", json={"spec": spec2})
    assert response.status_code == 200 and response.json()["recommended_budget"] == "3.75"
    old = rig["http"].post("/api/v8/economy/estimate", json={"spec": rig["spec"]})
    assert old.status_code == 200 and old.json()["recommended_budget"] == "2.50"


def test_image_input_requires_real_owner_bound_exact_version_admission(rig):
    profile2 = {**rig["profile"], "profile_version": 2, "mode": "image_to_video",
                "input_roles": ["first_frame"], "max_assets": 1}
    rig["state"]["catalog_profiles"].append(profile2)
    rig["state"]["catalog_version"] = 2
    identity = {k: profile2[k] for k in channel.IDENTITY}
    rig["node"]["media_profiles"].append(identity)
    rig["state"]["qualified_profiles"].append({**rig["state"]["qualified_profiles"][0], **identity})
    with rig["sessions"]() as s:
        channel.kv_set(s, media_profiles.DEVICE_BINDINGS_KEY, [rig["binding"], {**rig["binding"], **identity}])
    channel.poll_once(session_scope=rig["sessions"])
    spec2 = deepcopy(rig["spec"])
    spec2["media_input"].update(mode="image_to_video", profile_version=2,
        assets=[{"asset_id": "fixture-first", "sha256": "d" * 64, "role": "first_frame"}])
    assert rig["http"].post("/api/v8/economy/estimate", json={"spec": spec2}).status_code == 200
    spec2["media_input"]["assets"][0]["asset_id"] = "another-account-first"
    assert rig["http"].post("/api/v8/economy/estimate", json={"spec": spec2}).status_code == 503


def test_node_result_declaration_calls_verifier_outbox_without_settling_self_claim(rig):
    task_id, _ = submitted(rig)
    channel.poll_once(session_scope=rig["sessions"])
    with rig["sessions"]() as s:
        a = MediaRepo.attempt(s, task_id)
    artifact = {"object_key": "fixture-output", "object_version_id": "fixture-version",
                "sha256": "f" * 64, "size_bytes": 1024, "content_type": "video/mp4"}
    rig["state"]["events"] = [{"sequence": 1, "source": "node", "deviceId": a["device_id"],
        "taskId": task_id, "attemptId": a["attempt_id"], "leaseEpoch": a["lease_epoch"],
        "nodeEventSequence": 1, "occurredAt": None, "payload": {"stage": "awaiting_settlement",
            "assetId": "fixture-result", "artifact": artifact, "percent": 100}}]
    channel.poll_once(session_scope=rig["sessions"])
    assert len(rig["state"]["verified_requests"]) == 1
    with rig["sessions"]() as s:
        assert MediaRepo.settlement(s, task_id) is None
        assert WorkloadRepo.by_id(s, task_id).status.value == "RUNNING"


def test_cancel_unknown_dispatch_waits_for_signed_stop_and_never_refunds_early(rig):
    task_id, _ = submitted(rig)
    rig["state"]["drop_dispatch_reply"] = True
    rig["state"]["drop_task_reply"] = True
    channel.poll_once(session_scope=rig["sessions"])
    with rig["sessions"]() as s:
        w = WorkloadRepo.by_id(s, task_id)
        channel.cancel_media(s, w)
        assert WorkloadRepo.by_id(s, task_id).status.value == "RUNNING"
        assert AccountRepo.by_id(s, rig["buyer"].id).balance == Decimal("17.50")
        a = MediaRepo.attempt(s, task_id)
    now = int(time.time())
    terminal = rig["signed"]({"schema": "qianshou.formal-media-terminal.v1", "purpose": "qianshou:formal-media-terminal",
        "taskId": task_id, "attemptId": a["attempt_id"], "leaseEpoch": a["lease_epoch"],
        "plan_sha256": w.spec.media_profile["plan_sha256"], "status": "cancelled", "issued_at": now, "expires_at": now + 60})
    event = {"sequence": 1, "source": "node", "deviceId": a["device_id"], "taskId": task_id,
        "attemptId": a["attempt_id"], "leaseEpoch": a["lease_epoch"], "nodeEventSequence": 1,
        "payload": {"stage": "cancelled", "terminalReceipt": terminal}}
    with rig["sessions"]() as s:
        assert channel.consume_event(s, event) == "refunded"
        assert WorkloadRepo.by_id(s, task_id).status.value == "CANCELLED"
        assert AccountRepo.by_id(s, rig["buyer"].id).balance == Decimal("20")
    with rig["sessions"]() as s:
        assert channel.consume_event(s, event) == "refunded"
        assert AccountRepo.by_id(s, rig["buyer"].id).balance == Decimal("20")


@pytest.fixture
def sts_fixture(rig, monkeypatch):
    captured = []
    primary = SimpleNamespace(_config=lambda: ("fixtureMasterId", "fixtureMasterSecret", "https://cos.ap-shanghai.myqcloud.com"),
                              _authorization=lambda *_: "fixture Tc3 authorization")
    monkeypatch.setattr(media_storage, "_primary", lambda: primary)
    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self, limit):
            return channel.canonical({"Response": {"Credentials": {"TmpSecretId": "fixtureTemporaryId",
                "TmpSecretKey": "fixtureTemporarySecret", "Token": "fixtureTemporaryToken"},
                "ExpiredTime": int(time.time()) + 900}})
    class Opener:
        def open(self, request, timeout):
            captured.append(json.loads(request.data))
            return Response()
    monkeypatch.setattr(media_storage, "build_opener", lambda *_: Opener())
    return captured


def upload_ticket(rig, asset_id=None, **changes):
    asset_id = asset_id or str(uuid4())
    now = int(time.time())
    payload = {"schema": "qianshou.formal-media-asset-upload.v1", "purpose": "qianshou:formal-media-asset-upload",
        "accountId": rig["buyer"].id, "assetId": asset_id, "role": "first_frame", "sha256": "d" * 64,
        "size_bytes": 1024, "content_type": "image/png",
        "object_key": f"v8/account-{rig['buyer'].id}/media-assets/{asset_id}/input.png",
        "nonce": str(uuid4()), "issued_at": now, "expires_at": now + 300}
    payload.update(changes)
    return rig["signed"](payload, "upload")


def test_exact_input_sts_http_writer_reader_version_and_purpose_separation(rig, sts_fixture):
    ticket = upload_ticket(rig)
    headers = {"Authorization": "Bearer fixture-service-auth-only-12345678901234567890"}
    write = rig["http"].post("/api/v8/media/internal/input-write-credential", json={"ticket": ticket}, headers=headers)
    assert write.status_code == 200, write.text
    assert write.json()["credential"]["schema"] == "qianshou.formal-media-input-write-credential.v1"
    assert write.json()["credential"]["access_key_secret"] == "fixtureTemporarySecret"
    policy = json.loads(sts_fixture[-1]["Policy"])
    assert policy["statement"][0]["action"] == ["name/cos:PutObject"]
    assert policy["statement"][0]["resource"] == [f"qcs::cos:ap-shanghai:uid/1463872884:{media_storage.BUCKET}/{ticket['payload']['object_key']}"]
    assert policy["statement"][0]["condition"]["string_equal"]["cos:object-lock-mode"] == "COMPLIANCE"
    read = rig["http"].post("/api/v8/media/internal/input-read-credential", json={"ticket": ticket,
        "object_version_id": "fixture-version"}, headers=headers)
    assert read.status_code == 200
    policy = json.loads(sts_fixture[-1]["Policy"])
    assert policy["statement"][0]["action"] == ["name/cos:GetObject", "name/cos:HeadObject"]
    assert policy["statement"][0]["condition"]["string_equal"] == {"cos:versionid": "fixture-version"}
    changed = rig["http"].post("/api/v8/media/internal/input-read-credential", json={"ticket": ticket,
        "object_version_id": "replacement-version"}, headers=headers)
    assert changed.status_code == 503
    no_auth = rig["http"].post("/api/v8/media/internal/input-write-credential", json={"ticket": ticket})
    assert no_auth.status_code == 401


def test_upload_ticket_wrong_actor_prefix_signature_never_issues_sts(rig, sts_fixture):
    headers = {"Authorization": "Bearer fixture-service-auth-only-12345678901234567890"}
    ticket = upload_ticket(rig, object_key="v8/account-999/media-assets/forged/input.png")
    response = rig["http"].post("/api/v8/media/internal/input-write-credential", json={"ticket": ticket}, headers=headers)
    assert response.status_code == 503 and sts_fixture == []
    wrong_purpose = upload_ticket(rig, purpose="qianshou:formal-media-result")
    assert rig["http"].post("/api/v8/media/internal/input-write-credential", json={"ticket": wrong_purpose}, headers=headers).status_code == 503


def test_result_sts_bound_buyer_attempt_not_provider_and_freezes_single_object(rig, sts_fixture):
    task_id, _ = submitted(rig)
    channel.poll_once(session_scope=rig["sessions"])
    with rig["sessions"]() as s:
        a = MediaRepo.attempt(s, task_id)
    body = {"taskId": task_id, "attemptId": a["attempt_id"], "leaseEpoch": a["lease_epoch"],
        "assetId": str(uuid4()), "sha256": "f" * 64, "size_bytes": 1024, "content_type": "video/mp4"}
    headers = {"Authorization": "Bearer fixture-service-auth-only-12345678901234567890"}
    write = rig["http"].post("/api/v8/media/internal/result-write-credential", json=body, headers=headers)
    assert write.status_code == 200
    key = write.json()["object_key"]
    assert key.startswith(f"v8/account-{rig['buyer'].id}/workload-{task_id}/shard-{a['attempt_id']}/")
    assert f"account-{rig['owner'].id}/" not in key
    read = rig["http"].post("/api/v8/media/internal/result-read-credential",
        json={**body, "object_version_id": "fixture-output-version"}, headers=headers)
    assert read.status_code == 200
    changed = rig["http"].post("/api/v8/media/internal/result-write-credential",
        json={**body, "assetId": str(uuid4())}, headers=headers)
    assert changed.status_code == 503
    stale = rig["http"].post("/api/v8/media/internal/result-write-credential",
        json={**body, "leaseEpoch": 2}, headers=headers)
    assert stale.status_code == 503


def test_actual_provider_summary_counts_settlement_and_ledger_only(rig):
    task_id, _ = submitted(rig)
    channel.poll_once(session_scope=rig["sessions"])
    rig["app"].dependency_overrides[get_current_account] = lambda: rig["owner"]
    before = rig["http"].get("/api/v8/media/provider/summary").json()
    assert before["completedCalls"] == 0 and Decimal(before["settledEarnings"]) == 0
    rig["state"]["events"] = [result_event(rig, task_id)]
    channel.poll_once(session_scope=rig["sessions"])
    after = rig["http"].get("/api/v8/media/provider/summary").json()
    assert after["completedCalls"] == 1 and Decimal(after["settledEarnings"]) == Decimal("1.6250")
    assert after["modes"]["video"]["completedCalls"] == 1
    assert Decimal(after["modes"]["video"]["settledEarnings"]) == Decimal("1.6250")
    assert after["modes"]["image"] == {"completedCalls": 0, "activeCalls": 0, "settledEarnings": "0"}
    rig["app"].dependency_overrides[get_current_account] = lambda: rig["buyer"]
    buyer = rig["http"].get("/api/v8/media/provider/summary").json()
    assert buyer["completedCalls"] == 0 and Decimal(buyer["settledEarnings"]) == 0
