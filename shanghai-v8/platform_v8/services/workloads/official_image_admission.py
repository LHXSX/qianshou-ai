"""Server-owned admission for the official image provider on the generic workload path.

The public catalog cannot grant execution. A configured, online Guangzhou
worker and a live independent media verifier are required for every quote,
submit and result check. The configured worker is platform-owned, never a
buyer-supplied worker pin.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any
from uuid import UUID

from platform_v8.storage.repo import WorkerRepo

TASK_TYPE = "image.generate"
PROVIDER_ID = "qianshou:official-image-generation-v1"
_MAX_RECIPE_BYTES = 16 * 1024
_DEVELOPER_METADATA = frozenset({
    '_developer_api_version', '_developer_idempotency_key',
    '_developer_idempotency_fingerprint', '_developer_webhook_configured',
})


def _unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate image request field")
        result[key] = value
    return result


def validate_order(*, input_kind: str, inline_input: Any,
                   params: Any) -> dict[str, Any]:
    """Freeze one bounded prompt, model and size into the signed quote spec."""
    user_params = params
    if isinstance(params, dict) and _DEVELOPER_METADATA.issubset(params):
        # Developer-task intake adds these server-owned identity fields to the
        # quoted workload spec. They are not image options; admit only its exact
        # reviewed envelope, then still require the single user PNG choice.
        if (set(params) != _DEVELOPER_METADATA | {'output_format'}
                or params.get('_developer_api_version') != 'task.v1'
                or not isinstance(params.get('_developer_idempotency_key'), str)
                or not 1 <= len(params['_developer_idempotency_key']) <= 128
                or not isinstance(params.get('_developer_idempotency_fingerprint'), str)
                or not re.fullmatch(r'[a-f0-9]{64}', params['_developer_idempotency_fingerprint'])
                or params.get('_developer_webhook_configured') is not False):
            raise ValueError('official image developer envelope invalid')
        user_params = {'output_format': params['output_format']}
    if (input_kind != "inline" or not isinstance(inline_input, str)
            or len(inline_input.encode("utf-8")) > _MAX_RECIPE_BYTES
            or not isinstance(user_params, dict)
            or user_params != {"output_format": "png"}):
        raise ValueError("official image requires one inline PNG request")
    try:
        value = json.loads(inline_input, object_pairs_hook=_unique,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ValueError("official image request JSON invalid") from exc
    if (not isinstance(value, dict) or set(value) != {"prompt", "model", "size"}
            or not isinstance(value["prompt"], str)
            or not 1 <= len(value["prompt"].strip()) <= 8_000
            or value["model"] != "grok-4.6"
            or not isinstance(value["size"], str)
            or not re.fullmatch(r"[1-9][0-9]{1,3}x[1-9][0-9]{1,3}", value["size"])):
        raise ValueError("official image prompt, model or size invalid")
    width, height = map(int, value["size"].split("x"))
    if not (64 <= width <= 2048 and 64 <= height <= 2048
            and width * height <= 4_194_304):
        raise ValueError("official image size exceeds limit")
    return value


def trusted_worker_identity() -> tuple[str, int] | None:
    """Read the operator-pinned worker and owner; unset means unavailable."""
    worker_id = os.environ.get("V8_OFFICIAL_IMAGE_WORKER_ID", "")
    owner = os.environ.get("V8_OFFICIAL_IMAGE_WORKER_OWNER_ID", "")
    if os.environ.get("V8_OFFICIAL_IMAGE_ADMISSION") != "1":
        return None
    try:
        if str(UUID(worker_id)) != worker_id or not re.fullmatch(r"[1-9][0-9]*", owner):
            return None
        return worker_id, int(owner)
    except (TypeError, ValueError):
        return None


def worker_matches(worker: Any) -> bool:
    identity = trusted_worker_identity()
    if (identity is None or worker is None
            or str(getattr(worker, "id", "")) != identity[0]
            or int(getattr(worker, "owner_id", 0) or 0) != identity[1]
            or getattr(worker, "onboarding_status", "") != "active"
            or getattr(worker, "is_temporarily_disabled", False)
            or not getattr(worker, "is_online", False)):
        return False
    from platform_v8.services.workers.task_adapters import matches, opted_in
    return opted_in(worker) and matches(worker, task_type=TASK_TYPE, input_kind="inline",
                   capability_id="image.generate", output_kind="artifact_ref")


def ready(session: Any) -> bool:
    identity = trusted_worker_identity()
    if session is None or identity is None:
        return False
    try:
        worker = WorkerRepo.by_id(session, identity[0])
        if not worker_matches(worker):
            return False
        from platform_v8.services.external_media_verifier import available
        return available(TASK_TYPE)
    except Exception:
        return False


def result_worker_matches(session: Any, worker_id: str) -> bool:
    """Verify the recorded result came from the pinned platform-owned worker."""
    identity = trusted_worker_identity()
    if identity is None or worker_id != identity[0] or session is None:
        return False
    try:
        worker = WorkerRepo.by_id(session, worker_id)
        return (worker is not None and worker.owner_id == identity[1]
                and worker.onboarding_status == "active")
    except Exception:
        return False


def require_ready(session: Any, *, input_kind: str, inline_input: Any,
                  params: Any, spec: dict[str, Any] | None = None) -> dict[str, Any]:
    order = validate_order(input_kind=input_kind, inline_input=inline_input,
                           params=params)
    if spec is not None and (spec.get("input_ref") or spec.get("input_refs")
                             or spec.get("code_url") or spec.get("requirements")):
        raise ValueError("official image does not accept file, code or worker overrides")
    if not ready(session):
        raise ValueError("官方出图执行节点或独立媒体验收尚未就绪")
    return order
