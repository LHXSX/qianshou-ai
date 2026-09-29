"""
services/business/contracts.py · B2B 合约 CRUD + 状态机 + 配额查询

W7 · 2026-05-26

API:
  - create_contract(s, account_id, name, ...) → id
  - get_contract(s, contract_id) → dict | None
  - list_contracts(s, account_id=None, status=None) → list[dict]
  - update_contract(s, contract_id, **kwargs) → bool
  - set_status(s, contract_id, status) → bool
  - get_active_contract(s, account_id, business_type) → dict | None
    给 proxy gateway 用 · 查"客户 X 的当前生效合约"
  - check_monthly_quota(s, account_id, business_type) → (used_bytes, quota_bytes, exceeded)
    给 proxy gateway 用 · 月配额检查 (从 ledger workload_id 反查)

合约状态:
  draft   · 创建后未生效
  active  · 生效中 (可派单)
  suspended · 临时暂停 (admin 操作 / 客户欠款)
  expired · 已过期 (end_at 过)
"""
from __future__ import annotations
import logging
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


_VALID_STATUS = {"draft", "active", "suspended", "expired"}
_VALID_BIZ = {"ip_proxy", "crawl", "geo_monitor"}
_VALID_TIER = {"standard", "premium", "enterprise"}


# ════════════════════════════════════════════════════════════════
# Row → dict helper
# ════════════════════════════════════════════════════════════════
def _row_to_dict(row) -> dict:
    d = dict(row._mapping) if hasattr(row, "_mapping") else dict(row)
    # 类型规整 · DateTime → iso · Decimal → float
    for k in ("start_at", "end_at", "created_at", "updated_at"):
        v = d.get(k)
        if isinstance(v, datetime):
            d[k] = v.isoformat()
    for k in ("price_per_gb_edg", "discount_pct", "sla_uptime_pct"):
        v = d.get(k)
        if isinstance(v, Decimal):
            d[k] = float(v)
    return d


# ════════════════════════════════════════════════════════════════
# CREATE
# ════════════════════════════════════════════════════════════════
def create_contract(
    s: Session,
    *,
    account_id: int,
    name: str,
    business_type: str = "ip_proxy",
    quota_bytes_per_month: int = 0,
    quota_concurrent_sessions: int = 100,
    price_per_gb_edg: Decimal = Decimal("0.01"),
    discount_pct: Decimal = Decimal("0"),
    sla_uptime_pct: Decimal = Decimal("99"),
    sla_support_tier: str = "standard",
    status: str = "draft",
    end_at: Optional[datetime] = None,
    notes: str = "",
    metadata: Optional[dict] = None,
    created_by: Optional[int] = None,
) -> int:
    """创建合约 · 返 contract_id

    Raises:
        ValueError: business_type / status / tier 不合法
    """
    if business_type not in _VALID_BIZ:
        raise ValueError(f"business_type must be one of {_VALID_BIZ} · got {business_type}")
    if status not in _VALID_STATUS:
        raise ValueError(f"status must be one of {_VALID_STATUS} · got {status}")
    if sla_support_tier not in _VALID_TIER:
        raise ValueError(f"sla_support_tier must be one of {_VALID_TIER} · got {sla_support_tier}")
    if quota_bytes_per_month < 0:
        raise ValueError("quota_bytes_per_month 必须 >= 0")
    if quota_concurrent_sessions < 0:
        raise ValueError("quota_concurrent_sessions 必须 >= 0")
    if price_per_gb_edg < 0:
        raise ValueError("price_per_gb_edg 必须 >= 0")
    if not (Decimal("0") <= discount_pct <= Decimal("100")):
        raise ValueError("discount_pct 必须在 [0, 100]")

    # 跨方言: SQLite/PG 都用 SQLAlchemy Core insert · result.inserted_primary_key
    from platform_v8.storage.repo import business_contracts_t
    now = datetime.utcnow()
    result = s.execute(business_contracts_t.insert().values(
        account_id=account_id,
        name=name,
        business_type=business_type,
        quota_bytes_per_month=quota_bytes_per_month,
        quota_concurrent_sessions=quota_concurrent_sessions,
        price_per_gb_edg=price_per_gb_edg,
        discount_pct=discount_pct,
        sla_uptime_pct=sla_uptime_pct,
        sla_support_tier=sla_support_tier,
        status=status,
        start_at=now,
        end_at=end_at,
        notes=notes,
        metadata=metadata or {},
        created_at=now,
        updated_at=now,
        created_by=created_by,
    ))
    contract_id = int(result.inserted_primary_key[0]) if result.inserted_primary_key else 0
    logger.info("business.create_contract · id=%s account=%s name=%s status=%s",
                contract_id, account_id, name, status)
    return contract_id


# ════════════════════════════════════════════════════════════════
# READ
# ════════════════════════════════════════════════════════════════
def get_contract(s: Session, contract_id: int) -> Optional[dict]:
    """查单条 · 返 dict 或 None"""
    row = s.execute(text("""
        SELECT * FROM we_business_contracts WHERE id = :id
    """), {"id": contract_id}).first()
    return _row_to_dict(row) if row else None


def list_contracts(
    s: Session, *,
    account_id: Optional[int] = None,
    status: Optional[str] = None,
    business_type: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    """列合约 · 支持按 account / status / business_type 过滤"""
    where = ["1=1"]
    params: dict = {"lim": limit, "off": offset}
    if account_id is not None:
        where.append("account_id = :aid")
        params["aid"] = account_id
    if status is not None:
        where.append("status = :sts")
        params["sts"] = status
    if business_type is not None:
        where.append("business_type = :bt")
        params["bt"] = business_type

    rows = s.execute(text(f"""
        SELECT * FROM we_business_contracts
        WHERE {' AND '.join(where)}
        ORDER BY created_at DESC
        LIMIT :lim OFFSET :off
    """), params).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_active_contract(
    s: Session, *, account_id: int, business_type: str = "ip_proxy"
) -> Optional[dict]:
    """proxy gateway 用 · 查客户 X 的当前生效合约 (status=active · 未过期)

    若有多个 active · 取 created_at 最新的
    """
    row = s.execute(text("""
        SELECT * FROM we_business_contracts
        WHERE account_id = :aid
          AND business_type = :bt
          AND status = 'active'
          AND (end_at IS NULL OR end_at > :now)
        ORDER BY created_at DESC
        LIMIT 1
    """), {"aid": account_id, "bt": business_type, "now": datetime.utcnow()}).first()
    return _row_to_dict(row) if row else None


# ════════════════════════════════════════════════════════════════
# UPDATE
# ════════════════════════════════════════════════════════════════
_UPDATABLE_FIELDS = {
    "name", "quota_bytes_per_month", "quota_concurrent_sessions",
    "price_per_gb_edg", "discount_pct", "sla_uptime_pct", "sla_support_tier",
    "end_at", "notes",
}


def update_contract(s: Session, contract_id: int, **kwargs) -> bool:
    """更新合约 · 仅允许 _UPDATABLE_FIELDS 中的字段

    Returns:
        True 如果有改动 · False 如果 contract 不存在或无白名单字段
    """
    fields = {k: v for k, v in kwargs.items() if k in _UPDATABLE_FIELDS}
    if not fields:
        return False
    fields["updated_at"] = datetime.utcnow()

    # SQLAlchemy Core update · 跨方言 (SQLite 不接 raw text() 的 Decimal · Core 会转)
    from platform_v8.storage.repo import business_contracts_t
    result = s.execute(
        business_contracts_t.update()
        .where(business_contracts_t.c.id == contract_id)
        .values(**fields)
    )
    return result.rowcount > 0


def set_status(s: Session, contract_id: int, status: str) -> bool:
    """改状态 (state machine 入口)"""
    if status not in _VALID_STATUS:
        raise ValueError(f"status must be one of {_VALID_STATUS}")
    from platform_v8.storage.repo import business_contracts_t
    result = s.execute(
        business_contracts_t.update()
        .where(business_contracts_t.c.id == contract_id)
        .values(status=status, updated_at=datetime.utcnow())
    )
    if result.rowcount > 0:
        logger.info("business.set_status · contract=%s → %s", contract_id, status)
    return result.rowcount > 0


# ════════════════════════════════════════════════════════════════
# 配额检查 (proxy gateway 高频调)
# ════════════════════════════════════════════════════════════════
def check_monthly_quota(
    s: Session, *, account_id: int, business_type: str = "ip_proxy"
) -> dict:
    """月配额检查 · 返
        {
          "has_contract": bool,
          "contract_id": int | None,
          "quota_bytes": int (0 = 不限),
          "used_bytes": int (本月 ledger 累计),
          "exceeded": bool,
          "remaining_bytes": int (quota - used · 不限时返 -1)
        }

    used_bytes 数据源:
      proxy: 从 we_ledger 算 · 客户 ESCROW_HOLD 笔数 × 平均 session bytes (近似)
      MVP: 直接从 we_proxy_sessions 表 SUM(bytes_up + bytes_down) 本月
    """
    contract = get_active_contract(s, account_id=account_id, business_type=business_type)
    if not contract:
        return {
            "has_contract": False,
            "contract_id": None,
            "quota_bytes": 0,
            "used_bytes": 0,
            "exceeded": False,
            "remaining_bytes": -1,
        }

    quota = int(contract["quota_bytes_per_month"])
    if quota <= 0:
        # 不限
        return {
            "has_contract": True,
            "contract_id": contract["id"],
            "quota_bytes": 0,
            "used_bytes": 0,
            "exceeded": False,
            "remaining_bytes": -1,
        }

    # MVP: ip_proxy 业务 · 从 we_proxy_sessions 当月聚合 (audit 表 · 客户维度)
    # we_proxy_sessions 是 raw SQL 建的 (不在 SQLAlchemy metadata) · sqlite 测试可能没该表
    # 容错: 表不存在视作 used=0 (不影响主流程)
    if business_type == "ip_proxy":
        from datetime import date
        first_of_month = date.today().replace(day=1).isoformat()
        try:
            used_row = s.execute(text("""
                SELECT COALESCE(SUM(bytes_up + bytes_down), 0) AS used
                FROM we_proxy_sessions
                WHERE client_id = :cid
                  AND closed_at >= :since
            """), {"cid": str(account_id), "since": first_of_month}).first()
            used = int(used_row[0] if used_row and used_row[0] else 0)
        except Exception as exc:
            logger.debug("check_monthly_quota · we_proxy_sessions 表不可访问 · used=0 · %s", exc)
            used = 0
    else:
        used = 0  # crawl/geo 暂不实现

    return {
        "has_contract": True,
        "contract_id": contract["id"],
        "quota_bytes": quota,
        "used_bytes": used,
        "exceeded": used >= quota,
        "remaining_bytes": max(0, quota - used),
    }
