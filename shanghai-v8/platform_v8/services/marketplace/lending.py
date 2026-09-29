"""算力出借：节点设置 / 行情 / 收益 / shard 真结算。"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import insert, select, update
from sqlalchemy.orm import Session

from platform_v8.core import LedgerEntry, LedgerType
from platform_v8.engine import task_registry
from platform_v8.services.auth.admin_lookup import resolve_admin_account_id
from platform_v8.services.economy.ledger import _refresh_balance_cache
from platform_v8.services.marketplace import commission as commission_svc
from platform_v8.services.marketplace import sandbox as sandbox_svc
from platform_v8.storage.repo import (
    IdempotentConflict,
    LedgerRepo,
    lending_earnings_t,
    lending_nodes_t,
    shards_t,
    workers_t,
)

logger = logging.getLogger(__name__)


class LendingError(Exception):
    pass


def _row(m) -> dict[str, Any]:
    d = dict(m)
    for k, v in list(d.items()):
        if isinstance(v, Decimal):
            d[k] = float(v)
        elif isinstance(v, datetime):
            d[k] = v.isoformat()
        elif isinstance(v, UUID):
            d[k] = str(v)
        elif isinstance(v, (list, dict)):
            d[k] = v
    return d


def _official_types() -> set[str]:
    try:
        specs = getattr(task_registry, "TASK_SPECS", None) or getattr(task_registry, "_SPECS", None)
        if isinstance(specs, dict):
            return set(specs.keys())
        if callable(getattr(task_registry, "all_specs", None)):
            return {s.task_type for s in task_registry.all_specs()}
    except Exception:
        pass
    return {
        "ocr_image", "pdf_ocr", "contract_review",
        "whisper_transcribe", "excel_export", "package_digest",
    }


def get_or_create_node(s: Session, *, user_id: int, worker_id: str) -> dict:
    row = s.execute(
        select(lending_nodes_t).where(lending_nodes_t.c.worker_id == worker_id)
    ).mappings().first()
    if row:
        node = _row(row)
        if node["user_id"] != user_id:
            raise LendingError("该节点已绑定其他账号")
        return node
    # 校验 worker 归属
    w = s.execute(
        select(workers_t).where(workers_t.c.id == worker_id)
    ).mappings().first()
    if not w:
        raise LendingError("worker 不存在")
    if int(w["owner_id"]) != int(user_id):
        raise LendingError("只能出借自己的节点")
    s.execute(insert(lending_nodes_t).values(
        worker_id=worker_id,
        user_id=user_id,
        enabled=False,
        allow_third_party=False,
        schedule=[{"start": "22:00", "end": "08:00"}],
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    ))
    s.flush()
    row = s.execute(
        select(lending_nodes_t).where(lending_nodes_t.c.worker_id == worker_id)
    ).mappings().first()
    return _row(row)


def status_for_user(s: Session, user_id: int) -> dict:
    rows = s.execute(
        select(lending_nodes_t).where(lending_nodes_t.c.user_id == user_id)
    ).mappings().all()
    nodes = [_row(r) for r in rows]
    total_earned = sum(float(n.get("total_earned") or 0) for n in nodes)
    total_hours = sum(float(n.get("total_hours") or 0) for n in nodes)
    enabled = [n for n in nodes if n.get("enabled")]
    return {
        "nodes": nodes,
        "enabled_count": len(enabled),
        "total_earned": round(total_earned, 2),
        "total_hours": round(total_hours, 1),
        "market": market_quote(),
        "defaults": {
            "allow_third_party": False,
            "pricing_mode": "auto",
            "platform_share_pct": float(commission_svc.PLATFORM_LENDING_SHARE * 100),
        },
    }


def update_settings(s: Session, user_id: int, body: dict[str, Any]) -> dict:
    worker_id = body.get("worker_id")
    if not worker_id:
        raise LendingError("worker_id 必填")
    node = get_or_create_node(s, user_id=user_id, worker_id=str(worker_id))
    patch: dict[str, Any] = {"updated_at": datetime.utcnow()}
    if "enabled" in body:
        patch["enabled"] = bool(body["enabled"])
    if "max_cpu_cores" in body:
        patch["max_cpu_cores"] = max(1, min(64, int(body["max_cpu_cores"])))
    if "max_memory_mb" in body:
        patch["max_memory_mb"] = max(512, min(128 * 1024, int(body["max_memory_mb"])))
    if "schedule" in body:
        sched = body["schedule"]
        if isinstance(sched, str):
            sched = json.loads(sched)
        patch["schedule"] = sched
    if "pricing_mode" in body:
        mode = body["pricing_mode"]
        if mode not in ("auto", "manual"):
            raise LendingError("pricing_mode 须为 auto|manual")
        patch["pricing_mode"] = mode
    if "manual_price" in body:
        patch["manual_price"] = Decimal(str(body["manual_price"] or 0))
    if "allow_third_party" in body:
        # 默认禁止；用户显式打开才允许
        patch["allow_third_party"] = bool(body["allow_third_party"])
    s.execute(
        update(lending_nodes_t).where(lending_nodes_t.c.id == node["id"]).values(**patch)
    )
    s.flush()
    return status_for_user(s, user_id)


def market_quote() -> dict:
    rate = commission_svc.auto_lending_rate_per_hour(cpu_cores=2, gpu=False)
    split = commission_svc.split_lending_revenue(rate)
    return {
        "currency": "EDG",
        "auto_rate_per_hour": float(rate),
        "lender_take_per_hour": float(split["lender"]),
        "platform_take_per_hour": float(split["platform"]),
        "platform_share_pct": float(commission_svc.PLATFORM_LENDING_SHARE * 100),
        "note": "先 auto 定价；manual 第二期开放撮合",
    }


def list_earnings(s: Session, user_id: int, *, limit: int = 50) -> dict:
    nodes = s.execute(
        select(lending_nodes_t.c.id).where(lending_nodes_t.c.user_id == user_id)
    ).scalars().all()
    if not nodes:
        return {"items": [], "total": 0}
    rows = s.execute(
        select(lending_earnings_t)
        .where(lending_earnings_t.c.node_id.in_(list(nodes)))
        .order_by(lending_earnings_t.c.created_at.desc())
        .limit(limit)
    ).mappings().all()
    return {"items": [_row(r) for r in rows], "total": len(rows)}


def record_earning(
    s: Session,
    *,
    node_id: int,
    hours: float,
    rate: float | None = None,
    task_id: str | None = None,
    write_ledger: bool = True,
) -> dict:
    """写出借明细；可选同步 we_ledger（矿主 REWARD + 平台 PLATFORM_FEE）。"""
    node = s.execute(
        select(lending_nodes_t).where(lending_nodes_t.c.id == node_id)
    ).mappings().first()
    if not node:
        raise LendingError("出借节点不存在")

    # 幂等：同 node+task 已记账则直接返回
    if task_id:
        exists = s.execute(
            select(lending_earnings_t.c.id).where(
                lending_earnings_t.c.node_id == node_id,
                lending_earnings_t.c.task_id == str(task_id),
            )
        ).scalar()
        if exists:
            return {"ok": True, "already": True, "earning_id": int(exists), "gross": 0.0}

    h = Decimal(str(hours)).quantize(Decimal("0.01"))
    if h <= 0:
        h = Decimal("0.01")  # 最短按 0.01h 计量，避免 0 时长吞收益
    r = Decimal(str(rate if rate is not None else commission_svc.auto_lending_rate_per_hour(
        cpu_cores=int(node["max_cpu_cores"] or 2),
    )))
    gross = (h * r).quantize(Decimal("0.01"))
    split = commission_svc.split_lending_revenue(gross)
    s.execute(insert(lending_earnings_t).values(
        node_id=node_id,
        task_id=str(task_id) if task_id else None,
        hours=h,
        rate=r,
        earned=split["lender"],
        platform_fee=split["platform"],
        created_at=datetime.utcnow(),
    ))
    s.execute(
        update(lending_nodes_t).where(lending_nodes_t.c.id == node_id).values(
            total_earned=lending_nodes_t.c.total_earned + split["lender"],
            total_hours=lending_nodes_t.c.total_hours + h,
            updated_at=datetime.utcnow(),
        )
    )

    if write_ledger and task_id and split["lender"] > 0:
        lender_id = int(node["user_id"])
        order_key = f"lend:{node_id}:{task_id}"
        try:
            LedgerRepo.write(s, LedgerEntry(
                account_id=lender_id,
                type=LedgerType.REWARD,
                amount=split["lender"],
                idempotent_key=f"{order_key}:lender",
                note=f"出借收益 shard={task_id}",
                workload_id=None,
                shard_id=str(task_id),
            ))
            _refresh_balance_cache(s, lender_id)
        except IdempotentConflict:
            logger.info("lending ledger idempotent lender %s", order_key)
        if split["platform"] > 0:
            try:
                LedgerRepo.write(s, LedgerEntry(
                    account_id=resolve_admin_account_id(),
                    type=LedgerType.PLATFORM_FEE,
                    amount=split["platform"],
                    idempotent_key=f"{order_key}:platform",
                    note=f"出借平台抽成 shard={task_id}",
                    shard_id=str(task_id),
                ))
            except IdempotentConflict:
                logger.info("lending ledger idempotent platform %s", order_key)

    s.flush()
    return {
        "ok": True,
        "already": False,
        "gross": float(split["gross"]),
        "earned": float(split["lender"]),
        "platform_fee": float(split["platform"]),
        "hours": float(h),
        "rate": float(r),
    }


def _shard_hours(row: Any) -> float:
    elapsed_ms = row.get("elapsed_ms")
    if elapsed_ms is not None and int(elapsed_ms) > 0:
        return max(0.01, int(elapsed_ms) / 3_600_000)
    started = row.get("started_at") or row.get("dispatched_at")
    completed = row.get("completed_at")
    if started and completed:
        try:
            delta = (completed - started).total_seconds()
            return max(0.01, delta / 3600.0)
        except Exception:
            pass
    return 0.01


def settle_workload_shards(s: Session, *, workload_id: str) -> dict:
    """按已完成 shard 时长给启用的出借节点结算（幂等）。"""
    rows = s.execute(
        select(
            shards_t.c.id,
            shards_t.c.worker_id,
            shards_t.c.status,
            shards_t.c.elapsed_ms,
            shards_t.c.started_at,
            shards_t.c.dispatched_at,
            shards_t.c.completed_at,
            lending_nodes_t.c.id.label("node_id"),
            lending_nodes_t.c.max_cpu_cores,
            lending_nodes_t.c.pricing_mode,
            lending_nodes_t.c.manual_price,
            lending_nodes_t.c.enabled,
        )
        .select_from(shards_t)
        .join(lending_nodes_t, lending_nodes_t.c.worker_id == shards_t.c.worker_id)
        .where(
            shards_t.c.workload_id == str(workload_id),
            shards_t.c.status.in_(("DONE", "done", "COMPLETED", "completed")),
            lending_nodes_t.c.enabled.is_(True),
        )
    ).mappings().all()

    settled = 0
    gross_total = Decimal("0")
    details = []
    for r in rows:
        hours = _shard_hours(r)
        rate = None
        if str(r.get("pricing_mode") or "auto") == "manual" and r.get("manual_price") is not None:
            rate = float(r["manual_price"])
        else:
            rate = float(commission_svc.auto_lending_rate_per_hour(
                cpu_cores=int(r.get("max_cpu_cores") or 2),
            ))
        out = record_earning(
            s,
            node_id=int(r["node_id"]),
            hours=hours,
            rate=rate,
            task_id=str(r["id"]),
            write_ledger=True,
        )
        if not out.get("already"):
            settled += 1
            gross_total += Decimal(str(out.get("gross") or 0))
        details.append(out)

    return {
        "ok": True,
        "workload_id": str(workload_id),
        "settled_shards": settled,
        "candidate_shards": len(rows),
        "gross": float(gross_total),
        "details": details,
    }


def settle_recent_shards(s: Session, *, lookback_hours: int = 24) -> dict:
    """管理员补漏：扫描最近完成的出借 shard。"""
    since = datetime.utcnow() - timedelta(hours=max(1, lookback_hours))
    wids = s.execute(
        select(shards_t.c.workload_id)
        .join(lending_nodes_t, lending_nodes_t.c.worker_id == shards_t.c.worker_id)
        .where(
            shards_t.c.completed_at >= since,
            shards_t.c.status.in_(("DONE", "done", "COMPLETED", "completed")),
            lending_nodes_t.c.enabled.is_(True),
        )
        .distinct()
    ).scalars().all()
    total_shards = 0
    total_gross = Decimal("0")
    for wid in wids:
        out = settle_workload_shards(s, workload_id=str(wid))
        total_shards += int(out.get("settled_shards") or 0)
        total_gross += Decimal(str(out.get("gross") or 0))
    return {
        "ok": True,
        "workloads": len(wids),
        "settled_shards": total_shards,
        "gross": float(total_gross),
        "lookback_hours": lookback_hours,
    }


def settle_daily(s: Session, *, as_of: datetime | None = None) -> dict:
    """
    日批降级为「补漏」：扫描近 24h 真实 shard，禁止假 8h 占位。
    """
    as_of = as_of or datetime.utcnow()
    out = settle_recent_shards(s, lookback_hours=24)
    return {
        "ok": True,
        "as_of": as_of.isoformat(),
        "disabled": False,
        "mode": "shard_backfill",
        **out,
        "settled_nodes": out.get("settled_shards") or 0,
    }


def can_accept_task(
    s: Session,
    worker_id: str,
    task_type: str,
    *,
    respect_schedule: bool = False,
) -> bool:
    row = s.execute(
        select(lending_nodes_t).where(lending_nodes_t.c.worker_id == worker_id)
    ).mappings().first()
    if not row or not row["enabled"]:
        return False
    if respect_schedule and not _in_schedule(row.get("schedule")):
        return False
    return sandbox_svc.lending_task_allowed(
        allow_third_party=bool(row["allow_third_party"]),
        task_type=task_type,
        official_task_types=_official_types(),
    )


def worker_allowed_for_dispatch(
    s: Session,
    worker_id: str,
    task_type: str,
    *,
    respect_schedule: bool = True,
) -> bool:
    """
    派发硬过滤：
    - 未开通出借 / 出借已关闭 → 不施加出借沙箱约束（按普通节点派）
    - 出借开启 → 必须通过 can_accept_task（官方 task 放行；第三方需 allow_third_party）
    """
    row = s.execute(
        select(lending_nodes_t).where(lending_nodes_t.c.worker_id == worker_id)
    ).mappings().first()
    if not row or not row["enabled"]:
        return True
    return can_accept_task(
        s, worker_id, task_type, respect_schedule=respect_schedule,
    )


def filter_workers_for_dispatch(
    s: Session,
    workers: list[Any],
    task_type: str,
) -> list[Any]:
    """从候选 worker 列表中剔除违反出借策略的节点。"""
    if not workers or not task_type:
        return workers
    kept: list[Any] = []
    for w in workers:
        wid = str(getattr(w, "id", "") or "")
        if not wid:
            kept.append(w)
            continue
        try:
            if worker_allowed_for_dispatch(s, wid, task_type):
                kept.append(w)
            else:
                logger.info(
                    "lending.filter · skip worker=%s task=%s (出借策略拒绝)",
                    wid, task_type,
                )
        except Exception as exc:
            logger.debug("lending.filter · fail-open worker=%s err=%s", wid, exc)
            kept.append(w)
    return kept


def _in_schedule(schedule: Any) -> bool:
    if not schedule:
        return True
    try:
        now = datetime.utcnow().strftime("%H:%M")
        windows = schedule if isinstance(schedule, list) else json.loads(schedule)
        for w in windows or []:
            start = str(w.get("start") or "00:00")
            end = str(w.get("end") or "23:59")
            if start <= end:
                if start <= now <= end:
                    return True
            else:
                # 跨午夜：22:00-08:00
                if now >= start or now <= end:
                    return True
        return False
    except Exception:
        return True


def list_market_nodes(s: Session, *, task_type: str | None = None, limit: int = 50) -> dict:
    """用家借调视角：当前可接单的出借节点。"""
    rows = s.execute(
        select(lending_nodes_t, workers_t.c.status.label("worker_status"), workers_t.c.name)
        .join(workers_t, workers_t.c.id == lending_nodes_t.c.worker_id)
        .where(lending_nodes_t.c.enabled.is_(True))
        .limit(limit * 3)
    ).mappings().all()
    items = []
    for r in rows:
        wid = str(r["worker_id"])
        accepts = can_accept_task(s, wid, task_type or "ocr_image", respect_schedule=True)
        if task_type and not accepts:
            continue
        rate = commission_svc.auto_lending_rate_per_hour(cpu_cores=int(r.get("max_cpu_cores") or 2))
        if str(r.get("pricing_mode")) == "manual" and r.get("manual_price") is not None:
            rate = Decimal(str(r["manual_price"]))
        items.append({
            "worker_id": wid,
            "name": r.get("name"),
            "status": r.get("worker_status"),
            "max_cpu_cores": r.get("max_cpu_cores"),
            "max_memory_mb": r.get("max_memory_mb"),
            "allow_third_party": bool(r.get("allow_third_party")),
            "rate_per_hour": float(rate),
            "rep_score": r.get("rep_score"),
            "in_schedule": _in_schedule(r.get("schedule")),
            "accepts_task": accepts if task_type else can_accept_task(
                s, wid, "ocr_image", respect_schedule=True,
            ),
        })
        if len(items) >= limit:
            break
    quote = market_quote()
    return {"items": items, "total": len(items), "market": quote}
