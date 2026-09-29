"""
services/business/billing.py · B2B 月度账单 (W7-phase2 · 2026-05-26)

数据流:
  1. admin 触发 generate_invoice(account_id, period_yyyymm)
  2. billing 从 we_ledger WHERE workload_id LIKE 'proxy_%' 聚合该客户本月所有 transfer
     · ESCROW_HOLD (客户扣) · REWARD (节点拿) · PLATFORM_FEE (平台抽) 三类聚合
     · 加 we_proxy_sessions 聚合 total_bytes + session_count
  3. 写 we_business_invoices (account_id + period + business_type 唯一)
  4. admin 标 status: draft → issued → paid

幂等: 同 (account_id, period_yyyymm, business_type) UNIQUE 防重
"""
from __future__ import annotations
import logging
from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


_VALID_STATUS = {"draft", "issued", "paid", "cancelled"}


# ════════════════════════════════════════════════════════════════
# Row → dict
# ════════════════════════════════════════════════════════════════
def _row_to_dict(row) -> dict:
    d = dict(row._mapping) if hasattr(row, "_mapping") else dict(row)
    for k in ("generated_at", "issued_at", "paid_at", "due_at", "created_at", "updated_at"):
        v = d.get(k)
        if isinstance(v, datetime):
            d[k] = v.isoformat()
    for k in ("amount_edg", "node_paid_edg", "platform_fee_edg"):
        v = d.get(k)
        if isinstance(v, Decimal):
            d[k] = float(v)
    return d


# ════════════════════════════════════════════════════════════════
# 聚合: 从 ledger + we_proxy_sessions 算出用量 + 金额
# ════════════════════════════════════════════════════════════════
def _aggregate_period(
    s: Session, *,
    account_id: int,
    period_yyyymm: str,
    business_type: str = "ip_proxy",
) -> dict:
    """聚合指定客户/月份/业务的 ledger + 流量数据

    Returns:
        {
          "amount_edg": Decimal (客户应付 · ESCROW_HOLD 绝对值之和),
          "node_paid_edg": Decimal,
          "platform_fee_edg": Decimal,
          "total_bytes": int (本月 we_proxy_sessions 流量),
          "session_count": int,
          "ledger_count": int (3 倍 session_count · 每 session 3 条 entry),
        }
    """
    # period_yyyymm "2026-05" → 月初 / 下月初
    year, month = period_yyyymm.split("-")
    year, month = int(year), int(month)
    period_start = f"{year:04d}-{month:02d}-01"
    if month == 12:
        period_end = f"{year + 1:04d}-01-01"
    else:
        period_end = f"{year:04d}-{month + 1:02d}-01"

    # 1. ledger 聚合 (按 type 拆 · 客户/节点/平台)
    # 客户扣款 = SUM(amount) WHERE account_id=客户 AND type=ESCROW_HOLD AND workload_id 是 proxy_*
    ledger_rows = s.execute(text("""
        SELECT type, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
        FROM we_ledger
        WHERE workload_id LIKE :wid_pattern
          AND created_at >= :since
          AND created_at < :until
          AND (
              (account_id = :aid AND type = 'ESCROW_HOLD')
              OR (type IN ('REWARD', 'PLATFORM_FEE') AND workload_id IN (
                  SELECT workload_id FROM we_ledger
                  WHERE account_id = :aid AND type = 'ESCROW_HOLD'
                    AND workload_id LIKE :wid_pattern
                    AND created_at >= :since AND created_at < :until
              ))
          )
        GROUP BY type
    """), {
        "aid": account_id,
        "wid_pattern": f"{_pattern_for_biz(business_type)}_%",
        "since": period_start,
        "until": period_end,
    }).fetchall()

    by_type: dict = {}
    total_count = 0
    for r in ledger_rows:
        d = dict(r._mapping)
        by_type[d["type"]] = {
            "n": int(d["n"] or 0),
            "total": Decimal(str(d["total"] or 0)),
        }
        total_count += int(d["n"] or 0)

    amount_edg = abs(by_type.get("ESCROW_HOLD", {}).get("total", Decimal("0")))
    node_paid = by_type.get("REWARD", {}).get("total", Decimal("0"))
    platform_fee = by_type.get("PLATFORM_FEE", {}).get("total", Decimal("0"))
    session_count = by_type.get("ESCROW_HOLD", {}).get("n", 0)

    # 2. we_proxy_sessions 流量聚合 (容错 · 该表是 raw SQL 建)
    total_bytes = 0
    if business_type == "ip_proxy":
        try:
            row = s.execute(text("""
                SELECT COALESCE(SUM(bytes_up + bytes_down), 0) AS bytes
                FROM we_proxy_sessions
                WHERE client_id = :cid
                  AND closed_at >= :since
                  AND closed_at < :until
            """), {
                "cid": str(account_id),
                "since": period_start,
                "until": period_end,
            }).first()
            total_bytes = int(row[0] if row and row[0] else 0)
        except Exception:
            # we_proxy_sessions 不存在 (sqlite) 或其他 · 容错
            total_bytes = 0

    return {
        "amount_edg": amount_edg,
        "node_paid_edg": node_paid,
        "platform_fee_edg": platform_fee,
        "total_bytes": total_bytes,
        "session_count": session_count,
        "ledger_count": total_count,
    }


def _pattern_for_biz(business_type: str) -> str:
    """business_type → workload_id LIKE 前缀"""
    return {
        "ip_proxy": "proxy",
        "crawl": "crawl",
        "geo_monitor": "geo",
    }.get(business_type, "proxy")


# ════════════════════════════════════════════════════════════════
# CRUD
# ════════════════════════════════════════════════════════════════
def generate_invoice(
    s: Session, *,
    account_id: int,
    period_yyyymm: str,
    business_type: str = "ip_proxy",
    contract_id: Optional[int] = None,
    auto_issue: bool = False,
    due_days: int = 14,
) -> dict:
    """生成账单 · 自动聚合 ledger + 流量

    幂等: 同 (account_id, period_yyyymm, business_type) 已存在则更新金额 (重新聚合)
    可选 auto_issue: status=draft → issued · 设 due_at = generated_at + due_days

    Returns:
        invoice dict (含 id / amounts / status)
    """
    if business_type not in {"ip_proxy", "crawl", "geo_monitor"}:
        raise ValueError(f"business_type 不合法: {business_type}")

    # 聚合
    agg = _aggregate_period(s, account_id=account_id,
                            period_yyyymm=period_yyyymm,
                            business_type=business_type)

    now = datetime.utcnow()
    from platform_v8.storage.repo import business_invoices_t

    # 查是否已存在
    existing = s.execute(text("""
        SELECT id FROM we_business_invoices
        WHERE account_id = :aid
          AND period_yyyymm = :pm
          AND business_type = :bt
    """), {
        "aid": account_id, "pm": period_yyyymm, "bt": business_type,
    }).first()

    if existing:
        invoice_id = int(existing[0])
        # 已存在 · 更新金额 (status 不动 · 已 issued/paid 的就不重算)
        s.execute(
            business_invoices_t.update()
            .where(business_invoices_t.c.id == invoice_id)
            .where(business_invoices_t.c.status == "draft")  # 只更新 draft
            .values(
                amount_edg=agg["amount_edg"],
                node_paid_edg=agg["node_paid_edg"],
                platform_fee_edg=agg["platform_fee_edg"],
                total_bytes=agg["total_bytes"],
                session_count=agg["session_count"],
                contract_id=contract_id,
                updated_at=now,
            )
        )
        logger.info("billing.regenerate_invoice · id=%s account=%s period=%s amount=%s",
                    invoice_id, account_id, period_yyyymm, agg["amount_edg"])
    else:
        # 新建
        from datetime import timedelta
        due_at = now + timedelta(days=due_days) if auto_issue else None
        issued_at = now if auto_issue else None
        status = "issued" if auto_issue else "draft"

        result = s.execute(business_invoices_t.insert().values(
            account_id=account_id,
            contract_id=contract_id,
            period_yyyymm=period_yyyymm,
            business_type=business_type,
            total_bytes=agg["total_bytes"],
            session_count=agg["session_count"],
            amount_edg=agg["amount_edg"],
            node_paid_edg=agg["node_paid_edg"],
            platform_fee_edg=agg["platform_fee_edg"],
            status=status,
            generated_at=now,
            issued_at=issued_at,
            due_at=due_at,
            created_at=now,
            updated_at=now,
        ))
        invoice_id = int(result.inserted_primary_key[0]) if result.inserted_primary_key else 0
        logger.info("billing.create_invoice · id=%s account=%s period=%s amount=%s status=%s",
                    invoice_id, account_id, period_yyyymm, agg["amount_edg"], status)

    return get_invoice(s, invoice_id) or {}


def get_invoice(s: Session, invoice_id: int) -> Optional[dict]:
    row = s.execute(text("""
        SELECT * FROM we_business_invoices WHERE id = :id
    """), {"id": invoice_id}).first()
    return _row_to_dict(row) if row else None


def list_invoices(
    s: Session, *,
    account_id: Optional[int] = None,
    status: Optional[str] = None,
    period_yyyymm: Optional[str] = None,
    business_type: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    where = ["1=1"]
    params: dict = {"lim": limit, "off": offset}
    if account_id is not None:
        where.append("account_id = :aid")
        params["aid"] = account_id
    if status is not None:
        where.append("status = :sts")
        params["sts"] = status
    if period_yyyymm is not None:
        where.append("period_yyyymm = :pm")
        params["pm"] = period_yyyymm
    if business_type is not None:
        where.append("business_type = :bt")
        params["bt"] = business_type

    rows = s.execute(text(f"""
        SELECT * FROM we_business_invoices
        WHERE {' AND '.join(where)}
        ORDER BY period_yyyymm DESC, created_at DESC
        LIMIT :lim OFFSET :off
    """), params).fetchall()
    return [_row_to_dict(r) for r in rows]


# ════════════════════════════════════════════════════════════════
# 状态机
# ════════════════════════════════════════════════════════════════
def issue_invoice(s: Session, invoice_id: int, due_days: int = 14) -> bool:
    """draft → issued · 设 due_at"""
    from datetime import timedelta
    from platform_v8.storage.repo import business_invoices_t
    now = datetime.utcnow()
    result = s.execute(
        business_invoices_t.update()
        .where(business_invoices_t.c.id == invoice_id)
        .where(business_invoices_t.c.status == "draft")
        .values(status="issued",
                issued_at=now,
                due_at=now + timedelta(days=due_days),
                updated_at=now)
    )
    return result.rowcount > 0


def mark_paid(s: Session, invoice_id: int, paid_note: str = "") -> bool:
    """issued → paid (链下转账完成后 admin 手工标)"""
    from platform_v8.storage.repo import business_invoices_t
    now = datetime.utcnow()
    result = s.execute(
        business_invoices_t.update()
        .where(business_invoices_t.c.id == invoice_id)
        .where(business_invoices_t.c.status == "issued")
        .values(status="paid", paid_at=now, notes=paid_note,
                updated_at=now)
    )
    if result.rowcount > 0:
        logger.info("billing.mark_paid · invoice=%s", invoice_id)
    return result.rowcount > 0


def cancel_invoice(s: Session, invoice_id: int, reason: str = "") -> bool:
    """任何状态 → cancelled (作废 · 不可逆)"""
    from platform_v8.storage.repo import business_invoices_t
    result = s.execute(
        business_invoices_t.update()
        .where(business_invoices_t.c.id == invoice_id)
        .where(business_invoices_t.c.status != "paid")  # 已付不能撤
        .values(status="cancelled",
                notes=f"cancelled: {reason}" if reason else "cancelled",
                updated_at=datetime.utcnow())
    )
    return result.rowcount > 0
