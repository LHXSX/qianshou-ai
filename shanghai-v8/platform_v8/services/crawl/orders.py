"""
采集订单业务层

职责:
  - compute_quote: 纯函数 · 算价 (单测覆盖)
  - create_order: 扣 escrow + 拆 N 个 subtask + 入库 (事务保证)
  - cancel_order: 退未消耗的 escrow (用 ledger.refund helper)
  - aggregate_order_results: 聚合所有 subtask 结果 · 标 done
"""
from __future__ import annotations
import csv
import io
import json
import logging
import os
from decimal import Decimal
from typing import Optional

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.services.crawl.schemas import (
    DEFAULT_PLATFORM_FEE_PCT,
    OrderIn,
    OrderQuoteOut,
    PRIORITY_MULTIPLIER,
    VERIFY_MULTIPLIER,
)
from platform_v8.services.economy.ledger import (
    escrow_hold,
    escrow_release,
    refund,
)

logger = logging.getLogger(__name__)


# ════════════════════════════════════════════════════════════════════
# 算价 (纯函数 · 可测)
# ════════════════════════════════════════════════════════════════════
def compute_quote(
    *,
    recipe_id: int,
    unit_price_edg: Decimal,
    total_count: int,
    verify_level: int,
    priority: int,
    platform_fee_pct: Decimal = DEFAULT_PLATFORM_FEE_PCT,
) -> OrderQuoteOut:
    if total_count <= 0:
        raise ValueError("total_count 必须 > 0")
    if verify_level not in VERIFY_MULTIPLIER:
        raise ValueError(f"verify_level 必须 1 或 2 · 收到 {verify_level}")
    if priority not in PRIORITY_MULTIPLIER:
        raise ValueError(f"priority 必须 0 或 1 · 收到 {priority}")

    vm = VERIFY_MULTIPLIER[verify_level]
    pm = PRIORITY_MULTIPLIER[priority]
    final_unit = (unit_price_edg * vm * pm).quantize(Decimal("0.0001"))
    total = (final_unit * Decimal(total_count)).quantize(Decimal("0.01"))
    node_payout = (
        final_unit * (Decimal("100") - platform_fee_pct) / Decimal("100")
    ).quantize(Decimal("0.0001"))

    return OrderQuoteOut(
        recipe_id=recipe_id,
        total_count=total_count,
        unit_price_edg=unit_price_edg,
        verify_multiplier=vm,
        priority_multiplier=pm,
        final_unit_price_edg=final_unit,
        total_price_edg=total,
        platform_fee_pct=platform_fee_pct,
        node_payout_per_subtask=node_payout,
    )


# ════════════════════════════════════════════════════════════════════
# 从 OSS 拉客户上传的参数文件 · 解析成 list[dict]
# ════════════════════════════════════════════════════════════════════
def _fetch_params_from_oss(params_oss_url: str) -> list[dict]:
    """
    支持 CSV / JSON array / JSONL · 自动判别
    限制 10MB
    """
    with httpx.Client(timeout=30) as c:
        resp = c.get(params_oss_url)
    resp.raise_for_status()
    body = resp.text
    if len(body.encode()) > 10 * 1024 * 1024:
        raise ValueError("参数文件超过 10MB")

    stripped = body.lstrip()
    if stripped.startswith("["):
        data = json.loads(body)
        if not isinstance(data, list):
            raise ValueError("JSON 必须是 array of objects")
        return data
    if stripped.startswith("{"):
        out = []
        for ln in body.splitlines():
            ln = ln.strip()
            if ln:
                out.append(json.loads(ln))
        return out
    # CSV
    reader = csv.DictReader(io.StringIO(body))
    return [dict(row) for row in reader]


# ════════════════════════════════════════════════════════════════════
# 创建订单 · 关键链路 (escrow + 拆单 · 必须事务保证)
# ════════════════════════════════════════════════════════════════════
def create_order(
    s: Session,
    *,
    customer_id: int,
    order_in: OrderIn,
) -> dict:
    # 1. 取配方 · 校验存在且 active
    recipe_row = s.execute(
        text(
            "SELECT id, datasource_id, unit_price_edg, parser_type "
            "FROM we_crawl_recipes WHERE id = :id AND is_active = TRUE"
        ),
        {"id": order_in.recipe_id},
    ).mappings().first()
    if not recipe_row:
        raise ValueError(f"配方 {order_in.recipe_id} 不存在或已下架")

    # 2. 算价
    quote = compute_quote(
        recipe_id=recipe_row["id"],
        unit_price_edg=Decimal(str(recipe_row["unit_price_edg"])),
        total_count=order_in.total_count,
        verify_level=order_in.verify_level,
        priority=order_in.priority,
    )

    # 3. 下载 + 解析 params · 校验数量匹配
    params_list = _fetch_params_from_oss(order_in.params_oss_url)
    if len(params_list) != order_in.total_count:
        raise ValueError(
            f"参数行数 {len(params_list)} 与声明 total_count "
            f"{order_in.total_count} 不一致"
        )

    # 4. 写订单 (status=pending · 拆单后改 running)
    order_id = s.execute(
        text(
            "INSERT INTO we_crawl_orders "
            "(customer_id, recipe_id, title, total_count, concurrency, "
            " verify_level, priority, unit_price_edg, total_price_edg, "
            " params_oss_url, webhook_url, consent_signature) "
            "VALUES "
            "(:customer_id, :recipe_id, :title, :total_count, :concurrency, "
            " :verify_level, :priority, :unit_price, :total_price, "
            " :params_oss_url, :webhook_url, :consent_signature) "
            "RETURNING id"
        ),
        {
            "customer_id": customer_id,
            "recipe_id": order_in.recipe_id,
            "title": order_in.title,
            "total_count": order_in.total_count,
            "concurrency": order_in.concurrency,
            "verify_level": order_in.verify_level,
            "priority": order_in.priority,
            "unit_price": quote.final_unit_price_edg,
            "total_price": quote.total_price_edg,
            "params_oss_url": order_in.params_oss_url,
            "webhook_url": order_in.webhook_url,
            "consent_signature": order_in.consent_signature,
        },
    ).scalar_one()

    # 5. escrow_hold (扣客户余额)
    workload_id = f"crawl_order_{order_id}"
    escrow_hold(
        s,
        account_id=customer_id,
        amount=quote.total_price_edg,
        workload_id=workload_id,
        note=f"采集订单 #{order_id} 托管金 ({order_in.total_count} 条)",
    )

    # 6. 拆 N 个 subtask · 批量 insert
    rows = [
        {
            "order_id": order_id,
            "seq": i,
            "params_json": json.dumps(p, ensure_ascii=False),
        }
        for i, p in enumerate(params_list)
    ]
    if rows:
        s.execute(
            text(
                "INSERT INTO we_crawl_subtasks (order_id, seq, params_json) "
                "VALUES (:order_id, :seq, CAST(:params_json AS jsonb))"
            ),
            rows,
        )

    # 7. 标 order=running
    s.execute(
        text(
            "UPDATE we_crawl_orders "
            "SET status='running', started_at=NOW() "
            "WHERE id = :id"
        ),
        {"id": order_id},
    )

    # 8. W4 (2026-05-26) · 双写统一引擎 · workload(mode=PULL) + N shards · 失败静默
    # 让节点通过 PullRequest 协议拿 crawl 任务 · admin 在统一引擎控制台看进度
    # 老 we_crawl_subtasks 表仍是 truth (verify_level=2 双跑机制依赖) · workload 是统一引擎影子
    try:
        _create_unified_workload_for_crawl_order(
            s,
            order_id=order_id,
            customer_id=customer_id,
            recipe_row=recipe_row,
            quote=quote,
            order_in=order_in,
            params_list=params_list,
        )
    except Exception:
        logger.exception("crawl_order · 写统一引擎影子失败 · 老链路不受影响 · order=%s", order_id)

    s.commit()
    logger.info(
        "crawl_order created · id=%s customer=%s total=%s price=%s",
        order_id, customer_id, order_in.total_count, quote.total_price_edg,
    )
    return {"order_id": order_id, "quote": quote.model_dump(mode="json")}


# ════════════════════════════════════════════════════════════════════
# W4 (2026-05-26) · 统一引擎影子 workload+shards
# 让 crawl 业务接入统一引擎 PULL 模式 · 节点通过 PullRequest 协议拿任务
# 老 we_crawl_subtasks 仍是业务真值 · 这里只是镜像 (admin 视图 + 节点协议)
# ════════════════════════════════════════════════════════════════════
def _resolve_crawl_subtask_script_url() -> str:
    """节点端拉 crawl_subtask.py 脚本的 URL

    复用 platform_v8 的 /api/v8/scripts/{task_type}.py 路由 (节点 executor 已支持)
    """
    base = os.environ.get("V8_PUBLIC_BASE_URL", "") or os.environ.get("PUBLIC_API_BASE", "")
    if base:
        return f"{base.rstrip('/')}/api/v8/scripts/crawl_subtask.py"
    return "/api/v8/scripts/crawl_subtask.py"


def _create_unified_workload_for_crawl_order(
    s: Session,
    *,
    order_id: int,
    customer_id: int,
    recipe_row: dict,
    quote: OrderQuoteOut,
    order_in: OrderIn,
    params_list: list[dict],
) -> None:
    """create_order 末尾调 · 共事务 · 失败上抛但 create_order 捕获静默"""
    from datetime import datetime
    from platform_v8.core import (
        Workload, WorkloadSpec, WorkloadStatus,
        Shard, ShardStatus, ShardMode,
    )
    from platform_v8.storage.repo import WorkloadRepo, ShardRepo

    workload_id = f"crawl_order_{order_id}"  # 跟 escrow_hold 的 workload_id 完全一致

    # W4-phase2 (2026-05-26) · verify_level=2 双跑映射到 redundancy_factor=2
    # PULL 模式不走 lifecycle.start · 这里手工复制 shard 副本 (跟 lifecycle.start 同算法)
    # aggregator._finalize_done 会自动调 anti_cheat.evaluate_redundant_results 比对
    redundancy = max(1, int(order_in.verify_level or 1))

    spec = WorkloadSpec(
        task_type="crawl_subtask",
        # 节点 executor 默认走 script 模式 · 自动 GET code_url 拉脚本跑
        code_url=_resolve_crawl_subtask_script_url(),
        input_kind="params_only",  # 没文件 · 只 params (合作 task_registry InputKind)
        params={
            "crawl_order_id": order_id,
            "recipe_id": int(recipe_row["id"]),
            "datasource_id": int(recipe_row["datasource_id"]),
            "parser_type": recipe_row["parser_type"],
            "verify_level": order_in.verify_level,
            "priority": order_in.priority,
            "concurrency": order_in.concurrency,
            "unit_price_edg": str(quote.final_unit_price_edg),
            "platform_fee_pct": str(quote.platform_fee_pct),
            "webhook_url": order_in.webhook_url or "",
        },
        max_shards=order_in.total_count,
        redundancy_factor=redundancy,  # W4-phase2 · verify_level=2 → redundancy=2
        timeout_s=300,
    )
    wl = Workload(
        id=workload_id,
        owner_id=customer_id,
        name=order_in.title or f"crawl_order_{order_id}",
        spec=spec,
        status=WorkloadStatus.RUNNING,  # 已 escrow + 节点立即可抢
        # total_shards = 业务片数 × 冗余度 (verify_level=2 时翻倍)
        total_shards=order_in.total_count * redundancy,
        budget=quote.total_price_edg,
        created_at=datetime.utcnow(),
        started_at=datetime.utcnow(),
    )
    WorkloadRepo.create(s, wl)

    # 批量建 N 个 canonical shard (mode=PULL, status=PENDING · 等节点 PullRequest 抢)
    # verify_level=2 时 · 每片复制 R-1 份 (replica_index 1..R-1) · planner/anti_cheat 用 replica_of 关联
    import copy as _copy
    shards: list[Shard] = []
    for i, p in enumerate(params_list):
        canonical = Shard(
            workload_id=workload_id,
            index=i,
            total=order_in.total_count * redundancy,
            status=ShardStatus.PENDING,
            mode=ShardMode.PULL,
            metadata={
                "business": "crawl",
                "crawl_order_id": order_id,
                "crawl_seq": i,
                "params": p,                  # 本片业务参数 (节点 runner 用)
                "replica_index": 0,           # W4-phase2 · canonical 标记
                # replica_of 在 lifecycle 复制时填 · 这里先填 canonical.id (循环外赋值)
            },
        )
        canonical.metadata["replica_of"] = canonical.id  # canonical 指向自己
        shards.append(canonical)

        # 副本 1..R-1 (verify_level=2 时 1 个副本)
        for r in range(1, redundancy):
            clone = _copy.deepcopy(canonical)
            from uuid import uuid4 as _uuid4
            clone.id = str(_uuid4())
            clone.metadata = dict(canonical.metadata)   # 浅拷 dict
            clone.metadata["replica_index"] = r
            clone.metadata["replica_of"] = canonical.id  # 指 canonical (跟 anti_cheat 约定)
            shards.append(clone)

    if shards:
        ShardRepo.create_batch(s, shards)
    logger.info(
        "crawl_order · unified workload+shards created · order=%s seqs=%s redundancy=%s total_shards=%s",
        order_id, len(params_list), redundancy, len(shards),
    )


# ════════════════════════════════════════════════════════════════════
# 取消订单 · 退未消耗的 escrow
# ════════════════════════════════════════════════════════════════════
def cancel_order(s: Session, *, order_id: int, customer_id: int) -> dict:
    row = s.execute(
        text(
            "SELECT id, customer_id, status, total_count, completed_count, "
            "       failed_count, unit_price_edg, total_price_edg "
            "FROM we_crawl_orders WHERE id = :id FOR UPDATE"
        ),
        {"id": order_id},
    ).mappings().first()
    if not row:
        raise ValueError(f"订单 {order_id} 不存在")
    if row["customer_id"] != customer_id:
        raise PermissionError("无权操作他人订单")
    if row["status"] not in ("pending", "running"):
        raise ValueError(f"订单状态 {row['status']} 不可取消")

    consumed = (row["completed_count"] + row["failed_count"]) * Decimal(
        str(row["unit_price_edg"])
    )
    refund_amount = Decimal(str(row["total_price_edg"])) - consumed
    if refund_amount < 0:
        refund_amount = Decimal("0")

    # 标 cancelled · 把所有 pending/leased subtask 也标 failed (节点拿到也会失败)
    s.execute(
        text(
            "UPDATE we_crawl_orders SET status='cancelled', completed_at=NOW() "
            "WHERE id = :id"
        ),
        {"id": order_id},
    )
    s.execute(
        text(
            "UPDATE we_crawl_subtasks "
            "SET status='failed', error_msg='order_cancelled', "
            "    completed_at=NOW() "
            "WHERE order_id = :id AND status IN ('pending','leased','pending_verify')"
        ),
        {"id": order_id},
    )

    workload_id = f"crawl_order_{order_id}"
    # 标记 escrow 释放
    if consumed > 0:
        escrow_release(
            s,
            account_id=customer_id,
            amount=consumed,
            workload_id=workload_id,
        )
    else:
        # 没消耗一分钱 · escrow_release 接受 amount=0 (metadata 标记) · 强行写
        escrow_release(
            s,
            account_id=customer_id,
            amount=Decimal("0"),
            workload_id=workload_id,
        )
    # 退款 (用 ledger.refund · 不同幂等键)
    if refund_amount > 0:
        refund(
            s,
            account_id=customer_id,
            amount=refund_amount,
            workload_id=workload_id,
            reason="order_cancelled",
        )

    s.commit()
    logger.info(
        "crawl_order cancelled · id=%s refund=%s consumed=%s",
        order_id, refund_amount, consumed,
    )
    return {
        "ok": True,
        "order_id": order_id,
        "refunded_edg": str(refund_amount),
        "consumed_edg": str(consumed),
    }


# ════════════════════════════════════════════════════════════════════
# 聚合订单结果
# MVP: 仅生成 index JSONL · V2 真聚合到 OSS
# ════════════════════════════════════════════════════════════════════
def aggregate_order_results(s: Session, *, order_id: int) -> str:
    rows = s.execute(
        text(
            "SELECT seq, result_oss_url, result_hash, error_msg "
            "FROM we_crawl_subtasks WHERE order_id = :id ORDER BY seq"
        ),
        {"id": order_id},
    ).mappings().all()

    index = [
        {
            "seq": r["seq"],
            "result_url": r["result_oss_url"],
            "hash": r["result_hash"],
            "error": r["error_msg"],
        }
        for r in rows
    ]
    # MVP: 序列化为 JSON · 不真上传 OSS · stub URL
    _ = json.dumps(index, ensure_ascii=False)
    fake_url = f"local://orders/{order_id}/index.json"

    s.execute(
        text(
            "UPDATE we_crawl_orders SET result_oss_url = :url, "
            "status='done', completed_at=NOW() WHERE id = :id"
        ),
        {"url": fake_url, "id": order_id},
    )
    s.commit()
    logger.info("crawl_order aggregated · id=%s subtasks=%s", order_id, len(rows))
    return fake_url
