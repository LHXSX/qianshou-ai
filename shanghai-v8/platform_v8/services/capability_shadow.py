"""换血阶段① · 派单双路径影子对照。

旧路径（`planner._filter_by_requirements` 的 `required_software.issubset`）照常决定
谁能接活。本模块用 `contracts/v1/capabilities.registry.json` 再算一遍语义匹配：
实现按注册表 `role`（同 role OR、跨 role AND；无 role 则全体 OR），再加上
`required_software` 里不属于该能力实现名的伴随包（AND）。差集记 `we_audit`。

HX-06：语义路径与 relax 同时认 `provided_capabilities` 里的**契约**名（健康态）。
不改 `engine/capabilities.py` 那份 29 个 MVP 名，不改 isubset。
回滚 = 还原本文件（或 `V8_CAPABILITY_SHADOW=0`）。
"""
from __future__ import annotations

import json
import logging
import os
import threading
from collections import Counter
from functools import lru_cache
from typing import Any, Callable, Iterable

from platform_v8.services.executor_block import (
    capability_entry,
    capability_names,
    capability_satisfied,
    contracts_dir,
    implementation_software_names,
    normalize_software_names,
    registry_version,
)

logger = logging.getLogger(__name__)

SHADOW_ENV = "V8_CAPABILITY_SHADOW"
AUDIT_ACTION = "planner.capability_shadow"
_ID_CAP = 32
_ADVERTISED_ATTRS = (
    "software",
    "native_binaries",
    "installed_software",
    "runtime_tiers",
    "runtimes",
)
_HEALTHY_ADS = frozenset({"healthy", "ok", "ready", "loaded", "available", "warm", ""})
_UNHEALTHY_ADS = frozenset({"quarantined", "revoked", "disabled"})

_counts: Counter[str] = Counter()
_counts_lock = threading.Lock()


def shadow_enabled() -> bool:
    raw = os.environ.get(SHADOW_ENV, "").strip().lower()
    if raw in ("0", "false", "off", "no", "disabled"):
        return False
    return True


def capability_shadow_counts() -> dict[str, int]:
    with _counts_lock:
        return dict(_counts)


def capability_for_task_type(task_type: str) -> str | None:
    """契约注册表：旧 task_type → 语义能力名；未登记 → None。"""
    if not task_type:
        return None
    for name in capability_names():
        entry = capability_entry(name)
        if entry and task_type in entry["legacy_task_types"]:
            return name
    return None


def advertised_software(worker: Any) -> set[str]:
    cap = getattr(worker, "capabilities", None)
    if cap is None and isinstance(worker, dict):
        cap = worker.get("capabilities")
    names: list[object] = []
    raw: dict[str, Any] = {}
    if isinstance(cap, dict):
        raw = cap
    elif cap is not None:
        for attr in _ADVERTISED_ATTRS:
            val = getattr(cap, attr, None)
            if isinstance(val, (list, tuple, set)):
                names.extend(val)
        extra = getattr(cap, "__dict__", None)
        if isinstance(extra, dict):
            raw = extra
    for attr in _ADVERTISED_ATTRS:
        val = raw.get(attr) if raw else None
        if isinstance(val, (list, tuple, set)):
            names.extend(val)
    return normalize_software_names(names)


def _capabilities_raw(worker: Any) -> dict[str, Any]:
    cap = getattr(worker, "capabilities", None)
    if cap is None and isinstance(worker, dict):
        cap = worker.get("capabilities")
    if isinstance(cap, dict):
        return cap
    extra = getattr(cap, "__dict__", None)
    return extra if isinstance(extra, dict) else {}


def advertised_capabilities(worker: Any) -> set[str]:
    """`provided_capabilities` 里、且落在契约注册表的健康语义名。

    不认 `engine/capabilities.py` 的 29 个 MVP 名，也不认裸 task_type 字符串。
    """
    known = set(capability_names())
    if not known:
        return set()
    raw = _capabilities_raw(worker)
    provided = raw.get("provided_capabilities")
    if provided is None:
        cap = getattr(worker, "capabilities", None)
        provided = getattr(cap, "provided_capabilities", None)
    if not isinstance(provided, (list, tuple)):
        return set()
    names: set[str] = set()
    for item in provided:
        if isinstance(item, str):
            name, health = item.strip(), "ok"
        elif isinstance(item, dict):
            name = str(item.get("name") or "").strip()
            health = str(item.get("health") or "ok").strip().lower()
        else:
            continue
        if name not in known or health in _UNHEALTHY_ADS:
            continue
        if health in _HEALTHY_ADS:
            names.add(name)
    return names


def _capability_proven(capability: str, worker: Any, advertised: set[str]) -> bool:
    """软件实现命中，或节点用契约名健康广告了该能力。"""
    if capability in advertised_capabilities(worker):
        return True
    return capability_satisfied(capability, advertised)


def _worker_id(worker: Any) -> str:
    if isinstance(worker, dict):
        value = worker.get("id")
    else:
        value = getattr(worker, "id", None)
    return str(value or "")


def _ids(workers: Iterable[Any]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for worker in workers:
        wid = _worker_id(worker)
        if not wid or wid in seen:
            continue
        seen.add(wid)
        out.append(wid)
    out.sort()
    return out


def _clip(ids: list[str]) -> tuple[list[str], bool]:
    if len(ids) <= _ID_CAP:
        return ids, False
    return ids[:_ID_CAP], True


def _required_software(task_type: str) -> set[str]:
    try:
        from platform_v8.engine.task_registry import get_spec
        spec = get_spec(task_type)
    except Exception:
        return set()
    if spec is None:
        return set()
    return normalize_software_names(getattr(spec, "required_software", None) or ())


def _semantic_hit(capability: str, worker: Any, companions: set[str]) -> bool:
    advertised = advertised_software(worker)
    if not _capability_proven(capability, worker, advertised):
        return False
    return companions.issubset(advertised)


def relax_required_software(task_type: str, worker: Any, needed: set[str]) -> set[str]:
    """节点已按注册表满足该任务的语义能力时，从 required_software 拿掉实现名，留下伴随包。

    能力可由软件实现或 `provided_capabilities` 契约名证明。只做减法。不改 isubset。
    """
    remaining = set(needed)
    capability = capability_for_task_type(task_type)
    if not capability or not remaining:
        return remaining
    advertised = advertised_software(worker)
    if not _capability_proven(capability, worker, advertised):
        return remaining
    impls = implementation_software_names(capability)
    if not impls:
        return remaining
    kept: set[str] = set()
    for name in remaining:
        norm = normalize_software_names([name])
        if norm and norm <= impls:
            continue
        kept.add(name)
    return kept



HELLO_UNION_GATE_ENV = "V8_HELLO_UNION_GATE"
_HELLO_UNION_IMPL_KIND = "host-runner"


def hello_union_gate_enabled() -> bool:
    raw = os.environ.get(HELLO_UNION_GATE_ENV, "").strip().lower()
    return raw not in ("0", "false", "off", "no", "disabled")


@lru_cache(maxsize=1)
def hello_union_capabilities() -> frozenset[str]:
    """注册表里只能靠 hello `provided_capabilities` 证明的能力。

    判据：该能力全部实现都是 kind=host-runner 且没有 package_names，
    与本仓 packages/host/compute-core/src/host-side-matching.ts 的 `hello-union` 同义；
    registry 1.0 下只有 text.transform。注册表缺失或不可读 → 空集，门不生效。
    """
    path = contracts_dir() / "capabilities.registry.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.error("hello_union_capabilities · registry unreadable at %s · gate disabled", path)
        return frozenset()
    names: set[str] = set()
    for cap in data.get("capabilities") or []:
        name = cap.get("capability")
        impls = cap.get("implementations") or []
        if not name or not impls:
            continue
        if all(
            impl.get("kind") == _HELLO_UNION_IMPL_KIND and not (impl.get("package_names") or [])
            for impl in impls
        ):
            names.add(str(name))
    return frozenset(names)


def hello_union_gate(task_type: str, workers: list) -> list:
    """HX-88：hello-union 能力的任务只保留用契约名健康广告了该能力的节点。

    task_type 不落在 hello-union 能力、或 V8_HELLO_UNION_GATE 关闭 → 原列表原样返回。
    不改传入列表。留空时 planner 记「没节点满足」，任务等待，不再退回包名节点。
    """
    if not hello_union_gate_enabled():
        return workers
    capability = capability_for_task_type(task_type)
    if capability is None or capability not in hello_union_capabilities():
        return workers
    kept = [w for w in workers if capability in advertised_capabilities(w)]
    dropped = len(workers) - len(kept)
    if dropped:
        log = logger.warning if not kept else logger.info
        log(
            "planner.hello_union_gate · task=%s cap=%s kept=%d dropped=%d",
            task_type,
            capability,
            len(kept),
            dropped,
        )
    return kept


def compare(task_type: str, pool: Iterable[Any], old_matched: Iterable[Any]) -> dict[str, Any]:
    """对照同一候选池上的旧过滤结果与契约语义匹配。不改传入列表。"""
    pool_list = list(pool)
    old_list = list(old_matched)
    capability = capability_for_task_type(task_type)
    old_set = set(_ids(old_list))
    companions: list[str] = []
    if capability is None:
        semantic_ids: list[str] = []
        relation = "unmapped"
    else:
        companion_set = _required_software(task_type) - implementation_software_names(capability)
        companions = sorted(companion_set)
        semantic_ids = _ids(
            w for w in pool_list if _semantic_hit(capability, w, companion_set)
        )
        sem_set = set(semantic_ids)
        if not old_set and not sem_set:
            relation = "both_empty"
        elif old_set == sem_set:
            relation = "equal"
        elif sem_set > old_set:
            relation = "semantic_wider"
        elif old_set > sem_set:
            relation = "semantic_narrower"
        elif old_set & sem_set:
            relation = "overlap"
        else:
            relation = "disjoint"
    only_old = sorted(old_set - set(semantic_ids))
    only_semantic = sorted(set(semantic_ids) - old_set)
    only_old, trunc_old = _clip(only_old)
    only_semantic, trunc_sem = _clip(only_semantic)
    return {
        "mode": "shadow",
        "task_type": task_type,
        "capability": capability,
        "relation": relation,
        "old_count": len(old_set),
        "semantic_count": len(semantic_ids),
        "pool_count": len(_ids(pool_list)),
        "only_old": only_old,
        "only_semantic": only_semantic,
        "companions": companions,
        "registry_version": registry_version(),
        "truncated": trunc_old or trunc_sem,
    }


def _task_type_of(workload: Any) -> str:
    if isinstance(workload, dict):
        spec = workload.get("spec") or {}
        if isinstance(spec, dict):
            return str(spec.get("task_type") or "")
        return str(workload.get("task_type") or "")
    spec = getattr(workload, "spec", None)
    return str(getattr(spec, "task_type", "") or "")


def _workload_id_of(workload: Any) -> str:
    if isinstance(workload, dict):
        return str(workload.get("id") or "")
    return str(getattr(workload, "id", "") or "")


def _write_audit_default(detail: dict[str, Any], workload_id: str) -> None:
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import AuditRepo

    with db_mod.session_scope() as session:
        AuditRepo.write(
            session,
            action=AUDIT_ACTION,
            actor_kind="system",
            target_kind="workload" if workload_id else None,
            target_id=workload_id or None,
            detail=detail,
        )
        # 2026-09-19 · HX-01 缺这一行：session_scope() 只 close 不 commit，
        # 于是每条影子审计都被静默回滚（we_audit 里 0 条，且无异常无日志）。
        session.commit()


def record_shadow(
    workload: Any,
    pool: Iterable[Any],
    old_matched: Iterable[Any],
    *,
    write_audit: Callable[[dict[str, Any], str], None] | None = None,
) -> dict[str, Any] | None:
    """调度热路径入口。开关关闭 / 任何异常 → None，调用方候选不变。"""
    if not shadow_enabled():
        return None
    task_type = _task_type_of(workload)
    snapshot = compare(task_type, pool, old_matched)
    with _counts_lock:
        _counts[snapshot["relation"]] += 1
        _counts["total"] += 1
    workload_id = _workload_id_of(workload)
    try:
        (write_audit or _write_audit_default)(snapshot, workload_id)
    except Exception:
        logger.error("planner.capability_shadow audit write failed (dispatch continues)", exc_info=True)
    log = logger.info if snapshot["relation"] not in ("equal", "unmapped", "both_empty") else logger.debug
    log(
        "planner.capability_shadow · task=%s cap=%s relation=%s old=%s semantic=%s",
        snapshot["task_type"],
        snapshot["capability"],
        snapshot["relation"],
        snapshot["old_count"],
        snapshot["semantic_count"],
    )
    return snapshot
