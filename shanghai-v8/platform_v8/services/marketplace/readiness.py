"""应用就绪门：声明 requirements + 根据客户端 caps 评估。"""
from __future__ import annotations

from typing import Any

from platform_v8.engine import task_registry


def build_requirements(app: dict[str, Any]) -> dict[str, Any]:
    """只读透出 App + TaskTypeSpec 门槛（不探测本机）。"""
    task_type = app.get("task_type")
    items: list[dict[str, Any]] = []

    tiers = list(app.get("tiers") or [])
    required_tier = None
    fallback_tiers: list[str] = []
    required_software: list[str] = []
    if task_type:
        spec = task_registry.TASK_REGISTRY.get(task_type)
        if spec is not None:
            required_tier, fb = task_registry.resolve_tier_routing(spec)
            fallback_tiers = list(fb or ())
            required_software = list(spec.required_software or [])
            if required_tier and required_tier not in tiers:
                tiers = [required_tier, *tiers]

    if tiers or required_tier:
        items.append({
            "key": "tier",
            "kind": "tier",
            "label": f"运行环境 {required_tier or (tiers[0] if tiers else 'default')}",
            "required": True,
            "detail": {
                "required_tier": required_tier,
                "fallback_tiers": fallback_tiers,
                "declared_tiers": list(app.get("tiers") or []),
            },
        })

    for soft in required_software:
        items.append({
            "key": f"software:{soft}",
            "kind": "software",
            "label": soft,
            "required": True,
            "detail": {"name": soft},
        })

    items.append({
        "key": "bundle",
        "kind": "bundle",
        "label": "模型/脚本包",
        "required": True,
        "detail": {"slug": app.get("slug")},
    })

    min_mb = int(app.get("min_memory_mb") or 1024)
    items.append({
        "key": "memory",
        "kind": "memory",
        "label": f"内存 ≥ {max(1, round(min_mb / 1024))} GB",
        "required": True,
        "detail": {"min_memory_mb": min_mb},
    })

    gpu_req = bool(app.get("gpu_required"))
    items.append({
        "key": "gpu",
        "kind": "gpu",
        "label": "GPU",
        "required": gpu_req,
        "detail": {"gpu_required": gpu_req},
    })

    kind = app.get("launch_kind") or "workload"
    if kind in ("deep_link", "webview"):
        items.append({
            "key": "deep_link",
            "kind": "deep_link",
            "label": "桌面壳 / 深链入口",
            "required": True,
            "detail": {"url": app.get("deep_link_url") or ""},
        })

    return {
        "slug": app.get("slug"),
        "task_type": task_type,
        "launch_kind": kind,
        "items": items,
    }


def evaluate_readiness(app: dict[str, Any], caps: dict[str, Any]) -> dict[str, Any]:
    """根据客户端上报快照评估就绪与补齐计划。"""
    req = build_requirements(app)
    installed_tiers = {str(x).lower() for x in (caps.get("installed_tiers") or [])}
    installed_software = {str(x).lower() for x in (caps.get("installed_software") or [])}
    ram_gb = caps.get("ram_gb")
    has_gpu = bool(caps.get("has_gpu"))
    bundle_cached = bool(caps.get("bundle_cached"))
    law_shell = caps.get("law_shell_available")

    out_items: list[dict[str, Any]] = []
    provision_plan: list[dict[str, Any]] = []

    for it in req["items"]:
        kind = it["kind"]
        status = "unknown"
        detail = ""
        if kind == "tier":
            need = (it["detail"].get("required_tier") or "").lower()
            fallbacks = [str(x).lower() for x in (it["detail"].get("fallback_tiers") or [])]
            ok = (not need and not fallbacks) or (need in installed_tiers) or any(
                f in installed_tiers for f in fallbacks
            )
            # Web/未上报 tiers：不阻塞，标 unknown 并允许借调
            if not installed_tiers and not need:
                status = "ok"
                detail = "无硬性 tier"
            elif not installed_tiers:
                status = "unknown"
                detail = f"需 {need or 'tier'}（客户端未上报已装列表）"
            elif ok:
                status = "ok"
                detail = "已具备"
            else:
                status = "missing"
                detail = f"缺少 {need or 'tier'}"
                provision_plan.append({
                    "key": it["key"],
                    "kind": "tier",
                    "action": "install_tier",
                    "tier": need or (fallbacks[0] if fallbacks else None),
                })
        elif kind == "software":
            name = str(it["detail"].get("name") or "").lower()
            if not installed_software:
                status = "unknown"
                detail = f"需 {name}"
            elif name in installed_software:
                status = "ok"
                detail = "已具备"
            else:
                status = "missing"
                detail = f"缺少 {name}"
                provision_plan.append({
                    "key": it["key"],
                    "kind": "software",
                    "action": "install_dep",
                    "name": name,
                })
        elif kind == "bundle":
            if bundle_cached:
                status = "ok"
                detail = "本地缓存命中"
            else:
                status = "missing"
                detail = "模型/脚本包未缓存"
                provision_plan.append({
                    "key": "bundle",
                    "kind": "bundle",
                    "action": "download_bundle",
                    "slug": app.get("slug"),
                })
        elif kind == "memory":
            need_mb = int(it["detail"].get("min_memory_mb") or 1024)
            need_gb = max(1, round(need_mb / 1024))
            if ram_gb is None:
                status = "unknown"
                detail = f"建议 {need_gb} GB"
            elif float(ram_gb) >= need_gb:
                status = "ok"
                detail = f"可用 {ram_gb} GB / 建议 {need_gb} GB"
            else:
                status = "missing"
                detail = f"可用 {ram_gb} GB / 建议 {need_gb} GB"
        elif kind == "gpu":
            if not it["required"]:
                status = "ok"
                detail = "无需 GPU"
            elif has_gpu:
                status = "ok"
                detail = "已具备"
            else:
                status = "missing" if caps.get("has_gpu") is False else "unknown"
                detail = "建议借调边缘 GPU"
        elif kind == "deep_link":
            if law_shell is True or caps.get("deep_link_available") is True:
                status = "ok"
                detail = "壳可用"
            elif law_shell is False:
                status = "missing"
                detail = "未安装桌面壳"
            else:
                status = "unknown"
                detail = "请确认桌面壳已安装"
        else:
            status = "unknown"
            detail = ""

        out_items.append({
            "key": it["key"],
            "kind": kind,
            "label": it["label"],
            "required": it["required"],
            "status": status,
            "detail": detail,
        })

    hard_missing = [
        x for x in out_items
        if x["required"] and x["status"] == "missing" and x["kind"] != "gpu"
    ]
    gpu_advice = any(x["key"] == "gpu" and x["status"] in ("missing", "unknown") and x["required"] for x in out_items)
    launch_kind = app.get("launch_kind") or "workload"

    if launch_kind in ("deep_link", "webview"):
        exec_advice = "deep_link"
    elif hard_missing:
        exec_advice = "prefer_edge" if not any(x["kind"] == "memory" and x["status"] == "missing" for x in hard_missing) else "edge_only"
        if any(x["kind"] == "memory" and x["status"] == "missing" for x in out_items) and not gpu_advice:
            # 本机内存硬不足仍可借调
            exec_advice = "edge_only"
    elif gpu_advice:
        exec_advice = "prefer_edge"
    else:
        exec_advice = "local_ok"

    price = float(app.get("price") or 0)
    from platform_v8.services.marketplace import commission as commission_svc
    edge_rate = float(commission_svc.auto_lending_rate_per_hour(cpu_cores=2, gpu=bool(app.get("gpu_required"))))

    return {
        "slug": app.get("slug"),
        "task_type": app.get("task_type"),
        "items": out_items,
        "provision_plan": provision_plan,
        "exec_advice": exec_advice,
        "cost_hint": {
            "app_price": price,
            "pricing_model": app.get("pricing_model") or "free",
            "edge_estimate_min": edge_rate,
            "edge_estimate_max": round(edge_rate * 2, 2),
            "currency": "EDG",
        },
    }
