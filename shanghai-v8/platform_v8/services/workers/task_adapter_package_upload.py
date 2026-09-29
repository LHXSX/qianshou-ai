"""Direct-to-OSS package upload intent for a reviewed task adapter.

Shanghai signs control metadata and reads a version-specific HEAD only. It
never downloads package bytes. A confirmed upload is NOT a package receipt:
Guangzhou must independently read the locked version, verify its bytes and
author signature, and deposit its own signed evidence.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from sqlalchemy import insert, select, update
from sqlalchemy.orm import Session

from platform_v8.services.oss_provider import S3CompatibleProvider
from platform_v8.services.workers import task_adapter_evidence_storage as evidence_storage
from platform_v8.storage.repo import (
    AuditRepo, task_adapter_package_uploads_t as uploads_t,
    task_adapter_publications_t as publications_t,
)

_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
_VERSION = re.compile(r"[A-Za-z0-9_.~+-]{1,200}\Z")
_B64 = re.compile(r"[A-Za-z0-9_-]+={0,2}\Z")
_MAX_BYTES = 16 * 1024 * 1024
_INTENT_TTL = 15 * 60
_MIN_REMAINING_SECONDS = 24 * 3600
_SCHEMA = "qianshou.task-adapter-package-upload-intent.v1"


class PackageUploadError(ValueError):
    pass


class PackageUploadConflict(PackageUploadError):
    pass


class PackageUploadUnavailable(PackageUploadError):
    pass


class PackageUploadNotFound(PackageUploadError):
    pass


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    if not isinstance(value, str) or not _B64.fullmatch(value) or len(value) > 2048:
        raise PackageUploadError("上传凭证编码非法")
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, base64.binascii.Error) as exc:
        raise PackageUploadError("上传凭证编码非法") from exc


def _intent_key() -> bytes:
    encoded = os.environ.get("V8_TASK_PUBLICATION_UPLOAD_INTENT_KEY", "")
    raw = _unb64(encoded)
    if len(raw) < 32:
        raise PackageUploadError("平台未配置独立归档上传凭证密钥")
    return raw


def _provider() -> S3CompatibleProvider:
    if os.environ.get("V8_TASK_PUBLICATION_PACKAGE_UPLOAD_ENABLED") != "1":
        raise PackageUploadUnavailable("平台尚未开放不可变归档直传")
    try:
        storage = evidence_storage.provider()
        evidence_storage.require_bucket_proof(storage)
        return storage
    except evidence_storage.EvidenceStorageUnavailable as exc:
        raise PackageUploadUnavailable(str(exc)) from exc


def _publication(session: Session, publication_id: str, owner_id: int, *,
                 lock: bool = False, require_review: bool = True) -> dict[str, Any]:
    query = select(publications_t).where(publications_t.c.id == publication_id,
                                         publications_t.c.owner_id == owner_id)
    if lock:
        query = query.with_for_update()
    row = session.execute(query).mappings().first()
    if row is None:
        raise PackageUploadNotFound("接单技能投稿不存在")
    row = dict(row)
    if require_review and row["status"] != "review":
        raise PackageUploadConflict("仅待审核投稿可上传接单归档")
    if require_review and (row["review_evidence"] or {}).get("package") is not None:
        raise PackageUploadConflict("已收到独立验包回执；新包须另投新版本")
    return row


def _key(owner_id: int, publication_id: str) -> str:
    return f"v8/account-{owner_id}/publication/{publication_id}/adapter/source.zip"


def _matches_storage_digest(head: dict[str, Any], storage: S3CompatibleProvider,
                            archive_digest: str, content_md5: str) -> bool:
    """Check the digest actually enforced by this provider on the exact version.

    COS ignores x-amz-checksum-sha256 on PUT and omits it from HEAD. It does
    enforce Content-MD5, observed through its single-PUT ETag. The intended
    SHA-256 remains an independent Guangzhou exact-version GET obligation.
    """
    if storage.config.provider == "cos":
        expected = base64.b64decode(content_md5).hex()
        return head.get("ETag", "").strip('"').lower() == expected
    expected = base64.b64encode(bytes.fromhex(archive_digest[7:])).decode("ascii")
    return head.get("ChecksumSHA256") == expected


def _token(payload: dict[str, Any]) -> str:
    raw = _canonical(payload)
    if len(raw) > 1024:
        raise PackageUploadError("上传凭证过大")
    return _b64(raw) + "." + _b64(hmac.new(_intent_key(), raw, hashlib.sha256).digest())


def _untoken(token: str) -> dict[str, Any]:
    if not isinstance(token, str) or len(token) > 2048 or token.count(".") != 1:
        raise PackageUploadError("上传凭证格式非法")
    encoded, mac = token.split(".", 1)
    raw = _unb64(encoded)
    if not hmac.compare_digest(hmac.new(_intent_key(), raw, hashlib.sha256).digest(),
                               _unb64(mac)):
        raise PackageUploadError("上传凭证签名无效")
    try:
        value = json.loads(raw)
    except (UnicodeError, ValueError) as exc:
        raise PackageUploadError("上传凭证内容非法") from exc
    if not isinstance(value, dict) or value.get("schema") != _SCHEMA:
        raise PackageUploadError("上传凭证合同不匹配")
    return value


def prepare(session: Session, *, publication_id: str, owner_id: int,
            artifact_digest: str, package_digest: str,
            archive_digest: str, size_bytes: int, content_md5: str) -> dict[str, Any]:
    _intent_key()
    row = _publication(session, publication_id, owner_id, lock=True)
    if (artifact_digest != row["artifact_digest"]
            or package_digest != row["package_digest"]):
        raise PackageUploadError("上传包与当前投稿的源码或运行包摘要不一致")
    if not isinstance(archive_digest, str) or not _DIGEST.fullmatch(archive_digest):
        raise PackageUploadError("归档摘要必须为 SHA-256")
    if type(size_bytes) is not int or not 1 <= size_bytes <= _MAX_BYTES:
        raise PackageUploadError("规范六文件归档大小须为 1 至 16 MiB")
    try:
        content_md5 = evidence_storage.checked_content_md5(content_md5)
    except evidence_storage.EvidenceStorageUnavailable as exc:
        raise PackageUploadError(str(exc)) from exc
    provider = _provider()
    object_key = _key(owner_id, publication_id)
    if provider._full_key(object_key) != object_key:
        raise PackageUploadError("对象存储前缀与广州固定验包地址不一致")
    previous = session.execute(select(uploads_t).where(
        uploads_t.c.publication_id == publication_id).with_for_update()).mappings().first()
    if previous is not None and previous["status"] == "confirmed":
        raise PackageUploadConflict("该投稿已有存储确认的归档；新包须另投新版本")
    now = int(time.time())
    nonce = str(uuid4())
    expires_at = datetime.utcfromtimestamp(now + _INTENT_TTL)
    try:
        url, headers, retain_until = evidence_storage.locked_put_grant(
            provider, object_key=object_key, sha256_hex=archive_digest[7:],
            content_md5=content_md5, content_type="application/zip", expires=_INTENT_TTL)
    except evidence_storage.EvidenceStorageUnavailable as exc:
        raise PackageUploadUnavailable(str(exc)) from exc
    payload = {
        "schema": _SCHEMA, "publication_id": publication_id, "owner_id": owner_id,
        "artifact_digest": artifact_digest, "package_digest": package_digest,
        "archive_digest": archive_digest, "size_bytes": size_bytes,
        "content_md5": content_md5,
        "bucket": provider.bucket, "object_key": object_key, "nonce": nonce,
        "expires_at": now + _INTENT_TTL,
        "retain_until": retain_until.isoformat().replace("+00:00", "Z"),
    }
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or len(url) > 8192:
        raise PackageUploadError("归档上传必须使用 HTTPS 签名地址")
    values = {
        "owner_id": owner_id, "archive_digest": archive_digest,
        "content_md5": content_md5,
        "size_bytes": size_bytes, "bucket": provider.bucket,
        "object_key": object_key,
        "intent_nonce": nonce, "intent_expires_at": expires_at,
        "version_id": None, "lock_retain_until": None,
        "status": "prepared", "updated_at": datetime.utcnow(),
    }
    if previous is None:
        session.execute(insert(uploads_t).values(publication_id=publication_id, **values))
    else:
        session.execute(update(uploads_t).where(uploads_t.c.publication_id == publication_id)
                        .values(**values))
    AuditRepo.write(session, action="task_adapter_package_upload.prepare",
                    actor_account_id=owner_id, actor_kind="account",
                    target_kind="task_adapter_pub", target_id=publication_id,
                    detail={"archive_digest": archive_digest, "size_bytes": size_bytes,
                            "object_key": object_key})
    session.flush()
    return {
        "publication_id": publication_id, "bucket": provider.bucket,
        "object_key": object_key,
        "method": "PUT", "url": url, "headers": headers,
        "expires_in": _INTENT_TTL, "upload_intent": _token(payload),
        "status": "prepared",
    }


def confirm(session: Session, *, publication_id: str, owner_id: int,
            upload_intent: str, version_id: str) -> dict[str, Any]:
    row = _publication(session, publication_id, owner_id, lock=True)
    intent = _untoken(upload_intent)
    now = int(time.time())
    if (intent.get("publication_id") != publication_id
            or intent.get("owner_id") != owner_id
            or intent.get("artifact_digest") != row["artifact_digest"]
            or intent.get("package_digest") != row["package_digest"]
            or intent.get("object_key") != _key(owner_id, publication_id)
            or type(intent.get("expires_at")) is not int
            or intent["expires_at"] <= now):
        raise PackageUploadError("上传凭证已过期或与当前投稿不匹配")
    if not isinstance(version_id, str) or not _VERSION.fullmatch(version_id) or version_id == "null":
        raise PackageUploadError("OSS 未返回可锁定的 VersionId")
    stored = session.execute(select(uploads_t).where(
        uploads_t.c.publication_id == publication_id).with_for_update()).mappings().first()
    if stored is None or stored["intent_nonce"] != intent.get("nonce"):
        raise PackageUploadConflict("上传凭证已由另一份归档取代")
    if (stored["archive_digest"] != intent.get("archive_digest")
            or stored["content_md5"] != intent.get("content_md5")
            or stored["size_bytes"] != intent.get("size_bytes")
            or stored["bucket"] != intent.get("bucket")
            or stored["object_key"] != intent.get("object_key")):
        raise PackageUploadConflict("归档上传状态与签名凭证不一致")
    if stored["status"] == "confirmed":
        if stored["version_id"] == version_id:
            return status(session, publication_id=publication_id, owner_id=owner_id)
        raise PackageUploadConflict("该投稿已确认另一个不可变包版本")
    provider = _provider()
    if provider.bucket != stored["bucket"] or provider._full_key(stored["object_key"]) != stored["object_key"]:
        raise PackageUploadError("对象存储桶或前缀已变化，不能确认原上传")
    try:
        head = provider._internal.head_object(
            Bucket=provider.bucket, Key=stored["object_key"],
            VersionId=version_id, ChecksumMode="ENABLED")
    except Exception as exc:
        raise PackageUploadError("对象存储无法证明精确版本与 SHA-256 校验和") from exc
    if not isinstance(head, dict):
        raise PackageUploadError("对象存储未返回精确版本的 HEAD 证明")
    lock_until = head.get("ObjectLockRetainUntilDate")
    try:
        wanted_lock = datetime.fromisoformat(intent["retain_until"].replace("Z", "+00:00"))
        actual_lock = lock_until.astimezone(timezone.utc)
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise PackageUploadError("对象存储未返回有效锁定到期时间") from exc
    if (head.get("VersionId") != version_id
            or type(head.get("ContentLength")) is not int
            or head["ContentLength"] != stored["size_bytes"]
            or head.get("ContentType") != "application/zip"
            or not _matches_storage_digest(head, provider,
                                           stored["archive_digest"], stored["content_md5"])
            or head.get("ObjectLockMode") != "COMPLIANCE"
            or actual_lock < wanted_lock):
        raise PackageUploadError("对象存储版本、大小、校验和或合规锁定与上传凭证不一致")
    session.execute(update(uploads_t).where(uploads_t.c.publication_id == publication_id)
                    .values(status="confirmed", version_id=version_id,
                            lock_retain_until=actual_lock.replace(tzinfo=None),
                            updated_at=datetime.utcnow()))
    AuditRepo.write(session, action="task_adapter_package_upload.confirm",
                    actor_account_id=owner_id, actor_kind="account",
                    target_kind="task_adapter_pub", target_id=publication_id,
                    detail={"archive_digest": stored["archive_digest"],
                            "size_bytes": stored["size_bytes"], "object_key": stored["object_key"],
                            "version_id": version_id})
    session.flush()
    return status(session, publication_id=publication_id, owner_id=owner_id)


def status(session: Session, *, publication_id: str, owner_id: int) -> dict[str, Any]:
    _publication(session, publication_id, owner_id, require_review=False)
    row = session.execute(select(uploads_t).where(
        uploads_t.c.publication_id == publication_id)).mappings().first()
    if row is None:
        return {"publication_id": publication_id, "status": "missing"}
    result = {
        "publication_id": publication_id, "status": row["status"],
        "bucket": row["bucket"], "object_key": row["object_key"],
        "archive_digest": row["archive_digest"],
        "size_bytes": row["size_bytes"], "version_id": row["version_id"],
        "next_step": ("等待广州按该 VersionId 独立验包并签发 package 回执"
                      if row["status"] == "confirmed" else "完成 OSS PUT 并提交 VersionId"),
    }
    return result


def extend_lock_if_needed(session: Session, *, publication_id: str,
                          owner_id: int) -> bool:
    """Extend only the exact confirmed version; never recreate or rewrite it.

    Called only after independent publication gates are otherwise valid. The
    provider may hold PutObjectRetention but Shanghai never GETs object bytes.
    A lock that has already expired is not renewable: a mutable interval could
    have broken the independent package receipt.
    """
    row = session.execute(select(uploads_t).where(
        uploads_t.c.publication_id == publication_id,
        uploads_t.c.owner_id == owner_id).with_for_update()).mappings().first()
    if row is None or row["status"] != "confirmed" or not row["version_id"]:
        raise PackageUploadError("没有可续锁的已确认归档版本")
    previous = row["lock_retain_until"]
    if not isinstance(previous, datetime):
        raise PackageUploadError("归档版本缺少原始对象锁证明")
    if previous.tzinfo is None:
        previous = previous.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if previous <= now:
        raise PackageUploadError("归档对象锁已过期，不能安全续延")
    if (previous - now).total_seconds() >= _MIN_REMAINING_SECONDS:
        return False
    try:
        storage = evidence_storage.provider()
        evidence_storage.require_bucket_proof(storage)
    except evidence_storage.EvidenceStorageUnavailable as exc:
        raise PackageUploadError(str(exc)) from exc
    if storage.bucket != row["bucket"] or storage._full_key(row["object_key"]) != row["object_key"]:
        raise PackageUploadError("归档对象存储配置与已确认版本不一致")

    def exact_head() -> tuple[dict[str, Any], datetime]:
        try:
            head = storage._internal.head_object(
                Bucket=row["bucket"], Key=row["object_key"],
                VersionId=row["version_id"], ChecksumMode="ENABLED")
            lock_until = head["ObjectLockRetainUntilDate"].astimezone(timezone.utc)
        except Exception as exc:
            raise PackageUploadError("无法复核原始归档精确版本和对象锁") from exc
        if (head.get("VersionId") != row["version_id"]
                or type(head.get("ContentLength")) is not int
                or head["ContentLength"] != row["size_bytes"]
                or head.get("ContentType") != "application/zip"
                or not _matches_storage_digest(head, storage,
                                               row["archive_digest"], row["content_md5"])
                or head.get("ObjectLockMode") != "COMPLIANCE"):
            raise PackageUploadError("归档版本、大小、摘要或合规锁已不匹配")
        return head, lock_until

    _, observed = exact_head()
    if observed < previous or observed <= now:
        raise PackageUploadError("对象存储锁期短于上海原始确认，不能续延")
    if observed > previous:
        session.execute(update(uploads_t).where(uploads_t.c.publication_id == publication_id)
                        .values(lock_retain_until=observed.replace(tzinfo=None),
                                updated_at=datetime.utcnow()))
    wanted = datetime.fromtimestamp(
        int(now.timestamp()) + evidence_storage.retention_hours() * 3600,
        tz=timezone.utc)
    if wanted <= observed:
        return False
    try:
        storage._internal.put_object_retention(
            Bucket=row["bucket"], Key=row["object_key"],
            VersionId=row["version_id"],
            Retention={"Mode": "COMPLIANCE", "RetainUntilDate": wanted},
        )
    except Exception as exc:
        raise PackageUploadError("对象存储拒绝延长原始归档版本锁期") from exc
    _, verified = exact_head()
    if verified < wanted:
        raise PackageUploadError("对象存储未证明原始归档版本的锁期已经延长")
    session.execute(update(uploads_t).where(
        uploads_t.c.publication_id == publication_id,
        uploads_t.c.version_id == row["version_id"],
    ).values(lock_retain_until=verified.replace(tzinfo=None),
             updated_at=datetime.utcnow()))
    AuditRepo.write(session, action="task_adapter_package_upload.extend_lock",
                    actor_kind="service", target_kind="task_adapter_pub",
                    target_id=publication_id,
                    detail={"version_id": row["version_id"],
                            "retained_until": verified.isoformat()})
    session.flush()
    return True
