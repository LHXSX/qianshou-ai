"""
NCE P4.5/P4.6 · 慢作弊 + 假心跳检测

设计要点 (考虑全链路):
  1. 慢作弊检测 (z-score)
     - 算 worker 最近 7d shard 完成时长的均值/标准差
     - 比较该 worker 平均时长 vs 全网中位数 · 用 z-score 衡量
     - z-score > 3 → 可疑 (慢得离谱)
     - z-score < -3 → 可疑 (快得离谱 · 可能跳步)
  
  2. 假心跳检测 (时间方差 / 等间隔识别)
     - 真实节点 hb 间隔有自然抖动 (网络/CPU 调度差异)
     - 假节点 (脚本模拟) hb 完美等间隔 (方差极小)
     - 检测: hb 间隔的变异系数 (CV) · CV < 0.05 → 可疑
  
  3. 都是周期检测 · 不阻塞派单 · 输出告警 → admin 处理
  
  4. 结果写 we_reputation_events (event_type=anti_cheat_*)
     不直接扣分 (避免误判) · admin 确认后才扣分
  
  5. 数据要求: 至少 20 个 shard / 20 次 hb · 否则跳过 (数据不够算不准)
"""
from __future__ import annotations
import logging
import math
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# ════════════════════════════════════════════════════════════════════════════
# 阈值 (P4 拍 · P5 看真实数据调)
# ════════════════════════════════════════════════════════════════════════════

# 慢作弊: z-score 超过 ±3 标准差 → 可疑
SLOW_CHEAT_Z_THRESHOLD = 3.0

# 假心跳: 变异系数 (CV = std/mean) < 0.05 → 可疑 (完美等间隔)
FAKE_HEARTBEAT_CV_THRESHOLD = 0.05

# 最少样本数 (低于此值跳过 · 数据不够算不准)
MIN_SHARD_SAMPLES = 20
MIN_HB_SAMPLES = 20

# 检测窗口
WINDOW_DAYS = 7


# ════════════════════════════════════════════════════════════════════════════
# 数据模型
# ════════════════════════════════════════════════════════════════════════════

@dataclass
class CheatSignal:
    worker_id: str
    signal_type: str          # slow_cheat / fast_cheat / fake_heartbeat / normal
    severity: str             # critical / warning / info / normal
    score: float              # z-score 或 CV
    threshold: float          # 触发阈值
    sample_count: int
    detail: dict[str, Any] = field(default_factory=dict)
    recommendation: str = ""


# ════════════════════════════════════════════════════════════════════════════
# 1. 慢作弊检测 (z-score)
# ════════════════════════════════════════════════════════════════════════════

def detect_slow_cheat(
    worker_id: str,
    session,
    window_days: int = WINDOW_DAYS,
) -> CheatSignal:
    """
    比较 worker 平均 elapsed_ms vs 全网均值/标准差 · z-score 判定
    
    z = (worker_avg - global_mean) / global_std
      > 3 → 慢得离谱 (可能拖延赚时长)
      < -3 → 快得离谱 (可能跳步骗结果)
      |z| <= 3 → 正常
    """
    from sqlalchemy import text

    # 1. 拿全网最近 7d DONE shard 的均值 + 标准差 (按 task_type 分组防干扰)
    global_row = session.execute(
        text("""
            SELECT 
                AVG(elapsed_ms)::float AS avg_ms,
                STDDEV(elapsed_ms)::float AS std_ms,
                COUNT(*) AS cnt
            FROM we_shards
            WHERE status = 'DONE'
              AND elapsed_ms IS NOT NULL
              AND completed_at > NOW() - INTERVAL '7 days'
        """)
    ).fetchone()
    global_mean = float(global_row[0] or 0)
    global_std = float(global_row[1] or 0)
    global_cnt = int(global_row[2] or 0)

    # 2. 拿 worker 的均值
    worker_row = session.execute(
        text("""
            SELECT 
                AVG(elapsed_ms)::float AS avg_ms,
                COUNT(*) AS cnt
            FROM we_shards
            WHERE worker_id = CAST(:wid AS uuid)
              AND status = 'DONE'
              AND elapsed_ms IS NOT NULL
              AND completed_at > NOW() - INTERVAL '7 days'
        """),
        {"wid": worker_id},
    ).fetchone()
    worker_mean = float(worker_row[0] or 0)
    worker_cnt = int(worker_row[1] or 0)

    # 数据不够 · 跳过
    if worker_cnt < MIN_SHARD_SAMPLES or global_std <= 0 or global_cnt < MIN_SHARD_SAMPLES:
        return CheatSignal(
            worker_id=worker_id,
            signal_type="normal",
            severity="info",
            score=0,
            threshold=SLOW_CHEAT_Z_THRESHOLD,
            sample_count=worker_cnt,
            detail={"reason": "data_insufficient",
                    "worker_cnt": worker_cnt, "global_cnt": global_cnt},
            recommendation="数据不足 · 累积后再检测",
        )

    # z-score
    z = (worker_mean - global_mean) / global_std

    if z > SLOW_CHEAT_Z_THRESHOLD:
        return CheatSignal(
            worker_id=worker_id,
            signal_type="slow_cheat",
            severity="warning" if z < 5 else "critical",
            score=round(z, 3),
            threshold=SLOW_CHEAT_Z_THRESHOLD,
            sample_count=worker_cnt,
            detail={
                "worker_avg_ms": round(worker_mean, 1),
                "global_mean_ms": round(global_mean, 1),
                "global_std_ms": round(global_std, 1),
            },
            recommendation=f"节点完成速度比全网均值慢 {z:.1f} 个标准差 · 可能拖延 · 建议人工复查",
        )

    if z < -SLOW_CHEAT_Z_THRESHOLD:
        return CheatSignal(
            worker_id=worker_id,
            signal_type="fast_cheat",
            severity="warning" if z > -5 else "critical",
            score=round(z, 3),
            threshold=SLOW_CHEAT_Z_THRESHOLD,
            sample_count=worker_cnt,
            detail={
                "worker_avg_ms": round(worker_mean, 1),
                "global_mean_ms": round(global_mean, 1),
                "global_std_ms": round(global_std, 1),
            },
            recommendation=f"节点速度比全网均值快 {-z:.1f} 个标准差 · 可能跳步 · 建议结果校验",
        )

    return CheatSignal(
        worker_id=worker_id,
        signal_type="normal",
        severity="normal",
        score=round(z, 3),
        threshold=SLOW_CHEAT_Z_THRESHOLD,
        sample_count=worker_cnt,
        detail={
            "worker_avg_ms": round(worker_mean, 1),
            "global_mean_ms": round(global_mean, 1),
        },
    )


# ════════════════════════════════════════════════════════════════════════════
# 2. 假心跳检测 (变异系数)
# ════════════════════════════════════════════════════════════════════════════

def detect_fake_heartbeat(
    worker_id: str,
    session,
) -> CheatSignal:
    """
    检测心跳间隔的变异系数 · 完美等间隔 → 可疑脚本
    
    用 we_shards 的 dispatched_at 时间序列作为节点活动证据
    (真实 hb 历史没存 · 用 shard 时序近似)
    
    CV = std / mean · CV < 0.05 → 完美等间隔 → 可疑
    """
    from sqlalchemy import text

    rows = session.execute(
        text("""
            SELECT dispatched_at
            FROM we_shards
            WHERE worker_id = CAST(:wid AS uuid)
              AND dispatched_at > NOW() - INTERVAL '7 days'
            ORDER BY dispatched_at ASC
        """),
        {"wid": worker_id},
    ).fetchall()

    if len(rows) < MIN_HB_SAMPLES:
        return CheatSignal(
            worker_id=worker_id,
            signal_type="normal",
            severity="info",
            score=0,
            threshold=FAKE_HEARTBEAT_CV_THRESHOLD,
            sample_count=len(rows),
            detail={"reason": "data_insufficient"},
            recommendation="样本不足 · 累积后再检测",
        )

    # 算间隔 · 单位秒
    intervals = []
    prev = None
    for r in rows:
        t = r[0]
        if prev is not None:
            delta = (t - prev).total_seconds()
            if delta > 0:
                intervals.append(delta)
        prev = t

    if len(intervals) < MIN_HB_SAMPLES - 1:
        return CheatSignal(
            worker_id=worker_id,
            signal_type="normal",
            severity="info",
            score=0,
            threshold=FAKE_HEARTBEAT_CV_THRESHOLD,
            sample_count=len(intervals),
            detail={"reason": "interval_insufficient"},
        )

    # 算均值 / 标准差 / CV
    mean = sum(intervals) / len(intervals)
    if mean <= 0:
        return CheatSignal(
            worker_id=worker_id, signal_type="normal", severity="info",
            score=0, threshold=FAKE_HEARTBEAT_CV_THRESHOLD,
            sample_count=len(intervals),
            detail={"reason": "zero_mean"},
        )
    variance = sum((x - mean) ** 2 for x in intervals) / len(intervals)
    std = math.sqrt(variance)
    cv = std / mean

    if cv < FAKE_HEARTBEAT_CV_THRESHOLD:
        return CheatSignal(
            worker_id=worker_id,
            signal_type="fake_heartbeat",
            severity="warning" if cv > 0.02 else "critical",
            score=round(cv, 4),
            threshold=FAKE_HEARTBEAT_CV_THRESHOLD,
            sample_count=len(intervals),
            detail={
                "interval_mean_s": round(mean, 1),
                "interval_std_s": round(std, 1),
                "interval_min_s": round(min(intervals), 1),
                "interval_max_s": round(max(intervals), 1),
            },
            recommendation=f"心跳/派单间隔完美等距 (CV={cv:.3f}) · 疑似脚本伪造 · 建议人工排查",
        )

    return CheatSignal(
        worker_id=worker_id,
        signal_type="normal",
        severity="normal",
        score=round(cv, 4),
        threshold=FAKE_HEARTBEAT_CV_THRESHOLD,
        sample_count=len(intervals),
        detail={
            "interval_mean_s": round(mean, 1),
            "interval_std_s": round(std, 1),
        },
    )


# ════════════════════════════════════════════════════════════════════════════
# 3. 批量检测 + 写 audit (admin 触发 / cron 用)
# ════════════════════════════════════════════════════════════════════════════

def scan_all(
    *,
    only_online: bool = True,
    write_audit: bool = True,
) -> dict:
    """
    扫描所有节点 · 检测慢作弊 + 假心跳 · 返汇总
    
    Returns:
        {
            "total": 4,
            "alerts": [{worker_id, signal_type, severity, ...}],
            "signal_count": {normal: 3, slow_cheat: 0, fake_heartbeat: 1},
        }
    """
    from sqlalchemy import select
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import workers_t

    out = {
        "total": 0,
        "alerts": [],
        "signal_count": {
            "normal": 0,
            "slow_cheat": 0,
            "fast_cheat": 0,
            "fake_heartbeat": 0,
        },
    }

    with db_mod.session_scope() as s:
        stmt = select(workers_t.c.id, workers_t.c.name)
        if only_online:
            stmt = stmt.where(workers_t.c.status.in_(("ONLINE", "BUSY")))
        rows = s.execute(stmt).all()

        for r in rows:
            out["total"] += 1
            worker_id = str(r.id)

            # 慢作弊检测
            slow = detect_slow_cheat(worker_id, s)
            out["signal_count"][slow.signal_type] = out["signal_count"].get(slow.signal_type, 0) + 1
            if slow.signal_type != "normal":
                alert = {
                    "worker_id": worker_id, "name": r.name,
                    "type": slow.signal_type, "severity": slow.severity,
                    "score": slow.score, "detail": slow.detail,
                    "recommendation": slow.recommendation,
                }
                out["alerts"].append(alert)
                if write_audit:
                    _write_audit(s, slow)

            # 假心跳检测
            fake = detect_fake_heartbeat(worker_id, s)
            out["signal_count"][fake.signal_type] = out["signal_count"].get(fake.signal_type, 0) + 1
            if fake.signal_type != "normal":
                alert = {
                    "worker_id": worker_id, "name": r.name,
                    "type": fake.signal_type, "severity": fake.severity,
                    "score": fake.score, "detail": fake.detail,
                    "recommendation": fake.recommendation,
                }
                out["alerts"].append(alert)
                if write_audit:
                    _write_audit(s, fake)

        if write_audit:
            s.commit()

    logger.info(
        "anti_cheat.scan_all · total=%d alerts=%d distribution=%s",
        out["total"], len(out["alerts"]), out["signal_count"],
    )
    return out


def _write_audit(s, signal: CheatSignal) -> None:
    """把告警写到 we_reputation_events (审计 · 不直接扣分)"""
    from sqlalchemy import text
    import json
    s.execute(
        text("""
            INSERT INTO we_reputation_events
                (worker_id, event_type, delta,
                 reason, metadata, is_shadow, created_at)
            VALUES
                (CAST(:wid AS uuid), :etype, 0,
                 :reason, CAST(:meta AS jsonb), TRUE, NOW())
        """),
        {
            "wid": signal.worker_id,
            "etype": f"anti_cheat_{signal.signal_type}",
            "reason": signal.recommendation,
            "meta": json.dumps({
                "severity": signal.severity,
                "score": signal.score,
                "threshold": signal.threshold,
                "sample_count": signal.sample_count,
                "detail": signal.detail,
            }),
        },
    )
