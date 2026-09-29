"""
公开统计端点 · 给官网首页等无登录页用
所有响应全脱敏 (不返 user id / worker id / task spec / IP)
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import text

from platform_v8.api.deps import get_session

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/public", tags=["public"])


@router.get("/company")
def company_info() -> dict:
    """公司主体公开信息 · 给官网页脚/关于我们/协议页用 · 单一信源 core.company"""
    from platform_v8.core import company as _c
    return {"ok": True, "company": _c.public_info()}


@router.get("/console-snapshot")
def console_snapshot(session: Session = Depends(get_session)) -> dict:
    """官网首页用 · 实时算力大盘 · 全脱敏

    替代老 v1 同名端点 · 字段保持兼容:
      top_metrics:   官网 Hero 4 个大数字
      task_type_top: 官网"任务类型分布"列表
    """
    # 节点统计
    nodes = session.execute(text("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status IN ('ONLINE', 'BUSY')) AS online
        FROM we_workers
    """)).mappings().first()

    # 任务统计
    tasks = session.execute(text("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'DONE') AS done,
            COUNT(*) FILTER (WHERE status = 'RUNNING') AS running,
            COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS recent_24h
        FROM we_workloads
    """)).mappings().first()

    # 用户数
    users_total = session.execute(text("SELECT COUNT(*) AS n FROM we_accounts")).scalar() or 0

    # 算力分 (所有在线 worker capability_score 累加 · 给"集群算力"展示用)
    compute_score = session.execute(text("""
        SELECT COALESCE(SUM(capability_score), 0) AS total
        FROM we_workers WHERE status IN ('ONLINE', 'BUSY')
    """)).scalar() or 0

    # task_type top 6 (全平台累计)
    types = session.execute(text("""
        SELECT spec->>'task_type' AS task_type, COUNT(*) AS n
        FROM we_workloads
        WHERE spec->>'task_type' IS NOT NULL
        GROUP BY task_type
        ORDER BY n DESC
        LIMIT 6
    """)).mappings().all()

    # The anonymous snapshot exposes aggregate service health only. A device
    # name, detailed hardware/software inventory, or a live per-device task
    # stream can identify a contributor even when account IDs are omitted.
    # Keep legacy keys as empty lists for older public dashboard clients.
    nodes_list: list[dict] = []
    live_feed: list[dict] = []

    return {
        "top_metrics": {
            "nodes_total": int(nodes["total"] or 0),
            "nodes_online": int(nodes["online"] or 0),
            "tasks_total": int(tasks["total"] or 0),
            "tasks_done": int(tasks["done"] or 0),
            "tasks_running": int(tasks["running"] or 0),
            "tasks_24h": int(tasks["recent_24h"] or 0),
            "users_total": int(users_total),
            "compute_score": round(float(compute_score), 2),
        },
        "task_type_top": [
            {"task_type": r["task_type"], "count": int(r["n"])}
            for r in types
        ],
        "nodes": nodes_list,
        "live_feed": live_feed,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


# ── S3-T7 · 2026-06-07 · 公开节点收益榜 (脱敏 · 给官网/桌面 App 拉新激励用) ──
@router.get("/node-leaderboard")
def node_leaderboard(
    days: int = 30,
    limit: int = 50,
    session: Session = Depends(get_session),
) -> dict:
    """Top N 节点累计奖励 (按 owner 聚合 · 脱敏 · 无登录可读)
    
    展示用例:
      - 官网首页"千手节点收益榜"侧栏
      - 桌面 App 节点中心"今日 Top 矿工"
      - 渠道运营拉新文案
    """
    days = max(1, min(int(days), 365))
    limit = max(1, min(int(limit), 100))
    rows = session.execute(text(f"""
        WITH per_owner AS (
          SELECT wk.owner_id,
                 SUM(l.amount)::numeric AS reward_total,
                 COUNT(*) AS tx_count,
                 MAX(l.created_at) AS last_reward_at
            FROM we_ledger l
            JOIN we_shards s ON l.shard_id = s.id
            JOIN we_workers wk ON s.worker_id = wk.id
           WHERE l.type = 'REWARD'
             AND l.amount > 0
             AND l.created_at > NOW() - INTERVAL '{days} days'
           GROUP BY wk.owner_id
        )
        SELECT po.owner_id, po.reward_total, po.tx_count, po.last_reward_at,
               a.username
          FROM per_owner po
          LEFT JOIN we_accounts a ON po.owner_id = a.id
         ORDER BY po.reward_total DESC
         LIMIT :lim
    """), {"lim": limit}).mappings().all()

    def _mask_name(name: str | None, idx: int) -> str:
        if not name:
            return f"矿工 #{idx + 1}"
        # 脱敏: 首字 + ** + 末字(或单字直接显示)
        if len(name) <= 2:
            return name + "*"
        return name[0] + "*" * (len(name) - 2) + name[-1]

    items = []
    for i, r in enumerate(rows):
        items.append({
            "rank": i + 1,
            "miner_name": _mask_name(r["username"], i),
            "reward_total": round(float(r["reward_total"] or 0), 2),
            "task_count": int(r["tx_count"] or 0),
            "last_active": r["last_reward_at"].isoformat() if r["last_reward_at"] else None,
        })

    return {
        "ok": True,
        "period_days": days,
        "total_winners": len(items),
        "items": items,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "note": "脱敏 · 不暴露 owner_id/真实姓名 · 仅展示首末字符",
    }
