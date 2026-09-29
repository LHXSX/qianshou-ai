"""
采集后台 worker · 周期性维护

职责:
  1. reclaim_expired_leases · 释放超时未上报的 lease · 把 subtask 还回池
  2. finalize_orphan_orders   · 已无 pending/leased subtask 但仍 running 的订单 · 强制聚合
  3. (可选) prune_stale_lease_subtasks · 超过 MAX_ATTEMPTS 直接标 failed

启动: asyncio.create_task(crawl_worker_loop()) · 在 FastAPI lifespan
"""
from __future__ import annotations
import asyncio
import logging

from sqlalchemy import text

from platform_v8.storage.db import get_session_factory
from platform_v8.services.crawl.orders import aggregate_order_results

logger = logging.getLogger(__name__)

LOOP_INTERVAL_SECONDS = 30


def reclaim_expired_leases() -> int:
    """超过 lease_expires_at 仍未上报 · 还回 pending · 返回回收数"""
    with get_session_factory()() as s:
        n = s.execute(
            text(
                "UPDATE we_crawl_subtasks "
                "SET status = CASE "
                "      WHEN attempts >= 3 THEN 'failed' "
                "      ELSE 'pending' END, "
                "    leased_by_node = NULL, "
                "    leased_at = NULL, "
                "    lease_expires_at = NULL, "
                "    error_msg = 'lease_expired', "
                "    completed_at = CASE WHEN attempts >= 3 THEN NOW() ELSE NULL END "
                "WHERE status = 'leased' "
                "  AND lease_expires_at < NOW()"
            )
        ).rowcount
        # exhausted 的也得增加 failed_count (在订单上)
        if n:
            s.execute(
                text(
                    "UPDATE we_crawl_orders o "
                    "SET failed_count = failed_count + sub.cnt "
                    "FROM ( "
                    "  SELECT order_id, COUNT(*) AS cnt "
                    "  FROM we_crawl_subtasks "
                    "  WHERE status = 'failed' AND error_msg = 'lease_expired' "
                    "    AND completed_at > NOW() - INTERVAL '1 minute' "
                    "  GROUP BY order_id "
                    ") sub "
                    "WHERE o.id = sub.order_id"
                )
            )
        s.commit()
        return n


def finalize_orphan_orders() -> int:
    """状态 running 但已无未完成子任务 · 触发聚合 · 返回处理数"""
    with get_session_factory()() as s:
        rows = s.execute(
            text(
                "SELECT o.id FROM we_crawl_orders o "
                "WHERE o.status = 'running' AND NOT EXISTS ( "
                "  SELECT 1 FROM we_crawl_subtasks s "
                "  WHERE s.order_id = o.id "
                "    AND s.status IN ('pending','leased','pending_verify') "
                ")"
            )
        ).scalars().all()
        for oid in rows:
            try:
                aggregate_order_results(s, order_id=oid)
            except Exception:
                logger.exception("aggregate_order_results 失败 · order=%s", oid)
        return len(rows)


async def crawl_worker_loop() -> None:
    """asyncio 长循环 · 在 FastAPI lifespan 启动"""
    logger.info("crawl_worker_loop · 启动 · 周期 %ss", LOOP_INTERVAL_SECONDS)
    while True:
        try:
            n1 = await asyncio.to_thread(reclaim_expired_leases)
            n2 = await asyncio.to_thread(finalize_orphan_orders)
            if n1 or n2:
                logger.info(
                    "crawl_worker tick · reclaimed=%s · finalized=%s", n1, n2
                )
        except asyncio.CancelledError:
            logger.info("crawl_worker_loop · 取消信号 · 退出")
            raise
        except Exception:
            logger.exception("crawl_worker tick 异常 · 继续")
        await asyncio.sleep(LOOP_INTERVAL_SECONDS)
