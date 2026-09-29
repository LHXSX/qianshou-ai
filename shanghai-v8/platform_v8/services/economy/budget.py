"""
月预算 + cost preview (硬刹车 + 提交前预估)

设计要点 · 2026-05-21:
  1. 预算配置存 we_accounts.profile JSON · 字段 monthly_budget / alert_threshold (默认 0.8)
     → 不新建表 · 不加迁移 · 个人/企业账户都能用
  2. 本月已用 = SUM(ESCROW_HOLD - REFUND, account_id=me, created_at >= 月初)
     → ledger 是真相 · 跨进程一致
  3. cost preview 基于 owner 近 30 天同 template REWARD 历史均值 (基础单价 1.0 ¥/shard 兜底)
     → 区间 [min=avg×0.7, max=avg×1.5, expected=avg] · 含 p50/p95 latency
  4. 硬刹车: create_workload 时 escrow 前调 check_budget(expected) · 超限抛 BudgetExceeded
     → 阈值 80% 时发警告 (后续接通知)
  5. monthly_budget=0 表示不限 · 兼容存量账户
"""
from __future__ import annotations
import logging
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.storage.repo import AccountRepo

logger = logging.getLogger(__name__)

# ── 类型 ─────────────────────────────────────────────
@dataclass
class BudgetStatus:
    monthly_limit: Decimal       # 0 = 不限
    used_this_month: Decimal
    remaining: Decimal           # max(0, limit - used)
    alert_threshold: float       # 0.0-1.0 · 默认 0.8
    used_pct: float              # 0.0-1.0+ (可超 1)
    breach: bool                 # used >= limit (limit>0)
    warn: bool                   # used_pct >= alert_threshold (limit>0)


@dataclass
class CostEstimate:
    min_cost: Decimal
    expected_cost: Decimal
    max_cost: Decimal
    p50_latency_ms: int
    p95_latency_ms: int
    currency: str = "CNY"
    basis: Literal["history", "default"] = "default"
    sample_size: int = 0           # 历史样本数 (basis=history 时有意义)


class BudgetExceeded(Exception):
    """预算硬刹车 · create_workload 时抛 · 上层转 HTTP 402"""
    def __init__(self, used: Decimal, limit: Decimal, attempted: Decimal):
        self.used = used
        self.limit = limit
        self.attempted = attempted
        super().__init__(
            f"本月预算超限: 已用 {used} / 限额 {limit} · 本次任务预估 {attempted} · "
            f"超出 {used + attempted - limit}"
        )


# ── 内部: profile JSON 读写 ─────────────────────────
_DEFAULT_THRESHOLD = 0.8


def _read_profile(s: Session, account_id: int) -> dict[str, Any]:
    acc = AccountRepo.by_id(s, account_id)
    if acc is None:
        raise ValueError(f"account {account_id} not found")
    profile = acc.profile if isinstance(acc.profile, dict) else {}
    return profile


def _write_profile(s: Session, account_id: int, profile: dict[str, Any]) -> None:
    # 用原生 SQL 避免 ORM 把整 row 全更新
    s.execute(
        text("UPDATE we_accounts SET profile = :p, updated_at = :u WHERE id = :i"),
        {"p": profile, "u": datetime.utcnow(), "i": account_id},
    )
    s.flush()


# ── 本月已用 (ledger SUM) ────────────────────────────
def _month_start_utc() -> datetime:
    now = datetime.utcnow()
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def used_this_month(s: Session, account_id: int) -> Decimal:
    """本月净花销 = ESCROW_HOLD - REFUND (仅当月)"""
    month_start = _month_start_utc()
    row = s.execute(text("""
        SELECT
          COALESCE(SUM(CASE WHEN type = 'ESCROW_HOLD' THEN amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type = 'REFUND'      THEN amount ELSE 0 END), 0)
        AS used
        FROM we_ledger
        WHERE account_id = :aid
          AND created_at >= :ms
    """), {"aid": account_id, "ms": month_start}).fetchone()
    used = Decimal(str(row.used)) if row and row.used is not None else Decimal("0")
    return max(Decimal("0"), used)


# ── 对外: 预算状态 ──────────────────────────────────
def get_status(s: Session, account_id: int) -> BudgetStatus:
    profile = _read_profile(s, account_id)
    limit = Decimal(str(profile.get("monthly_budget", 0)))
    threshold = float(profile.get("alert_threshold", _DEFAULT_THRESHOLD))
    used = used_this_month(s, account_id)

    if limit > 0:
        remaining = max(Decimal("0"), limit - used)
        used_pct = float(used / limit) if limit else 0.0
        breach = used >= limit
        warn = used_pct >= threshold
    else:
        remaining = Decimal("0")  # 不限场景 remaining 无意义
        used_pct = 0.0
        breach = False
        warn = False

    return BudgetStatus(
        monthly_limit=limit,
        used_this_month=used,
        remaining=remaining,
        alert_threshold=threshold,
        used_pct=used_pct,
        breach=breach,
        warn=warn,
    )


def set_budget(s: Session, account_id: int,
               monthly_limit: Decimal, alert_threshold: float = _DEFAULT_THRESHOLD) -> BudgetStatus:
    if monthly_limit < 0:
        raise ValueError("monthly_limit 必须 >= 0 (0 = 不限)")
    if not (0.1 <= alert_threshold <= 1.0):
        raise ValueError("alert_threshold 必须在 [0.1, 1.0]")
    profile = _read_profile(s, account_id)
    profile["monthly_budget"] = str(monthly_limit)
    profile["alert_threshold"] = float(alert_threshold)
    profile["budget_updated_at"] = datetime.utcnow().isoformat()
    _write_profile(s, account_id, profile)
    logger.info("budget.set · account=%s limit=%s threshold=%.2f",
                account_id, monthly_limit, alert_threshold)
    return get_status(s, account_id)


# ── 硬刹车 ───────────────────────────────────────────
def check_budget(s: Session, account_id: int, attempted_cost: Decimal) -> None:
    """create_workload 时 escrow 前调用 · 超限抛 BudgetExceeded"""
    status = get_status(s, account_id)
    if status.monthly_limit <= 0:
        return  # 不限场景跳过
    if status.used_this_month + attempted_cost > status.monthly_limit:
        raise BudgetExceeded(
            used=status.used_this_month,
            limit=status.monthly_limit,
            attempted=attempted_cost,
        )


# ── cost preview ────────────────────────────────────
_DEFAULT_UNIT_COST = Decimal("1.0")   # ¥/shard 兜底
_DEFAULT_P50_MS = 5000
_DEFAULT_P95_MS = 15000


def estimate_cost(s: Session, account_id: int,
                  *, template_id: str | None, shard_count: int) -> CostEstimate:
    """
    基于近 30 天历史: 同 owner + 同 template 已成功 shard 的 reward 均值
    无历史 → 默认 1.0 ¥/shard
    """
    if shard_count <= 0:
        shard_count = 1

    avg_unit = _DEFAULT_UNIT_COST
    avg_latency = _DEFAULT_P50_MS
    p95_latency = _DEFAULT_P95_MS
    sample_size = 0
    basis: Literal["history", "default"] = "default"

    since = datetime.utcnow() - timedelta(days=30)

    # 查同 template 历史成功 shard 的 reward (从 ledger REWARD + workload.spec)
    try:
        if template_id:
            row = s.execute(text("""
                SELECT
                  AVG(sh.predicted_cost)     AS avg_cost,
                  AVG(sh.elapsed_ms)         AS avg_ms,
                  COUNT(sh.id)               AS n
                FROM we_shards sh
                JOIN we_workloads w ON w.id = sh.workload_id
                WHERE w.owner_id = :aid
                  AND sh.status = 'OK'
                  AND sh.completed_at >= :since
                  AND (w.spec->>'template_id') = :tpl
            """), {"aid": account_id, "since": since, "tpl": template_id}).fetchone()
            if row and row.n and int(row.n) >= 3:
                if row.avg_cost is not None:
                    avg_unit = Decimal(str(row.avg_cost))
                if row.avg_ms is not None:
                    avg_latency = max(100, int(float(row.avg_ms)))
                    p95_latency = int(avg_latency * 2.5)
                sample_size = int(row.n)
                basis = "history"
    except Exception as exc:
        logger.warning("estimate_cost · history query failed: %s · fallback default", exc)

    expected = (avg_unit * shard_count).quantize(Decimal("0.0001"))
    min_cost = (expected * Decimal("0.7")).quantize(Decimal("0.0001"))
    max_cost = (expected * Decimal("1.5")).quantize(Decimal("0.0001"))

    return CostEstimate(
        min_cost=min_cost,
        expected_cost=expected,
        max_cost=max_cost,
        p50_latency_ms=avg_latency,
        p95_latency_ms=p95_latency,
        basis=basis,
        sample_size=sample_size,
    )


def to_dict(obj: BudgetStatus | CostEstimate) -> dict[str, Any]:
    """dataclass → dict · Decimal 转 str"""
    d = asdict(obj)
    return {k: (str(v) if isinstance(v, Decimal) else v) for k, v in d.items()}
