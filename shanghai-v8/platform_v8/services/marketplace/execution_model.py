"""Runtime 执行模型与 R7 灰度开关。

execution_model:
  - legacy_script：tier/software 双读（默认）
  - runtime_v2：只认 provided_capabilities 健康广告；不把「装了 Python」当成满足

灰度（环境变量，默认全关硬匹配）：
  EDGE_PLANNER_RUNTIME_V2=1
  EDGE_RUNTIME_V2_ACCOUNT_IDS=1,2,3   # 空=不限制账号
  EDGE_RUNTIME_V2_APP_SLUGS=slug-a    # 空=不限制应用（Ally LAN 建议留空，作者新上架即可硬匹配）
  EDGE_RUNTIME_V2_CAPABILITIES=media.probe  # 空=不限制 Capability
"""
from __future__ import annotations

import os
from typing import Any


EXEC_LEGACY = "legacy_script"
EXEC_V2 = "runtime_v2"

# An advertised capability is not proof that a worker runs a reviewed plugin
# release. Until that binding exists, keep release-specific orders out of the
# generic worker paths.
PLUGIN_DISPATCH_FIELDS = frozenset({
    "plugin", "plugin_id", "plugin_manifest", "release_id",
    "plugin_release_id", "plugin_release", "package_sha256",
    "operation_id", "plugin_operation_id",
    "pluginId", "releaseId", "pluginReleaseId", "packageSha256",
    "operationId",
})


def requests_plugin_dispatch(value: Any) -> bool:
    """Detect plugin orders in submitted specs and stored workload specs."""
    spec = getattr(value, "spec", value)
    if isinstance(spec, dict):
        bags = (spec, spec.get("params"), spec.get("requirements"))
    else:
        bags = (getattr(spec, "params", None), getattr(spec, "requirements", None))
    return any(
        isinstance(bag, dict) and not PLUGIN_DISPATCH_FIELDS.isdisjoint(bag)
        for bag in bags
    )


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "on", "yes")


def _env_set(name: str) -> set[str]:
    raw = os.environ.get(name, "") or ""
    return {p.strip() for p in raw.split(",") if p.strip()}


def resolve_execution_model(app: dict[str, Any] | None) -> str:
    """从 Marketplace app / 版本元数据解析执行模型。缺省 legacy_script。"""
    if not app:
        return EXEC_LEGACY
    raw = (
        app.get("execution_model")
        or app.get("executionModel")
        or (app.get("display_meta") or {}).get("execution_model")
        or (app.get("runtime") or {}).get("execution_model")
        or ""
    )
    text = str(raw).strip().lower().replace("-", "_")
    if text in (EXEC_V2, "runtimev2", "v2"):
        return EXEC_V2
    return EXEC_LEGACY


def resolve_from_workload(workload: Any) -> str:
    """从 Workload.spec 解析；兼容 params/requirements。"""
    if workload is None:
        return EXEC_LEGACY
    spec = getattr(workload, "spec", None)
    if spec is None:
        return EXEC_LEGACY
    direct = getattr(spec, "execution_model", None) or ""
    if str(direct).strip():
        return resolve_execution_model({"execution_model": direct})
    params = getattr(spec, "params", None) or {}
    req = getattr(spec, "requirements", None) or {}
    return resolve_execution_model(
        {
            "execution_model": params.get("execution_model")
            or req.get("execution_model")
            or ""
        }
    )


def planner_v2_hard_match_enabled(
    *,
    account_id: int | None = None,
    app_slug: str | None = None,
    capability: str | None = None,
) -> bool:
    """是否对 V2 任务启用 Capability 硬匹配。总开关关闭时永远 False。"""
    if not _env_flag("EDGE_PLANNER_RUNTIME_V2"):
        return False
    accounts = _env_set("EDGE_RUNTIME_V2_ACCOUNT_IDS")
    if accounts and account_id is not None and str(account_id) not in accounts:
        return False
    apps = _env_set("EDGE_RUNTIME_V2_APP_SLUGS")
    if apps and app_slug and app_slug not in apps:
        return False
    caps = _env_set("EDGE_RUNTIME_V2_CAPABILITIES")
    if caps and capability and capability not in caps:
        return False
    return True


def marketplace_manifest_v2_fields(app: dict[str, Any]) -> dict[str, Any]:
    """序列化给客户端的 Runtime V2 / Legacy 分流字段（不删 legacy）。

    V2：作者声明的 required_capabilities 为真相源（不得被 task_registry 空推断冲掉）。
    Legacy：仍从 task_type → resolve_required(spec)。
    """
    model = resolve_execution_model(app)
    from platform_v8.engine import capabilities as cap_reg
    from platform_v8.engine import task_registry

    task_type = str(app.get("task_type") or "")
    spec = task_registry.get_spec(task_type) if task_type else task_registry.DEFAULT_SPEC
    if model == EXEC_V2:
        required_caps = cap_reg.author_declared_capabilities(app)
        if not required_caps:
            # 兼容旧 LAN SQL 仅改 execution_model、未写 caps 的灰度 slug
            required_caps = cap_reg.resolve_required(spec)
    else:
        required_caps = cap_reg.resolve_required(spec)

    meta = app.get("display_meta") if isinstance(app.get("display_meta"), dict) else {}
    runtime_api = (
        app.get("runtime_api")
        or meta.get("runtime_api")
        or ("2.0" if model == EXEC_V2 else None)
    )
    if model == EXEC_V2 and runtime_api in (None, "", "2"):
        runtime_api = "2.0"

    out: dict[str, Any] = {
        "execution_model": model,
        "runtime_api": runtime_api,
        "required_capabilities": required_caps,
    }
    if model == EXEC_V2:
        out["runtime"] = {
            "api": str(runtime_api or "2.0"),
            "execution_model": EXEC_V2,
            "required_capabilities": required_caps,
            "legacy_fallback_task_type": task_type or None,
            "show_tiers": False,
        }
        out["provider_review"] = {
            "permissions_summary": ["filesystem:task-input", "filesystem:task-output"],
            "cts_required": True,
            "trust_allowed": ["official", "reviewed-third-party"],
        }
    else:
        req_tier, fb = task_registry.resolve_tier_routing(spec)
        out["runtime"] = {
            "execution_model": EXEC_LEGACY,
            "required_tier": req_tier,
            "fallback_tiers": list(fb),
            "show_tiers": True,
        }
    return out
