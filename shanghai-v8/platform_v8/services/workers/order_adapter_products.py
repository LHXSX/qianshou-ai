"""Separate CNY sale, account entitlement and version-pinned install metadata.

Shanghai never opens package or media bytes. An independent package issuer
must sign immutable object/version/hash evidence before a product can list.
The buyer verifies downloaded archive bytes and computes its own runtime digest;
an account entitlement is not a device installation receipt.
"""
from __future__ import annotations

import base64
import asyncio
import hashlib
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from platform_v8.core import LedgerEntry, LedgerType
from platform_v8.services.economy.ledger import _refresh_balance_cache
from platform_v8.services.marketplace.commission import split_app_revenue
from platform_v8.services.workers import task_adapter_publications as publication_svc
from platform_v8.services.workers import task_adapter_publisher_identity as publisher_identity
from platform_v8.services.workers import task_adapter_evidence_storage as evidence_storage
from platform_v8.services.workers.order_adapter_attestor_health import attestor_ready
from platform_v8.services.workers.order_package_provenance import (
    PackageProvenanceError, verify_enrolled_manifest_metadata,
)
from platform_v8.services.workers.official_cloud_catalog import list_official_cloud_capabilities
from platform_v8.services.workers import publication_lifecycle as lifecycle
from platform_v8.storage.repo import (
    AuditRepo, LedgerRepo, accounts_t, ledger_t,
    order_adapter_device_installs_t as device_installs_t,
    order_adapter_entitlements_t as entitlements_t,
    order_adapter_products_t as products_t, task_adapter_publications_t as publications_t,
)

_SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
_OBJECT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.!~*'()/+-]{0,1023}\Z")
_VERSION = re.compile(r"[A-Za-z0-9_.-]{1,200}\Z")
_KEY = re.compile(r"[A-Za-z0-9_.:-]{8,128}\Z")
_DEVICE = re.compile(r"[A-Za-z0-9_.:-]{8,128}\Z")
_INSTALL_SCHEMA = "qianshou.order-adapter-remote-challenge.v1"
_INSTALL_WINDOW_SECONDS = 24 * 60 * 60
_expiry_reaper_healthy = threading.Event()
logger = logging.getLogger(__name__)

_CATEGORY_LABELS_ZH = {
    "text": "文字", "image": "图片", "video": "视频", "audio": "音频",
    "ppt": "演示文稿", "office": "办公", "document": "文档", "doc": "文档",
    "data": "数据", "research": "调研", "code": "开发", "encoding": "编码",
    "development": "开发", "automation": "自动化", "design": "设计",
    "legal": "法律", "education": "教育", "marketing": "营销",
    "compute": "算力", "ai": "智能", "crawl": "采集", "render": "渲染",
}


def _category_label_zh(category: str) -> str:
    return _CATEGORY_LABELS_ZH.get(str(category).strip().lower(), "其他")


def _utc(value: datetime) -> datetime:
    """PostgreSQL returns aware TIMESTAMPTZ; SQLite returns naive UTC."""
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _utc_iso(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class ProductError(ValueError):
    pass


class ProductConflict(ProductError):
    pass


class ProductNotFound(ProductError):
    pass


def _purchase_enabled(*, fresh: bool = False) -> bool:
    # Remains disabled by default, including when a candidate migration exists.
    # A flag alone cannot open debit while the signed installer or refund
    # reaper is missing. The reaper sets this only after one committed sweep.
    if (os.getenv("V8_ORDER_ADAPTER_PURCHASE_ENABLED") != "1"
            or not _expiry_reaper_healthy.is_set()):
        return False
    roots = _install_roots()
    return bool(roots) and attestor_ready(roots, fresh=fresh)


def _yuan(value: Any) -> str:
    try:
        return publication_svc._yuan(value)
    except publication_svc.PublicationError as exc:
        raise ProductError(str(exc)) from exc


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _publisher_roots() -> dict[str, dict[str, str]]:
    raw = os.getenv("V8_TASK_ADAPTER_PUBLISHER_ROOTS", "")
    if not raw or len(raw) > 16 * 1024:
        return {}
    try:
        value = json.loads(raw)
        if (not isinstance(value, dict) or any(
                not str(owner).isdigit() or not isinstance(keys, dict)
                for owner, keys in value.items())):
            return {}
        return value
    except (ValueError, TypeError):
        return {}


def _get(s: Session, product_id: str, *, lock: bool = False) -> dict[str, Any]:
    stmt = select(products_t).where(products_t.c.id == product_id)
    if lock:
        stmt = stmt.with_for_update()
    row = s.execute(stmt).mappings().first()
    if row is None:
        raise ProductNotFound("商品不存在")
    return dict(row)


def _publication(s: Session, publication_id: str) -> dict[str, Any]:
    row = s.execute(select(publications_t).where(
        publications_t.c.id == publication_id)).mappings().first()
    if row is None:
        raise ProductNotFound("接单技能投稿不存在")
    return dict(row)


def _distribution(s: Session, row: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    """Revalidate the independent package receipt and enrolled publisher.

    The receipt is bound to the reviewed seller runtime digest. The archive
    digest below is a separate portable byte identity for buyer download.
    """
    issues: list[str] = []
    evidence = row.get("review_evidence") or {}
    receipt = evidence.get("package") if isinstance(evidence, dict) else None
    issue = publication_svc._approved_receipt_issue(
        "package", receipt, row, reviewer_id=None, now=int(time.time()),
        roots=publication_svc._roots())
    if issue:
        return None, ["package: " + issue]
    details = receipt["payload"]["details"]
    archive_digest = details.get("archive_digest")
    archive_size = details.get("archive_size_bytes")
    bucket = details.get("archive_bucket")
    object_key = details.get("archive_object_key")
    version_id = details.get("archive_version_id")
    if not isinstance(archive_digest, str) or not _SHA.fullmatch(archive_digest):
        issues.append("缺少受信归档 SHA-256 摘要")
    if type(archive_size) is not int or not 1 <= archive_size <= 16 * 1024 * 1024:
        issues.append("缺少受信归档字节数")
    if not isinstance(bucket, str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{2,62}", bucket):
        issues.append("归档桶标识非法")
    if (not isinstance(object_key, str) or not _OBJECT.fullmatch(object_key)
            or ".." in object_key.split("/") or object_key.startswith("/")):
        issues.append("归档对象键非法")
    if not isinstance(version_id, str) or not _VERSION.fullmatch(version_id):
        issues.append("缺少不可变 OSS VersionId")
    if details.get("archive_object_lock_verified") is not True:
        issues.append("归档未通过对象锁或等价不可变性核验")
    v5_self_contained = details.get("inventory_algorithm") == "qianshou.source-package.v1"
    if v5_self_contained:
        # The independent v5 issuer verifies the exact versioned ZIP_STORED
        # source and empty dependency lock. No package manager runs on install.
        if (details.get("dispatchable_package_verified") is not True
                or details.get("immutable_package_verified") is not True
                or details.get("publisher_signature_verified") is not True):
            issues.append("v5 源码包尚未通过独立确定性验包")
        dependency_mode = "self-contained-no-install-v1"
    else:
        if details.get("archive_format") != "zip-source-v1":
            issues.append("归档格式未通过确定性源码 ZIP 合同审核")
        if details.get("install_dependency_mode") != "pnpm-frozen-lockfile-v1":
            issues.append("依赖安装合同未审核")
        dependency_mode = "pnpm-frozen-lockfile-v1"
    if not issues and details.get("immutable_package_ref") != f"oss://{bucket}/{object_key}?versionId={version_id}":
        issues.append("包审核引用未绑定同一版本化归档")
    if not issues:
        try:
            roots = _publisher_roots()
            roots[str(row["owner_id"])] = {
                key: value for key, value in roots.get(str(row["owner_id"]), {}).items()
                if not key.startswith("author-")}
            account_roots = publisher_identity.roots_for_owner(s, owner_id=row["owner_id"])
            roots.setdefault(str(row["owner_id"]), {}).update(
                account_roots.get(str(row["owner_id"]), {}))
            if v5_self_contained:
                # The author envelope is held by Shanghai as immutable control
                # metadata. The Guangzhou-signed receipt commits to its hash;
                # neither side needs to copy untrusted package bytes here.
                enrolled = publisher_identity.manifest_for_issuer(
                    s, publication_id=row["id"])
                author_envelope = enrolled["author_manifest"]
                if (enrolled["owner_id"] != row["owner_id"]
                        or enrolled["key_id"] != details.get("publisher_key_id")
                        or details.get("publisher_owner_id") != row["owner_id"]
                        or details.get("author_manifest_sha256") !=
                        "sha256:" + hashlib.sha256(_canonical(author_envelope)).hexdigest()):
                    raise PackageProvenanceError("v5 验包回执未绑定已登记作者清单")
            else:
                author_envelope = details.get("author_manifest")
            author_payload = (author_envelope.get("payload")
                              if isinstance(author_envelope, dict) else None)
            if (not isinstance(author_payload, dict)
                    or author_payload.get("schema") !=
                    "qianshou.order-adapter-author-manifest.v2"):
                raise PackageProvenanceError("仅接受精确绑定投稿编号的 v2 作者清单")
            author = verify_enrolled_manifest_metadata(
                author_envelope, owner_id=row["owner_id"],
                artifact_digest=row["artifact_digest"],
                package_digest=row["package_digest"],
                publisher_roots=roots,
                publication_id=row["id"], task_type=row["task_type"],
                capability_id=row["capability_id"], version=row["version"])
            if (author_envelope["payload"]["inventory_algorithm"]
                    != details.get("inventory_algorithm")):
                raise PackageProvenanceError("验包回执与作者清单算法不一致")
        except (PackageProvenanceError, publisher_identity.PublisherIdentityError) as exc:
            issues.append(str(exc))
    if issues:
        return None, issues
    return {
        "archive_digest": archive_digest, "archive_size_bytes": archive_size,
        "archive_bucket": bucket, "archive_object_key": object_key,
        "archive_version_id": version_id,
        "artifact_digest": row["artifact_digest"],
        "reviewed_seller_runtime_digest": row["package_digest"],
        "publisher_manifest": author["envelope"],
        "publisher_key_id": author["key_id"],
        "publisher_public_key": author["public_key"],
        "archive_format": "zip-source-v1",
        "inventory_algorithm": details["inventory_algorithm"],
        "install_dependency_mode": dependency_mode,
        "package_receipt": receipt,
    }, []


def _issues(s: Session, product: dict[str, Any], publication: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    issues: list[str] = []
    if publication["status"] != "approved":
        issues.append("接单技能尚未通过独立发布审核")
    readiness = publication_svc.readiness_for_publication(
        s, publication["id"])
    if not readiness["ready"] or readiness["publication_id"] != publication["id"]:
        issues.extend(readiness["reasons"] or ["接单技能当前不可派发"])
    if product["owner_id"] != publication["owner_id"]:
        issues.append("商品作者与投稿作者不一致")
    if product["currency"] != "CNY":
        issues.append("商品价格单位不是人民币元")
    manifest, distribution_issues = _distribution(s, publication)
    issues.extend(distribution_issues)
    if (product["status"] == "published" and manifest is not None
            and product["distribution_manifest"] != manifest):
        issues.append("归档证据已改变，需下架重新审核")
    return manifest, list(dict.fromkeys(issues))


def _serialize(s: Session, row: dict[str, Any], *, include_reasons: bool = True) -> dict[str, Any]:
    pub = _publication(s, row["publication_id"])
    out = {
        "id": row["id"], "publication_id": row["publication_id"],
        "owner_id": row["owner_id"], "task_type": pub["task_type"],
        "name": pub["name"], "version": pub["version"],
        "category": pub["category"], "description": pub["description"],
        "category_label_zh": _category_label_zh(pub["category"]),
        "capability_id": pub["capability_id"],
        "accepted_input_kinds": list(pub["input_kinds"]),
        "output_kind": pub["output_kind"],
        "contract_version": pub["contract_version"],
        "artifact_digest": pub["artifact_digest"],
        "reviewed_seller_runtime_digest": pub["package_digest"],
        "sale_price_yuan": _yuan(row["sale_price_yuan"]),
        "currency": "CNY", "status": row["status"],
        "created_at": _utc_iso(row["created_at"]),
    }
    if include_reasons:
        manifest, issues = _issues(s, row, pub)
        if manifest and manifest["inventory_algorithm"] == "qianshou.source-package.v1":
            source_paths = {item["path"] for item in
                            manifest["publisher_manifest"]["payload"]["files"]}
            out["runtime_abi"] = ("quickjs-wasm.v3" if "src/adapter.quickjs.js" in source_paths
                                  else "node-sandbox.v2")
        out["review_reasons"] = issues
        out["available_to_purchase"] = (
            row["status"] == "published" and not issues and _purchase_enabled())
        out["purchase_block_reason"] = (
            None if _purchase_enabled() else "独立安装签发或超时退款回收未就绪，暂停扣款")
        out["can_approve"] = row["status"] == "review" and not issues
        out["archive_digest"] = manifest["archive_digest"] if manifest else None
        out["archive_size_bytes"] = manifest["archive_size_bytes"] if manifest else None
    return out


def submit(s: Session, *, owner_id: int, publication_id: str,
           sale_price_yuan: str, currency: str) -> dict[str, Any]:
    if currency != "CNY":
        raise ProductError("商品价格单位仅支持 CNY/人民币元")
    price = _yuan(sale_price_yuan)
    publication = _publication(s, publication_id)
    try:
        lifecycle.require_active(s, publication_id)
    except lifecycle.LifecycleError as exc:
        raise ProductConflict("投稿已撤回、下架或归档") from exc
    if publication["owner_id"] != owner_id:
        raise ProductNotFound("接单技能投稿不存在")
    if publication["status"] != "approved":
        raise ProductError("接单技能尚未批准，不能申请上架商品")
    existing = s.execute(select(products_t).where(
        products_t.c.publication_id == publication_id)).mappings().first()
    if existing is not None:
        if _yuan(existing["sale_price_yuan"]) != price:
            raise ProductConflict("该投稿已按另一商品售价提交；须另审新版本")
        return _serialize(s, dict(existing))
    product_id = str(uuid4())
    try:
        with s.begin_nested():
            s.execute(insert(products_t).values(
                id=product_id, publication_id=publication_id, owner_id=owner_id,
                sale_price_yuan=Decimal(price), currency="CNY", status="review",
                distribution_manifest={}, review_note=""))
    except IntegrityError as exc:
        raise ProductConflict("商品投稿发生并发冲突，请重新读取") from exc
    AuditRepo.write(s, action="order_adapter_product.submit", actor_account_id=owner_id,
                    actor_kind="account", target_kind="order_product",
                    target_id=product_id, detail={"sale_price_yuan": price, "currency": "CNY"})
    s.flush()
    return _serialize(s, _get(s, product_id))


def mine(s: Session, *, owner_id: int) -> dict[str, Any]:
    rows = s.execute(select(products_t).where(products_t.c.owner_id == owner_id)
                     .order_by(products_t.c.created_at.desc()).limit(100)).mappings().all()
    return {"items": [_serialize(s, dict(row)) for row in rows]}


def pending(s: Session) -> dict[str, Any]:
    rows = s.execute(select(products_t).where(products_t.c.status == "review")
                     .order_by(products_t.c.created_at.asc()).limit(100)).mappings().all()
    return {"items": [_serialize(s, dict(row)) for row in rows]}


def list_public(s: Session) -> dict[str, Any]:
    rows = s.execute(select(products_t).where(products_t.c.status == "published",
        lifecycle.active_clause(products_t.c.publication_id))
                     .order_by(products_t.c.created_at.desc()).limit(100)).mappings().all()
    return {"items": [_serialize(s, dict(row)) for row in rows]}


def _approved_task_names(s: Session, task_types: list[str]) -> dict[str, str]:
    """Display metadata only; live admission remains list_callable_task_specs.

    A task's description can be an entire paragraph. It must not become the
    public picker name when the approved publication has no sale product yet.
    Only already approved publications supply a label, never pending drafts.
    """
    if not task_types:
        return {}
    rows = s.execute(select(publications_t.c.task_type, publications_t.c.name)
                     .where(publications_t.c.status == "approved", lifecycle.active_clause(publications_t.c.id),
                            publications_t.c.task_type.in_(task_types))
                     .order_by(publications_t.c.created_at.desc(),
                               publications_t.c.id.desc())).mappings().all()
    names: dict[str, str] = {}
    for row in rows:
        value = row["name"]
        if isinstance(value, str) and 1 <= len(value) <= 100:
            names.setdefault(row["task_type"], value)
    return names


def list_capabilities(s: Session, *, include_registry: bool = True) -> dict[str, Any]:
    """One callable task type with any independently approved sale options.

    Sale price buys a package entitlement. A single task execution has its
    own live CNY quote and Shanghai selects a reported compatible node later.
    """
    groups: dict[str, dict[str, Any]] = {}
    cloud_items = {item["task_type"]: item for item in list_official_cloud_capabilities()} if include_registry else {}
    if include_registry:
        from platform_v8.engine.task_registry import list_developer_specs
        from platform_v8.services.workloads.submit import (
            required_task_params, task_input_form_contract,
        )
        official_specs = list_developer_specs()
        reviewed_specs = publication_svc.list_callable_task_specs(s)
        reviewed_names = _approved_task_names(s, [spec.task_type for spec in reviewed_specs])
        for spec in (*official_specs, *reviewed_specs):
            accepted = [kind for kind in spec.accepted_input_kinds if kind != "stream"]
            if not accepted:
                continue
            if spec.task_type in groups:
                # An independently approved publication cannot replace an
                # existing official task contract by sharing its task name.
                continue
            official_provider = bool(spec.official_provider_id)
            reviewed = spec.requires_verified_adapter and not official_provider
            cloud = cloud_items.get(spec.task_type) if official_provider else None
            cloud_ready = _official_provider_ready(s, spec) if official_provider else False
            # The legacy video_generate registry row has no installed task script
            # or independently reviewed video supply. Keep the visible contract
            # unavailable until the reviewed video route is deployed and proven.
            unproven_video = (spec.task_type == "video_generate" or
                              (spec.adapter_capability_id == "video.render" and
                               spec.adapter_input_contract == "comfy-video-graph.v1"))
            callable_now = (not official_provider or cloud_ready) and not unproven_video
            groups[spec.task_type] = {
                "task_type": spec.task_type,
                "capability_id": spec.adapter_capability_id or spec.task_type,
                "name": cloud["name"] if cloud is not None else
                        reviewed_names.get(spec.task_type, spec.task_type) if reviewed else
                        (spec.description or spec.task_type)[:120],
                "description": cloud["description"] if cloud is not None else spec.description,
                "category": spec.category,
                "category_label_zh": _category_label_zh(spec.category),
                "accepted_input_kinds": accepted,
                "default_input_kind": (spec.default_input_kind
                                       if spec.default_input_kind in accepted else accepted[0]),
                "required_params": list(required_task_params(spec.task_type)),
                **task_input_form_contract(spec),
                "output_kind": spec.adapter_output_kind or "workload_result",
                "contract_version": "v1" if spec.requires_verified_adapter else "task-registry.v1",
                "source": "approved_publication" if reviewed else "platform_task_registry",
                "publisher_kind": "user" if reviewed else "official",
                "publisher_kinds": ["user"] if reviewed else ["official"],
                "provider_kind": "user-device" if reviewed else
                                 "official-cloud" if official_provider else "official-device",
                "execution_mode": "cloud" if official_provider else "device",
                "availability": ("awaiting_live_video_supply" if unproven_video else
                                 "contract_ready" if not official_provider or cloud_ready else "paused"),
                "callable": callable_now, "currency": "CNY",
                "requires_quote": True,
                "execution_quote_path": "/api/v8/developer/tasks/estimate"
                                        if callable_now else None,
                "products": [],
            }
    for product in list_public(s)["items"]:
        task_type = product["task_type"]
        group = groups.get(task_type)
        if group is None:
            group = {
                "task_type": task_type,
                "capability_id": product["capability_id"],
                "name": product["name"], "description": product["description"],
                "category": product["category"],
                "category_label_zh": product["category_label_zh"],
                "accepted_input_kinds": product["accepted_input_kinds"],
                "default_input_kind": product["accepted_input_kinds"][0],
                "required_params": [],
                "form_schema_version": "qianshou.task-input-form.v1",
                "input_schema": None, "params_schema": None,
                "form_ready": False,
                "output_kind": product["output_kind"],
                "contract_version": product["contract_version"],
                "source": "approved_publication",
                "publisher_kind": "user", "publisher_kinds": ["user"],
                "provider_kind": "user-device",
                "execution_mode": "device", "availability": "published_no_dispatch_contract",
                "callable": False, "currency": "CNY",
                "requires_quote": True,
                "execution_quote_path": "/api/v8/developer/tasks/estimate",
                "products": [],
            }
            groups[task_type] = group
        elif (group["accepted_input_kinds"] != product["accepted_input_kinds"]
              or group["output_kind"] != product["output_kind"]):
            # A published product cannot silently broaden the platform task
            # contract shown to the customer. Keep it out of callable choices.
            continue
        if group["source"] == "approved_publication" and not group["products"]:
            # The task contract describes execution and may be a long sentence.
            # Use the publisher's reviewed product title in the @ picker.
            group["name"] = product["name"]
        if "user" not in group["publisher_kinds"]:
            group["publisher_kinds"].append("user")
        group["products"].append({
            "product_id": product["id"], "publication_id": product["publication_id"],
            "owner_id": product["owner_id"], "publisher_kind": "user",
            "version": product["version"],
            "sale_price_yuan": product["sale_price_yuan"],
            "available_to_purchase": product["available_to_purchase"],
        })
    if include_registry:
        # Guangzhou's private, read-only provider registry is a distinct cloud
        # source. It cannot inherit a device task's dispatch contract or be
        # made callable merely by returning available=true.
        for item in cloud_items.values():
            # The public @ contract is task-first and requires a unique key.
            # Until a reviewed multi-provider dispatch contract exists, keep
            # a device task rather than publishing an ambiguous duplicate.
            groups.setdefault(item["task_type"], item)
    return {"items": list(groups.values()), "total": len(groups)}


def _official_provider_ready(s: Session, spec: Any) -> bool:
    """Fail closed until the provider's own live admission is in place."""
    if spec.task_type == "image.generate" and spec.official_provider_id == (
            "qianshou:official-image-generation-v1"):
        from platform_v8.services.workloads.official_image_admission import ready
        return ready(s)
    return False


def get_public(s: Session, product_id: str) -> dict[str, Any]:
    row = _get(s, product_id)
    if row["status"] != "published":
        raise ProductNotFound("商品尚未上架")
    return _serialize(s, row)


def approve(s: Session, *, product_id: str, reviewer_id: int, note: str) -> dict[str, Any]:
    note = note.strip()
    if not note:
        raise ProductError("请填写商品上架审核说明")
    try:
        lifecycle.product_admission(s, product_id)
    except lifecycle.LifecycleError as exc:
        raise ProductConflict("投稿已撤回、下架或归档") from exc
    row = _get(s, product_id, lock=True)
    if row["status"] == "published" and row["reviewer_id"] == reviewer_id and row["review_note"] == note:
        return _serialize(s, row)
    if row["status"] != "review":
        raise ProductConflict("商品不是待审核状态")
    publication = _publication(s, row["publication_id"])
    manifest, issues = _issues(s, row, publication)
    if issues or manifest is None:
        raise ProductError("不能上架：" + "；".join(issues or ["可信安装清单缺失"]))
    now = _utc_now()
    changed = s.execute(update(products_t).where(
        products_t.c.id == product_id, products_t.c.status == "review")
        .values(status="published", distribution_manifest=manifest,
                reviewer_id=reviewer_id, review_note=note,
                updated_at=now, reviewed_at=now))
    if changed.rowcount != 1:
        raise ProductConflict("商品审核状态已变化")
    AuditRepo.write(s, action="order_adapter_product.approve", actor_account_id=reviewer_id,
                    actor_kind="admin", target_kind="order_product", target_id=product_id,
                    detail={"archive_digest": manifest["archive_digest"], "note": note})
    s.flush()
    return _serialize(s, _get(s, product_id))


def reject(s: Session, *, product_id: str, reviewer_id: int, note: str) -> dict[str, Any]:
    note = note.strip()
    if not note:
        raise ProductError("请填写驳回原因")
    row = _get(s, product_id, lock=True)
    if row["status"] == "rejected" and row["reviewer_id"] == reviewer_id and row["review_note"] == note:
        return _serialize(s, row)
    if row["status"] != "review":
        raise ProductConflict("商品不是待审核状态")
    now = _utc_now()
    changed = s.execute(update(products_t).where(
        products_t.c.id == product_id, products_t.c.status == "review")
        .values(status="rejected", review_note=note, reviewer_id=reviewer_id,
                reviewed_at=now, updated_at=now))
    if changed.rowcount != 1:
        raise ProductConflict("商品审核状态已变化")
    AuditRepo.write(s, action="order_adapter_product.reject", actor_account_id=reviewer_id,
                    actor_kind="admin", target_kind="order_product", target_id=product_id,
                    detail={"note": note})
    s.flush()
    return _serialize(s, _get(s, product_id))


def _entitlement(row: dict[str, Any], *, already_owned: bool) -> dict[str, Any]:
    return {"entitlement_id": row["id"], "product_id": row["product_id"],
            "status": row["status"], "price_yuan": _yuan(row["price_yuan"]),
            "currency": "CNY", "already_owned": already_owned,
            "device_installed": False,
            "install_expires_at": (_utc_iso(row["expires_at"])
                                   if row.get("expires_at") else None)}


def buyer_entitlements(s: Session, *, buyer_id: int,
                       worker_id: str | None = None) -> dict[str, Any]:
    """Read only this account's durable purchases and this worker's signed device records."""
    if worker_id is not None and not _DEVICE.fullmatch(worker_id):
        raise ProductError("设备编号非法")
    from platform_v8.services.workers.file_device_attestation import validate_binding as validate_file_binding
    rows = s.execute(select(entitlements_t).where(
        entitlements_t.c.buyer_id == buyer_id)
        .order_by(entitlements_t.c.created_at.desc()).limit(100)).mappings().all()
    items = []
    for row in rows:
        product = _get(s, row["product_id"])
        publication = _publication(s, product["publication_id"])
        device_installed = False
        runtime_digest = None
        if worker_id is not None:
            install = s.execute(select(device_installs_t.c.runtime_digest,
                                       device_installs_t.c.signed_receipt).where(
                device_installs_t.c.entitlement_id == row["id"],
                device_installs_t.c.device_id == worker_id,
                device_installs_t.c.revoked_at.is_(None)).limit(1)).first()
            receipt = install.signed_receipt if install is not None else None
            payload = _stored_install_payload(receipt)
            if (install is not None and isinstance(install.runtime_digest, str)
                    and _SHA.fullmatch(install.runtime_digest)
                    and isinstance(payload, dict)
                    and (payload.get("schema") == _INSTALL_SCHEMA
                         or (payload.get("schema") == "qianshou.order-adapter-file-challenge.v1"
                             and validate_file_binding(publication, payload.get("file_binding"), proof=True)))
                    and payload.get("result") == "passed"
                    and payload.get("runtime_digest") == install.runtime_digest
                    and payload.get("entitlement_id") == row["id"]
                    and payload.get("product_id") == row["product_id"]
                    and payload.get("buyer_id") == buyer_id
                    and payload.get("publication_id") == product["publication_id"]
                    and payload.get("device_id") == worker_id):
                runtime_digest = install.runtime_digest
                device_installed = True
        items.append({"entitlement_id": row["id"], "product_id": row["product_id"],
                      "product_name": publication["name"], "status": row["status"],
                      "device_installed": device_installed,
                      "runtime_digest": runtime_digest,
                      "install_expires_at": (_utc_iso(row["expires_at"])
                                             if row["expires_at"] else None)})
    return {"items": items}


def _stored_install_payload(receipt: Any) -> dict[str, Any] | None:
    """Verify a durable install receipt without reapplying its issuance expiry."""
    if not isinstance(receipt, dict) or set(receipt) != {"key_id", "payload", "signature"}:
        return None
    payload = receipt["payload"]
    key_id = receipt["key_id"]
    from platform_v8.services.workers.file_device_attestation import RECEIPT_SCHEMA as FILE_RECEIPT_SCHEMA, file_install_roots
    roots = file_install_roots() if isinstance(payload, dict) and payload.get("schema") == FILE_RECEIPT_SCHEMA else _install_roots()
    key = roots.get(key_id) if isinstance(key_id, str) else None
    if key is None or not isinstance(payload, dict):
        return None
    try:
        signed = publication_svc._b64decode(receipt["signature"], 64)
        key.verify(signed, _canonical(payload))
    except (ValueError, TypeError, InvalidSignature):
        return None
    return payload


def _funds_account(s: Session, buyer_id: int) -> None:
    row = s.execute(select(accounts_t.c.status).where(
        accounts_t.c.id == buyer_id).with_for_update()).scalar_one_or_none()
    if row != "active":
        raise ProductError("购买账号不存在或已停用")


def purchase(s: Session, *, product_id: str, buyer_id: int,
             request_key: str) -> dict[str, Any]:
    if not isinstance(request_key, str) or not _KEY.fullmatch(request_key):
        raise ProductError("Idempotency-Key 必须为 8–128 位安全字符")
    try:
        lifecycle.product_admission(s, product_id)
    except lifecycle.LifecycleError as exc:
        raise ProductConflict("投稿已撤回、下架或归档，停止新增购买和接单授权") from exc
    row = _get(s, product_id, lock=True)
    existing_key = s.execute(select(entitlements_t).where(
        entitlements_t.c.buyer_id == buyer_id,
        entitlements_t.c.request_key == request_key)).mappings().first()
    if existing_key is not None and existing_key["product_id"] != product_id:
        raise ProductConflict("同一幂等键已用于另一商品")
    existing = s.execute(select(entitlements_t).where(
        entitlements_t.c.buyer_id == buyer_id,
        entitlements_t.c.product_id == product_id)).mappings().first()
    if existing is not None:
        if (existing["status"] == "pending_install" and existing["expires_at"]
                and _utc(existing["expires_at"]) <= _utc_now()):
            _refund_pending(s, dict(existing), reason="install_expired", actor_id=None)
            existing = s.execute(select(entitlements_t).where(
                entitlements_t.c.id == existing["id"])).mappings().one()
        return _entitlement(dict(existing), already_owned=True)
    if row["status"] != "published":
        raise ProductNotFound("商品尚未上架")
    if not _purchase_enabled(fresh=True):
        raise ProductError("独立安装签发或超时退款回收未就绪，暂停购买扣款")
    if buyer_id == row["owner_id"]:
        raise ProductError("作者无需购买自己的商品")
    publication = _publication(s, row["publication_id"])
    _, issues = _issues(s, row, publication)
    if issues:
        raise ProductError("商品当前不可购买：" + "；".join(issues))
    price = Decimal(_yuan(row["sale_price_yuan"]))
    _funds_account(s, buyer_id)
    if price > 0:
        claimed = s.execute(update(accounts_t).where(
            accounts_t.c.id == buyer_id, accounts_t.c.balance >= price)
            .values(balance=accounts_t.c.balance - price))
        if claimed.rowcount != 1:
            raise ProductError("人民币余额不足")
    entitlement_id = str(uuid4())
    ledger_key = f"order-adapter:{product_id}:{buyer_id}"
    expires_at = _utc_now() + timedelta(seconds=_INSTALL_WINDOW_SECONDS)
    try:
        with s.begin_nested():
            s.execute(insert(entitlements_t).values(
                id=entitlement_id, product_id=product_id, buyer_id=buyer_id,
                price_yuan=price, currency="CNY", ledger_key=ledger_key,
                request_key=request_key, status="pending_install",
                expires_at=expires_at))
    except IntegrityError as exc:
        raise ProductConflict("并发购买发生冲突，请重新读取权益") from exc
    if price > 0:
        LedgerRepo.write(s, LedgerEntry(
            account_id=buyer_id, type=LedgerType.ESCROW_HOLD,
            amount=-price, idempotent_key=ledger_key + ":hold",
            note=f"接单技能待安装托管 {product_id}",
            metadata={"product_id": product_id, "entitlement_id": entitlement_id}))
        _refresh_balance_cache(s, buyer_id)
    AuditRepo.write(s, action="order_adapter_product.purchase", actor_account_id=buyer_id,
                    actor_kind="account", target_kind="order_entitlement",
                    target_id=entitlement_id,
                    detail={"product_id": product_id, "price_yuan": str(price),
                            "currency": "CNY", "state": "pending_install"})
    s.flush()
    return _entitlement({"id": entitlement_id, "product_id": product_id,
                         "status": "pending_install", "price_yuan": price,
                         "expires_at": expires_at}, already_owned=False)


def author_entitlement(s: Session, *, product_id: str, owner_id: int) -> dict[str, Any]:
    """Give an exact published package's author the same device-install path, at zero cost.

    This is an account entitlement only. Independent install challenges and
    signed device receipts remain mandatory, and any prior state is reused.
    """
    try:
        lifecycle.product_admission(s, product_id)
    except lifecycle.LifecycleError as exc:
        raise ProductConflict("投稿已撤回、下架或归档，停止新增购买和接单授权") from exc
    product = _get(s, product_id, lock=True)
    if product["owner_id"] != owner_id:
        raise ProductNotFound("此商品不属于当前作者")
    if product["status"] != "published":
        raise ProductNotFound("商品尚未上架")
    publication = _publication(s, product["publication_id"])
    if publication["owner_id"] != owner_id or publication["status"] != "approved":
        raise ProductError("作者投稿尚未通过审核")
    existing = s.execute(select(entitlements_t).where(
        entitlements_t.c.product_id == product_id,
        entitlements_t.c.buyer_id == owner_id)).mappings().first()
    if existing is not None:
        return _entitlement(dict(existing), already_owned=True)
    _, issues = _issues(s, product, publication)
    if issues:
        raise ProductError("商品当前不可安装：" + "；".join(issues))
    _funds_account(s, owner_id)
    entitlement_id = str(uuid4())
    expires_at = _utc_now() + timedelta(seconds=_INSTALL_WINDOW_SECONDS)
    try:
        with s.begin_nested():
            s.execute(insert(entitlements_t).values(
                id=entitlement_id, product_id=product_id, buyer_id=owner_id,
                price_yuan=Decimal("0.00"), currency="CNY", ledger_key=None,
                request_key=f"author:{product_id}", status="pending_install",
                expires_at=expires_at))
    except IntegrityError as exc:
        raise ProductConflict("作者权益状态已变化，请重新读取") from exc
    AuditRepo.write(s, action="order_adapter_product.author_entitlement",
                    actor_account_id=owner_id, actor_kind="account",
                    target_kind="order_entitlement", target_id=entitlement_id,
                    detail={"product_id": product_id,
                            "publication_id": publication["id"],
                            "price_yuan": "0.00", "currency": "CNY",
                            "state": "pending_install"})
    s.flush()
    return _entitlement({"id": entitlement_id, "product_id": product_id,
                         "status": "pending_install", "price_yuan": Decimal("0.00"),
                         "expires_at": expires_at}, already_owned=False)


def _owned_entitlement(s: Session, *, product_id: str, buyer_id: int,
                       lock: bool = False) -> dict[str, Any]:
    stmt = select(entitlements_t).where(
        entitlements_t.c.product_id == product_id,
        entitlements_t.c.buyer_id == buyer_id)
    if lock:
        stmt = stmt.with_for_update()
    row = s.execute(stmt).mappings().first()
    if row is None:
        raise ProductNotFound("尚无此商品的购买记录")
    return dict(row)


def _refund_pending(s: Session, row: dict[str, Any], *, reason: str,
                    actor_id: int | None) -> dict[str, Any]:
    """Release only an unsettled hold. CAS and ledger key make retries harmless."""
    if row["status"] == "refunded":
        return _entitlement(row, already_owned=True)
    if row["status"] != "pending_install":
        raise ProductConflict("订单已经安装结算，不能按安装失败退款")
    now = _utc_now()
    changed = s.execute(update(entitlements_t).where(
        entitlements_t.c.id == row["id"], entitlements_t.c.status == "pending_install")
        .values(status="refunded", refunded_at=now, refund_reason=reason))
    if changed.rowcount != 1:
        raise ProductConflict("购买状态已变化，请重新读取")
    price = Decimal(_yuan(row["price_yuan"]))
    if price > 0:
        LedgerRepo.write(s, LedgerEntry(
            account_id=row["buyer_id"], type=LedgerType.REFUND,
            amount=price, idempotent_key=row["ledger_key"] + ":refund:buyer",
            note=f"接单技能安装未完成退款 {row['product_id']}",
            metadata={"product_id": row["product_id"],
                      "entitlement_id": row["id"], "reason": reason}))
        _refresh_balance_cache(s, row["buyer_id"])
    AuditRepo.write(s, action="order_adapter_product.refund_pending",
                    actor_account_id=actor_id, actor_kind="account" if actor_id else "system",
                    target_kind="order_entitlement", target_id=row["id"],
                    detail={"reason": reason, "price_yuan": _yuan(price)})
    return _entitlement({**row, "status": "refunded"}, already_owned=True)


def cancel_pending_purchase(s: Session, *, product_id: str, buyer_id: int) -> dict[str, Any]:
    row = _owned_entitlement(s, product_id=product_id, buyer_id=buyer_id, lock=True)
    return _refund_pending(s, row, reason="buyer_cancel_before_install", actor_id=buyer_id)


def expire_pending_purchases(s: Session, *, now: datetime | None = None,
                             limit: int = 100) -> dict[str, int]:
    """Idempotent batch for a trusted periodic runner, never a browser timer."""
    if not 1 <= limit <= 500:
        raise ProductError("过期退款批量大小非法")
    current = _utc(now) if now is not None else _utc_now()
    rows = s.execute(select(entitlements_t).where(
        entitlements_t.c.status == "pending_install",
        entitlements_t.c.expires_at.is_not(None),
        entitlements_t.c.expires_at <= current)
        .order_by(entitlements_t.c.expires_at.asc()).limit(limit)
        .with_for_update(skip_locked=True)).mappings().all()
    for row in rows:
        _refund_pending(s, dict(row), reason="install_expired", actor_id=None)
    return {"refunded": len(rows)}


async def expiry_refund_worker_loop(interval_seconds: int = 60) -> None:
    """Only a healthy migrated DB can unlock the explicit purchase flag.

    Each process runs the bounded idempotent sweep. PostgreSQL SKIP LOCKED
    partitions rows between processes; missing v8_063 or a DB outage clears
    the local purchase gate immediately.
    """
    from platform_v8.storage import db as db_mod

    if interval_seconds < 1:
        raise ValueError("invalid refund interval")
    _expiry_reaper_healthy.clear()
    first_sweep_reported = False
    try:
        while True:
            try:
                def sweep() -> int:
                    with db_mod.session_scope() as session:
                        result = expire_pending_purchases(session)
                        session.commit()
                        return result["refunded"]

                count = await asyncio.to_thread(sweep)
                _expiry_reaper_healthy.set()
                if not first_sweep_reported:
                    logger.info("order_adapter.expiry_refund · healthy first_sweep refunded=%d", count)
                    first_sweep_reported = True
                if count:
                    logger.info("order_adapter.expiry_refund · refunded=%d", count)
            except Exception:
                _expiry_reaper_healthy.clear()
                logger.exception("order_adapter.expiry_refund · unavailable; purchase closed")
            await asyncio.sleep(interval_seconds)
    finally:
        _expiry_reaper_healthy.clear()


def _install_roots() -> dict[str, Ed25519PublicKey]:
    """Independent device-install attestors, provisioned by operations only."""
    raw = os.environ.get("V8_ORDER_ADAPTER_INSTALL_TRUST_ROOTS", "")
    if not raw or len(raw) > 8192:
        return {}
    try:
        roots = json.loads(raw)
        if not isinstance(roots, dict) or not 1 <= len(roots) <= 8:
            return {}
        other_keys = {key.public_bytes(Encoding.Raw, PublicFormat.Raw)
                      for group in publication_svc._roots().values()
                      for key in group.values()}
        result: dict[str, Ed25519PublicKey] = {}
        seen: set[bytes] = set()
        for key_id, encoded in roots.items():
            if not isinstance(key_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", key_id):
                return {}
            key_bytes = publication_svc._b64decode(encoded, 32)
            if key_bytes in other_keys or key_bytes in seen:
                return {}
            seen.add(key_bytes)
            result[key_id] = Ed25519PublicKey.from_public_bytes(key_bytes)
        return result
    except (ValueError, TypeError):
        return {}


def _verify_install_receipt(envelope: Any, *, row: dict[str, Any],
                            product: dict[str, Any], publication: dict[str, Any],
                            manifest: dict[str, Any]) -> tuple[str, str, str]:
    try:
        encoded = _canonical(envelope)
    except (ValueError, TypeError):
        raise ProductError("设备安装回执格式非法") from None
    if (not isinstance(envelope, dict) or set(envelope) != {"key_id", "payload", "signature"}
            or len(encoded) > 8192):
        raise ProductError("设备安装回执格式非法")
    key_id = envelope["key_id"]
    payload = envelope["payload"]
    signature = envelope["signature"]
    from platform_v8.services.workers import file_device_attestation as file_device
    file_source = bool(getattr(publication_svc._spec_for_row(publication), "adapter_file_schema", None))
    roots = file_device.file_install_roots() if file_source else _install_roots()
    key = roots.get(key_id) if isinstance(key_id, str) else None
    if key is None:
        raise ProductError("设备安装签发方未获独立信任")
    if (not isinstance(payload, dict) or set(payload) != {
            "schema", "result", "entitlement_id", "product_id", "buyer_id",
            "publication_id", "device_id", "archive_digest", "archive_version_id",
            "artifact_digest", "reviewed_seller_runtime_digest",
            "runtime_digest", "challenge_nonce", "challenge_input_sha256",
            "challenge_result_sha256", "issued_at", "expires_at"} | ({"file_binding"} if file_source else set())):
        raise ProductError("设备安装回执字段非法")
    now = int(time.time())
    if (payload["schema"] != (file_device.RECEIPT_SCHEMA if file_source else _INSTALL_SCHEMA)
            or (file_source and not file_device.validate_binding(publication, payload["file_binding"], proof=True))
            or payload["result"] != "passed"
            or payload["entitlement_id"] != row["id"]
            or payload["product_id"] != row["product_id"]
            or type(payload["buyer_id"]) is not int or payload["buyer_id"] != row["buyer_id"]
            or payload["publication_id"] != product["publication_id"]
            or not isinstance(payload["device_id"], str)
            or not _DEVICE.fullmatch(payload["device_id"])
            or payload["archive_digest"] != manifest["archive_digest"]
            or payload["archive_version_id"] != manifest["archive_version_id"]
            or payload["artifact_digest"] != publication["artifact_digest"]
            or payload["reviewed_seller_runtime_digest"] != publication["package_digest"]
            or not isinstance(payload["runtime_digest"], str)
            or not _SHA.fullmatch(payload["runtime_digest"])
            or not isinstance(payload["challenge_nonce"], str)
            or not isinstance(payload["challenge_input_sha256"], str)
            or not _SHA.fullmatch(payload["challenge_input_sha256"])
            or not isinstance(payload["challenge_result_sha256"], str)
            or not _SHA.fullmatch(payload["challenge_result_sha256"])
            or type(payload["issued_at"]) is not int or type(payload["expires_at"]) is not int
            or payload["issued_at"] > now + 60 or payload["expires_at"] <= now
            or payload["expires_at"] - payload["issued_at"] > 600):
        raise ProductError("设备安装回执未绑定当前购买、设备、归档或有效期")
    try:
        signed = publication_svc._b64decode(signature, 64)
        key.verify(signed, _canonical(payload))
    except (ValueError, TypeError, InvalidSignature) as exc:
        raise ProductError("设备安装回执签名无效") from exc
    return payload["device_id"], payload["runtime_digest"], key_id


def report_device_install(s: Session, *, product_id: str, buyer_id: int,
                          receipt: dict[str, Any]) -> dict[str, Any]:
    """Settle a held purchase only after a separate issuer signs device proof."""
    row = _owned_entitlement(s, product_id=product_id, buyer_id=buyer_id, lock=True)
    if row["status"] in {"refunded", "granted"}:
        raise ProductConflict("该权益已退款或属于旧结算合同，不能安装激活")
    if (row["status"] == "pending_install" and row["expires_at"]
            and _utc(row["expires_at"]) <= _utc_now()):
        return _refund_pending(s, row, reason="install_expired", actor_id=None)
    product = _get(s, product_id, lock=True)
    publication = _publication(s, product["publication_id"])
    manifest, issues = _issues(s, product, publication)
    if product["status"] != "published" or issues or manifest is None:
        if row["status"] == "pending_install":
            return _refund_pending(s, row, reason="provenance_unavailable", actor_id=None)
        raise ProductConflict("商品溯源已失效，设备授权暂停")
    device_id, runtime_digest, key_id = _verify_install_receipt(
        receipt, row=row, product=product, publication=publication, manifest=manifest)
    existing = s.execute(select(device_installs_t).where(
        device_installs_t.c.entitlement_id == row["id"],
        device_installs_t.c.device_id == device_id)).mappings().first()
    if existing is not None:
        if (existing["revoked_at"] is not None
                or existing["signed_receipt"] != receipt):
            raise ProductConflict("该设备安装回执与已登记回执不一致")
        return {**_entitlement(row, already_owned=True), "device_installed": True,
                "device_id": device_id, "runtime_digest": runtime_digest}
    from platform_v8.services.workers.order_adapter_remote_challenges import (
        RemoteChallengeError, consume_remote_challenge,
    )
    try:
        consume_remote_challenge(
            s, receipt=receipt, product_id=product_id, entitlement_id=row["id"],
            buyer_id=buyer_id, worker_id=device_id,
            publication=publication, manifest=manifest)
    except RemoteChallengeError as exc:
        raise ProductConflict(str(exc)) from exc
    try:
        with s.begin_nested():
            s.execute(insert(device_installs_t).values(
                id=str(uuid4()), entitlement_id=row["id"], device_id=device_id,
                runtime_digest=runtime_digest, receipt_key_id=key_id,
                signed_receipt=receipt))
    except IntegrityError as exc:
        raise ProductConflict("设备安装回执发生并发冲突，请重新读取") from exc
    if row["status"] == "pending_install":
        changed = s.execute(update(entitlements_t).where(
            entitlements_t.c.id == row["id"], entitlements_t.c.status == "pending_install")
            .values(status="installed", settled_at=_utc_now()))
        if changed.rowcount != 1:
            raise ProductConflict("购买状态已变化，请重新读取")
        price = Decimal(_yuan(row["price_yuan"]))
        if price > 0:
            platform_id = s.execute(select(accounts_t.c.id).where(
                accounts_t.c.role == "admin", accounts_t.c.status == "active")
                .order_by(accounts_t.c.id).limit(1)).scalar_one_or_none()
            if platform_id is None:
                raise ProductError("平台人民币结算账户未配置")
            split = split_app_revenue(price)
            for account_id, amount, suffix, kind in (
                    (product["owner_id"], split["developer"], "author", LedgerType.REWARD),
                    (platform_id, split["platform"], "platform", LedgerType.PLATFORM_FEE)):
                if amount > 0:
                    LedgerRepo.write(s, LedgerEntry(
                        account_id=account_id, type=kind, amount=amount,
                        idempotent_key=row["ledger_key"] + ":" + suffix,
                        note=f"接单技能安装成功结算 {product_id}",
                        metadata={"product_id": product_id, "entitlement_id": row["id"]}))
                    _refresh_balance_cache(s, account_id)
        row["status"] = "installed"
    AuditRepo.write(s, action="order_adapter_product.device_installed",
                    actor_account_id=buyer_id, actor_kind="account",
                    target_kind="order_device_install", target_id=device_id,
                    detail={"entitlement_id": row["id"], "runtime_digest": runtime_digest,
                            "receipt_key_id": key_id,
                            "receipt_sha256": hashlib.sha256(_canonical(receipt)).hexdigest()})
    return {**_entitlement(row, already_owned=True), "device_installed": True,
            "device_id": device_id, "runtime_digest": runtime_digest}


def suspend(s: Session, *, product_id: str, reviewer_id: int, note: str) -> dict[str, Any]:
    note = note.strip()
    if not note:
        raise ProductError("请填写下架原因")
    row = _get(s, product_id, lock=True)
    if row["status"] == "suspended":
        return _serialize(s, row)
    if row["status"] != "published":
        raise ProductConflict("只有已上架商品可暂停")
    changed = s.execute(update(products_t).where(
        products_t.c.id == product_id, products_t.c.status == "published")
        .values(status="suspended", review_note=note, reviewer_id=reviewer_id,
                updated_at=_utc_now()))
    if changed.rowcount != 1:
        raise ProductConflict("商品状态已变化")
    AuditRepo.write(s, action="order_adapter_product.suspend",
                    actor_account_id=reviewer_id, actor_kind="admin",
                    target_kind="order_product", target_id=product_id,
                    detail={"note": note})
    return _serialize(s, _get(s, product_id))


def refund_revoked_purchase(s: Session, *, product_id: str, entitlement_id: str,
                            reviewer_id: int, note: str) -> dict[str, Any]:
    """Audited chargeback after provenance revocation; ledger entries stay append-only."""
    note = note.strip()
    if not note:
        raise ProductError("请填写溯源撤销退款原因")
    product = _get(s, product_id, lock=True)
    row = s.execute(select(entitlements_t).where(
        entitlements_t.c.id == entitlement_id,
        entitlements_t.c.product_id == product_id).with_for_update()).mappings().first()
    if row is None:
        raise ProductNotFound("购买权益不存在")
    row = dict(row)
    if row["status"] == "refunded":
        return _entitlement(row, already_owned=True)
    publication = _publication(s, product["publication_id"])
    _, issues = _issues(s, product, publication)
    if product["status"] != "suspended" and not issues:
        raise ProductError("商品仍有有效溯源；须先暂停商品或完成撤销审核")
    if row["status"] == "pending_install":
        return _refund_pending(s, row, reason="provenance_revoked", actor_id=reviewer_id)
    if row["status"] != "installed":
        raise ProductConflict("旧合同已分账订单须人工核对，不自动改写")
    price = Decimal(_yuan(row["price_yuan"]))
    payout_rows = s.execute(select(ledger_t).where(
        ledger_t.c.idempotent_key.in_([
            row["ledger_key"] + ":author", row["ledger_key"] + ":platform"]))).mappings().all()
    if price > 0:
        split = split_app_revenue(price)
        expected = {suffix: amount for suffix, amount in (
            ("author", split["developer"]), ("platform", split["platform"])) if amount > 0}
        payouts = {str(p["idempotent_key"]).rsplit(":", 1)[-1]: p for p in payout_rows}
        if (set(payouts) != set(expected)
                or any(Decimal(str(payouts[suffix]["amount"])) != amount
                       or payouts[suffix]["currency"] != "CNY"
                       or not isinstance(payouts[suffix]["metadata"], dict)
                       or payouts[suffix]["metadata"].get("entitlement_id") != entitlement_id
                       for suffix, amount in expected.items())
                or ("author" in payouts and payouts["author"]["account_id"] != product["owner_id"])):
            raise ProductError("历史分账和订单金额不一致，禁止自动冲正")
    changed = s.execute(update(entitlements_t).where(
        entitlements_t.c.id == entitlement_id, entitlements_t.c.status == "installed")
        .values(status="refunded", refunded_at=_utc_now(),
                refund_reason="provenance_revoked"))
    if changed.rowcount != 1:
        raise ProductConflict("购买状态已变化，请重新读取")
    if price > 0:
        for payout in payout_rows:
            suffix = str(payout["idempotent_key"]).rsplit(":", 1)[-1]
            LedgerRepo.write(s, LedgerEntry(
                account_id=payout["account_id"], type=LedgerType.REFUND,
                amount=-Decimal(str(payout["amount"])),
                idempotent_key=row["ledger_key"] + ":refund:" + suffix,
                note=f"接单技能溯源撤销冲正 {product_id}",
                metadata={"product_id": product_id, "entitlement_id": entitlement_id,
                          "reason": note}))
            _refresh_balance_cache(s, payout["account_id"])
        LedgerRepo.write(s, LedgerEntry(
            account_id=row["buyer_id"], type=LedgerType.REFUND,
            amount=price, idempotent_key=row["ledger_key"] + ":refund:buyer",
            note=f"接单技能溯源撤销退款 {product_id}",
            metadata={"product_id": product_id, "entitlement_id": entitlement_id,
                      "reason": note}))
        _refresh_balance_cache(s, row["buyer_id"])
    s.execute(update(device_installs_t).where(
        device_installs_t.c.entitlement_id == entitlement_id,
        device_installs_t.c.revoked_at.is_(None)).values(revoked_at=_utc_now()))
    AuditRepo.write(s, action="order_adapter_product.refund_revoked",
                    actor_account_id=reviewer_id, actor_kind="admin",
                    target_kind="order_entitlement", target_id=entitlement_id,
                    detail={"product_id": product_id, "note": note,
                            "price_yuan": _yuan(price)})
    return _entitlement({**row, "status": "refunded"}, already_owned=True)


def _presign_versioned_get(*, object_key: str, version_id: str, bucket: str) -> tuple[str, int]:
    # Product archives live in the separately locked evidence bucket. The
    # general OSS provider points at a different, non-review bucket.
    try:
        storage = evidence_storage.provider()
        if storage.bucket != bucket or storage._full_key(object_key) != object_key:
            raise ProductError("锁定归档桶与商品清单不一致")
        expires = 300
        url = storage._public.generate_presigned_url(
            "get_object", Params={"Bucket": bucket, "Key": object_key,
                                  "VersionId": version_id},
            ExpiresIn=expires, HttpMethod="GET")
    except ProductError:
        raise
    except Exception as exc:
        raise ProductError("版本化商品存储未配置") from exc
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or len(url) > 8192):
        raise ProductError("版本化商品下载签名不可用")
    return url, int(time.time()) + expires


def install_manifest(s: Session, *, product_id: str, buyer_id: int) -> dict[str, Any]:
    row = _get(s, product_id)
    if row["status"] != "published":
        raise ProductNotFound("商品尚未上架")
    entitlement = s.execute(select(entitlements_t).where(
        entitlements_t.c.product_id == product_id,
        entitlements_t.c.buyer_id == buyer_id,
        entitlements_t.c.status.in_(["pending_install", "installed"]))).mappings().first()
    if entitlement is None:
        raise ProductNotFound("尚无有效的新版购买权益")
    if (entitlement["status"] == "pending_install" and entitlement["expires_at"]
            and _utc(entitlement["expires_at"]) <= _utc_now()):
        raise ProductError("安装期限已过；待托管退款处理")
    publication = _publication(s, row["publication_id"])
    manifest, issues = _issues(s, row, publication)
    if issues or manifest is None:
        raise ProductError("安装清单暂不可签发：" + "；".join(issues or ["可信归档缺失"]))
    url, expires_at = _presign_versioned_get(
        object_key=manifest["archive_object_key"],
        version_id=manifest["archive_version_id"],
        bucket=manifest["archive_bucket"])
    package_receipt = manifest["package_receipt"]
    package_issuer_key_id = package_receipt["key_id"]
    package_issuer_key = publication_svc._roots().get("package", {}).get(package_issuer_key_id)
    if package_issuer_key is None:
        raise ProductError("包审核签发方已撤销")
    package_issuer_public_key = base64.urlsafe_b64encode(
        package_issuer_key.public_bytes(Encoding.Raw, PublicFormat.Raw)).rstrip(b"=").decode("ascii")
    return {
        "product_id": product_id, "entitlement_id": entitlement["id"],
        "publication_id": row["publication_id"],
        "task_type": publication["task_type"], "version": publication["version"],
        "artifact_digest": manifest["artifact_digest"],
        "archive_digest": manifest["archive_digest"],
        "archive_size_bytes": manifest["archive_size_bytes"],
        "archive_version_id": manifest["archive_version_id"],
        "archive_format": manifest["archive_format"],
        "inventory_algorithm": manifest["inventory_algorithm"],
        "install_dependency_mode": manifest["install_dependency_mode"],
        "download_url": url, "expires_at": expires_at,
        "publisher_manifest": manifest["publisher_manifest"],
        "publisher_key_id": manifest["publisher_key_id"],
        "publisher_public_key": manifest["publisher_public_key"],
        "package_receipt": package_receipt,
        "package_issuer_key_id": package_issuer_key_id,
        "package_issuer_public_key": package_issuer_public_key,
        "reviewed_seller_runtime_digest": manifest["reviewed_seller_runtime_digest"],
        "buyer_runtime_digest_required": True,
        "device_installed": False,
    }
