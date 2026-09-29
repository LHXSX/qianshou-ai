"""
平台自营业务 · 通用补贴 + 收入流水模块 (2026-05-26)

适用 4 业务:
  - ip_proxy   · IP 代理池
  - geo_monitor · GEO 监测
  - ads        · 广告业务
  - cdn_edge   · CDN 边缘 (未来)

核心接口:
  accrue_revenue(business, client_id, amount_edg, ...) → 写 we_platform_revenue
  accrue_subsidy(business, basis, quantity, worker_id, ref_id) → 算补贴 + 入流水 + 入 ledger

D 方案 (节点小额奖励):
  - 单价表 we_subsidy_rules · admin 可调
  - 业务预算池 budget_daily_edg · 当天超 → 给 0 (业务继续 · 节点拿 0)
  - 单节点每日上限 max_per_day_edg · 防节点刷
  - 单笔最低发钱 min_payout_edg · 小于 → 累积或丢弃

入账路径:
  1. 写 we_node_subsidies 流水 (paid_to_ledger=FALSE)
  2. 调 ledger.reward 给节点 owner 加钱 (跟算力同套)
  3. 标记 paid_to_ledger=TRUE
"""
from __future__ import annotations
import logging
from decimal import Decimal
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.services.economy import ledger as ledger_mod

logger = logging.getLogger(__name__)


# ════════════════════════════════════════════════════════════════════
# 内部 · 读规则
# ════════════════════════════════════════════════════════════════════
def _get_rule(s: Session, business: str, basis: str) -> dict | None:
    """读 we_subsidy_rules · 返 None = 没规则 (不给补贴)"""
    row = s.execute(text("""
        SELECT unit_price_edg, min_payout_edg, max_per_day_edg,
               budget_daily_edg, enabled
        FROM we_subsidy_rules
        WHERE business = :biz AND basis = :basis
    """), {"biz": business, "basis": basis}).fetchone()
    if not row:
        return None
    return {
        "unit_price_edg": Decimal(str(row[0])),
        "min_payout_edg": Decimal(str(row[1])),
        "max_per_day_edg": Decimal(str(row[2])),
        "budget_daily_edg": Decimal(str(row[3])),
        "enabled": bool(row[4]),
    }


def _today_business_total(s: Session, business: str) -> Decimal:
    """今天某业务总补贴 (用于预算池检查)"""
    row = s.execute(text("""
        SELECT COALESCE(SUM(amount_edg), 0)
        FROM we_node_subsidies
        WHERE business = :biz
          AND created_at >= date_trunc('day', NOW())
    """), {"biz": business}).fetchone()
    return Decimal(str(row[0])) if row else Decimal("0")


def _today_worker_total(s: Session, worker_id: str, business: str) -> Decimal:
    """今天某节点某业务总补贴 (用于节点每日上限)"""
    row = s.execute(text("""
        SELECT COALESCE(SUM(amount_edg), 0)
        FROM we_node_subsidies
        WHERE business = :biz AND worker_id = :wid
          AND created_at >= date_trunc('day', NOW())
    """), {"biz": business, "wid": worker_id}).fetchone()
    return Decimal(str(row[0])) if row else Decimal("0")


def _get_worker_owner(s: Session, worker_id: str) -> int | None:
    row = s.execute(text(
        "SELECT owner_id FROM we_workers WHERE id = :wid LIMIT 1"
    ), {"wid": worker_id}).fetchone()
    return int(row[0]) if row and row[0] is not None else None


# ════════════════════════════════════════════════════════════════════
# 节点补贴 · accrue_subsidy
# ════════════════════════════════════════════════════════════════════
def accrue_subsidy(
    s: Session,
    *,
    business: str,
    basis: str,
    quantity: float | Decimal,
    worker_id: str,
    ref_id: str = "",
) -> Decimal:
    """算补贴 + 写流水 + 入 ledger

    返实付 EDG (Decimal · 可能 0).

    流程:
      1. 读规则 · 没规则 / disabled → 返 0
      2. 算 raw_amount = quantity * unit_price
      3. 检查预算池 (今天业务已发 + raw > daily_budget → 返 0)
      4. 检查节点每日上限 (今天该节点已拿 + raw > max_per_day → 给到上限)
      5. 检查最低发钱阈值 (< min_payout → 写流水 amount=0 · 不入 ledger)
      6. 写 we_node_subsidies 流水
      7. 调 ledger.reward · 给 worker owner 加钱
      8. 标记 paid_to_ledger=TRUE
    """
    q = Decimal(str(quantity))
    if q <= 0:
        return Decimal("0")

    rule = _get_rule(s, business, basis)
    if not rule or not rule["enabled"]:
        # 没规则 · 不给补贴 (仍写一条 amount=0 流水做审计)
        _write_subsidy(s, worker_id, business, basis, q, Decimal("0"), Decimal("0"),
                       ref_id, paid=False)
        return Decimal("0")

    raw_amount = q * rule["unit_price_edg"]

    # 预算池检查 (按业务)
    today_biz = _today_business_total(s, business)
    if today_biz + raw_amount > rule["budget_daily_edg"]:
        remaining = max(Decimal("0"), rule["budget_daily_edg"] - today_biz)
        if remaining <= 0:
            logger.info("subsidy.budget_exhausted · biz=%s today=%s budget=%s",
                        business, today_biz, rule["budget_daily_edg"])
            _write_subsidy(s, worker_id, business, basis, q, rule["unit_price_edg"],
                           Decimal("0"), ref_id, paid=False)
            return Decimal("0")
        raw_amount = remaining

    # 节点每日上限
    today_worker = _today_worker_total(s, worker_id, business)
    if today_worker + raw_amount > rule["max_per_day_edg"]:
        remaining_worker = max(Decimal("0"), rule["max_per_day_edg"] - today_worker)
        if remaining_worker <= 0:
            logger.info("subsidy.worker_cap · worker=%s biz=%s today=%s cap=%s",
                        worker_id, business, today_worker, rule["max_per_day_edg"])
            _write_subsidy(s, worker_id, business, basis, q, rule["unit_price_edg"],
                           Decimal("0"), ref_id, paid=False)
            return Decimal("0")
        raw_amount = min(raw_amount, remaining_worker)

    # 最低发钱阈值
    if raw_amount < rule["min_payout_edg"]:
        # 累积不发 · 只记流水 (未来可加 sweep job 把零碎补一起发)
        _write_subsidy(s, worker_id, business, basis, q, rule["unit_price_edg"],
                       raw_amount, ref_id, paid=False)
        return Decimal("0")

    # 真正发钱
    subsidy_id = _write_subsidy(s, worker_id, business, basis, q,
                                 rule["unit_price_edg"], raw_amount, ref_id, paid=False)
    owner_id = _get_worker_owner(s, worker_id)
    if owner_id is None:
        logger.warning("subsidy.no_owner · worker=%s · 跳过 ledger", worker_id)
        return Decimal("0")

    try:
        ledger_mod.reward(
            s,
            worker_owner_id=owner_id,
            amount=raw_amount,
            workload_id=f"__platform_{business}_{subsidy_id}__",
            shard_id=ref_id or None,
            note=f"system_task_subsidy · {business}/{basis}",
            idempotent_suffix=f"sub_{subsidy_id}",
            worker_id=worker_id,
            basis="none",
        )
        # 标 paid
        s.execute(text("""
            UPDATE we_node_subsidies SET paid_to_ledger=TRUE, paid_at=NOW()
            WHERE id = :sid
        """), {"sid": subsidy_id})
    except Exception as exc:
        logger.exception("subsidy.ledger_fail · worker=%s amount=%s err=%s",
                         worker_id, raw_amount, exc)
        return Decimal("0")

    return raw_amount


def _write_subsidy(
    s: Session, worker_id: str, business: str, basis: str,
    quantity: Decimal, unit_price: Decimal, amount: Decimal,
    ref_id: str, paid: bool,
) -> int:
    """写一条 we_node_subsidies 流水 · 返 id"""
    owner_id = _get_worker_owner(s, worker_id)
    row = s.execute(text("""
        INSERT INTO we_node_subsidies
            (worker_id, owner_id, business, basis,
             quantity, unit_price_edg, amount_edg, ref_id, paid_to_ledger)
        VALUES
            (:wid, :oid, :biz, :basis,
             :q, :up, :amt, :ref, :paid)
        RETURNING id
    """), {
        "wid": worker_id, "oid": owner_id, "biz": business, "basis": basis,
        "q": float(quantity), "up": float(unit_price), "amt": float(amount),
        "ref": ref_id, "paid": paid,
    }).fetchone()
    return int(row[0])


# ════════════════════════════════════════════════════════════════════
# 平台收入 · accrue_revenue
# ════════════════════════════════════════════════════════════════════
def accrue_revenue(
    s: Session,
    *,
    business: str,
    client_id: str,
    amount_edg: float | Decimal,
    quantity: float | Decimal = 0,
    unit: str = "",
    ref_id: str = "",
    metadata: dict | None = None,
) -> int:
    """写 we_platform_revenue 流水 · 返 id

    注意: 此函数 *不* 从 client account 扣钱 (那是另一个流程).
    只记录收入流水 · 方便后期对账 / 报表.

    扣钱由各业务 admin 后台 / 客户端 充值流程负责.
    """
    amt = Decimal(str(amount_edg))
    q = Decimal(str(quantity))
    md = metadata or {}

    import json as _json
    row = s.execute(text("""
        INSERT INTO we_platform_revenue
            (business, client_id, amount_edg, quantity, unit, ref_id, metadata)
        VALUES
            (:biz, :cid, :amt, :q, :unit, :ref, CAST(:md AS jsonb))
        RETURNING id
    """), {
        "biz": business, "cid": client_id, "amt": float(amt), "q": float(q),
        "unit": unit, "ref": ref_id, "md": _json.dumps(md),
    }).fetchone()
    return int(row[0])


# ════════════════════════════════════════════════════════════════════
# 一站式 · 接业务 (各 service 调这个)
# ════════════════════════════════════════════════════════════════════
def settle(
    s: Session,
    *,
    business: str,
    basis: str,
    quantity: float | Decimal,
    worker_id: str,
    client_id: str,
    revenue_edg: float | Decimal,
    ref_id: str = "",
    unit: str = "",
    metadata: dict | None = None,
) -> tuple[Decimal, int]:
    """业务完成时一站式结算

    会做 2 件事:
      1. 平台收入入流水 (accrue_revenue)
      2. 节点补贴入账 (accrue_subsidy)

    返 (节点拿到 EDG, revenue_id).

    DEPRECATED (W5 · 2026-05-26):
      proxy/crawl 业务建议直接调 ledger.transfer (三方原子分账 · 客户也扣钱)
      本函数保留为审计兼容 · 不再发展新业务. 老业务双轨过渡期仍调.
    """
    logger.debug(
        "subsidy.settle (deprecated) · business=%s ref=%s revenue=%s · "
        "建议改用 ledger.transfer",
        business, ref_id, revenue_edg,
    )
    revenue_id = accrue_revenue(
        s, business=business, client_id=client_id,
        amount_edg=revenue_edg, quantity=quantity, unit=unit,
        ref_id=ref_id, metadata=metadata,
    )
    node_paid = accrue_subsidy(
        s, business=business, basis=basis, quantity=quantity,
        worker_id=worker_id, ref_id=ref_id,
    )
    return node_paid, revenue_id


# ════════════════════════════════════════════════════════════════════
# 查询 (admin 用)
# ════════════════════════════════════════════════════════════════════
def get_business_today(s: Session, business: str) -> dict:
    """某业务今日统计"""
    rev_row = s.execute(text("""
        SELECT COALESCE(SUM(amount_edg), 0), COUNT(*) FROM we_platform_revenue
        WHERE business = :biz AND created_at >= date_trunc('day', NOW())
    """), {"biz": business}).fetchone()
    sub_row = s.execute(text("""
        SELECT COALESCE(SUM(amount_edg), 0), COUNT(*) FROM we_node_subsidies
        WHERE business = :biz AND created_at >= date_trunc('day', NOW())
    """), {"biz": business}).fetchone()
    return {
        "business": business,
        "revenue_today_edg": float(rev_row[0] or 0),
        "revenue_count": int(rev_row[1] or 0),
        "subsidy_today_edg": float(sub_row[0] or 0),
        "subsidy_count": int(sub_row[1] or 0),
        "net_today_edg": float((rev_row[0] or 0) - (sub_row[0] or 0)),
    }
