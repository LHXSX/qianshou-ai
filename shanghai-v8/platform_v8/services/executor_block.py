"""QS-18 阶段① · 结果侧 `executor` 块（契约 contracts/v1/result.schema.json · `executor` 节）。

只做加法：从已落库事实推"谁算的"——分片的 worker、节点产出里的 `compute_provenance`、
平台自己登记的 `compute_origin=platform_relay` 且产出带官方脚本 `summary.endpoints`、
能力注册表（contracts/v1/capabilities.registry.json 的部署副本）。任何一项推不出就返回 None，
调用方不写该块；**绝不默认 `node`**（契约原文：缺失 = 执行者未知）。
纯文字回帧仍是执行者未知。

这是生产代码第一次读契约：注册表路径 = 环境变量 V8_CONTRACTS_DIR，默认 <repo>/contracts/v1。
注册表缺失 → 每进程 ERROR 一次，所有节点执行的块都不产出（平台代调块不依赖注册表）。

阶段②（缺 executor 拒绝入账）不在本模块；本模块不改任何控制流。
"""
from __future__ import annotations

import json
import logging
import os
import threading
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Iterable

logger = logging.getLogger(__name__)

CONTRACTS_DIR_ENV = "V8_CONTRACTS_DIR"
_DEFAULT_CONTRACTS_DIR = Path(__file__).resolve().parents[2] / "contracts" / "v1"

# 与 scripts/tasks/llm_chat.py 的 COMPUTE_ORIGIN_PLATFORM_RELAY 同值（节点产出里写的原文）。
PLATFORM_RELAY_ORIGIN = "platform_relay"
# 平台代调时的执行者身份 —— 与本仓 contracts/tests/contract.spec.ts golden 4b 逐字一致。
PLATFORM_LLM_EXECUTOR: dict[str, Any] = {
    "kind": "platform",
    "worker_id": "platform-llm-gateway",
    "worker_name": "platform llm gateway",
    "capability": "llm.generate.local",
    "impl": {"runtime": "platform-llm-gateway"},
}
_PLATFORM_ACCOUNT_ENV = "V8_PLATFORM_ACCOUNT_ID"   # 与 services/proxy/gateway.py 同名同默认值

_skips: Counter[str] = Counter()
_skips_lock = threading.Lock()


def contracts_dir() -> Path:
    """注册表所在目录（V8_CONTRACTS_DIR 或 <repo>/contracts/v1）。"""
    configured = os.environ.get(CONTRACTS_DIR_ENV, "").strip()
    return Path(configured) if configured else _DEFAULT_CONTRACTS_DIR


def _normalize(name: object) -> str:
    # 注册表 alias_normalization：小写、连字符→下划线（faster-whisper == faster_whisper）。
    return str(name or "").strip().lower().replace("-", "_")


@lru_cache(maxsize=1)
def _registry() -> dict[str, Any] | None:
    path = contracts_dir() / "capabilities.registry.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        logger.error("capability registry missing at %s · node executor blocks disabled", path)
        return None
    except Exception:
        logger.error("capability registry unreadable at %s", path, exc_info=True)
        return None
    legacy: dict[str, str] = {}
    impls: dict[str, list[dict[str, Any]]] = {}
    legacy_by_cap: dict[str, list[str]] = {}
    for cap in data.get("capabilities") or []:
        name = cap.get("capability")
        if not name:
            continue
        legacy_by_cap[str(name)] = [str(t) for t in (cap.get("legacy_task_types") or [])]
        for task_type in legacy_by_cap[str(name)]:
            legacy[task_type] = str(name)
        entries = []
        for impl in cap.get("implementations") or []:
            runtime = impl.get("impl")
            if not runtime:
                continue
            names = {_normalize(runtime)}
            names.update(_normalize(n) for n in (impl.get("package_names") or []))
            names.update(_normalize(n) for n in (impl.get("aliases") or []))
            role = impl.get("role")
            entries.append({
                "runtime": str(runtime),
                "names": names,
                "role": str(role).strip() if isinstance(role, str) and role.strip() else None,
            })
        impls[str(name)] = entries
    logger.info("capability registry loaded · version=%s · %d capabilities · %d legacy task types",
                data.get("registry_version"), len(impls), len(legacy))
    return {"version": data.get("registry_version"), "legacy": legacy, "impls": impls,
            "legacy_by_cap": legacy_by_cap}


def registry_version() -> str | None:
    """已装载注册表的 registry_version；未装载/缺失 → None。"""
    reg = _registry()
    return None if reg is None else str(reg.get("version"))


def capability_entry(capability: str) -> dict[str, Any] | None:
    """注册表里一个能力的目录信息：{capability, implementations[], legacy_task_types[]}；不在目录 → None。"""
    reg = _registry()
    if reg is None or capability not in reg["impls"]:
        return None
    return {
        "capability": capability,
        "implementations": [e["runtime"] for e in reg["impls"][capability]],
        "legacy_task_types": list(reg["legacy_by_cap"].get(capability, [])),
    }


def capability_names() -> list[str]:
    """注册表里全部能力名（排序）；注册表缺失 → []。"""
    reg = _registry()
    return sorted(reg["impls"]) if reg else []


def normalize_software_names(names: Iterable[object]) -> set[str]:
    """节点广告软件名 → 归一化集合（与注册表 alias_normalization 同规则）。"""
    return {_normalize(n) for n in names if isinstance(n, str) and n.strip()}


def declared_implementation(capability: str, advertised: set[str]) -> str | None:
    """节点**明确广告**了该能力的哪个实现（严格取交集，不做单实现兜底）；没有 → None。"""
    reg = _registry()
    if reg is None:
        return None
    for entry in reg["impls"].get(capability, []):
        if entry["names"] & advertised:
            return str(entry["runtime"])
    return None


def implementation_software_names(capability: str) -> set[str]:
    """该能力全部实现的包名/别名（归一化）。注册表缺失 → 空集。"""
    reg = _registry()
    names: set[str] = set()
    if reg is None:
        return names
    for entry in reg["impls"].get(capability) or []:
        names |= set(entry["names"])
    return names


def capability_satisfied(capability: str, advertised: set[str]) -> bool:
    """节点是否满足该能力：同一 role 内 OR，不同 role 之间 AND；全无 role 则全体 OR。"""
    reg = _registry()
    if reg is None:
        return False
    entries = reg["impls"].get(capability) or []
    if not entries:
        return False

    def _hit(group: list[dict[str, Any]]) -> bool:
        return any(entry["names"] & advertised for entry in group)

    by_role: dict[str, list[dict[str, Any]]] = {}
    unroled: list[dict[str, Any]] = []
    for entry in entries:
        role = entry.get("role")
        if role:
            by_role.setdefault(str(role), []).append(entry)
        else:
            unroled.append(entry)
    if by_role:
        return all(_hit(group) for group in by_role.values())
    return _hit(unroled)


def _skip(reason: str) -> None:
    with _skips_lock:
        _skips[reason] += 1
        first = _skips[reason] == 1
    # 首次 INFO、之后 DEBUG：既不静默也不刷日志；累计值走 executor_block_skips()。
    (logger.info if first else logger.debug)("executor block skipped · reason=%s", reason)


def executor_block_skips() -> dict[str, int]:
    """每个"没产出 executor 块"的原因的累计次数（进程内）。"""
    with _skips_lock:
        return dict(_skips)


def _parse_json_object(raw: object) -> dict[str, Any] | None:
    text = str(raw or "").strip()
    if not text.startswith("{"):
        return None
    try:
        data = json.loads(text)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _platform_relay_provenance(output: object) -> dict[str, Any] | None:
    data = _parse_json_object(output)
    if data is None:
        return None
    summary = data.get("summary")
    prov = (summary.get("compute_provenance") if isinstance(summary, dict) else None) \
        or data.get("compute_provenance")
    if isinstance(prov, dict) and prov.get("compute_origin") == PLATFORM_RELAY_ORIGIN:
        return prov
    return None


def _looks_like_relay_output(output: object) -> bool:
    data = _parse_json_object(output)
    summary = data.get("summary") if data else None
    return isinstance(summary, dict) and "endpoints" in summary


def _platform_declared_relay(task_type: str) -> bool:
    """平台自己登记的代调类型。读不到 task_registry 时只认 `llm_chat`。"""
    name = str(task_type or "")
    try:
        from platform_v8.engine.task_registry import compute_origin_of
        return compute_origin_of(name) == PLATFORM_RELAY_ORIGIN
    except Exception:
        # Smoke and Host copies do not import the Shanghai task registry.
        return name == "llm_chat"


def _platform_executor_block() -> dict[str, Any]:
    """Golden 4b platform identity. The forwarding node is never the executor."""
    block = dict(PLATFORM_LLM_EXECUTOR)
    block["impl"] = dict(PLATFORM_LLM_EXECUTOR["impl"])
    block["owner_id"] = os.environ.get(_PLATFORM_ACCOUNT_ENV, "1").strip() or "1"
    return block


def _advertised_software(worker: Any) -> set[str]:
    caps = getattr(worker, "capabilities", None)
    names: set[str] = set()
    for attr in ("software", "native_binaries", "installed_software", "runtime_tiers", "runtimes"):
        values = getattr(caps, attr, None)
        if isinstance(values, (list, tuple, set)):
            names.update(_normalize(v) for v in values if isinstance(v, str))
    return names


def _match_impl(entries: list[dict[str, Any]], worker: Any) -> str | None:
    if not entries:
        return None
    advertised = _advertised_software(worker)
    for entry in entries:
        if entry["names"] & advertised:
            return str(entry["runtime"])
    # 注册表只登记了一种实现时，派单门(required_software)已保证节点具备它。
    return str(entries[0]["runtime"]) if len(entries) == 1 else None


def _status_name(status: object) -> str:
    return str(getattr(status, "value", status) or "").upper()


def build_shard_executor(
    task_type: str,
    shard: Any,
    load_worker: Callable[[str], Any],
) -> dict[str, Any] | None:
    """一个分片的 executor 块；推不出 → None（并计数原因）。绝不抛出。"""
    try:
        if _status_name(getattr(shard, "status", None)) != "DONE":
            _skip("shard_not_done")
            return None
        worker_id = getattr(shard, "worker_id", None)
        if not worker_id:
            _skip("shard_without_worker")
            return None
        output = getattr(shard, "output_ref", None)
        if _platform_relay_provenance(output) is not None:
            return _platform_executor_block()
        # 平台自己登记的代调类型：官方脚本写下 summary.endpoints 就是它打了云端 LLM。
        # 旧脚本没写 compute_provenance；等节点改脚本会让历史任务永远缺块。
        if _platform_declared_relay(task_type) and _looks_like_relay_output(output):
            return _platform_executor_block()
        reg = _registry()
        if reg is None:
            _skip("registry_unavailable")
            return None
        capability = reg["legacy"].get(str(task_type or ""))
        if capability is None:
            # 未登记类型：有 endpoints 也不是平台代调登记（例如伪造字段）；与纯文字分开计数。
            if _looks_like_relay_output(output):
                _skip(f"provenance_missing:{task_type or '?'}")
            else:
                _skip(f"unmapped:{task_type or '?'}")
            return None
        worker = load_worker(str(worker_id))
        if worker is None:
            _skip("worker_missing")
            return None
        runtime = _match_impl(reg["impls"].get(capability, []), worker)
        if runtime is None:
            _skip(f"impl_unknown:{capability}")
            return None
        return {
            "kind": "node",
            "worker_id": str(worker_id),
            "worker_name": str(getattr(worker, "name", "") or ""),
            "owner_id": str(getattr(worker, "owner_id", "")),
            "capability": capability,
            "impl": {"runtime": runtime},
        }
    except Exception:
        _skip("error")
        logger.error("executor block failed · task_type=%s", task_type, exc_info=True)
        return None


def build_executor_blocks(
    task_type: str,
    shards: Iterable[Any],
    load_worker: Callable[[str], Any],
) -> tuple[dict[str, Any] | None, dict[int, dict[str, Any]]]:
    """(workload 级块, {shard.index: 分片块})。
    workload 级只在所有分片块指向同一 (kind, worker_id) 时给出，否则 None（计 `multi_executor`）。"""
    cache: dict[str, Any] = {}

    def cached(worker_id: str) -> Any:
        if worker_id not in cache:
            cache[worker_id] = load_worker(worker_id)
        return cache[worker_id]

    per_shard: dict[int, dict[str, Any]] = {}
    shard_list = list(shards)
    for shard in shard_list:
        block = build_shard_executor(task_type, shard, cached)
        if block is not None:
            per_shard[int(getattr(shard, "index", 0) or 0)] = block
    if not per_shard:
        return None, per_shard
    if len(per_shard) != len(shard_list):
        _skip("partial_shards")
        return None, per_shard
    identities = {(b["kind"], b["worker_id"]) for b in per_shard.values()}
    if len(identities) != 1:
        _skip("multi_executor")
        return None, per_shard
    return dict(next(iter(per_shard.values()))), per_shard
