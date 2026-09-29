"""
NCE P3 · 多维信誉 4 子分 + 调和平均

设计要点 (考虑全链路):
  1. 4 子分:
       stability   (25%) - 在线稳定性 · 从 last_seen + heartbeat 派生
       correctness (40%) - 正确率 · DONE/(DONE+FAILED) · 从 we_shards
       speed       (20%) - 速度 · elapsed_ms vs task_type 中位数 · 从 we_shards
       resource    (15%) - 资源诚信 · P3 默认 70 (P4 接 benchmark)
  
  2. 主分 = 加权调和平均 (短板放大 · 鼓励均衡)
       rep_main = N / sum(w_i / s_i)
       任何一项极低 · 主分会大幅下降
  
  3. 评分时间窗: 最近 30 天 shard
     - 新节点 (< 10 shard) · 全部子分用默认 60 (实习期)
     - 老节点充分数据 · 用真实派生
  
  4. 持久化: 写 we_workers.rep_* + we_reputation_events (审计)
  
  5. P3 阈值是拍的 · P4 看真实分布调
"""
from __future__ import annotations
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

# ════════════════════════════════════════════════════════════════════════════
# 权重 (总和 100)
# ════════════════════════════════════════════════════════════════════════════

_W_STABILITY = 25
_W_CORRECTNESS = 40
_W_SPEED = 20
_W_RESOURCE = 15

# 新节点门槛 (shard 不足时全部用默认)
_MIN_SHARDS_FOR_REAL = 10
_DEFAULT_NEW_NODE_SCORE = 60

# stability 评分 · 24h 在线比 · uptime 90%+ 即满分
_STABILITY_UPTIME_TARGET = 0.90

# speed 评分 · 多快算满分 · 简化版用 elapsed_ms 阈值
# 超过 task_type 中位数 2x · 给 50 分; 4x · 给 25; 8x · 给 10
_SPEED_TARGET_RATIO = 1.0
_SPEED_TOLERANT_RATIO = 2.0

# 时间窗
_WINDOW_DAYS = 30


# ════════════════════════════════════════════════════════════════════════════
# 数据模型
# ════════════════════════════════════════════════════════════════════════════

@dataclass
class RepScoreResult:
    worker_id: str
    rep_main: int
    sub_scores: dict[str, int] = field(default_factory=dict)   # stability/correctness/speed/resource
    detail: dict[str, Any] = field(default_factory=dict)       # 统计明细
    is_default: bool = False  # True = 新节点 · 全默认 60


# ════════════════════════════════════════════════════════════════════════════
# 子分计算
# ════════════════════════════════════════════════════════════════════════════

def _score_correctness(done: int, failed: int) -> tuple[int, dict]:
    """
    正确率 = DONE / (DONE + FAILED) · 100
    
    >=99%  → 100  (旗舰)
    95-99% → 80-100 线性
    90-95% → 60-80 线性
    80-90% → 40-60 线性
    <80%   → 跟实际比例 · 70% → 35 · 50% → 25 · 0% → 0
    """
    total = done + failed
    if total == 0:
        return _DEFAULT_NEW_NODE_SCORE, {"reason": "no_data"}

    rate = done / total
    if rate >= 0.99:
        score = 100
    elif rate >= 0.95:
        score = 80 + (rate - 0.95) * 500       # 0.95→80, 0.99→100
    elif rate >= 0.90:
        score = 60 + (rate - 0.90) * 400       # 0.90→60, 0.95→80
    elif rate >= 0.80:
        score = 40 + (rate - 0.80) * 200       # 0.80→40, 0.90→60
    else:
        score = max(0, rate * 50)              # 0→0, 80%→40

    return int(score), {
        "done": done,
        "failed": failed,
        "success_rate": round(rate, 4),
    }


def _score_speed(avg_elapsed_ms: float, target_ms: float) -> tuple[int, dict]:
    """
    速度评分 = 跟 task_type 中位数比
    
    elapsed <= target * 1.0  → 100
    elapsed <= target * 2.0  → 75
    elapsed <= target * 4.0  → 50
    elapsed <= target * 8.0  → 25
    elapsed >  target * 8.0  → 10
    """
    if not avg_elapsed_ms or not target_ms or target_ms <= 0:
        return _DEFAULT_NEW_NODE_SCORE, {"reason": "no_data"}

    ratio = avg_elapsed_ms / target_ms
    if ratio <= _SPEED_TARGET_RATIO:
        score = 100
    elif ratio <= _SPEED_TOLERANT_RATIO:
        score = 75 + (_SPEED_TOLERANT_RATIO - ratio) * 25   # 1→100, 2→75
    elif ratio <= 4.0:
        score = 50 + (4.0 - ratio) * 12.5                   # 2→75, 4→50
    elif ratio <= 8.0:
        score = 25 + (8.0 - ratio) * 6.25                   # 4→50, 8→25
    else:
        score = 10

    return int(score), {
        "avg_elapsed_ms": round(avg_elapsed_ms, 1),
        "target_ms": round(target_ms, 1),
        "ratio": round(ratio, 3),
    }


def _score_stability(uptime_ratio_24h: float) -> tuple[int, dict]:
    """
    稳定性 = 24h 在线比 · 1.0 = 全程在线
    
    >= 0.95 → 100
    0.90 → 90
    0.80 → 75
    0.50 → 40
    0.00 → 10
    """
    if uptime_ratio_24h is None:
        return _DEFAULT_NEW_NODE_SCORE, {"reason": "no_data"}

    r = max(0.0, min(1.0, uptime_ratio_24h))
    if r >= 0.95:
        score = 100
    elif r >= 0.90:
        score = 90 + (r - 0.90) * 200       # 0.90→90, 0.95→100
    elif r >= 0.80:
        score = 75 + (r - 0.80) * 150       # 0.80→75, 0.90→90
    elif r >= 0.50:
        score = 40 + (r - 0.50) * 116.67    # 0.50→40, 0.80→75
    else:
        score = max(10, r * 80)             # 0→10, 0.50→50

    return int(score), {"uptime_ratio_24h": round(r, 4)}


def _score_resource(worker=None) -> tuple[int, dict]:
    """资源诚信 · P5 NCE · 接客户端 benchmark.rs 上报的 capability_score

    客户端启动跑 ~3s micro-bench (SHA256 50MB / mem 顺写 / disk 写 100MB)
    综合 = cpu*0.5 + mem*0.3 + disk*0.2 (0-100)

    陈老机器打不过 · 高端合 90+ · NCE 用来区分"丰富资源节点"与"贫血节点"
    旧节点 (未上报) / 老客户端 · 回退到默认 60
    """
    if worker is not None:
        cap = getattr(worker, "capabilities", None)
        if cap is not None:
            bench = float(getattr(cap, "bench_capability_score", 0.0) or 0.0)
            if bench > 0:
                # 限制 0-100 + 取整
                score = max(20, min(100, int(round(bench))))
                return score, {
                    "source": "client_benchmark",
                    "raw_score": round(bench, 1),
                    "cpu_mb_per_sec": float(getattr(cap, "bench_cpu_mb_per_sec", 0.0) or 0.0),
                    "mem_gb_per_sec": float(getattr(cap, "bench_memory_gb_per_sec", 0.0) or 0.0),
                    "disk_mb_per_sec": float(getattr(cap, "bench_disk_mb_per_sec", 0.0) or 0.0),
                }
    return _DEFAULT_NEW_NODE_SCORE, {"source": "default_new_node_no_bench"}


# ════════════════════════════════════════════════════════════════════════════
# 调和平均 (短板放大 · 鼓励均衡)
# ════════════════════════════════════════════════════════════════════════════

def _harmonic_mean(scores: dict[str, int], weights: dict[str, int]) -> int:
    """
    加权调和平均 (2026-05-25 P4.18 已弃用 · 留作对比)
    
    公式: H = sum(w_i) / sum(w_i / s_i)
    
    问题: 一票否决过严 · 一项 1 分 → 主分 ~6 (其他全 90 也救不回)
    """
    total_w = sum(weights.values())
    denominator = sum(weights[k] / max(scores[k], 1) for k in weights)
    if denominator == 0:
        return 60
    return int(round(total_w / denominator))


def _geometric_mean(scores: dict[str, int], weights: dict[str, int]) -> int:
    """
    P4.18 加权几何平均 (取代调和平均做主分公式)
    
    公式: G = exp( sum(w_i * ln(s_i)) / sum(w_i) )
    
    特点:
      - 短板有惩罚但不极端 (例: 90/90/90/1 → ~47 · 调和给 ~6)
      - 鼓励均衡 (全均 60 → 60 · 全 100 → 100)
      - 单项 0 分也不会让主分崩成 0 (max(s, 1) + 地板 _REP_MAIN_FLOOR)
    
    地板 _REP_MAIN_FLOOR=20 防"被 ban 节点直接 0 分" · 留给运营手动观察
    天花板 100 防溢出
    """
    import math
    total_w = sum(weights.values())
    if total_w <= 0:
        return 60
    log_sum = sum(weights[k] * math.log(max(scores[k], 1)) for k in weights)
    g = math.exp(log_sum / total_w)
    return max(_REP_MAIN_FLOOR, min(100, int(round(g))))


# P4.18 · rep_main 地板 · 防偶发失败一次性崩到 0
_REP_MAIN_FLOOR = 20


# ════════════════════════════════════════════════════════════════════════════
# 主入口 · 给一个 worker 算 4 子分 + 主分
# ════════════════════════════════════════════════════════════════════════════

def evaluate_worker(
    worker_id: str,
    *,
    window_days: int = _WINDOW_DAYS,
    session=None,
) -> RepScoreResult:
    """
    给一个 worker 算 4 子分 + 主分
    
    数据来源:
      - correctness/speed: we_shards (最近 N 天)
      - stability: we_workers.last_seen + 心跳 (P3 简化: 用 last_seen 距今估)
      - resource: 默认 70
    """
    from platform_v8.storage import db as db_mod

    def _do(s):
        return _evaluate_impl(s, worker_id, window_days)

    if session is not None:
        return _do(session)
    with db_mod.session_scope() as s:
        return _do(s)


def _evaluate_impl(s, worker_id: str, window_days: int) -> RepScoreResult:
    from sqlalchemy import text

    # 1. correctness · 从 we_shards 派生
    # P3+ flag nce_difficulty_factor ON 时 · 按 task_type 加权 (难任务 DONE 更值钱)
    use_difficulty = _check_difficulty_flag()

    if use_difficulty:
        # JOIN we_workloads 拿 task_type
        type_rows = s.execute(
            text("""
                SELECT
                    w.spec->>'task_type' AS task_type,
                    SUM(CASE WHEN sh.status = 'DONE' THEN 1 ELSE 0 END) AS done,
                    -- v8.1.8 · env 类失败(缺包/坏 venv/缺工具)是环境问题·节点正在自愈·
                    -- 不计入正确率,否则错杀(与 capability_feedback env 豁免对齐)
                    SUM(CASE WHEN sh.status = 'FAILED'
                             AND COALESCE(sh.failure_class,'') NOT LIKE 'env_%'
                             THEN 1 ELSE 0 END) AS failed,
                    COUNT(*) AS total
                FROM we_shards sh
                JOIN we_workloads w ON sh.workload_id = w.id
                WHERE sh.worker_id = CAST(:wid AS uuid)
                  AND sh.completed_at > NOW() - make_interval(days => :days)
                  AND COALESCE((sh.metadata->'result_verification'->>'nce_excluded')::boolean, FALSE) = FALSE
                GROUP BY w.spec->>'task_type'
            """),
            {"wid": worker_id, "days": window_days},
        ).fetchall()

        from platform_v8.services.economy.task_difficulty import get_difficulty
        weighted_done = 0.0
        weighted_failed = 0.0
        total = 0
        done = 0
        failed = 0
        difficulty_breakdown = {}
        for r in type_rows:
            t = r[0] or "unknown"
            d = float(r[1] or 0)
            f = float(r[2] or 0)
            tot = int(r[3] or 0)
            diff = get_difficulty(t)
            weighted_done += d * diff
            weighted_failed += f * diff
            done += int(d)
            failed += int(f)
            total += tot
            difficulty_breakdown[t] = {"done": int(d), "failed": int(f), "difficulty": diff}

        # 假装 correctness 用 weighted 算 (但传给 _score_correctness 的是 int)
        # 直接算 weighted 比率 · 然后映射到 done/failed 形式
        if weighted_done + weighted_failed > 0:
            # weighted_rate 视为新的"正确率"输入
            weighted_total = weighted_done + weighted_failed
            done_scaled = int(round(weighted_done / weighted_total * 100))
            failed_scaled = 100 - done_scaled
            done_for_scoring = done_scaled
            failed_for_scoring = failed_scaled
        else:
            done_for_scoring = done
            failed_for_scoring = failed
    else:
        # 老路径: 等权
        shard_stats = s.execute(
            text("""
                SELECT
                    SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done,
                    -- v8.1.8 · env 类失败不计入正确率(节点环境问题·正在自愈·勿错杀)
                    SUM(CASE WHEN status = 'FAILED'
                             AND COALESCE(failure_class,'') NOT LIKE 'env_%'
                             THEN 1 ELSE 0 END) AS failed,
                    COUNT(*) AS total
                FROM we_shards
                WHERE worker_id = CAST(:wid AS uuid)
                  AND completed_at > NOW() - make_interval(days => :days)
                  AND COALESCE((metadata->'result_verification'->>'nce_excluded')::boolean, FALSE) = FALSE
            """),
            {"wid": worker_id, "days": window_days},
        ).fetchone()
        done = int(shard_stats[0] or 0)
        failed = int(shard_stats[1] or 0)
        total = int(shard_stats[2] or 0)
        difficulty_breakdown = None
        done_for_scoring = done
        failed_for_scoring = failed

    # 新节点 (shard 不足) · 全默认
    if total < _MIN_SHARDS_FOR_REAL:
        return RepScoreResult(
            worker_id=worker_id,
            rep_main=_DEFAULT_NEW_NODE_SCORE,
            sub_scores={
                "stability": _DEFAULT_NEW_NODE_SCORE,
                "correctness": _DEFAULT_NEW_NODE_SCORE,
                "speed": _DEFAULT_NEW_NODE_SCORE,
                "resource": _DEFAULT_NEW_NODE_SCORE,
            },
            detail={"reason": "new_node_default", "total_shards": total,
                    "window_days": window_days},
            is_default=True,
        )

    correctness, correct_detail = _score_correctness(done_for_scoring, failed_for_scoring)
    if difficulty_breakdown is not None:
        correct_detail["difficulty_weighted"] = True
        correct_detail["breakdown"] = difficulty_breakdown
        correct_detail["raw_done"] = done
        correct_detail["raw_failed"] = failed

    # 2. speed · P4.17c 按 task_type 分组 · 每组跟 TARGET_MS 字典基线比 · 按完成数加权
    # 防"image_resize 100ms 和 llm_chat 30s 用同一全网平均判分"的失真
    type_speed_rows = s.execute(
        text("""
            SELECT
                w.spec->>'task_type' AS task_type,
                AVG(sh.elapsed_ms) AS avg_ms,
                COUNT(*) AS cnt
            FROM we_shards sh
            JOIN we_workloads w ON sh.workload_id = w.id
            WHERE sh.worker_id = CAST(:wid AS uuid)
              AND sh.status = 'DONE'
              AND sh.elapsed_ms IS NOT NULL
              AND sh.completed_at > NOW() - make_interval(days => :days)
              AND COALESCE((sh.metadata->'result_verification'->>'nce_excluded')::boolean, FALSE) = FALSE
            GROUP BY w.spec->>'task_type'
        """),
        {"wid": worker_id, "days": window_days},
    ).fetchall()

    from platform_v8.services.economy.task_difficulty import get_target_ms
    per_type_score = []  # [(score, weight=完成次数), ...]
    per_type_detail = {}
    for r in type_speed_rows:
        t = r[0] or "unknown"
        avg = float(r[1] or 0)
        cnt = int(r[2] or 0)
        if cnt == 0 or avg <= 0:
            continue
        target = float(get_target_ms(t))
        s_score, s_det = _score_speed(avg, target)
        per_type_score.append((s_score, cnt))
        per_type_detail[t] = {
            "avg_ms": round(avg, 1),
            "target_ms": int(target),
            "ratio": round(avg / target, 3) if target else None,
            "score": s_score,
            "cnt": cnt,
        }

    if per_type_score:
        total_w = sum(w for _, w in per_type_score)
        speed = int(round(sum(s * w for s, w in per_type_score) / total_w))
        speed_detail = {
            "per_task_type": per_type_detail,
            "weighted_avg": speed,
            "task_types_count": len(per_type_detail),
        }
    else:
        speed, speed_detail = _DEFAULT_NEW_NODE_SCORE, {"reason": "no_speed_data"}

    # 3. stability · P4.4 真打分 · 用 shard 派生 active_hours · 退回 last_seen
    stab_row = s.execute(
        text("""
            SELECT last_seen, registered_at
            FROM we_workers WHERE id = CAST(:wid AS uuid)
        """),
        {"wid": worker_id},
    ).fetchone()

    # 优先用 shard 派生 (24h 内有派单 = 真在工作)
    active_hours_24h = s.execute(
        text("""
            SELECT COUNT(DISTINCT DATE_TRUNC('hour', dispatched_at)) AS h
            FROM we_shards
            WHERE worker_id = CAST(:wid AS uuid)
              AND dispatched_at > NOW() - INTERVAL '24 hours'
        """),
        {"wid": worker_id},
    ).scalar() or 0

    uptime_ratio = _estimate_uptime_ratio_v2(stab_row, active_hours_24h)
    stability, stab_detail = _score_stability(uptime_ratio)
    stab_detail["active_hours_24h"] = int(active_hours_24h)

    # 4. resource · P5 NCE · 接客户端 benchmark 上报 · 老节点回退默认 60
    # 从 DB 读 worker 拿 capabilities.bench_capability_score
    try:
        from platform_v8.storage.repo import WorkerRepo as _WR
        worker_for_res = _WR.by_id(s, worker_id)
    except Exception:
        worker_for_res = None
    resource, res_detail = _score_resource(worker_for_res)

    # 5. 调和平均
    sub = {
        "stability": stability,
        "correctness": correctness,
        "speed": speed,
        "resource": resource,
    }
    weights = {
        "stability": _W_STABILITY,
        "correctness": _W_CORRECTNESS,
        "speed": _W_SPEED,
        "resource": _W_RESOURCE,
    }
    # P4.18 · 加权几何平均取代调和平均 (缓解一票否决过严)
    rep_main = _geometric_mean(sub, weights)

    return RepScoreResult(
        worker_id=worker_id,
        rep_main=rep_main,
        sub_scores=sub,
        detail={
            "window_days": window_days,
            "total_shards": total,
            "stability_detail": stab_detail,
            "correctness_detail": correct_detail,
            "speed_detail": speed_detail,
            "resource_detail": res_detail,
            "weights": weights,
        },
        is_default=False,
    )


def _check_difficulty_flag() -> bool:
    """检查 nce_difficulty_factor flag · 任何异常返 False (fail-safe)"""
    try:
        from platform_v8.services.ops import feature_flags as ff
        return ff.is_enabled("nce_difficulty_factor", subject_id=None)
    except Exception:
        return False


def _estimate_uptime_ratio_v2(row, active_hours_24h: int) -> float | None:
    """
    P4.4 · stability 真打分 · 综合 last_seen + active_hours
    
    优先用 active_hours_24h:
      - >= 18h 活跃 → 0.95+
      - 12-18h → 0.8
      - 6-12h → 0.6
      - 1-6h → 0.4
      - 0 但 last_seen 在线 → 回退老算法 (worker 在线但暂时无任务)
      - 0 且 last_seen 离线 → 0.0
    """
    if active_hours_24h is None:
        active_hours_24h = 0
    active_hours_24h = int(active_hours_24h)

    # stability = 节点 reliability · 主要看 last_seen
    # active_hours 仅作加成 (有活动证明在线 · 但没活动不扣分 - 平台问题)
    base = _estimate_uptime_ratio(row) or 0.0

    # 活跃加成: 6h+ 加 0.05 · 12h+ 加 0.1 · 仅锦上添花
    if active_hours_24h >= 12:
        return min(1.0, base + 0.1)
    if active_hours_24h >= 6:
        return min(1.0, base + 0.05)
    # 1-6h 或 0 · 不加不减
    return base


def _estimate_uptime_ratio(row) -> float | None:
    """
    P3 简化 stability 估算:
      - last_seen 距今 > 24h → 0.0 (离线)
      - last_seen 距今 < 5 分钟 + 注册时间 > 24h → 0.95+ (持续在线)
      - 其他 → 按距今时间线性 (5min=1.0, 24h=0.0)
    
    P4 应改用真实 hb 频率 / online_window 派生
    """
    if row is None or row[0] is None:
        return None
    last_seen = row[0]
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    delta_min = (now - last_seen).total_seconds() / 60

    if delta_min > 1440:    # >24h
        return 0.0
    if delta_min <= 5:
        # 在线 · 用注册时间长短给 stability
        registered = row[1]
        if registered:
            if registered.tzinfo is None:
                registered = registered.replace(tzinfo=timezone.utc)
            online_days = (now - registered).total_seconds() / 86400
            if online_days >= 7:
                return 0.97
            elif online_days >= 1:
                return 0.90
            else:
                return 0.80
        return 0.85
    # 5min - 24h 之间 · 线性
    return max(0.0, 1.0 - delta_min / 1440)


# ════════════════════════════════════════════════════════════════════════════
# 持久化 · 写 we_workers + we_reputation_events
# ════════════════════════════════════════════════════════════════════════════

def persist_score(
    result: RepScoreResult,
    *,
    trigger: str = "cron",
    session=None,
) -> None:
    """
    把 4 子分 + 主分写到 we_workers · 加一条 we_reputation_events
    """
    from sqlalchemy import text
    from platform_v8.storage import db as db_mod

    def _do(s):
        # 1. UPDATE we_workers 信誉字段 (不动 reputation 老字段 · 共存)
        s.execute(
            text("""
                UPDATE we_workers
                SET rep_stability = :stab,
                    rep_correctness = :corr,
                    rep_speed = :spd,
                    rep_resource = :res,
                    rep_main = :main,
                    rep_updated_at = NOW()
                WHERE id = CAST(:wid AS uuid)
            """),
            {
                "stab": result.sub_scores.get("stability", 60),
                "corr": result.sub_scores.get("correctness", 60),
                "spd": result.sub_scores.get("speed", 60),
                "res": result.sub_scores.get("resource", 60),
                "main": result.rep_main,
                "wid": result.worker_id,
            },
        )

        # 2. INSERT we_reputation_events
        import json
        s.execute(
            text("""
                INSERT INTO we_reputation_events
                    (worker_id, event_type, delta,
                     before_score, after_score,
                     reason, metadata, is_shadow, created_at)
                VALUES
                    (CAST(:wid AS uuid), :etype, 0,
                     NULL, :after, :reason,
                     CAST(:meta AS jsonb), FALSE, NOW())
            """),
            {
                "wid": result.worker_id,
                "etype": f"rep_recompute_{trigger}",
                "after": result.rep_main,
                "reason": (
                    "new_node_default" if result.is_default
                    else f"recompute(trigger={trigger})"
                ),
                "meta": json.dumps({
                    "sub_scores": result.sub_scores,
                    "detail": result.detail,
                    "is_default": result.is_default,
                }),
            },
        )

    if session is not None:
        _do(session)
    else:
        with db_mod.session_scope() as s:
            _do(s)
            s.commit()


# ════════════════════════════════════════════════════════════════════════════
# 批量重算 (cron 入口)
# ════════════════════════════════════════════════════════════════════════════

def recompute_all(
    *,
    only_online: bool = True,
    trigger: str = "cron",
    dry_run: bool = False,
) -> dict:
    """批量重算所有节点的 4 子分 + 主分"""
    from sqlalchemy import text, select
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import workers_t

    out = {
        "total": 0,
        "updated": 0,
        "default_count": 0,  # 新节点用默认
        "dry_run": dry_run,
        "trigger": trigger,
        "histogram": {},     # rep_main 分布 (50 / 60 / 70 / 80 / 90+)
        "changes": [],       # 显著变化 (差 > 5)
    }

    with db_mod.session_scope() as s:
        stmt = select(workers_t.c.id, workers_t.c.name, workers_t.c.rep_main)
        if only_online:
            stmt = stmt.where(workers_t.c.status.in_(("ONLINE", "BUSY")))
        rows = s.execute(stmt).all()

        for r in rows:
            out["total"] += 1
            worker_id = str(r.id)
            old_main = int(r.rep_main or 60)

            result = _evaluate_impl(s, worker_id, _WINDOW_DAYS)
            if result.is_default:
                out["default_count"] += 1

            # 分布桶
            bucket = (result.rep_main // 10) * 10
            out["histogram"][bucket] = out["histogram"].get(bucket, 0) + 1

            # 显著变化
            if abs(old_main - result.rep_main) >= 5:
                out["changes"].append({
                    "worker_id": worker_id, "name": r.name,
                    "old_main": old_main, "new_main": result.rep_main,
                    "sub_scores": result.sub_scores,
                })

            if not dry_run:
                persist_score(result, trigger=trigger, session=s)
                out["updated"] += 1

        if not dry_run:
            s.commit()

    logger.info(
        "rep_scoring.recompute_all · total=%d updated=%d defaults=%d histogram=%s changes=%d (trigger=%s)",
        out["total"], out["updated"], out["default_count"],
        out["histogram"], len(out["changes"]), trigger,
    )
    return out
