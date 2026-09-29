"""Workload 任务计价（报价 / estimate / submit 共用）

闭环策略 (2026-08-10):
  - 普通账号: escrow 强制使用服务端价 server_price（忽略客户端低报）
  - 特殊价:
      * admin → 信任客户端 budget
      * account.profile.honor_client_budget=true → 信任客户端 budget（商务合同）
      * account.profile.task_price_overrides={task_type: base_price} → 改单价
      * account.profile.workload_discount_pct=0..100 → 在服务端价上打折
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from platform_v8.storage.repo import AccountRepo

logger = logging.getLogger(__name__)

_FALLBACK_BASE_PRICE = Decimal("0.5")
_FALLBACK_MIN_CHARGE = Decimal("0.10")


@dataclass(frozen=True)
class TaskPriceQuote:
    total_yuan: Decimal
    units: int
    shards: int
    task_type: str
    base_price: Decimal
    min_charge: Decimal
    price_basis: str
    discount_pct: Decimal = Decimal("0")
    settings_version: int = 0
    profile_id: str = ""
    profile_version: int = 0
    price_version: int = 0
    seconds: int | None = None
    asset_manifest_sha256: str = ""
    plan_sha256: str = ""


def estimate_units_shards(spec: dict[str, Any]) -> tuple[int, int]:
    task_type = str(spec.get("task_type") or "").strip()
    input_kind = str(spec.get("input_kind") or "").strip()
    input_refs = spec.get("input_refs") or []
    if not isinstance(input_refs, list):
        input_refs = []

    if task_type in {"image_generate", "video_generate"}:
        # A missing official profile is never a guessed fixed-duration quote.
        plan = spec.get("media_profile") or {}
        units = plan.get("units")
        if type(units) is not int or units < 1:
            raise ValueError("quote_unavailable: 媒体生成尚未解析官方执行 profile")
        return units, 1
    elif input_kind == "multi_file":
        units = max(1, len(input_refs))
    else:
        units = 1

    try:
        max_shards = int(spec.get("max_shards") or 1)
    except (TypeError, ValueError):
        max_shards = 1
    max_shards = max(1, max_shards)
    shards = max(1, min(max_shards, units))
    return units, shards


def _load_settings(session: Session) -> dict[str, Any]:
    # lazy: 避免 services ↔ api 环依赖在 import 期炸
    from platform_v8.api.v8.economy import _load_settings as _ls

    return _ls(session)


def _account_profile(session: Session, account_id: int | None) -> dict[str, Any]:
    if not account_id:
        return {}
    acc = AccountRepo.by_id(session, account_id)
    if acc is None:
        return {}
    return acc.profile if isinstance(acc.profile, dict) else {}


def honor_client_budget(
    session: Session,
    *,
    account_id: int,
    is_admin: bool = False,
) -> bool:
    """特殊价通道: admin 或 profile.honor_client_budget。"""
    if is_admin:
        return True
    profile = _account_profile(session, account_id)
    flag = profile.get("honor_client_budget")
    return flag is True or str(flag).strip().lower() in {"1", "true", "yes", "on"}


def compute_price_for_spec(
    session: Session,
    spec: dict[str, Any],
    *,
    account_id: int | None = None,
) -> TaskPriceQuote:
    """按 task_pricing (+ 账号覆盖/折扣) 计算服务端价。"""
    task_type = str(spec.get("task_type") or "").strip()
    if not task_type:
        raise ValueError("spec.task_type 不能为空")

    settings = _load_settings(session)
    from platform_v8.services.media_profiles import canonical_media_plan
    media_plan = canonical_media_plan(spec, settings)
    if media_plan is not None:
        from platform_v8.services.media_profiles import official_profiles
        profile = next(p for p in official_profiles(settings)
                       if (p.profile_id, p.profile_version) ==
                       (media_plan["profile_id"], media_plan["profile_version"]))
        total = max(profile.min_charge_yuan, Decimal(media_plan["units"]) * profile.unit_price_yuan)
        return TaskPriceQuote(
            total_yuan=total.quantize(Decimal("0.01")), units=media_plan["units"], shards=1,
            task_type=task_type, base_price=profile.unit_price_yuan, min_charge=profile.min_charge_yuan,
            price_basis=f"official_media_profile[{profile.profile_id}@{profile.profile_version}]",
            settings_version=int(settings.get("version", 0) or 0),
            profile_id=profile.profile_id, profile_version=profile.profile_version,
            price_version=profile.price_version, seconds=media_plan["seconds"],
            asset_manifest_sha256=media_plan["asset_manifest_sha256"], plan_sha256=media_plan["plan_sha256"],
        )
    pricing_rows = settings.get("task_pricing") or []
    matches = [r for r in pricing_rows if isinstance(r, dict) and r.get("task_type") == task_type]
    if len(matches) > 1:
        raise ValueError("人民币任务价目重复")
    row = matches[0] if matches else None
    from platform_v8.engine.task_registry import TASK_REGISTRY
    from platform_v8.services.economy.reviewed_adapter_tariffs import resolve_tariff
    reviewed_spec = TASK_REGISTRY.get(task_type)
    reviewed = bool(reviewed_spec and reviewed_spec.requires_verified_adapter)
    official = bool(reviewed_spec and getattr(reviewed_spec, "official_provider_id", ""))
    tariff = None
    if row is None and reviewed:
        tariff = resolve_tariff(settings, reviewed_spec)
        row = tariff
    if reviewed and row is None:
        raise ValueError("已审核任务缺少人民币价目，不能报价")
    if official and row is None:
        raise ValueError("官方能力缺少人民币价目，不能报价")

    profile = _account_profile(session, account_id)
    overrides = profile.get("task_price_overrides") or {}
    if not isinstance(overrides, dict):
        overrides = {}

    if not official and task_type in overrides and overrides[task_type] is not None:
        base_price = Decimal(str(overrides[task_type]))
        min_charge = Decimal(str(row.get("min_charge", _FALLBACK_MIN_CHARGE))) if row else _FALLBACK_MIN_CHARGE
        price_basis = f"profile.override[{task_type}]"
    elif row is not None:
        base_price = Decimal(str(row.get("base_price", 0)))
        min_charge = Decimal(str(row.get("min_charge", 0)))
        price_basis = (f"reviewed_adapter_tariff[{row['result_strategy']}]·v{int(settings.get('version', 0))}"
                       if tariff is not None else
                       f"task_pricing[{task_type}]·v{int(settings.get('version', 0))}")
    else:
        base_price = _FALLBACK_BASE_PRICE
        min_charge = _FALLBACK_MIN_CHARGE
        price_basis = "default(未配置定价·兜底单价)"

    units, shards = estimate_units_shards(spec)
    # Reviewed one-shot adapters have a declared CNY service price. Generic
    # speed/quality multipliers would make @ quote differ from that price.
    speed_factor = (Decimal("1") if reviewed or official else
                    Decimal(str(settings.get("speed_t24", 1.0))))
    quality_factor = (Decimal("1") if reviewed or official else
                      Decimal(str(settings.get("quality_standard", 1.0))))

    base_yuan = (Decimal(units) * base_price).quantize(Decimal("0.0001"))
    pre_min_total = (base_yuan * speed_factor * quality_factor).quantize(Decimal("0.0001"))
    total_yuan = max(min_charge, pre_min_total).quantize(Decimal("0.01"))
    if official and (not total_yuan.is_finite() or total_yuan <= 0):
        raise ValueError("官方能力人民币价目必须为正数")

    try:
        discount_pct = Decimal(str(profile.get("workload_discount_pct", 0) or 0))
    except Exception:
        discount_pct = Decimal("0")
    if discount_pct < 0:
        discount_pct = Decimal("0")
    if discount_pct > 100:
        discount_pct = Decimal("100")
    if discount_pct > 0:
        total_yuan = (total_yuan * (Decimal("100") - discount_pct) / Decimal("100")).quantize(
            Decimal("0.01")
        )
        # 打折后仍不低于 0；允许合同价低于 min_charge
        price_basis = f"{price_basis}+discount {discount_pct}%"

    return TaskPriceQuote(
        total_yuan=total_yuan,
        units=units,
        shards=shards,
        task_type=task_type,
        base_price=base_price,
        min_charge=min_charge,
        price_basis=price_basis,
        discount_pct=discount_pct,
        settings_version=int(settings.get("version", 0) or 0),
    )


def resolve_effective_budget(
    session: Session,
    *,
    spec: dict[str, Any],
    client_budget: Decimal,
    account_id: int,
    is_admin: bool = False,
) -> tuple[Decimal, TaskPriceQuote, str]:
    """返回 (effective_budget, quote, mode).

    mode:
      - server_price: 普通账号强制服务端价
      - client_budget: admin / honor_client_budget 特殊通道
    """
    quote = compute_price_for_spec(session, spec, account_id=account_id)
    if honor_client_budget(session, account_id=account_id, is_admin=is_admin):
        return Decimal(client_budget), quote, "client_budget"
    return quote.total_yuan, quote, "server_price"
