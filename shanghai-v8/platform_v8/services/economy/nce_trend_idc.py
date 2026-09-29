"""
NCE P4.7 + P4.8 · 历史趋势报警 + 反作弊 Layer B (IDC 聚合)

设计要点 (考虑全链路):

  P4.7 历史趋势报警:
    - 比较节点最近 7d hw_score 均值 vs 30d 均值
    - 偏差档位:
        ≤ 3 分     → healthy   (健康)
        3-7 分     → mild      (轻度劣化)
        7-15 分    → moderate  (中度劣化 · 告警)
        > 15 分    → severe    (严重劣化 · 立即处理)
    - 写 we_hw_score_history.trigger=trend_alert
  
  P4.8 反作弊 Layer B (IDC 聚合):
    - 用 IP 的 /24 子网作 IDC 近似 (PRD §17)
    - 同 /24 节点数 > 阈值 (10) → 高密度 IDC → 降权
    - 同 /24 + 同 owner_id → 怀疑 NAT 后多假节点 → 高度可疑
    - 不直接扣分 · 写 audit · admin 处理
    
  设计简化 (P4 版):
    - 不依赖 GeoIP 库 (节省外部依赖)
    - 用现有 we_workers 数据 (last_seen + capabilities) 反推
    - last_ip 字段在 we_workers 暂无 · 用 capabilities.hostname 作为分组键 (P5 加 last_ip)
    - 现阶段: 用 owner_id + capabilities.hostname 做粗筛
"""
from __future__ import annotations
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# ════════════════════════════════════════════════════════════════════════════
# 阈值
# ════════════════════════════════════════════════════════════════════════════

# 趋势报警
TREND_HEALTHY_DELTA = 3      # ≤ 3 分 = healthy
TREND_MILD_DELTA = 7         # 3-7 = mild
TREND_MODERATE_DELTA = 15    # 7-15 = moderate · > 15 = severe

# IDC 聚合
IDC_NODE_THRESHOLD = 10      # 同 IDC > 10 节点 → 高密度
IDC_OWNER_THRESHOLD = 3      # 同 IDC + 同 owner > 3 节点 → 可疑


# ════════════════════════════════════════════════════════════════════════════
# 数据模型
# ════════════════════════════════════════════════════════════════════════════

@dataclass
class TrendAlert:
    worker_id: str
    status: str          # healthy / mild / moderate / severe
    score_7d: float
    score_30d: float
    delta: float
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass
class IdcCluster:
    cluster_key: str    # 分组键 (hostname 前缀 / IP 子网 等)
    node_count: int
    owner_distribution: dict[int, int]   # {owner_id: count}
    is_suspicious: bool = False
    reason: str = ""
    worker_ids: list[str] = field(default_factory=list)


# ════════════════════════════════════════════════════════════════════════════
# P4.7 · 历史趋势报警
# ════════════════════════════════════════════════════════════════════════════

def analyze_trend(worker_id: str, session) -> TrendAlert:
    """
    比较 worker 最近 7d vs 30d 的 hw_score 趋势
    
    Returns: TrendAlert with status (healthy/mild/moderate/severe)
    """
    from sqlalchemy import text

    # 7d 均值
    row7 = session.execute(
        text("""
            SELECT AVG(hw_score)::float AS avg, COUNT(*) AS cnt
            FROM we_hw_score_history
            WHERE worker_id = CAST(:wid AS uuid)
              AND created_at > NOW() - INTERVAL '7 days'
        """),
        {"wid": worker_id},
    ).fetchone()
    avg_7d = float(row7[0] or 0)
    cnt_7d = int(row7[1] or 0)

    # 30d 均值
    row30 = session.execute(
        text("""
            SELECT AVG(hw_score)::float AS avg, COUNT(*) AS cnt
            FROM we_hw_score_history
            WHERE worker_id = CAST(:wid AS uuid)
              AND created_at > NOW() - INTERVAL '30 days'
        """),
        {"wid": worker_id},
    ).fetchone()
    avg_30d = float(row30[0] or 0)
    cnt_30d = int(row30[1] or 0)

    # 数据不足
    if cnt_7d < 2 or cnt_30d < 4:
        return TrendAlert(
            worker_id=worker_id,
            status="healthy",      # 数据不够 · 默认 healthy
            score_7d=avg_7d,
            score_30d=avg_30d,
            delta=0,
            detail={
                "reason": "insufficient_data",
                "cnt_7d": cnt_7d, "cnt_30d": cnt_30d,
            },
        )

    # delta = 30d 均值 - 7d 均值 (正 = 在劣化 · 负 = 在改善)
    delta = avg_30d - avg_7d
    abs_delta = abs(delta)

    if abs_delta <= TREND_HEALTHY_DELTA:
        status = "healthy"
    elif abs_delta <= TREND_MILD_DELTA:
        status = "mild" if delta > 0 else "improving"
    elif abs_delta <= TREND_MODERATE_DELTA:
        status = "moderate" if delta > 0 else "improving"
    else:
        status = "severe" if delta > 0 else "improving"

    return TrendAlert(
        worker_id=worker_id,
        status=status,
        score_7d=round(avg_7d, 2),
        score_30d=round(avg_30d, 2),
        delta=round(delta, 2),
        detail={"cnt_7d": cnt_7d, "cnt_30d": cnt_30d},
    )


def scan_trend_all(only_online: bool = True, write_audit: bool = True) -> dict:
    """批量扫所有节点的趋势 · 告警 mild+ 节点"""
    from sqlalchemy import select
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import workers_t

    out = {
        "total": 0,
        "status_count": {"healthy": 0, "mild": 0, "moderate": 0,
                         "severe": 0, "improving": 0},
        "alerts": [],
    }

    with db_mod.session_scope() as s:
        stmt = select(workers_t.c.id, workers_t.c.name)
        if only_online:
            stmt = stmt.where(workers_t.c.status.in_(("ONLINE", "BUSY")))
        rows = s.execute(stmt).all()

        for r in rows:
            out["total"] += 1
            alert = analyze_trend(str(r.id), s)
            out["status_count"][alert.status] = out["status_count"].get(alert.status, 0) + 1
            if alert.status in ("mild", "moderate", "severe"):
                out["alerts"].append({
                    "worker_id": str(r.id), "name": r.name,
                    "status": alert.status, "delta": alert.delta,
                    "score_7d": alert.score_7d, "score_30d": alert.score_30d,
                })

        if write_audit and out["alerts"]:
            _write_trend_audit(s, out["alerts"])
            s.commit()

    logger.info("nce_trend.scan_all · total=%d distribution=%s alerts=%d",
                out["total"], out["status_count"], len(out["alerts"]))
    return out


def _write_trend_audit(s, alerts: list) -> None:
    """趋势告警写到 we_hw_score_history (trigger=trend_alert)"""
    from sqlalchemy import text
    import json
    for a in alerts:
        s.execute(
            text("""
                INSERT INTO we_hw_score_history
                    (worker_id, hw_tier, hw_score, sub_scores, trigger, created_at)
                VALUES
                    (CAST(:wid AS uuid), :tier, :score, CAST(:sub AS jsonb),
                     :trigger, NOW())
            """),
            {
                "wid": a["worker_id"],
                "tier": "X",  # X = 未变 · 仅写告警
                "score": a["score_7d"],
                "sub": json.dumps({
                    "alert_type": "trend_degradation",
                    "status": a["status"],
                    "delta": a["delta"],
                    "score_30d": a["score_30d"],
                }),
                "trigger": "trend_alert",
            },
        )


# ════════════════════════════════════════════════════════════════════════════
# P4.8 · IDC 聚合 (反作弊 Layer B)
# ════════════════════════════════════════════════════════════════════════════

def _cluster_key(capabilities: dict) -> str:
    """
    用 capabilities 派生 IDC 分组键 (P4 简化版)
    
    优先级:
      1. hostname 前 8 字符 (e.g. "iZj6cfyf" · 同前缀 = 同 IDC)
      2. cpu_brand + os_name + os_version (相同硬件 · 同批机)
      3. "unknown"
    
    P5 加 last_ip /24 子网 (需 we_workers 加 last_ip 字段)
    """
    if not capabilities:
        return "unknown"
    
    hostname = capabilities.get("hostname") or ""
    if hostname and len(hostname) >= 8:
        return f"host_prefix:{hostname[:8]}"
    
    cpu = capabilities.get("cpu_brand") or ""
    os_name = capabilities.get("os_name") or ""
    os_ver = capabilities.get("os_version") or ""
    if cpu or os_name:
        return f"hwgroup:{cpu[:12]}|{os_name}|{os_ver[:10]}"
    
    return "unknown"


def detect_idc_clusters(only_online: bool = True) -> list[IdcCluster]:
    """
    扫所有节点 · 按 _cluster_key 分组 · 找出可疑高密度 IDC
    """
    from sqlalchemy import select
    from collections import defaultdict
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import workers_t

    groups: dict[str, list] = defaultdict(list)

    with db_mod.session_scope() as s:
        stmt = select(
            workers_t.c.id, workers_t.c.name, workers_t.c.owner_id,
            workers_t.c.capabilities,
        )
        if only_online:
            stmt = stmt.where(workers_t.c.status.in_(("ONLINE", "BUSY")))
        rows = s.execute(stmt).all()

        for r in rows:
            caps = r.capabilities or {}
            if isinstance(caps, str):
                import json
                try:
                    caps = json.loads(caps)
                except Exception:
                    caps = {}
            key = _cluster_key(caps)
            groups[key].append({
                "worker_id": str(r.id),
                "name": r.name,
                "owner_id": r.owner_id,
            })

    clusters = []
    for key, members in groups.items():
        if key == "unknown":
            continue  # 不识别的不告警

        owner_dist = defaultdict(int)
        for m in members:
            owner_dist[m["owner_id"]] += 1

        is_suspicious = False
        reason_parts = []

        if len(members) >= IDC_NODE_THRESHOLD:
            is_suspicious = True
            reason_parts.append(f"同 IDC {len(members)} 节点 (≥{IDC_NODE_THRESHOLD})")

        max_owner_count = max(owner_dist.values()) if owner_dist else 0
        if max_owner_count >= IDC_OWNER_THRESHOLD:
            is_suspicious = True
            top_owner = max(owner_dist, key=owner_dist.get)
            reason_parts.append(
                f"同 IDC + owner={top_owner} 有 {max_owner_count} 节点 (≥{IDC_OWNER_THRESHOLD})"
            )

        cluster = IdcCluster(
            cluster_key=key,
            node_count=len(members),
            owner_distribution=dict(owner_dist),
            is_suspicious=is_suspicious,
            reason=" · ".join(reason_parts) if reason_parts else "",
            worker_ids=[m["worker_id"] for m in members],
        )
        clusters.append(cluster)

    return clusters


def scan_idc_all(only_online: bool = True, write_audit: bool = True) -> dict:
    """admin 触发 · 找出可疑 IDC + 写 audit"""
    clusters = detect_idc_clusters(only_online=only_online)
    suspicious = [c for c in clusters if c.is_suspicious]

    out = {
        "total_clusters": len(clusters),
        "suspicious_count": len(suspicious),
        "clusters": [
            {
                "cluster_key": c.cluster_key,
                "node_count": c.node_count,
                "owner_distribution": c.owner_distribution,
                "is_suspicious": c.is_suspicious,
                "reason": c.reason,
                "worker_ids": c.worker_ids,
            }
            for c in clusters
        ],
    }

    if write_audit and suspicious:
        from platform_v8.storage import db as db_mod
        with db_mod.session_scope() as s:
            _write_idc_audit(s, suspicious)
            s.commit()

    logger.info("nce_idc.scan_all · total=%d suspicious=%d",
                len(clusters), len(suspicious))
    return out


def _write_idc_audit(s, clusters: list[IdcCluster]) -> None:
    """IDC 告警写到 we_reputation_events"""
    from sqlalchemy import text
    import json
    for c in clusters:
        for wid in c.worker_ids:
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
                    "wid": wid,
                    "etype": "idc_suspicious_cluster",
                    "reason": c.reason,
                    "meta": json.dumps({
                        "cluster_key": c.cluster_key,
                        "node_count": c.node_count,
                        "owner_distribution": c.owner_distribution,
                    }),
                },
            )
