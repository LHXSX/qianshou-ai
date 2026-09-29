"""
NCE Admin HTTP router · /api/v8/admin/nce/*

设计要点 (考虑全链路):
  - 独立 router · 不动现有 admin.py
  - 全 endpoint 强制 admin (Depends(get_admin_account))
  - 目前提供:
    1. feature flags CRUD (NCE 灰度核心)
    后续 P2/P3 加:
    2. hw_score 手工评估 / 调档
    3. 信誉手工调整 (admin override)
    4. 派单决策审计查询
    5. 数据驱动调参报表
"""
from __future__ import annotations
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session, get_admin_account
from platform_v8.core import Account
from platform_v8.services.ops import feature_flags as ff

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/admin/nce", tags=["admin-nce"])


# ════════════════════════════════════════════════════════════════════
# Feature Flags (灰度核心)
# ════════════════════════════════════════════════════════════════════

class FlagUpdateRequest(BaseModel):
    enabled: bool | None = Field(default=None, description="是否启用")
    rollout_pct: int | None = Field(default=None, ge=0, le=100, description="灰度百分比")
    rollout_filter: dict | None = Field(
        default=None,
        description='白名单 {"owner_ids":[1,2], "worker_ids":["uuid1"]}',
    )
    description: str | None = Field(default=None, description="新建时必填")


@router.get("/flags", summary="列出 NCE feature flags")
def list_flags(
    prefix: str | None = Query(default="nce_", description="前缀过滤 · 默认只看 nce_*"),
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """列出所有 feature flag · 默认只看 nce_ 开头的 (NCE 相关)"""
    flags = ff.list_flags(prefix=prefix or None, session=session)
    return {
        "ok": True,
        "items": [
            {
                "flag_name": f.flag_name,
                "enabled": f.enabled,
                "rollout_pct": f.rollout_pct,
                "rollout_filter": f.rollout_filter,
                "description": f.description,
                "updated_at": f.updated_at,
                "updated_by": f.updated_by,
            }
            for f in flags
        ],
        "total": len(flags),
    }


@router.get("/flags/{flag_name}", summary="拿单个 flag 详情")
def get_flag(
    flag_name: str,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    flag = ff.get_flag(flag_name, session=session)
    if flag is None:
        raise HTTPException(status_code=404, detail=f"flag {flag_name} 不存在")
    return {
        "ok": True,
        "flag": {
            "flag_name": flag.flag_name,
            "enabled": flag.enabled,
            "rollout_pct": flag.rollout_pct,
            "rollout_filter": flag.rollout_filter,
            "description": flag.description,
            "updated_at": flag.updated_at,
            "updated_by": flag.updated_by,
        },
    }


@router.patch("/flags/{flag_name}", summary="改 flag (启用/灰度/白名单)")
def update_flag(
    flag_name: str,
    body: FlagUpdateRequest,
    session: Session = Depends(get_session),
    admin: Account = Depends(get_admin_account),
):
    """
    改 flag · 任意字段可省 · 只改提供的字段。
    
    典型用法:
      - 影子模式启动: PATCH /flags/nce_planner_shadow_mode {enabled: true, rollout_pct: 100}
      - 1% 灰度:    PATCH /flags/nce_planner_use_reputation {enabled: true, rollout_pct: 1}
      - 紧急关闭:   PATCH /flags/nce_planner_use_reputation {enabled: false}
    """
    # 至少要改一项
    if (body.enabled is None and body.rollout_pct is None
            and body.rollout_filter is None and body.description is None):
        raise HTTPException(status_code=400, detail="至少提供一个字段")

    try:
        flag = ff.update_flag(
            flag_name,
            enabled=body.enabled,
            rollout_pct=body.rollout_pct,
            rollout_filter=body.rollout_filter,
            description=body.description,
            updated_by=admin.username,
            session=session,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    logger.info(
        "nce_admin.flag_update · admin=%s flag=%s enabled=%s pct=%d",
        admin.username, flag_name, flag.enabled, flag.rollout_pct,
    )

    return {
        "ok": True,
        "flag": {
            "flag_name": flag.flag_name,
            "enabled": flag.enabled,
            "rollout_pct": flag.rollout_pct,
            "rollout_filter": flag.rollout_filter,
            "description": flag.description,
            "updated_at": flag.updated_at,
            "updated_by": flag.updated_by,
        },
    }


@router.post("/flags/invalidate", summary="清缓存 (急用 · 改了不生效)")
def invalidate_cache(
    _admin: Account = Depends(get_admin_account),
):
    """admin 触发 · 清进程内缓存 (Redis 等自然 TTL · 30s 后一致)"""
    ff.invalidate_all()
    return {"ok": True, "message": "L1 cache cleared · L2 (Redis) will expire within 30s"}


# ════════════════════════════════════════════════════════════════════
# 灰度判定测试 (admin 调试用)
# ════════════════════════════════════════════════════════════════════

# ════════════════════════════════════════════════════════════════════
# 硬件评分 (P2 · hw_scoring)
# ════════════════════════════════════════════════════════════════════

class RecomputeRequest(BaseModel):
    only_online: bool = Field(default=True, description="只算 ONLINE/BUSY 节点 (默认 True · 省时间)")
    dry_run: bool = Field(default=False, description="True = 只计算不写库 (调试)")
    trigger: str = Field(default="admin_manual", description="审计 trigger 字段")


@router.post("/hw_scores/recompute", summary="重算硬件评分 (批量 · 写 hw_score_history)")
def recompute_hw_scores(
    body: RecomputeRequest,
    _admin: Account = Depends(get_admin_account),
):
    """
    手工触发硬件评分重算 · 通常 cron 自动跑 · 这是兜底入口。
    
    返回:
        total / updated / tier_distribution / tier_changes
    """
    from platform_v8.services.economy import hw_scoring
    try:
        result = hw_scoring.recompute_all(
            only_online=body.only_online,
            trigger=body.trigger,
            dry_run=body.dry_run,
        )
    except Exception as exc:
        logger.exception("hw_scores.recompute fail")
        raise HTTPException(status_code=500, detail=f"重算失败: {exc}")

    logger.info("nce_admin.hw_recompute · admin=%s total=%d updated=%d distribution=%s",
                _admin.username, result["total"], result["updated"],
                result["tier_distribution"])
    return {"ok": True, "result": result}


@router.get("/workers/{worker_id}/hw_score", summary="看单节点当前评分 + 子分 + 5 条历史")
def get_worker_hw_score(
    worker_id: str,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """返回 worker 当前 hw_tier/hw_score · 子分 (用 evaluate 再算一次) · 最近 5 条 history"""
    from sqlalchemy import text
    from platform_v8.services.economy import hw_scoring
    from platform_v8.storage.repo import WorkerRepo

    worker = WorkerRepo.by_id(session, worker_id)
    if worker is None:
        raise HTTPException(status_code=404, detail=f"worker {worker_id} 不存在")

    # 实时算一次 (跟 DB 存的对比)
    fresh = hw_scoring.evaluate(worker.capabilities)

    # 拿最近 5 条 history
    rows = session.execute(
        text("""
            SELECT hw_tier, hw_score, sub_scores, trigger, created_at
            FROM we_hw_score_history
            WHERE worker_id = CAST(:wid AS uuid)
            ORDER BY created_at DESC
            LIMIT 5
        """),
        {"wid": worker_id},
    ).fetchall()
    history = [
        {
            "hw_tier": r[0],
            "hw_score": float(r[1]),
            "sub_scores": r[2] or {},
            "trigger": r[3],
            "created_at": r[4].isoformat() if r[4] else None,
        }
        for r in rows
    ]

    # 从 DB row 拿当前值 (会被新写覆盖 · 但用 db 直查保险)
    db_row = session.execute(
        text("SELECT hw_tier, hw_score, hw_evaluated_at FROM we_workers WHERE id = CAST(:wid AS uuid)"),
        {"wid": worker_id},
    ).fetchone()

    return {
        "ok": True,
        "worker_id": worker_id,
        "name": worker.name,
        "status": worker.status.value if hasattr(worker.status, "value") else str(worker.status),
        "db_state": {
            "hw_tier": db_row[0] if db_row else None,
            "hw_score": float(db_row[1]) if db_row and db_row[1] is not None else None,
            "hw_evaluated_at": db_row[2].isoformat() if db_row and db_row[2] else None,
        },
        "fresh_eval": {
            "hw_tier": fresh.hw_tier,
            "hw_score": fresh.hw_score,
            "sub_scores": fresh.sub_scores,
            "detail": fresh.detail,
        },
        "history": history,
    }


# ════════════════════════════════════════════════════════════════════
# P3 · 多维信誉 (4 子分 + 调和平均)
# ════════════════════════════════════════════════════════════════════

@router.post("/rep_scores/recompute", summary="重算 4 子分 + 调和平均主分")
def recompute_rep_scores(
    body: RecomputeRequest,
    _admin: Account = Depends(get_admin_account),
):
    """从 we_shards 派生 correctness/speed · 从 last_seen 派生 stability · resource 默认 70"""
    from platform_v8.services.economy import rep_scoring
    try:
        result = rep_scoring.recompute_all(
            only_online=body.only_online,
            trigger=body.trigger,
            dry_run=body.dry_run,
        )
    except Exception as exc:
        logger.exception("rep_scores.recompute fail")
        raise HTTPException(status_code=500, detail=f"重算失败: {exc}")

    logger.info("nce_admin.rep_recompute · admin=%s total=%d updated=%d defaults=%d",
                _admin.username, result["total"], result["updated"], result["default_count"])
    return {"ok": True, "result": result}


@router.get("/workers/{worker_id}/rep_score", summary="看单节点 4 子分 + 调和平均")
def get_worker_rep_score(
    worker_id: str,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """返回 worker 当前 rep_* · 实时算一次 (跟 DB 比较) · 最近 5 条 history"""
    from sqlalchemy import text
    from platform_v8.services.economy import rep_scoring

    fresh = rep_scoring.evaluate_worker(worker_id, session=session)

    db_row = session.execute(
        text("""
            SELECT name, status, rep_main, rep_stability, rep_correctness,
                   rep_speed, rep_resource, rep_updated_at
            FROM we_workers WHERE id = CAST(:wid AS uuid)
        """),
        {"wid": worker_id},
    ).fetchone()
    if db_row is None:
        raise HTTPException(status_code=404, detail=f"worker {worker_id} 不存在")

    # 最近 5 条 rep 事件
    history_rows = session.execute(
        text("""
            SELECT event_type, after_score, reason, metadata, created_at
            FROM we_reputation_events
            WHERE worker_id = CAST(:wid AS uuid)
            ORDER BY created_at DESC LIMIT 5
        """),
        {"wid": worker_id},
    ).fetchall()

    return {
        "ok": True,
        "worker_id": worker_id,
        "name": db_row[0],
        "status": db_row[1],
        "db_state": {
            "rep_main": int(db_row[2] or 60),
            "rep_stability": int(db_row[3] or 60),
            "rep_correctness": int(db_row[4] or 60),
            "rep_speed": int(db_row[5] or 60),
            "rep_resource": int(db_row[6] or 60),
            "rep_updated_at": db_row[7].isoformat() if db_row[7] else None,
        },
        "fresh_eval": {
            "rep_main": fresh.rep_main,
            "sub_scores": fresh.sub_scores,
            "is_default": fresh.is_default,
            "detail": fresh.detail,
        },
        "history": [
            {
                "event_type": r[0],
                "after_score": int(r[1]) if r[1] is not None else None,
                "reason": r[2],
                "metadata": r[3] or {},
                "created_at": r[4].isoformat() if r[4] else None,
            }
            for r in history_rows
        ],
    }


# ════════════════════════════════════════════════════════════════════
# P4 · 反作弊 + 趋势 + IDC 聚合
# ════════════════════════════════════════════════════════════════════

@router.post("/anti_cheat/scan", summary="慢作弊 + 假心跳全网扫")
def anti_cheat_scan(
    _admin: Account = Depends(get_admin_account),
    only_online: bool = Query(default=True),
    write_audit: bool = Query(default=True),
):
    """扫所有节点 · 检测慢作弊 (z-score) + 假心跳 (变异系数)"""
    from platform_v8.services.economy import anti_cheat_detect
    try:
        result = anti_cheat_detect.scan_all(
            only_online=only_online, write_audit=write_audit,
        )
    except Exception as exc:
        logger.exception("anti_cheat.scan fail")
        raise HTTPException(status_code=500, detail=str(exc))
    logger.info("nce_admin.anti_cheat_scan · admin=%s total=%d alerts=%d",
                _admin.username, result["total"], len(result["alerts"]))
    return {"ok": True, "result": result}


@router.get("/anti_cheat/worker/{worker_id}", summary="单节点反作弊详情")
def anti_cheat_worker(
    worker_id: str,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """查单个节点的 slow_cheat + fake_heartbeat 检测结果"""
    from platform_v8.services.economy import anti_cheat_detect
    slow = anti_cheat_detect.detect_slow_cheat(worker_id, session)
    fake = anti_cheat_detect.detect_fake_heartbeat(worker_id, session)
    return {
        "ok": True,
        "worker_id": worker_id,
        "slow_cheat": {
            "type": slow.signal_type, "severity": slow.severity,
            "score": slow.score, "threshold": slow.threshold,
            "sample_count": slow.sample_count,
            "detail": slow.detail, "recommendation": slow.recommendation,
        },
        "fake_heartbeat": {
            "type": fake.signal_type, "severity": fake.severity,
            "score": fake.score, "threshold": fake.threshold,
            "sample_count": fake.sample_count,
            "detail": fake.detail, "recommendation": fake.recommendation,
        },
    }


@router.post("/trend/scan", summary="P4.7 · 历史趋势报警全网扫")
def trend_scan(
    _admin: Account = Depends(get_admin_account),
    only_online: bool = Query(default=True),
    write_audit: bool = Query(default=True),
):
    """比较 7d vs 30d hw_score · 输出 mild/moderate/severe 节点"""
    from platform_v8.services.economy import nce_trend_idc
    try:
        result = nce_trend_idc.scan_trend_all(
            only_online=only_online, write_audit=write_audit,
        )
    except Exception as exc:
        logger.exception("trend.scan fail")
        raise HTTPException(status_code=500, detail=str(exc))
    return {"ok": True, "result": result}


@router.get("/trend/worker/{worker_id}", summary="单节点趋势详情")
def trend_worker(
    worker_id: str,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    from platform_v8.services.economy import nce_trend_idc
    alert = nce_trend_idc.analyze_trend(worker_id, session)
    return {
        "ok": True,
        "worker_id": worker_id,
        "status": alert.status,
        "score_7d": alert.score_7d,
        "score_30d": alert.score_30d,
        "delta": alert.delta,
        "detail": alert.detail,
    }


@router.post("/idc/scan", summary="P4.8 · IDC 聚合扫描 (反作弊 Layer B)")
def idc_scan(
    _admin: Account = Depends(get_admin_account),
    only_online: bool = Query(default=True),
    write_audit: bool = Query(default=True),
):
    """按 hostname 前缀 / 硬件指纹聚合节点 · 找出可疑高密度 IDC"""
    from platform_v8.services.economy import nce_trend_idc
    try:
        result = nce_trend_idc.scan_idc_all(
            only_online=only_online, write_audit=write_audit,
        )
    except Exception as exc:
        logger.exception("idc.scan fail")
        raise HTTPException(status_code=500, detail=str(exc))
    return {"ok": True, "result": result}


# ════════════════════════════════════════════════════════════════════
# P4.12 · 候选池缓存清理
# ════════════════════════════════════════════════════════════════════

@router.post("/planner/candidates_cache/clear", summary="清 planner 候选池缓存")
def clear_candidates_cache(
    _admin: Account = Depends(get_admin_account),
):
    from platform_v8.engine import planner
    planner.invalidate_candidates_cache()
    return {"ok": True, "message": "candidates cache cleared"}


# ════════════════════════════════════════════════════════════════════
# P4.13 · 异步事件总线
# ════════════════════════════════════════════════════════════════════

@router.get("/event_bus/stats", summary="看事件总线状态")
def event_bus_stats(
    _admin: Account = Depends(get_admin_account),
):
    from platform_v8.services.economy import event_bus
    return {"ok": True, "stats": event_bus.get_stats()}


@router.get("/event_bus/dead_letter", summary="看 dead letter 队列")
def event_bus_dead_letter(
    limit: int = Query(default=50, le=200),
    _admin: Account = Depends(get_admin_account),
):
    from platform_v8.services.economy import event_bus
    return {"ok": True, "dead_letter": event_bus.get_dead_letter(limit)}


# ════════════════════════════════════════════════════════════════════
# P4.14 · 价格自适应
# ════════════════════════════════════════════════════════════════════

@router.get("/pricing/current", summary="当前价格乘数")
def pricing_current(
    refresh: bool = Query(default=False),
    _admin: Account = Depends(get_admin_account),
):
    from platform_v8.services.economy import dynamic_pricing
    decision = dynamic_pricing.calculate_multiplier(force_refresh=refresh)
    return {
        "ok": True,
        "multiplier": decision.multiplier,
        "reason": decision.reason,
        "supply_count": decision.supply_count,
        "demand_count": decision.demand_count,
        "supply_demand_ratio": decision.supply_demand_ratio,
    }


@router.get("/pricing/apply", summary="给基准价应用动态乘数 (估算用)")
def pricing_apply(
    base_price: float = Query(...),
    task_type: str | None = Query(default=None),
    _admin: Account = Depends(get_admin_account),
):
    from platform_v8.services.economy import dynamic_pricing
    return {"ok": True, **dynamic_pricing.apply_to_base_price(base_price, task_type)}


@router.get("/task_difficulty", summary="任务难度表 (P3+ · 信誉加权)")
def get_task_difficulty(
    _admin: Account = Depends(get_admin_account),
):
    """返回 PRD v1.2 §22 定义的 task_type → difficulty 映射 + 分组"""
    from platform_v8.services.economy import task_difficulty as td
    return {
        "ok": True,
        "difficulty": td.list_all(),
        "categories": td.categorize(),
        "constants": {
            "DEFAULT_DIFFICULTY": td.DEFAULT_DIFFICULTY,
            "SUCCESS_BONUS_CAP": td.SUCCESS_BONUS_CAP,
            "FAILED_PENALTY_MIN": td.FAILED_PENALTY_MIN,
        },
        "examples": [
            {"task_type": t, "difficulty": td.get_difficulty(t),
             "success_delta": td.success_delta(t),
             "failed_delta": td.failed_delta(t)}
            for t in ["hash_batch", "image_resize", "ocr", "video_compress", "blender_render"]
        ],
    }


@router.get("/rep_scores/distribution", summary="全网 rep_main 分布")
def rep_distribution(
    only_online: bool = Query(default=True),
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """按 10 分桶看 rep_main 分布 · 给运营看是否过松/过严"""
    from sqlalchemy import text
    where = "WHERE status IN ('ONLINE','BUSY')" if only_online else ""
    rows = session.execute(
        text(f"""
            SELECT 
                FLOOR(rep_main / 10) * 10 AS bucket,
                COUNT(*) AS cnt
            FROM we_workers
            {where}
            GROUP BY bucket
            ORDER BY bucket
        """)
    ).fetchall()
    return {
        "ok": True,
        "only_online": only_online,
        "buckets": [
            {"range": f"{int(r[0])}-{int(r[0])+9}", "count": int(r[1])}
            for r in rows
        ],
    }


@router.get("/hw_scores/distribution", summary="全网 hw_tier 分布")
def hw_distribution(
    only_online: bool = Query(default=True),
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """返回 S/A/B/C/D 各档的节点数 + score 区间 · 给运营看分布"""
    from sqlalchemy import text
    where = "WHERE status IN ('ONLINE','BUSY')" if only_online else ""
    rows = session.execute(
        text(f"""
            SELECT 
                hw_tier,
                COUNT(*) AS cnt,
                MIN(hw_score) AS min_score,
                MAX(hw_score) AS max_score,
                AVG(hw_score) AS avg_score
            FROM we_workers
            {where}
            GROUP BY hw_tier
            ORDER BY hw_tier
        """)
    ).fetchall()
    return {
        "ok": True,
        "only_online": only_online,
        "distribution": [
            {
                "hw_tier": r[0],
                "count": int(r[1]),
                "min_score": float(r[2]) if r[2] is not None else None,
                "max_score": float(r[3]) if r[3] is not None else None,
                "avg_score": round(float(r[4]), 2) if r[4] is not None else None,
            }
            for r in rows
        ],
    }


# ════════════════════════════════════════════════════════════════════
# 灰度判定测试 (admin 调试用)
# ════════════════════════════════════════════════════════════════════

@router.get("/flags/{flag_name}/check", summary="测某个 subject 是否落在灰度内")
def check_subject(
    flag_name: str,
    subject_id: str = Query(..., description="owner_id 或 worker_id"),
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    """
    admin 调试用 · 模拟某个 owner/worker 是否会启用该 flag。
    
    例: /flags/nce_planner_use_reputation/check?subject_id=42
    """
    flag = ff.get_flag(flag_name, session=session)
    if flag is None:
        raise HTTPException(status_code=404, detail=f"flag {flag_name} 不存在")

    enabled = ff.is_enabled(flag_name, subject_id=subject_id, session=session)
    return {
        "ok": True,
        "flag_name": flag_name,
        "subject_id": subject_id,
        "enabled": enabled,
        "flag_state": {
            "enabled": flag.enabled,
            "rollout_pct": flag.rollout_pct,
            "rollout_filter": flag.rollout_filter,
        },
        "bucket": ff._hash_bucket(subject_id),
        "reason": (
            "flag_disabled" if not flag.enabled
            else "rollout_filter_match" if (
                subject_id and flag.rollout_filter and (
                    str(subject_id) in [str(x) for x in (flag.rollout_filter.get("owner_ids") or [])]
                    or str(subject_id) in [str(x) for x in (flag.rollout_filter.get("worker_ids") or [])]
                )
            )
            else "full_rollout" if flag.rollout_pct >= 100
            else "no_rollout" if flag.rollout_pct == 0
            else f"hash_bucket({ff._hash_bucket(subject_id)}) {'<' if enabled else '>='} pct({flag.rollout_pct})"
        ),
    }
