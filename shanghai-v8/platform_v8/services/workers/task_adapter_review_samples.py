"""Unpaid, quarantined audit sample jobs for a candidate media adapter.

The producer is an independent registered Mac compute worker. Shanghai creates real
workload/shard identities, grants one fixed-key result upload per attempt and
stores only signed control metadata. Guangzhou independently verifies locked
media. These jobs never enter the paid scheduler or settlement path.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import time
from urllib.parse import urlsplit
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from uuid import uuid4

from sqlalchemy import insert, or_, select, update
from sqlalchemy.orm import Session

from platform_v8.core import Shard, ShardStatus, Workload, WorkloadSpec, WorkloadStatus
from platform_v8.protocol.artifact import build_object_key
from platform_v8.services import artifact_issuance_receipt, external_media_verifier
from platform_v8.services.artifact_lease import mint_lease_token, verify_lease_token
from platform_v8.services.workers import task_adapter_evidence_storage as evidence_storage
from platform_v8.services.workers import task_adapter_package_upload as package_upload
from platform_v8.services.workers import task_adapter_publications as publications
from platform_v8.storage.repo import (
    AccountRepo, AuditRepo, ShardRepo, WorkerRepo, WorkloadRepo,
    task_adapter_author_manifests_t as manifests_t,
    task_adapter_media_revalidation_t as revalidation_t,
    task_adapter_package_uploads_t as uploads_t,
    task_adapter_review_samples_t as samples_t,
    task_adapter_publications_t as publications_t,
    shards_t, workers_t,
)

_RECIPE = json.dumps({
    "kind": "bar_chart_svg_v1", "title": "接单验收", "unit": "单",
    "durationSeconds": 5, "fps": 20, "width": 640, "height": 360,
    "bars": [{"label": "一月", "value": 18, "color": "#4f8cff"},
             {"label": "二月", "value": 42, "color": "#28b5a3"},
             {"label": "三月", "value": 78, "color": "#f2b55c"}],
}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
_RECIPE_SHA = hashlib.sha256(_RECIPE.encode()).hexdigest()
_FORMAT_MIME = {"gif": "image/gif", "mp4": "video/mp4"}
_HEX = re.compile(r"[0-9a-f]{64}\Z")
_VERSION = re.compile(r"[A-Za-z0-9_.~+-]{1,200}\Z")
_SAMPLE_TTL = 3600
_UPLOAD_TTL = 900
_HEARTBEAT_TTL = 60
_MAX_SAMPLE_ATTEMPTS = 3


class ReviewSampleError(publications.PublicationError):
    pass


class ReviewSampleUnavailable(ReviewSampleError):
    pass


def _lease_expired(value: datetime | None) -> bool:
    if value is None:
        return True
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value <= datetime.now(timezone.utc)


def _enabled() -> None:
    import os
    if os.environ.get("V8_TASK_ADAPTER_REVIEW_SAMPLES_ENABLED") != "1":
        raise ReviewSampleUnavailable("平台尚未启用独立审核样单")


def _row(s: Session, publication_id: str, owner_id: int | None = None,
         *, lock: bool = False) -> dict[str, Any]:
    row = publications._get(s, publication_id, lock=lock)
    if owner_id is not None and row["owner_id"] != owner_id:
        raise publications.PublicationNotFound("接单技能投稿不存在")
    if row["status"] != "review":
        raise publications.PublicationConflict("仅待审核投稿可生成独立样单")
    return row


def _archive(s: Session, row: dict[str, Any]) -> dict[str, Any]:
    upload = s.execute(select(uploads_t).where(
        uploads_t.c.publication_id == row["id"])).mappings().first()
    manifest = s.execute(select(manifests_t).where(
        manifests_t.c.publication_id == row["id"])).mappings().first()
    if (upload is None or upload["status"] != "confirmed"
            or upload["owner_id"] != row["owner_id"]
            or manifest is None or manifest["owner_id"] != row["owner_id"]
            or manifest["artifact_digest"] != row["artifact_digest"]
            or manifest["package_digest"] != row["package_digest"]
            or upload["lock_retain_until"] is None or not upload["version_id"]):
        raise ReviewSampleError("请先完成作者签名和受锁源码归档确认")
    lock = upload["lock_retain_until"]
    if lock.tzinfo is None:
        lock = lock.replace(tzinfo=timezone.utc)
    # The independent Mac lease can use its full hour before Guangzhou signs
    # a new 24-hour package receipt. Leave a small clock/network margin too.
    if lock.timestamp() <= time.time() + _SAMPLE_TTL + 86400 + 300:
        raise ReviewSampleError("归档锁期不足以覆盖样单租约和独立验收回执")
    from platform_v8.services.workers.task_adapter_publisher_identity import active_key
    try:
        active_key(s, owner_id=row["owner_id"], key_id=manifest["key_id"])
    except Exception as exc:
        raise ReviewSampleError("作者签名公钥不可用") from exc
    return {"bucket": upload["bucket"], "object_key": upload["object_key"],
            "object_version_id": upload["version_id"],
            "sha256": upload["archive_digest"], "size_bytes": upload["size_bytes"]}


def _publisher(s: Session, row: dict[str, Any]) -> dict[str, Any]:
    manifest = s.execute(select(manifests_t).where(
        manifests_t.c.publication_id == row["id"])).mappings().one()
    from platform_v8.services.workers.task_adapter_publisher_identity import active_key
    key = active_key(s, owner_id=row["owner_id"], key_id=manifest["key_id"])
    return {"publisher_owner_id": row["owner_id"],
            "publisher_key_id": manifest["key_id"],
            "publisher_public_key": key["public_key"],
            "author_manifest": manifest["manifest"]}


def _archive_download_grant(archive: dict[str, Any]) -> dict[str, Any]:
    """Exact-version short GET for the registered compute worker, no Shanghai bytes."""
    try:
        storage = evidence_storage.provider()
        if (storage.bucket != archive["bucket"]
                or storage._full_key(archive["object_key"]) != archive["object_key"]):
            raise ReviewSampleError("审核证据桶与原始归档不一致")
        expires = 300
        url = storage._public.generate_presigned_url(
            "get_object", Params={"Bucket": archive["bucket"],
                                  "Key": archive["object_key"],
                                  "VersionId": archive["object_version_id"]},
            ExpiresIn=expires, HttpMethod="GET")
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                or parsed.password or len(url) > 8192):
            raise ReviewSampleError("审核归档精确版本下载授权不安全")
        return {"url": url, "expires_at": int(time.time()) + expires}
    except ReviewSampleError:
        raise
    except Exception as exc:
        raise ReviewSampleUnavailable("审核归档精确版本下载授权不可用") from exc


def _jobs(s: Session, publication_id: str) -> dict[str, dict[str, Any]]:
    rows = s.execute(select(samples_t).where(
        samples_t.c.publication_id == publication_id)).mappings().all()
    return {row["format"]: dict(row) for row in rows}


def _summary(s: Session, row: dict[str, Any]) -> dict[str, Any]:
    jobs = _jobs(s, row["id"])
    media = (row["review_evidence"] or {}).get("media")
    stored = s.execute(select(revalidation_t.c.media_receipt_sha256).where(
        revalidation_t.c.publication_id == row["id"])).scalar_one_or_none()
    issue = (publications._receipt_issue("media", media, row, reviewer_id=None,
                                        now=int(time.time()), roots=publications._roots())
             if media is not None else "missing")
    media_status = ("missing" if media is None else "valid" if issue is None and
                    stored == "sha256:" + publications._digest(media) else "invalid")
    sample_status = {fmt: {"status": jobs[fmt]["status"] if fmt in jobs else "missing",
                           "workload_id": str(jobs[fmt]["workload_id"]) if fmt in jobs else None,
                           "shard_id": str(jobs[fmt]["shard_id"]) if fmt in jobs else None}
                     for fmt in _FORMAT_MIME}
    if media_status == "valid":
        status = "evidence_deposited"
    elif not jobs:
        status = "blocked"
    elif any(job["status"] in {"leased", "upload_issued"}
             and _lease_expired(job["lease_expires_at"])
             for job in jobs.values()):
        status = "blocked"
    elif all(job["status"] == "verified" for job in jobs.values()) and any(
            not isinstance(job["verify_receipt"], dict)
            or not isinstance(job["verify_receipt"].get("payload"), dict)
            or job["verify_receipt"]["payload"].get("expires_at", 0) <= time.time()
            for job in jobs.values()):
        status = "blocked"
    elif all(job["status"] == "verified" for job in jobs.values()):
        status = "verified"
    elif any(job["status"] != "pending" for job in jobs.values()):
        status = "running"
    else:
        status = "pending"
    return {"publication_id": row["id"], "status": status,
            "samples": sample_status, "media_evidence_status": media_status}


def status(s: Session, *, publication_id: str, owner_id: int) -> dict[str, Any]:
    row = publications._get(s, publication_id)
    if row["owner_id"] != owner_id:
        raise publications.PublicationNotFound("接单技能投稿不存在")
    return _summary(s, row)


def start(s: Session, *, publication_id: str, owner_id: int) -> dict[str, Any]:
    _enabled()
    row = _row(s, publication_id, owner_id, lock=True)
    existing = _jobs(s, publication_id)
    if existing:
        if set(existing) != set(_FORMAT_MIME):
            raise ReviewSampleError("审核样单创建不完整，需人工修复")
        return _summary(s, row)
    _archive(s, row)
    reviewed_spec = publications._spec_for_row(row)
    policy = external_media_verifier._reviewed_policy(row["task_type"], reviewed_spec)
    if (policy is None or set(policy.formats) != set(_FORMAT_MIME)
            or policy.mime_types != _FORMAT_MIME
            or policy.recipe_validator is None):
        raise ReviewSampleError("该任务尚无对应媒体验收策略的双样单配方")
    if not publications._external_media_verifier_ready(row["task_type"], reviewed_spec):
        raise ReviewSampleUnavailable("广州独立媒体验证服务尚未在线")
    for fmt in _FORMAT_MIME:
        policy.recipe_validator(input_kind="inline", inline_input=_RECIPE,
                                params={"output_format": fmt})
        spec = WorkloadSpec(
            task_type=row["task_type"], input_kind="inline", inline_input=_RECIPE,
            params={"output_format": fmt, "review_sample_publication_id": row["id"],
                    "review_sample_only": True}, max_shards=1,
            verification_policy="quarantine", timeout_s=_SAMPLE_TTL,
        )
        workload = Workload(owner_id=owner_id, name=f"独立审核样单 {fmt.upper()}",
                            spec=spec, status=WorkloadStatus.QUARANTINED,
                            budget=Decimal("0"), total_shards=1)
        WorkloadRepo.create(s, workload)
        shard = Shard(workload_id=workload.id, index=0, total=1,
                      status=ShardStatus.PENDING, max_attempts=_MAX_SAMPLE_ATTEMPTS,
                      metadata={"review_sample_publication_id": row["id"],
                                "review_sample_format": fmt,
                                "review_sample_only": True})
        ShardRepo.create_batch(s, [shard])
        s.execute(insert(samples_t).values(
            publication_id=row["id"], format=fmt, owner_id=owner_id,
            workload_id=workload.id, shard_id=shard.id,
            recipe_sha256=_RECIPE_SHA, status="pending"))
    AuditRepo.write(s, action="task_adapter_publication.review_samples_start",
                    actor_account_id=owner_id, actor_kind="account",
                    target_kind="task_adapter_pub", target_id=row["id"],
                    detail={"formats": list(_FORMAT_MIME), "unpaid": True})
    s.flush()
    return _summary(s, row)


def pending(s: Session) -> dict[str, Any]:
    _enabled()
    # Only whole pairs which still have no issued result are actionable. A
    # half-uploaded or expired pair needs a fresh publication version; never
    # silently reuse a signed issuance or an expiring media receipt.
    rows = s.execute(select(samples_t).join(
        publications_t, publications_t.c.id == samples_t.c.publication_id,
    ).outerjoin(
        revalidation_t, revalidation_t.c.publication_id == samples_t.c.publication_id,
    ).where(
        publications_t.c.status == "review",
        revalidation_t.c.publication_id.is_(None),
        samples_t.c.status.in_(["pending", "leased"]),
    ).limit(100)).mappings().all()
    grouped: dict[str, dict[str, dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(row["publication_id"], {})[row["format"]] = dict(row)
    import os
    worker_id = os.environ.get("V8_TASK_ADAPTER_REVIEW_RUNNER_WORKER_ID", "").strip()
    items = []
    for publication_id, jobs in grouped.items():
        if set(jobs) != set(_FORMAT_MIME):
            continue
        if any(job["status"] == "leased" and (
                str(job["worker_id"]) != worker_id
                or (_lease_expired(job["lease_expires_at"])
                    and not _retryable_preupload(
                        s, job=job, shard=ShardRepo.by_id(s, job["shard_id"]),
                        worker_id=worker_id))) for job in jobs.values()):
            continue
        items.extend({"publication_id": publication_id, "format": fmt,
                      "status": jobs[fmt]["status"]} for fmt in _FORMAT_MIME)
    return {"items": items}


def _runner_worker(s: Session):
    import os
    worker_id = os.environ.get("V8_TASK_ADAPTER_REVIEW_RUNNER_WORKER_ID", "").strip()
    capabilities = (s.execute(select(workers_t.c.capabilities).where(
        workers_t.c.id == worker_id).with_for_update()).scalar_one_or_none()
        if worker_id else None)
    worker = WorkerRepo.by_id(s, worker_id) if worker_id else None
    account = AccountRepo.by_id(s, worker.owner_id) if worker is not None else None
    if (worker is None or account is None or not account.is_active
            or worker.onboarding_status == "banned"
            or worker.is_temporarily_disabled
            or not isinstance(capabilities, dict)
            or capabilities.get("review_only") is not True
            or capabilities.get("mode") != "active"
            or worker.capabilities.throttle_pct <= 0):
        raise ReviewSampleUnavailable("独立审核 runner 的平台注册节点不可用")
    # PostgreSQL returns UUID objects; the WebSocket broker and signed wire
    # contracts use their canonical string form.
    if not _ws_connected(str(worker.id)):
        raise ReviewSampleUnavailable("独立审核 runner 尚无真实 WebSocket 在线会话")
    return worker


def enroll_review_worker(s: Session, *, worker_id: str, owner_id: int,
                         admin_id: int) -> dict[str, Any]:
    """Operator binds one newly registered paused node to the audit identity."""
    import os
    expected = os.environ.get("V8_TASK_ADAPTER_REVIEW_RUNNER_WORKER_ID", "").strip()
    if not expected or worker_id != expected:
        raise ReviewSampleError("仅可登记平台固定的独立审核节点")
    s.execute(select(workers_t.c.id).where(
        workers_t.c.id == worker_id).with_for_update()).first()
    worker = WorkerRepo.by_id(s, worker_id)
    account = AccountRepo.by_id(s, owner_id)
    if (worker is None or worker.owner_id != owner_id
            or account is None or not account.is_active
            or worker.onboarding_status == "banned"
            or worker.is_temporarily_disabled):
        raise ReviewSampleError("审核节点未正常注册或归属不符")
    if worker.capabilities.review_only:
        return {"worker_id": worker_id, "owner_id": owner_id,
                "review_only": True, "status": "enrolled"}
    if worker.capabilities.contribute_mode != "paused":
        raise ReviewSampleError("独立审核节点必须先以暂停模式注册")
    active = s.execute(select(shards_t.c.id).where(
        or_(shards_t.c.worker_id == worker_id,
            shards_t.c.lease_by_node == worker_id),
        shards_t.c.status.in_(["DISPATCHED", "RUNNING", "LEASED"]),
    ).limit(1)).first()
    if active:
        raise ReviewSampleError("节点仍有在途分片，不可切为审核专用")
    if not WorkerRepo.update_capabilities(s, worker_id, {"review_only": True}):
        raise ReviewSampleError("审核专用节点登记失败")
    AuditRepo.write(s, action="task_adapter_publication.review_worker_enrolled",
                    actor_account_id=admin_id, actor_kind="admin",
                    target_kind="worker", target_id=worker_id,
                    detail={"owner_id": owner_id, "review_only": True})
    return {"worker_id": worker_id, "owner_id": owner_id,
            "review_only": True, "status": "enrolled"}


def revoke_review_worker(s: Session, *, worker_id: str, owner_id: int,
                         admin_id: int) -> dict[str, Any]:
    import os
    if worker_id != os.environ.get("V8_TASK_ADAPTER_REVIEW_RUNNER_WORKER_ID", "").strip():
        raise ReviewSampleError("仅可撤销平台固定的独立审核节点")
    s.execute(select(workers_t.c.id).where(
        workers_t.c.id == worker_id).with_for_update()).first()
    worker = WorkerRepo.by_id(s, worker_id)
    if worker is None or worker.owner_id != owner_id:
        raise ReviewSampleError("审核节点不存在或归属不符")
    if not worker.capabilities.review_only:
        return {"worker_id": worker_id, "owner_id": owner_id,
                "review_only": False, "status": "revoked"}
    active = s.execute(select(shards_t.c.id).where(
        or_(shards_t.c.worker_id == worker_id,
            shards_t.c.lease_by_node == worker_id),
        shards_t.c.status.in_(["DISPATCHED", "RUNNING", "LEASED"]),
    ).limit(1)).first()
    if (worker.capabilities.contribute_mode != "paused"
            or getattr(worker.status, "value", worker.status) != "OFFLINE"
            or active):
        raise ReviewSampleError("先暂停并断开审核节点，待在途分片结束后才能撤销")
    if not WorkerRepo.update_capabilities(s, worker_id, {"review_only": False}):
        raise ReviewSampleError("审核节点撤销失败")
    AuditRepo.write(s, action="task_adapter_publication.review_worker_revoked",
                    actor_account_id=admin_id, actor_kind="admin",
                    target_kind="worker", target_id=worker_id,
                    detail={"owner_id": owner_id, "review_only": False})
    return {"worker_id": worker_id, "owner_id": owner_id,
            "review_only": False, "status": "revoked"}


def _ws_connected(worker_id: str) -> bool:
    """Require live node presence; DB ONLINE and HTTP heartbeat alone cannot grant work."""
    from platform_v8.engine import broker, gateway
    if gateway.multi_enabled():
        online = gateway.online_worker_ids_global(ttl_s=45)
        return (isinstance(online, list) and worker_id in online
                and bool(gateway.get_owner(worker_id)))
    return broker.is_worker_online(worker_id)


def _active_runner(s: Session):
    """Require both the registered WS and the recent review heartbeat."""
    worker = _runner_worker(s)
    last_seen = worker.last_seen
    if last_seen is not None and last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)
    if (getattr(worker.status, "value", worker.status) not in {"ONLINE", "BUSY"}
            or last_seen is None
            or last_seen < datetime.now(timezone.utc) - timedelta(seconds=_HEARTBEAT_TTL)):
        raise ReviewSampleUnavailable("独立审核 runner 心跳已失效")
    return worker


def heartbeat(s: Session) -> dict[str, Any]:
    """Refresh only the fixed registered Mac worker behind the runner bearer."""
    _enabled()
    worker = _runner_worker(s)
    now = datetime.now(timezone.utc)
    status = getattr(worker.status, "value", worker.status)
    if status not in {"ONLINE", "BUSY"}:
        raise ReviewSampleUnavailable("独立审核 runner 的平台注册节点尚未由节点本身上线")
    changed = s.execute(update(workers_t).where(
        workers_t.c.id == worker.id,
        workers_t.c.status.in_(["ONLINE", "BUSY"]),
        or_(workers_t.c.onboarding_status.is_(None),
            workers_t.c.onboarding_status != "banned"),
        or_(workers_t.c.disabled_until.is_(None),
            workers_t.c.disabled_until <= now),
        workers_t.c.capabilities["mode"].as_string() == "active",
        workers_t.c.capabilities["review_only"].as_boolean().is_(True),
    ).values(last_seen=now))
    if changed.rowcount != 1:
        raise ReviewSampleUnavailable("独立审核 runner 已被禁用")
    return {"worker_id": str(worker.id), "status": "online",
            "last_seen_at": int(now.timestamp())}


def _restore_preupload_reclaim(s: Session, *, job: dict[str, Any], shard: Shard,
                               worker_id: str) -> Shard:
    """Repair an old ordinary-WS reclaim before any result was issued.

    The review row is the durable owner of this private lease. A reconnect may
    restore exactly the same attempt and worker; it cannot mint a second upload
    issuance or revive an expired lease. New broker code no longer reclaims
    these shards, but this handles already stranded rows from a prior process.
    """
    if shard.status != ShardStatus.PENDING:
        return shard
    workload = WorkloadRepo.by_id(s, job["workload_id"])
    if (job["status"] != "leased" or str(job["worker_id"]) != worker_id
            or _lease_expired(job["lease_expires_at"])
            or any(job.get(key) is not None for key in (
                "result_id", "sha256", "object_key", "issuance_receipt"))
            or shard.worker_id is not None
            or not 1 <= shard.attempts <= _MAX_SAMPLE_ATTEMPTS
            or str(shard.workload_id) != str(job["workload_id"])
            or not isinstance(shard.metadata, dict)
            or shard.metadata.get("review_sample_only") is not True
            or workload is None or workload.status != WorkloadStatus.QUARANTINED
            or workload.budget != 0 or not isinstance(workload.spec.params, dict)
            or workload.spec.params.get("review_sample_only") is not True):
        raise ReviewSampleError("审核样单分片状态不一致，不能恢复租约")
    metadata = dict(shard.metadata)
    excluded = metadata.get("excluded_workers")
    if isinstance(excluded, list):
        retained = [str(item) for item in excluded if str(item) != worker_id]
        if retained:
            metadata["excluded_workers"] = retained
        else:
            metadata.pop("excluded_workers", None)
    changed = s.execute(update(shards_t).where(
        shards_t.c.id == shard.id,
        shards_t.c.workload_id == job["workload_id"],
        shards_t.c.status == ShardStatus.PENDING.value,
        shards_t.c.worker_id.is_(None),
        shards_t.c.attempts == shard.attempts,
    ).values(status=ShardStatus.RUNNING.value, worker_id=worker_id,
             started_at=datetime.utcnow(), metadata=metadata))
    if changed.rowcount != 1:
        raise ReviewSampleError("审核样单分片已改变，不能恢复租约")
    AuditRepo.write(s, action="task_adapter_publication.review_sample_reconnected",
                    actor_kind="service", target_kind="task_adapter_pub",
                    target_id=job["publication_id"],
                    detail={"format": job["format"], "shard_id": str(shard.id),
                            "worker_id": worker_id, "attempt": shard.attempts})
    restored = ShardRepo.by_id(s, shard.id)
    if restored is None:
        raise ReviewSampleError("审核样单分片恢复后不可读取")
    return restored


def _retryable_preupload(s: Session, *, job: dict[str, Any],
                         shard: Shard | None, worker_id: str) -> bool:
    """An expired review lease may retry only before any result was issued."""
    if (job["status"] != "leased" or str(job["worker_id"]) != worker_id
            or not _lease_expired(job["lease_expires_at"])
            or any(job.get(key) is not None for key in (
                "result_id", "sha256", "object_key", "issuance_receipt"))
            or shard is None or not 1 <= shard.attempts < _MAX_SAMPLE_ATTEMPTS
            or str(shard.workload_id) != str(job["workload_id"])
            or not isinstance(shard.metadata, dict)
            or shard.metadata.get("review_sample_only") is not True
            or shard.metadata.get("result_upload_issuance")
            or shard.metadata.get("result_upload_issuances")):
        return False
    if (shard.status == ShardStatus.RUNNING and shard.worker_id != worker_id
            or shard.status == ShardStatus.PENDING and shard.worker_id is not None
            or shard.status not in {ShardStatus.RUNNING, ShardStatus.PENDING}):
        return False
    workload = WorkloadRepo.by_id(s, job["workload_id"])
    return (workload is not None
            and workload.status == WorkloadStatus.QUARANTINED
            and workload.budget == 0
            and isinstance(workload.spec.params, dict)
            and workload.spec.params.get("review_sample_only") is True)


def lease(s: Session, *, publication_id: str, fmt: str) -> dict[str, Any]:
    import os
    _enabled()
    if fmt not in _FORMAT_MIME:
        raise ReviewSampleError("审核样单仅支持 GIF/MP4")
    row = _row(s, publication_id, lock=True)
    archive = _archive(s, row)
    publisher = _publisher(s, row)
    download = _archive_download_grant(archive)
    job = s.execute(select(samples_t).where(
        samples_t.c.publication_id == publication_id, samples_t.c.format == fmt
    ).with_for_update()).mappings().first()
    if job is None:
        raise ReviewSampleError("请先由投稿账号启动审核样单")
    worker = _active_runner(s)
    worker_id = str(worker.id)
    shard = ShardRepo.by_id(s, job["shard_id"])
    if shard is None:
        raise ReviewSampleError("审核样单分片已丢失")
    resumed_verified = None
    if job["status"] in {"upload_issued", "verified"}:
        if str(job["worker_id"]) != worker_id or not 1 <= shard.attempts <= _MAX_SAMPLE_ATTEMPTS:
            raise ReviewSampleError("已上传样单不属于当前独立审核节点")
        if job["status"] == "upload_issued":
            # A process may die after COS PUT but before the exact VersionId is
            # committed. Recover only this fixed result key. No media bytes
            # pass through Shanghai; verify() checks the immutable version and
            # Guangzhou independently reads and signs the media result.
            try:
                storage = evidence_storage.provider()
                head = storage._internal.head_object(
                    Bucket=storage.bucket, Key=job["object_key"])
                version = head.get("VersionId")
            except Exception as exc:
                raise ReviewSampleUnavailable("已上传样单精确版本暂不可恢复") from exc
            if not isinstance(version, str) or not _VERSION.fullmatch(version) or version == "null":
                raise ReviewSampleUnavailable("已上传样单未返回精确对象版本")
        else:
            version = job["object_version_id"]
        resumed_verified = verify(s, publication_id=publication_id, fmt=fmt,
                                  result_id=job["result_id"], object_version_id=version)
    elif job["status"] == "leased" and _lease_expired(job["lease_expires_at"]):
        if not _retryable_preupload(s, job=job, shard=shard, worker_id=worker_id):
            raise ReviewSampleError("独立样单租约已过期且不可安全重试")
        prior_attempt = shard.attempts
        if shard.status == ShardStatus.RUNNING and not ShardRepo.reset_pending(
                s, shard.id, expected_worker_id=worker_id,
                expected_attempt=prior_attempt):
            raise ReviewSampleError("独立样单旧租约回收失败")
        s.execute(update(shards_t).where(
            shards_t.c.id == shard.id,
            shards_t.c.status == ShardStatus.PENDING.value,
            shards_t.c.attempts == prior_attempt,
        ).values(max_attempts=_MAX_SAMPLE_ATTEMPTS))
        attempt = ShardRepo.assign_to_worker(s, shard.id, worker_id)
        if attempt != prior_attempt + 1 or not ShardRepo.mark_running(
                s, shard.id, expected_worker_id=worker_id):
            raise ReviewSampleError("独立样单安全重试租约签发失败")
        lease_expires = datetime.now(timezone.utc) + timedelta(seconds=_SAMPLE_TTL)
        s.execute(update(samples_t).where(
            samples_t.c.publication_id == publication_id,
            samples_t.c.format == fmt).values(
                lease_expires_at=lease_expires, updated_at=datetime.now(timezone.utc)))
        AuditRepo.write(s, action="task_adapter_publication.review_sample_preupload_retry",
                        actor_kind="service", target_kind="task_adapter_pub",
                        target_id=publication_id,
                        detail={"format": fmt, "shard_id": str(shard.id),
                                "worker_id": worker_id, "attempt": attempt})
    elif job["status"] == "pending":
        attempt = ShardRepo.assign_to_worker(s, shard.id, worker_id)
        if attempt != 1 or not ShardRepo.mark_running(s, shard.id,
                                                       expected_worker_id=worker_id):
            raise ReviewSampleError("独立样单租约签发失败")
        lease_expires = datetime.now(timezone.utc) + timedelta(seconds=_SAMPLE_TTL)
        s.execute(update(samples_t).where(
            samples_t.c.publication_id == publication_id,
            samples_t.c.format == fmt).values(
                status="leased", worker_id=worker_id,
                lease_expires_at=lease_expires, updated_at=datetime.now(timezone.utc)))
    elif (job["status"] != "leased" or str(job["worker_id"]) != worker_id
          or _lease_expired(job["lease_expires_at"])):
        raise ReviewSampleError("审核样单租约已使用或过期；需要重新投稿")
    current_shard = ShardRepo.by_id(s, job["shard_id"])
    if current_shard is None:
        raise ReviewSampleError("审核样单分片已丢失")
    if resumed_verified is None:
        shard = _restore_preupload_reclaim(s, job=job, shard=current_shard,
                                           worker_id=worker_id)
        if (shard.status != ShardStatus.RUNNING or shard.worker_id != worker_id
                or not 1 <= shard.attempts <= _MAX_SAMPLE_ATTEMPTS):
            raise ReviewSampleError("审核样单分片与当前独立节点租约不一致")
    else:
        shard = current_shard
    attempt = shard.attempts
    token = mint_lease_token(shard_id=str(job["shard_id"]), worker_id=worker_id,
                             attempt=attempt, ttl_s=_SAMPLE_TTL)
    AuditRepo.write(s, action="task_adapter_publication.review_sample_lease",
                    actor_kind="service", target_kind="task_adapter_pub",
                    target_id=publication_id,
                    detail={"format": fmt, "shard_id": str(job["shard_id"]),
                            "worker_id": worker_id, "attempt": attempt})
    return {"publication_id": publication_id, "format": fmt,
            "workload_id": str(job["workload_id"]), "shard_id": str(job["shard_id"]),
            "worker_id": worker_id, "attempt": attempt,
            "lease_token": token, "lease_expires_at": int(time.time()) + _SAMPLE_TTL,
            "recipe": _RECIPE, "recipe_sha256": _RECIPE_SHA,
            "task_type": row["task_type"], "artifact_digest": row["artifact_digest"],
            "package_digest": row["package_digest"], "archive": archive,
            "archive_download": download, **publisher,
            **({"resume_verified": resumed_verified} if resumed_verified is not None else {})}


def upload_intent(s: Session, *, publication_id: str, fmt: str, lease_token: str,
                  result_id: str, sha256: str, content_md5: str,
                  size_bytes: int) -> dict[str, Any]:
    _enabled()
    if fmt not in _FORMAT_MIME:
        raise ReviewSampleError("审核样单格式无效")
    row = _row(s, publication_id, lock=True)
    job = s.execute(select(samples_t).where(
        samples_t.c.publication_id == publication_id, samples_t.c.format == fmt
    ).with_for_update()).mappings().first()
    if (job is None or job["status"] != "leased"
            or _lease_expired(job["lease_expires_at"])
            or not job["worker_id"]):
        raise ReviewSampleError("独立样单租约不存在或已过期")
    if str(_active_runner(s).id) != str(job["worker_id"]):
        raise ReviewSampleError("独立样单不属于当前审核节点")
    shard = ShardRepo.by_id(s, job["shard_id"])
    if (shard is None or shard.status != ShardStatus.RUNNING
            or shard.worker_id != str(job["worker_id"])
            or not verify_lease_token(lease_token, shard_id=str(job["shard_id"]),
                                      worker_id=str(job["worker_id"]), attempt=shard.attempts)):
        raise ReviewSampleError("独立样单租约与当前分片不一致")
    try:
        from uuid import UUID
        if str(UUID(result_id)) != result_id:
            raise ValueError("noncanonical result id")
    except (TypeError, ValueError) as exc:
        raise ReviewSampleError("样单结果 ID 必须是 UUID") from exc
    if (not isinstance(sha256, str) or not _HEX.fullmatch(sha256)
            or type(size_bytes) is not int or not 1 <= size_bytes <= 16 * 1024 * 1024):
        raise ReviewSampleError("样单摘要或大小非法")
    try:
        content_md5 = evidence_storage.checked_content_md5(content_md5)
        provider = evidence_storage.provider()
        evidence_storage.require_bucket_proof(provider)
        if provider.bucket != _archive(s, row)["bucket"]:
            raise ReviewSampleError("样单证据桶与锁定源码归档不一致")
    except evidence_storage.EvidenceStorageUnavailable as exc:
        raise ReviewSampleUnavailable(str(exc)) from exc
    object_key = build_object_key(
        account_id=row["owner_id"], workload_id=str(job["workload_id"]),
        shard_id=str(job["shard_id"]), result_id=result_id,
        filename=f"result.{fmt}")
    if provider._full_key(object_key) != object_key:
        raise ReviewSampleError("审核证据桶不能改写真实样单键")
    issued = int(time.time())
    expires = issued + _UPLOAD_TTL
    try:
        receipt = artifact_issuance_receipt.issue(
            account_id=row["owner_id"], workload_id=str(job["workload_id"]),
            shard_id=str(job["shard_id"]), worker_id=str(job["worker_id"]),
            attempt=shard.attempts, result_id=result_id,
            object_key=object_key, sha256=sha256, size_bytes=size_bytes,
            content_type=_FORMAT_MIME[fmt], issued_at=issued, expires_at=expires)
        if receipt is None:
            raise ReviewSampleError("平台未启用真实结果发行签名")
        url, headers, _ = evidence_storage.locked_put_grant(
            provider, object_key=object_key, sha256_hex=sha256,
            content_md5=content_md5, content_type=_FORMAT_MIME[fmt],
            expires=_UPLOAD_TTL, min_retention_hours=50)
    except (artifact_issuance_receipt.IssuanceReceiptConfigurationError,
            evidence_storage.EvidenceStorageUnavailable) as exc:
        raise ReviewSampleUnavailable("独立样单上传授权不可用") from exc
    if not ShardRepo.record_result_upload_issuance(
            s, job["shard_id"], worker_id=str(job["worker_id"]),
            object_key=object_key, result_id=result_id,
            size_bytes=size_bytes, sha256=sha256,
            content_type=_FORMAT_MIME[fmt], expires_at=expires):
        raise ReviewSampleError("该独立样单已发行过一次上传授权")
    s.execute(update(samples_t).where(
        samples_t.c.publication_id == publication_id,
        samples_t.c.format == fmt).values(
            status="upload_issued", result_id=result_id, sha256=sha256,
            content_md5=content_md5, size_bytes=size_bytes,
            object_key=object_key, issuance_receipt=receipt,
            updated_at=datetime.now(timezone.utc)))
    AuditRepo.write(s, action="task_adapter_publication.review_sample_upload",
                    actor_kind="service", target_kind="task_adapter_pub",
                    target_id=publication_id,
                    detail={"format": fmt, "shard_id": str(job["shard_id"]),
                            "result_id": result_id, "sha256": sha256})
    return {"object_key": object_key, "bucket": provider.bucket,
            "url": url, "upload_url": url, "method": "PUT", "headers": headers,
            "expires_in": _UPLOAD_TTL, "expires_at": expires,
            "schema_version": "artifact.v1", "issuance_receipt": receipt}


def verify(s: Session, *, publication_id: str, fmt: str,
           result_id: str, object_version_id: str) -> dict[str, Any]:
    _enabled()
    if (fmt not in _FORMAT_MIME or not isinstance(object_version_id, str)
            or not _VERSION.fullmatch(object_version_id)
            or object_version_id == "null"):
        raise ReviewSampleError("样单对象版本无效")
    row = _row(s, publication_id, lock=True)
    job = s.execute(select(samples_t).where(
        samples_t.c.publication_id == publication_id, samples_t.c.format == fmt
    ).with_for_update()).mappings().first()
    if (job is None or job["status"] not in {"upload_issued", "verified"}
            or job["result_id"] != result_id or not job["issuance_receipt"]):
        raise ReviewSampleError("该结果不属于当前真实审核样单授权")
    if job["status"] == "verified":
        if object_version_id != job["object_version_id"]:
            raise ReviewSampleError("原始样单版本不可替换")
        receipt = job["verify_receipt"] if isinstance(job["verify_receipt"], dict) else {}
        payload = receipt.get("payload") if isinstance(receipt.get("payload"), dict) else {}
        if payload.get("expires_at", 0) > time.time() + 30:
            return _verified_response(job, fmt)
    try:
        storage = evidence_storage.provider()
        evidence_storage.require_bucket_proof(storage)
        if storage.bucket != _archive(s, row)["bucket"]:
            raise ReviewSampleError("样单证据桶与锁定源码归档不一致")
        head = storage._internal.head_object(Bucket=storage.bucket,
                                             Key=job["object_key"],
                                             VersionId=object_version_id)
        retention = storage._internal.get_object_retention(
            Bucket=storage.bucket, Key=job["object_key"],
            VersionId=object_version_id).get("Retention", {})
        lock_until = retention.get("RetainUntilDate")
        if (head.get("VersionId") != object_version_id
                or head.get("ContentLength") != job["size_bytes"]
                or head.get("ContentType") != _FORMAT_MIME[fmt]
                or not package_upload._matches_storage_digest(
                    head, storage, "sha256:" + job["sha256"], job["content_md5"])
                or retention.get("Mode") != "COMPLIANCE"
                or lock_until is None
                or lock_until.timestamp() < time.time() + 2 * 86400):
            raise ReviewSampleError("样单精确版本、MD5 或对象锁不满足独立验收")
    except ReviewSampleError:
        raise
    except Exception as exc:
        raise ReviewSampleUnavailable("样单精确版本只读核验失败") from exc
    artifact = {"object_key": job["object_key"],
                "object_version_id": object_version_id,
                "result_id": result_id, "sha256": job["sha256"],
                "size_bytes": job["size_bytes"], "content_type": _FORMAT_MIME[fmt]}
    try:
        checked = external_media_verifier.verify(
            task_type=row["task_type"], account_id=row["owner_id"],
            workload_id=str(job["workload_id"]), shard_id=str(job["shard_id"]),
            worker_id=str(job["worker_id"]), attempt=ShardRepo.by_id(s, job["shard_id"]).attempts,
            artifact=artifact, recipe=_RECIPE, output_format=fmt,
            include_raw_receipt=True,
            reviewed_spec=publications._spec_for_row(row))
    except Exception as exc:
        if isinstance(exc, external_media_verifier.ExternalVerifierUnavailable):
            raise ReviewSampleUnavailable("广州独立媒体验证暂不可用") from exc
        raise ReviewSampleError("广州独立媒体验证未通过") from exc
    s.execute(update(samples_t).where(
        samples_t.c.publication_id == publication_id,
        samples_t.c.format == fmt).values(
            status="verified", object_version_id=object_version_id,
            verify_request=checked["verify_request"],
            verify_receipt=checked["verify_receipt"],
            updated_at=datetime.now(timezone.utc)))
    AuditRepo.write(s, action="task_adapter_publication.review_sample_verified",
                    actor_kind="service", target_kind="task_adapter_pub",
                    target_id=publication_id,
                    detail={"format": fmt, "result_id": result_id,
                            "object_version_id": object_version_id,
                            "receipt_id": checked["receipt_id"]})
    return {"format": fmt, "object_ref": {
                "bucket": storage.bucket, "object_key": job["object_key"],
                "object_version_id": object_version_id,
                "sha256": job["sha256"], "size_bytes": job["size_bytes"]},
            "verify_request": checked["verify_request"],
            "verify_receipt": checked["verify_receipt"],
            "issuance_receipt": job["issuance_receipt"]}


def _verified_response(job: dict[str, Any], fmt: str) -> dict[str, Any]:
    return {"format": fmt, "object_ref": {
                "bucket": evidence_storage.provider().bucket,
                "object_key": job["object_key"],
                "object_version_id": job["object_version_id"],
                "sha256": job["sha256"], "size_bytes": job["size_bytes"]},
            "verify_request": job["verify_request"],
            "verify_receipt": job["verify_receipt"],
            "issuance_receipt": job["issuance_receipt"]}


def verified_pair(s: Session, *, publication_id: str) -> dict[str, Any]:
    row = _row(s, publication_id)
    jobs = _jobs(s, publication_id)
    if set(jobs) != set(_FORMAT_MIME) or any(job["status"] != "verified" for job in jobs.values()):
        raise ReviewSampleError("双样单尚未完成独立验收")
    return {"publication_id": publication_id, "owner_id": row["owner_id"],
            "artifact_digest": row["artifact_digest"],
            "package_digest": row["package_digest"],
            "archive": _archive(s, row),
            "samples": {fmt: _verified_response(jobs[fmt], fmt) for fmt in _FORMAT_MIME}}


def finalize(s: Session, *, publication_id: str,
             runner_attestation: dict[str, Any]) -> dict[str, Any]:
    """Deposit media only after Guangzhou independently passes the exact pair.

    The Mac worker supplies its signed execution statement. Every other field
    comes from Shanghai's persisted publication, locked archive and the two
    independently verified sample jobs; no media bytes transit Shanghai.
    """
    _enabled()
    row = _row(s, publication_id, lock=True)
    original = s.execute(select(revalidation_t).where(
        revalidation_t.c.publication_id == publication_id)).mappings().first()
    if original is not None:
        if original["material"].get("runner_attestation") != runner_attestation:
            raise ReviewSampleError("原始执行回执已固定，不可替换")
        if _summary(s, row)["media_evidence_status"] != "valid":
            raise ReviewSampleError("原始媒体验收已过期或与当前投稿不一致")
        return {"publication_id": publication_id, "status": "evidence_deposited",
                "media_receipt_id": original["media_receipt_sha256"]}
    if (not isinstance(runner_attestation, dict)
            or set(runner_attestation) != {"key_id", "payload", "signature"}
            or not isinstance(runner_attestation.get("payload"), dict)
            or runner_attestation["payload"].get("schema")
            != "qianshou.adapter-sample-execution.v2"
            or len(publications._canonical(runner_attestation)) > 16 * 1024):
        raise ReviewSampleError("独立计算节点签名执行回执无效")
    jobs = _jobs(s, publication_id)
    if set(jobs) != set(_FORMAT_MIME) or any(
            job["status"] != "verified" for job in jobs.values()):
        raise ReviewSampleError("GIF 和 MP4 必须先完成锁定版本独立验收")
    archive = _archive(s, row)
    publisher = _publisher(s, row)
    def sample(fmt: str) -> dict[str, Any]:
        job = jobs[fmt]
        return {"verify_request": job["verify_request"],
                "verify_receipt": job["verify_receipt"],
                "issuance_receipt": job["issuance_receipt"],
                "object_version_id": job["object_version_id"]}
    body = {"schema": "qianshou.publication-attest-request.v2",
            "publication_id": publication_id,
            "publisher_owner_id": row["owner_id"],
            "task_type": row["task_type"],
            "artifact_digest": row["artifact_digest"],
            "package_digest": row["package_digest"],
            "package_archive_digest": archive["sha256"],
            "package_immutable_version_id": archive["object_version_id"],
            "publisher_key_id": publisher["publisher_key_id"],
            "author_manifest": publisher["author_manifest"],
            "gif_sample": sample("gif"), "mp4_sample": sample("mp4"),
            "runner_attestation": runner_attestation}
    try:
        receipt = external_media_verifier.publication_attest(body)
    except external_media_verifier.ExternalVerifierUnavailable as exc:
        raise ReviewSampleUnavailable("广州独立投稿媒体验收暂不可用") from exc
    except external_media_verifier.ExternalMediaRejected as exc:
        raise ReviewSampleError("广州独立投稿媒体验收未通过") from exc
    material = {"schema": "qianshou.media-revalidation-material.v1",
                "gif": {key: body["gif_sample"][key] for key in (
                    "verify_request", "verify_receipt", "issuance_receipt")},
                "mp4": {key: body["mp4_sample"][key] for key in (
                    "verify_request", "verify_receipt", "issuance_receipt")},
                "runner_attestation": runner_attestation}
    publications.deposit_evidence(
        s, publication_id=publication_id, kind="media", receipt=receipt,
        revalidation_material=material)
    digest = "sha256:" + publications._digest(receipt)
    AuditRepo.write(s, action="task_adapter_publication.review_samples_finalized",
                    actor_kind="service", target_kind="task_adapter_pub",
                    target_id=publication_id,
                    detail={"media_receipt_sha256": digest})
    return {"publication_id": publication_id, "status": "evidence_deposited",
            "media_receipt_id": digest}
