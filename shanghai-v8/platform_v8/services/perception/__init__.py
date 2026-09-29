"""千手 · v8 原生感知中枢 (神经感知 Perception Bus)

2026-05-30 · 替代 v1 未迁移的 services/perception · 让 services/ai/perception.py 的
3 个 AI 工具 (perception_query_metric / snapshot / anomalies) 从"未启用"变为可用。

设计:
  - METRIC_CATALOG: 指标目录 (name -> MetricSpec + 计算函数)
  - PerceptionBus: perceive(单指标) / snapshot(多指标) / recent_anomalies(异常规则)
  - 数据源: 现有 we_* 表 (只读 SQL · session_scope)
  - 异常检测: 轻量规则 (失败率高 / 节点全掉线 / 某平台失败集中)

接口契约 (services/ai/perception.py 依赖):
  default_bus(), bootstrap(), PerceptionQuery(metric, limit), METRIC_CATALOG
  bus.perceive(q) -> MetricValue(.value/.ts_ms/.error/.metadata/.spec)
  bus.snapshot(categories) -> dict[name -> MetricValue]
  bus.recent_anomalies(limit) -> list[Anomaly]
  Distribution(.buckets/.total) · TopKItem(.label/.value/.extra)
"""
from __future__ import annotations

import asyncio
import enum
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from sqlalchemy import text

logger = logging.getLogger("services.perception")


# ── 类型 ────────────────────────────────────────────────
class Category(enum.Enum):
    USERS = "users"
    NODES = "nodes"
    TASKS = "tasks"
    ECONOMY = "economy"
    HEALTH = "health"
    SECURITY = "security"
    EXTERNAL = "external"


class Kind(enum.Enum):
    SCALAR = "scalar"
    DISTRIBUTION = "distribution"
    TOPK = "topk"


@dataclass
class Distribution:
    buckets: dict[str, float]
    total: float


@dataclass
class TopKItem:
    label: str
    value: float
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class MetricSpec:
    category: Category
    kind: Kind
    description: str
    sensitive: bool = False
    fn: Optional[Callable[[Any], Any]] = None  # (session) -> value


@dataclass
class MetricValue:
    value: Any
    ts_ms: int
    spec: MetricSpec
    error: Optional[str] = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Anomaly:
    metric: str
    severity: str            # info / warning / critical
    message: str
    detected_at_ms: int
    current: Any = None
    baseline: Any = None
    suggestion: str = ""


@dataclass
class PerceptionQuery:
    metric: str
    limit: int = 10


def _now_ms() -> int:
    return int(time.time() * 1000)


# ── 指标计算函数 (同步 SQL · 由 session_scope 提供 s) ──────────
def _scalar(s, sql: str) -> float:
    r = s.execute(text(sql)).scalar()
    return float(r) if r is not None else 0.0


def m_nodes_online(s):    return _scalar(s, "select count(*) from we_workers where status='ONLINE'")
def m_nodes_offline(s):   return _scalar(s, "select count(*) from we_workers where status='OFFLINE'")
def m_nodes_total(s):     return _scalar(s, "select count(*) from we_workers")
def m_users_total(s):     return _scalar(s, "select count(*) from we_accounts")
def m_tasks_running(s):   return _scalar(s, "select count(*) from we_workloads where status='RUNNING'")
def m_tasks_total_24h(s): return _scalar(s, "select count(*) from we_workloads where created_at > now()-interval '24 hours'")
def m_tasks_failed_24h(s):return _scalar(s, "select count(*) from we_workloads where status='FAILED' and created_at > now()-interval '24 hours'")


def m_tasks_fail_rate_24h(s):
    tot = m_tasks_total_24h(s)
    if tot <= 0:
        return 0.0
    return round(m_tasks_failed_24h(s) / tot, 4)


def m_nodes_by_os(s):
    rows = s.execute(text(
        "select coalesce(capabilities->>'os','?') os, count(*) c from we_workers "
        "where status='ONLINE' group by 1 order by 2 desc")).all()
    b = {str(r[0]): float(r[1]) for r in rows}
    return Distribution(buckets=b, total=float(sum(b.values())))


def m_tasks_fail_by_os_24h(s):
    """近24h 失败 shard 按节点平台分布 (定位 Windows 等平台性失败)"""
    rows = s.execute(text(
        "select coalesce(wk.capabilities->>'os','?') os, count(*) c "
        "from we_shards sh join we_workers wk on sh.worker_id=wk.id "
        "where sh.status='FAILED' and sh.completed_at > now()-interval '24 hours' "
        "group by 1 order by 2 desc")).all()
    b = {str(r[0]): float(r[1]) for r in rows}
    return Distribution(buckets=b, total=float(sum(b.values())))


def m_top_failed_types_24h(s, limit=10):
    rows = s.execute(text(
        "select coalesce(spec->>'task_type','?') tt, count(*) c from we_workloads "
        "where status='FAILED' and created_at > now()-interval '24 hours' "
        "group by 1 order by 2 desc limit :lim"), {"lim": limit}).all()
    return [TopKItem(label=str(r[0]), value=float(r[1])) for r in rows]


def m_revenue_today(s):
    # 平台今日入账 (PLATFORM_FEE 正数和) · 敏感
    return _scalar(s,
        "select coalesce(sum(amount),0) from we_ledger where type='PLATFORM_FEE' "
        "and amount>0 and created_at > date_trunc('day', now())")


# ── 指标目录 ────────────────────────────────────────────
METRIC_CATALOG: dict[str, MetricSpec] = {
    "nodes.online":          MetricSpec(Category.NODES, Kind.SCALAR, "当前在线节点数", fn=m_nodes_online),
    "nodes.offline":         MetricSpec(Category.NODES, Kind.SCALAR, "当前离线节点数", fn=m_nodes_offline),
    "nodes.total":           MetricSpec(Category.NODES, Kind.SCALAR, "节点总数", fn=m_nodes_total),
    "nodes.by_os":           MetricSpec(Category.NODES, Kind.DISTRIBUTION, "在线节点按操作系统分布", fn=m_nodes_by_os),
    "tasks.running":         MetricSpec(Category.TASKS, Kind.SCALAR, "运行中任务数", fn=m_tasks_running),
    "tasks.total_24h":       MetricSpec(Category.TASKS, Kind.SCALAR, "近24小时任务总数", fn=m_tasks_total_24h),
    "tasks.failed_24h":      MetricSpec(Category.TASKS, Kind.SCALAR, "近24小时失败任务数", fn=m_tasks_failed_24h),
    "tasks.fail_rate_24h":   MetricSpec(Category.TASKS, Kind.SCALAR, "近24小时任务失败率(0-1)", fn=m_tasks_fail_rate_24h),
    "tasks.fail_by_os_24h":  MetricSpec(Category.TASKS, Kind.DISTRIBUTION, "近24小时失败分片按节点平台分布", fn=m_tasks_fail_by_os_24h),
    "tasks.top_failed_types_24h": MetricSpec(Category.TASKS, Kind.TOPK, "近24小时失败最多的任务类型", fn=m_top_failed_types_24h),
    "users.total":           MetricSpec(Category.USERS, Kind.SCALAR, "注册用户总数", fn=m_users_total),
    "economy.revenue_today": MetricSpec(Category.ECONOMY, Kind.SCALAR, "平台今日入账(EDG)", sensitive=True, fn=m_revenue_today),
    "health.backend":        MetricSpec(Category.HEALTH, Kind.SCALAR, "后端健康(1=ok)", fn=lambda s: 1.0),
}


# ── 感知总线 ────────────────────────────────────────────
class PerceptionBus:
    def __init__(self):
        self._booted = False

    def bootstrap(self):
        self._booted = True

    def _compute_one(self, name: str, spec: MetricSpec, limit: int) -> MetricValue:
        from platform_v8.storage.db import session_scope
        try:
            with session_scope() as s:
                if spec.kind == Kind.TOPK:
                    val = spec.fn(s, limit)  # type: ignore[call-arg]
                else:
                    val = spec.fn(s)         # type: ignore[misc]
            return MetricValue(value=val, ts_ms=_now_ms(), spec=spec)
        except Exception as e:  # 单指标失败不影响整体
            logger.warning("perceive metric %s 失败: %s", name, e)
            return MetricValue(value=None, ts_ms=_now_ms(), spec=spec, error=str(e)[:200])

    async def perceive(self, q: PerceptionQuery) -> MetricValue:
        spec = METRIC_CATALOG.get(q.metric)
        if spec is None:
            raise ValueError(f"未知 metric: {q.metric}")
        return await asyncio.to_thread(self._compute_one, q.metric, spec, q.limit)

    async def snapshot(self, categories: Optional[list[str]] = None) -> dict[str, MetricValue]:
        cats = set(categories) if categories else None

        def _run() -> dict[str, MetricValue]:
            out: dict[str, MetricValue] = {}
            for name, spec in METRIC_CATALOG.items():
                if cats and spec.category.value not in cats:
                    continue
                out[name] = self._compute_one(name, spec, 10)
            return out
        return await asyncio.to_thread(_run)

    def recent_anomalies(self, limit: int = 20) -> list[Anomaly]:
        """轻量规则异常检测 (同步 · 实时算)"""
        from platform_v8.storage.db import session_scope
        anoms: list[Anomaly] = []
        now = _now_ms()
        try:
            with session_scope() as s:
                online = m_nodes_online(s)
                tot = m_tasks_total_24h(s)
                fr = m_tasks_fail_rate_24h(s)
                fail_os = m_tasks_fail_by_os_24h(s)

                if online <= 0:
                    anoms.append(Anomaly("nodes.online", "critical", "当前无任何在线节点", now,
                                         current=online, baseline=">0", suggestion="检查节点连通/后端 WS"))
                if tot >= 20 and fr > 0.20:
                    anoms.append(Anomaly("tasks.fail_rate_24h", "warning",
                                         f"近24h 任务失败率偏高 {fr*100:.1f}% (共 {int(tot)} 单)", now,
                                         current=fr, baseline="≤0.20",
                                         suggestion="看 tasks.fail_by_os_24h 定位是否平台性问题"))
                # 某平台失败集中 (如 Windows 运行时)
                if fail_os.total >= 20:
                    for osname, c in fail_os.buckets.items():
                        if c / fail_os.total > 0.6:
                            anoms.append(Anomaly("tasks.fail_by_os_24h", "warning",
                                                 f"近24h 失败分片 {c/fail_os.total*100:.0f}% 集中在 {osname} 平台",
                                                 now, current=osname,
                                                 suggestion=f"排查 {osname} 节点运行时(venv/PATH/exit code)"))
        except Exception as e:
            logger.warning("recent_anomalies 失败: %s", e)
        return anoms[:limit]


_bus: Optional[PerceptionBus] = None


def default_bus() -> PerceptionBus:
    global _bus
    if _bus is None:
        _bus = PerceptionBus()
        _bus.bootstrap()
    return _bus


def bootstrap():
    """幂等初始化 (供 ai/perception.py 调用)"""
    default_bus()
