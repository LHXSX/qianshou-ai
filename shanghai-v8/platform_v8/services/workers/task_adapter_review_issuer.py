"""Independent security and task-contract review receipt issuer.

This module is meant to run in a separate, read-only issuer process.  It never
scans or downloads package bytes on Shanghai.  A real scanner and a separate
contract reviewer must each sign a report about the same immutable package
before the issuer can sign the platform's ``review`` receipt.  Caller supplied
booleans, admin notes, unsigned reports and skipped scans have no authority.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
from datetime import timezone
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from sqlalchemy import select
from sqlalchemy.orm import Session

from platform_v8.services.workers import task_adapter_publications as publication_svc
from platform_v8.storage.repo import (
    accounts_t, task_adapter_publications_t,
    task_adapter_package_uploads_t, task_adapter_author_manifests_t,
)

_REPORT_SCHEMA = "task-adapter-independent-review-report.v1"
_RECEIPT_SCHEMA = "task-adapter-publication-evidence.v1"
_KEY_ID = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
_SHA256 = re.compile(r"sha256:[0-9a-f]{64}\Z")
_B64 = re.compile(r"[A-Za-z0-9_-]+={0,2}\Z")
_REPORT_KINDS = ("security", "contract")
_MAX_REPORT_BYTES = 16 * 1024
_TTL_SECONDS = 3600
_SECURITY_CHECKS = frozenset({
    "archive_integrity", "malware", "dependency_policy", "secret_exposure",
    "execution_policy",
})
_CONTRACT_CHECKS = frozenset({
    "registered_task", "input_schema", "output_schema", "execution_scope",
    "result_verification",
})


class ReviewEvidenceError(ValueError):
    """One of the independent review prerequisites was not trustworthy."""


def _canonical(value: Any) -> bytes:
    return publication_svc._canonical(value)


def _sha256(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()


def _b64decode(value: Any, size: int) -> bytes:
    if not isinstance(value, str) or len(value) > 128 or not _B64.fullmatch(value):
        raise ReviewEvidenceError("独立审查报告签名编码非法")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, base64.binascii.Error) as exc:
        raise ReviewEvidenceError("独立审查报告签名编码非法") from exc
    if len(decoded) != size:
        raise ReviewEvidenceError("独立审查报告签名长度非法")
    return decoded


def _report_roots() -> dict[str, dict[str, Ed25519PublicKey]]:
    """Read only deployment-owned, purpose-separated reviewer public keys."""
    raw = os.environ.get("V8_TASK_PUBLICATION_REVIEW_REPORT_ROOTS", "")
    if not raw or len(raw) > 8192:
        raise ReviewEvidenceError("未配置独立安全与合同审查信任根")
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, dict) or set(parsed) != set(_REPORT_KINDS):
            raise ReviewEvidenceError("独立审查信任根须按安全与合同分开配置")
        result: dict[str, dict[str, Ed25519PublicKey]] = {}
        seen: set[bytes] = set()
        for kind in _REPORT_KINDS:
            entries = parsed[kind]
            if not isinstance(entries, dict) or not 1 <= len(entries) <= 8:
                raise ReviewEvidenceError("独立审查信任根配置非法")
            result[kind] = {}
            for key_id, encoded in entries.items():
                if not isinstance(key_id, str) or not _KEY_ID.fullmatch(key_id):
                    raise ReviewEvidenceError("独立审查信任根编号非法")
                key_bytes = _b64decode(encoded, 32)
                if key_bytes in seen:
                    raise ReviewEvidenceError("安全与合同审查不得共用密钥")
                seen.add(key_bytes)
                result[kind][key_id] = Ed25519PublicKey.from_public_bytes(key_bytes)
        return result
    except (TypeError, ValueError) as exc:
        if isinstance(exc, ReviewEvidenceError):
            raise
        raise ReviewEvidenceError("独立审查信任根配置非法") from exc


def _contract_snapshot(row: dict[str, Any], spec: Any) -> dict[str, Any]:
    """Pin both the accepted submission and the dispatch/settlement contract."""
    snapshot = {
        "task_type": spec.task_type,
        "category": spec.category,
        "accepted_input_kinds": list(spec.accepted_input_kinds),
        "default_input_kind": spec.default_input_kind,
        "slicer": spec.slicer,
        "aggregator": spec.aggregator,
        "runtimes": list(spec.runtimes),
        "required_software": list(spec.required_software),
        "default_max_shards": spec.default_max_shards,
        "max_shards_limit": spec.max_shards_limit,
        "mode": spec.mode.value,
        "executor": spec.executor.value,
        "settlement_policy": spec.settlement_policy,
        "exact_input_kinds": spec.exact_input_kinds,
        "requires_verified_adapter": spec.requires_verified_adapter,
        "adapter_capability_id": spec.adapter_capability_id,
        "adapter_output_kind": spec.adapter_output_kind,
        "adapter_input_contract": spec.adapter_input_contract,
        "adapter_result_strategy": spec.adapter_result_strategy,
        "parameter_schema": spec.parameter_schema,
        "inline_input_form": spec.inline_input_form,
        "adapter_output_schema": spec.adapter_output_schema,
        "external_artifact_verifier_required": spec.external_artifact_verifier_required,
        "submitted_contract_version": row["contract_version"],
        "submitted_capability_id": row["capability_id"],
        "submitted_input_kinds": list(row["input_kinds"]),
        "submitted_output_kind": row["output_kind"],
    }
    if spec.adapter_input_contract == "h3-prompt-fixed-frame.v1":
        from platform_v8.protocol.native_h3 import validate_definition
        if row.get("contract_version") == "v2":
            from platform_v8.protocol.native_h3_v2 import validate_definition
        snapshot["native_binding"] = validate_definition(row)["nativeBinding"]
    if getattr(spec, "adapter_file_schema", None):
        snapshot["adapter_file_schema"] = spec.adapter_file_schema
    return snapshot


def task_contract_sha256(row: dict[str, Any], spec: Any) -> str:
    """Digest the concrete platform contract the reviewer must inspect."""
    return _sha256(_contract_snapshot(row, spec))


def review_snapshot(session: Session, publication_id: str) -> dict[str, Any]:
    """Give independent reviewers a live, narrow control-plane snapshot.

    Never return archive/media bytes or trust an author-supplied row. The
    package receipt and enrolled author identity are rechecked on every read.
    """
    from uuid import UUID

    try:
        if str(UUID(publication_id)) != publication_id:
            raise ValueError("noncanonical uuid")
    except (TypeError, ValueError) as exc:
        raise ReviewEvidenceError("投稿编号非法") from exc
    row_raw = session.execute(select(task_adapter_publications_t).where(
        task_adapter_publications_t.c.id == publication_id)).mappings().first()
    if row_raw is None or row_raw["status"] != "review":
        raise ReviewEvidenceError("投稿不存在或未处于待审状态")
    row = dict(row_raw)
    spec = publication_svc._spec_for_row(row)
    if (spec is None or not spec.requires_verified_adapter
            or not publication_svc._result_verifier_wired(spec)
            or row["contract_version"] not in ({"v1", "v2"} if spec.adapter_input_contract == "h3-prompt-fixed-frame.v1" else {"v1"})
            or row["capability_id"] != spec.adapter_capability_id
            or row["output_kind"] != spec.adapter_output_kind
            or tuple(row["input_kinds"] or []) != tuple(spec.accepted_input_kinds)):
        raise ReviewEvidenceError("投稿与现行平台任务合同不一致")
    package = (row["review_evidence"] or {}).get("package")
    now = int(time.time())
    if publication_svc._receipt_issue("package", package, row,
                                      reviewer_id=None, now=now,
                                      roots=publication_svc._roots()) is not None:
        raise ReviewEvidenceError("缺少当前有效的广州独立验包回执")
    details = package["payload"]["details"]
    upload = session.execute(select(task_adapter_package_uploads_t).where(
        task_adapter_package_uploads_t.c.publication_id == publication_id)).mappings().first()
    if (upload is None or upload["status"] != "confirmed"
            or upload["owner_id"] != row["owner_id"]
            or any((details.get(detail_key) != upload[column]
                    for detail_key, column in (
                        ("archive_digest", "archive_digest"),
                        ("archive_size_bytes", "size_bytes"),
                        ("archive_bucket", "bucket"),
                        ("archive_object_key", "object_key"),
                        ("archive_version_id", "version_id"))))):
        raise ReviewEvidenceError("广州回执未绑定上海确认的不可变归档")
    lock_until = upload["lock_retain_until"]
    if lock_until is None or lock_until.replace(tzinfo=lock_until.tzinfo or timezone.utc).timestamp() < now + 86400:
        raise ReviewEvidenceError("归档锁定期不足以覆盖审核回执")
    manifest = session.execute(select(task_adapter_author_manifests_t).where(
        task_adapter_author_manifests_t.c.publication_id == publication_id)).mappings().first()
    if (manifest is None or manifest["owner_id"] != row["owner_id"]
            or manifest["key_id"] != details.get("publisher_key_id")
            or manifest["artifact_digest"] != row["artifact_digest"]
            or manifest["package_digest"] != row["package_digest"]
            or details.get("author_manifest_sha256") != _sha256(manifest["manifest"])):
        raise ReviewEvidenceError("验包回执未绑定当前登记作者清单")
    try:
        from platform_v8.services.workers.task_adapter_publisher_identity import active_key
        active_key(session, owner_id=row["owner_id"], key_id=manifest["key_id"])
    except Exception as exc:
        raise ReviewEvidenceError("作者签名公钥已撤销或不可用") from exc
    output = {
        "schema": "task-adapter-review-snapshot.v1",
        "publication": {key: row[key] for key in (
            "id", "owner_id", "status", "task_type", "artifact_digest",
            "package_digest", "capability_id", "input_kinds", "output_kind",
            "contract_version")},
        "package_receipt": package,
        "task_contract": _contract_snapshot(row, spec),
        "task_contract_sha256": task_contract_sha256(row, spec),
        "media_verifier_ready": publication_svc._external_media_verifier_ready(
            row["task_type"], spec),
    }
    if len(_canonical(output)) > 16 * 1024:
        raise ReviewEvidenceError("独立审查快照超过 16 KiB")
    return output


def _verify_report(
    report: Any, *, kind: str, row: dict[str, Any], package_receipt_sha256: str,
    immutable_package_ref: str, contract_sha256: str, roots: dict, now: int,
) -> dict[str, Any]:
    try:
        if (not isinstance(report, dict) or set(report) != {"key_id", "payload", "signature"}
                or len(_canonical(report)) > _MAX_REPORT_BYTES):
            raise ReviewEvidenceError("独立审查报告缺失或过大")
        key_id = report["key_id"]
        payload = report["payload"]
        if not isinstance(key_id, str) or key_id not in roots[kind] or not isinstance(payload, dict):
            raise ReviewEvidenceError("独立审查报告签发方不受信任")
        roots[kind][key_id].verify(_b64decode(report["signature"], 64), _canonical(payload))
        expected = {
            "schema": _REPORT_SCHEMA,
            "kind": kind,
            "publication_id": row["id"],
            "owner_id": row["owner_id"],
            "task_type": row["task_type"],
            "artifact_digest": row["artifact_digest"],
            "package_digest": row["package_digest"],
            "package_receipt_sha256": package_receipt_sha256,
            "immutable_package_ref": immutable_package_ref,
            "contract_sha256": contract_sha256,
            "result": "pass",
        }
        if set(payload) != set(expected) | {"report_id", "issued_at", "expires_at", "details"}:
            raise ReviewEvidenceError("独立审查报告字段不符合固定合同")
        if any(payload.get(field) != value for field, value in expected.items()):
            raise ReviewEvidenceError("独立审查报告未绑定当前不可变包及任务合同")
        if not publication_svc._evidence_ref(payload.get("report_id")):
            raise ReviewEvidenceError("独立审查报告编号缺失")
        issued_at, expires_at = payload["issued_at"], payload["expires_at"]
        if (type(issued_at) is not int or type(expires_at) is not int
                or issued_at <= 0 or issued_at > now + 60 or expires_at <= now
                or expires_at - issued_at > 86400):
            raise ReviewEvidenceError("独立审查报告过期或时间无效")
        details = payload["details"]
        if not isinstance(details, dict) or details.get("findings") != []:
            raise ReviewEvidenceError("独立审查报告有未解决问题")
        if kind == "security":
            checks = details.get("checks")
            if (set(details) != {"findings", "scan_engine", "scan_engine_version",
                                 "scan_rules_sha256", "scanned_bytes", "scanned_package_digest",
                                 "checks"}
                    or not publication_svc._evidence_ref(details.get("scan_engine"))
                    or details["scan_engine"].lower() in {"stub", "disabled", "none", "skipped"}
                    or not publication_svc._evidence_ref(details.get("scan_engine_version"))
                    or not isinstance(details.get("scan_rules_sha256"), str)
                    or not _SHA256.fullmatch(details["scan_rules_sha256"])
                    or type(details.get("scanned_bytes")) is not int or details["scanned_bytes"] <= 0
                    or details.get("scanned_package_digest") != row["package_digest"]
                    or not isinstance(checks, dict) or set(checks) != _SECURITY_CHECKS
                    or any(value != "pass" for value in checks.values())):
                raise ReviewEvidenceError("独立包扫描未完成或未通过全部安全检查")
        else:
            checks = details.get("checks")
            if (set(details) != {"findings", "reviewer_service", "checks"}
                    or not publication_svc._evidence_ref(details.get("reviewer_service"))
                    or not isinstance(checks, dict) or set(checks) != _CONTRACT_CHECKS
                    or any(value != "pass" for value in checks.values())):
                raise ReviewEvidenceError("独立任务合同审查未完成或未通过")
        return payload
    except (InvalidSignature, KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, ReviewEvidenceError):
            raise
        raise ReviewEvidenceError("独立审查报告签名或格式无效") from exc


def issue_review_receipt(
    session: Session, *, publication_id: str, reviewer_id: int,
    security_report: dict[str, Any], contract_report: dict[str, Any],
    signing_key: Ed25519PrivateKey, key_id: str, now: int | None = None,
) -> dict[str, Any]:
    """Sign only if two independent signed reports match a live accepted row."""
    if not isinstance(signing_key, Ed25519PrivateKey):
        raise ReviewEvidenceError("缺少独立审查回执签名密钥")
    if not isinstance(key_id, str) or not _KEY_ID.fullmatch(key_id):
        raise ReviewEvidenceError("审查签发密钥编号非法")
    if type(reviewer_id) is not int or reviewer_id <= 0:
        raise ReviewEvidenceError("审核员编号非法")
    issued_at = int(time.time()) if now is None else now
    if type(issued_at) is not int or issued_at <= 0:
        raise ReviewEvidenceError("签发时间非法")
    row_raw = session.execute(select(task_adapter_publications_t).where(
        task_adapter_publications_t.c.id == publication_id)).mappings().first()
    if row_raw is None or row_raw["status"] != "review":
        raise ReviewEvidenceError("投稿不存在或未处于待审状态")
    row = dict(row_raw)
    owner = session.execute(select(accounts_t.c.status).where(
        accounts_t.c.id == row["owner_id"])).scalar_one_or_none()
    reviewer = session.execute(select(accounts_t.c.status, accounts_t.c.role).where(
        accounts_t.c.id == reviewer_id)).mappings().first()
    if owner != "active" or reviewer is None or reviewer["status"] != "active" or reviewer["role"] != "admin":
        raise ReviewEvidenceError("投稿人或审核员身份无效")
    if row["owner_id"] == reviewer_id:
        raise ReviewEvidenceError("投稿人与审核员不能相同")
    spec = publication_svc._spec_for_row(row)
    if (spec is None or not spec.requires_verified_adapter
            or not publication_svc._result_verifier_wired(spec)
            or row["contract_version"] not in ({"v1", "v2"} if spec.adapter_input_contract == "h3-prompt-fixed-frame.v1" else {"v1"})
            or row["capability_id"] != spec.adapter_capability_id
            or row["output_kind"] != spec.adapter_output_kind
            or tuple(row["input_kinds"] or []) != tuple(spec.accepted_input_kinds)):
        raise ReviewEvidenceError("投稿与现行平台任务合同不一致")
    # The issuer cannot accept a signed but unbound receipt; the snapshot
    # proves the currently confirmed storage version and enrolled author key.
    snapshot = review_snapshot(session, publication_id)
    package_receipt = snapshot["package_receipt"]
    package_details = package_receipt["payload"]["details"]
    immutable_package_ref = package_details["immutable_package_ref"]
    package_receipt_sha256 = _sha256(package_receipt)
    contract_sha256 = task_contract_sha256(row, spec)
    roots = _report_roots()
    signing_public = signing_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    if any(signing_public == key.public_bytes(Encoding.Raw, PublicFormat.Raw)
           for entries in roots.values() for key in entries.values()):
        raise ReviewEvidenceError("审查回执与原始审查报告不得共用签名密钥")
    platform_roots = publication_svc._roots()
    review_root = platform_roots.get("review", {}).get(key_id)
    if (review_root is None or review_root.public_bytes(Encoding.Raw, PublicFormat.Raw)
            != signing_public):
        raise ReviewEvidenceError("平台未登记当前独立审查回执签发根")
    security = _verify_report(
        security_report, kind="security", row=row,
        package_receipt_sha256=package_receipt_sha256,
        immutable_package_ref=immutable_package_ref,
        contract_sha256=contract_sha256, roots=roots, now=issued_at,
    )
    contract = _verify_report(
        contract_report, kind="contract", row=row,
        package_receipt_sha256=package_receipt_sha256,
        immutable_package_ref=immutable_package_ref,
        contract_sha256=contract_sha256, roots=roots, now=issued_at,
    )
    report_pair = {
        "security_report_id": security["report_id"],
        "security_report_sha256": _sha256(security_report),
        "contract_report_id": contract["report_id"],
        "contract_report_sha256": _sha256(contract_report),
    }
    report_id = "review-" + hashlib.sha256(_canonical(report_pair)).hexdigest()[:32]
    payload = {
        "schema": _RECEIPT_SCHEMA,
        "kind": "review",
        "publication_id": row["id"],
        "owner_id": row["owner_id"],
        "task_type": row["task_type"],
        "artifact_digest": row["artifact_digest"],
        "package_digest": row["package_digest"],
        "result": "pass",
        "issued_at": issued_at,
        "expires_at": issued_at + _TTL_SECONDS,
        "details": {
            "security_review_passed": True,
            "contract_review_passed": True,
            "reviewer_id": reviewer_id,
            "review_report_id": report_id,
            "package_receipt_sha256": package_receipt_sha256,
            "immutable_package_ref": immutable_package_ref,
            "task_contract_sha256": contract_sha256,
            **report_pair,
        },
    }
    signature = signing_key.sign(_canonical(payload))
    return {
        "key_id": key_id,
        "payload": payload,
        "signature": base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii"),
    }
