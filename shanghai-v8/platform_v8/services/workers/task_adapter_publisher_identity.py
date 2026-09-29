"""Account-bound author key enrollment and immutable source-manifest metadata.

Only authenticated owners can enroll a key, after proving possession of its
private half with a one-use server challenge.  Guangzhou uses a separate
read-only service credential to resolve active keys; request keys are never
roots of trust.  Neither enrollment nor author signature is review evidence.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import delete, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from platform_v8.services.workers.order_package_provenance import (
    PackageProvenanceError, verify_enrolled_manifest_metadata,
)
from platform_v8.storage.repo import (
    AuditRepo, accounts_t, task_adapter_author_manifests_t as manifests_t,
    task_adapter_publisher_challenges_t as challenges_t,
    task_adapter_publisher_keys_t as keys_t,
    task_adapter_publications_t as publications_t,
)

ENROLL_SCHEMA = "qianshou.order-adapter-key-enrollment.v1"
KEY_SCHEMA = "qianshou.order-adapter-publisher-key.v1"
_KEY_ID = re.compile(r"author-[0-9a-f]{24}\Z")
_UUID = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\Z")
_RAW_KEY = re.compile(r"[A-Za-z0-9_-]{43}\Z")
_SIGNATURE = re.compile(r"[A-Za-z0-9_-]{86}\Z")


class PublisherIdentityError(ValueError):
    pass


class PublisherIdentityNotFound(PublisherIdentityError):
    pass


class PublisherIdentityRevoked(PublisherIdentityError):
    pass


class PublisherIdentityConflict(PublisherIdentityError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _raw(value: str, size: int, pattern: re.Pattern[str]) -> bytes:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise PublisherIdentityError("作者密钥编码无效")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as exc:
        raise PublisherIdentityError("作者密钥编码无效") from exc
    if len(decoded) != size or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode() != value:
        raise PublisherIdentityError("作者密钥编码无效")
    return decoded


def _account_active(s: Session, owner_id: int) -> bool:
    return s.execute(select(accounts_t.c.status).where(
        accounts_t.c.id == owner_id)).scalar_one_or_none() == "active"


def challenge(s: Session, *, owner_id: int) -> dict[str, Any]:
    if type(owner_id) is not int or owner_id < 1 or not _account_active(s, owner_id):
        raise PublisherIdentityNotFound("作者账号不存在或已停用")
    issued = _now()
    challenge_id = str(uuid4())
    nonce = secrets.token_urlsafe(32)
    s.execute(delete(challenges_t).where(challenges_t.c.owner_id == owner_id))
    s.execute(insert(challenges_t).values(
        owner_id=owner_id, challenge_id=challenge_id, nonce=nonce,
        expires_at=issued + timedelta(minutes=5), created_at=issued))
    s.flush()
    return {"schema": ENROLL_SCHEMA, "owner_id": owner_id,
            "challenge_id": challenge_id, "nonce": nonce,
            "expires_at": int((issued + timedelta(minutes=5)).timestamp())}


def enroll(s: Session, *, owner_id: int, key_id: str, public_key: str,
           challenge_id: str, signature: str) -> dict[str, Any]:
    if (type(owner_id) is not int or owner_id < 1
            or not isinstance(key_id, str) or not _KEY_ID.fullmatch(key_id)
            or not isinstance(challenge_id, str) or not _UUID.fullmatch(challenge_id)):
        raise PublisherIdentityError("作者登记字段无效")
    public = _raw(public_key, 32, _RAW_KEY)
    proof = _raw(signature, 64, _SIGNATURE)
    expected_id = "author-" + hashlib.sha256(public).hexdigest()[:24]
    if key_id != expected_id:
        raise PublisherIdentityError("密钥编号与公钥不一致")
    row = s.execute(select(challenges_t).where(
        challenges_t.c.owner_id == owner_id,
        challenges_t.c.challenge_id == challenge_id).with_for_update()).mappings().first()
    if row is None or _aware(row["expires_at"]) <= _now():
        raise PublisherIdentityConflict("作者签名挑战已失效，请重新尝试")
    payload = {"schema": ENROLL_SCHEMA, "owner_id": owner_id,
               "key_id": key_id, "public_key": public_key,
               "challenge_id": challenge_id, "nonce": row["nonce"]}
    try:
        Ed25519PublicKey.from_public_bytes(public).verify(proof, _canonical(payload))
    except (InvalidSignature, ValueError) as exc:
        raise PublisherIdentityError("作者私钥持有证明无效") from exc
    consumed = s.execute(delete(challenges_t).where(
        challenges_t.c.owner_id == owner_id,
        challenges_t.c.challenge_id == challenge_id))
    if consumed.rowcount != 1:
        raise PublisherIdentityConflict("作者签名挑战已被使用")
    existing = s.execute(select(keys_t).where(
        keys_t.c.owner_id == owner_id, keys_t.c.key_id == key_id).with_for_update()).mappings().first()
    if existing is not None:
        if existing["revoked_at"] is not None:
            raise PublisherIdentityRevoked("此作者密钥已撤销，须换新密钥")
        if existing["public_key"] != public_key:
            raise PublisherIdentityConflict("密钥编号已被占用")
        return {"schema": KEY_SCHEMA, "owner_id": owner_id,
                "key_id": key_id, "public_key": public_key, "status": "active"}
    count = s.execute(select(keys_t.c.key_id).where(
        keys_t.c.owner_id == owner_id, keys_t.c.revoked_at.is_(None))).all()
    if len(count) >= 8:
        raise PublisherIdentityConflict("作者活动密钥已达上限")
    try:
        with s.begin_nested():
            s.execute(insert(keys_t).values(
                owner_id=owner_id, key_id=key_id, public_key=public_key,
                created_at=_now(), revoked_at=None))
    except IntegrityError as exc:
        raise PublisherIdentityConflict("作者密钥并发登记冲突") from exc
    AuditRepo.write(s, action="task_adapter.publisher_key.enroll",
                    actor_account_id=owner_id, actor_kind="account",
                    target_kind="publisher_key", target_id=key_id,
                    detail={"key_id": key_id})
    s.flush()
    return {"schema": KEY_SCHEMA, "owner_id": owner_id,
            "key_id": key_id, "public_key": public_key, "status": "active"}


def active_key(s: Session, *, owner_id: int, key_id: str) -> dict[str, Any]:
    if type(owner_id) is not int or owner_id < 1 or not isinstance(key_id, str) or not _KEY_ID.fullmatch(key_id):
        raise PublisherIdentityNotFound("作者密钥不存在")
    row = s.execute(select(keys_t).where(
        keys_t.c.owner_id == owner_id, keys_t.c.key_id == key_id)).mappings().first()
    if row is None or not _account_active(s, owner_id):
        raise PublisherIdentityNotFound("作者密钥不存在")
    if row["revoked_at"] is not None:
        raise PublisherIdentityRevoked("作者密钥已撤销")
    return {"schema": KEY_SCHEMA, "owner_id": owner_id, "key_id": key_id,
            "public_key": row["public_key"], "status": "active"}


def revoke(s: Session, *, owner_id: int, key_id: str) -> dict[str, Any]:
    active_key(s, owner_id=owner_id, key_id=key_id)
    updated = s.execute(update(keys_t).where(
        keys_t.c.owner_id == owner_id, keys_t.c.key_id == key_id,
        keys_t.c.revoked_at.is_(None)).values(revoked_at=_now()))
    if updated.rowcount != 1:
        raise PublisherIdentityConflict("作者密钥状态已改变")
    AuditRepo.write(s, action="task_adapter.publisher_key.revoke",
                    actor_account_id=owner_id, actor_kind="account",
                    target_kind="publisher_key", target_id=key_id,
                    detail={"key_id": key_id})
    s.flush()
    return {"schema": KEY_SCHEMA, "owner_id": owner_id, "key_id": key_id,
            "status": "revoked"}


def publish_manifest(s: Session, *, owner_id: int, publication_id: str,
                     envelope: dict[str, Any]) -> dict[str, Any]:
    if (type(owner_id) is not int or owner_id < 1 or not isinstance(publication_id, str)
            or not _UUID.fullmatch(publication_id) or not isinstance(envelope, dict)
            or len(_canonical(envelope)) > 64 * 1024):
        raise PublisherIdentityError("作者清单格式无效")
    row = s.execute(select(publications_t).where(
        publications_t.c.id == publication_id,
        publications_t.c.owner_id == owner_id).with_for_update()).mappings().first()
    if row is None:
        raise PublisherIdentityNotFound("投稿不存在")
    if row["status"] != "review":
        raise PublisherIdentityConflict("投稿已结束审核，不能改签名清单")
    key_id = envelope.get("key_id")
    public_key = active_key(s, owner_id=owner_id, key_id=key_id)["public_key"]
    try:
        verify_enrolled_manifest_metadata(
            envelope, owner_id=owner_id,
            artifact_digest=row["artifact_digest"],
            package_digest=row["package_digest"],
            publisher_roots={str(owner_id): {key_id: public_key}},
            publication_id=publication_id, task_type=row["task_type"],
            capability_id=row["capability_id"], version=row["version"])
    except PackageProvenanceError as exc:
        raise PublisherIdentityError(str(exc)) from exc
    payload = envelope["payload"]
    if payload.get("version") != row["version"] or payload.get("capability_id") != row["capability_id"]:
        raise PublisherIdentityError("作者签名与投稿版本不一致")
    existing = s.execute(select(manifests_t).where(
        manifests_t.c.publication_id == publication_id).with_for_update()).mappings().first()
    if existing is not None:
        if existing["manifest"] != envelope:
            raise PublisherIdentityConflict("此投稿已锁定另一作者清单")
        return {"publication_id": publication_id, "owner_id": owner_id,
                "key_id": key_id, "status": "recorded"}
    try:
        with s.begin_nested():
            s.execute(insert(manifests_t).values(
                publication_id=publication_id, owner_id=owner_id,
                key_id=key_id, artifact_digest=row["artifact_digest"],
                package_digest=row["package_digest"], manifest=envelope,
                created_at=_now()))
    except IntegrityError as exc:
        raise PublisherIdentityConflict("作者清单并发提交冲突") from exc
    AuditRepo.write(s, action="task_adapter.author_manifest.record",
                    actor_account_id=owner_id, actor_kind="account",
                    target_kind="task_adapter_pub", target_id=publication_id,
                    detail={"key_id": key_id})
    s.flush()
    return {"publication_id": publication_id, "owner_id": owner_id,
            "key_id": key_id, "status": "recorded"}


def manifest_for_issuer(s: Session, *, publication_id: str) -> dict[str, Any]:
    if not isinstance(publication_id, str) or not _UUID.fullmatch(publication_id):
        raise PublisherIdentityNotFound("作者清单不存在")
    row = s.execute(select(manifests_t).where(
        manifests_t.c.publication_id == publication_id)).mappings().first()
    if row is None:
        raise PublisherIdentityNotFound("作者清单不存在")
    active_key(s, owner_id=row["owner_id"], key_id=row["key_id"])
    return {"publication_id": publication_id, "owner_id": row["owner_id"],
            "key_id": row["key_id"], "artifact_digest": row["artifact_digest"],
            "package_digest": row["package_digest"], "author_manifest": row["manifest"]}


def issuer_authorized(authorization: str | None) -> bool:
    expected = os.getenv("V8_TASK_ADAPTER_KEY_LOOKUP_TOKEN", "")
    return (32 <= len(expected) <= 2048 and isinstance(authorization, str)
            and hmac.compare_digest(authorization, "Bearer " + expected))


def roots_for_owner(s: Session, *, owner_id: int) -> dict[str, dict[str, str]]:
    """Current active account-bound author keys for Shanghai product checks."""
    if not _account_active(s, owner_id):
        return {}
    rows = s.execute(select(keys_t.c.key_id, keys_t.c.public_key).where(
        keys_t.c.owner_id == owner_id, keys_t.c.revoked_at.is_(None))).all()
    return {str(owner_id): {key_id: public_key for key_id, public_key in rows}}
