"""Short-lived, account-bound confirmation for an executable workload price.

The token is deliberately separate from an auth JWT.  It confirms a particular
submitted spec and the current server price; it does not authorize a user or
reserve money.  Submission always recomputes the price before writing anything.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from dataclasses import asdict
from decimal import Decimal
from typing import Any

from platform_v8.protocol.http_schema import WorkloadSpecIn
from platform_v8.services.auth.token import _get_secret
from platform_v8.services.economy.task_pricing import TaskPriceQuote

QUOTE_TTL_SECONDS = 300
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")


class WorkloadQuoteError(ValueError):
    """The user must request and confirm a fresh estimate."""


def canonical_spec(raw: dict[str, Any]) -> dict[str, Any]:
    """Use the same HTTP spec defaults at estimate and submit boundaries."""
    return WorkloadSpecIn.model_validate(raw).model_dump(mode="json")


def pricing_spec(raw: dict[str, Any], *, session: Any = None,
                 account_id: int | None = None) -> dict[str, Any]:
    """Mirror submission's input-kind inference before counting billable files."""
    spec = canonical_spec(raw)
    from platform_v8.engine.task_registry import get_spec

    if spec["task_type"] == "video_generate" and spec.get("media_input") is None:
        raise WorkloadQuoteError("旧版出视频任务没有可验证的在线供给，暂不能报价")

    if session is not None:
        # A new reviewed task type may be defined by an independently signed
        # publication rather than a Python literal in the static registry.
        from platform_v8.services.workers.task_adapter_publications import callable_task_spec
        callable_task_spec(session, spec["task_type"])

    task_meta = get_spec(spec["task_type"])
    if task_meta.requires_verified_adapter:
        reason_code = ("EXTERNAL_ARTIFACT_VERIFIER_REQUIRED" if
                       task_meta.external_artifact_verifier_required else
                       "TASK_ADAPTER_PUBLICATION_NOT_READY")
        if session is None or account_id is None:
            raise WorkloadQuoteError(
                reason_code + ": 此接单技能等待独立结果验收，暂不能报价"
            )
        from platform_v8.services.workers.task_adapter_publications import market_readiness
        state = market_readiness(session, spec["task_type"])
        if not state["ready"]:
            raise WorkloadQuoteError(
                reason_code + ": " + "；".join(state["reasons"])
            )
    input_kind = spec["input_kind"]
    from platform_v8.services.media_profiles import is_media
    if is_media(spec):
        if input_kind not in {"", "params_only"}:
            raise WorkloadQuoteError("媒体任务只接受 media_input 元数据")
        spec["input_kind"] = "params_only"
        return spec
    if not input_kind:
        if spec["inline_input"]:
            input_kind = "inline"
        elif spec["input_refs"]:
            input_kind = "multi_file"
        elif spec["input_ref"]:
            input_kind = "single_file"
        else:
            input_kind = task_meta.default_input_kind
    if input_kind not in task_meta.accepted_input_kinds:
        if task_meta.exact_input_kinds:
            raise WorkloadQuoteError("已审核接单技能不接受该输入类型")
        input_kind = (
            "single_file" if spec["input_ref"] else
            "multi_file" if spec["input_refs"] else task_meta.default_input_kind
        )
    if input_kind not in task_meta.accepted_input_kinds:
        raise WorkloadQuoteError("任务输入类型不受支持，无法报价")
    spec["input_kind"] = input_kind
    if task_meta.requires_verified_adapter:
        from platform_v8.services.workloads.reviewed_adapter_contract import validate_reviewed_order
        try:
            validate_reviewed_order(task_meta, input_kind=input_kind,
                                    inline_input=spec.get("inline_input"),
                                    params=spec.get("params"))
        except ValueError as exc:
            raise WorkloadQuoteError(str(exc)) from exc
    if getattr(task_meta, "official_provider_id", ""):
        from platform_v8.services.workloads.official_image_admission import require_ready
        try:
            require_ready(session, input_kind=input_kind,
                          inline_input=spec.get("inline_input"),
                          params=spec.get("params"), spec=spec)
        except ValueError as exc:
            raise WorkloadQuoteError(str(exc)) from exc
    return spec


def _digest(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _quote_snapshot(quote: TaskPriceQuote) -> dict[str, Any]:
    data = asdict(quote)
    return {key: str(value) if isinstance(value, Decimal) else value for key, value in data.items()}


def _key() -> bytes:
    # Production auth already requires V8_JWT_SECRET.  Derive a separate HMAC
    # namespace so a workload ticket can never be accepted as an auth token.
    return hmac.new(_get_secret().encode("utf-8"), b"v8.workload-price-confirmation.v1", hashlib.sha256).digest()


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def issue_confirmation(
    *, account_id: int, spec: dict[str, Any], quote: TaskPriceQuote, now: int | None = None,
) -> tuple[str, int]:
    """Return an opaque token and its Unix expiry, with no database write."""
    from platform_v8.services.media_profiles import require_formal_media_channel
    require_formal_media_channel(spec, account_id=account_id)
    issued_at = int(time.time()) if now is None else now
    expires_at = issued_at + QUOTE_TTL_SECONDS
    claims = {
        "v": 1, "account_id": account_id, "spec_sha256": _digest(canonical_spec(spec)),
        "price_sha256": _digest(_quote_snapshot(quote)), "issued_at": issued_at,
        "expires_at": expires_at,
    }
    payload = json.dumps(claims, sort_keys=True, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(_key(), payload, hashlib.sha256).digest()
    return f"{_b64(payload)}.{_b64(signature)}", expires_at


def verify_confirmation(
    token: str | None, *, account_id: int, spec: dict[str, Any], quote: TaskPriceQuote,
    now: int | None = None,
) -> None:
    """Reject missing, altered, expired, cross-account or stale price tickets."""
    if not token or len(token) > 4096 or not _TOKEN_RE.fullmatch(token):
        raise WorkloadQuoteError("请先获取最新任务报价并确认金额")
    encoded, encoded_signature = token.split(".", 1)
    try:
        payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        signature = base64.urlsafe_b64decode(encoded_signature + "=" * (-len(encoded_signature) % 4))
    except (ValueError, TypeError):
        raise WorkloadQuoteError("任务报价无效，请重新获取") from None
    expected = hmac.new(_key(), payload, hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected):
        raise WorkloadQuoteError("任务报价无效，请重新获取")
    try:
        claims = json.loads(payload)
        current = int(time.time()) if now is None else now
        if not isinstance(claims, dict) or claims.get("v") != 1:
            raise WorkloadQuoteError("任务报价无效，请重新获取")
        issued_at = claims.get("issued_at")
        expires_at = claims.get("expires_at")
        if type(issued_at) is not int or type(expires_at) is not int \
                or expires_at - issued_at != QUOTE_TTL_SECONDS or current < issued_at:
            raise WorkloadQuoteError("任务报价无效，请重新获取")
        if current >= expires_at:
            raise WorkloadQuoteError("任务报价已过期，请重新获取并确认")
        if claims.get("account_id") != account_id or claims.get("spec_sha256") != _digest(canonical_spec(spec)):
            raise WorkloadQuoteError("任务报价与当前账号或任务不匹配，请重新获取")
        if claims.get("price_sha256") != _digest(_quote_snapshot(quote)):
            raise WorkloadQuoteError("任务价格已更新，请重新获取并确认")
    except (TypeError, ValueError) as exc:
        if isinstance(exc, WorkloadQuoteError):
            raise
        raise WorkloadQuoteError("任务报价无效，请重新获取") from None
