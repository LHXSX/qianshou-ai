"""One-use control-plane challenge for activating a purchased adapter.

Shanghai reserves an entitlement/node/locked-archive nonce and stores an
independently signed input plan. The separate attestor serves challenge input,
compares the target node's result against its own isolated execution, and signs
the activation receipt. Shanghai never executes package code or handles media
bytes. A challenge pass demonstrates a working remote executor at that moment;
it cannot cryptographically prove permanent files on an untrusted PC.
"""
from __future__ import annotations

import hashlib
import base64
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
import httpx
from sqlalchemy import insert, select, update
from sqlalchemy.orm import Session

from platform_v8.services.workers import order_adapter_products as products
from platform_v8.services.workers import task_adapter_publications as publications
from platform_v8.services.workers.order_adapter_attestor_health import attestor_ready, _config
from platform_v8.storage.repo import (
    WorkerRepo, order_adapter_remote_challenges_t as challenges_t,
    task_adapter_package_uploads_t as uploads_t,
)

_PLAN_SCHEMA = "qianshou.order-adapter-remote-challenge-plan.v1"
_RECEIPT_SCHEMA = "qianshou.order-adapter-remote-challenge.v1"
_SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
_PLAN_FIELDS = frozenset({
    "schema", "challenge_nonce", "product_id", "entitlement_id", "buyer_id",
    "publication_id", "device_id", "archive_digest", "archive_version_id",
    "artifact_digest", "reviewed_seller_runtime_digest", "input_kind",
    "challenge_input_sha256", "input_ref", "issued_at", "expires_at",
})
_RECEIPT_FIELDS = frozenset({
    "schema", "result", "entitlement_id", "product_id", "buyer_id",
    "publication_id", "device_id", "archive_digest", "archive_version_id",
    "artifact_digest", "reviewed_seller_runtime_digest", "runtime_digest",
    "challenge_nonce", "challenge_input_sha256", "challenge_result_sha256",
    "issued_at", "expires_at",
})


class RemoteChallengeError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _signed_payload(envelope: Any, expected_fields: frozenset[str]) -> dict[str, Any]:
    if isinstance(envelope, dict) and isinstance(envelope.get("payload"), dict) and "file_binding" in envelope["payload"]:
        from platform_v8.services.workers.file_device_attestation import signed_file_payload
        try:
            return signed_file_payload(envelope, expected_fields)
        except (ValueError, TypeError) as exc:
            raise RemoteChallengeError("文件设备用途签名无效") from exc
    if (not isinstance(envelope, dict)
            or set(envelope) != {"key_id", "payload", "signature"}
            or not isinstance(envelope["key_id"], str)
            or not isinstance(envelope["payload"], dict)
            or set(envelope["payload"]) != expected_fields
            or len(products._canonical(envelope)) > 8192):
        raise RemoteChallengeError("独立挑战签名包字段非法")
    key = products._install_roots().get(envelope["key_id"])
    if key is None:
        raise RemoteChallengeError("独立挑战签发方未获信任")
    try:
        signature = publications._b64decode(envelope["signature"], 64)
        key.verify(signature, products._canonical(envelope["payload"]))
    except (InvalidSignature, ValueError, TypeError) as exc:
        raise RemoteChallengeError("独立挑战签名无效") from exc
    return envelope["payload"]


def reserve_remote_challenge(s: Session, *, product_id: str, buyer_id: int,
                             worker_id: str) -> dict[str, Any]:
    """Lock the entitlement and reserve only control metadata for one online node.

    The caller sends the returned request over an authenticated service channel
    to the independent attestor. No client-provided input or archive claim is
    accepted here.
    """
    if not isinstance(worker_id, str) or not worker_id:
        raise RemoteChallengeError("请选择已登录的接单设备")
    worker = WorkerRepo.by_id(s, worker_id)
    if (worker is None or int(worker.owner_id) != buyer_id
            or getattr(worker.status, "value", worker.status) not in {"ONLINE", "BUSY"}
            or getattr(worker, "onboarding_status", None) == "banned"):
        raise RemoteChallengeError("接单设备不在线或不属于当前账号")
    from platform_v8.services.workers.task_adapter_review_samples import _ws_connected
    if not _ws_connected(worker_id):
        raise RemoteChallengeError("接单设备会话未连接")
    entitlement = products._owned_entitlement(s, product_id=product_id,
                                               buyer_id=buyer_id, lock=True)
    if entitlement["status"] not in {"pending_install", "installed"}:
        raise RemoteChallengeError("尚无可激活的购买权益")
    now = _now()
    if (entitlement["status"] == "pending_install" and entitlement["expires_at"]
            and _utc(entitlement["expires_at"]) <= now):
        raise RemoteChallengeError("购买安装期限已过")
    product = products._get(s, product_id)
    publication = products._publication(s, product["publication_id"])
    manifest, issues = products._issues(s, product, publication)
    if product["status"] != "published" or issues or manifest is None:
        raise RemoteChallengeError("商品锁定归档或审核状态不可用")
    # Shanghai sends only metadata verified from three independent records:
    # its confirmed upload, Guangzhou's signed package receipt (rechecked in
    # _issues) and the published distribution manifest. The buyer cannot pick
    # a bucket, object key or owner for the attestor's exact-version GET.
    upload = s.execute(select(uploads_t).where(
        uploads_t.c.publication_id == publication["id"],
        uploads_t.c.owner_id == publication["owner_id"],
        uploads_t.c.status == "confirmed",
    )).mappings().first()
    lock_until = upload["lock_retain_until"] if upload is not None else None
    if (upload is None or lock_until is None
            or _utc(lock_until) <= now + timedelta(hours=24)
            or product["owner_id"] != publication["owner_id"]
            or upload["bucket"] != manifest.get("archive_bucket")
            or upload["object_key"] != manifest.get("archive_object_key")
            or upload["version_id"] != manifest["archive_version_id"]
            or upload["archive_digest"] != manifest["archive_digest"]):
        raise RemoteChallengeError("锁定归档与独立验包证据不一致")
    file_binding = None
    if getattr(publications._spec_for_row(publication), "adapter_file_schema", None):
        from platform_v8.services.workers import file_device_attestation as file_device
        if not file_device.file_attestor_ready():
            raise RemoteChallengeError("独立文件设备验收服务未登记或未就绪")
        file_binding = file_device.request_binding(publication)
    else:
        roots = products._install_roots()
        if not roots or not attestor_ready(roots, fresh=True):
            raise RemoteChallengeError("独立远程验收服务未就绪")
    s.execute(update(challenges_t).where(
        challenges_t.c.entitlement_id == entitlement["id"],
        challenges_t.c.worker_id == worker_id,
        challenges_t.c.status.in_(["pending_plan", "issued"]),
        challenges_t.c.expires_at <= now,
    ).values(status="expired"))
    active = s.execute(select(challenges_t.c.nonce).where(
        challenges_t.c.entitlement_id == entitlement["id"],
        challenges_t.c.worker_id == worker_id,
        challenges_t.c.status.in_(["pending_plan", "issued"]),
    ).limit(1)).first()
    if active is not None:
        raise RemoteChallengeError("该设备已有待完成的随机挑战")
    nonce = str(uuid4())
    expires = now + timedelta(seconds=120)
    pinned = {
        "challenge_nonce": nonce, "product_id": product_id,
        "entitlement_id": entitlement["id"], "buyer_id": buyer_id,
        "publication_id": publication["id"], "device_id": worker_id,
        "archive_digest": manifest["archive_digest"],
        "archive_version_id": manifest["archive_version_id"],
        "artifact_digest": publication["artifact_digest"],
        "reviewed_seller_runtime_digest": publication["package_digest"],
    }
    s.execute(insert(challenges_t).values(
        nonce=nonce, entitlement_id=entitlement["id"], product_id=product_id,
        publication_id=publication["id"], buyer_id=buyer_id, worker_id=worker_id,
        archive_digest=pinned["archive_digest"],
        archive_version_id=pinned["archive_version_id"],
        artifact_digest=pinned["artifact_digest"],
        reviewed_seller_runtime_digest=pinned["reviewed_seller_runtime_digest"],
        status="pending_plan", issued_at=now, expires_at=expires,
    ))
    return {"schema": (file_device.REQUEST_SCHEMA if file_binding else "qianshou.order-adapter-remote-challenge-request.v1"),
            **({"file_binding": file_binding} if file_binding else {}),
            **pinned, "input_kinds": publication["input_kinds"],
            "archive_owner_id": publication["owner_id"],
            "archive_bucket": manifest["archive_bucket"],
            "archive_object_key": manifest["archive_object_key"],
            "issued_at": int(now.timestamp()), "expires_at": int(expires.timestamp())}


def attach_attestor_plan(s: Session, *, plan: dict[str, Any]) -> dict[str, Any]:
    """Accept only the independently signed input plan for a reserved nonce."""
    payload = _signed_payload(plan, _PLAN_FIELDS)
    nonce = payload["challenge_nonce"]
    row = s.execute(select(challenges_t).where(
        challenges_t.c.nonce == nonce).with_for_update()).mappings().first()
    if row is None or row["status"] != "pending_plan" or _utc(row["expires_at"]) <= _now():
        raise RemoteChallengeError("随机挑战不存在或已过期")
    exact = {
        "product_id": row["product_id"], "entitlement_id": row["entitlement_id"],
        "buyer_id": row["buyer_id"], "publication_id": row["publication_id"],
        "device_id": row["worker_id"], "archive_digest": row["archive_digest"],
        "archive_version_id": row["archive_version_id"],
        "artifact_digest": row["artifact_digest"],
        "reviewed_seller_runtime_digest": row["reviewed_seller_runtime_digest"],
    }
    publication = products._publication(s, row["publication_id"])
    from platform_v8.services.workers import file_device_attestation as file_device
    file_source = bool(getattr(publications._spec_for_row(publication), "adapter_file_schema", None))
    now = int(_now().timestamp())
    if (payload["schema"] != (file_device.PLAN_SCHEMA if file_source else _PLAN_SCHEMA)
            or (file_source and not file_device.validate_binding(publication, payload.get("file_binding"), proof=True))
            or (not file_source and "file_binding" in payload)
            or any(payload[key] != value for key, value in exact.items())
            or payload["input_kind"] not in publication["input_kinds"]
            or not isinstance(payload["challenge_input_sha256"], str)
            or not _SHA.fullmatch(payload["challenge_input_sha256"])
            or payload["input_ref"] != (f"/file/challenges/{nonce}/input" if file_source else f"/challenges/{nonce}/input")
            or type(payload["issued_at"]) is not int
            or type(payload["expires_at"]) is not int
            or payload["issued_at"] < int(_utc(row["issued_at"]).timestamp()) - 5
            or payload["issued_at"] > now + 10
            or payload["expires_at"] <= now
            or payload["expires_at"] > int(_utc(row["expires_at"]).timestamp())):
        raise RemoteChallengeError("独立挑战输入未绑定购买与锁定版本")
    changed = s.execute(update(challenges_t).where(
        challenges_t.c.nonce == nonce, challenges_t.c.status == "pending_plan",
    ).values(status="issued", challenge_input_sha256=payload["challenge_input_sha256"],
             signed_plan=plan))
    if changed.rowcount != 1:
        raise RemoteChallengeError("随机挑战状态已变化")
    return plan


def request_attestor_plan(s: Session, request: dict[str, Any]) -> dict[str, Any]:
    """Ask the fixed HTTPS attestor to create input, then persist its signed plan.

    The independent service must keep challenge bytes and its private key.
    The response contains only a relative input ref and hashes for Shanghai.
    """
    if "file_binding" in request:
        from platform_v8.services.workers.file_device_attestation import file_attestor_config, file_attestor_ready
        file_config = file_attestor_config()
        if file_config is None or not file_attestor_ready():
            raise RemoteChallengeError("独立文件远程验收服务未就绪")
        url, token, key_id, ca = file_config.base_url, file_config.token, file_config.key_id, True
        signer_key = file_config.public_key
    else:
        roots = products._install_roots()
        config = _config(roots)
        if config is None or not attestor_ready(roots, fresh=True):
            raise RemoteChallengeError("独立远程验收服务未就绪")
        url, token, key_id, ca = config
        signer_key = roots[key_id]
    try:
        response = httpx.post(
            url + "/challenges", json=request,
            headers={"Authorization": "Bearer " + token},
            timeout=httpx.Timeout(30.0, connect=3.0),
            verify=ca, follow_redirects=False, trust_env=False,
        )
        if response.status_code != 200 or len(response.content) > 8192:
            raise RemoteChallengeError("独立验收服务未签发挑战输入")
        plan = response.json()
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        raise RemoteChallengeError("独立验收服务未签发挑战输入") from exc
    if not isinstance(plan, dict) or plan.get("key_id") != key_id:
        raise RemoteChallengeError("挑战输入不是当前独立签发方签署")
    saved = attach_attestor_plan(s, plan=plan)
    public_key = signer_key.public_bytes(Encoding.Raw, PublicFormat.Raw)
    return {"signed_plan": saved, "attestor_origin": url + "/",
            "attestor_key_id": key_id,
            "attestor_public_key": base64.urlsafe_b64encode(public_key).rstrip(b"=").decode()}


def consume_remote_challenge(s: Session, *, receipt: dict[str, Any],
                             product_id: str, entitlement_id: str,
                             buyer_id: int, worker_id: str,
                             publication: dict[str, Any],
                             manifest: dict[str, Any]) -> str:
    """Consume a signed challenge once inside the device-receipt transaction.

    The caller must verify the independent Ed25519 receipt first. This function
    independently repeats its signature check to avoid a future call-site gap.
    """
    payload = _signed_payload(receipt, _RECEIPT_FIELDS)
    nonce = payload["challenge_nonce"]
    if not isinstance(nonce, str):
        raise RemoteChallengeError("随机挑战编号非法")
    row = s.execute(select(challenges_t).where(
        challenges_t.c.nonce == nonce).with_for_update()).mappings().first()
    now = _now()
    if (row is None or row["status"] != "issued" or _utc(row["expires_at"]) <= now
            or row["signed_plan"] is None):
        raise RemoteChallengeError("随机挑战未完成、过期或已消费")
    exact = {
        "entitlement_id": entitlement_id, "product_id": product_id,
        "buyer_id": buyer_id, "publication_id": publication["id"],
        "device_id": worker_id, "archive_digest": manifest["archive_digest"],
        "archive_version_id": manifest["archive_version_id"],
        "artifact_digest": publication["artifact_digest"],
        "reviewed_seller_runtime_digest": publication["package_digest"],
        "challenge_input_sha256": row["challenge_input_sha256"],
    }
    from platform_v8.services.workers import file_device_attestation as file_device
    file_source = bool(getattr(publications._spec_for_row(publication), "adapter_file_schema", None))
    if (payload["schema"] != (file_device.RECEIPT_SCHEMA if file_source else _RECEIPT_SCHEMA)
            or (file_source and (not file_device.validate_binding(publication, payload.get("file_binding"), proof=True)
                or payload.get("file_binding") != row["signed_plan"].get("payload", {}).get("file_binding")))
            or (not file_source and "file_binding" in payload) or payload["result"] != "passed"
            or any(payload[key] != value for key, value in exact.items())
            or row["entitlement_id"] != entitlement_id
            or row["product_id"] != product_id or row["buyer_id"] != buyer_id
            or row["worker_id"] != worker_id
            or row["publication_id"] != publication["id"]
            or not isinstance(payload["challenge_result_sha256"], str)
            or not _SHA.fullmatch(payload["challenge_result_sha256"])
            or not isinstance(payload["runtime_digest"], str)
            or not _SHA.fullmatch(payload["runtime_digest"])
            or type(payload["issued_at"]) is not int
            or type(payload["expires_at"]) is not int
            or payload["issued_at"] < int(_utc(row["issued_at"]).timestamp())
            or payload["issued_at"] > int(now.timestamp()) + 10
            or payload["expires_at"] <= int(now.timestamp())
            or payload["expires_at"] - payload["issued_at"] > 600):
        raise RemoteChallengeError("远程挑战回执未绑定当前节点、输入及审核版本")
    digest = "sha256:" + hashlib.sha256(products._canonical(receipt)).hexdigest()
    changed = s.execute(update(challenges_t).where(
        challenges_t.c.nonce == nonce, challenges_t.c.status == "issued",
    ).values(status="passed", receipt_sha256=digest, consumed_at=now))
    if changed.rowcount != 1:
        raise RemoteChallengeError("随机挑战已被并发消费")
    return digest
