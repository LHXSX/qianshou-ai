"""Dashboard API — 实时算力大屏数据"""
from fastapi import APIRouter
from platform_v8.storage.db import session_scope
from sqlalchemy import text
import time

router = APIRouter(prefix="/api/v8/dashboard", tags=["dashboard"])

@router.get("/live")
async def dashboard_live():
    with session_scope() as s:
        # Public dashboard: count capacity without returning device identities.
        online_workers = s.execute(text(
            "SELECT count(*) FROM we_workers WHERE status='ONLINE'"
        )).scalar() or 0
        
        # 任务统计
        shard_stats = s.execute(text(
            "SELECT status, count(*) FROM we_shards GROUP BY status"
        )).fetchall()
        
        # 今日完成
        today_done = s.execute(text(
            "SELECT count(*) FROM we_shards WHERE status='DONE' "
            "AND completed_at > NOW()-INTERVAL '24 hours'"
        )).scalar()
        
        # 节点配置汇总
        tiers = s.execute(text(
            "SELECT hw_tier, count(*) FROM we_workers WHERE status='ONLINE' GROUP BY hw_tier"
        )).fetchall()
        
    return {
        "ts": int(time.time()),
        "online_workers": int(online_workers),
        "workers": [],
        "shards": {row[0]: row[1] for row in shard_stats},
        "today_done": today_done,
        "tiers": {row[0]: row[1] for row in tiers},
        "recent": [],
    }
