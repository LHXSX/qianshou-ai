"""QS-21 · Registry 反查：按语义能力名问"池里谁声明能做"。

纪律（05 册 §3.1）：Registry 只回答"这个能力名，谁能实现"——**不选择、不排序、不派单**。
结论只能到"可以尝试派"，到不了"能派成"。

三态分开说：
  found          —— 目录（contracts/v1/capabilities.registry.json）里有这个名字；没有 → 404，不是空集
  declared       —— 池里有节点**明确广告**了某个已登记实现（软件包名严格交集），
                    或用契约名健康写入了 `provided_capabilities`（impl 记 advertised，不猜是哪个包）
  available_now  —— declared 且 status=ONLINE 且 last_seen 在在线 TTL 内（此刻，读时算）

只读：不写任何表，不碰 GET /api/v8/workers 的响应形状。
普通账号仅查看自己的设备明细；全平台的能力可用性只通过聚合计数展示。
不认 engine/capabilities.py 的 29 个 MVP 名。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session, get_current_account
from platform_v8.core import Account
from platform_v8.engine import registry as registry_mod
from platform_v8.services import capability_shadow as shadow
from platform_v8.services import executor_block
from platform_v8.storage.repo import workers_t

router = APIRouter(prefix="/api/v8/capabilities", tags=["capabilities"])

_MAX_PROVIDES = 500
_ADVERTISED_IMPL = "advertised"


def _not_in_registry(capability: str) -> HTTPException:
    return HTTPException(status_code=404, detail={
        "found": False,
        "capability": capability,
        "reason": "not_in_registry",
        "registry_version": executor_block.registry_version(),
    })


def _utc_naive(dt: datetime | None) -> datetime | None:
    """we_workers.last_seen 可能带 tz；datetime.utcnow() 不带。统一成 naive UTC 再比。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _advertised(caps: Any) -> set[str]:
    if not isinstance(caps, dict):
        return set()
    names: list[object] = []
    for key in ("software", "native_binaries", "installed_software", "runtime_tiers", "runtimes"):
        values = caps.get(key)
        if isinstance(values, list):
            names.extend(values)
    return executor_block.normalize_software_names(names)


def declared_impl(capability: str, caps: Any) -> str | None:
    """软件实现优先；否则契约名健康广告 → `advertised`。MVP 名 / 裸 task_type → None。"""
    impl = executor_block.declared_implementation(capability, _advertised(caps))
    if impl is not None:
        return impl
    if capability in shadow.advertised_capabilities({"capabilities": caps or {}}):
        return _ADVERTISED_IMPL
    return None


@router.get("", summary="能力目录（注册表里有哪些语义能力名）")
def list_capabilities(current: Account = Depends(get_current_account)) -> dict[str, Any]:
    version = executor_block.registry_version()
    if version is None:
        raise HTTPException(status_code=503, detail="capability registry unavailable")
    return {
        "registry_version": version,
        "capabilities": [executor_block.capability_entry(name) for name in executor_block.capability_names()],
    }


@router.get("/{capability}/workers", summary="按语义能力反查：目录里有 / 池里有人声明 / 此刻可用（三态）")
def workers_for_capability(
    capability: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
    include_offline: bool = Query(True, description="provides[] 是否包含此刻不在线的声明者"),
) -> dict[str, Any]:
    name = (capability or "").strip()
    entry = executor_block.capability_entry(name)
    if entry is None:
        raise _not_in_registry(name)

    ttl = int(getattr(registry_mod, "WORKER_ONLINE_TTL_S", 60))
    online_after = datetime.utcnow() - timedelta(seconds=ttl)
    rows = session.execute(select(
        workers_t.c.id, workers_t.c.owner_id, workers_t.c.name, workers_t.c.status,
        workers_t.c.last_seen, workers_t.c.capabilities,
    )).fetchall()

    declared_by_impl: dict[str, int] = {}
    available_by_impl: dict[str, int] = {}
    provides: list[dict[str, Any]] = []
    for row in rows:
        impl = declared_impl(name, row.capabilities)
        if impl is None:
            continue
        declared_by_impl[impl] = declared_by_impl.get(impl, 0) + 1
        status = str(getattr(row.status, "value", row.status) or "").upper()
        seen = _utc_naive(row.last_seen)
        available_now = status == "ONLINE" and seen is not None and seen >= online_after
        if available_now:
            available_by_impl[impl] = available_by_impl.get(impl, 0) + 1
        if not include_offline and not available_now:
            continue
        own_or_admin = current.is_admin or int(row.owner_id) == int(current.id)
        if not own_or_admin:
            # A stable worker ID, name prefix or exact heartbeat time can
            # identify another contributor even if owner_id is replaced by 0.
            continue
        provides.append({
            "worker_id": str(row.id),
            "name": str(row.name or ""),
            "owner_id": int(row.owner_id),
            "status": status,
            "last_seen": row.last_seen.isoformat() if row.last_seen else None,
            "impl": impl,
            "available_now": available_now,
        })

    return {
        "found": True,
        "capability": name,
        "registry_version": executor_block.registry_version(),
        "implementations": entry["implementations"],
        "legacy_task_types": entry["legacy_task_types"],
        "declared": {"count": sum(declared_by_impl.values()), "by_impl": declared_by_impl},
        "available_now": {"count": sum(available_by_impl.values()), "by_impl": available_by_impl,
                          "online_ttl_seconds": ttl},
        "provides": provides[:_MAX_PROVIDES],
        "truncated": len(provides) > _MAX_PROVIDES,
        "note": "registry answers who declares this capability; it does not choose, rank, or dispatch",
    }
