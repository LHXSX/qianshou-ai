"""Official media plans and fail-closed device admission.

Profiles are operator-reviewed versioned metadata in the existing economy KV.
Binding receipts come from a separate server-only KV, never node advertisements.
This module performs no download, upload, image decoding, or content review.
The formal media executor/result/idempotency integration is still unavailable.
"""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, is_dataclass
from typing import Any

from platform_v8.protocol.media_profile import MediaInput, OfficialMediaProfile

MEDIA_TASKS = {"image_generate": "image", "video_generate": "video"}
DEVICE_BINDINGS_KEY = "media:device-bindings:v1"


class MediaProfileError(ValueError):
    pass


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()


def official_profiles(settings: dict[str, Any]) -> list[OfficialMediaProfile]:
    raw = settings.get("media_profiles", [])
    if not isinstance(raw, list) or len(raw) > 500:
        raise MediaProfileError("quote_unavailable: 官方媒体 profile 目录无效")
    try:
        profiles = [OfficialMediaProfile.model_validate(row) for row in raw]
        keys = [(p.profile_id, p.profile_version) for p in profiles]
        if len(keys) != len(set(keys)):
            raise ValueError("重复 profile 版本")
        return profiles
    except (ValueError, TypeError) as exc:
        raise MediaProfileError("quote_unavailable: 官方媒体 profile 目录校验失败") from exc


def validate_profile_update(previous: dict[str, Any], updated: dict[str, Any]) -> None:
    """An existing version may be disabled, but its execution/rate terms are immutable."""
    old = {(p.profile_id, p.profile_version): p for p in official_profiles(previous)}
    new = {(p.profile_id, p.profile_version): p for p in official_profiles(updated)}
    for key, profile in old.items():
        if key not in new:
            raise MediaProfileError("不能删除既有媒体 profile 版本；可禁用，参数变化须新版本")
        before = profile.model_dump(mode="json", exclude={"enabled"})
        after = new[key].model_dump(mode="json", exclude={"enabled"})
        if before != after:
            raise MediaProfileError("媒体 profile 版本不可改写；参数或费率变化须新版本")


def is_media(value: Any) -> bool:
    if isinstance(value, dict):
        return value.get("task_type") in MEDIA_TASKS or value.get("media_input") is not None
    spec = getattr(value, "spec", value)
    return getattr(spec, "task_type", "") in MEDIA_TASKS or getattr(spec, "media_input", None) is not None


def canonical_media_plan(spec: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any] | None:
    """Resolve all executable/pricing terms from one official profile version."""
    task_type = spec.get("task_type")
    raw = spec.get("media_input")
    if not is_media(spec):
        return None
    if task_type not in MEDIA_TASKS or raw is None:
        raise MediaProfileError("quote_unavailable: 媒体生成必须提供受支持的 media_input 和官方 profile")
    try:
        media = MediaInput.model_validate(raw)
    except ValueError as exc:
        raise MediaProfileError("media_input 参数或输入角色无效") from exc
    if media.capability != MEDIA_TASKS[task_type]:
        raise MediaProfileError("media_input capability 与 task_type 不匹配")
    # Never let the legacy fields carry hidden attachments, bytes or a second
    # prompt/seconds/steps contract beside the canonical media input.
    if (spec.get("input_ref") or spec.get("input_refs") or spec.get("inline_input")
            or spec.get("params") or spec.get("code_url")
            or spec.get("input_kind") not in {"", "params_only"}
            or spec.get("redundancy_factor", 1) != 1):
        raise MediaProfileError("媒体生成仅接受 media_input 元数据，禁止旧输入、params/code_url 或冗余出片")
    profile = next((p for p in official_profiles(settings)
                    if p.profile_id == media.profile_id and p.profile_version == media.profile_version), None)
    if profile is None or not profile.enabled:
        raise MediaProfileError("quote_unavailable: 官方媒体 profile 未配置或未启用")
    for field in ("capability", "mode", "quality", "orientation"):
        if getattr(media, field) != getattr(profile, field):
            raise MediaProfileError(f"media_input {field} 不受所选官方 profile 支持")
    if media.seconds is not None and media.seconds not in profile.allowed_seconds:
        raise MediaProfileError("media_input seconds 超出官方 profile 已验证时长")
    if len(media.assets) > profile.max_assets or not set(a.role for a in media.assets).issubset(profile.input_roles):
        raise MediaProfileError("media_input 图片数量或角色超出官方 profile 上限")
    assets = sorted((a.model_dump(mode="json") for a in media.assets), key=lambda a: (a["role"], a["asset_id"]))
    plan = profile.model_dump(mode="json", exclude={"enabled", "allowed_seconds", "unit_price_yuan", "min_charge_yuan"})
    plan.update(seconds=media.seconds, asset_manifest_sha256=digest(assets),
                units=media.seconds if media.capability == "video" else 1)
    plan["plan_sha256"] = digest(plan)
    return plan


def require_formal_media_channel(spec: Any, *, session=None, account_id=None) -> None:
    """Configured identities + live signed preflight + trusted supply, or deny."""
    if is_media(spec):
        from platform_v8.services.media_channel import GatewayClient, require_channel
        try:
            GatewayClient()
            return require_channel(spec, session=session, account_id=account_id)
        except MediaProfileError:
            raise
        except Exception:
            raise MediaProfileError("quote_unavailable: 正式媒体控制、资质或账本接入不可验证") from None


def load_device_bindings(session=None) -> list[dict[str, Any]]:
    """Read operator-verified device/owner policy; absence and malformed data deny."""
    if session is None:
        from platform_v8.storage.db import session_scope
        with session_scope() as current:
            return load_device_bindings(current)
    from sqlalchemy import select
    from platform_v8.storage.repo import kv_t
    row = session.execute(select(kv_t).where(kv_t.c.k == DEVICE_BINDINGS_KEY)).one_or_none()
    raw = row.v if row else []
    if isinstance(raw, str):
        raw = json.loads(raw)
    if not isinstance(raw, list) or len(raw) > 10000 or any(not isinstance(item, dict) for item in raw):
        raise MediaProfileError("媒体设备绑定无效")
    return raw


def _caps(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if is_dataclass(value):
        return asdict(value)
    return vars(value)


def worker_matches_media_plan(worker: Any, plan: dict[str, Any], *,
                              bindings: list[dict[str, Any]], now: int | None = None) -> bool:
    """GPU name alone grants nothing: exact verified profile and current capacity."""
    current = int(time.time()) if now is None else now
    try:
        cap = _caps(worker.capabilities)
        # Official task metadata is persisted by submit, not a worker claim.
        checked = dict(plan)
        supplied_digest = checked.pop("plan_sha256")
        if supplied_digest != digest(checked):
            return False
        identity = {key: plan[key] for key in ("profile_id", "profile_version", "model_sha256",
                                               "workflow_sha256", "validation_receipt_sha256")}
        advertisements = cap.get("media_profiles") or []
        if not isinstance(advertisements, list) or not any(
            isinstance(p, dict) and all(p.get(k) == v for k, v in identity.items()) for p in advertisements
        ):
            return False
        memory_mb = int(cap.get("total_memory_mb") or float(cap.get("memory_gb") or 0) * 1024)
        if (int(cap.get("gpu_count") or 0) < 1 or memory_mb < plan["min_memory_mb"]
                or cap.get("review_only") is True
                or int(cap.get("vram_mb") or 0) < max(8192, plan["min_vram_mb"])
                or int(cap.get("free_vram_mb") or 0) < plan["min_vram_mb"]
                or cap.get("contribute_mode") not in {"active", "throttled"}
                or int(cap.get("throttle_pct") or 0) <= 0):
            return False
        for binding in bindings:
            if (binding.get("worker_id") != str(worker.id) or binding.get("owner_id") != worker.owner_id
                    or binding.get("enabled") is not True
                    or any(binding.get(k) != v for k, v in identity.items())
                    or binding.get("gpu_model") != cap.get("gpu_model")
                    or binding.get("vram_mb") != cap.get("vram_mb")):
                continue
            # RTX 4060 is the minimum intended cohort. A verified hardware
            # qualification receipt is required; model-name string ordering
            # cannot prove performance, memory, quantization or workflow support.
            qualification = binding.get("hardware_qualification")
            if qualification != "rtx_4060_or_better_verified":
                continue
            p90 = binding.get("p90_execution_seconds")
            parallel = binding.get("max_concurrent")
            if type(p90) is not int or not 1 <= p90 <= plan["timeout_s"]:
                continue
            if type(parallel) is not int or parallel != 1:
                continue  # first GPU cohort is one execution slot
            needed = p90 + 45
            if (int(worker.active_shards or 0) >= min(parallel, int(cap.get("max_media_concurrent") or 0))
                    or int(binding.get("max_task_seconds") or 0) < plan["timeout_s"]
                    or int(cap.get("media_available_seconds") or 0) < needed
                    or int(binding.get("authorized_until") or 0) - current < needed
                    or int(binding.get("verified_until") or 0) <= current):
                continue
            return True
        return False
    except (ValueError, TypeError, KeyError, AttributeError, ArithmeticError):
        return False


def filter_media_workers(workers: list[Any], workload: Any, *, bindings=None) -> list[Any]:
    if not is_media(workload):
        return workers
    plan = getattr(workload.spec, "media_profile", None)
    if not isinstance(plan, dict) or not plan:
        return []
    try:
        # Re-read current official terms; stored or hand-built plan metadata
        # cannot admit a disabled or changed official profile.
        from platform_v8.services.economy.task_pricing import _load_settings
        from platform_v8.storage.db import session_scope
        with session_scope() as session:
            expected = canonical_media_plan(asdict(workload.spec), _load_settings(session))
            verified = load_device_bindings(session) if bindings is None else bindings
        if expected != plan:
            return []
        return [w for w in workers if worker_matches_media_plan(w, plan, bindings=verified)]
    except Exception:
        return []  # all dispatch entry points must fail closed on policy errors
