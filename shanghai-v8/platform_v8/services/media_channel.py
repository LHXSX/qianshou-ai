"""Formal media control plane: bounded JSON only, never download media bytes.

Pinned service identities, verified hardware bindings and immutable official
profiles are required. A configuration flag cannot create those receipts.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import stat
import time
from dataclasses import asdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from sqlalchemy import select, insert, update

from platform_v8.core import Workload, WorkloadSpec, WorkloadResult, WorkloadStatus, WorkerStatus
from platform_v8.services.media_profiles import (MediaProfileError, canonical_media_plan, digest,
    load_device_bindings, worker_matches_media_plan)
from platform_v8.storage.media_repo import (MediaRepo, requests_t, attempts_t, outbox_t,
                                          events_t, settlements_t)
from platform_v8.storage.repo import (WorkloadRepo, WorkerRepo, AccountRepo, kv_t,
                                     workers_t, workloads_t, accounts_t, shards_t)

log = logging.getLogger(__name__)
PREFLIGHT_KEY = "media:channel-preflight:v1"
DIRECTORY_KEY = "media:directory:v1"
CURSOR_KEY = "media:event-cursor:v1"
FEATURES = {"directory", "dispatch_reconcile", "event_journal", "asset_admission",
            "result_verifier", "settlement_ack"}
IDENTITY = ("profile_id", "profile_version", "model_sha256", "workflow_sha256",
            "validation_receipt_sha256")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _file(name, *, secret=False):
    path = Path(os.environ.get(name, ""))
    if not path.is_absolute():
        raise MediaProfileError("quote_unavailable: 媒体服务身份未配置")
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_size > 16384
                    or (secret and (info.st_mode & 0o077 or info.st_uid != os.geteuid()))):
                raise ValueError("file permissions")
            return source.read(16385)
    except (OSError, ValueError):
        raise MediaProfileError("quote_unavailable: 媒体服务身份不可读取") from None


def _keys():
    try:
        public = serialization.load_pem_public_key(_file("V8_MEDIA_GUANGZHOU_PUBLIC_KEY_FILE"))
        private = serialization.load_pem_private_key(_file("V8_MEDIA_ORDER_PRIVATE_KEY_FILE", secret=True), None)
        gid, sid = os.getenv("V8_MEDIA_GUANGZHOU_KEY_ID", ""), os.getenv("V8_MEDIA_ORDER_KEY_ID", "")
        if (not isinstance(public, Ed25519PublicKey) or not isinstance(private, Ed25519PrivateKey)
                or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", gid)
                or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", sid)
                or public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
                == private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)):
            raise ValueError("independent pinned identities required")
        return gid, public, sid, private
    except (ValueError, TypeError):
        raise MediaProfileError("quote_unavailable: 媒体服务独立身份无效") from None


def _signer(role):
    prefix = {"order": "V8_MEDIA_ORDER", "authorization": "V8_MEDIA_AUTHORIZATION",
              "viewer": "V8_MEDIA_VIEWER"}[role]
    kid = os.getenv(prefix + "_KEY_ID", "")
    try:
        key = serialization.load_pem_private_key(_file(prefix + "_PRIVATE_KEY_FILE", secret=True), None)
        if not isinstance(key, Ed25519PrivateKey) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", kid):
            raise ValueError("signer")
        return kid, key
    except (ValueError, TypeError):
        raise MediaProfileError("quote_unavailable: 媒体用途签名配置无效") from None


def sign(payload, *, role="order"):
    kid, key = _signer(role)
    return {"key_id": kid, "payload": payload,
            "signature": base64.urlsafe_b64encode(key.sign(canonical(payload))).rstrip(b"=").decode()}


def verify(envelope, *, schema, purpose, now=None, stored_receipt=False):
    if schema in {"qianshou.formal-media-catalog.v1", "qianshou.formal-media-asset-upload.v1"}:
        prefix = "V8_MEDIA_CATALOG" if schema == "qianshou.formal-media-catalog.v1" else "V8_MEDIA_UPLOAD"
        gid = os.getenv(prefix + "_KEY_ID", "")
        try:
            public = serialization.load_pem_public_key(_file(prefix + "_PUBLIC_KEY_FILE"))
            if not isinstance(public, Ed25519PublicKey):
                raise ValueError("catalog identity")
        except (ValueError, TypeError):
            raise MediaProfileError("quote_unavailable: 广州目录/资产用途签名未配置") from None
    else:
        gid, public, _, _ = _keys()
    now = int(time.time()) if now is None else now
    try:
        if (not isinstance(envelope, dict) or set(envelope) != {"key_id", "payload", "signature"}
                or envelope["key_id"] != gid or not isinstance(envelope["payload"], dict)
                or not re.fullmatch(r"[A-Za-z0-9_-]{86}", envelope["signature"])):
            raise ValueError("signature shape")
        raw = base64.urlsafe_b64decode(envelope["signature"] + "==")
        if len(raw) != 64 or base64.urlsafe_b64encode(raw).rstrip(b"=").decode() != envelope["signature"]:
            raise ValueError("noncanonical signature encoding")
        public.verify(raw, canonical(envelope["payload"]))
        payload = envelope["payload"]
        if (payload.get("schema") != schema or payload.get("purpose") != purpose
                or type(payload.get("issued_at")) is not int
                or type(payload.get("expires_at")) is not int
                or not payload["issued_at"] <= now
                or (not stored_receipt and now >= payload["expires_at"])
                or payload["expires_at"] <= payload["issued_at"]
                or payload["expires_at"] - payload["issued_at"] > 3600):
            raise ValueError("purpose or freshness")
        return payload
    except Exception:
        raise MediaProfileError("quote_unavailable: 广州媒体签名、用途或有效期无效") from None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise MediaProfileError("媒体控制服务禁止重定向")


class GatewayClient:
    """Only fixed internal metadata routes; bounded responses and no redirects."""
    @staticmethod
    def _base(value):
        parsed = urlsplit(value)
        if (parsed.scheme not in {"https", "http"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in {"", "/"}
                or (parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"})):
            raise MediaProfileError("quote_unavailable: 媒体控制服务地址未配置或不安全")
        return value

    def __init__(self):
        self.base = self._base(os.getenv("V8_MEDIA_SERVICE_BASE_URL", "").rstrip("/"))
        self.verifier_base = self._base(os.getenv("V8_MEDIA_VERIFIER_BASE_URL", self.base).rstrip("/"))
        self.token = _file("V8_MEDIA_SERVICE_TOKEN_FILE", secret=True).decode().strip()
        self.verifier_token = (_file("V8_MEDIA_VERIFIER_TOKEN_FILE", secret=True).decode().strip()
                               if os.getenv("V8_MEDIA_VERIFIER_TOKEN_FILE") else self.token)
        if not 32 <= len(self.token) <= 4096 or any(c.isspace() for c in self.token):
            raise MediaProfileError("quote_unavailable: 媒体服务凭据无效")
        _keys()

    def post(self, path, payload):
        if path not in {"nodes", "dispatch", "task", "events/read", "events/ack",
                        "profiles", "devices/verified", "preflight", "assets/admit", "results/verify", "settlement", "cancel"}:
            raise ValueError("unknown metadata route")
        verifier = path in {"profiles", "devices/verified", "preflight", "assets/admit", "results/verify"}
        base, token = (self.verifier_base, self.verifier_token) if verifier else (self.base, self.token)
        limit = 1048576 if path == "profiles" else 131072
        req = Request(base + "/internal/media/" + path, data=canonical(payload),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept-Encoding": "identity"}, method="POST")
        with build_opener(ProxyHandler({}), _NoRedirect()).open(req, timeout=8) as response:
            if response.headers.get_content_type() != "application/json":
                raise MediaProfileError("媒体控制服务响应必须是JSON")
            raw = response.read(limit + 1)
            if len(raw) > limit:
                raise MediaProfileError("媒体元数据响应超限")
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise MediaProfileError("媒体元数据响应无效")
            return data


def kv_get(s, key, default=None):
    row = s.execute(select(kv_t).where(kv_t.c.k == key)).one_or_none()
    value = row.v if row else default
    return json.loads(value) if isinstance(value, str) else value


def kv_set(s, key, value):
    if s.execute(select(kv_t.c.k).where(kv_t.c.k == key)).first():
        s.execute(update(kv_t).where(kv_t.c.k == key).values(v=value))
    else:
        s.execute(insert(kv_t).values(k=key, v=value))


def _preflight(s, plan=None):
    GatewayClient()  # proves separately configured service identity, never a boolean flag
    from platform_v8.services.media_storage import _primary
    _primary()
    for name in ("V8_MEDIA_SERVICE_INBOUND_TOKEN_FILE", "V8_MEDIA_STORAGE_WRITE_SERVICE_INBOUND_TOKEN_FILE",
                 "V8_MEDIA_STORAGE_READ_SERVICE_INBOUND_TOKEN_FILE"):
        if len(_file(name, secret=True).decode().strip()) < 32:
            raise MediaProfileError("quote_unavailable: 媒体回调/存储专用服务身份未配置")
    identities = [_keys()[1], *[_signer(role)[1].public_key() for role in ("order", "authorization", "viewer")]]
    if len({key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw) for key in identities}) != 4:
        raise MediaProfileError("quote_unavailable: 媒体验真、订单、授权、查看签名必须独立")
    published = kv_get(s, "media:catalog-receipt:v1", {})
    catalog = verify(published.get("catalog"), schema="qianshou.formal-media-catalog.v1",
                     purpose="qianshou:formal-media-catalog")
    from platform_v8.services.economy.task_pricing import _load_settings
    if (published.get("catalog_version") != catalog.get("catalog_version")
            or catalog["expires_at"] - catalog["issued_at"] > 300
            or published.get("terms_sha256") != digest(catalog.get("profiles"))
            or digest(_load_settings(s).get("media_profiles", [])) != published.get("terms_sha256")):
        raise MediaProfileError("quote_unavailable: 上海媒体目录与广州官方发行版本不一致")
    qualification = kv_get(s, "media:directory-qualification:v1", {})
    q = verify(qualification.get("qualification"), schema="qianshou.formal-media-directory-qualification.v1",
               purpose="qianshou:formal-media-directory-qualification")
    if (q["expires_at"] - q["issued_at"] > 30
            or qualification.get("bindings_sha256") != digest(load_device_bindings(s))):
        raise MediaProfileError("quote_unavailable: 广州设备验证已过期或绑定被改写")
    data = verify(kv_get(s, PREFLIGHT_KEY), schema="qianshou.formal-media-preflight.v1",
                  purpose="qianshou:formal-media-preflight")
    if (data.get("status") != "ready" or data["expires_at"] - data["issued_at"] > 30
            or not os.getenv("V8_MEDIA_RESULT_BUCKET") or data.get("bucket") != os.getenv("V8_MEDIA_RESULT_BUCKET")
            or not isinstance(data.get("features"), dict)
            or any(data["features"].get(k) is not True for k in FEATURES)):
        raise MediaProfileError("quote_unavailable: 广州媒体服务实际预检不完整")
    if plan and not any(isinstance(p, dict) and all(p.get(k) == plan[k] for k in IDENTITY)
                        for p in data.get("profiles", [])):
        raise MediaProfileError("quote_unavailable: 广州未验证当前官方媒体档位")
    return data


def require_channel(spec, *, session=None, account_id=None):
    from platform_v8.storage.db import session_scope
    if session is None:
        with session_scope() as s:
            return require_channel(spec, session=s, account_id=account_id)
    from platform_v8.services.economy.task_pricing import _load_settings
    from platform_v8.services.economy.workload_quote import pricing_spec
    plan = canonical_media_plan(pricing_spec(spec), _load_settings(session))
    _preflight(session, plan)
    # Exact profile must have genuinely verified supply; advertisements alone cannot quote.
    bindings = load_device_bindings(session)
    directory = kv_get(session, DIRECTORY_KEY, {})
    now = int(time.time())
    if not isinstance(directory, dict) or now - int(directory.get("observed_at", 0)) > 30:
        raise MediaProfileError("quote_unavailable: 媒体设备目录已过期")
    candidates = directory.get("devices", [])
    if not any((w := WorkerRepo.by_id(session, d.get("worker_id", ""))) is not None
               and d.get("online") is True and w.is_online and not w.is_temporarily_disabled
               and worker_matches_media_plan(w, plan, bindings=bindings)
               for d in candidates if isinstance(d, dict)):
        raise MediaProfileError("quote_unavailable: 当前档位无经验证且获得机主授权的设备")
    assets = spec.get("media_input", {}).get("assets", [])
    if assets:
        if type(account_id) is not int or account_id <= 0:
            raise MediaProfileError("quote_unavailable: 媒体资产必须绑定购买账号")
        nonce = str(uuid4())
        response = GatewayClient().post("assets/admit", {"accountId": account_id, "assets": assets, "nonce": nonce})
        admission = verify(response.get("admission"), schema="qianshou.formal-media-assets-admission.v1",
                           purpose="qianshou:formal-media-assets-admission")
        frozen = admission.get("assets", [])
        if (admission.get("accountId") != account_id or admission.get("nonce") != nonce
                or admission["expires_at"] - admission["issued_at"] > 60
                or not isinstance(frozen, list)
                or [{k: a.get(k) for k in ("asset_id", "sha256", "role")} for a in frozen] != assets
                or any(not isinstance(a.get("object_version_id"), str)
                       or a["object_version_id"].lower() in {"", "null"}
                       or type(a.get("size_bytes")) is not int or a["size_bytes"] <= 0
                       or type(a.get("retention_until")) is not int
                       or a["retention_until"] <= now + plan["timeout_s"]
                       for a in frozen)):
            raise MediaProfileError("quote_unavailable: 输入资产归属或不可变版本不匹配")
    return plan


def sync_catalog(s, signed_catalog, *, nonce):
    """Only Guangzhou's pinned official publisher can populate media prices."""
    from platform_v8.services.media_profiles import official_profiles, validate_profile_update
    from platform_v8.services.economy.task_pricing import _load_settings
    payload = verify(signed_catalog, schema="qianshou.formal-media-catalog.v1",
                     purpose="qianshou:formal-media-catalog")
    if (set(payload) != {"schema", "purpose", "nonce", "catalog_version", "profiles", "issued_at", "expires_at"}
            or payload.get("nonce") != nonce or type(payload.get("catalog_version")) is not int
            or payload["catalog_version"] < 1 or payload["expires_at"] - payload["issued_at"] > 300):
        raise MediaProfileError("quote_unavailable: 广州官方目录challenge或版本无效")
    current = _load_settings(s)
    # Publication responses include every historical version. Node capability
    # advertisements and legacy per-second tariffs never enter this store.
    incoming = {**current, "media_profiles": payload["profiles"]}
    official_profiles(incoming)
    validate_profile_update(current, incoming)
    previous = kv_get(s, "media:catalog-receipt:v1", {})
    old_version = previous.get("catalog_version", 0)
    terms = digest(payload["profiles"])
    if (payload["catalog_version"] < old_version
            or (payload["catalog_version"] == old_version and previous.get("terms_sha256") != terms)):
        raise MediaProfileError("quote_unavailable: 广州官方目录发生降版或同版本改写")
    if current.get("media_profiles", []) != payload["profiles"]:
        incoming["version"] = int(current.get("version", 0)) + 1
        kv_set(s, "economy:settings:v1", incoming)
    kv_set(s, "media:catalog-receipt:v1", {"catalog_version": payload["catalog_version"],
        "terms_sha256": terms, "catalog": signed_catalog})
    return payload


def project_directory(s, response, *, now=None):
    """Self reports update live capacity only after a trusted device/owner mapping."""
    now = int(time.time()) if now is None else now
    nodes = response.get("nodes")
    if not isinstance(nodes, list) or len(nodes) > 10000:
        raise MediaProfileError("广州媒体目录格式无效")
    bindings = load_device_bindings(s)
    devices = []
    seen = set()
    for node in nodes:
        if not isinstance(node, dict) or node.get("deviceId") in seen:
            raise MediaProfileError("广州媒体目录重复或格式无效")
        seen.add(node.get("deviceId"))
        mapped = [b for b in bindings if b.get("device_id") == node.get("deviceId")
                  and b.get("gateway_owner_id") == node.get("ownerId") and b.get("enabled") is True]
        ids = {(b.get("worker_id"), b.get("owner_id")) for b in mapped}
        if len(ids) != 1:
            continue
        worker_id, owner_id = next(iter(ids))
        worker = WorkerRepo.by_id(s, worker_id)
        if worker is None or worker.owner_id != owner_id or AccountRepo.by_id(s, owner_id) is None:
            continue  # never create an account/worker from a gateway claim
        cap = asdict(worker.capabilities)
        for field in ("media_profiles", "free_vram_mb", "max_media_concurrent", "media_available_seconds"):
            cap[field] = node.get(field, [] if field == "media_profiles" else 0)
        live = (node.get("online") is True and node.get("media_exchange_ready") is True
                and isinstance(node.get("capabilityRevision"), str) and 1 <= len(node["capabilityRevision"]) <= 200
                and type(node.get("connectionEpoch")) is int and node["connectionEpoch"] >= 1
                and type(node.get("freeSlots")) is int and node["freeSlots"] > 0)
        # Owner withdrawal in server policy always wins over a fresh self-report.
        if cap.get("contribute_mode") not in {"active", "throttled"} or cap.get("throttle_pct", 0) <= 0:
            live = False
        active = s.execute(select(attempts_t.c.attempt_id).where(
            attempts_t.c.worker_id == worker_id,
            attempts_t.c.state.notin_(["settled", "failed", "cancelled"]))).all()
        ordinary = s.execute(select(shards_t.c.id).where(shards_t.c.worker_id == worker_id,
            shards_t.c.status.in_(["DISPATCHED", "LEASED", "RUNNING"]))).all()
        s.execute(update(workers_t).where(workers_t.c.id == worker_id,
            workers_t.c.owner_id == owner_id).values(capabilities=cap,
            status=WorkerStatus.ONLINE.value if live else WorkerStatus.OFFLINE.value,
            active_shards=max(worker.active_shards, len(active) + len(ordinary)), last_seen=datetime.utcnow()))
        devices.append({"worker_id": worker_id, "owner_id": owner_id,
            "device_id": node["deviceId"], "gateway_owner_id": node["ownerId"],
            "connection_epoch": node["connectionEpoch"], "revision": node["capabilityRevision"], "online": live})
    kv_set(s, DIRECTORY_KEY, {"observed_at": now, "devices": devices})
    return devices


def sync_qualifications(s, envelope, *, nonce):
    """GZ verifies publication plus independent device receipts; no self reports."""
    from platform_v8.services.economy.task_pricing import _load_settings
    from platform_v8.services.media_profiles import official_profiles
    payload = verify(envelope, schema="qianshou.formal-media-directory-qualification.v1",
                     purpose="qianshou:formal-media-directory-qualification")
    supply = {"worker_id", "authorized_until", "verified_until", "p90_execution_seconds",
              "max_task_seconds", "gpu_model", "vram_mb", "total_memory_mb", "max_concurrent", "hardware_qualification"}
    if (set(payload) != {"schema", "purpose", "nonce", "profiles", "issued_at", "expires_at"}
            or payload.get("nonce") != nonce or payload["expires_at"] - payload["issued_at"] > 30
            or not isinstance(payload.get("profiles"), list) or len(payload["profiles"]) > 1024):
        raise MediaProfileError("广州设备验证challenge无效")
    official = {(p.profile_id, p.profile_version): p for p in official_profiles(_load_settings(s))}
    bindings, seen = [], set()
    for p in payload["profiles"]:
        if not isinstance(p, dict) or set(p) != set(IDENTITY) | supply | {"deviceId", "ownerId", "executor_sha256"}:
            raise MediaProfileError("广州设备验证字段不完整")
        profile = official.get((p["profile_id"], p["profile_version"]))
        if (profile is None or not profile.enabled or type(p["profile_version"]) is not int
                or any(p[k] != getattr(profile, k) for k in IDENTITY)
                or not isinstance(p["ownerId"], str) or not re.fullmatch(r"[1-9][0-9]*", p["ownerId"])
                or not isinstance(p["deviceId"], str) or not 1 <= len(p["deviceId"]) <= 128
                or not isinstance(p["executor_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", p["executor_sha256"])
                or not isinstance(p["worker_id"], str) or not 1 <= len(p["worker_id"]) <= 36
                or not isinstance(p["gpu_model"], str) or not 1 <= len(p["gpu_model"]) <= 256
                or any(type(p[k]) is not int or p[k] <= 0 for k in supply - {"worker_id", "gpu_model", "hardware_qualification"})
                or p["max_concurrent"] != 1 or p["hardware_qualification"] != "rtx_4060_or_better_verified"
                or p["vram_mb"] < max(8192, profile.min_vram_mb) or p["total_memory_mb"] < profile.min_memory_mb
                or p["p90_execution_seconds"] > profile.timeout_s or p["max_task_seconds"] < profile.timeout_s
                or min(p["authorized_until"], p["verified_until"]) <= int(time.time())):
            raise MediaProfileError("广州设备验证资格与官方能力不匹配")
        owner = int(p["ownerId"])
        worker = WorkerRepo.by_id(s, p["worker_id"])
        account = AccountRepo.by_id(s, owner)
        if worker is None or worker.owner_id != owner or account is None or not account.is_active:
            continue  # existing numeric authenticated owner/worker only
        identity = (p["deviceId"], p["profile_id"], p["profile_version"])
        if identity in seen:
            raise MediaProfileError("广州设备验证身份重复")
        seen.add(identity)
        bindings.append({k: p[k] for k in set(IDENTITY) | supply | {"executor_sha256"}} | {
            "device_id": p["deviceId"], "gateway_owner_id": p["ownerId"], "owner_id": owner, "enabled": True})
    kv_set(s, "media:directory-qualification:v1", {"qualification": envelope, "bindings_sha256": digest(bindings)})
    kv_set(s, "media:device-bindings:v1", bindings)
    return bindings


def submit_media(s, inp):
    """Same account/request + same contract returns the real original workload."""
    from platform_v8.services.economy import task_pricing, workload_quote, ledger, split
    request_id = getattr(inp, "request_id", None)
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", request_id):
        raise MediaProfileError("quote_unavailable: 正式媒体提交必须提供稳定 request_id")
    if not inp.budget.is_finite() or inp.budget <= 0:
        raise MediaProfileError("正式媒体确认金额必须为有限正数")
    canonical_spec = workload_quote.canonical_spec(inp.spec_dict)
    contract_hash = digest({"spec": canonical_spec, "budget": str(inp.budget.quantize(Decimal("0.0001")))})
    # Serialize owner idempotency before querying; this also works on SQLite,
    # whose SELECT FOR UPDATE is ignored. The value is unchanged.
    locked = s.execute(update(accounts_t).where(accounts_t.c.id == inp.owner_id)
                       .values(balance=accounts_t.c.balance))
    if locked.rowcount != 1:
        raise MediaProfileError("购买账号不存在")
    prior = MediaRepo.request(s, inp.owner_id, request_id)
    if prior:
        if prior["spec_sha256"] != contract_hash:
            raise MediaProfileError("request_id 已绑定另一媒体任务，不能改写参数或金额")
        original = WorkloadRepo.by_id(s, prior["workload_id"])
        if original is None:
            raise MediaProfileError("媒体幂等记录缺失原任务，禁止重提")
        return original
    plan = require_channel(canonical_spec, session=s, account_id=inp.owner_id)
    quote = task_pricing.compute_price_for_spec(s, workload_quote.pricing_spec(canonical_spec), account_id=inp.owner_id)
    workload_quote.verify_confirmation(inp.quote_token, account_id=inp.owner_id, spec=canonical_spec, quote=quote)
    if not inp.budget.is_finite() or inp.budget <= 0 or inp.budget != quote.total_yuan:
        raise MediaProfileError("确认金额与官方媒体报价不一致；需重新报价并确认")
    cfg = split.load_config_from_env()
    ratios = (cfg.client_ratio, cfg.platform_ratio, cfg.channel_ratio)
    if any(not r.is_finite() or r < 0 for r in ratios) or sum(ratios) != Decimal("1"):
        raise MediaProfileError("quote_unavailable: 正式账本分润配置无效")
    if (cfg.platform_account_id <= 0 or AccountRepo.by_id(s, cfg.platform_account_id) is None
            or (cfg.channel_account_id and AccountRepo.by_id(s, cfg.channel_account_id) is None)):
        raise MediaProfileError("quote_unavailable: 正式账本受益账号未接通")
    spec = WorkloadSpec(task_type=canonical_spec["task_type"], input_kind="params_only",
        media_input=canonical_spec["media_input"], media_profile=plan,
        verification_policy="artifact", timeout_s=plan["timeout_s"], max_shards=1)
    w = Workload(owner_id=inp.owner_id, name=inp.name, spec=spec, budget=quote.total_yuan,
                 total_shards=1, status=WorkloadStatus.CREATED)
    WorkloadRepo.create(s, w)
    frozen = {"price": {"currency": "CNY", "total_yuan": str(quote.total_yuan),
        "profile_id": quote.profile_id, "profile_version": quote.profile_version,
        "price_version": quote.price_version, "price_unit": plan["price_unit"], "units": quote.units},
        "split": {k: str(v) if isinstance(v, Decimal) else v for k, v in asdict(cfg).items()}}
    s.execute(insert(requests_t).values(workload_id=w.id, owner_id=inp.owner_id,
        request_id=request_id, spec_sha256=contract_hash,
        quote_id=hashlib.sha256(inp.quote_token.encode()).hexdigest(),
        authorization_id=str(uuid4()), authorization=frozen))
    ledger.escrow_hold(s, account_id=inp.owner_id, amount=w.budget, workload_id=w.id,
                       note="正式媒体任务托管")
    return w


def stage_dispatch(s, task_id, *, now=None):
    now = int(time.time()) if now is None else now
    w = WorkloadRepo.by_id_for_update(s, task_id)
    if w is None or w.is_terminal:
        return None
    existing = MediaRepo.attempt(s, task_id, lock=True)
    if existing:
        return existing  # unknown/running/settled attempts are never reallocated
    request = MediaRepo.request_by_task(s, task_id)
    if request is None:
        raise MediaProfileError("正式媒体任务缺冻结授权，禁止派发")
    plan = require_channel(asdict(w.spec), session=s, account_id=w.owner_id)
    if plan != w.spec.media_profile:
        raise MediaProfileError("官方媒体合同与冻结计划不一致")
    bindings = load_device_bindings(s)
    for d in kv_get(s, DIRECTORY_KEY, {}).get("devices", []):
        worker = WorkerRepo.by_id(s, d["worker_id"])
        if (not d.get("online") or worker is None or worker.is_temporarily_disabled
                or not worker_matches_media_plan(worker, plan, bindings=bindings)):
            continue
        # Claim the sole verified GPU execution slot atomically across gateways.
        claimed = s.execute(update(workers_t).where(workers_t.c.id == worker.id,
            workers_t.c.owner_id == d["owner_id"], workers_t.c.active_shards == 0,
            ~select(attempts_t.c.attempt_id).where(attempts_t.c.worker_id == worker.id,
                attempts_t.c.state.notin_(["settled", "failed", "cancelled"])).exists(),
            ~select(shards_t.c.id).where(shards_t.c.worker_id == worker.id,
                shards_t.c.status.in_(["DISPATCHED", "LEASED", "RUNNING"])).exists())
            .values(active_shards=1))
        if claimed.rowcount != 1:
            continue
        attempt_id, epoch = str(uuid4()), 1
        expires = now + plan["timeout_s"] + 45
        expires_iso = datetime.utcfromtimestamp(expires).isoformat(timespec="seconds") + "Z"
        auth = sign({"schema": "qianshou.formal-media-authorization.v1",
            "purpose": "qianshou:formal-media-authorization", "taskId": task_id,
            "attemptId": attempt_id, "deviceId": d["device_id"], "leaseEpoch": epoch,
            "leaseExpiresAt": expires_iso, "accountId": w.owner_id, "ownerId": d["gateway_owner_id"],
            "plan_sha256": plan["plan_sha256"], "quoteId": request["quote_id"],
            "authorizationId": request["authorization_id"], "price": request["authorization"]["price"],
            "issued_at": now, "expires_at": expires}, role="authorization")
        envelope = {"schema": "qianshou.formal-media-order.v1", "accountId": w.owner_id,
            "plan_sha256": plan["plan_sha256"],
            "plan": {k: v for k, v in plan.items() if k not in {"price_version", "price_unit", "units"}},
            "spec": {"task_type": w.spec.task_type, "input_kind": "params_only", "media_input": w.spec.media_input},
            "authorization": auth}
        envelope["outputPolicy"] = {"object_prefix": f"v8/account-{w.owner_id}/workload-{task_id}/shard-{attempt_id}/result/",
                                    "max_bytes": 64 * 1024 * 1024}
        payload = {"deviceId": d["device_id"], "taskId": task_id, "attemptId": attempt_id,
            "leaseEpoch": epoch, "leaseExpiresAt": expires_iso, "quoteId": request["quote_id"],
            "authorizationId": request["authorization_id"], "envelope": envelope}
        row = MediaRepo.add_attempt(s, {"task_id": task_id, "attempt_id": attempt_id,
            "worker_id": worker.id, "worker_owner_id": worker.owner_id, "device_id": d["device_id"],
            "connection_epoch": d["connection_epoch"], "lease_epoch": epoch,
            "lease_expires_at": expires, "envelope": payload, "state": "staged", "event_sequence": 0})
        WorkloadRepo.update_status(s, task_id, WorkloadStatus.RUNNING, started_at=datetime.utcnow(), error="")
        return row
    WorkloadRepo.update_status(s, task_id, WorkloadStatus.WAITING_FOR_WORKERS, error="等待符合官方档位和机主授权的设备")
    return None


async def start_media(task_id):
    from platform_v8.storage.db import session_scope
    def stage():
        with session_scope() as s:
            try:
                stage_dispatch(s, task_id)
            except MediaProfileError:
                w = WorkloadRepo.by_id(s, task_id)
                if w and not w.is_terminal and MediaRepo.attempt(s, task_id) is None:
                    WorkloadRepo.update_status(s, task_id, WorkloadStatus.WAITING_FOR_WORKERS,
                                               error="媒体官方服务暂未就绪，等待原任务")
            s.commit()
    await asyncio.to_thread(stage)
    return {"dispatched": 0, "queued": True}


def current_order(s, task_id, attempt_id, epoch):
    w, a = WorkloadRepo.by_id(s, task_id), MediaRepo.attempt(s, task_id)
    if (w is None or a is None or a["attempt_id"] != attempt_id or a["lease_epoch"] != epoch
            or w.is_terminal or int(time.time()) >= a["lease_expires_at"]):
        raise MediaProfileError("媒体订单/租约不再有效")
    payload = a["envelope"]
    now = int(time.time())
    return sign({"schema": "qianshou.formal-media-current-order.v1",
        "purpose": "qianshou:formal-media-order-current", "taskId": task_id,
        "attemptId": attempt_id, "deviceId": a["device_id"],
        "ownerId": payload["envelope"]["authorization"]["payload"]["ownerId"],
        "accountId": w.owner_id, "leaseEpoch": epoch, "leaseExpiresAt": payload["leaseExpiresAt"],
        "plan_sha256": w.spec.media_profile["plan_sha256"], "plan": w.spec.media_profile,
        "spec": payload["envelope"]["spec"], "quoteId": payload["quoteId"],
        "authorizationId": payload["authorizationId"], "status": a["state"],
        "issued_at": now, "expires_at": now + 60})


def _release_slot(s, attempt):
    s.execute(update(workers_t).where(workers_t.c.id == attempt["worker_id"],
        workers_t.c.active_shards > 0).values(active_shards=workers_t.c.active_shards - 1))


def settle_verified_result(s, w, attempt, signed_verdict, *, stored_receipt=False):
    """Independent mechanical verdict -> one atomic real ledger settlement."""
    from platform_v8.services.economy import ledger, split
    from platform_v8.storage.repo import ledger_t
    verdict = verify(signed_verdict, schema="qianshou.formal-media-result.v1",
                     purpose="qianshou:formal-media-result", stored_receipt=stored_receipt)
    plan = w.spec.media_profile
    expected = {"taskId": w.id, "attemptId": attempt["attempt_id"], "deviceId": attempt["device_id"],
        "ownerId": str(w.owner_id), "leaseEpoch": attempt["lease_epoch"],
        "plan_sha256": plan["plan_sha256"], "profile_id": plan["profile_id"],
        "profile_version": plan["profile_version"]}
    if any(verdict.get(k) != v for k, v in expected.items()) or verdict["issued_at"] > attempt["lease_expires_at"]:
        raise MediaProfileError("广州结果与当前冻结订单/设备/租约不匹配")
    revision = verdict.get("resultRevision")
    if verdict.get("status") == "rejected":
        if (verdict.get("reason") != "media_rejected" or not isinstance(revision, str)
                or not re.fullmatch(r"[0-9a-f]{64}", revision)
                or verdict.get("billableResultRevision") != revision):
            raise MediaProfileError("媒体失败结果合同无效")
        if MediaRepo.settlement(s, w.id) or w.is_terminal:
            return {"settled": False, "deliveryOnly": True}
        ledger.refund(s, account_id=w.owner_id, amount=w.budget, workload_id=w.id,
                      reason="media_file_integrity_rejected")
        s.execute(update(attempts_t).where(attempts_t.c.attempt_id == attempt["attempt_id"])
                  .values(state="failed", result_revision=revision))
        WorkloadRepo.update_status(s, w.id, WorkloadStatus.FAILED,
            error="媒体文件机械验真失败，托管已退款", completed_at=datetime.utcnow())
        _release_slot(s, attempt)
        return {"settled": False, "refunded": True}
    if (not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{64}", revision)
            or verdict.get("billableResultRevision") != revision or verdict.get("status") != "verified"
            or verdict.get("reason") is not None):
        raise MediaProfileError("广州机械验真未通过，禁止结算")
    f = verdict.get("file")
    required_file = {"object_key", "object_version_id", "sha256", "size_bytes", "content_type",
                     "width", "height", "fps_num", "fps_den", "seconds_ms"}
    video = plan["capability"] == "video"
    if (not isinstance(f, dict) or set(f) != required_file
            or not isinstance(verdict.get("assetId"), str)
            or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", verdict["assetId"])
            or not isinstance(f.get("object_key"), str) or not 1 <= len(f["object_key"]) <= 1024
            or not isinstance(f.get("object_version_id"), str) or not 1 <= len(f["object_version_id"]) <= 200
            or f["object_version_id"].lower() == "null"
            or not isinstance(f.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", f["sha256"])
            or type(f.get("size_bytes")) is not int or not 1 <= f["size_bytes"] <= 64 * 1024 * 1024
            or f.get("width") != plan["width"] or f.get("height") != plan["height"]
            or (video and (f.get("content_type") != "video/mp4"
                or type(f.get("fps_num")) is not int or type(f.get("fps_den")) is not int
                or f["fps_den"] <= 0 or f["fps_num"] != plan["fps"] * f["fps_den"]
                or type(f.get("seconds_ms")) is not int
                or abs(f["seconds_ms"] - plan["seconds"] * 1000) > (1000 + plan["fps"] - 1) // plan["fps"]))
            or (not video and (f.get("content_type") not in {"image/png", "image/jpeg", "image/webp"}
                              or f.get("fps_num") is not None or f.get("fps_den") is not None
                              or f.get("seconds_ms") is not None))):
        raise MediaProfileError("广州机械结果规格与官方档位不匹配")
    from platform_v8.storage.media_repo import objects_t
    object_row = s.execute(select(objects_t).where(objects_t.c.id == "result:" + attempt["attempt_id"])).one_or_none()
    if (object_row is None or object_row.account_id != w.owner_id or object_row.asset_id != verdict["assetId"]
            or any(getattr(object_row, k) != f[k] for k in
                   ("object_key", "object_version_id", "sha256", "size_bytes", "content_type"))):
        raise MediaProfileError("媒体签名结果不是原冻结写入/读取版本，禁止结算")
    existing = MediaRepo.settlement(s, w.id)
    if existing:
        if existing["result_revision"] != revision or existing["verdict_sha256"] != digest(verdict):
            raise MediaProfileError("媒体结果已冻结结算，不能替换 revision 或重新计费")
        return existing["receipt"]
    if w.is_terminal or attempt["state"] in {"failed", "cancelled", "settled"}:
        raise MediaProfileError("媒体任务已终止，不能结算")
    request = MediaRepo.request_by_task(s, w.id)
    escrow = s.execute(select(ledger_t).where(ledger_t.c.idempotent_key == "escrow:" + w.id)).one_or_none()
    if escrow is None or escrow.account_id != w.owner_id or Decimal(escrow.amount) != -w.budget:
        raise MediaProfileError("媒体任务缺真实托管账本，禁止结算")
    frozen = request["authorization"]
    if frozen["price"]["total_yuan"] != str(w.budget):
        # DB numeric loads may append trailing zeroes; compare exact decimal value.
        if Decimal(frozen["price"]["total_yuan"]) != w.budget:
            raise MediaProfileError("媒体报价与托管金额不匹配")
    cfgraw = frozen["split"]
    cfg = split.SplitConfig(**{k: Decimal(v) if k.endswith("_ratio") else v for k, v in cfgraw.items()})
    allocation = split.compute_split(w.budget,
        [split.NodeContribution(attempt["worker_id"], attempt["worker_owner_id"])], cfg)
    # Keep the frozen GMV exact after 4-decimal rounding.
    total = sum(amount for _, amount in allocation.node_payouts) + allocation.platform_pool + allocation.channel_pool
    allocation.platform_pool += w.budget - total
    receipt = {"taskId": w.id, "attemptId": attempt["attempt_id"], "leaseEpoch": attempt["lease_epoch"],
        "resultRevision": revision, "billableResultRevision": revision, "settled": True,
        "ledgerReceiptId": "release:" + w.id, "currency": "CNY", "amount": str(w.budget)}
    s.execute(insert(settlements_t).values(workload_id=w.id, attempt_id=attempt["attempt_id"],
        result_revision=revision, billable_result_revision=revision,
        verdict_sha256=digest(verdict), receipt=receipt))
    for owner_id, amount in allocation.node_payouts:
        if amount > 0:
            ledger.reward(s, worker_owner_id=owner_id, amount=amount, workload_id=w.id,
                idempotent_suffix="media-node", worker_id=attempt["worker_id"], basis="node_compute")
    for owner_id, amount, suffix in ((cfg.platform_account_id, allocation.platform_pool, "platform"),
                                    (cfg.channel_account_id, allocation.channel_pool, "channel")):
        if amount > 0:
            if not owner_id or AccountRepo.by_id(s, owner_id) is None:
                raise MediaProfileError("媒体冻结分润受益账号不可用")
            ledger.reward(s, worker_owner_id=owner_id, amount=amount, workload_id=w.id,
                          idempotent_suffix=suffix, basis="none")
    ledger.escrow_release(s, account_id=w.owner_id, amount=w.budget, workload_id=w.id)
    WorkloadRepo.update_result(s, w.id, WorkloadResult(output_ref=json.dumps({"assetId": verdict["assetId"]}),
        metadata={"media_result": verdict, "settlement": receipt}))
    s.execute(update(workloads_t).where(workloads_t.c.id == w.id).values(spent=w.budget,
        status=WorkloadStatus.DONE.value, progress=1.0, completed_shards=1,
        completed_at=datetime.utcnow(), updated_at=datetime.utcnow(), error=""))
    s.execute(update(attempts_t).where(attempts_t.c.attempt_id == attempt["attempt_id"])
              .values(state="settled", result_revision=revision))
    _release_slot(s, attempt)
    MediaRepo.enqueue(s, attempt["attempt_id"], "settlement", {k: receipt[k] for k in
        ("taskId", "attemptId", "leaseEpoch", "resultRevision", "billableResultRevision", "settled", "ledgerReceiptId")})
    return receipt


def consume_event(s, event, *, stored_receipt=False):
    """Duplicate/reordered events cannot change immutable billing or leases."""
    sequence = event.get("sequence")
    if type(sequence) is not int or sequence <= 0:
        raise MediaProfileError("媒体事件序号无效")
    event_hash = digest(event)
    prior = s.execute(select(events_t).where(events_t.c.sequence == sequence)).one_or_none()
    if prior:
        if prior.event_sha256 != event_hash:
            raise MediaProfileError("媒体全局事件序号发生改写")
        return prior.disposition
    task_id = event.get("taskId")
    w = WorkloadRepo.by_id_for_update(s, task_id)
    a = MediaRepo.attempt(s, task_id, lock=True)
    disposition = "ignored_stale"
    node_sequence = event.get("nodeEventSequence")
    payload = event.get("payload")
    if not isinstance(payload, dict):
        raise MediaProfileError("媒体事件payload无效")
    source = event.get("source")
    if (w is not None and a is not None and event.get("attemptId") == a["attempt_id"]
            and event.get("leaseEpoch") == a["lease_epoch"]
            and (source in {"verdict", "settlement"}
                 or (source == "node" and type(node_sequence) is int and node_sequence > a["event_sequence"]))):
        stage = payload.get("stage")
        if source == "verdict":
            receipt = settle_verified_result(s, w, a, payload.get("verdict"), stored_receipt=stored_receipt)
            disposition = "settled" if receipt.get("settled") is True else "refunded"
        elif w.is_terminal or a["state"] == "settled":
            disposition = "delivery_only"
        elif stage in {"accepted", "running", "uploading", "awaiting_settlement"}:
            s.execute(update(attempts_t).where(attempts_t.c.attempt_id == a["attempt_id"])
                      .values(state=stage))
            percent = payload.get("percent")
            if type(percent) in {int, float} and 0 <= percent <= 100:
                s.execute(update(workloads_t).where(workloads_t.c.id == w.id)
                          .values(progress=min(percent / 100, .99), updated_at=datetime.utcnow()))
            disposition = "progress"
            if stage == "awaiting_settlement" and payload.get("assetId") is not None:
                artifact = payload.get("artifact")
                allowed = {"object_key", "object_version_id", "sha256", "size_bytes", "content_type"}
                if not isinstance(artifact, dict) or set(artifact) != allowed:
                    raise MediaProfileError("媒体输出声明只能包含不可变对象元数据")
                MediaRepo.enqueue(s, a["attempt_id"], "results/verify", {"taskId": w.id,
                    "attemptId": a["attempt_id"], "leaseEpoch": a["lease_epoch"],
                    "assetId": payload["assetId"], "artifact": artifact})
        elif stage in {"failed", "cancelled"}:
            # Gateway must confirm terminal state using the same service signed
            # current-task receipt. A node's unverified terminal claim is not money authority.
            if payload.get("terminalReceipt") is None:
                # Node terminal claims are observational events. Record/ack them
                # while awaiting the independent gateway terminal confirmation.
                s.execute(insert(events_t).values(sequence=sequence, event_sha256=event_hash,
                    payload=event, disposition="awaiting_terminal_receipt"))
                kv_set(s, CURSOR_KEY, max(int(kv_get(s, CURSOR_KEY, 0)), sequence))
                return "awaiting_terminal_receipt"
            terminal = verify(payload.get("terminalReceipt"), schema="qianshou.formal-media-terminal.v1",
                              purpose="qianshou:formal-media-terminal")
            expected = {"taskId": w.id, "attemptId": a["attempt_id"], "leaseEpoch": a["lease_epoch"],
                        "plan_sha256": w.spec.media_profile["plan_sha256"], "status": stage}
            if any(terminal.get(k) != v for k, v in expected.items()):
                raise MediaProfileError("媒体终止确认不匹配，禁止退款")
            from platform_v8.services.economy import ledger
            ledger.refund(s, account_id=w.owner_id, amount=w.budget, workload_id=w.id,
                          reason="media_" + stage)
            s.execute(update(attempts_t).where(attempts_t.c.attempt_id == a["attempt_id"]).values(state=stage))
            WorkloadRepo.update_status(s, w.id, WorkloadStatus.CANCELLED if stage == "cancelled" else WorkloadStatus.FAILED,
                error="媒体任务终止，托管已退款", completed_at=datetime.utcnow())
            _release_slot(s, a)
            disposition = "refunded"
        if source == "node":
            s.execute(update(attempts_t).where(attempts_t.c.attempt_id == a["attempt_id"])
                      .values(event_sequence=node_sequence))
    s.execute(insert(events_t).values(sequence=sequence, event_sha256=event_hash,
                                     payload=event, disposition=disposition))
    previous_cursor = kv_get(s, CURSOR_KEY, 0)
    kv_set(s, CURSOR_KEY, max(int(previous_cursor), sequence))
    return disposition


def cancel_media(s, w):
    """Once dispatched, request cancellation; refund only a signed stopped receipt."""
    from platform_v8.services.economy import ledger
    w = WorkloadRepo.by_id_for_update(s, w.id)
    if w.is_terminal:
        raise MediaProfileError("媒体任务已终止")
    a = MediaRepo.attempt(s, w.id, lock=True)
    unsent = False
    if a is not None:
        op = s.execute(select(outbox_t).where(outbox_t.c.id == a["attempt_id"] + ":dispatch").with_for_update()).one_or_none()
        unsent = op is not None and op.state == "pending"
    if a is None or unsent:
        ledger.refund(s, account_id=w.owner_id, amount=w.budget, workload_id=w.id, reason="media_cancel_before_dispatch")
        WorkloadRepo.update_status(s, w.id, WorkloadStatus.CANCELLED, completed_at=datetime.utcnow())
        if a:
            MediaRepo.complete_operation(s, a["attempt_id"] + ":dispatch", state="cancelled")
            s.execute(update(attempts_t).where(attempts_t.c.attempt_id == a["attempt_id"]).values(state="cancelled"))
            _release_slot(s, a)
    else:
        MediaRepo.enqueue(s, a["attempt_id"], "cancel", {"taskId": w.id,
            "attemptId": a["attempt_id"], "leaseEpoch": a["lease_epoch"]})
        WorkloadRepo.update_status(s, w.id, w.status, error="正在确认原媒体任务停止；停止确认后退还托管")
    return WorkloadRepo.by_id(s, w.id)


def process_outbox(client, *, session_scope, now=None):
    now = int(time.time()) if now is None else now
    with session_scope() as s:
        operations = MediaRepo.pending_operations(s, now)
    for op in operations:
        key, operation = op["id"], op["operation"]
        is_send = False
        if op["state"] == "pending":
            with session_scope() as s:
                if operation == "dispatch":
                    a = MediaRepo.attempt(s, op["payload"]["taskId"], lock=True)
                    w = WorkloadRepo.by_id_for_update(s, op["payload"]["taskId"])
                    if w is None or w.is_terminal or a is None or now >= a["lease_expires_at"]:
                        continue
                    # Preserve the original reservation. Check withdrawals and
                    # official service validity again before its first send.
                    try:
                        _preflight(s, w.spec.media_profile)
                    except MediaProfileError:
                        continue
                    worker = WorkerRepo.by_id(s, a["worker_id"])
                    if worker is None:
                        continue
                    reserved_worker = type(worker)(**vars(worker))
                    reserved_worker.active_shards = 0
                    if not worker_matches_media_plan(reserved_worker, w.spec.media_profile,
                            bindings=load_device_bindings(s), now=now):
                        continue
                is_send = MediaRepo.claim(s, key, now)
                s.commit()
            if not is_send:
                continue
        # A process crash may occur after HTTP reached Guangzhou. Never POST
        # another dispatch from sending/unknown, even when task lookup is 404.
        try:
            if operation == "dispatch" and not is_send:
                response = client.post("task", {"taskId": op["payload"]["taskId"],
                                                "attemptId": op["payload"]["attemptId"]})
                remote = response.get("task")
                if (response.get("ok") is not True or not isinstance(remote, dict)
                        or any(remote.get(k) != v for k, v in op["payload"].items())):
                    raise MediaProfileError("媒体派发未知，仅可继续核对原任务")
            else:
                response = client.post(operation, op["payload"])
                if response.get("ok") is not True or (operation == "results/verify" and response.get("published") is not True):
                    raise MediaProfileError("媒体控制操作未确认")
            with session_scope() as s:
                MediaRepo.complete_operation(s, key, state="complete")
                if operation == "dispatch":
                    s.execute(update(attempts_t).where(attempts_t.c.attempt_id == op["attempt_id"],
                        attempts_t.c.state == "staged").values(state="accepted"))
                s.commit()
        except Exception:
            with session_scope() as s:
                MediaRepo.complete_operation(s, key, state="unknown")
                s.commit()
            # Log only static operation/status; never service tokens or media prompts.
            log.warning("media control acknowledgement unavailable operation=%s", operation)


def poll_once(client=None, *, session_scope=None):
    if session_scope is None:
        from platform_v8.storage.db import session_scope
    client = client or GatewayClient()
    try:
        nonce = str(uuid4())
        catalog = client.post("profiles", {"nonce": nonce}).get("catalog")
        with session_scope() as s:
            sync_catalog(s, catalog, nonce=nonce)
            s.commit()
        nonce = str(uuid4())
        response = client.post("preflight", {"nonce": nonce})
        envelope = response.get("preflight")
        payload = verify(envelope, schema="qianshou.formal-media-preflight.v1",
                         purpose="qianshou:formal-media-preflight")
        if payload.get("nonce") != nonce or payload["expires_at"] - payload["issued_at"] > 30:
            raise MediaProfileError("媒体预检challenge无效")
        nodes = client.post("nodes", {})
        qualification_nonce = str(uuid4())
        qualification = client.post("devices/verified", {"nonce": qualification_nonce}).get("qualification")
        with session_scope() as s:
            kv_set(s, PREFLIGHT_KEY, envelope)
            sync_qualifications(s, qualification, nonce=qualification_nonce)
            project_directory(s, nodes)
            s.commit()
    except Exception:
        log.warning("media catalog/preflight refresh unavailable; existing task reconciliation continues")
    with session_scope() as s:
        queued = s.execute(select(requests_t.c.workload_id).join(workloads_t,
            requests_t.c.workload_id == workloads_t.c.id).where(workloads_t.c.status.in_(
            [WorkloadStatus.CREATED.value, WorkloadStatus.WAITING_FOR_WORKERS.value])).limit(100)).all()
    for row in queued:
        with session_scope() as s:
            try:
                stage_dispatch(s, row.workload_id)
                s.commit()
            except MediaProfileError:
                s.rollback()
    process_outbox(client, session_scope=session_scope)
    with session_scope() as s:
        after = int(kv_get(s, CURSOR_KEY, 0))
    consumer = "shanghai-formal-media-v1"
    feed = client.post("events/read", {"consumerId": consumer, "afterSequence": after, "limit": 128})
    events = feed.get("events")
    if feed.get("ok") is not True or not isinstance(events, list) or len(events) > 128:
        raise MediaProfileError("广州事件feed不可用")
    previous = after
    for event in events:
        if not isinstance(event, dict) or type(event.get("sequence")) is not int or event["sequence"] <= previous:
            raise MediaProfileError("广州事件feed乱序，禁止跳过")
        stored_receipt = False
        if event.get("source") == "verdict":
            # Guangzhou checked expiry before persisting this signed verdict.
            # Recover the same durable receipt, not a new GPU run, after downtime.
            remote = client.post("task", {"taskId": event["taskId"], "attemptId": event["attemptId"]}).get("task")
            with session_scope() as s:
                local = MediaRepo.attempt(s, event["taskId"])
            if (not isinstance(remote, dict) or local is None
                    or remote.get("verdict") != event.get("payload", {}).get("verdict")
                    or any(remote.get(k) != v for k, v in local["envelope"].items())):
                raise MediaProfileError("持久媒体结果与广州原任务不匹配")
            stored_receipt = True
        with session_scope() as s:
            consume_event(s, event, stored_receipt=stored_receipt)
            s.commit()  # verdict/ledger/cursor committed before acknowledging the feed
        previous = event["sequence"]
    if previous:
        ack = client.post("events/ack", {"consumerId": consumer, "sequence": previous})
        if ack.get("ok") is not True:
            raise MediaProfileError("广州事件ack未知；仅重放原cursor")
    process_outbox(client, session_scope=session_scope)
    return {"events": len(events), "sequence": previous}


async def consumer_loop():
    while True:
        try:
            await asyncio.to_thread(poll_once)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Signing/preflight/authentication failures leave admission closed.
            log.warning("formal media control unavailable; admission remains fail closed")
        await asyncio.sleep(10)


def task_status(s, w):
    request, attempt = MediaRepo.request_by_task(s, w.id), MediaRepo.attempt(s, w.id)
    if request is None:
        raise MediaProfileError("任务不属于正式媒体通道")
    settlement = MediaRepo.settlement(s, w.id)
    verdict = (w.result.metadata or {}).get("media_result") if w.result else None
    result = None
    viewer = None
    if settlement and verdict:
        f = verdict["file"]
        result = {"assetId": verdict["assetId"], "capability": w.spec.media_profile["capability"],
            "sha256": f["sha256"], "sizeBytes": f["size_bytes"], "contentType": f["content_type"],
            "width": f["width"], "height": f["height"], "fpsNum": f["fps_num"],
            "fpsDen": f["fps_den"], "secondsMs": f["seconds_ms"], "resultRevision": verdict["resultRevision"]}
        bucket = os.getenv("V8_MEDIA_RESULT_BUCKET", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{3,128}", bucket):
            raise MediaProfileError("媒体交付bucket未配置，保留原结算仅恢复交付")
        now = int(time.time())
        grant = sign({"schema": "qianshou.media-view-grant.v1", "audience": "guangzhou-result-media",
            "account_id": w.owner_id, "task_id": w.id, "asset_id": verdict["assetId"], "bucket": bucket,
            "object_key": f["object_key"], "object_version_id": f["object_version_id"], "sha256": f["sha256"],
            "size_bytes": f["size_bytes"], "content_type": f["content_type"], "result_finalized": True,
            "media_attested": True, "issued_at": now, "expires_at": now + 300}, role="viewer")
        viewer = base64.urlsafe_b64encode(canonical(grant)).rstrip(b"=").decode()
    phase = attempt["state"] if attempt else "waiting"
    if settlement:
        op = s.execute(select(outbox_t).where(outbox_t.c.id == settlement["attempt_id"] + ":settlement")).one_or_none()
        phase = "settled" if op and op.state == "complete" else "delivery_pending"
    phase = {"staged": "waiting", "accepted": "waiting", "uploading": "running"}.get(phase, phase)
    return {"ok": True, "taskId": w.id, "requestId": request["request_id"],
        "attemptId": attempt["attempt_id"] if attempt else None,
        "leaseEpoch": attempt["lease_epoch"] if attempt else None, "status": w.status.value, "phase": phase,
        "progress": w.progress if attempt and attempt["event_sequence"] > 0 else None,
        "elapsedSeconds": max(0, int((datetime.utcnow() - w.created_at).total_seconds())),
        "resultMetadata": result, "settlement": settlement["receipt"] if settlement else None,
        "viewerReceipt": viewer}
