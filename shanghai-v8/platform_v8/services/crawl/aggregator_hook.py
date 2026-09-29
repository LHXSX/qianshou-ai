"""
采集子系统 · aggregator hook (W4-D5 · 2026-05-26)

工作模式:
  - shard 完成/失败 (event_bus 订阅 shard.completed / shard.failed)
  - 只处理 sh.metadata['business']=='crawl' 的 shard
  - shard.completed → 反写 we_crawl_subtasks(status='done', result_oss_url, result_hash)
    + 给节点 owner 写报酬 (_pay_node) + 如全部完成触发 aggregate_order_results
  - shard.failed    → 反写 we_crawl_subtasks(status='failed' if attempts>=3 else 'pending', error_msg)

兼容老 we_crawl_subtasks 表:
  - shard.metadata.crawl_order_id / crawl_seq 反查 we_crawl_subtasks.id (seq+order_id 联合主键?)
  - 实际我们用 (crawl_order_id, crawl_seq) 唯一定位 we_crawl_subtasks 行
  - subtask_id 通过反查得到 (avoiding 在 shard.metadata 双写)

verify_level=2 双跑暂未走统一引擎 redundancy (W4 后续 phase)
"""
from __future__ import annotations
import json
import logging
from decimal import Decimal

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


# ════════════════════════════════════════════════════════════════
# shard.completed · 节点完成 crawl_subtask
# ════════════════════════════════════════════════════════════════
async def on_shard_completed(event) -> None:
    """event_bus 订阅 shard.completed 事件

    event.payload: {
        "workload_id": str,
        "shard_id": str,
        "worker_id": str | None,
        "outcome": "success" | "failure",
    }
    """
    payload = event.payload if hasattr(event, "payload") else (event or {})
    if not isinstance(payload, dict):
        return
    if payload.get("outcome") != "success":
        return

    shard_id = payload.get("shard_id")
    workload_id = payload.get("workload_id")
    if not shard_id or not workload_id:
        return

    import asyncio
    try:
        await asyncio.to_thread(_process_shard_completed_sync, shard_id, workload_id)
    except Exception as exc:
        logger.warning("crawl.aggregator_hook.completed · shard=%s err=%s", str(shard_id)[:8], exc)


# ════════════════════════════════════════════════════════════════
# shard.failed · 节点失败
# ════════════════════════════════════════════════════════════════
async def on_shard_failed(event) -> None:
    payload = event.payload if hasattr(event, "payload") else (event or {})
    if not isinstance(payload, dict):
        return

    shard_id = payload.get("shard_id")
    workload_id = payload.get("workload_id")
    if not shard_id or not workload_id:
        return

    import asyncio
    try:
        await asyncio.to_thread(_process_shard_failed_sync, shard_id, workload_id)
    except Exception as exc:
        logger.warning("crawl.aggregator_hook.failed · shard=%s err=%s", str(shard_id)[:8], exc)


# ════════════════════════════════════════════════════════════════
# 同步主逻辑 (asyncio.to_thread 包)
# ════════════════════════════════════════════════════════════════
def _process_shard_completed_sync(shard_id: str, workload_id: str) -> None:
    """W4-phase2 适配 · 处理 canonical/replica 双跑

    流程:
      1. shard 加 done 标记 (不动 status · 仅记 metadata.replica_done=True)
      2. 如果 verify_level=1 (无 replica) · 直接反写 we_crawl_subtasks done
      3. 如果 verify_level=2 (有 replica_of) ·
         3.1 查同 canonical 的所有副本 · 都 DONE 则 → 比 hash
         3.2 hash 一致 → 反写老表 done · 双方分账
         3.3 hash 不一致 → 标 verify_mismatch · 不付钱
    """
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo

    with db_mod.session_scope() as s:
        sh = ShardRepo.by_id(s, shard_id)
        if sh is None:
            return
        meta = sh.metadata or {}
        if meta.get("business") != "crawl":
            return

        crawl_order_id = meta.get("crawl_order_id")
        crawl_seq = meta.get("crawl_seq")
        if crawl_order_id is None or crawl_seq is None:
            logger.warning("crawl.hook · shard=%s meta 缺 crawl_order_id/seq · 跳过", shard_id[:8])
            return

        # 反查 we_crawl_subtasks 老表 (用 order_id+seq 联合定位)
        row = s.execute(text(
            "SELECT id, order_id, status FROM we_crawl_subtasks "
            "WHERE order_id = :oid AND seq = :seq FOR UPDATE"
        ), {"oid": crawl_order_id, "seq": crawl_seq}).mappings().first()
        if row is None:
            logger.warning("crawl.hook · 老 subtask (order=%s, seq=%s) 不存在 · 跳过",
                           crawl_order_id, crawl_seq)
            return
        if row["status"] in ("done", "failed"):
            return  # 幂等

        # W4-phase2 · 判 redundancy
        replica_of = meta.get("replica_of")
        # 全部同 canonical 的副本
        siblings = []
        if replica_of:
            siblings = _fetch_replica_siblings(s, workload_id=workload_id,
                                               replica_of=replica_of)
        is_redundant = len(siblings) > 1

        if not is_redundant:
            # ─── verify_level=1 · 单跑 · 直接反写 ───
            _commit_done_single(s, sh=sh, row=row, crawl_order_id=crawl_order_id, crawl_seq=crawl_seq)
        else:
            # ─── verify_level=2 · 双跑 · 等所有副本 DONE 后比 hash ───
            done_siblings = [x for x in siblings if x["status"] == "DONE"]
            if len(done_siblings) < len(siblings):
                # 还有副本未完成 · 暂不反写 · 等下次 event
                logger.info("crawl.hook · double-run 等其他副本 · canonical=%s done=%d/%d",
                            str(replica_of)[:8], len(done_siblings), len(siblings))
                return

            # 全副本 DONE · 比 hash (从各 output_ref JSON 解 result_hash · 多数投票)
            verdict = _hash_compare_siblings(done_siblings)
            if verdict["consistent"]:
                _commit_done_with_verify(
                    s, row=row, crawl_order_id=crawl_order_id, crawl_seq=crawl_seq,
                    primary=verdict["primary"], verify=verdict["verify"],
                )
            else:
                _commit_verify_mismatch(
                    s, row=row, crawl_order_id=crawl_order_id, crawl_seq=crawl_seq,
                    siblings=done_siblings,
                )
        s.commit()
        # 检查 order 是否全完成 · 触发聚合
        _maybe_finalize_order(s, crawl_order_id)


def _process_shard_failed_sync(shard_id: str, workload_id: str) -> None:
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo

    with db_mod.session_scope() as s:
        sh = ShardRepo.by_id(s, shard_id)
        if sh is None:
            return
        meta = sh.metadata or {}
        if meta.get("business") != "crawl":
            return

        crawl_order_id = meta.get("crawl_order_id")
        crawl_seq = meta.get("crawl_seq")
        if crawl_order_id is None or crawl_seq is None:
            return

        # 反查 we_crawl_subtasks
        row = s.execute(text(
            "SELECT id, status, attempts FROM we_crawl_subtasks "
            "WHERE order_id = :oid AND seq = :seq FOR UPDATE"
        ), {"oid": crawl_order_id, "seq": crawl_seq}).mappings().first()
        if row is None or row["status"] in ("done", "failed"):
            return

        # attempts >= 3 标 failed · 否则 pending (回池)
        # shard 层 attempts 由 ShardRepo.mark_failed 维护 · 我们看老表 attempts
        # 这里简化用 shard.attempts (统一引擎维护)
        attempts = sh.attempts or 0
        if attempts >= 3:
            s.execute(text(
                "UPDATE we_crawl_subtasks "
                "SET status='failed', error_msg=:err, "
                "    completed_at=NOW(), "
                "    leased_by_node=NULL, lease_expires_at=NULL "
                "WHERE id = :id"
            ), {"id": row["id"], "err": (sh.error or "shard_failed")[:500]})
            s.execute(text(
                "UPDATE we_crawl_orders SET failed_count = failed_count + 1 "
                "WHERE id = :id"
            ), {"id": crawl_order_id})
        else:
            s.execute(text(
                "UPDATE we_crawl_subtasks "
                "SET status='pending', "
                "    leased_by_node=NULL, leased_at=NULL, lease_expires_at=NULL, "
                "    error_msg=:err "
                "WHERE id = :id"
            ), {"id": row["id"], "err": (sh.error or "")[:500]})

        s.commit()
        logger.info("crawl.hook · subtask=%s order=%s seq=%s attempts=%s → %s",
                    row["id"], crawl_order_id, crawl_seq, attempts,
                    "failed" if attempts >= 3 else "pending")

        if attempts >= 3:
            _maybe_finalize_order(s, crawl_order_id)


# ════════════════════════════════════════════════════════════════
# W4-phase2 · 双跑 helpers
# ════════════════════════════════════════════════════════════════
def _fetch_replica_siblings(s: Session, *, workload_id: str, replica_of: str) -> list[dict]:
    """返同 canonical (replica_of) 的所有副本 · 含 status/output_ref/lease_by_node"""
    rows = s.execute(text(
        "SELECT id, status, output_ref, lease_by_node, metadata "
        "FROM we_shards "
        "WHERE workload_id = :wl "
        "  AND (metadata->>'replica_of') = :ro"
    ), {"wl": workload_id, "ro": replica_of}).mappings().all()
    return [dict(r) for r in rows]


def _hash_compare_siblings(done_siblings: list[dict]) -> dict:
    """从各副本 output_ref 解 result_hash · 比对

    返:
      {
        "consistent": bool,
        "primary": {"worker_id": ..., "output_ref": ..., "result_hash": ...},
        "verify":  {"worker_id": ..., "output_ref": ..., "result_hash": ...},
      }
    """
    parsed = []
    for sib in done_siblings:
        url, h, size = _parse_node_output(sib.get("output_ref") or "")
        parsed.append({
            "worker_id": sib.get("lease_by_node") or "",
            "output_ref": sib.get("output_ref") or "",
            "result_hash": h,
            "result_oss_url": url,
            "result_size_bytes": size,
            "replica_index": (sib.get("metadata") or {}).get("replica_index", 0),
        })
    # 按 replica_index 排序 · primary=0 · verify=1+
    parsed.sort(key=lambda x: x["replica_index"])
    primary = parsed[0]
    verify = parsed[1] if len(parsed) > 1 else None

    # hash 全一致才 consistent (双跑严格)
    hashes = {p["result_hash"] for p in parsed if p["result_hash"]}
    consistent = len(hashes) == 1 and bool(next(iter(hashes), ""))
    return {"consistent": consistent, "primary": primary, "verify": verify}


def _commit_done_single(s: Session, *, sh, row: dict,
                        crawl_order_id: int, crawl_seq: int) -> None:
    """单跑 verify_level=1 · 直接反写 done + 分账"""
    url, h, size = _parse_node_output(sh.output_ref or "")
    s.execute(text(
        "UPDATE we_crawl_subtasks "
        "SET status='done', "
        "    result_oss_url=:url, result_hash=:hash, result_size_bytes=:size, "
        "    completed_at=NOW(), "
        "    leased_by_node=NULL, lease_expires_at=NULL "
        "WHERE id = :id"
    ), {"id": row["id"], "url": url, "hash": h, "size": size})
    s.execute(text(
        "UPDATE we_crawl_orders SET completed_count = completed_count + 1 "
        "WHERE id = :id"
    ), {"id": crawl_order_id})

    order = s.execute(text(
        "SELECT id, customer_id, unit_price_edg, platform_fee_pct FROM we_crawl_orders "
        "WHERE id = :id"
    ), {"id": crawl_order_id}).mappings().first()
    if order and sh.worker_id:
        _pay_node(s, order=dict(order), subtask_id=row["id"],
                  node_id=sh.worker_id, is_verify=False)
    logger.info("crawl.hook.single · subtask=%s order=%s seq=%s done (worker=%s)",
                row["id"], crawl_order_id, crawl_seq, (sh.worker_id or "")[:8])


def _commit_done_with_verify(s: Session, *, row: dict,
                             crawl_order_id: int, crawl_seq: int,
                             primary: dict, verify: dict) -> None:
    """双跑 hash 一致 · 反写 done + primary/verify 双方分账"""
    s.execute(text(
        "UPDATE we_crawl_subtasks "
        "SET status='done', "
        "    result_oss_url=:url, result_hash=:hash, result_size_bytes=:size, "
        "    primary_by_node = CAST(:pnode AS uuid), "
        "    verify_by_node  = CAST(:vnode AS uuid), "
        "    verify_result_oss_url=:vurl, verify_result_hash=:vhash, "
        "    completed_at=NOW(), "
        "    leased_by_node=NULL, lease_expires_at=NULL "
        "WHERE id = :id"
    ), {
        "id": row["id"],
        "url": primary["result_oss_url"], "hash": primary["result_hash"],
        "size": primary["result_size_bytes"],
        "pnode": primary["worker_id"], "vnode": verify["worker_id"],
        "vurl": verify["result_oss_url"], "vhash": verify["result_hash"],
    })
    s.execute(text(
        "UPDATE we_crawl_orders SET completed_count = completed_count + 1 "
        "WHERE id = :id"
    ), {"id": crawl_order_id})

    order = s.execute(text(
        "SELECT id, customer_id, unit_price_edg, platform_fee_pct FROM we_crawl_orders "
        "WHERE id = :id"
    ), {"id": crawl_order_id}).mappings().first()
    if order:
        # 双方都付 · primary is_verify=false · verify is_verify=true
        if primary.get("worker_id"):
            _pay_node(s, order=dict(order), subtask_id=row["id"],
                      node_id=primary["worker_id"], is_verify=False)
        if verify.get("worker_id"):
            _pay_node(s, order=dict(order), subtask_id=row["id"],
                      node_id=verify["worker_id"], is_verify=True)
    logger.info("crawl.hook.double · subtask=%s order=%s seq=%s hash 一致 · 双方分账",
                row["id"], crawl_order_id, crawl_seq)


def _commit_verify_mismatch(s: Session, *, row: dict,
                            crawl_order_id: int, crawl_seq: int,
                            siblings: list[dict]) -> None:
    """双跑 hash 不一致 · 标 verify_mismatch + failed_count+1 · 不付钱"""
    s.execute(text(
        "UPDATE we_crawl_subtasks "
        "SET status='failed', error_msg='verify_mismatch', "
        "    completed_at=NOW(), "
        "    leased_by_node=NULL, lease_expires_at=NULL "
        "WHERE id = :id"
    ), {"id": row["id"]})
    s.execute(text(
        "UPDATE we_crawl_orders SET failed_count = failed_count + 1 "
        "WHERE id = :id"
    ), {"id": crawl_order_id})
    logger.warning(
        "crawl.hook.double · subtask=%s order=%s seq=%s hash 不一致 · 标 failed (workers=%s)",
        row["id"], crawl_order_id, crawl_seq,
        [s.get("lease_by_node", "")[:8] for s in siblings],
    )


# ════════════════════════════════════════════════════════════════
# helpers
# ════════════════════════════════════════════════════════════════
def _parse_node_output(output_ref: str) -> tuple[str, str, int]:
    """节点 crawl_subtask runner 输出 JSON: {"result_oss_url":..., "result_hash":..., "result_size_bytes":N}

    inline 输出走这里 · 大输出走 OSS 由节点直接上传 + 返 URL
    返 (result_oss_url, result_hash, result_size_bytes)
    """
    if not output_ref:
        return "", "", 0
    if output_ref.startswith("{"):
        try:
            data = json.loads(output_ref)
            return (
                data.get("result_oss_url", "") or "",
                data.get("result_hash", "") or "",
                int(data.get("result_size_bytes", 0) or 0),
            )
        except Exception:
            pass
    # 兜底: output_ref 直接当 OSS URL (节点上传后返 URL)
    return output_ref, "", 0


def _pay_node(s: Session, *, order: dict, subtask_id: int,
              node_id: str, is_verify: bool) -> None:
    """给节点 owner 发报酬 · 跟老 dispatch._pay_node 行为一致"""
    from platform_v8.services.economy.ledger import reward

    owner = s.execute(text(
        "SELECT owner_id FROM we_workers WHERE id = CAST(:nid AS uuid)"
    ), {"nid": node_id}).scalar()
    if owner is None:
        logger.warning("crawl.hook · 节点 %s 无 owner · 跳过进账", node_id[:8])
        return

    final_unit = Decimal(str(order["unit_price_edg"]))
    fee_pct = Decimal(str(order["platform_fee_pct"]))
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
    s.execute(text(
        "INSERT INTO we_crawl_payouts "
        "(subtask_id, order_id, node_id, account_id, amount_edg, is_verify_run) "
        "VALUES (:sid, :oid, CAST(:nid AS uuid), :aid, :amt, :verify)"
    ), {
        "sid": subtask_id, "oid": order.get("id") or 0,
        "nid": node_id, "aid": owner,
        "amt": node_amount, "verify": is_verify,
    })


def _maybe_finalize_order(s: Session, order_id: int) -> None:
    """所有 subtask 落定 · 触发聚合"""
    pending = s.execute(text(
        "SELECT COUNT(*) FROM we_crawl_subtasks "
        "WHERE order_id = :id AND status IN ('pending','leased','pending_verify')"
    ), {"id": order_id}).scalar()
    if pending == 0:
        from .orders import aggregate_order_results
        try:
            aggregate_order_results(s, order_id=order_id)
        except Exception:
            logger.exception("crawl.hook · aggregate_order_results 失败 · order=%s", order_id)
