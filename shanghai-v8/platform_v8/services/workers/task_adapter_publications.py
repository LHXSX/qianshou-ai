"""Owner intake and independent review of order-taking task adapters.

This module stores control-plane metadata only.  Author declarations, local
self-tests and admin clicks are never converted into trusted verification.
Receipts are checked against deployment-owned, purpose-separated Ed25519 roots
on approval *and again* on every readiness read, so expiry or key removal closes
the gate.  Media bytes and packages are never fetched by Shanghai here.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import exists, and_, insert, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from platform_v8.engine.task_registry import BUILTIN_TASK_TYPES, TASK_REGISTRY
from platform_v8.services.workers.reviewed_task_definition import candidate_spec
from platform_v8.services.workers import publication_lifecycle as lifecycle
from platform_v8.storage.repo import (
    AuditRepo, accounts_t, task_adapter_package_uploads_t as package_uploads_t,
    task_adapter_author_manifests_t as author_manifests_t,
    task_adapter_media_revalidation_t as media_revalidation_t,
    task_adapter_review_samples_t as review_samples_t,
    task_adapter_publications_t as publications_t,
    order_adapter_products_t as products_t,
)

_DIGEST = re.compile(r"(?:sha256:)?[0-9a-f]{64}\Z")
_VERSION = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}\Z")
_B64 = re.compile(r"[A-Za-z0-9_-]+={0,2}\Z")
_RECEIPT_SCHEMA = "task-adapter-publication-evidence.v1"
_RECEIPT_KINDS = ("package", "media", "sample", "pricing", "review")
_MAX_RECEIPT_BYTES = 64 * 1024
_PACKAGE_LOCK_ISSUE = "package: 对象锁期限不足以覆盖本次订单和复核窗口"
_MEDIA_LOCK_ISSUE = "media: GIF/MP4 样单对象锁即将到期"
_SAMPLE_VERSION = re.compile(r"[A-Za-z0-9_.~+-]{1,200}\Z")
# we_audit.target_kind is VARCHAR(20) in the deployed PostgreSQL schema.
_AUDIT_TARGET_KIND = "task_adapter_pub"


def _spec_for_row(row: dict[str, Any]) -> Any | None:
    """Static platform contract or bounded proposed contract for new types."""
    if row["task_type"] in BUILTIN_TASK_TYPES:
        return TASK_REGISTRY.get(row["task_type"])
    return candidate_spec(row)


def _definition_in_signed_manifest(row: dict[str, Any],
                                   signed_manifest: Any) -> bool:
    """Bind the proposed machine contract to canonical bytes in v5 source."""
    if not isinstance(signed_manifest, Mapping):
        return False
    definition = row.get("task_definition")
    if not isinstance(definition, dict):
        return False
    envelope = signed_manifest.get("manifest")
    if not isinstance(envelope, dict):
        return False
    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        return False
    files = payload.get("files") or []
    if (payload.get("inventory_algorithm") not in {"qianshou.source-package.v1", "qianshou.native-binding-package.v1"}
            or not isinstance(files, list)):
        return False
    entry = next((item for item in files if isinstance(item, dict)
                  and item.get("path") == "task-definition.json"), None)
    encoded = _canonical(definition)
    return (entry is not None and entry.get("size_bytes") == len(encoded)
            and entry.get("sha256") == hashlib.sha256(encoded).hexdigest())


def package_snapshot_for_issuer(s: Session, publication_id: str) -> dict[str, Any]:
    """Read-only control snapshot for Guangzhou's independent v5 package issuer.

    The bearer-protected caller still has to verify the author signature and
    exact locked COS bytes itself. Neither the archive nor a download URL is
    returned by Shanghai.
    """
    from uuid import UUID
    from platform_v8.services.workers.order_package_provenance import (
        PackageProvenanceError, verify_enrolled_manifest_metadata,
    )
    from platform_v8.services.workers.task_adapter_publisher_identity import active_key

    try:
        if str(UUID(publication_id)) != publication_id:
            raise ValueError("noncanonical UUID")
    except (TypeError, ValueError, AttributeError) as exc:
        raise PublicationError("投稿编号无效") from exc
    row_raw = s.execute(select(publications_t).where(
        publications_t.c.id == publication_id)).mappings().first()
    if row_raw is None:
        raise PublicationNotFound("接单技能投稿不存在")
    row = dict(row_raw)
    if not lifecycle.active(s, row["id"]):
        raise PublicationConflict("投稿已撤回或归档，请刷新记录")
    if row["status"] != "review":
        raise PublicationConflict("接单技能投稿已不在待审状态")
    upload_raw = s.execute(select(package_uploads_t).where(
        package_uploads_t.c.publication_id == publication_id)).mappings().first()
    author_raw = s.execute(select(author_manifests_t).where(
        author_manifests_t.c.publication_id == publication_id)).mappings().first()
    if upload_raw is None or author_raw is None:
        raise PublicationConflict("不可变归档或作者签名清单尚未齐备")
    upload, author = dict(upload_raw), dict(author_raw)
    retain = upload["lock_retain_until"]
    if retain is not None and retain.tzinfo is None:
        retain = retain.replace(tzinfo=timezone.utc)
    expected_key = (f"v8/account-{row['owner_id']}/publication/{publication_id}"
                    "/adapter/source.zip")
    if (upload["status"] != "confirmed" or upload["owner_id"] != row["owner_id"]
            or upload["archive_digest"] is None
            or upload["bucket"] is None or upload["object_key"] != expected_key
            or not isinstance(upload["version_id"], str)
            or upload["version_id"] == "null" or retain is None
            or retain.timestamp() <= time.time() + 86400
            or author["owner_id"] != row["owner_id"]
            or author["artifact_digest"] != row["artifact_digest"]
            or author["package_digest"] != row["package_digest"]):
        raise PublicationConflict("归档或作者清单与当前投稿不一致")
    try:
        enrolled = active_key(s, owner_id=row["owner_id"], key_id=author["key_id"])
        verify_enrolled_manifest_metadata(
            author["manifest"], owner_id=row["owner_id"],
            artifact_digest=row["artifact_digest"],
            package_digest=row["package_digest"],
            publisher_roots={str(row["owner_id"]): {
                author["key_id"]: enrolled["public_key"]}},
            publication_id=publication_id, task_type=row["task_type"],
            capability_id=row["capability_id"], version=row["version"])
    except (PackageProvenanceError, ValueError) as exc:
        raise PublicationConflict("作者签名清单无效或公钥已撤销") from exc
    manifest = author["manifest"]
    native = manifest["payload"].get("inventory_algorithm") == "qianshou.native-binding-package.v1"
    if (manifest["payload"].get("inventory_algorithm") not in {
            "qianshou.source-package.v1", "qianshou.native-binding-package.v1"}
            or (not native and row["package_digest"] != row["artifact_digest"])
            or not _definition_in_signed_manifest(row, author)
            or (native and candidate_spec(row) is None)):
        raise PublicationConflict("v5 任务定义未绑定已登记的签名源码包")
    return {
        "schema": "qianshou.package-review-snapshot."+row["contract_version"] if native else "qianshou.package-review-snapshot.v1",
        "publication": {**({"contract_version":"v2"} if native and row["contract_version"]=="v2" else {}), **{key: row[key] for key in (
            "id", "owner_id", "status", "task_type", "capability_id",
            "category", "input_kinds", "output_kind", "version",
            "artifact_digest", "package_digest", "task_definition")}},
        "upload": {
            "status": upload["status"], "owner_id": upload["owner_id"],
            "bucket": upload["bucket"], "object_key": upload["object_key"],
            "version_id": upload["version_id"],
            "archive_digest": upload["archive_digest"],
            "size_bytes": upload["size_bytes"],
            "lock_retain_until": int(retain.timestamp()),
        },
        "author": {"key_id": author["key_id"],
                   "public_key": enrolled["public_key"], "status": "active",
                   "manifest": manifest},
    }


def sample_snapshot_for_issuer(s: Session, publication_id: str) -> dict[str, Any]:
    """Bounded control snapshot for an isolated off-box sample issuer."""
    snapshot = package_snapshot_for_issuer(s, publication_id)
    row = _get(s, publication_id)
    package = (row.get("review_evidence") or {}).get("package")
    if _receipt_issue("package", package, row, reviewer_id=None,
                      now=int(time.time()), roots=_roots()) is not None:
        raise PublicationConflict("当前投稿没有有效的独立验包回执")
    owner_status = s.execute(select(accounts_t.c.status).where(
        accounts_t.c.id == row["owner_id"])).scalar_one_or_none()
    if owner_status != "active":
        raise PublicationConflict("投稿账号已停用")
    return {
        **snapshot, "schema": "qianshou.sample-review-snapshot.v1",
        "publication": {**snapshot["publication"],
                        "contract_version": row["contract_version"],
                        "description": row["description"]},
        "publisher_status": "active",
        "package_receipt": package,
    }


def _result_verifier_wired(spec: Any) -> bool:
    """Require a settlement path in the loaded verifier, not a task flag alone.

    The publication API can be upgraded separately from the result worker.
    An older worker must keep review closed even when the remote media health
    probe becomes ready. The same path returned here is used for settlement.
    """
    try:
        from platform_v8.services import result_verifier
        from platform_v8.services.workloads.reviewed_adapter_contract import input_contract_loaded
        lookup = getattr(result_verifier, "reviewed_result_path_for_spec", None)
        return (input_contract_loaded(getattr(spec, "adapter_input_contract", ""))
                and callable(lookup) and callable(lookup(spec)))
    except Exception:
        return False


def _evidence_ref(value: Any) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= 200 and not any(ch.isspace() for ch in value)


def _sample_ref_valid(value: Any, *, owner_id: int, fmt: str,
                      receipt_expires_at: int) -> bool:
    if not isinstance(value, dict) or set(value) != {
            "bucket", "object_key", "object_version_id", "sha256",
            "size_bytes", "lock_retained_until"}:
        return False
    key = value.get("object_key")
    expected = (rf"v8/account-{owner_id}/workload-[A-Za-z0-9_.-]{{1,100}}/"
                rf"shard-[A-Za-z0-9_.-]{{1,100}}/result/[0-9a-f-]{{36}}/result\.{fmt}")
    return (isinstance(value.get("bucket"), str)
            and re.fullmatch(r"[a-z0-9][a-z0-9.-]{2,199}", value["bucket"]) is not None
            and isinstance(key, str) and re.fullmatch(expected, key) is not None
            and isinstance(value.get("object_version_id"), str)
            and _SAMPLE_VERSION.fullmatch(value["object_version_id"]) is not None
            and value["object_version_id"] != "null"
            and isinstance(value.get("sha256"), str)
            and re.fullmatch(r"[0-9a-f]{64}", value["sha256"]) is not None
            and type(value.get("size_bytes")) is int and 1 <= value["size_bytes"] <= 2 * 1024 ** 3
            and type(value.get("lock_retained_until")) is int
            and value["lock_retained_until"] >= receipt_expires_at + 86400)


class PublicationError(ValueError):
    pass


class PublicationConflict(PublicationError):
    pass


class PublicationNotFound(PublicationError):
    pass


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _b64decode(value: Any, expected_length: int) -> bytes:
    if not isinstance(value, str) or not _B64.fullmatch(value) or len(value) > 128:
        raise ValueError("base64url invalid")
    result = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if len(result) != expected_length:
        raise ValueError("base64url length invalid")
    return result


def _roots() -> dict[str, dict[str, Ed25519PublicKey]]:
    """Trust roots are operator configuration, never a request or database field."""
    raw = os.environ.get("V8_TASK_PUBLICATION_TRUST_ROOTS", "")
    if not raw or len(raw) > 8192:
        return {}
    try:
        parsed = json.loads(raw)
        if (not isinstance(parsed, dict) or not parsed
                or not set(parsed).issubset(set(_RECEIPT_KINDS))):
            return {}
        roots: dict[str, dict[str, Ed25519PublicKey]] = {}
        seen: set[bytes] = set()
        for kind, entries in parsed.items():
            if not isinstance(entries, dict) or not 1 <= len(entries) <= 8:
                return {}
            roots[kind] = {}
            for key_id, encoded in entries.items():
                if not isinstance(key_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", key_id):
                    return {}
                key_bytes = _b64decode(encoded, 32)
                if key_bytes in seen:
                    return {}  # Different evidence roles must not share a key.
                seen.add(key_bytes)
                roots[kind][key_id] = Ed25519PublicKey.from_public_bytes(key_bytes)
        return roots
    except (TypeError, ValueError, KeyError):
        return {}


def issuer_authorized(kind: str, authorization: str | None) -> bool:
    """Independent issuers deposit evidence; authors/admins cannot self-assert."""
    if kind not in _RECEIPT_KINDS or not isinstance(authorization, str):
        return False
    raw = os.environ.get("V8_TASK_PUBLICATION_EVIDENCE_TOKENS", "")
    if not raw or len(raw) > 8192:
        return False
    try:
        tokens = json.loads(raw)
        if (not isinstance(tokens, dict) or not tokens
                or not set(tokens).issubset(set(_RECEIPT_KINDS))
                or any(not isinstance(token, str) or not 32 <= len(token) <= 2048
                       for token in tokens.values())
                or len(set(tokens.values())) != len(tokens)):
            return False
        expected = tokens.get(kind)
        return (isinstance(expected, str) and
                hmac.compare_digest(authorization, "Bearer " + expected))
    except (TypeError, ValueError):
        return False


def _yuan(value: Any) -> str:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise PublicationError("price_yuan 必须是人民币金额") from exc
    if not amount.is_finite() or amount < 0 or amount > 100000 or amount.as_tuple().exponent < -2:
        raise PublicationError("price_yuan 须为 0–100000 元，最多两位小数")
    return f"{amount:.2f}"


def _normalize(body: dict[str, Any]) -> dict[str, Any]:
    spec = _spec_for_row(body)
    if spec is None:
        raise PublicationError("任务类型未在平台显式登记")
    if not spec.requires_verified_adapter:
        raise PublicationError("此任务尚无专用接单适配器审核合同，不能提交平台发布")
    if not _result_verifier_wired(spec):
        raise PublicationError("此任务尚无独立结果验收合同，不能提交平台发布")
    digest = str(body["artifact_digest"]).strip().lower()
    package_digest = str(body["package_digest"]).strip().lower()
    if not _DIGEST.fullmatch(digest) or not _DIGEST.fullmatch(package_digest):
        raise PublicationError("适配器与包摘要必须是 SHA-256")
    if not digest.startswith("sha256:"):
        digest = "sha256:" + digest
    if not package_digest.startswith("sha256:"):
        package_digest = "sha256:" + package_digest
    input_kinds = body["input_kinds"]
    if (not isinstance(input_kinds, list) or not input_kinds
            or len(input_kinds) != len(set(input_kinds))
            or tuple(input_kinds) != tuple(spec.accepted_input_kinds)
            or body["capability_id"] != spec.adapter_capability_id
            or body["output_kind"] != spec.adapter_output_kind
            or body["contract_version"] not in ({"v1", "v2"} if spec.adapter_input_contract == "h3-prompt-fixed-frame.v1" else {"v1"})):
        raise PublicationError("适配器声明与已登记任务合同不一致")
    if not _VERSION.fullmatch(body["version"]):
        raise PublicationError("version 格式非法")
    result = {key: body[key] for key in (
        "task_type", "capability_id", "input_kinds", "output_kind", "contract_version",
        "version", "name", "category", "description", "configuration",
    )}
    result["artifact_digest"] = digest
    result["package_digest"] = package_digest
    result["task_definition"] = body.get("task_definition")
    result["currency"] = "CNY"
    result["price_yuan"] = _yuan(body["price_yuan"])
    if body.get("sale_price_yuan") is not None:
        result["sale_price_yuan"] = _yuan(body["sale_price_yuan"])
    return result


def _row(row: Any) -> dict[str, Any]:
    value = dict(row)
    for key in ("created_at", "updated_at", "reviewed_at"):
        if isinstance(value.get(key), datetime):
            value[key] = value[key].isoformat() + "Z"
    value["price_yuan"] = _yuan(value["price_yuan"])
    if value.get("sale_price_yuan") is not None:
        value["sale_price_yuan"] = _yuan(value["sale_price_yuan"])
    return value


def _get(s: Session, publication_id: str, *, lock: bool = False) -> dict[str, Any]:
    query = select(publications_t).where(publications_t.c.id == publication_id)
    if lock:
        query = query.with_for_update()
    result = s.execute(query).mappings().first()
    if result is None:
        raise PublicationNotFound("接单技能投稿不存在")
    return dict(result)


def submit(s: Session, *, owner_id: int, body: dict[str, Any]) -> dict[str, Any]:
    body = dict(body)
    proposed_spec = _spec_for_row(body)
    needs_server_price = body.get("price_yuan") in (None, "")
    dynamic_type = body["task_type"] not in BUILTIN_TASK_TYPES
    if proposed_spec is not None and (dynamic_type or needs_server_price):
        configured = _configured_price(s, body["task_type"], spec=proposed_spec)
        if configured is None:
            raise PublicationError("平台尚未审核此任务策略的人民币通用价目")
        if needs_server_price:
            # The author chooses publish once; the platform owns the price.
            body["price_yuan"] = configured[0]
        elif dynamic_type and _yuan(body["price_yuan"]) != configured[0]:
            raise PublicationError("投稿价格与平台已审核人民币价目不一致")
    fields = _normalize(body)
    fingerprint = _digest(fields)
    key = (owner_id, fields["task_type"], fields["artifact_digest"])
    existing = s.execute(select(publications_t).where(
        publications_t.c.owner_id == key[0], publications_t.c.task_type == key[1],
        publications_t.c.artifact_digest == key[2],
    )).mappings().first()
    if existing is not None:
        if existing["submission_fingerprint"] != fingerprint:
            raise PublicationConflict("同一包摘要已有不同投稿；请以新版本和新摘要提交")
        return _serialize(s, dict(existing))
    publication_id = str(uuid4())
    try:
        with s.begin_nested():
            s.execute(insert(publications_t).values(
                id=publication_id, owner_id=owner_id, **fields,
                submission_fingerprint=fingerprint, status="review",
                review_evidence={}, review_note="",
            ))
    except IntegrityError:
        existing = s.execute(select(publications_t).where(
            publications_t.c.owner_id == key[0], publications_t.c.task_type == key[1],
            publications_t.c.artifact_digest == key[2],
        )).mappings().first()
        if existing is None or existing["submission_fingerprint"] != fingerprint:
            raise PublicationConflict("同一任务或摘要发生并发冲突") from None
        return _serialize(s, dict(existing))
    AuditRepo.write(s, action="task_adapter_publication.submit", actor_account_id=owner_id,
                    actor_kind="account", target_kind=_AUDIT_TARGET_KIND,
                    target_id=publication_id,
                    detail={"task_type": fields["task_type"], "artifact_digest": fields["artifact_digest"]})
    s.flush()
    return _serialize(s, _get(s, publication_id))


def mine(s: Session, *, owner_id: int, include_archived: bool = False) -> dict[str, Any]:
    visibility = True if include_archived else ~exists(select(lifecycle.states.c.publication_id).where(
        lifecycle.states.c.publication_id == publications_t.c.id, lifecycle.states.c.archived))
    rows = s.execute(select(publications_t).where(publications_t.c.owner_id == owner_id, visibility)
                     .order_by(publications_t.c.created_at.desc()).limit(100)).mappings().all()
    ids = [row["id"] for row in rows]
    upload_states = dict(s.execute(select(
        package_uploads_t.c.publication_id, package_uploads_t.c.status,
    ).where(package_uploads_t.c.publication_id.in_(ids))).all()) if ids else {}
    signed_ids = set(s.execute(select(
        author_manifests_t.c.publication_id,
    ).where(author_manifests_t.c.publication_id.in_(ids))).scalars().all()) if ids else set()
    sample_states: dict[str, dict[str, dict[str, Any]]] = {}
    if ids:
        for publication_id, fmt, state, lease_expires_at, verify_receipt in s.execute(select(
                review_samples_t.c.publication_id, review_samples_t.c.format,
                review_samples_t.c.status, review_samples_t.c.lease_expires_at,
                review_samples_t.c.verify_receipt).where(
                    review_samples_t.c.publication_id.in_(ids))):
            sample_states.setdefault(publication_id, {})[fmt] = {
                "status": state, "lease_expires_at": lease_expires_at,
                "verify_receipt": verify_receipt}
    media_material = dict(s.execute(select(
        media_revalidation_t.c.publication_id,
        media_revalidation_t.c.media_receipt_sha256,
    ).where(media_revalidation_t.c.publication_id.in_(ids))).all()) if ids else {}
    media_ready_cache: dict[str, bool] = {}
    return {"items": [_serialize(
        s, dict(row), media_ready_cache=media_ready_cache,
        package_upload_status=upload_states.get(row["id"], "missing"),
        author_manifest_status="recorded" if row["id"] in signed_ids else "missing",
        sample_jobs_status=sample_states.get(row["id"], {}),
        media_material_digest=media_material.get(row["id"], ""),
    ) for row in rows]}


def pending(s: Session, *, reviewer_id: int) -> dict[str, Any]:
    rows = s.execute(select(publications_t).where(publications_t.c.status == "review", lifecycle.active_clause(publications_t.c.id))
                     .order_by(publications_t.c.created_at.asc()).limit(100)).mappings().all()
    media_ready_cache: dict[str, bool] = {}
    return {"items": [_serialize(s, dict(row), reviewer_id=reviewer_id,
                                 media_ready_cache=media_ready_cache) for row in rows]}


def _review_cursor(row: dict[str, Any]) -> str:
    payload = {"created_at": row["created_at"].isoformat(timespec="microseconds"),
               "id": row["id"]}
    return base64.urlsafe_b64encode(_canonical(payload)).decode("ascii").rstrip("=")


def _parse_review_cursor(value: str) -> tuple[datetime, str]:
    try:
        if not isinstance(value, str) or len(value) > 512 or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise ValueError("bad cursor")
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        data = json.loads(decoded)
        if set(data) != {"created_at", "id"} or not isinstance(data["id"], str):
            raise ValueError("bad cursor")
        created_at = datetime.fromisoformat(data["created_at"])
        if created_at.tzinfo is not None or not re.fullmatch(r"[0-9a-f-]{36}", data["id"]):
            raise ValueError("bad cursor")
        return created_at, data["id"]
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise PublicationError("独立审核队列游标非法") from exc


def pending_review_index(s: Session, *, kind: str, cursor: str | None = None) -> dict[str, Any]:
    """Minimal purpose-scoped machine queue; no archive, media or user data."""
    if kind not in {"package", "security", "contract", "sample"}:
        raise PublicationError("未知独立审核用途")
    evidence_kind = ("package" if kind == "package" else
                     "sample" if kind == "sample" else "review")
    query = select(publications_t).where(publications_t.c.status == "review", lifecycle.active_clause(publications_t.c.id))
    if cursor is not None:
        created_at, publication_id = _parse_review_cursor(cursor)
        query = query.where(or_(
            publications_t.c.created_at > created_at,
            and_(publications_t.c.created_at == created_at,
                 publications_t.c.id > publication_id),
        ))
    rows = s.execute(query.order_by(publications_t.c.created_at.asc(),
                                    publications_t.c.id.asc()).limit(101)).mappings().all()
    has_next = len(rows) > 100
    rows = rows[:100]
    ids = [row["id"] for row in rows]
    upload_states = dict(s.execute(select(
        package_uploads_t.c.publication_id, package_uploads_t.c.status,
    ).where(package_uploads_t.c.publication_id.in_(ids))).all()) if ids else {}
    roots, now = _roots(), int(time.time())
    items: list[dict[str, Any]] = []
    for row in rows:
        evidence = row["review_evidence"] or {}
        def evidence_state(receipt_kind: str) -> str:
            receipt = evidence.get(receipt_kind) if isinstance(evidence, dict) else None
            return ("missing" if receipt is None else
                    "valid" if _receipt_issue(receipt_kind, receipt, dict(row),
                                              reviewer_id=None, now=now, roots=roots) is None
                    else "invalid")
        state = evidence_state(evidence_kind)
        package_state = evidence_state("package")
        if kind == "sample":
            spec = _spec_for_row(dict(row))
            package = evidence.get("package") if isinstance(evidence, dict) else None
            payload = package.get("payload") if isinstance(package, dict) else None
            details = payload.get("details") if isinstance(payload, dict) else None
            if not isinstance(details, dict):
                details = {}
            if (package_state != "valid" or state == "valid"
                    or upload_states.get(row["id"]) != "confirmed"
                    or details.get("inventory_algorithm") != "qianshou.source-package.v1"
                    or spec is None or (spec.external_artifact_verifier_required and not spec.adapter_file_schema)
                    or tuple(spec.accepted_input_kinds) != ("inline",)
                    or spec.adapter_output_kind != ("artifact_ref" if spec.adapter_file_schema else "inline_json")):
                continue
        items.append({"publication_id": row["id"], "status": "review",
                      "version": row["version"], "evidence_status": state,
                      "package_evidence_status": package_state,
                      "package_upload_status": upload_states.get(row["id"], "missing")})
    return {"schema": "qianshou.pending-review-index.v1", "kind": kind,
            "items": items,
            "next_cursor": _review_cursor(rows[-1]) if has_next else None}


def _receipt_issue(kind: str, receipt: Any, row: dict[str, Any], *,
                   reviewer_id: int | None, now: int, roots: dict,
                   allow_expired: bool = False) -> str | None:
    if not roots or kind not in roots:
        return "平台未配置分用途验签信任根"
    try:
        if not isinstance(receipt, dict) or len(_canonical(receipt)) > _MAX_RECEIPT_BYTES:
            return "可信回执缺失或过大"
        key_id, payload, signature = receipt["key_id"], receipt["payload"], receipt["signature"]
        if not isinstance(payload, dict) or key_id not in roots[kind]:
            return "回执签发方不受信任"
        roots[kind][key_id].verify(_b64decode(signature, 64), _canonical(payload))
        expected = {
            "schema": _RECEIPT_SCHEMA, "kind": kind, "publication_id": row["id"],
            "owner_id": row["owner_id"], "task_type": row["task_type"],
            "artifact_digest": row["artifact_digest"], "package_digest": row["package_digest"],
            "result": "pass",
        }
        if any(payload.get(key) != value for key, value in expected.items()):
            return "回执未绑定当前投稿及精确摘要"
        issued_at, expires_at = payload.get("issued_at"), payload.get("expires_at")
        if (not isinstance(issued_at, int) or isinstance(issued_at, bool)
                or not isinstance(expires_at, int) or isinstance(expires_at, bool)
                or issued_at > now + 60 or expires_at <= issued_at
                or (expires_at <= now and not allow_expired)
                or expires_at - issued_at > 90 * 86400):
            return "回执时间无效或已过期"
        details = payload.get("details")
        if not isinstance(details, dict):
            return "回执细项缺失"
        if kind == "package" and not (
            details.get("publisher_signature_verified") is True
            and details.get("immutable_package_verified") is True
            and details.get("dispatchable_package_verified") is True
            and details.get("inventory_algorithm") in {
                "qianshou.bar-chart-package.v4", "qianshou.source-package.v1", "qianshou.native-binding-package.v1"}
            and details.get("publisher_owner_id") == row["owner_id"]
            and _evidence_ref(details.get("publisher_key_id"))
            and _evidence_ref(details.get("immutable_package_ref"))
            and isinstance(details.get("archive_digest"), str)
            and _DIGEST.fullmatch(details["archive_digest"])
            and type(details.get("archive_size_bytes")) is int
            and 1 <= details["archive_size_bytes"] <= 16 * 1024 * 1024
            and _evidence_ref(details.get("archive_bucket"))
            and _evidence_ref(details.get("archive_object_key"))
            and _evidence_ref(details.get("archive_version_id"))
            and details.get("archive_object_lock_verified") is True
            and details.get("immutable_package_ref") == (
                f"oss://{details['archive_bucket']}/{details['archive_object_key']}"
                f"?versionId={details['archive_version_id']}")
        ):
            return "缺少可信发布者验签与不可变包证明"
        if kind == "media" and not (
            details.get("external_result_verifier_ready") is True
            and details.get("order_bound_receipt_verified") is True
            and details.get("animation_semantics_verified") is True
            and details.get("output_kind") == row["output_kind"]
            and details.get("semantic_scope") == "full-recipe-v1"
            and set(details.get("formats") or []) >= {"gif", "mp4"}
            and _evidence_ref(details.get("gif_receipt_id"))
            and _evidence_ref(details.get("mp4_receipt_id"))
            and _evidence_ref(details.get("runner_execution_evidence_id"))
            and _sample_ref_valid(details.get("gif_sample_ref"), owner_id=row["owner_id"],
                                  fmt="gif", receipt_expires_at=expires_at)
            and _sample_ref_valid(details.get("mp4_sample_ref"), owner_id=row["owner_id"],
                                  fmt="mp4", receipt_expires_at=expires_at)
            and isinstance(details.get("package_archive_digest"), str)
            and _DIGEST.fullmatch(details["package_archive_digest"])
            and _evidence_ref(details.get("package_immutable_version_id"))
        ):
            return "缺少 GIF/MP4 外置媒体验收证明"
        if kind == "sample":
            spec = _spec_for_row(row)
            file_abi = bool(spec is not None and getattr(spec, "adapter_file_schema", None))
            native_h3 = bool(spec is not None and spec.adapter_input_contract == "h3-prompt-fixed-frame.v1")
            buyer_confirmed = bool(
                spec is not None
                and spec.adapter_input_contract == "inline-json-bounded.v1"
                and spec.adapter_result_strategy == "buyer-confirmed-structure.v1"
                and spec.adapter_output_schema
            )
            if not (
                spec is not None and spec.requires_verified_adapter
                and (not spec.external_artifact_verifier_required or file_abi or native_h3)
                and details.get("independent_execution_verified") is True
                and (details.get("result_semantics_verified") is False
                     and details.get("structure_verified") is True
                     if buyer_confirmed or file_abi or native_h3 else
                     details.get("result_semantics_verified") is True)
                and details.get("input_contract") == spec.adapter_input_contract
                and details.get("result_strategy") == spec.adapter_result_strategy
                and type(details.get("sample_count")) is int
                and details["sample_count"] >= 2
                and _evidence_ref(details.get("execution_evidence_id"))
                and isinstance(details.get("sample_input_sha256"), str)
                and _DIGEST.fullmatch(details["sample_input_sha256"])
                and isinstance(details.get("sample_output_sha256"), str)
                and _DIGEST.fullmatch(details["sample_output_sha256"])
                and isinstance(details.get("package_archive_digest"), str)
                and _DIGEST.fullmatch(details["package_archive_digest"])
                and _evidence_ref(details.get("package_immutable_version_id"))
            ):
                return "缺少独立执行与已审核结果策略样单证明"
            if native_h3:
                from platform_v8.protocol.native_h3 import validate_definition
                if row.get("contract_version") == "v2":
                    from platform_v8.protocol.native_h3_v2 import validate_definition
                from platform_v8.protocol.native_h3_review import ARTIFACT_FIELDS
                native = validate_definition(row)
                if row.get("contract_version") == "v2":
                    from platform_v8.protocol.native_h3_v2 import logical_binding_sha256
                    if (details.get("logical_binding_sha256") != logical_binding_sha256(native["nativeBinding"])
                            or not isinstance(details.get("local_owner_config_digest"), str)
                            or not re.fullmatch(r"sha256:[0-9a-f]{64}", details["local_owner_config_digest"])
                            or type(details.get("device_binding_revision")) is not int
                            or not 1 <= details["device_binding_revision"] <= 9007199254740991):
                        return "原生H3 v2样例缺少真实设备配置版本绑定"
                samples = details.get("samples")
                if (details.get("native_binding") != native["nativeBinding"] or not isinstance(samples,list)
                    or len(samples)!=2 or len({x.get("challenge_nonce") for x in samples if isinstance(x,dict)})!=2
                    or any(not isinstance(x,dict) or set(x.get("artifact",{})) != ARTIFACT_FIELDS
                           or x.get("observed",{}).get("decoded_frames_verified") is not True
                           or x.get("observed",{}).get("prompt_semantics_verified") is not False for x in samples)):
                    return "原生H3样例未绑定固定运行时及独立完整MP4解码"
            if file_abi:
                from platform_v8.protocol.generic_file import file_schema_sha256
                if (details.get("file_abi_verified") is not True
                        or details.get("file_schema_sha256") != file_schema_sha256(spec.adapter_file_schema)):
                    return "文件样例回执未绑定已审核声明"
        if kind == "pricing":
            if (details.get("currency") != "CNY" or details.get("price_yuan") != _yuan(row["price_yuan"])
                    or not isinstance(details.get("settings_version"), int)
                    or isinstance(details.get("settings_version"), bool)):
                return "价格回执与人民币报价或配置版本不一致"
        if kind == "review" and not (
            details.get("security_review_passed") is True
            and details.get("contract_review_passed") is True
            and isinstance(details.get("reviewer_id"), int)
            and not isinstance(details.get("reviewer_id"), bool)
            and _evidence_ref(details.get("review_report_id"))
            and (reviewer_id is None or details["reviewer_id"] == reviewer_id)
        ):
            return "独立安全与任务合同审查证据缺失"
    except (KeyError, TypeError, ValueError, InvalidSignature):
        return "回执签名或格式无效"
    return None


def _approved_receipt_issue(kind: str, receipt: Any, row: dict[str, Any], *,
                            reviewer_id: int | None, now: int,
                            roots: dict) -> str | None:
    """Keep a completed review as an attestation, bound to its approval time.

    The one-hour issuer window is the window in which an administrator may
    approve the submission. After approval the immutable evidence must still
    have its original signature, active trust root and exact review fingerprint.
    Runtime admission separately rechecks the author key, price row, package
    version/lock and result-verifier availability in ``_issues``.
    """
    if row.get("status") != "approved":
        return _receipt_issue(kind, receipt, row, reviewer_id=reviewer_id,
                              now=now, roots=roots)
    reviewed_at = row.get("reviewed_at")
    evidence = row.get("review_evidence")
    note = row.get("review_note")
    if (not isinstance(reviewed_at, datetime)
            or not isinstance(evidence, dict) or not isinstance(note, str)
            or row.get("review_fingerprint") !=
            _digest({"evidence": evidence, "note": note})):
        return "已批准审核记录指纹无效"
    issue = _receipt_issue(kind, receipt, row, reviewer_id=reviewer_id,
                           now=now, roots=roots, allow_expired=True)
    if issue:
        return issue
    if reviewed_at.tzinfo is None:
        reviewed_at = reviewed_at.replace(tzinfo=timezone.utc)
    approved_at = int(reviewed_at.timestamp())
    payload = receipt["payload"]
    if (payload["issued_at"] > approved_at + 60
            or payload["expires_at"] <= approved_at):
        return "回执不在管理员审核时效内"
    return None


def deposit_evidence(s: Session, *, publication_id: str, kind: str,
                     receipt: dict[str, Any],
                     revalidation_material: dict[str, Any] | None = None) -> dict[str, Any]:
    """Write only a purpose-signed independent receipt through issuer ingress."""
    if kind not in _RECEIPT_KINDS:
        raise PublicationError("未知审核证据用途")
    row = _get(s, publication_id, lock=True)
    if not lifecycle.active(s, row["id"]):
        raise PublicationConflict("投稿已撤回或归档，请刷新记录")
    if row["status"] != "review":
        raise PublicationConflict("仅待审核投稿可接收审核证据")
    issue = _receipt_issue(kind, receipt, row, reviewer_id=None,
                           now=int(time.time()), roots=_roots())
    if issue:
        raise PublicationError(f"{kind}: {issue}")
    if revalidation_material is not None:
        if kind != "media":
            raise PublicationError("仅媒体回执可携带独立复验控制元数据")
        from platform_v8.services.workers.task_adapter_revalidation import store_original
        store_original(s, row=row, media_receipt=receipt, material=revalidation_material)
    evidence = dict(row["review_evidence"] or {})
    if evidence.get(kind) == receipt:
        return _serialize(s, row)
    evidence[kind] = receipt
    now = datetime.utcnow()
    changed = s.execute(update(publications_t).where(
        publications_t.c.id == publication_id,
        publications_t.c.status == "review",
    ).values(review_evidence=evidence, updated_at=now))
    if changed.rowcount != 1:
        raise PublicationConflict("投稿审核状态已变化，请重新读取")
    AuditRepo.write(s, action="task_adapter_publication.evidence_deposit",
                    actor_kind="service", target_kind=_AUDIT_TARGET_KIND,
                    target_id=publication_id,
                    detail={"kind": kind, "receipt_sha256": _digest(receipt),
                            "replaced": kind in (row["review_evidence"] or {})})
    s.flush()
    return _serialize(s, _get(s, publication_id))


def _configured_price(s: Session, task_type: str, *, spec: Any = None) -> tuple[str, int] | None:
    try:
        from platform_v8.services.economy.task_pricing import _load_settings
        from platform_v8.services.economy.reviewed_adapter_tariffs import resolve_tariff
        settings = _load_settings(s)
        rows = [item for item in settings.get("task_pricing", [])
                if isinstance(item, dict) and item.get("task_type") == task_type]
        if len(rows) > 1:
            return None
        row = rows[0] if rows else resolve_tariff(
            settings, spec if spec is not None else TASK_REGISTRY.get(task_type))
        if row is None:
            return None
        price = _yuan(row["base_price"])
        if Decimal(price) <= 0:
            return None
        return price, int(settings["version"])
    except Exception:
        return None


def preview_reviewed_price(s: Session, *, task_type: str,
                           task_definition: dict[str, Any]) -> dict[str, Any]:
    """Quote an author's proposed machine contract from server-owned CNY policy.

    This does not approve a package or lock a price. Submission rechecks the
    exact policy and the independent issuer later signs the current version.
    """
    try:
        if len(_canonical(task_definition)) > 8192:
            raise PublicationError("任务定义超过平台上限")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise PublicationError("任务定义无法规范编码") from exc
    if task_type in BUILTIN_TASK_TYPES:
        spec = TASK_REGISTRY.get(task_type)
        if (spec is None or not spec.requires_verified_adapter
                or task_definition.get("schema") != "qianshou.reviewed-task-definition.v1"
                or task_definition.get("taskType") != task_type
                or task_definition.get("capabilityId") != spec.adapter_capability_id
                or task_definition.get("category") != spec.category
                or tuple(task_definition.get("inputKinds") or ()) != tuple(spec.accepted_input_kinds)
                or task_definition.get("outputKind") != spec.adapter_output_kind
                or task_definition.get("inputContract") != spec.adapter_input_contract
                or task_definition.get("resultStrategy") != spec.adapter_result_strategy):
            raise PublicationError("任务定义与已审核平台任务合同不一致")
    else:
        row = {"task_type": task_type, "task_definition": task_definition,
               "capability_id": task_definition.get("capabilityId"),
               "category": task_definition.get("category"),
               "input_kinds": task_definition.get("inputKinds"),
               "output_kind": task_definition.get("outputKind"),
               "contract_version": "v1", "description": "平台价目预览"}
        spec = candidate_spec(row)
    if spec is None or not _result_verifier_wired(spec):
        raise PublicationError("任务定义尚不符合平台通用执行和验收合同")
    configured = _configured_price(s, task_type, spec=spec)
    if configured is None:
        raise PublicationError("平台尚未审核此任务策略的人民币通用价目")
    return {"pricing_mode": "platform", "currency": "CNY",
            "price_yuan": configured[0], "settings_version": configured[1],
            "task_definition_sha256": "sha256:" + _digest(task_definition),
            "input_contract": spec.adapter_input_contract,
            "result_strategy": spec.adapter_result_strategy,
            "output_kind": spec.adapter_output_kind}


def _configured_pricing_row_digest(s: Session, task_type: str, *, spec: Any = None) -> str | None:
    """Re-read the persisted CNY row that the independent issuer signed."""
    try:
        from platform_v8.services.workers.task_adapter_pricing_issuer import _server_price
        return _server_price(s, task_type, spec=spec)[2]
    except Exception:
        return None


def _external_media_verifier_ready(task_type: str, spec: Any = None) -> bool:
    """Live signed challenge, not an admin-controlled or static boolean."""
    try:
        if getattr(spec, "adapter_file_schema", None):
            from platform_v8.services.external_file_verifier import available
            return available() is True
        from platform_v8.services.external_media_verifier import available
        return available(task_type, spec) is True
    except Exception:
        return False


def _issues(s: Session, row: dict[str, Any], evidence: Any,
            *, reviewer_id: int | None = None, require_runtime_pin: bool = False,
            media_ready_cache: dict[str, bool] | None = None) -> list[str]:
    issues: list[str] = []
    spec = _spec_for_row(row)
    if spec is None:
        issues.append("任务合同未登记或已撤销")
    elif not spec.requires_verified_adapter:
        issues.append("尚无专用接单适配器审核合同")
    elif not _result_verifier_wired(spec):
        issues.append("尚无独立结果验收合同")
    elif (row["capability_id"] != spec.adapter_capability_id
          or row["output_kind"] != spec.adapter_output_kind
          or tuple(row["input_kinds"] or []) != tuple(spec.accepted_input_kinds)):
        issues.append("平台任务合同与投稿适配器不匹配")
    # The approved, signed DB row is the runtime pin. An optional code-level
    # digest may narrow it further but an empty candidate constant cannot
    # silently override a later independently reviewed publication.
    if (require_runtime_pin and spec is not None and spec.approved_adapter_digest
            and spec.approved_adapter_digest != row["artifact_digest"]):
        issues.append("代码级固定摘要与已审发布摘要不一致")
    if not isinstance(evidence, dict):
        evidence = {}
    roots = _roots()
    now = int(time.time())
    required = ["package", "pricing", "review"]
    if spec is not None and spec.external_artifact_verifier_required:
        required.append("sample" if getattr(spec, "adapter_file_schema", None) or spec.adapter_input_contract == "h3-prompt-fixed-frame.v1" else "media")
        media_key = (f"{row['task_type']}|{spec.adapter_input_contract}|"
                     f"{spec.adapter_result_strategy}")
        media_ready = (media_ready_cache.get(media_key)
                       if media_ready_cache is not None else None)
        if media_ready is None:
            media_ready = _external_media_verifier_ready(row["task_type"], spec)
            if media_ready_cache is not None:
                media_ready_cache[media_key] = media_ready
        if not media_ready:
            issues.append("外置文件字节校验服务尚未接入实际结算链路" if getattr(spec, "adapter_file_schema", None)
                          else "外置媒体结果校验服务尚未接入实际结算链路")
    elif spec is not None and spec.requires_verified_adapter:
        required.append("sample")
    valid_receipts: dict[str, dict[str, Any]] = {}
    for kind in required:
        issue = _approved_receipt_issue(kind, evidence.get(kind), row,
                                        reviewer_id=reviewer_id, now=now,
                                        roots=roots)
        if issue:
            issues.append(f"{kind}: {issue}")
        else:
            valid_receipts[kind] = evidence[kind]
    package_receipt = valid_receipts.get("package")
    if "media" in valid_receipts:
        saved_material = s.execute(select(media_revalidation_t.c.media_receipt_sha256).where(
            media_revalidation_t.c.publication_id == row["id"])).scalar_one_or_none()
        if saved_material != "sha256:" + _digest(valid_receipts["media"]):
            issues.append("media: 缺少与本次媒体验收绑定的原始双样单复验材料")
    if package_receipt is not None:
        package_details = package_receipt["payload"]["details"]
        signed_manifest = s.execute(select(author_manifests_t).where(
            author_manifests_t.c.publication_id == row["id"])).mappings().first()
        if (signed_manifest is None
                or signed_manifest["owner_id"] != row["owner_id"]
                or signed_manifest["key_id"] != package_details["publisher_key_id"]
                or signed_manifest["artifact_digest"] != row["artifact_digest"]
                or signed_manifest["package_digest"] != row["package_digest"]
                or package_details.get("author_manifest_sha256") != (
                    "sha256:" + _digest(signed_manifest["manifest"]))):
            issues.append("package: 验包回执未绑定服务端已登记作者清单")
        else:
            try:
                from platform_v8.services.workers.task_adapter_publisher_identity import active_key
                active_key(s, owner_id=row["owner_id"], key_id=signed_manifest["key_id"])
            except Exception:
                issues.append("package: 作者签名公钥已撤销或不可用")
        if spec is not None and row["task_type"] not in BUILTIN_TASK_TYPES:
            # The UI sends machine fields read from its local source tree, but
            # only this signed file inventory binds those bytes to the exact
            # immutable package that Guangzhou independently verified.
            if not _definition_in_signed_manifest(row, signed_manifest):
                issues.append("package: 任务定义未与已签名源码包的 task-definition.json 精确绑定")
        # Author upload confirmation is necessary but has no review authority.
        # The separately signed Guangzhou receipt must name the exact version
        # Shanghai confirmed by a version-specific OSS HEAD.
        upload = s.execute(select(package_uploads_t).where(
            package_uploads_t.c.publication_id == row["id"])).mappings().first()
        if (upload is None or upload["status"] != "confirmed"
                or upload["owner_id"] != row["owner_id"]
                or package_details["archive_digest"] != upload["archive_digest"]
                or package_details["archive_size_bytes"] != upload["size_bytes"]
                or package_details["archive_bucket"] != upload["bucket"]
                or package_details["archive_object_key"] != upload["object_key"]
                or package_details["archive_version_id"] != upload["version_id"]):
            issues.append("package: 广州验包回执与上海已确认的归档版本不一致")
        elif upload["lock_retain_until"] is None:
            issues.append("package: 归档版本缺少对象锁保留期限")
        else:
            lock_until = upload["lock_retain_until"]
            if lock_until.tzinfo is None:
                lock_until = lock_until.replace(tzinfo=timezone.utc)
            # Dispatch may outlive the initial lock. The dispatch path extends
            # the same immutable VersionId before this guard admits an order.
            if lock_until.timestamp() < now + 86400:
                issues.append(_PACKAGE_LOCK_ISSUE)
        review_receipt = valid_receipts.get("review")
        if review_receipt is not None and spec is not None:
            from platform_v8.services.workers.task_adapter_review_issuer import task_contract_sha256
            review_details = review_receipt["payload"]["details"]
            if (review_details.get("package_receipt_sha256") != "sha256:" + _digest(package_receipt)
                    or review_details.get("immutable_package_ref") != package_details["immutable_package_ref"]
                    or review_details.get("task_contract_sha256") != task_contract_sha256(row, spec)):
                issues.append("review: 独立审查与当前验包回执或任务合同不一致")
        media_receipt = valid_receipts.get("media")
        if media_receipt is not None:
            media_details = media_receipt["payload"]["details"]
            if (media_details["package_archive_digest"] != package_details["archive_digest"]
                    or media_details["package_immutable_version_id"] != package_details["archive_version_id"]):
                issues.append("media: 媒体验收与当前不可变包归档不一致")
            if (media_details["gif_sample_ref"]["bucket"] != package_details["archive_bucket"]
                    or media_details["mp4_sample_ref"]["bucket"] != package_details["archive_bucket"]):
                issues.append("media: 样单证据桶与已确认归档不一致")
            if min(media_details["gif_sample_ref"]["lock_retained_until"],
                   media_details["mp4_sample_ref"]["lock_retained_until"]) < now + 86400:
                issues.append(_MEDIA_LOCK_ISSUE)
        sample_receipt = valid_receipts.get("sample")
        if sample_receipt is not None:
            sample_details = sample_receipt["payload"]["details"]
            if (sample_details["package_archive_digest"] != package_details["archive_digest"]
                    or sample_details["package_immutable_version_id"] != package_details["archive_version_id"]):
                issues.append("sample: 独立样单未绑定当前不可变源码归档")
    configured = _configured_price(s, row["task_type"], spec=spec)
    pricing = evidence.get("pricing") if isinstance(evidence.get("pricing"), dict) else {}
    details = pricing.get("payload", {}).get("details", {}) if isinstance(pricing.get("payload"), dict) else {}
    if configured is None:
        issues.append("平台尚未配置此任务的人民币服务端价格")
    elif configured[0] != _yuan(row["price_yuan"]):
        # The settings version is global. Adding a price for an unrelated task
        # must not revoke an unchanged, independently signed price row.
        # The exact row digest is checked below against the signed receipt.
        issues.append("当前人民币服务端价格与已审报价不一致")
    if "pricing" in valid_receipts and configured is not None:
        row_digest = details.get("settings_row_sha256")
        if (not isinstance(row_digest, str) or not _DIGEST.fullmatch(row_digest)
                or row_digest != _configured_pricing_row_digest(
                    s, row["task_type"], spec=spec)):
            issues.append("pricing: 价格回执与当前人民币价目行不一致")
    owner_status = s.execute(select(accounts_t.c.status).where(accounts_t.c.id == row["owner_id"])).scalar_one_or_none()
    if owner_status != "active":
        issues.append("投稿账号已停用或不存在")
    return issues


def _serialize(s: Session, row: dict[str, Any], *, reviewer_id: int | None = None,
               media_ready_cache: dict[str, bool] | None = None,
               package_upload_status: str | None = None,
               author_manifest_status: str | None = None,
               sample_jobs_status: dict[str, dict[str, Any]] | None = None,
               media_material_digest: str | None = None) -> dict[str, Any]:
    result = _row(row)
    result.pop("review_evidence", None)
    result.pop("submission_fingerprint", None)
    result.pop("review_fingerprint", None)
    if package_upload_status is None:
        package_upload_status = s.execute(select(package_uploads_t.c.status).where(
            package_uploads_t.c.publication_id == row["id"])).scalar_one_or_none() or "missing"
    result["package_upload_status"] = package_upload_status
    if author_manifest_status is None:
        author_manifest_status = ("recorded" if s.execute(select(
            author_manifests_t.c.publication_id).where(
                author_manifests_t.c.publication_id == row["id"])).scalar_one_or_none()
            else "missing")
    result["author_manifest_status"] = author_manifest_status
    evidence = row.get("review_evidence") or {}
    result["evidence_kinds"] = sorted(evidence) if isinstance(evidence, dict) else []
    effective_reviewer_id = reviewer_id if reviewer_id is not None else row.get("reviewer_id")
    result["review_reasons"] = _issues(s, row, evidence,
                                        reviewer_id=effective_reviewer_id,
                                        require_runtime_pin=row["status"] == "approved",
                                        media_ready_cache=media_ready_cache)
    task_spec = _spec_for_row(row)
    result["required_evidence"] = (["package", "media", "pricing", "review"]
                                   if task_spec is not None and task_spec.external_artifact_verifier_required
                                   and not task_spec.adapter_file_schema and task_spec.adapter_input_contract != "h3-prompt-fixed-frame.v1"
                                   else ["package", "sample", "pricing", "review"]
                                   if task_spec is not None and task_spec.requires_verified_adapter
                                   else ["package", "pricing", "review"])
    roots = _roots()
    now = int(time.time())
    result["evidence_status"] = {
        kind: ("missing" if kind not in evidence else
               "valid" if _approved_receipt_issue(
                   kind, evidence[kind], row,
                   reviewer_id=effective_reviewer_id,
                   now=now, roots=roots) is None else "invalid")
        for kind in result["required_evidence"]
    }
    if sample_jobs_status is None:
        sample_jobs_status = {fmt: {
            "status": state, "lease_expires_at": lease_expires_at,
            "verify_receipt": verify_receipt}
            for fmt, state, lease_expires_at, verify_receipt in s.execute(select(
                review_samples_t.c.format, review_samples_t.c.status,
                review_samples_t.c.lease_expires_at,
                review_samples_t.c.verify_receipt).where(
                    review_samples_t.c.publication_id == row["id"])).all()}
    if media_material_digest is None:
        media_material_digest = s.execute(select(
            media_revalidation_t.c.media_receipt_sha256).where(
                media_revalidation_t.c.publication_id == row["id"])).scalar_one_or_none() or ""
    media_receipt = evidence.get("media") if isinstance(evidence, dict) else None
    media_status = ("missing" if media_receipt is None else
                    "valid" if result["evidence_status"].get("media") == "valid"
                    and media_material_digest == "sha256:" + _digest(media_receipt)
                    else "invalid")
    result["media_evidence_status"] = media_status
    def sample_lease_expired(value: datetime | None) -> bool:
        if value is None:
            return True
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value <= datetime.now(timezone.utc)

    stalled = any(
        job["status"] in {"leased", "upload_issued"}
        and sample_lease_expired(job["lease_expires_at"])
        for job in sample_jobs_status.values())
    stale_receipt = (bool(sample_jobs_status)
        and all(job["status"] == "verified" for job in sample_jobs_status.values())
        and any(not isinstance(job["verify_receipt"], dict)
                or not isinstance(job["verify_receipt"].get("payload"), dict)
                or job["verify_receipt"]["payload"].get("expires_at", 0) <= now
                for job in sample_jobs_status.values()))
    result["review_sample_status"] = (
        "independent_sample_required" if task_spec is not None
        and task_spec.requires_verified_adapter
        and (not task_spec.external_artifact_verifier_required or task_spec.adapter_file_schema
             or task_spec.adapter_input_contract == "h3-prompt-fixed-frame.v1")
        and result["evidence_status"].get("sample") != "valid" else
        "evidence_deposited" if task_spec is not None
        and task_spec.requires_verified_adapter
        and (not task_spec.external_artifact_verifier_required or task_spec.adapter_file_schema
             or task_spec.adapter_input_contract == "h3-prompt-fixed-frame.v1") else
        "evidence_deposited" if media_status == "valid" else
        "blocked" if not sample_jobs_status or stalled or stale_receipt else
        "verified" if set(sample_jobs_status) == {"gif", "mp4"}
        and all(job["status"] == "verified" for job in sample_jobs_status.values()) else
        "pending" if all(job["status"] == "pending" for job in sample_jobs_status.values()) else
        "running")
    if row.get("sale_price_yuan") is not None and row["status"] == "approved":
        listed = s.execute(select(products_t.c.id, products_t.c.status).where(
            products_t.c.publication_id == row["id"])).mappings().first()
        if listed is not None:
            result["market_product_id"] = listed["id"]
            result["market_product_status"] = listed["status"]
    result["lifecycle"] = lifecycle.project(s, row)
    is_active = lifecycle.active(s, row["id"])
    if result["lifecycle"]["state"] == "delisted" and result.get("market_product_id"):
        result["market_product_status"] = "suspended"
    result["can_submit_review"] = is_active and row["status"] == "review"
    result["can_approve"] = is_active and row["status"] == "review" and not result["review_reasons"]
    return result


def approve(s: Session, *, publication_id: str, reviewer_id: int,
            note: str) -> dict[str, Any]:
    if not note.strip():
        raise PublicationError("请填写可追溯的审核说明")
    row = _get(s, publication_id, lock=True)
    evidence = row["review_evidence"] or {}
    fingerprint = _digest({"evidence": evidence, "note": note.strip()})
    if row["status"] == "approved":
        if row["review_fingerprint"] == fingerprint and row["reviewer_id"] == reviewer_id:
            return _serialize(s, row)
        raise PublicationConflict("已批准投稿不可替换审核证据")
    if not lifecycle.active(s, row["id"]):
        raise PublicationConflict("投稿已撤回或归档，请刷新记录")
    if row["status"] != "review":
        raise PublicationConflict("仅待审核投稿可批准")
    issues = _issues(s, row, evidence, reviewer_id=reviewer_id)
    if issues:
        raise PublicationError("不能批准：" + "；".join(issues))
    now = datetime.utcnow()
    try:
        with s.begin_nested():
            changed = s.execute(update(publications_t).where(
                publications_t.c.id == publication_id,
                publications_t.c.status == "review",
            ).values(status="approved", review_evidence=evidence,
                     review_fingerprint=fingerprint, review_note=note.strip(),
                     reviewer_id=reviewer_id, reviewed_at=now, updated_at=now))
            if changed.rowcount != 1:
                raise PublicationConflict("审核状态已发生变化，请重新读取")
            s.flush()
            # One Guangzhou decision covers the exact package and chosen listing price.
            # Product checks run inside this savepoint, so failed distribution cannot
            # leave an approved publication or a partially created marketplace item.
            if row.get("sale_price_yuan") is not None:
                from platform_v8.services.workers import order_adapter_products as product_service
                try:
                    product = product_service.submit(s, owner_id=row["owner_id"],
                        publication_id=publication_id,
                        sale_price_yuan=_yuan(row["sale_price_yuan"]), currency="CNY")
                    product_service.approve(s, product_id=product["id"],
                        reviewer_id=reviewer_id, note=note.strip())
                except product_service.ProductError as exc:
                    raise PublicationError("自动上架未完成：" + str(exc)) from exc
    except IntegrityError as exc:
        raise PublicationConflict("该任务已有一个获批接单适配器") from exc
    AuditRepo.write(s, action="task_adapter_publication.approve", actor_account_id=reviewer_id,
                    actor_kind="admin", target_kind=_AUDIT_TARGET_KIND,
                    target_id=publication_id,
                    detail={"note": note.strip(), "evidence_sha256": _digest(evidence),
                            "artifact_digest": row["artifact_digest"]})
    s.flush()
    return _serialize(s, _get(s, publication_id))


def reject(s: Session, *, publication_id: str, reviewer_id: int, note: str) -> dict[str, Any]:
    note = note.strip()
    if not note:
        raise PublicationError("请填写驳回原因")
    row = _get(s, publication_id, lock=True)
    if row["status"] == "rejected":
        if row["review_note"] == note and row["reviewer_id"] == reviewer_id:
            return _serialize(s, row)
        raise PublicationConflict("投稿已由其他审核结论处理")
    if not lifecycle.active(s, row["id"]):
        raise PublicationConflict("投稿已撤回或归档，请刷新记录")
    if row["status"] != "review":
        raise PublicationConflict("仅待审核投稿可驳回")
    now = datetime.utcnow()
    changed = s.execute(update(publications_t).where(
        publications_t.c.id == publication_id,
        publications_t.c.status == "review",
    ).values(
        status="rejected", review_note=note, reviewer_id=reviewer_id,
        reviewed_at=now, updated_at=now))
    if changed.rowcount != 1:
        raise PublicationConflict("审核状态已发生变化，请重新读取")
    AuditRepo.write(s, action="task_adapter_publication.reject", actor_account_id=reviewer_id,
                    actor_kind="admin", target_kind=_AUDIT_TARGET_KIND,
                    target_id=publication_id, detail={"note": note})
    s.flush()
    return _serialize(s, _get(s, publication_id))


def _missing_readiness(task_type: str) -> dict[str, Any]:
    return {"task_type": task_type, "ready": False, "publication_id": None,
            "owner_id": None, "approved_artifact_digest": None,
            "approved_package_digest": None,
            "status": "missing", "reasons": ["无已受理的接单适配器投稿"]}


def _readiness_row(s: Session, row: dict[str, Any], *,
                   renew_lock: bool = False) -> dict[str, Any]:
    """Evaluate the exact approved version advertised by one worker."""
    task_type = row["task_type"]
    owner_id = int(row["owner_id"])
    if not lifecycle.active(s, row["id"]):
        return {"task_type": task_type, "ready": False, "publication_id": row["id"],
                "owner_id": row["owner_id"], "approved_artifact_digest": None,
                "approved_package_digest": None, "status": row["status"],
                "reasons": ["作者或管理员已撤回、下架或归档此记录"]}
    reasons = _issues(s, row, row["review_evidence"] or {},
                      reviewer_id=row["reviewer_id"], require_runtime_pin=True)
    # Buyer quote and scheduler opt in. Never prolong storage on an invalid
    # receipt, withdrawn publication or unrelated validation failure.
    if (renew_lock and row["status"] == "approved" and reasons
            and set(reasons) <= {_PACKAGE_LOCK_ISSUE, _MEDIA_LOCK_ISSUE}):
        try:
            from platform_v8.services.workers.task_adapter_package_upload import (
                extend_lock_if_needed,
            )
            extend_lock_if_needed(s, publication_id=row["id"], owner_id=owner_id)
            reasons = _issues(s, row, row["review_evidence"] or {},
                              reviewer_id=row["reviewer_id"], require_runtime_pin=True)
        except Exception:
            reasons = ["审核证据桶锁期续延失败，暂停接单"]
    if row["status"] != "approved":
        reasons.insert(0, "尚未通过接单适配器审核")
    return {"task_type": task_type, "ready": row["status"] == "approved" and not reasons,
            "publication_id": row["id"], "owner_id": row["owner_id"],
            "approved_artifact_digest": row["artifact_digest"] if row["status"] == "approved" else None,
            "approved_package_digest": row["package_digest"] if row["status"] == "approved" else None,
            "status": row["status"], "reasons": reasons}


def readiness_for_publication(s: Session, publication_id: str, *,
                              renew_lock: bool = False) -> dict[str, Any]:
    """Check one immutable publication rather than an arbitrary task owner row."""
    if s is None or not isinstance(publication_id, str) or not publication_id:
        return _missing_readiness("")
    row = s.execute(select(publications_t).where(
        publications_t.c.id == publication_id)).mappings().first()
    if row is None:
        return _missing_readiness("")
    return _readiness_row(s, dict(row), renew_lock=renew_lock)


def readiness(s: Session, task_type: str, *, owner_id: int,
              renew_lock: bool = False) -> dict[str, Any]:
    """Return one ready version per owner, independent of database row order."""
    if s is None or not isinstance(owner_id, int) or owner_id <= 0:
        return _missing_readiness(task_type)
    approved = s.execute(select(publications_t).where(
        publications_t.c.task_type == task_type,
        publications_t.c.owner_id == owner_id,
        publications_t.c.status == "approved",
    ).order_by(publications_t.c.reviewed_at.desc(), publications_t.c.id.desc())
                         ).mappings().all()
    first_failure: dict[str, Any] | None = None
    for row in approved:
        state = _readiness_row(s, dict(row), renew_lock=renew_lock)
        if state["ready"]:
            return state
        if first_failure is None:
            first_failure = state
    if first_failure is not None:
        return first_failure
    latest = s.execute(select(publications_t).where(
        publications_t.c.task_type == task_type,
        publications_t.c.owner_id == owner_id,
    ).order_by(publications_t.c.created_at.desc(), publications_t.c.id.desc())
                       .limit(1)).mappings().first()
    if latest is None:
        return _missing_readiness(task_type)
    return _readiness_row(s, dict(latest), renew_lock=False)


def market_readiness(s: Session, task_type: str) -> dict[str, Any]:
    """Buyer-facing admission: one ready supply owner, never the buyer's id."""
    if s is None:
        return {"ready": False, "reasons": ["接单适配器审核不可用"]}
    lifecycle.lock_task(s, task_type)
    rows = s.execute(select(publications_t.c.owner_id).where(
        publications_t.c.task_type == task_type,
        publications_t.c.status == "approved",
    ).limit(100)).scalars().all()
    reasons: list[str] = []
    for owner_id in rows:
        state = readiness(s, task_type, owner_id=int(owner_id), renew_lock=True)
        if state["ready"]:
            return state
        reasons.extend(state["reasons"])
    return {"ready": False,
            "reasons": reasons or ["暂无通过审核且可独立验收结果的接单适配器"]}


def callable_task_spec(s: Session, task_type: str) -> Any | None:
    """Session-bound admission for the public quote/submit/catalog APIs.

    Static task registration alone never opens a seller-created capability.
    At least one live approved publication and its independent evidence must
    remain ready; Shanghai still picks a compatible online device per task.
    """
    if s is None:
        return None
    state = market_readiness(s, task_type)
    if not state["ready"]:
        return None
    row = s.execute(select(publications_t).where(
        publications_t.c.id == state["publication_id"])).mappings().first()
    if row is None:
        return None
    spec = _spec_for_row(dict(row))
    if (spec is None or not spec.requires_verified_adapter
            or not _result_verifier_wired(spec)):
        return None
    from platform_v8.services.workers.task_adapter_review_issuer import task_contract_sha256
    contract_digest = task_contract_sha256(dict(row), spec)
    approved_rows = s.execute(select(publications_t).where(
        publications_t.c.task_type == task_type,
        publications_t.c.status == "approved")).mappings().all()
    for other in approved_rows:
        other_row = dict(other)
        if other_row["id"] == row["id"] or not _readiness_row(s, other_row)["ready"]:
            continue
        other_spec = _spec_for_row(other_row)
        if (other_spec is None
                or task_contract_sha256(other_row, other_spec) != contract_digest):
            # The @ picker is task-first. Two live sellers cannot give one
            # task_type incompatible input or result semantics.
            return None
    existing = TASK_REGISTRY.get(task_type)
    if (existing is not None and existing.adapter_input_contract != "__blocked__"
            and task_contract_sha256(dict(row), existing) != contract_digest):
        return None
    if existing is None or existing.adapter_input_contract == "__blocked__":
        # This registration changes engine routing only after the independently
        # reviewed, signed publication is proven ready. Quote/submit repeat the
        # readiness check; registration alone never grants a seller access.
        from platform_v8.engine.task_registry import register_dynamic
        register_dynamic(spec)
    return TASK_REGISTRY[task_type]


def list_callable_task_specs(s: Session) -> list[Any]:
    """Distinct live reviewed capabilities for the public task directory."""
    if s is None:
        return []
    task_types = s.execute(select(publications_t.c.task_type).where(
        publications_t.c.status == "approved").distinct()
                           .order_by(publications_t.c.task_type)).scalars().all()
    return [spec for task_type in task_types
            if (spec := callable_task_spec(s, task_type)) is not None]
