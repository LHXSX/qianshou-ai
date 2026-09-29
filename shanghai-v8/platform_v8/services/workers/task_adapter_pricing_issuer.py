"""Independent CNY pricing evidence from persisted server settings.

Run this code in a separate issuer process with a dedicated read-only database
identity and signing key. The desktop, author and Guangzhou review page provide
only the publication ID. None can provide the price, settings or signature.
The resulting receipt still needs the purpose-scoped evidence ingress and is
rechecked against live pricing at approval and dispatch readiness.
"""
from __future__ import annotations

import base64
import hashlib
import re
import time
from decimal import Decimal
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy import select
from sqlalchemy.orm import Session

from platform_v8.services.workers import task_adapter_publications as publication_svc
from platform_v8.storage.repo import accounts_t, kv_t, task_adapter_publications_t

_SETTINGS_KEY = "economy:settings:v1"
_KEY_ID = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
_TTL_SECONDS = 3600


class PricingEvidenceError(ValueError):
    """No trusted receipt can be issued for this publication or price state."""


def _server_price(session: Session, task_type: str, *, spec: Any = None) -> tuple[str, int, str]:
    """Require one persisted, versioned CNY row or reviewed policy tariff."""
    raw = session.execute(select(kv_t.c.v).where(kv_t.c.k == _SETTINGS_KEY)).scalar_one_or_none()
    if not isinstance(raw, dict):
        raise PricingEvidenceError("平台尚未保存独立版本的人民币任务定价")
    version = raw.get("version")
    rows = raw.get("task_pricing")
    if type(version) is not int or version < 1 or not isinstance(rows, list):
        raise PricingEvidenceError("人民币定价配置没有有效版本或明细")
    matches = [row for row in rows if isinstance(row, dict) and row.get("task_type") == task_type]
    if len(matches) > 1:
        raise PricingEvidenceError("该任务人民币服务端价目存在重复")
    if matches:
        row = matches[0]
    else:
        from platform_v8.services.economy.reviewed_adapter_tariffs import resolve_tariff
        row = resolve_tariff(raw, spec)
        if row is None:
            raise PricingEvidenceError("该任务缺少已审核的人民币通用价目")
    if row.get("currency", "CNY") != "CNY":
        raise PricingEvidenceError("任务价目不是人民币")
    try:
        price = publication_svc._yuan(row["base_price"])
        minimum = publication_svc._yuan(row.get("min_charge", 0))
    except (KeyError, publication_svc.PublicationError) as exc:
        raise PricingEvidenceError("人民币服务端价目非法") from exc
    if Decimal(price) <= 0 or Decimal(minimum) < 0:
        raise PricingEvidenceError("任务价目必须为正数")
    # The live readiness code reads the same settings through _load_settings.
    # A mismatch means a bridge, override, or newer settings source is active.
    if publication_svc._configured_price(session, task_type, spec=spec) != (price, version):
        raise PricingEvidenceError("价目与当前平台报价来源不一致")
    row_digest = "sha256:" + hashlib.sha256(publication_svc._canonical(row)).hexdigest()
    return price, version, row_digest


def issue_pricing_receipt(
    session: Session,
    *,
    publication_id: str,
    signing_key: Ed25519PrivateKey,
    key_id: str,
    now: int | None = None,
) -> dict[str, Any]:
    """Sign only after reading and checking the actual publication and price.

    The caller must run under an independent issuer identity. This function
    does not write to the database or deposit evidence by itself.
    """
    if not isinstance(signing_key, Ed25519PrivateKey):
        raise PricingEvidenceError("缺少独立价格签发密钥")
    if not isinstance(key_id, str) or not _KEY_ID.fullmatch(key_id):
        raise PricingEvidenceError("价格签发密钥编号非法")
    row = session.execute(select(task_adapter_publications_t).where(
        task_adapter_publications_t.c.id == publication_id)).mappings().first()
    if row is None or row["status"] != "review":
        raise PricingEvidenceError("投稿不存在或已不在待审核状态")
    owner_status = session.execute(select(accounts_t.c.status).where(
        accounts_t.c.id == row["owner_id"])).scalar_one_or_none()
    if owner_status != "active":
        raise PricingEvidenceError("投稿账号未处于可用状态")
    spec = publication_svc._spec_for_row(dict(row))
    if spec is None or not spec.requires_verified_adapter or not publication_svc._result_verifier_wired(spec):
        raise PricingEvidenceError("任务尚无已登记的独立接单审核合同")
    if (row["capability_id"] != spec.adapter_capability_id
            or row["output_kind"] != spec.adapter_output_kind
            or tuple(row["input_kinds"] or []) != tuple(spec.accepted_input_kinds)):
        raise PricingEvidenceError("投稿与平台任务合同不匹配")
    if row["currency"] != "CNY":
        raise PricingEvidenceError("投稿并非人民币报价")
    server_price, settings_version, row_digest = _server_price(
        session, row["task_type"], spec=spec)
    if publication_svc._yuan(row["price_yuan"]) != server_price:
        raise PricingEvidenceError("投稿价格与当前人民币服务端价不一致")
    issued_at = int(time.time()) if now is None else now
    if type(issued_at) is not int or issued_at <= 0:
        raise PricingEvidenceError("签发时间非法")
    payload = {
        "schema": "task-adapter-publication-evidence.v1",
        "kind": "pricing",
        "publication_id": row["id"],
        "owner_id": row["owner_id"],
        "task_type": row["task_type"],
        "artifact_digest": row["artifact_digest"],
        "package_digest": row["package_digest"],
        "result": "pass",
        "issued_at": issued_at,
        "expires_at": issued_at + _TTL_SECONDS,
        "details": {
            "currency": "CNY",
            "price_yuan": server_price,
            "settings_version": settings_version,
            "settings_row_sha256": row_digest,
            "settings_source": _SETTINGS_KEY,
        },
    }
    signature = signing_key.sign(publication_svc._canonical(payload))
    return {
        "key_id": key_id,
        "payload": payload,
        "signature": base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii"),
    }
