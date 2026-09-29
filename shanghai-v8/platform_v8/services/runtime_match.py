"""RT-B · 运行时能力契约与节点撮合

字段约定（客户端 hello / 商店 we_apps 对齐）:
  - runtime_api: 主契约版本字符串，如 "1.0.0"
  - capabilities / implemented / stubbed / declared: 能力名列表
    · 支持 string[] 或 {name, version}[]
  - dispatch_covered: bool 或 covered 能力列表
  - supported_executors: 含 "plugin.v1" 的执行器列表

撮合:
  1) Runtime 主版本一致（主版本号 int 相等；缺省宽松）
  2) 应用 required ⊆ node.implemented；策略允许时也可 ⊆ (implemented ∪ stubbed)
"""
from __future__ import annotations

import re
from typing import Any, Iterable

# 上架校验用的能力名契约（客户端官方 23 项 · RT-B）
KNOWN_CAPABILITY_NAMES: frozenset[str] = frozenset({
    "doc.pdf.info",
    "doc.pdf.text",
    "doc.pdf.render",
    "doc.ocr",
    "doc.table.extract",
    "vision.image.info",
    "vision.image.transform",
    "vision.image.detect",
    "vision.image.classify",
    "media.probe",
    "media.frames",
    "media.audio.extract",
    "media.transcribe",
    "media.transcode",
    "data.table.read",
    "data.schema.infer",
    "data.table.transform",
    "data.table.merge",
    "data.table.write",
    "llm.text.complete",
    "llm.text.summarize",
    "llm.text.extract",
    "llm.text.classify",
})

# 兼容历史/demo；上架仅认 KNOWN 23 项 + 可选扩展前缀策略见 capability_name_valid
_CAP_NAME_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$", re.I)
_RUNTIME_API_DEFAULT = "1.0.0"
HOST_API_VERSION = "1.0.0"  # 与客户端 runtime_api 同步
PLUGIN_EXECUTOR = "plugin.v1"


def normalize_cap_names(raw: Any) -> list[str]:
    """string[] | {name,version}[] | 混排 → 去重保序的能力名列表。"""
    if raw is None:
        return []
    if isinstance(raw, str):
        name = raw.strip()
        return [name] if name else []
    if not isinstance(raw, (list, tuple, set)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        name = ""
        if isinstance(item, str):
            name = item.strip()
        elif isinstance(item, dict):
            name = str(item.get("name") or item.get("id") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def capability_name_valid(name: str) -> bool:
    """上架：必须属于官方 23 项。运行时撮合：官方项或合法点分名均可。"""
    if not name or not _CAP_NAME_RE.match(name):
        return False
    return name in KNOWN_CAPABILITY_NAMES


def capability_name_known_or_dotted(name: str) -> bool:
    """撮合侧略宽：官方 23 + 合法点分命名。"""
    if not name or not _CAP_NAME_RE.match(name):
        return False
    if name in KNOWN_CAPABILITY_NAMES:
        return True
    return "." in name and len(name) <= 64


def validate_capabilities_for_publish(raw: Any) -> list[str]:
    """上架校验：返回清洗后的能力名；必须 ∈ 官方 23 项。"""
    names = normalize_cap_names(raw)
    bad = [n for n in names if not capability_name_valid(n)]
    if bad:
        raise ValueError(
            f"capabilities 含非契约能力名（须为官方 23 项）: {', '.join(bad[:8])}"
        )
    return names


def runtime_major(api: str | None) -> int | None:
    s = (api or "").strip()
    if not s:
        return None
    # "1.0.0" / "v1" / "1"
    s = s.lstrip("vV")
    head = s.split(".", 1)[0]
    if head.isdigit():
        return int(head)
    return None


def runtime_api_compatible(app_api: str | None, node_api: str | None) -> bool:
    """主版本一致才撮合；任一侧缺失时宽松通过（兼容老节点）。"""
    am = runtime_major(app_api)
    nm = runtime_major(node_api)
    if am is None or nm is None:
        return True
    return am == nm


def flatten_runtime_caps(caps: dict[str, Any] | None) -> dict[str, Any]:
    """hello capabilities → 扁平 runtime 字段（兼容嵌套）。

    优先顶栏: runtime_api / implemented / stubbed / declared / dispatch_covered
    兼容: capabilities.runtime.{api,implemented,...} 或 nested ``runtime`` dict
    """
    c = caps if isinstance(caps, dict) else {}
    nested = c.get("runtime") if isinstance(c.get("runtime"), dict) else {}

    def _pick(key: str, *alt: str) -> Any:
        if key in c and c[key] is not None:
            return c[key]
        for a in alt:
            if a in c and c[a] is not None:
                return c[a]
        if nested:
            if key in nested and nested[key] is not None:
                return nested[key]
            for a in alt:
                if a in nested and nested[a] is not None:
                    return nested[a]
        return None

    runtime_api = _pick("runtime_api", "api")
    if runtime_api is None and nested.get("api") is not None:
        runtime_api = nested.get("api")
    if isinstance(runtime_api, (int, float)):
        runtime_api = str(runtime_api)
    runtime_api = str(runtime_api or "").strip()

    implemented = normalize_cap_names(_pick("implemented", "caps_implemented"))
    stubbed = normalize_cap_names(_pick("stubbed", "caps_stubbed"))
    declared = normalize_cap_names(_pick("declared", "caps_declared"))
    # 部分客户端把全部能力放 capabilities 数组
    if not implemented and not stubbed and not declared:
        generic = normalize_cap_names(c.get("capabilities"))
        if generic:
            implemented = generic

    dispatch_covered = _pick("dispatch_covered")
    if dispatch_covered is None:
        dispatch_covered = 0
    elif isinstance(dispatch_covered, bool):
        # True → 视为 covered 全部；False → 0
        dispatch_covered = len(KNOWN_CAPABILITY_NAMES) if dispatch_covered else 0
    elif isinstance(dispatch_covered, (int, float)):
        dispatch_covered = int(dispatch_covered)
    elif isinstance(dispatch_covered, list):
        # 能力名列表 → 计数
        dispatch_covered = len(normalize_cap_names(dispatch_covered))
    else:
        try:
            dispatch_covered = int(dispatch_covered)
        except (TypeError, ValueError):
            dispatch_covered = 0

    supported = normalize_cap_names(_pick("supported_executors"))
    if not supported:
        supported = normalize_cap_names(c.get("supported_executors"))

    return {
        "runtime_api": runtime_api,
        "implemented": implemented,
        "stubbed": stubbed,
        "declared": declared,
        "dispatch_covered": dispatch_covered,
        "supported_executors": supported,
    }


def worker_effective_caps(
    worker_or_caps: Any,
    *,
    allow_stubbed: bool = True,
) -> set[str]:
    """节点可用于撮合的能力集合。"""
    flat = _caps_from_worker(worker_or_caps)
    out = set(flat.get("implemented") or [])
    if allow_stubbed:
        out |= set(flat.get("stubbed") or [])
    return out


def _caps_from_worker(worker_or_caps: Any) -> dict[str, Any]:
    if worker_or_caps is None:
        return flatten_runtime_caps({})
    if isinstance(worker_or_caps, dict):
        return flatten_runtime_caps(worker_or_caps)
    cap = getattr(worker_or_caps, "capabilities", None)
    if hasattr(cap, "__dataclass_fields__"):
        from dataclasses import asdict
        d = asdict(cap)
        # 已展平的字段优先
        flat = {
            "runtime_api": d.get("runtime_api") or "",
            "implemented": list(d.get("implemented") or []),
            "stubbed": list(d.get("stubbed") or []),
            "declared": list(d.get("declared") or []),
            "dispatch_covered": d.get("dispatch_covered"),
            "supported_executors": list(d.get("supported_executors") or []),
        }
        # 若 dataclass 未灌扁平字段，再从可能残留的 raw 风格合并
        if not flat["implemented"] and not flat["runtime_api"]:
            return flatten_runtime_caps(d)
        return flat
    if isinstance(cap, dict):
        return flatten_runtime_caps(cap)
    return flatten_runtime_caps({})


def node_runtime_api(worker_or_caps: Any) -> str:
    return str(_caps_from_worker(worker_or_caps).get("runtime_api") or "")


def node_supports_executor(worker_or_caps: Any, executor: str) -> bool:
    if not executor:
        return True
    flat = _caps_from_worker(worker_or_caps)
    supported = set(flat.get("supported_executors") or [])
    # 兼容老 WorkerCapabilities 直接字段
    if not supported and hasattr(getattr(worker_or_caps, "capabilities", None), "supported_executors"):
        supported = set(getattr(worker_or_caps.capabilities, "supported_executors", None) or [])
    return executor in supported


def app_required_caps(app_or_caps: Any) -> list[str]:
    if isinstance(app_or_caps, dict):
        return normalize_cap_names(app_or_caps.get("capabilities") or app_or_caps)
    return normalize_cap_names(app_or_caps)


def match_runtime(
    *,
    required_caps: Iterable[str] | None,
    required_runtime_api: str | None,
    worker_or_caps: Any,
    allow_stubbed: bool = True,
    require_executor: str | None = None,
) -> tuple[bool, str]:
    """返回 (ok, reason)。"""
    if require_executor and not node_supports_executor(worker_or_caps, require_executor):
        return False, f"executor_missing:{require_executor}"

    if not runtime_api_compatible(required_runtime_api, node_runtime_api(worker_or_caps)):
        return False, (
            f"runtime_api_mismatch:app={required_runtime_api or '-'} "
            f"node={node_runtime_api(worker_or_caps) or '-'}"
        )

    needed = set(normalize_cap_names(list(required_caps or [])))
    if not needed:
        return True, "ok"

    have = worker_effective_caps(worker_or_caps, allow_stubbed=allow_stubbed)
    missing = sorted(needed - have)
    if missing:
        return False, f"caps_missing:{','.join(missing[:12])}"
    return True, "ok"


def sanitize_plugin_block(raw: Any) -> dict[str, Any] | None:
    """接单/派发用的 plugin 块清洗；非法返回 None。"""
    if not isinstance(raw, dict):
        return None
    out: dict[str, Any] = {}
    code = raw.get("code")
    code_url = raw.get("code_url") or raw.get("codeUrl")
    if isinstance(code, str) and code.strip():
        out["code"] = code
    if isinstance(code_url, str) and code_url.strip():
        out["code_url"] = code_url.strip()
    entry = raw.get("entry")
    if isinstance(entry, str) and entry.strip():
        out["entry"] = entry.strip()
    caps = normalize_cap_names(raw.get("capabilities"))
    if caps:
        out["capabilities"] = caps
    if "budget" in raw and raw["budget"] is not None:
        try:
            out["budget"] = float(raw["budget"])
        except (TypeError, ValueError):
            pass
    if "allowRemote" in raw or "allow_remote" in raw:
        out["allowRemote"] = bool(raw.get("allowRemote", raw.get("allow_remote")))
    # 透传其余 JSON 安全字段（节点侧可能扩展）
    for k, v in raw.items():
        if k in out or k in ("codeUrl", "allow_remote"):
            continue
        if k.startswith("_"):
            continue
        if isinstance(v, (str, int, float, bool, list, dict)) or v is None:
            if k not in ("code", "code_url", "entry", "capabilities", "budget", "allowRemote"):
                out[k] = v
    if "code" not in out and "code_url" not in out:
        return None
    return out


def is_plugin_workload(spec: Any) -> bool:
    executor = str(getattr(spec, "executor", "") or "").strip()
    if executor == PLUGIN_EXECUTOR:
        return True
    plugin = getattr(spec, "plugin", None)
    if isinstance(plugin, dict) and plugin:
        return True
    if isinstance(spec, dict):
        if str(spec.get("executor") or "").strip() == PLUGIN_EXECUTOR:
            return True
        if isinstance(spec.get("plugin"), dict) and spec.get("plugin"):
            return True
    return False


__all__ = [
    "KNOWN_CAPABILITY_NAMES",
    "HOST_API_VERSION",
    "PLUGIN_EXECUTOR",
    "normalize_cap_names",
    "capability_name_valid",
    "capability_name_known_or_dotted",
    "validate_capabilities_for_publish",
    "runtime_major",
    "runtime_api_compatible",
    "flatten_runtime_caps",
    "worker_effective_caps",
    "node_runtime_api",
    "node_supports_executor",
    "app_required_caps",
    "match_runtime",
    "sanitize_plugin_block",
    "is_plugin_workload",
    "_RUNTIME_API_DEFAULT",
]
