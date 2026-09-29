"""
采集任务派发 (节点视角)

接口:
  - pull_subtasks: 节点要任务 · 返回 N 条 SubtaskAssign · 写 lease
  - complete_subtask: 节点报完成 · 若 verify_level=2 触发双跑分支
  - fail_subtask: 节点报失败 · 释放 lease · 失败计数+1 (满 3 次标 failed)

关键点:
  - pull 用 FOR UPDATE SKIP LOCKED 防多节点抢同一条
  - node_id 在 DB 是 UUID 类型 · 在传参时用 ::uuid 强转
  - verify_level=2 分支: 首跑标 pending_verify · 二跑比 hash · 一致才双方进账
"""
from __future__ import annotations
import logging
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.services.crawl.schemas import (
    CompleteIn,
    FailIn,
    PullIn,
    PullOut,
    SubtaskAssign,
)
from platform_v8.services.economy.ledger import reward

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
LEASE_DURATION = timedelta(minutes=2)


# ════════════════════════════════════════════════════════════════════
# pull · 节点拉任务 (核心 · 用 FOR UPDATE SKIP LOCKED 防并发抢)
# ════════════════════════════════════════════════════════════════════
def pull_subtasks(s: Session, *, pull_in: PullIn) -> PullOut:
    # 1. 校验节点 consent
    consent = s.execute(
        text(
            "SELECT max_concurrency, is_active "
            "FROM we_crawl_node_consent WHERE node_id = CAST(:nid AS uuid)"
        ),
        {"nid": pull_in.node_id},
    ).mappings().first()
    if not consent or not consent["is_active"]:
        return PullOut(assignments=[])

    max_count = min(pull_in.max_count, consent["max_concurrency"], 8)

    # 2. SKIP LOCKED · 抢 N 条
    #    pending_verify 优先 (DESC 排序时 'pending_verify' > 'pending')
    #    verify 任务排除已经被同节点跑过的 (primary_by_node != self)
    rows = s.execute(
        text(
            "WITH picked AS ( "
            "  SELECT s.id, s.status AS s_status, s.primary_by_node "
            "  FROM we_crawl_subtasks s "
            "  JOIN we_crawl_orders o ON o.id = s.order_id "
            "  WHERE s.status IN ('pending', 'pending_verify') "
            "    AND o.status = 'running' "
            "    AND (s.status = 'pending' "
            "         OR s.primary_by_node IS NULL "
            "         OR s.primary_by_node <> CAST(:nid AS uuid)) "
            "    AND (CAST(:filter AS BIGINT) IS NULL "
            "         OR (SELECT datasource_id FROM we_crawl_recipes "
            "             WHERE id = o.recipe_id) = CAST(:filter AS BIGINT)) "
            "  ORDER BY s.status DESC, o.priority DESC, s.created_at ASC "
            "  LIMIT :max_count "
            "  FOR UPDATE OF s SKIP LOCKED "
            ") "
            "UPDATE we_crawl_subtasks AS sub "
            "SET status = 'leased', "
            "    leased_by_node = CAST(:nid AS uuid), "
            "    leased_at = NOW(), "
            "    lease_expires_at = NOW() + (:lease_min || ' min')::INTERVAL, "
            "    attempts = sub.attempts + 1 "
            "FROM picked p "
            "WHERE sub.id = p.id "
            "RETURNING sub.id AS subtask_id, sub.order_id, sub.params_json, "
            "          sub.lease_expires_at, p.s_status AS prev_status"
        ),
        {
            "nid": pull_in.node_id,
            "max_count": max_count,
            "filter": pull_in.datasource_filter,
            "lease_min": int(LEASE_DURATION.total_seconds() / 60),
        },
    ).mappings().all()

    if not rows:
        s.commit()
        return PullOut(assignments=[])

    # 3. 一次性查所有 recipes (避免 N+1)
    order_ids = list({r["order_id"] for r in rows})
    recipes = s.execute(
        text(
            "SELECT o.id AS order_id, r.id AS recipe_id, r.parser_type, "
            "       r.url_template, r.method, r.headers_json, r.timeout_ms, "
            "       r.parser_config "
            "FROM we_crawl_orders o "
            "JOIN we_crawl_recipes r ON r.id = o.recipe_id "
            "WHERE o.id = ANY(:ids)"
        ),
        {"ids": order_ids},
    ).mappings().all()
    recipe_by_order = {r["order_id"]: dict(r) for r in recipes}

    assignments = []
    for row in rows:
        r = recipe_by_order[row["order_id"]]
        params = row["params_json"]
        if isinstance(params, str):
            import json as _json
            params = _json.loads(params)
        assignments.append(
            SubtaskAssign(
                subtask_id=row["subtask_id"],
                order_id=row["order_id"],
                recipe_id=r["recipe_id"],
                parser_type=r["parser_type"],
                url_template=r["url_template"],
                method=r["method"],
                headers_json=r["headers_json"] or {},
                timeout_ms=r["timeout_ms"],
                parser_config=r["parser_config"] or {},
                params_json=params or {},
                lease_expires_at=row["lease_expires_at"],
                is_verify_run=(row["prev_status"] == "pending_verify"),
            )
        )

    s.commit()
    logger.info(
        "crawl_pull · node=%s assigned=%s (max_count=%s)",
        pull_in.node_id, len(assignments), max_count,
    )
    return PullOut(assignments=assignments)


# ════════════════════════════════════════════════════════════════════
# complete · 节点报结果 (含 verify 分支)
# ════════════════════════════════════════════════════════════════════
def complete_subtask(s: Session, *, complete_in: CompleteIn) -> dict:
    # 1. 锁行 · 校验租约
    row = s.execute(
        text(
            "SELECT s.id, s.order_id, s.status, s.leased_by_node, "
            "       s.primary_by_node, s.result_oss_url, s.result_hash, "
            "       o.verify_level, o.unit_price_edg, o.customer_id, "
            "       o.platform_fee_pct "
            "FROM we_crawl_subtasks s "
            "JOIN we_crawl_orders o ON o.id = s.order_id "
            "WHERE s.id = :id FOR UPDATE"
        ),
        {"id": complete_in.subtask_id},
    ).mappings().first()
    if not row:
        raise ValueError(f"subtask {complete_in.subtask_id} 不存在")
    if row["status"] != "leased":
        raise ValueError(f"状态 {row['status']} 不可 complete")
    if str(row["leased_by_node"]) != complete_in.node_id:
        raise PermissionError(f"租约不属于节点 {complete_in.node_id}")

    # 判定本次是不是 verify run (primary_by_node 已存 + 非同人)
    is_verify_completion = (
        row["verify_level"] == 2
        and row["primary_by_node"] is not None
        and str(row["primary_by_node"]) != complete_in.node_id
    )
    is_first_run_v2 = row["verify_level"] == 2 and row["primary_by_node"] is None

    if is_first_run_v2:
        # ── 双跑 · 第一次完成 · 存为 primary · 标 pending_verify · 等下一节点 ──
        s.execute(
            text(
                "UPDATE we_crawl_subtasks "
                "SET status='pending_verify', "
                "    primary_by_node=CAST(:nid AS uuid), "
                "    result_oss_url=:url, result_hash=:hash, "
                "    result_size_bytes=:size, "
                "    leased_by_node=NULL, leased_at=NULL, lease_expires_at=NULL "
                "WHERE id = :id"
            ),
            {
                "id": complete_in.subtask_id,
                "nid": complete_in.node_id,
                "url": complete_in.result_oss_url,
                "hash": complete_in.result_hash,
                "size": complete_in.result_size_bytes,
            },
        )
        s.commit()
        logger.info(
            "crawl_complete · 首跑 · subtask=%s · primary=%s · 等校验",
            complete_in.subtask_id, complete_in.node_id,
        )
        return {"ok": True, "stage": "pending_verify"}

    if is_verify_completion:
        # ── 双跑 · 第二次完成 · 比 hash ──
        if row["result_hash"] != complete_in.result_hash:
            # 哈希不一致 · 标 pending 重投池 (primary 节点不进账)
            s.execute(
                text(
                    "UPDATE we_crawl_subtasks "
                    "SET status='pending', "
                    "    result_oss_url=NULL, result_hash=NULL, "
                    "    primary_by_node=NULL, "
                    "    leased_by_node=NULL, leased_at=NULL, lease_expires_at=NULL, "
                    "    verify_result_oss_url=:vurl, verify_result_hash=:vhash, "
                    "    verify_by_node=CAST(:vnode AS uuid), "
                    "    error_msg='verify_mismatch' "
                    "WHERE id = :id"
                ),
                {
                    "id": complete_in.subtask_id,
                    "vurl": complete_in.result_oss_url,
                    "vhash": complete_in.result_hash,
                    "vnode": complete_in.node_id,
                },
            )
            s.commit()
            logger.warning(
                "crawl_complete · verify mismatch · subtask=%s · 重投池",
                complete_in.subtask_id,
            )
            return {"ok": False, "stage": "verify_mismatch"}
        # 一致 · 双方进账
        # primary 已经在第一次没付 (因为 pending_verify) · 现在补
        primary_node = str(row["primary_by_node"])
        _mark_done(s, complete_in, verify_node=complete_in.node_id)
        _pay_node(s, row, complete_in.subtask_id, primary_node, is_verify=False)
        _pay_node(s, row, complete_in.subtask_id, complete_in.node_id, is_verify=True)
        s.commit()
    else:
        # ── 单跑 · 直接 done + 进账 ──
        _mark_done(s, complete_in, verify_node=None)
        _pay_node(s, row, complete_in.subtask_id, complete_in.node_id, is_verify=False)
        s.commit()

    # 4. 检查 order 是否全完成 · 触发聚合
    _maybe_finalize_order(s, row["order_id"])
    return {"ok": True, "stage": "done"}


def _mark_done(s: Session, complete_in: CompleteIn,
               *, verify_node: str | None) -> None:
    if verify_node is not None:
        # 双跑成功 · 主结果保留 · 把 verify 字段也填上
        s.execute(
            text(
                "UPDATE we_crawl_subtasks "
                "SET status='done', "
                "    verify_result_oss_url=:vurl, verify_result_hash=:vhash, "
                "    verify_by_node=CAST(:vnode AS uuid), "
                "    completed_at=NOW(), "
                "    leased_by_node=NULL, lease_expires_at=NULL "
                "WHERE id = :id"
            ),
            {
                "id": complete_in.subtask_id,
                "vurl": complete_in.result_oss_url,
                "vhash": complete_in.result_hash,
                "vnode": verify_node,
            },
        )
    else:
        # 单跑 · 直接写所有字段
        s.execute(
            text(
                "UPDATE we_crawl_subtasks "
                "SET status='done', "
                "    result_oss_url=:url, result_hash=:hash, "
                "    result_size_bytes=:size, "
                "    completed_at=NOW(), "
                "    leased_by_node=NULL, lease_expires_at=NULL "
                "WHERE id = :id"
            ),
            {
                "id": complete_in.subtask_id,
                "url": complete_in.result_oss_url,
                "hash": complete_in.result_hash,
                "size": complete_in.result_size_bytes,
            },
        )

    # 更新 order completed_count
    s.execute(
        text(
            "UPDATE we_crawl_orders SET completed_count = completed_count + 1 "
            "WHERE id = (SELECT order_id FROM we_crawl_subtasks WHERE id = :id)"
        ),
        {"id": complete_in.subtask_id},
    )


def _pay_node(s: Session, row: dict, subtask_id: int, node_id: str,
              *, is_verify: bool) -> None:
    """给指定节点 owner 发报酬 + 写流水"""
    owner = s.execute(
        text("SELECT owner_id FROM we_workers WHERE id = CAST(:nid AS uuid)"),
        {"nid": node_id},
    ).scalar()
    if owner is None:
        logger.warning("节点 %s 无 owner_id · 跳过进账", node_id)
        return

    final_unit = Decimal(str(row["unit_price_edg"]))
    fee_pct = Decimal(str(row["platform_fee_pct"]))
    node_amount = (
        final_unit * (Decimal("100") - fee_pct) / Decimal("100")
    ).quantize(Decimal("0.0001"))

    reward(
        s,
        worker_owner_id=owner,
        amount=node_amount,
        workload_id=f"crawl_subtask_{subtask_id}",
        shard_id="verify" if is_verify else "primary",
        note=f"采集子任务 #{subtask_id} 报酬 ({'校验' if is_verify else '首跑'})",
    )
    s.execute(
        text(
            "INSERT INTO we_crawl_payouts "
            "(subtask_id, order_id, node_id, account_id, amount_edg, is_verify_run) "
            "VALUES (:sid, :oid, CAST(:nid AS uuid), :aid, :amt, :verify)"
        ),
        {
            "sid": subtask_id,
            "oid": row["order_id"],
            "nid": node_id,
            "aid": owner,
            "amt": node_amount,
            "verify": is_verify,
        },
    )


def _maybe_finalize_order(s: Session, order_id: int) -> None:
    """所有 subtask 落定 · 触发聚合"""
    pending = s.execute(
        text(
            "SELECT COUNT(*) FROM we_crawl_subtasks "
            "WHERE order_id = :id AND status IN ('pending','leased','pending_verify')"
        ),
        {"id": order_id},
    ).scalar()
    if pending == 0:
        from platform_v8.services.crawl.orders import aggregate_order_results
        aggregate_order_results(s, order_id=order_id)


# ════════════════════════════════════════════════════════════════════
# fail · 节点报失败
# ════════════════════════════════════════════════════════════════════
def fail_subtask(s: Session, *, fail_in: FailIn) -> dict:
    row = s.execute(
        text(
            "SELECT id, order_id, status, leased_by_node, attempts "
            "FROM we_crawl_subtasks WHERE id = :id FOR UPDATE"
        ),
        {"id": fail_in.subtask_id},
    ).mappings().first()
    if not row:
        raise ValueError(f"subtask {fail_in.subtask_id} 不存在")
    if str(row["leased_by_node"] or "") != fail_in.node_id:
        raise PermissionError(f"租约不属于 {fail_in.node_id}")

    if row["attempts"] >= MAX_ATTEMPTS:
        # 整 fail
        s.execute(
            text(
                "UPDATE we_crawl_subtasks "
                "SET status='failed', error_msg=:err, "
                "    leased_by_node=NULL, lease_expires_at=NULL, "
                "    completed_at=NOW() "
                "WHERE id = :id"
            ),
            {"id": fail_in.subtask_id, "err": fail_in.error_msg[:500]},
        )
        s.execute(
            text(
                "UPDATE we_crawl_orders SET failed_count = failed_count + 1 "
                "WHERE id = :oid"
            ),
            {"oid": row["order_id"]},
        )
        s.commit()
        _maybe_finalize_order(s, row["order_id"])
        logger.warning(
            "crawl_fail · subtask=%s · 满 %s 次 · 标 failed",
            fail_in.subtask_id, MAX_ATTEMPTS,
        )
        return {"ok": True, "stage": "exhausted"}

    # 仍可重试 · 还回池
    s.execute(
        text(
            "UPDATE we_crawl_subtasks "
            "SET status='pending', "
            "    leased_by_node=NULL, leased_at=NULL, lease_expires_at=NULL, "
            "    error_msg=:err "
            "WHERE id = :id"
        ),
        {"id": fail_in.subtask_id, "err": fail_in.error_msg[:500]},
    )
    s.commit()
    return {"ok": True, "stage": "requeued", "attempts": row["attempts"]}
