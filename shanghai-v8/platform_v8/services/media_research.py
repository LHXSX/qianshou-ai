"""Authenticated research API metadata only; no worker, workload, dispatch or ledger authority."""
from __future__ import annotations
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import stat
import time
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from uuid import UUID, uuid4
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from platform_v8.storage.repo import kv_t

KEY = "media:research-directory:v1"
SCHEMA = "qianshou.research-api-directory.v1"
log = logging.getLogger(__name__)


class ResearchDirectoryError(ValueError):
    """Static metadata diagnostic; no upstream body, credential or local origin is exposed."""


def enabled():
    return os.getenv("V8_MEDIA_RESEARCH_ENABLED") == "1"


def _exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ResearchDirectoryError("research metadata fields invalid")
    return value


def _time(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", value):
        raise ResearchDirectoryError("research metadata timestamp invalid")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        raise ResearchDirectoryError("research metadata timestamp invalid") from None


def _id(value, *, generic=False):
    pattern = r"[A-Za-z0-9._:-]{1,128}" if generic else r"[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}"
    if not isinstance(value, str) or not re.fullmatch(pattern, value) or ".." in value or value == "localhost":
        raise ResearchDirectoryError("research metadata identifier invalid")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise ResearchDirectoryError("research metadata address is not an identifier")


def _identity(value):
    if value is None:
        return None
    p = _exact(value, ("id", "sha256", "version"))
    if p["sha256"] is not None and (not isinstance(p["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", p["sha256"])):
        raise ResearchDirectoryError("research metadata hash invalid")
    return {"id": _id(p["id"]), "sha256": p["sha256"], "version": None if p["version"] is None else _id(p["version"])}


def _execution(value, epoch, now):
    """A current device resource report is separate from an API health confirmation."""
    p = _exact(value, ("schema", "observedAt", "connectionEpoch", "observationRevision", "idle",
                       "resourceAllowed", "activeTasks", "slotCount"))
    if (p["schema"] != "qianshou.research-node-execution.v1" or type(p["connectionEpoch"]) is not int
            or p["connectionEpoch"] != epoch or p["idle"] is not None and type(p["idle"]) is not bool
            or p["resourceAllowed"] is not None and type(p["resourceAllowed"]) is not bool
            or type(p["activeTasks"]) is not int or not 0 <= p["activeTasks"] <= 128
            or type(p["slotCount"]) is not int or p["slotCount"] != 1 or _time(p["observedAt"]) > now + 5):
        raise ResearchDirectoryError("research execution observation invalid")
    return {**p, "observationRevision": _id(p["observationRevision"], generic=True)}


def validate(response, nonce, *, now=None):
    """Validate one fresh server-authenticated response without conferring execution authority."""
    now = time.time() if now is None else now
    p = _exact(response, ("ok", "schema", "nonce", "generatedAt", "truncated", "dispatchAuthority", "formalQualification", "nodes"))
    if (p["ok"] is not True or p["schema"] != SCHEMA or p["nonce"] != nonce
            or p["dispatchAuthority"] != "none" or p["formalQualification"] != "not_evaluated"
            or type(p["truncated"]) is not bool or not isinstance(p["nodes"], list) or len(p["nodes"]) > 128):
        raise ResearchDirectoryError("research directory authority invalid")
    generated = _time(p["generatedAt"])
    if not now - 30 <= generated <= now + 5:
        raise ResearchDirectoryError("research directory stale")
    nodes, devices = [], set()
    for raw in p["nodes"]:
        fields = ("deviceId", "ownerId", "connectionEpoch", "online", "authorization", "lastHeartbeatAt", "localServices")
        node = _exact(raw, (*fields, "execution") if isinstance(raw, dict) and "execution" in raw else fields)
        device = _id(node["deviceId"], generic=True)
        if (device in devices or not isinstance(node["ownerId"], str) or not re.fullmatch(r"[1-9][0-9]{0,19}", node["ownerId"])
                or type(node["connectionEpoch"]) is not int or not 1 <= node["connectionEpoch"] <= 2**53 - 1
                or type(node["online"]) is not bool or node["authorization"] not in ("active", "paused", "revoked")
                or not isinstance(node["localServices"], list) or len(node["localServices"]) > 2):
            raise ResearchDirectoryError("research device metadata invalid")
        devices.add(device)
        if node["lastHeartbeatAt"] is not None and _time(node["lastHeartbeatAt"]) > now + 5:
            raise ResearchDirectoryError("research heartbeat invalid")
        services, modes = [], set()
        for raw_service in node["localServices"]:
            s = _exact(raw_service, ("mode", "adapter", "status", "model", "workflow", "observedAt", "registration", "probe", "modeGrant", "availableForTrial"))
            probe = _exact(s["probe"], ("state", "completedAt"))
            if (s["mode"] not in ("image", "video") or s["mode"] in modes
                    or s["status"] not in ("ready", "unavailable", "auth_required", "unsupported", "unknown")
                    or s["registration"] != "reported" or s["modeGrant"] != "reported"
                    or type(s["availableForTrial"]) is not bool or probe["state"] not in ("pending", "confirmed", "failed", "expired")):
                raise ResearchDirectoryError("research API metadata invalid")
            modes.add(s["mode"])
            model, workflow = _identity(s["model"]), _identity(s["workflow"])
            if _time(s["observedAt"]) > now + 5 or s["status"] == "ready" and (model is None or workflow is None):
                raise ResearchDirectoryError("research API observation invalid")
            completed = None if probe["completedAt"] is None else _time(probe["completedAt"])
            if completed is not None and completed > now + 5 or probe["state"] == "confirmed" and completed is None:
                raise ResearchDirectoryError("research API confirmation invalid")
            available = (node["online"] and node["authorization"] == "active" and s["status"] == "ready"
                         and probe["state"] == "confirmed" and completed is not None and -5 <= now - completed < 120)
            if s["availableForTrial"] and not available:
                raise ResearchDirectoryError("research availability unsupported")
            services.append({**s, "adapter": _id(s["adapter"]), "model": model, "workflow": workflow,
                             "probe": dict(probe)})
        projected = {**node, "deviceId": device, "localServices": services}
        if "execution" in node:
            projected["execution"] = _execution(node["execution"], node["connectionEpoch"], now)
        nodes.append(projected)
    return {**p, "nodes": nodes}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ResearchDirectoryError("research redirect refused")


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ResearchDirectoryError("research duplicate JSON field")
        result[key] = value
    return result


class ResearchClient:
    """One fixed server-only read route with an independent private credential."""
    def __init__(self):
        if not enabled():
            raise ResearchDirectoryError("research directory unavailable")
        self.base = os.getenv("V8_MEDIA_RESEARCH_SERVICE_BASE_URL", "").rstrip("/")
        p = urlsplit(self.base)
        if (p.scheme not in ("https", "http") or not p.hostname or p.username or p.password or p.query or p.fragment
                or p.path or p.scheme == "http" and p.hostname not in ("127.0.0.1", "::1")):
            raise ResearchDirectoryError("research service configuration unavailable")
        path = Path(os.getenv("V8_MEDIA_RESEARCH_SERVICE_TOKEN_FILE", ""))
        try:
            if not path.is_absolute():
                raise OSError()
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 4096
                        or hasattr(os, "geteuid") and info.st_uid != os.geteuid()):
                    raise OSError()
                self.token = source.read(4097).decode("utf-8").strip()
        except (OSError, ValueError):
            raise ResearchDirectoryError("research service identity unavailable") from None
        if not 32 <= len(self.token) <= 4096 or re.search(r"\s", self.token):
            raise ResearchDirectoryError("research service identity unavailable")

    def read(self, nonce):
        if str(UUID(nonce)) != nonce:
            raise ResearchDirectoryError("research nonce invalid")
        request = Request(self.base + "/internal/media/research/nodes", data=json.dumps({"nonce": nonce}).encode(),
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json", "Accept-Encoding": "identity"}, method="POST")
        try:
            with build_opener(ProxyHandler({}), _NoRedirect()).open(request, timeout=8) as response:
                if response.headers.get_content_type() != "application/json":
                    raise ResearchDirectoryError("research response invalid")
                raw = response.read(524289)
                if len(raw) > 524288:
                    raise ResearchDirectoryError("research response exceeded bound")
                return json.loads(raw, object_pairs_hook=_pairs, parse_constant=lambda _x: (_ for _ in ()).throw(ValueError()))
        except Exception:
            raise ResearchDirectoryError("research directory read unavailable") from None


def _load(s, *, lock=False):
    statement = select(kv_t.c.v).where(kv_t.c.k == KEY)
    row = s.execute(statement.with_for_update() if lock else statement).one_or_none()
    return json.loads(row.v) if row and isinstance(row.v, str) else row.v if row else None


def _ensure(s):
    # The unique KV row serializes all process readers before replacing a snapshot.
    dialect = s.get_bind().dialect.name
    insert = pg_insert if dialect == "postgresql" else sqlite_insert if dialect == "sqlite" else None
    if insert is None:
        raise ResearchDirectoryError("research metadata storage unavailable")
    s.execute(insert(kv_t).values(k=KEY, v={}).on_conflict_do_nothing(index_elements=[kv_t.c.k]))


def _save(s, value):
    s.execute(update(kv_t).where(kv_t.c.k == KEY).values(v=value))


def poll_once(client=None, *, session_scope=None):
    if session_scope is None:
        from platform_v8.storage.db import session_scope
    nonce = str(uuid4())
    try:
        response = validate((client or ResearchClient()).read(nonce), nonce)
        with session_scope() as s:
            _ensure(s)
            old = _load(s, lock=True)
            if old and _time(old["directory"]["generatedAt"]) > _time(response["generatedAt"]):
                return {"updated": False, "reason": "older_snapshot"}
            _save(s, {"observedAt": time.time(), "lastFailureAt": None, "directory": response})
            s.commit()
        return {"updated": True, "nodes": len(response["nodes"])}
    except Exception:
        with session_scope() as s:
            old = _load(s, lock=True)
            if old and old.get("directory") is not None:
                _save(s, {**old, "lastFailureAt": time.time()})
                s.commit()
        raise ResearchDirectoryError("research directory unavailable") from None


def owner_directory(s, owner, *, now=None):
    if not enabled():
        raise ResearchDirectoryError("research directory unavailable")
    now = time.time() if now is None else now
    saved = _load(s)
    if not saved or saved.get("directory") is None:
        raise ResearchDirectoryError("research directory unavailable")
    directory = deepcopy(saved["directory"])
    fresh = (saved.get("lastFailureAt") is None and 0 <= now - saved["observedAt"] < 30
             and -5 <= now - _time(directory["generatedAt"]) < 30)
    nodes = [node for node in directory["nodes"] if node["ownerId"] == str(owner)]
    for node in nodes:
        for service in node["localServices"]:
            completed = service["probe"]["completedAt"]
            if not fresh or completed is None or not -5 <= now - _time(completed) < 120:
                service["availableForTrial"] = False
                if service["probe"]["state"] == "confirmed":
                    service["probe"]["state"] = "expired"
    return {"ok": True, "schema": SCHEMA, "state": "current" if fresh else "unavailable",
            "generatedAt": directory["generatedAt"], "truncated": directory["truncated"], "nodes": nodes,
            "dispatchAuthority": "none", "formalQualification": "not_evaluated"}


async def consumer_loop():
    while True:
        work = asyncio.create_task(asyncio.to_thread(poll_once))
        try:
            await asyncio.shield(work)
        except asyncio.CancelledError:
            # Drain this bounded read/commit before lifespan closes its dependencies.
            try:
                await work
            except Exception:
                pass
            raise
        except Exception:
            log.warning("research API metadata unavailable; no dispatch authority")
        await asyncio.sleep(10)
