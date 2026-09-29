"""Immutable sample control metadata for independent Guangzhou revalidation.

No source archive, GIF/MP4 bytes, upload URL or secret enters Shanghai.
The original signed evidence is retained so a later receipt can be refreshed
against the same exact object versions, rather than new client supplied keys.
"""
from __future__ import annotations

import hashlib
import re
import time
from datetime import timezone
from typing import Any

from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from platform_v8.services.workers import task_adapter_publications as publications
from platform_v8.storage.repo import (
    AuditRepo, task_adapter_author_manifests_t as manifests_t,
    task_adapter_media_revalidation_t as revalidation_t,
    task_adapter_package_uploads_t as uploads_t,
    task_adapter_publications_t as publications_t,
)

_SCHEMA = "qianshou.media-revalidation-material.v1"
_SNAPSHOT_SCHEMA = "qianshou.publication-revalidation-snapshot.v1"
_REQUEST_FIELDS = {"schema", "kind", "nonce", "task_type", "account_id", "workload_id",
                   "shard_id", "worker_id", "attempt", "object_key", "object_version_id",
                   "result_id", "sha256", "size_bytes", "content_type", "output_format",
                   "recipe_sha256", "recipe"}
_ENVELOPE = {"key_id", "payload", "signature"}
_HEX = re.compile(r"[0-9a-f]{64}\Z")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
_MAX_MATERIAL_BYTES = 96 * 1024


class RevalidationError(publications.PublicationError):
    pass


def _envelope(value: Any, schema: str) -> dict[str, Any]:
    if (not isinstance(value, dict) or set(value) != _ENVELOPE
            or not isinstance(value.get("key_id"), str)
            or not isinstance(value.get("signature"), str)
            or not isinstance(value.get("payload"), dict)
            or value["payload"].get("schema") != schema):
        raise RevalidationError("样单原始签名证据格式或合同不匹配")
    return value["payload"]


def validate_material(row: dict[str, Any], media_receipt: dict[str, Any],
                      material: Any) -> None:
    try:
        if (not isinstance(material, dict)
                or set(material) != {"schema", "gif", "mp4", "runner_attestation"}
                or material.get("schema") != _SCHEMA
                or len(publications._canonical(material)) > _MAX_MATERIAL_BYTES):
            raise RevalidationError("原始样单控制元数据缺失或过大")
        details = media_receipt["payload"]["details"]
        runner = _envelope(material["runner_attestation"],
                           "qianshou.adapter-sample-execution.v2")
        execution = runner.get("execution")
        if (runner.get("publication_id") != row["id"]
                or runner.get("owner_id") != row["owner_id"]
                or runner.get("task_type") != row["task_type"]
                or runner.get("artifact_digest") != row["artifact_digest"]
                or runner.get("package_digest") != row["package_digest"]
                or runner.get("package_archive_digest") != details["package_archive_digest"]
                or runner.get("package_immutable_version_id") != details["package_immutable_version_id"]
                or not isinstance(execution, dict)
                or execution.get("evidence_id") != details["runner_execution_evidence_id"]
                or execution.get("installed_package_digest") != row["package_digest"]
                or execution.get("source_version_id") != details["package_immutable_version_id"]
                or runner.get("result") != "pass"):
            raise RevalidationError("独立执行回执与当前投稿或不可变包不一致")
        runner_samples = runner.get("samples")
        if not isinstance(runner_samples, list) or len(runner_samples) != 2:
            raise RevalidationError("独立执行回执缺少双样单")
        for index, fmt in enumerate(("gif", "mp4")):
            sample = material[fmt]
            if not isinstance(sample, dict) or set(sample) != {
                    "verify_request", "issuance_receipt", "verify_receipt"}:
                raise RevalidationError("样单原始证据字段不完整")
            req = sample["verify_request"]
            ref = details[f"{fmt}_sample_ref"]
            if (not isinstance(req, dict) or set(req) != _REQUEST_FIELDS
                    or req.get("schema") != "qianshou.external-media-request.v1"
                    or req.get("kind") != "verify"
                    or req.get("task_type") != row["task_type"]
                    or req.get("account_id") != row["owner_id"]
                    or req.get("output_format") != fmt
                    or req.get("content_type") != ("image/gif" if fmt == "gif" else "video/mp4")
                    or req.get("object_key") != ref["object_key"]
                    or req.get("object_version_id") != ref["object_version_id"]
                    or req.get("sha256") != ref["sha256"]
                    or req.get("size_bytes") != ref["size_bytes"]
                    or not isinstance(req.get("recipe"), str)
                    or len(req["recipe"].encode("utf-8")) > 16 * 1024
                    or not _HEX.fullmatch(str(req.get("recipe_sha256")))
                    or hashlib.sha256(req["recipe"].encode()).hexdigest() != req["recipe_sha256"]
                    or not _UUID.fullmatch(str(req.get("result_id")))):
                raise RevalidationError("原始样单请求与锁定版本不一致")
            issuance = _envelope(sample["issuance_receipt"],
                                 "qianshou.artifact-upload-issuance.v1")
            verified = _envelope(sample["verify_receipt"],
                                 "qianshou.external-media-result.v1")
            if (not _UUID.fullmatch(str(issuance.get("issuance_id")))
                    or not _UUID.fullmatch(str(verified.get("receipt_id")))
                    or verified.get("receipt_id") != details[f"{fmt}_receipt_id"]
                    or verified.get("result") != "pass"
                    or verified.get("nonce") != req["nonce"]
                    or any(issuance.get(key) != req["account_id" if key == "account_id" else key]
                           for key in ("account_id", "workload_id", "shard_id", "worker_id",
                                       "attempt", "object_key", "result_id", "sha256",
                                       "size_bytes", "content_type"))
                    or any(verified.get(key) != req[key] for key in (
                        "task_type", "account_id", "workload_id", "shard_id",
                        "worker_id", "attempt", "object_key", "object_version_id",
                        "result_id", "sha256", "size_bytes", "content_type",
                        "output_format", "recipe_sha256"))):
                raise RevalidationError("上海发行或广州媒体验证证据与样单不一致")
            signed = runner_samples[index]
            metadata = {key: req[key] for key in (
                "account_id", "workload_id", "shard_id", "worker_id", "attempt",
                "object_key", "object_version_id", "result_id", "sha256",
                "size_bytes", "content_type", "output_format", "recipe_sha256")}
            if (not isinstance(signed, dict) or signed.get("format") != fmt
                    or signed.get("verify_metadata") != metadata
                    or signed.get("object_version_id") != req["object_version_id"]
                    or signed.get("upload_issuance_id") != issuance["issuance_id"]
                    or signed.get("verify_receipt_id") != verified["receipt_id"]):
                raise RevalidationError("独立执行回执未绑定本次真实样单")
        if material["gif"]["verify_request"]["recipe_sha256"] != (
                material["mp4"]["verify_request"]["recipe_sha256"]):
            raise RevalidationError("GIF/MP4 样单配方不一致")
    except (KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, RevalidationError):
            raise
        raise RevalidationError("原始样单控制元数据不完整") from exc


def store_original(s: Session, *, row: dict[str, Any], media_receipt: dict[str, Any],
                   material: Any) -> None:
    validate_material(row, media_receipt, material)
    existing = s.execute(select(revalidation_t).where(
        revalidation_t.c.publication_id == row["id"]).with_for_update()).mappings().first()
    if existing is not None:
        if (existing["owner_id"] != row["owner_id"]
                or existing["original_media_receipt"] != media_receipt
                or existing["material"] != material):
            raise RevalidationError("原始样单证据已固定；新样单须另投新版本")
        return
    s.execute(insert(revalidation_t).values(
        publication_id=row["id"], owner_id=row["owner_id"],
        media_receipt_sha256="sha256:" + publications._digest(media_receipt),
        original_media_receipt=media_receipt, material=material))
    AuditRepo.write(s, action="task_adapter_publication.media_material",
                    actor_kind="service", target_kind="task_adapter_pub",
                    target_id=row["id"],
                    detail={"media_receipt_sha256": "sha256:" + publications._digest(media_receipt)})


def snapshot(s: Session, publication_id: str) -> dict[str, Any]:
    row = publications._get(s, publication_id)
    if row["status"] != "approved":
        raise RevalidationError("仅已批准且未撤销投稿可供独立复验")
    evidence = row["review_evidence"] or {}
    source = s.execute(select(uploads_t).where(
        uploads_t.c.publication_id == publication_id)).mappings().first()
    author = s.execute(select(manifests_t).where(
        manifests_t.c.publication_id == publication_id)).mappings().first()
    original = s.execute(select(revalidation_t).where(
        revalidation_t.c.publication_id == publication_id)).mappings().first()
    if (source is None or source["status"] != "confirmed"
            or author is None or author["owner_id"] != row["owner_id"]
            or original is None or original["owner_id"] != row["owner_id"]
            or not source["version_id"] or source["lock_retain_until"] is None):
        raise RevalidationError("不可变归档、作者签名或原始样单证据缺失")
    lock = source["lock_retain_until"]
    if lock.tzinfo is None:
        lock = lock.replace(tzinfo=timezone.utc)
    if lock.timestamp() <= time.time() + 86400:
        raise RevalidationError("归档锁不足以覆盖重新复验期")
    roots = publications._roots()
    # Expiry is deliberately ignored only for this approved, read-only
    # revalidation snapshot. Guangzhou rechecks exact bytes/lock/semantics
    # before minting any fresh pass. Dispatch still requires live receipts.
    for kind, receipt in (("package", evidence.get("package")),
                          ("media", original["original_media_receipt"])):
        issue = publications._receipt_issue(kind, receipt, row, reviewer_id=None,
                                            now=int(time.time()), roots=roots,
                                            allow_expired=True)
        if issue:
            raise RevalidationError(f"原始 {kind} 签名证据不可用：{issue}")
    package = evidence["package"]
    details = package["payload"]["details"]
    if (details["archive_digest"] != source["archive_digest"]
            or details["archive_bucket"] != source["bucket"]
            or details["archive_object_key"] != source["object_key"]
            or details["archive_version_id"] != source["version_id"]
            or details["archive_size_bytes"] != source["size_bytes"]
            or author["artifact_digest"] != row["artifact_digest"]
            or author["package_digest"] != row["package_digest"]
            or details["publisher_key_id"] != author["key_id"]
            or details.get("author_manifest_sha256") != "sha256:" + publications._digest(author["manifest"])):
        raise RevalidationError("当前归档、作者签名与原验包回执不一致")
    try:
        from platform_v8.services.workers.task_adapter_publisher_identity import active_key
        active_key(s, owner_id=row["owner_id"], key_id=author["key_id"])
    except Exception as exc:
        raise RevalidationError("作者签名公钥已撤销或不可用") from exc
    original_media = original["original_media_receipt"]
    validate_material(row, original_media, original["material"])
    media_details = original_media["payload"]["details"]
    if (media_details["package_archive_digest"] != source["archive_digest"]
            or media_details["package_immutable_version_id"] != source["version_id"]
            or any(media_details[f"{fmt}_sample_ref"]["bucket"] != source["bucket"]
                   for fmt in ("gif", "mp4"))):
        raise RevalidationError("样单与归档不属于同一受锁证据桶或源版本")
    result = {
        "schema": _SNAPSHOT_SCHEMA,
        "publication_id": row["id"], "owner_id": row["owner_id"],
        "status": row["status"], "package_receipt": package,
        "media_receipt": original_media, "author_manifest": author["manifest"],
        "revalidation_material": original["material"],
        "archive": {"bucket": source["bucket"], "object_key": source["object_key"],
                    "object_version_id": source["version_id"],
                    "sha256": source["archive_digest"], "size_bytes": source["size_bytes"]},
    }
    if len(publications._canonical(result)) > 128 * 1024:
        raise RevalidationError("复验快照超过有界控制元数据上限")
    return result
