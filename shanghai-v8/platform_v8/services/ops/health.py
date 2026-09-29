"""
Health check 业务逻辑

设计要点 (考虑全链路):
  - liveness: backend 进程活着就返 ok (k8s 用 · 不查 db)
  - readiness: backend 能服务请求 (查 db + redis · 任何挂就 503)
  - 这是所有 service 文件的"模板"路径 (api → service → storage)
"""
from __future__ import annotations
import os
import platform
import time
from dataclasses import dataclass, asdict
from datetime import datetime

from platform_v8 import __version__
from platform_v8.storage import db as db_mod
from platform_v8.storage import kv as kv_mod
from platform_v8.services.auth import config as auth_config


@dataclass
class HealthReport:
    """健康检查报告 · 给 ops/health endpoint 返"""
    status: str                       # "ok" / "degraded" / "error"
    version: str
    uptime_s: float
    timestamp: str
    components: dict[str, dict[str, str]]


_STARTED_AT = time.time()


def liveness() -> dict:
    """轻量 · 不查依赖 · k8s liveness probe 用"""
    return {
        "status": "ok",
        "version": __version__,
        "uptime_s": round(time.time() - _STARTED_AT, 2),
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }


def readiness() -> HealthReport:
    """详细 · 查 db + redis · k8s readiness probe + 监控用"""
    components: dict[str, dict[str, str]] = {}

    # DB
    components["db"] = db_mod.healthcheck()
    components["auth_schema"] = db_mod.auth_schema_healthcheck()
    components["migrations"] = db_mod.migration_healthcheck()

    # Redis
    components["redis"] = kv_mod.healthcheck()
    components["auth_config"] = auth_config.config_healthcheck()

    # 进程元数据 (运维查问题用)
    components["process"] = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "pid": str(os.getpid()),
    }

    # 总体状态
    has_error = any("error" in component.values() for component in components.values())
    if has_error:
        overall = "error"
    elif components["redis"].get("redis") == "disabled":
        overall = "degraded"
    else:
        overall = "ok"

    return HealthReport(
        status=overall,
        version=__version__,
        uptime_s=round(time.time() - _STARTED_AT, 2),
        timestamp=datetime.utcnow().isoformat() + "Z",
        components=components,
    )


def readiness_dict() -> dict:
    """readiness 转 dict (FastAPI JSON 序列化用)"""
    return asdict(readiness())
