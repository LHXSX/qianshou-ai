"""AI 工具适配：中央 AI 神经感知中枢

把 services/perception 的 3 个能力注册成 ai_tools.TOOL_REGISTRY 里的工具，
让 ai_agent V2 的 LLM 调用链可以直接调用感知中枢。

启动注册
========
app 启动期 import 本模块即可（装饰器会自动注册）：
```python
from platform_v8.services.ai import perception  # noqa: F401  触发 @ai_tool 装饰
```

3 个工具
========
1. perception_query_metric — 单 metric 查询（"现在多少节点在线"）
2. perception_snapshot     — 全域/分类快照（"平台现在怎么样"）
3. perception_anomalies    — 当前异常事件（"最近有告警吗"）

权限
====
- snapshot / anomalies：所有角色可调（reading 权限）
- query_metric：所有角色可调，但 sensitive=True 的 metric（如 security.pii_events_24h）
  会在内部检查角色 → 仅 admin/enterprise 可见
"""
from __future__ import annotations

import logging
from typing import Any

from .tools import ai_tool

logger = logging.getLogger("services.ai_tools_perception")

# ─── v8 Fallback：直接从数据库查实时数据 ─────────────────────────
import os, json

async def _fallback_query_metric(user, args):
    """感知中枢不可用时的直接数据库查询 fallback"""
    import asyncpg
    metric = str(args.get("metric", "")).strip()
    dsn = os.environ.get("DIRECT_DATABASE_URL") or os.environ.get("DATABASE_URL") or ""
    if not dsn:
        return {"metric": metric, "error": "数据库未配置", "value": None, "rendered_text": f"抱歉，无法查询 {metric}，数据库连接未配置。"}
    
    try:
        # 时区根治: asyncpg 默认用 server 时区(Asia/Shanghai)·与 db.py sync engine 的
        # SET TIME ZONE 'UTC' 对齐·确保 NOW() 与 naive utcnow 写入口径一致(v8_029)
        conn = await asyncpg.connect(dsn, server_settings={"timezone": "UTC"})
        try:
            if metric == "nodes.online":
                row = await conn.fetchval("SELECT COUNT(*) FROM we_workers WHERE status='ONLINE'")
                return {"metric": metric, "value": row, "rendered_text": f"当前 {row} 个节点在线。"}
            elif metric == "nodes.total":
                row = await conn.fetchval("SELECT COUNT(*) FROM we_workers")
                return {"metric": metric, "value": row, "rendered_text": f"共 {row} 个注册节点。"}
            elif metric == "tasks.completed_today":
                row = await conn.fetchval("SELECT COUNT(*) FROM we_workloads WHERE status='DONE' AND created_at >= NOW() - INTERVAL '24 hours'")
                return {"metric": metric, "value": row, "rendered_text": f"24 小时内完成 {row} 个任务。"}
            elif metric == "economy.revenue_today":
                row = await conn.fetchval("SELECT COALESCE(SUM(amount),0) FROM we_ledger WHERE created_at >= NOW() - INTERVAL '24 hours' AND amount > 0")
                return {"metric": metric, "value": float(row), "rendered_text": f"24 小时收入 {float(row):.2f} EDG。"}
            elif metric in ("nodes.unhealthy", "economy.total_balance", "tasks.running"):
                # 通用查询
                if "node" in metric:
                    row = await conn.fetchval("SELECT COUNT(*) FROM we_workers WHERE status='OFFLINE'")
                    return {"metric": metric, "value": row, "rendered_text": f"当前 {row} 个节点离线。"}
                elif "task" in metric:
                    row = await conn.fetchval("SELECT COUNT(*) FROM we_workloads WHERE status='RUNNING'")
                    return {"metric": metric, "value": row, "rendered_text": f"当前 {row} 个任务运行中。"}
                elif "balance" in metric:
                    row = await conn.fetchval("SELECT COALESCE(SUM(balance),0) FROM we_accounts")
                    return {"metric": metric, "value": float(row), "rendered_text": f"平台总余额 {float(row):.2f} EDG。"}
            else:
                return {"metric": metric, "value": None, "rendered_text": f"未知指标: {metric}，可用指标: nodes.online, nodes.total, tasks.completed_today, economy.revenue_today"}
        finally:
            await conn.close()
    except Exception as e:
        return {"metric": metric, "error": str(e), "value": None, "rendered_text": f"查询 {metric} 时出错: {e}"}


# v8 未迁移 v1 services/perception 中枢 · 这 3 个 tool 暂作“未启用”优雅返回
# TODO: 后续可选 - 将 v1 perception (bus + METRIC_CATALOG + nl_renderer) 移植过来、
#       或重写为 v8 原生实现 (基于 ops + workloads + workers 现有 repo)
class _PerceptionUnavailable(RuntimeError):
    """v8 感知中枢未启用 · 优雅错误 · 不是 traceback"""
    def __init__(self):
        super().__init__(
            "感知中枢服务在 v8 暂未启用 (v1 perception bus 未迁移)。"
            "请改用 get_system_status / query_nodes / query_my_tasks 等已可用工具。"
        )


def _require_perception():
    """检查 v8 perception 服务是否可用 · 不可用则招 RuntimeError (装饰器会转为 friendly error)"""
    try:
        import importlib
        importlib.import_module("platform_v8.services.perception")
    except ImportError:
        raise _PerceptionUnavailable()


def _to_serializable(val: Any) -> Any:
    """把 dataclass / Distribution / TopKItem 转 JSON-safe dict。"""
    if val is None:
        return None
    if isinstance(val, (str, int, float, bool)):
        return val
    if hasattr(val, "buckets") and hasattr(val, "total"):
        return {"buckets": dict(val.buckets), "total": float(val.total)}
    if isinstance(val, list):
        return [_to_serializable(x) for x in val]
    if hasattr(val, "label") and hasattr(val, "value"):
        return {"label": val.label, "value": val.value,
                "extra": getattr(val, "extra", {}) or {}}
    if isinstance(val, dict):
        return {str(k): _to_serializable(v) for k, v in val.items()}
    return str(val)


# ─── Tool 1: 单 metric 查询 ───────────────────────────────────────


@ai_tool(
    name="perception_query_metric",
    description=(
        "查询千手算力平台单个实时运行指标。"
        "可用 metric 共 43 个，涵盖用户/节点/任务/经济/系统健康/安全/外部依赖。"
        "示例：'现在多少节点在线' → metric='nodes.online'；"
        "'今日营收' → metric='economy.revenue_today'；"
        "'哪些节点不健康' → metric='nodes.unhealthy'；"
        "'整体算力利用率' → metric='nodes.capacity_utilization'。"
    ),
    risk="low",
    schema={
        "type": "object",
        "properties": {
            "metric": {
                "type": "string",
                "description": "metric 名（点分命名，如 nodes.online、economy.revenue_today）",
            },
            "limit": {
                "type": "integer",
                "default": 10,
                "description": "TopK / List 类型返回数量上限，默认 10",
            },
        },
        "required": ["metric"],
    },
)
async def perception_query_metric(user, args):
    """单 metric 查询。LLM 用这个回答"具体某个指标值"的问题。"""
    try:
        _require_perception()
        from platform_v8.services.perception import default_bus, PerceptionQuery, METRIC_CATALOG  # type: ignore
        from platform_v8.services.perception.nl_renderer import render_one  # type: ignore
        from platform_v8.services.perception import bootstrap as _ppn_bootstrap  # type: ignore
        _ppn_bootstrap()

        metric = str(args.get("metric", "")).strip()
        if not metric:
            raise ValueError("缺少 metric 参数")
        spec = METRIC_CATALOG.get(metric)
        if spec is None:
            raise ValueError(f"未知 metric: {metric}（请用 perception_snapshot 看所有可用）")

        if spec.sensitive:
            role = str(user.get("role", "")).lower()
            if role not in ("admin", "enterprise"):
                raise PermissionError(f"metric '{metric}' 为敏感指标，仅 admin/enterprise 可访问")

        limit = int(args.get("limit", 10) or 10)
        mv = await default_bus().perceive(PerceptionQuery(metric=metric, limit=limit))

        return {
            "metric": metric,
            "category": spec.category.value,
            "kind": spec.kind.value,
            "description": spec.description,
            "value": _to_serializable(mv.value),
            "rendered_text": render_one(mv),
            "ts_ms": mv.ts_ms,
            "error": mv.error,
            "metadata": mv.metadata,
        }
    except _PerceptionUnavailable:
        # v8 fallback：感知中枢未启用时，从数据库直接查
        return await _fallback_query_metric(user, args)


# ─── Tool 2: 全域快照 ─────────────────────────────────────────────


@ai_tool(
    name="perception_snapshot",
    description=(
        "获取千手算力平台整体运行状态快照（多指标聚合的中文报告）。"
        "适合回答'平台现在怎么样'、'给我看看运营情况'、'整体概况'等宽泛问题。"
        "可指定 categories 参数缩小到特定域：users/nodes/tasks/economy/health/security/external。"
    ),
    risk="low",
    schema={
        "type": "object",
        "properties": {
            "categories": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["users", "nodes", "tasks", "economy",
                             "health", "security", "external"],
                },
                "description": "限定 category，留空表示所有域",
            },
        },
    },
)
async def perception_snapshot(user, args):
    """整体或分类快照。LLM 用这个回答宽泛"平台怎么样"的问题。"""
    try:
        _require_perception()
        from platform_v8.services.perception import default_bus  # type: ignore
        from platform_v8.services.perception.nl_renderer import render_snapshot  # type: ignore
        from platform_v8.services.perception import bootstrap as _ppn_bootstrap  # type: ignore
        _ppn_bootstrap()

        cats = args.get("categories") or None
        snap = await default_bus().snapshot(categories=cats)

        # admin 见全部；非 admin 过滤掉 sensitive
        role = str(user.get("role", "")).lower()
        if role not in ("admin", "enterprise"):
            snap = {k: v for k, v in snap.items() if not v.spec.sensitive}

        rendered = render_snapshot(snap, title="千手算力平台实时状态")
        return {
            "metric_count": len(snap),
            "categories_requested": cats or "all",
            "rendered_text": rendered,
        }
    except _PerceptionUnavailable:
        # v8 fallback：从数据库直接生成快照
        return await _fallback_snapshot(user, args)


# ─── Tool 3: 异常事件 ────────────────────────────────────────────


@ai_tool(
    name="perception_anomalies",
    description=(
        "查询神经感知中枢捕获到的最近异常事件（错误激增、节点掉线潮、信誉异动、安全告警等）。"
        "适合回答'最近有什么异常'、'有没有告警'、'平台还健康吗'等问题。"
    ),
    risk="low",
    schema={
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "default": 20,
                "description": "返回数量上限，默认 20",
            },
        },
    },
)
async def perception_anomalies(user, args):
    """异常事件列表。LLM 用这个回答"有没有告警"的问题。"""
    _require_perception()
    from platform_v8.services.perception import default_bus  # type: ignore
    from platform_v8.services.perception.nl_renderer import render_anomalies  # type: ignore
    from platform_v8.services.perception import bootstrap as _ppn_bootstrap  # type: ignore
    _ppn_bootstrap()

    limit = int(args.get("limit", 20) or 20)
    anoms = default_bus().recent_anomalies(limit=limit)

    return {
        "count": len(anoms),
        "rendered_text": render_anomalies(anoms),
        "items": [
            {
                "metric": a.metric,
                "severity": a.severity,
                "message": a.message,
                "detected_at_ms": a.detected_at_ms,
                "current": a.current,
                "baseline": a.baseline,
                "suggestion": a.suggestion,
            }
            for a in anoms
        ],
    }


logger.info("perception AI 工具已注册：3 个（perception_query_metric / snapshot / anomalies）")
async def _fallback_snapshot(user, args):
    """感知中枢不可用时的数据库快照 fallback"""
    import asyncpg
    dsn = os.environ.get("DIRECT_DATABASE_URL") or os.environ.get("DATABASE_URL") or ""
    if not dsn:
        return {"metric_count": 0, "rendered_text": "抱歉，数据库未配置，无法生成快照。"}
    
    try:
        # 时区根治: asyncpg 默认用 server 时区(Asia/Shanghai)·与 db.py sync engine 的
        # SET TIME ZONE 'UTC' 对齐·确保 NOW() 与 naive utcnow 写入口径一致(v8_029)
        conn = await asyncpg.connect(dsn, server_settings={"timezone": "UTC"})
        try:
            online = await conn.fetchval("SELECT COUNT(*) FROM we_workers WHERE status='ONLINE'")
            total = await conn.fetchval("SELECT COUNT(*) FROM we_workers")
            done = await conn.fetchval("SELECT COUNT(*) FROM we_workloads WHERE status='DONE' AND created_at >= NOW() - INTERVAL '24 hours'")
            running = await conn.fetchval("SELECT COUNT(*) FROM we_workloads WHERE status='RUNNING'")
            users = await conn.fetchval("SELECT COUNT(*) FROM we_accounts")
            revenue = await conn.fetchval("SELECT COALESCE(SUM(amount),0) FROM we_ledger WHERE created_at >= NOW() - INTERVAL '24 hours' AND amount > 0")
            
            text = (
                f"📊 千手算力平台实时状态\\n\\n"
                f"**节点**: {online} 在线 / {total} 注册\\n"
                f"**任务**: 24h 完成 {done} · 运行中 {running}\\n"
                f"**用户**: {users} 个注册\\n"
                f"**收入**: 24h {float(revenue):.2f} EDG\\n"
            )
            return {"metric_count": 5, "rendered_text": text}
        finally:
            await conn.close()
    except Exception as e:
        return {"metric_count": 0, "rendered_text": f"快照生成失败: {e}"}
