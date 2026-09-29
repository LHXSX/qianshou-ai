"""感知中枢 · 中文自然语言渲染 (把 MetricValue / Anomaly 渲染成可读文本)"""
from __future__ import annotations

from typing import Any

from . import Distribution, TopKItem, MetricValue, Anomaly, Kind


def _fmt_value(mv: MetricValue) -> str:
    v = mv.value
    if mv.error:
        return f"(取值失败: {mv.error})"
    if v is None:
        return "(无数据)"
    if isinstance(v, Distribution):
        if not v.buckets:
            return "(空)"
        parts = [f"{k} {int(val) if float(val).is_integer() else val}" for k, val in v.buckets.items()]
        return "、".join(parts) + f" (合计 {int(v.total)})"
    if isinstance(v, list) and v and isinstance(v[0], TopKItem):
        return "; ".join(f"{i+1}.{it.label}={int(it.value)}" for i, it in enumerate(v)) or "(空)"
    if isinstance(v, float):
        # 失败率类 (0-1) 用百分比
        if mv.spec.description and ("率" in mv.spec.description or "0-1" in mv.spec.description):
            return f"{v*100:.1f}%"
        return f"{int(v) if v.is_integer() else round(v, 2)}"
    return str(v)


def render_one(mv: MetricValue) -> str:
    return f"{mv.spec.description}: {_fmt_value(mv)}"


def render_snapshot(snap: dict[str, MetricValue], title: str = "平台实时状态") -> str:
    if not snap:
        return f"【{title}】(无可用指标)"
    # 按 category 分组
    by_cat: dict[str, list[str]] = {}
    for name, mv in snap.items():
        cat = mv.spec.category.value
        by_cat.setdefault(cat, []).append(f"  · {render_one(mv)}")
    cat_zh = {"users": "用户", "nodes": "节点", "tasks": "任务",
              "economy": "经济", "health": "健康", "security": "安全", "external": "外部"}
    lines = [f"【{title}】"]
    for cat, items in by_cat.items():
        lines.append(f"[{cat_zh.get(cat, cat)}]")
        lines.extend(items)
    return "\n".join(lines)


def render_anomalies(anoms: list[Anomaly]) -> str:
    if not anoms:
        return "✅ 当前无异常告警 (节点/失败率/平台均正常)"
    sev_icon = {"critical": "🔴", "warning": "🟠", "info": "🔵"}
    lines = [f"⚠ 捕获 {len(anoms)} 条异常:"]
    for a in anoms:
        line = f"  {sev_icon.get(a.severity, '•')} [{a.severity}] {a.message}"
        if a.suggestion:
            line += f" · 建议: {a.suggestion}"
        lines.append(line)
    return "\n".join(lines)
