"""应用市场计费：one_time 安装扣款 / per_use session 结算（幂等）。"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from platform_v8.core import LedgerEntry, LedgerType
from platform_v8.services.auth.admin_lookup import resolve_admin_account_id
from platform_v8.services.economy.ledger import _refresh_balance_cache
from platform_v8.services.marketplace import commission as commission_svc
from platform_v8.storage.repo import AccountRepo, IdempotentConflict, LedgerRepo

logger = logging.getLogger(__name__)


class BillingError(Exception):
    pass


def _write_ledger(s: Session, entry: LedgerEntry) -> bool:
    """写入账本；幂等冲突视为已成功。返回 True=新写入。"""
    try:
        LedgerRepo.write(s, entry)
        return True
    except IdempotentConflict:
        logger.info("marketplace billing idempotent: %s", entry.idempotent_key)
        return False


def charge_app_split(
    s: Session,
    *,
    user_id: int,
    app: dict[str, Any],
    amount: Decimal,
    order_key: str,
    note_prefix: str,
) -> dict[str, Any]:
    """客户扣款 + 作者 80% + 平台 20%。order_key 全局唯一，保证不双扣。"""
    price = Decimal(str(amount)).quantize(Decimal("0.01"))
    if price <= 0:
        return {"charged": 0.0, "split": {"gross": 0, "developer": 0, "platform": 0}, "wrote": False}

    locked = AccountRepo.by_id_for_update(s, user_id)
    if locked is None:
        raise BillingError("账户不存在")
    if Decimal(str(locked.balance)) < price:
        raise BillingError(f"余额不足（需要 {price} EDG），请先充值")

    split = commission_svc.split_app_revenue(price)
    name = app.get("name") or app.get("slug") or "app"
    wrote = _write_ledger(s, LedgerEntry(
        account_id=user_id,
        type=LedgerType.ESCROW_HOLD,
        amount=-split["gross"],
        idempotent_key=f"{order_key}:client",
        note=f"{note_prefix}「{name}」",
    ))
    author_id = app.get("author_id")
    if author_id and split["developer"] > 0:
        _write_ledger(s, LedgerEntry(
            account_id=int(author_id),
            type=LedgerType.REWARD,
            amount=split["developer"],
            idempotent_key=f"{order_key}:author",
            note=f"应用「{name}」作者分成 80%",
        ))
        _refresh_balance_cache(s, int(author_id))
    elif split["developer"] > 0:
        # 官方/无作者：开发者份额归平台
        _write_ledger(s, LedgerEntry(
            account_id=resolve_admin_account_id(),
            type=LedgerType.PLATFORM_FEE,
            amount=split["developer"],
            idempotent_key=f"{order_key}:author_as_platform",
            note=f"应用「{name}」官方份额（无作者）",
        ))
    if split["platform"] > 0:
        _write_ledger(s, LedgerEntry(
            account_id=resolve_admin_account_id(),
            type=LedgerType.PLATFORM_FEE,
            amount=split["platform"],
            idempotent_key=f"{order_key}:platform",
            note=f"应用「{name}」平台抽成 20%",
        ))
    _refresh_balance_cache(s, user_id)
    return {
        "charged": float(split["gross"]),
        "split": {k: float(v) for k, v in split.items()},
        "wrote": wrote,
    }


def charge_one_time_install(
    s: Session, *, user_id: int, app: dict[str, Any],
) -> dict[str, Any]:
    price = Decimal(str(app.get("price") or 0))
    order_key = f"appinstall:{app['id']}:{user_id}"
    return charge_app_split(
        s,
        user_id=user_id,
        app=app,
        amount=price,
        order_key=order_key,
        note_prefix="买断安装应用",
    )


def charge_per_use_session(
    s: Session,
    *,
    user_id: int,
    app: dict[str, Any],
    session_id: int,
) -> dict[str, Any]:
    price = Decimal(str(app.get("price") or 0))
    order_key = f"market:app:{app.get('slug')}:{user_id}:{session_id}:charge"
    return charge_app_split(
        s,
        user_id=user_id,
        app=app,
        amount=price,
        order_key=order_key,
        note_prefix="按次运行应用",
    )


def charge_monthly_subscribe(
    s: Session,
    *,
    user_id: int,
    app: dict[str, Any],
    period_key: str,
) -> dict[str, Any]:
    """月订阅扣款。period_key 建议 YYYYMM，保证同月幂等不双扣。"""
    price = Decimal(str(app.get("price") or 0))
    order_key = f"appmonth:{app['id']}:{user_id}:{period_key}"
    return charge_app_split(
        s,
        user_id=user_id,
        app=app,
        amount=price,
        order_key=order_key,
        note_prefix="月订阅应用",
    )


def charge_app_usage(
    s: Session,
    *,
    user_id: int,
    app: dict[str, Any],
    amount: Decimal,
    order_key: str,
    note: str,
) -> dict[str, Any]:
    """应用内按用量扣款（外链应用如千手创作，按秒/按张变额计费）。

    金额由应用侧按公开价目计算后上报；order_key 全局唯一，重复请求不双扣。
    分账走 charge_app_split：作者 80% + 平台 20%。
    """
    price = Decimal(str(amount)).quantize(Decimal("0.01"))
    if price <= 0:
        raise BillingError("扣款金额必须大于 0")
    return charge_app_split(
        s,
        user_id=user_id,
        app=app,
        amount=price,
        order_key=order_key,
        note_prefix=(note or "应用内消费") + " · ",
    )


def refund_app_usage(
    s: Session,
    *,
    user_id: int,
    app: dict[str, Any],
    order_key: str,
    reason: str,
) -> dict[str, Any]:
    """整笔退回一次应用内扣款：客户 REFUND 入账，作者/平台份额同额冲回。

    按原单的 idempotent_key 找到当初每一条入出账，逐条写反向条目；
    反向条目也带幂等键，重复退款不会双退。只允许整笔退。
    """
    from sqlalchemy import select

    from platform_v8.storage.repo import ledger_t

    suffixes = ("client", "author", "author_as_platform", "platform")
    originals = {}
    for suf in suffixes:
        row = s.execute(
            select(ledger_t).where(ledger_t.c.idempotent_key == f"{order_key}:{suf}")
        ).mappings().first()
        if row:
            originals[suf] = row
    client_row = originals.get("client")
    if client_row is None:
        raise BillingError("找不到这笔扣款，检查 order_key")
    if int(client_row["account_id"]) != int(user_id):
        raise BillingError("这笔扣款不属于当前账号，不能退")

    name = app.get("name") or app.get("slug") or "app"
    gross = -Decimal(str(client_row["amount"]))  # 原单是负数出账
    wrote = _write_ledger(s, LedgerEntry(
        account_id=int(client_row["account_id"]),
        type=LedgerType.REFUND,
        amount=gross,
        idempotent_key=f"{order_key}:refund:client",
        note=f"{reason or '应用内退款'}「{name}」",
    ))
    already = not wrote
    for suf in ("author", "author_as_platform", "platform"):
        row = originals.get(suf)
        if row is None:
            continue
        _write_ledger(s, LedgerEntry(
            account_id=int(row["account_id"]),
            type=LedgerType(row["type"]),
            amount=-Decimal(str(row["amount"])),
            idempotent_key=f"{order_key}:refund:{suf}",
            note=f"应用「{name}」退款份额冲回",
        ))
        _refresh_balance_cache(s, int(row["account_id"]))
    _refresh_balance_cache(s, int(client_row["account_id"]))
    return {
        "refunded": float(gross),
        "already_refunded": already,
    }
