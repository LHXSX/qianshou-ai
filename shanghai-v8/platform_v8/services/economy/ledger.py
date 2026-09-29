"""
账本业务 · escrow / reward / refund / withdraw / deposit

设计要点 (考虑全链路):
  1. 所有"动钱"动作都是一条 LedgerEntry · append-only
  2. idempotent_key 规范: <action>:<workload_id|shard_id|...> 防重复
  3. 每次写完同步刷新 we_accounts.balance (cache · 单一真相在 ledger)
  4. 链路 4 用 escrow_hold (提任务时锁钱)
     链路 5 用 reward (节点完成) + escrow_release (任务成功)
     链路 5 用 refund (任务失败退钱)
     链路 6 用 withdraw (用户提现)
     admin 用 deposit (给用户充值)
"""
from __future__ import annotations
import logging
from decimal import Decimal

from sqlalchemy.orm import Session
from sqlalchemy import select, update

from platform_v8.core import LedgerEntry, LedgerType
from platform_v8.storage.repo import (
    LedgerRepo, IdempotentConflict,
    accounts_t, ledger_t,
)

logger = logging.getLogger(__name__)

# QS-19 · 与 contracts/v1/ledger.schema.json beneficiary.basis /
# contracts/v1/result.schema.json billing.basis 逐字相同。非法值记 ERROR 并存 NULL，不拦入账。
LEDGER_BASIS = frozenset({
    "node_compute",
    "platform_llm_forward",
    "platform_relay",
    "none",
})


def _clean_basis(basis: str | None) -> str | None:
    if basis is None or str(basis).strip() == "":
        return None
    value = str(basis).strip()
    if value in LEDGER_BASIS:
        return value
    logger.error("ledger basis not in contract enum · got=%r · stored NULL", basis)
    return None


def reward_basis_for_task(task_type: str | None) -> str:
    """Node-payout path only: llm_chat is platform-forwarded; everything else is node compute."""
    if str(task_type or "") == "llm_chat":
        return "platform_llm_forward"
    return "node_compute"


def settlement_round_key(prefix: str, workload_id: str, resume_count: int = 0) -> str:
    """Build a stable ledger idempotency key for the active workload round."""
    round_n = max(0, int(resume_count or 0))
    return f"{prefix}:{workload_id}" if round_n == 0 else f"{prefix}:{workload_id}:r{round_n}"


# ── 内部 helper · 写完后刷新 we_accounts.balance ─────
def _refresh_balance_cache(s: Session, account_id: int) -> Decimal:
    """从 ledger SUM 重算余额 · 写入 we_accounts.balance (cache)"""
    new_balance = LedgerRepo.sum_balance(s, account_id)
    s.execute(
        update(accounts_t).where(accounts_t.c.id == account_id)
        .values(balance=new_balance)
    )
    return new_balance


# ════════════════════════════════════════════════════════════════════
# escrow_hold · 提交任务时锁住 budget (链路 4)
# ════════════════════════════════════════════════════════════════════
def escrow_hold(s: Session, *, account_id: int, amount: Decimal,
                workload_id: str, note: str = "",
                idempotent_key: str | None = None) -> LedgerEntry:
    """
    锁住 amount (写一条 ESCROW_HOLD · amount 为负 · 余额减少)

    幂等键: escrow:{workload_id}（断点续跑可传 escrow:{wid}:r{n}）
    """
    if amount <= 0:
        raise ValueError("amount 必须 > 0")
    key = idempotent_key or f"escrow:{workload_id}"
    existing = s.execute(
        select(ledger_t.c.id).where(ledger_t.c.idempotent_key == key)
    ).first()
    if existing is not None:
        logger.info("escrow_hold idempotent: %s", key)
        return LedgerEntry(
            account_id=account_id,
            type=LedgerType.ESCROW_HOLD,
            amount=-amount,
            workload_id=workload_id,
            idempotent_key=key,
            note=note,
        )
    # The prior read-then-insert sequence let two concurrent submits both see
    # the same balance.  Claim funds with a conditional UPDATE instead; row
    # locking makes the operation atomic on PostgreSQL and SQLite.
    reserved = s.execute(
        update(accounts_t)
        .where(accounts_t.c.id == account_id)
        .where(accounts_t.c.balance >= amount)
        .values(balance=accounts_t.c.balance - amount)
    )
    if reserved.rowcount <= 0:
        raise ValueError("余额不足或账号不存在")
    entry = LedgerEntry(
        account_id=account_id,
        type=LedgerType.ESCROW_HOLD,
        amount=-amount,                       # 负数 = 扣减
        workload_id=workload_id,
        idempotent_key=key,
        note=note or f"提交任务托管金 ({str(workload_id)[:8]})",
    )
    try:
        LedgerRepo.write(s, entry)
    except IdempotentConflict:
        # A duplicate key must not consume funds again.  This path is only
        # expected for an application retry in the same transaction boundary.
        raise
    return entry


# ════════════════════════════════════════════════════════════════════
# escrow_release · 任务成功完成 · 把托管金转给"任务方完成"账本 (链路 5)
# ════════════════════════════════════════════════════════════════════
def escrow_release(s: Session, *, account_id: int, amount: Decimal,
                   workload_id: str) -> LedgerEntry:
    """
    释放托管 (写一条 ESCROW_RELEASE · amount 为 0 · 仅记账标记)

    幂等键: release:{workload_id}

    注意: amount 这里不影响 balance · 因为 escrow_hold 已经扣过钱了
    这条只是标记"该 workload 的 escrow 已释放" (admin 审计追溯用)
    """
    key = f"release:{workload_id}"
    entry = LedgerEntry(
        account_id=account_id,
        type=LedgerType.ESCROW_RELEASE,
        amount=Decimal("0"),                  # 不影响 balance
        workload_id=workload_id,
        idempotent_key=key,
        note=f"托管释放 ({str(workload_id)[:8]} · 实际支出 {amount})",
        metadata={"actual_spend": str(amount)},
    )
    try:
        LedgerRepo.write(s, entry)
    except IdempotentConflict:
        logger.info("escrow_release idempotent: %s", key)
    return entry


# ════════════════════════════════════════════════════════════════════
# reward · 节点完成任务 · 给 node owner 加钱 (链路 5)
# ════════════════════════════════════════════════════════════════════
def reward(s: Session, *, worker_owner_id: int, amount: Decimal,
           workload_id: str, shard_id: str | None = None,
           note: str = "",
           idempotent_suffix: str = "",
           worker_id: str | None = None,
           basis: str | None = None) -> LedgerEntry:
    """
    给节点 owner 加奖励

    幂等键: reward:{workload_id}:{shard_id or 'all'}[:{suffix}]
       suffix 用于同一 workload 写多笔 (e.g. 三方分润 · 节点 / 平台 / 渠道)
    QS-19: basis / worker_id 可空，不进入幂等键。
    """
    if amount <= 0:
        raise ValueError("amount 必须 > 0")
    # 2026-05-18 · 三方分润支持: suffix 区分 (节点 / 平台 / 渠道) 避免幂等冲突
    base = f"reward:{workload_id}:{shard_id or 'all'}"
    key = f"{base}:{idempotent_suffix}" if idempotent_suffix else base
    entry = LedgerEntry(
        account_id=worker_owner_id,
        type=LedgerType.REWARD,
        amount=amount,                        # 正数 = 入账
        workload_id=workload_id,
        shard_id=shard_id,
        basis=_clean_basis(basis),
        worker_id=worker_id,
        idempotent_key=key,
        note=note or f"节点完成奖励 ({str(workload_id)[:8]})",
    )
    try:
        LedgerRepo.write(s, entry)
    except IdempotentConflict:
        logger.info("reward idempotent: %s", key)
    _refresh_balance_cache(s, worker_owner_id)
    return entry


# ════════════════════════════════════════════════════════════════════
# refund · 任务失败 / 取消 · 退钱给任务方 (链路 4 取消 + 链路 5 失败)
# ════════════════════════════════════════════════════════════════════
def refund(s: Session, *, account_id: int, amount: Decimal,
           workload_id: str, reason: str = "",
           idempotent_key: str | None = None) -> LedgerEntry:
    """
    退款 (写一条 REFUND · amount 为正 · 余额加)

    幂等键: refund:{workload_id}（断点续跑后取消可传 refund:{wid}:r{n}）
    """
    if amount <= 0:
        raise ValueError("amount 必须 > 0")
    key = idempotent_key or f"refund:{workload_id}"
    entry = LedgerEntry(
        account_id=account_id,
        type=LedgerType.REFUND,
        amount=amount,                        # 正数 = 入账
        workload_id=workload_id,
        idempotent_key=key,
        note=f"任务退款 ({str(workload_id)[:8]} · {reason})",
        metadata={"reason": reason},
    )
    try:
        LedgerRepo.write(s, entry)
    except IdempotentConflict:
        logger.info("refund idempotent: %s", key)
    _refresh_balance_cache(s, account_id)
    return entry


# ════════════════════════════════════════════════════════════════════
# deposit · admin 给用户充值 (链路 4 dev/admin 用)
# ════════════════════════════════════════════════════════════════════
def deposit(s: Session, *, account_id: int, amount: Decimal,
            idempotent_key: str, note: str = "") -> LedgerEntry:
    """admin 用 · 给用户加钱"""
    if amount <= 0:
        raise ValueError("amount 必须 > 0")
    entry = LedgerEntry(
        account_id=account_id,
        type=LedgerType.DEPOSIT,
        amount=amount,
        idempotent_key=idempotent_key,
        note=note or "管理员充值",
    )
    try:
        LedgerRepo.write(s, entry)
    except IdempotentConflict:
        logger.info("deposit idempotent: %s", idempotent_key)
    _refresh_balance_cache(s, account_id)
    return entry


# ════════════════════════════════════════════════════════════════════
# withdraw · 用户提现 (链路 6)
# ════════════════════════════════════════════════════════════════════
def withdraw(s: Session, *, account_id: int, amount: Decimal,
             idempotent_key: str, note: str = "") -> LedgerEntry:
    """
    提现 (检查余额 + 写 WITHDRAW · amount 为负)
    """
    if amount <= 0:
        raise ValueError("amount 必须 > 0")
    balance = LedgerRepo.sum_balance(s, account_id)
    if balance < amount:
        raise ValueError(f"余额不足 (当前 {balance} · 需 {amount})")
    entry = LedgerEntry(
        account_id=account_id,
        type=LedgerType.WITHDRAW,
        amount=-amount,
        idempotent_key=idempotent_key,
        note=note or "用户提现",
    )
    try:
        LedgerRepo.write(s, entry)
    except IdempotentConflict:
        logger.info("withdraw idempotent: %s", idempotent_key)
    _refresh_balance_cache(s, account_id)
    return entry


# ════════════════════════════════════════════════════════════════════
# W5 (2026-05-26) · transfer · 即时三方分账
# 用于 post-paid 场景 (SESSION/PULL 业务实际消费后结算)
# 客户扣钱 → 节点拿大头 → 平台抽 fee
# 不走 escrow_hold/release · 直接 ESCROW_HOLD type 即时扣 (语义: 客户预扣 + 即时消费)
# ════════════════════════════════════════════════════════════════════
def transfer(
    s: Session,
    *,
    client_account_id: int,
    worker_owner_id: int,
    platform_account_id: int,
    total_amount: Decimal,
    platform_fee_pct: Decimal,
    workload_id: str,
    shard_id: str | None = None,
    note: str = "",
) -> dict:
    """即时三方分账 · 原子写 3 条 ledger entry

    流程:
      1. 客户扣 total_amount (ESCROW_HOLD · 负数)
      2. 节点拿 total_amount × (1 - fee_pct) (REWARD)
      3. 平台拿 total_amount × fee_pct (PLATFORM_FEE)

    幂等键: transfer:{workload_id}:{shard_id or 'all'}
    幂等冲突时 · 视作已完成 (业务幂等)

    Returns:
        {"client_deducted": Decimal, "node_paid": Decimal, "platform_fee": Decimal}

    Raises:
        ValueError: amount<=0 / fee_pct 不在 [0,100]
    """
    if total_amount <= 0:
        raise ValueError("total_amount 必须 > 0")
    if not (Decimal("0") <= platform_fee_pct <= Decimal("100")):
        raise ValueError(f"platform_fee_pct 必须在 [0,100] · 收到 {platform_fee_pct}")

    fee_amount = (total_amount * platform_fee_pct / Decimal("100")).quantize(Decimal("0.0001"))
    node_amount = (total_amount - fee_amount).quantize(Decimal("0.0001"))

    base_key = f"transfer:{workload_id}:{shard_id or 'all'}"
    note_prefix = note or f"transfer ({str(workload_id)[:8]})"

    # 1. 客户扣钱 (用 ESCROW_HOLD type · 即时扣 · 不写 release 配对)
    client_entry = LedgerEntry(
        account_id=client_account_id,
        type=LedgerType.ESCROW_HOLD,
        amount=-total_amount,
        workload_id=workload_id,
        shard_id=shard_id,
        idempotent_key=f"{base_key}:client",
        note=f"{note_prefix} · 客户消费",
    )
    try:
        LedgerRepo.write(s, client_entry)
    except IdempotentConflict:
        logger.info("transfer.client idempotent: %s", client_entry.idempotent_key)
    _refresh_balance_cache(s, client_account_id)

    # 2. 节点拿钱
    node_entry = LedgerEntry(
        account_id=worker_owner_id,
        type=LedgerType.REWARD,
        amount=node_amount,
        workload_id=workload_id,
        shard_id=shard_id,
        idempotent_key=f"{base_key}:node",
        note=f"{note_prefix} · 节点分润 ({100 - int(platform_fee_pct)}%)",
    )
    try:
        LedgerRepo.write(s, node_entry)
    except IdempotentConflict:
        logger.info("transfer.node idempotent: %s", node_entry.idempotent_key)
    _refresh_balance_cache(s, worker_owner_id)

    # 3. 平台抽 fee
    if fee_amount > 0:
        platform_entry = LedgerEntry(
            account_id=platform_account_id,
            type=LedgerType.PLATFORM_FEE,
            amount=fee_amount,
            workload_id=workload_id,
            shard_id=shard_id,
            idempotent_key=f"{base_key}:platform",
            note=f"{note_prefix} · 平台抽成 ({int(platform_fee_pct)}%)",
        )
        try:
            LedgerRepo.write(s, platform_entry)
        except IdempotentConflict:
            logger.info("transfer.platform idempotent: %s", platform_entry.idempotent_key)
        _refresh_balance_cache(s, platform_account_id)

    logger.info("ledger.transfer · workload=%s client=%s -%s node=%s +%s platform=%s +%s",
                str(workload_id)[:12], client_account_id, total_amount,
                worker_owner_id, node_amount,
                platform_account_id, fee_amount)
    return {
        "client_deducted": total_amount,
        "node_paid": node_amount,
        "platform_fee": fee_amount,
    }
