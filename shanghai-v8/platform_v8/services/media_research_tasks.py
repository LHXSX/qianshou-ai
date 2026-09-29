"""Same-owner zero-fee fixed Qwen tasks. Shanghai stores control metadata, never media or money."""
from __future__ import annotations
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import stat
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler
from uuid import UUID, uuid4
from sqlalchemy import select, update, func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from platform_v8.storage.repo import accounts_t, kv_t
from platform_v8.services.media_research import owner_directory, _exact, _time, _NoRedirect, _pairs

log = logging.getLogger(__name__)
PREFIX = "media:research-task:v1:"
INDEX = "media:research-task-id:v1:"
LOCK = "media:research-task-lock:v1"
SLOT = "media:research-device-slot:v1:"
TIMING = "media:research-device-timing:v1:"
SCHEMA = "qianshou.research-media-task.v1"
WORKFLOW = "comfy-pilot-image-154f7d6133fe0276"
WORKFLOW_SHA = "154f7d6133fe0276e7cefc97a17ea2bde1febe397f3963bd0ea8be8c624ee7be"
TERMINAL = ("succeeded", "failed", "cancelled")
MAX_OWNER_QUEUE = 32
# Planning defaults, not measurements or a declared device speed. A successful control-plane
# observation can replace execution/return estimates; no fabricated GPU benchmark is stored.
CONSERVATIVE_SECONDS = {"modelLoadSeconds": 120, "executionSeconds": 600, "returnSeconds": 60}
NOT_STARTED = {
    403: {"RESEARCH_OWNER_MISMATCH"},
    409: {"CONNECTION_EPOCH_STALE", "RESEARCH_NODE_UNAVAILABLE", "RESEARCH_NODE_BUSY", "RESEARCH_LEASE_EXPIRED",
          "RESEARCH_API_NOT_CONFIRMED", "RESEARCH_WORKFLOW_UNSUPPORTED", "RESEARCH_EXECUTION_NOT_READY"},
    400: {"RESEARCH_MESSAGE_INVALID", "RESEARCH_LEASE_INVALID", "RESEARCH_INPUT_INVALID", "RESEARCH_IDENTIFIER_INVALID",
          "RESEARCH_IDENTITY_INVALID"},
}


class ResearchTaskError(ValueError):
    def __init__(self, code, status=503):
        super().__init__(code)
        self.code, self.status = code, status


def enabled():
    return os.getenv("V8_MEDIA_RESEARCH_TASKS_ENABLED") == "1"


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _sha(value):
    return hashlib.sha256(_canonical(value).encode()).hexdigest()


def _uuid(value):
    try:
        if (not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value)
                or str(UUID(value)) != value):
            raise ValueError()
        return value
    except (ValueError, AttributeError):
        raise ResearchTaskError("research_request_invalid", 400) from None


def _iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class DispatchClient:
    """Dedicated research write identity; no read/formal/admin credential fallback or media route."""
    def __init__(self):
        if not enabled():
            raise ResearchTaskError("research_tasks_unavailable")
        self.base = os.getenv("V8_MEDIA_RESEARCH_DISPATCH_SERVICE_BASE_URL", "").rstrip("/")
        parsed = urlsplit(self.base)
        if (parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment
                or parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "::1")):
            raise ResearchTaskError("research_dispatch_configuration_unavailable")
        path = Path(os.getenv("V8_MEDIA_RESEARCH_DISPATCH_SERVICE_TOKEN_FILE", ""))
        try:
            if not path.is_absolute():
                raise OSError()
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 257
                        or hasattr(os, "geteuid") and info.st_uid != os.geteuid()):
                    raise OSError()
                self.token = source.read(258).decode().strip()
        except (OSError, ValueError):
            raise ResearchTaskError("research_dispatch_identity_unavailable") from None
        if not re.fullmatch(r"[A-Za-z0-9_-]{43,256}", self.token):
            raise ResearchTaskError("research_dispatch_identity_unavailable")

    def call(self, action, body):
        if action not in ("dispatch", "task"):
            raise ResearchTaskError("research_operation_invalid")
        request = Request(self.base + "/internal/media/research/" + action,
            data=_canonical(body).encode(), headers={"Authorization": "Bearer " + self.token,
                "Content-Type": "application/json", "Accept-Encoding": "identity"}, method="POST")
        try:
            with build_opener(ProxyHandler({}), _NoRedirect()).open(request, timeout=8) as response:
                if response.headers.get_content_type() != "application/json":
                    raise ValueError()
                raw = response.read(65537)
                if len(raw) > 65536:
                    raise ValueError()
                return json.loads(raw, object_pairs_hook=_pairs, parse_constant=lambda _x: (_ for _ in ()).throw(ValueError()))
        except HTTPError as error:
            try:
                body = json.loads(error.read(2049), object_pairs_hook=_pairs)
                _exact(body, ("ok", "code"))
                if action == "dispatch" and body["ok"] is False and body["code"] in NOT_STARTED.get(error.code, set()):
                    raise ResearchTaskError(body["code"], error.code)
            except ResearchTaskError:
                raise
            except Exception:
                pass
            raise ResearchTaskError("research_dispatch_unknown") from None
        except Exception:
            raise ResearchTaskError("research_dispatch_unknown") from None


def _key(owner, request):
    return PREFIX + str(owner) + ":" + request


def _load(s, key, *, lock=False):
    statement = select(kv_t.c.v).where(kv_t.c.k == key)
    row = s.execute(statement.with_for_update() if lock else statement).one_or_none()
    return json.loads(row.v) if row and isinstance(row.v, str) else row.v if row else None


def _insert(s, key, value):
    dialect = s.get_bind().dialect.name
    insert = pg_insert if dialect == "postgresql" else sqlite_insert if dialect == "sqlite" else None
    if insert is None:
        raise ResearchTaskError("research_storage_unavailable")
    s.execute(insert(kv_t).values(k=key, v=value).on_conflict_do_nothing(index_elements=[kv_t.c.k]))


def _save(s, key, value):
    revision = value["revision"]
    changed = s.execute(update(kv_t).where(kv_t.c.k == key, kv_t.c.v["revision"].as_integer() == revision)
        .values(v={**value, "revision": revision + 1}, updated_at=datetime.utcnow())).rowcount
    if changed != 1:
        raise ResearchTaskError("research_storage_conflict")


def _queue_lock(s):
    # SQLite INSERT obtains its database write lock; PostgreSQL locks the existing singleton.
    # Every reservation/release and outbox claim uses this same transaction boundary.
    _insert(s, LOCK, {})
    return _load(s, LOCK, lock=True)


def _slot_key(device):
    return SLOT + hashlib.sha256(device.encode()).hexdigest()


def _timing_key(device):
    return TIMING + hashlib.sha256(device.encode()).hexdigest()


def _valid_record(record):
    legacy = ("schema", "revision", "ownerId", "requestId", "requestHash", "taskId", "attemptId", "lease", "leaseSha",
              "status", "dispatchState", "createdAt", "updatedAt", "lastSyncedAt", "reason", "gatewayTask")
    if isinstance(record, dict) and set(record) == set(legacy):
        record = {**deepcopy(record), "input": deepcopy(record["lease"]["input"]), "queueSequence": 0,
                  "scheduling": {"estimate": None, "reservedAt": None, "submittedAt": None,
                                 "uploadingAt": None, "completedAt": None}}
    _exact(record, (*legacy, "input", "queueSequence", "scheduling"))
    lease = record["lease"]
    input_value = _exact(record["input"], ("prompt",))
    scheduling = _exact(record["scheduling"], ("estimate", "reservedAt", "submittedAt", "uploadingAt", "completedAt"))
    if (record["schema"] != SCHEMA or type(record["revision"]) is not int or record["revision"] < 0
            or record["requestHash"] != _sha({"mode": "image", "input": input_value})
            or record["status"] not in ("queued", "running", "unknown", "delivery_pending", *TERMINAL)
            or record["dispatchState"] not in ("waiting", "pending", "sending", "unknown", "accepted", "rejected")
            or type(record["queueSequence"]) is not int or record["queueSequence"] < 0
            or not isinstance(record["ownerId"], str) or not re.fullmatch(r"[1-9][0-9]{0,19}", record["ownerId"])):
        raise ResearchTaskError("research_storage_invalid")
    if lease is None:
        if record["leaseSha"] is not None or record["dispatchState"] != "waiting" or record["status"] != "queued":
            raise ResearchTaskError("research_storage_invalid")
    elif (record["leaseSha"] != _sha(lease) or record["ownerId"] != str(lease["accountId"])
          or lease["input"] != input_value or any(record[key] != lease[key] for key in ("requestId", "taskId", "attemptId"))):
        raise ResearchTaskError("research_storage_invalid")
    for key in ("requestId", "taskId", "attemptId"):
        _uuid(record[key])
    for key in ("createdAt", "updatedAt"):
        _time(record[key])
    for key in ("reservedAt", "submittedAt", "uploadingAt", "completedAt"):
        if scheduling[key] is not None:
            _time(scheduling[key])
    estimate = scheduling["estimate"]
    if estimate is not None:
        _exact(estimate, ("source", "sampleCount", "queueSeconds", "modelLoadSeconds", "executionSeconds", "returnSeconds", "totalSeconds"))
        if (estimate["source"] not in ("conservative", "observed_control") or type(estimate["sampleCount"]) is not int
                or not 0 <= estimate["sampleCount"] <= 32
                or any(type(estimate[k]) is not int or not 0 <= estimate[k] <= 86400
                       for k in ("queueSeconds", "modelLoadSeconds", "executionSeconds", "returnSeconds"))
                or type(estimate["totalSeconds"]) is not int or not 0 <= estimate["totalSeconds"] <= 345600
                or estimate["totalSeconds"] != sum(estimate[k] for k in ("queueSeconds", "modelLoadSeconds", "executionSeconds", "returnSeconds"))):
            raise ResearchTaskError("research_estimate_invalid")
    return record


def _projection(record, position=None):
    r = _valid_record(record)
    estimate = r["scheduling"]["estimate"]
    return {"ok": True, "schema": SCHEMA, "requestId": r["requestId"], "taskId": r["taskId"], "attemptId": r["attemptId"],
        "mode": "image", "status": r["status"], "dispatchState": r["dispatchState"], "reason": r["reason"],
        "createdAt": r["createdAt"], "updatedAt": r["updatedAt"], "lastSyncedAt": r["lastSyncedAt"],
        "non_billable": True, "commercial": False, "result": None if r["gatewayTask"] is None else r["gatewayTask"]["artifact"],
        "queue": {"position": position if r["dispatchState"] == "waiting" else None,
                  "estimate": deepcopy(estimate)}}


def _position(s, record):
    return s.execute(select(func.count()).select_from(kv_t).where(kv_t.c.k.like(PREFIX + record["ownerId"] + ":%"),
        kv_t.c.v["dispatchState"].as_string() == "waiting",
        kv_t.c.v["queueSequence"].as_integer() <= record["queueSequence"])).scalar_one()


def submit(s, owner, body):
    """Persist a FIFO request. Waiting requests have no lease and cannot submit to a GPU."""
    _exact(body, ("requestId", "mode", "input"))
    request = _uuid(body["requestId"])
    input_value = _exact(body["input"], ("prompt",))
    prompt = input_value["prompt"]
    if (body["mode"] != "image" or not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode()) > 8192
            or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", prompt)):
        raise ResearchTaskError("research_input_invalid", 400)
    fingerprint = _sha({"mode": "image", "input": input_value})
    if s.execute(select(accounts_t.c.id).where(accounts_t.c.id == owner).with_for_update()).one_or_none() is None:
        raise ResearchTaskError("research_owner_unavailable", 401)
    counter = _queue_lock(s)
    known = _load(s, _key(owner, request), lock=True)
    if known is not None:
        known = _valid_record(known)
        if known["requestHash"] != fingerprint:
            raise ResearchTaskError("research_request_conflict", 409)
        return _projection(known, _position(s, known))
    DispatchClient()  # Missing the dedicated write identity still fails closed before creating a request.
    waiting = s.execute(select(kv_t.c.k).where(kv_t.c.k.like(PREFIX + str(owner) + ":%"),
        kv_t.c.v["dispatchState"].as_string() == "waiting").limit(MAX_OWNER_QUEUE)).all()
    if len(waiting) >= MAX_OWNER_QUEUE:
        raise ResearchTaskError("research_queue_full", 429)
    sequence = counter.get("queueSequence", 0) + 1
    s.execute(update(kv_t).where(kv_t.c.k == LOCK).values(v={"queueSequence": sequence}))
    task, attempt, now = str(uuid4()), str(uuid4()), _iso()
    record = {"schema": SCHEMA, "revision": 0, "ownerId": str(owner), "requestId": request, "requestHash": fingerprint,
        "taskId": task, "attemptId": attempt, "input": dict(input_value), "lease": None, "leaseSha": None,
        "queueSequence": sequence, "status": "queued", "dispatchState": "waiting", "createdAt": now,
        "updatedAt": now, "lastSyncedAt": None, "reason": None, "gatewayTask": None,
        "scheduling": {"estimate": None, "reservedAt": None, "submittedAt": None, "uploadingAt": None, "completedAt": None}}
    _insert(s, _key(owner, request), record)
    _insert(s, INDEX + task, {"ownerId": str(owner), "requestId": request})
    s.commit()
    return _projection(record, len(waiting) + 1)


def status(s, owner, *, request_id=None, task_id=None):
    if task_id is not None:
        pointer = _load(s, INDEX + _uuid(task_id))
        if pointer is None or pointer.get("ownerId") != str(owner):
            raise ResearchTaskError("research_task_not_found", 404)
        request_id = pointer["requestId"]
    record = _load(s, _key(owner, _uuid(request_id)))
    if record is None:
        raise ResearchTaskError("research_task_not_found", 404)
    return _projection(record, _position(s, _valid_record(record)))


def _estimate(s, device):
    saved = _load(s, _timing_key(device))
    samples = saved["samples"] if saved and saved.get("workflowSha256") == WORKFLOW_SHA else []
    def upper(field, fallback):
        values = sorted(sample[field] for sample in samples if sample.get(field) is not None)
        if not values:
            return fallback
        # Control observation includes polling uncertainty; add two polling intervals.
        return min(86400, max(1, math.ceil(values[math.ceil(len(values) * .9) - 1]) + 6))
    result = {"source": "observed_control" if samples else "conservative", "sampleCount": len(samples),
              "queueSeconds": 0, "modelLoadSeconds": CONSERVATIVE_SECONDS["modelLoadSeconds"],
              "executionSeconds": upper("executionSeconds", CONSERVATIVE_SECONDS["executionSeconds"]),
              "returnSeconds": upper("returnSeconds", CONSERVATIVE_SECONDS["returnSeconds"])}
    result["totalSeconds"] = sum(result[k] for k in ("queueSeconds", "modelLoadSeconds", "executionSeconds", "returnSeconds"))
    return result


def _eligible(node, service, now):
    execution = node.get("execution")
    return (node["online"] and node["authorization"] == "active" and service["availableForTrial"]
        and service["mode"] == "image" and service["adapter"] == "comfyui" and service["status"] == "ready"
        and service["model"] is not None and service["model"]["id"] == "qwen-image-2.1-int8-convrot"
        and service["model"]["version"] == "2.1" and service["workflow"] is not None
        and service["workflow"]["id"] == WORKFLOW and service["workflow"]["sha256"] == WORKFLOW_SHA
        and service["workflow"]["version"] == "1" and execution is not None
        and execution["connectionEpoch"] == node["connectionEpoch"] and -5 <= now - _time(execution["observedAt"]) < 15
        and execution["idle"] is True and execution["resourceAllowed"] is True
        and execution["activeTasks"] == 0 and execution["slotCount"] == 1)


def _reserve(s, key, record, node, estimate):
    slot = _slot_key(node["deviceId"])
    _insert(s, slot, {})
    if _load(s, slot, lock=True):
        return False
    s.execute(update(kv_t).where(kv_t.c.k == slot).values(v={"taskId": record["taskId"], "attemptId": record["attemptId"],
        "ownerId": record["ownerId"], "deviceId": node["deviceId"]}))
    expiry = datetime.fromtimestamp(time.time() + 300, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    lease = {"schema": "qianshou.research-media-lease.v1", "requestId": record["requestId"], "taskId": record["taskId"],
        "attemptId": record["attemptId"], "accountId": int(record["ownerId"]), "deviceId": node["deviceId"],
        "connectionEpoch": node["connectionEpoch"], "leaseEpoch": 1, "leaseExpiresAt": expiry, "mode": "image",
        "adapter": "comfyui", "modelId": "qwen-image-2.1-int8-convrot", "workflowId": WORKFLOW, "input": record["input"]}
    _save(s, key, {**record, "lease": lease, "leaseSha": _sha(lease), "dispatchState": "pending", "reason": None,
        "updatedAt": _iso(), "scheduling": {**record["scheduling"], "estimate": estimate, "reservedAt": _iso()}})
    return True


def _release(s, record):
    if record["lease"] is None:
        return
    key = _slot_key(record["lease"]["deviceId"])
    slot = _load(s, key, lock=True)
    if slot and slot.get("taskId") == record["taskId"] and slot.get("attemptId") == record["attemptId"]:
        s.execute(update(kv_t).where(kv_t.c.k == key).values(v={}))


def _schedule(s):
    # Preserve the occupancy of old v1 sending/unknown attempts after an upgrade.
    occupied = s.execute(select(kv_t.c.v).where(kv_t.c.k.like(PREFIX + "%"),
        kv_t.c.v["dispatchState"].as_string().in_(("pending", "sending", "unknown", "accepted")),
        kv_t.c.v["status"].as_string().notin_(TERMINAL))).scalars()
    for raw in occupied:
        record = _valid_record(raw)
        slot_key = _slot_key(record["lease"]["deviceId"])
        _insert(s, slot_key, {})
        if not _load(s, slot_key, lock=True):
            s.execute(update(kv_t).where(kv_t.c.k == slot_key).values(v={"taskId": record["taskId"], "attemptId": record["attemptId"],
                "ownerId": record["ownerId"], "deviceId": record["lease"]["deviceId"]}))
    rows = s.execute(select(kv_t.c.k, kv_t.c.v).where(kv_t.c.k.like(PREFIX + "%"),
        kv_t.c.v["dispatchState"].as_string() == "waiting").order_by(kv_t.c.v["queueSequence"].as_integer(), kv_t.c.k).limit(4096)).all()
    directories = {}
    for row in rows:
        record = _valid_record(row.v)
        if record["ownerId"] not in directories:
            try:
                directories[record["ownerId"]] = owner_directory(s, int(record["ownerId"]))
            except Exception:
                directories[record["ownerId"]] = None
        directory = directories[record["ownerId"]]
        candidates = []
        for node in directory["nodes"] if directory and directory["state"] == "current" else []:
            if any(_eligible(node, service, time.time()) for service in node["localServices"]) and not _load(s, _slot_key(node["deviceId"])):
                candidates.append((_estimate(s, node["deviceId"]), node))
        if candidates:
            estimate, node = min(candidates, key=lambda item: (item[0]["totalSeconds"], item[1]["deviceId"]))
            _reserve(s, row.k, record, node, estimate)
        else:
            reason = "research_directory_unavailable" if not directory or directory["state"] != "current" else "research_no_idle_device"
            if record["reason"] != reason:
                _save(s, row.k, {**record, "reason": reason, "updatedAt": _iso()})


def _observe_completed(s, record, scheduling):
    if scheduling["submittedAt"] is None:
        return  # Old records without a recorded start do not manufacture a timing sample.
    finished = _time(scheduling["completedAt"])
    upload = _time(scheduling["uploadingAt"]) if scheduling["uploadingAt"] is not None else finished
    sample = {"attemptId": record["attemptId"], "observedAt": scheduling["completedAt"],
              "executionSeconds": min(86400, max(0, math.ceil(upload - _time(scheduling["submittedAt"])))),
              "returnSeconds": None if scheduling["uploadingAt"] is None else min(86400, max(0, math.ceil(finished - upload)))}
    key = _timing_key(record["lease"]["deviceId"])
    old = _load(s, key, lock=True)
    samples = old["samples"] if old and old.get("workflowSha256") == WORKFLOW_SHA else []
    if any(p["attemptId"] == record["attemptId"] for p in samples):
        return
    _insert(s, key, {})
    s.execute(update(kv_t).where(kv_t.c.k == key).values(v={"workflowSha256": WORKFLOW_SHA, "samples": [*samples, sample][-32:]}))


def validate_task(reply, record, *, dispatch=False):
    _exact(reply, ("ok", "duplicate", "task") if dispatch else ("ok", "task"))
    if reply["ok"] is not True or dispatch and type(reply["duplicate"]) is not bool:
        raise ResearchTaskError("research_gateway_response_invalid")
    task = _exact(reply["task"], ("sequence", "lease", "stage", "eventSequence", "backendJobId", "artifact", "submission", "expired"))
    lease = _exact(task["lease"], (*record["lease"], "observationRevision", "non_billable"))
    if (any(type(lease[k]) is not type(v) or lease[k] != v for k, v in record["lease"].items()) or lease["non_billable"] is not True
            or not isinstance(lease["observationRevision"], str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", lease["observationRevision"])
            or type(task["sequence"]) is not int or task["sequence"] < 1 or type(task["eventSequence"]) is not int or task["eventSequence"] < 0
            or type(task["expired"]) is not bool or task["submission"] not in ("not_claimed", "claimed")
            or task["stage"] not in ("leased", "accepted", "submitting", "running", "outcome_unknown", "uploading", "failed", "cancelled", "completed")):
        raise ResearchTaskError("research_gateway_tuple_invalid")
    if task["backendJobId"] is not None:
        _uuid(task["backendJobId"])
    artifact = task["artifact"]
    if artifact is not None:
        _exact(artifact, ("assetId", "sha256", "size_bytes", "content_type", "width", "height", "resultRevision", "download_path"))
        if (artifact["assetId"] != record["attemptId"] or artifact["content_type"] != "image/png"
                or artifact["width"] != 2048 or artifact["height"] != 1152 or type(artifact["size_bytes"]) is not int
                or not 1 <= artifact["size_bytes"] <= 67108864
                or any(not isinstance(artifact[key], str) or not re.fullmatch(r"[0-9a-f]{64}", artifact[key]) for key in ("sha256", "resultRevision"))
                or artifact["download_path"] != "/v1/media/research/result?taskId=" + record["taskId"] + "&attemptId=" + record["attemptId"]):
            raise ResearchTaskError("research_gateway_artifact_invalid")
    if (task["stage"] == "completed") != (artifact is not None):
        raise ResearchTaskError("research_gateway_completion_invalid")
    return deepcopy(task)


def _accept(s, key, task):
    _queue_lock(s)
    current = _valid_record(_load(s, key, lock=True))
    old = current["gatewayTask"]
    if old is not None:
        if old["lease"] != task["lease"] or old["sequence"] != task["sequence"]:
            raise ResearchTaskError("research_gateway_immutable_conflict")
        if current["status"] in TERMINAL or task["eventSequence"] < old["eventSequence"]:
            return
    mapped = {"leased": "queued", "accepted": "queued", "submitting": "unknown", "outcome_unknown": "unknown",
              "running": "running", "uploading": "delivery_pending", "completed": "succeeded", "failed": "failed", "cancelled": "cancelled"}
    now, scheduling = _iso(), dict(current["scheduling"])
    if task["stage"] == "uploading" and scheduling["uploadingAt"] is None:
        scheduling["uploadingAt"] = now
    if task["stage"] == "completed":
        scheduling["completedAt"] = now
        _observe_completed(s, current, scheduling)
        _release(s, current)
    elif task["stage"] == "cancelled" and task["submission"] == "not_claimed" and task["backendJobId"] is None:
        # Guangzhou rejects cancellation after any claim and rejects claims after cancellation.
        # This original durable tuple proves no execution right existed and revokes its lease.
        _release(s, current)
    # Failed/cancelled claimed execution is not proof the GPU stopped. Retain its slot;
    # only completed immutable bytes, or an exact pre-dispatch rejection, release it here.
    _save(s, key, {**current, "gatewayTask": task, "dispatchState": "accepted", "status": mapped[task["stage"]],
        "updatedAt": now, "lastSyncedAt": now, "reason": None, "scheduling": scheduling})


def _ready_reserved(s, record):
    try:
        directory = owner_directory(s, int(record["ownerId"]))
        return directory["state"] == "current" and any(node["deviceId"] == record["lease"]["deviceId"]
            and node["connectionEpoch"] == record["lease"]["connectionEpoch"]
            and any(_eligible(node, service, time.time()) for service in node["localServices"]) for node in directory["nodes"])
    except Exception:
        return False


def poll_once(client=None, *, session_scope=None):
    """Reconcile original tuples, reserve free devices atomically, then consume one send right."""
    if session_scope is None:
        from platform_v8.storage.db import session_scope
    client = client or DispatchClient()
    with session_scope() as s:
        active = s.execute(select(kv_t.c.k, kv_t.c.v).where(kv_t.c.k.like(PREFIX + "%"),
            kv_t.c.v["dispatchState"].as_string().in_(("sending", "unknown", "accepted")),
            kv_t.c.v["status"].as_string().notin_(TERMINAL)).order_by(kv_t.c.updated_at, kv_t.c.k).limit(4)).all()
    for row in active:
        record = _valid_record(row.v)
        try:
            task = validate_task(client.call("task", {"taskId": record["taskId"], "attemptId": record["attemptId"]}), record)
            with session_scope() as s:
                _accept(s, row.k, task); s.commit()
        except Exception:
            with session_scope() as s:
                _queue_lock(s)
                current = _valid_record(_load(s, row.k, lock=True))
                if current["status"] not in TERMINAL:
                    _save(s, row.k, {**current, "reason": "research_status_unavailable", "updatedAt": _iso()}); s.commit()
    selected = None
    with session_scope() as s:
        _queue_lock(s)
        _schedule(s)
        pending = s.execute(select(kv_t.c.k, kv_t.c.v).where(kv_t.c.k.like(PREFIX + "%"),
            kv_t.c.v["dispatchState"].as_string() == "pending").order_by(kv_t.c.v["queueSequence"].as_integer(), kv_t.c.k).limit(128)).all()
        for row in pending:
            record = _valid_record(row.v)
            if _time(record["lease"]["leaseExpiresAt"]) <= time.time():
                _save(s, row.k, {**record, "status": "failed", "dispatchState": "rejected", "reason": "RESEARCH_LEASE_EXPIRED", "updatedAt": _iso()})
                _release(s, record)
            elif _ready_reserved(s, record):
                now = _iso()
                _save(s, row.k, {**record, "dispatchState": "sending", "status": "unknown", "updatedAt": now,
                    "scheduling": {**record["scheduling"], "submittedAt": now}})
                selected = (row.k, record)
                break
        s.commit()  # Neither slot nor dispatch right can be observed half committed.
    if selected is not None:
        key, record = selected
        try:
            task = validate_task(client.call("dispatch", record["lease"]), record, dispatch=True)
            with session_scope() as s:
                _accept(s, key, task); s.commit()
        except Exception as error:
            with session_scope() as s:
                _queue_lock(s)
                current = _valid_record(_load(s, key, lock=True))
                if current["dispatchState"] != "accepted":
                    definite = isinstance(error, ResearchTaskError) and error.code in NOT_STARTED.get(error.status, set())
                    _save(s, key, {**current, "dispatchState": "rejected" if definite else "unknown",
                        "status": "failed" if definite else "unknown", "reason": error.code if definite else "research_dispatch_unknown", "updatedAt": _iso()})
                    if definite:
                        _release(s, current)
                    s.commit()
    return {"dispatchConsumed": selected is not None, "statusReads": len(active)}


async def consumer_loop():
    while True:
        work = asyncio.create_task(asyncio.to_thread(poll_once))
        try:
            await asyncio.shield(work)
        except asyncio.CancelledError:
            try:
                await work
            except Exception:
                pass
            raise
        except Exception:
            log.warning("research task synchronization unavailable; original attempts retained")
        await asyncio.sleep(3)
