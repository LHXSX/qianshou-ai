"""
NCE P2 · 硬件评分 + 等级归类

设计要点 (考虑全链路):
  1. 输入 WorkerCapabilities · 输出 hw_score (0-100) + hw_tier (S/A/B/C/D) + sub_scores
  2. P2 简化版 · 不依赖 benchmark · 只用上报的硬件参数:
       - CPU 30% (核心数 + 品牌档位)
       - RAM 25% (内存大小)
       - GPU 35% (gpu_count + VRAM + 品牌)
       - Storage 5% (暂不算 · 占位)
       - Network 5% (暂不算 · 占位)
  3. 档位划分:
       S 90-100   (旗舰 GPU · 大内存 · 高端 CPU)
       A 75-89    (高端配置)
       B 60-74    (主流配置 · 默认)
       C 45-59    (入门可用)
       D 0-44     (低端 · 仅做轻量任务)
  4. P1 权重是拍的 · P4 看真实数据调
  5. 所有计算纯函数 · 不动 DB · 易测
"""
from __future__ import annotations
import logging
from dataclasses import dataclass, asdict, field
from typing import Any

from platform_v8.core import Worker
from platform_v8.core.worker import WorkerCapabilities

logger = logging.getLogger(__name__)

# ════════════════════════════════════════════════════════════════════════════
# 权重 (P2 初始值 · 总和 = 100)
# ════════════════════════════════════════════════════════════════════════════

_W_CPU = 30
_W_RAM = 25
_W_GPU = 35
_W_STORAGE = 5
_W_NETWORK = 5

# 档位阈值
_TIER_THRESHOLDS = [
    ("S", 90),
    ("A", 75),
    ("B", 60),
    ("C", 45),
    ("D", 0),
]

# CPU 品牌加成 (能识别的高端 CPU 给 bonus · 不在表里默认 0)
# 格式: 子串匹配 (小写)
_CPU_BRAND_BONUS = {
    # NVIDIA workstation
    "xeon w-": 15,
    "threadripper pro": 15,
    "epyc": 12,
    # Apple Silicon 高端
    "m5 ultra": 18,
    "m5 max": 15,
    "m4 ultra": 16,
    "m4 max": 13,
    "m3 ultra": 14,
    "m3 max": 11,
    "m5 pro": 10,
    "m4 pro": 8,
    "m3 pro": 6,
    # Intel/AMD 旗舰
    "ultra 9": 10,
    "i9-14": 9, "i9-15": 12,
    "ryzen 9 79": 9, "ryzen 9 99": 12,
    # Intel/AMD 主流高端
    "ultra 7": 6,
    "i7-14": 5, "i7-15": 8,
    "ryzen 7 79": 5, "ryzen 7 99": 8,
}

# GPU 品牌加成
_GPU_BRAND_BONUS = {
    "h100": 25, "h200": 30, "b100": 30,
    "rtx 5090": 22, "rtx 5080": 18, "rtx 5070": 12,
    "rtx 4090": 20, "rtx 4080": 15, "rtx 4070": 10,
    "rtx 3090": 14, "rtx 3080": 10, "rtx 3070": 7,
    "a100": 22, "l40": 18, "a40": 15,
    # Apple Silicon (内置 GPU 通过 cpu_brand 加成 · 这里也给 VRAM-aware bonus)
    "apple silicon": 5,
    "metal": 4,
    "mlx": 3,
    # AMD
    "rx 7900": 14, "rx 7800": 10, "rx 6900": 9,
}


# ════════════════════════════════════════════════════════════════════════════
# 数据模型
# ════════════════════════════════════════════════════════════════════════════

@dataclass
class HwScoreResult:
    hw_score: float                    # 0-100
    hw_tier: str                       # S/A/B/C/D
    sub_scores: dict[str, float] = field(default_factory=dict)  # {cpu, ram, gpu, storage, network}
    detail: dict[str, Any] = field(default_factory=dict)        # {cpu_brand, cores, ram_gb, ...}


# ════════════════════════════════════════════════════════════════════════════
# 子分计算 (纯函数 · 输入数值/字符串 · 输出 0-100)
# ════════════════════════════════════════════════════════════════════════════

def _score_cpu_legacy(cores: int, cpu_brand: str = "") -> float:
    """
    CPU 评分 0-100（旧曲线 · YAML 未命中时使用）

    核心数曲线: 4=20, 8=50, 16=80, 24=92, 32+=100 (线性插值)
    品牌加成: M5 Max +15, Ultra 9 +10, ...
    """
    cores = max(0, int(cores or 0))
    # 核心数基础分
    if cores <= 0:
        base = 0
    elif cores <= 4:
        base = 5 + cores * 3.75   # 0→5, 4→20
    elif cores <= 8:
        base = 20 + (cores - 4) * 7.5  # 4→20, 8→50
    elif cores <= 16:
        base = 50 + (cores - 8) * 3.75  # 8→50, 16→80
    elif cores <= 32:
        base = 80 + (cores - 16) * 1.25  # 16→80, 32→100
    else:
        base = 100

    # 品牌加成
    bonus = 0
    brand_lower = (cpu_brand or "").lower()
    for needle, b in _CPU_BRAND_BONUS.items():
        if needle in brand_lower:
            bonus = max(bonus, b)  # 取最大匹配

    return min(100.0, base + bonus)


def _score_cpu(cores: int, cpu_brand: str = "") -> float:
    """
    CPU 评分 0-100

    优先查可替换 YAML 排行 (cpu_rank)；命中则 coeff×100。
    未命中回退 _score_cpu_legacy。
    """
    score, _meta = _score_cpu_with_meta(cores, cpu_brand)
    return score


def _score_cpu_with_meta(cores: int, cpu_brand: str = "") -> tuple[float, dict[str, Any]]:
    """返回 (cpu_subscore_0_100, meta)；meta 含 cpu_coeff / 命中信息。"""
    from platform_v8.services.economy import cpu_rank as cpu_rank_mod

    hit = cpu_rank_mod.lookup(cpu_brand)
    if hit is not None:
        score = round(float(hit.coeff) * 100.0, 2)
        return score, {
            "cpu_coeff": float(hit.coeff),
            "cpu_rank_grade": hit.grade,
            "cpu_rank_match": hit.match,
            "cpu_rank_rank": hit.rank,
            "cpu_rank_source": "yaml",
        }

    legacy = _score_cpu_legacy(cores, cpu_brand)
    coeff = cpu_rank_mod.cpu_coeff_for_brand(
        cpu_brand, fallback_score_0_100=legacy,
    )
    return legacy, {
        "cpu_coeff": float(coeff),
        "cpu_rank_source": "fallback",
    }


def _score_ram(ram_mb: int) -> float:
    """
    RAM 评分 0-100 (按 GB 分档)
    
    曲线: 4GB=15, 8=30, 16=50, 32=70, 64=85, 128+=100
    """
    if not ram_mb or ram_mb <= 0:
        return 0
    gb = ram_mb / 1024.0
    if gb < 4:
        return max(0, gb * 3.75)  # 0→0, 4→15
    elif gb < 8:
        return 15 + (gb - 4) * 3.75  # 4→15, 8→30
    elif gb < 16:
        return 30 + (gb - 8) * 2.5   # 8→30, 16→50
    elif gb < 32:
        return 50 + (gb - 16) * 1.25  # 16→50, 32→70
    elif gb < 64:
        return 70 + (gb - 32) * 0.46875  # 32→70, 64→85
    elif gb < 128:
        return 85 + (gb - 64) * 0.234375  # 64→85, 128→100
    else:
        return 100


def _score_gpu(gpu_count: int, vram_mb: int, gpu_model: str = "") -> float:
    """
    GPU 评分 0-100
    
    无 GPU (gpu_count=0): 仅 5 分 (能跑 CPU-only 任务)
    有 GPU:
      VRAM 基础: 4G=30, 8=50, 12=65, 16=75, 24=90, 48+=100
      多卡: gpu_count >= 2 加成 (每多一张 +5 · 上限 20)
      品牌加成: 4090 +20, H100 +25, M5 Max +15
    """
    if not gpu_count or gpu_count <= 0:
        return 5.0  # 无 GPU 给最低分 · CPU-only 任务可用

    vram_gb = (vram_mb or 0) / 1024.0
    # VRAM 基础分
    if vram_gb < 2:
        base = 15
    elif vram_gb < 4:
        base = 15 + (vram_gb - 2) * 7.5  # 2→15, 4→30
    elif vram_gb < 8:
        base = 30 + (vram_gb - 4) * 5    # 4→30, 8→50
    elif vram_gb < 12:
        base = 50 + (vram_gb - 8) * 3.75  # 8→50, 12→65
    elif vram_gb < 16:
        base = 65 + (vram_gb - 12) * 2.5  # 12→65, 16→75
    elif vram_gb < 24:
        base = 75 + (vram_gb - 16) * 1.875  # 16→75, 24→90
    elif vram_gb < 48:
        base = 90 + (vram_gb - 24) * 0.4167  # 24→90, 48→100
    else:
        base = 100

    # 多卡加成
    multi_card_bonus = 0
    if gpu_count >= 2:
        multi_card_bonus = min(20, (gpu_count - 1) * 5)

    # 品牌加成
    brand_bonus = 0
    model_lower = (gpu_model or "").lower()
    for needle, b in _GPU_BRAND_BONUS.items():
        if needle in model_lower:
            brand_bonus = max(brand_bonus, b)

    return min(100.0, base + multi_card_bonus + brand_bonus)


def _score_storage(caps: WorkerCapabilities) -> float:
    """按磁盘总容量打分 · 未上报时回落中位 50"""
    total_mb = int(getattr(caps, "total_disk_mb", 0) or 0)
    if total_mb <= 0:
        # 兼容仅上报 GB
        total_gb = float(getattr(caps, "total_disk_gb", 0) or 0)
        if total_gb > 0:
            total_mb = int(total_gb * 1024)
    if total_mb <= 0:
        return 50.0
    gb = total_mb / 1024.0
    if gb < 64:
        return 20.0
    if gb < 128:
        return 35.0
    if gb < 256:
        return 50.0
    if gb < 512:
        return 65.0
    if gb < 1024:
        return 80.0
    if gb < 2048:
        return 90.0
    return 100.0


def _score_network(_caps: WorkerCapabilities) -> float:
    """P2 占位 · 没字段 · 给中位分 50 (P3 接探针后真打分)"""
    return 50.0


# ════════════════════════════════════════════════════════════════════════════
# 主入口 · 综合评分 + 档位
# ════════════════════════════════════════════════════════════════════════════

def evaluate(caps: WorkerCapabilities) -> HwScoreResult:
    """
    给一个 WorkerCapabilities 算 hw_score + hw_tier
    
    用法:
      result = evaluate(worker.capabilities)
      print(result.hw_tier)     # 'A'
      print(result.hw_score)    # 78.5
      print(result.sub_scores)  # {cpu: 70, ram: 80, gpu: 85, ...}
    """
    if caps is None:
        return HwScoreResult(hw_score=0, hw_tier="D", sub_scores={}, detail={})

    # 取真实硬件参数 (兼容多种字段名)
    cores = int(getattr(caps, "cpu_cores", 0) or 0)
    cpu_brand = getattr(caps, "cpu_brand", "") or ""

    # 内存: 优先 total_memory_mb · 退到 memory_gb / ram_gb
    ram_mb = int(getattr(caps, "total_memory_mb", 0) or 0)
    if ram_mb == 0:
        memory_gb = float(getattr(caps, "memory_gb", 0) or 0)
        if memory_gb == 0:
            memory_gb = float(getattr(caps, "ram_gb", 0) or 0)
        ram_mb = int(memory_gb * 1024)

    gpu_count = int(getattr(caps, "gpu_count", 0) or 0)
    vram_mb = int(getattr(caps, "vram_mb", 0) or 0)
    gpu_model = getattr(caps, "gpu_model", "") or ""

    # 子分
    cpu_score, cpu_meta = _score_cpu_with_meta(cores, cpu_brand)
    sub = {
        "cpu": round(cpu_score, 2),
        "ram": round(_score_ram(ram_mb), 2),
        "gpu": round(_score_gpu(gpu_count, vram_mb, gpu_model), 2),
        "storage": round(_score_storage(caps), 2),
        "network": round(_score_network(caps), 2),
    }

    # 综合分 = 有真实测量的维度加权平均。
    # storage：上报 total_disk_mb 后纳入；network 仍无探针，继续排除。
    _measured = [
        (sub["cpu"], _W_CPU),
        (sub["ram"], _W_RAM),
        (sub["gpu"], _W_GPU),
    ]
    if int(getattr(caps, "total_disk_mb", 0) or 0) > 0:
        _measured.append((sub["storage"], _W_STORAGE))
    _w_sum = sum(w for _, w in _measured) or 1
    composite = sum(score * w for score, w in _measured) / _w_sum

    hw_score = round(min(100.0, max(0.0, composite)), 2)
    hw_tier = _tier_for_score(hw_score)

    detail = {
        "cpu_brand": cpu_brand,
        "cpu_cores": cores,
        "ram_mb": ram_mb,
        "gpu_count": gpu_count,
        "vram_mb": vram_mb,
        "gpu_model": gpu_model,
        "weights": {
            "cpu": _W_CPU, "ram": _W_RAM, "gpu": _W_GPU,
            "storage": _W_STORAGE, "network": _W_NETWORK,
        },
        **cpu_meta,
    }

    return HwScoreResult(
        hw_score=hw_score,
        hw_tier=hw_tier,
        sub_scores=sub,
        detail=detail,
    )


def _tier_for_score(score: float) -> str:
    """根据 hw_score 归类档位"""
    for tier, threshold in _TIER_THRESHOLDS:
        if score >= threshold:
            return tier
    return "D"


def evaluate_worker(worker: Worker) -> HwScoreResult:
    """便捷封装 · 直接对 Worker 算"""
    return evaluate(worker.capabilities)


# ════════════════════════════════════════════════════════════════════════════
# 持久化 · 把结果写到 we_workers + we_hw_score_history
# ════════════════════════════════════════════════════════════════════════════

def persist_score(
    worker_id: str,
    result: HwScoreResult,
    *,
    trigger: str = "cron",
    capabilities_snapshot: dict | None = None,
    session=None,
) -> None:
    """
    把 hw_score / hw_tier 写到 we_workers + 加一条 we_hw_score_history
    
    trigger 可选:
      cron / onboard / admin_manual / capability_change
    """
    from sqlalchemy import text
    from platform_v8.storage import db as db_mod

    def _do(s):
        # SQLite 本地联调不支持 PG 的 NOW()/jsonb · 按方言降级
        dialect = s.bind.dialect.name if s.bind is not None else "postgresql"
        sql_now = "NOW()" if dialect == "postgresql" else "CURRENT_TIMESTAMP"
        json_cast = "CAST(:{k} AS jsonb)" if dialect == "postgresql" else ":{k}"

        # 1. UPDATE we_workers (只改 NCE 字段 · 不动 reputation/capability_score 老字段)
        s.execute(
            text(f"""
                UPDATE we_workers
                SET hw_tier = :tier,
                    hw_score = :score,
                    hw_evaluated_at = {sql_now}
                WHERE id = CAST(:wid AS uuid)
            """),
            {"tier": result.hw_tier, "score": result.hw_score, "wid": worker_id},
        )

        # 2. INSERT we_hw_score_history (审计 + 趋势)
        import json
        s.execute(
            text(f"""
                INSERT INTO we_hw_score_history
                    (worker_id, hw_tier, hw_score, sub_scores,
                     trigger, capabilities_snapshot, created_at)
                VALUES
                    (CAST(:wid AS uuid), :tier, :score,
                     {json_cast.format(k="sub")}, :trigger,
                     {json_cast.format(k="cap_snap")}, {sql_now})
            """),
            {
                "wid": worker_id,
                "tier": result.hw_tier,
                "score": result.hw_score,
                "sub": json.dumps(result.sub_scores),
                "trigger": trigger,
                "cap_snap": json.dumps(capabilities_snapshot or {}),
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
    """
    批量重算所有节点的 hw_score
    
    Args:
        only_online: 只算 ONLINE/BUSY 节点 (cron 默认 True · 节省时间)
        trigger: 触发来源 · 写到 history.trigger 字段
        dry_run: True = 只计算不写库 (admin 调试)
    
    Returns:
        {
            "total": 13,
            "updated": 4,
            "tier_distribution": {"S": 0, "A": 2, "B": 11, "C": 0, "D": 0},
            "tier_changes": [{worker_id, old_tier, new_tier, old_score, new_score}, ...],
            "dry_run": False,
        }
    """
    from sqlalchemy import text
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import _row_to_worker, workers_t
    from sqlalchemy import select

    out = {
        "total": 0,
        "updated": 0,
        "skipped_no_caps": 0,
        "tier_distribution": {"S": 0, "A": 0, "B": 0, "C": 0, "D": 0},
        "tier_changes": [],
        "dry_run": dry_run,
        "trigger": trigger,
    }

    with db_mod.session_scope() as s:
        stmt = select(workers_t)
        if only_online:
            stmt = stmt.where(workers_t.c.status.in_(("ONLINE", "BUSY")))
        rows = s.execute(stmt).all()

        for r in rows:
            out["total"] += 1
            worker = _row_to_worker(r)
            caps = worker.capabilities

            # 没硬件信息 · 跳过 (避免误降档)
            if not caps or (
                getattr(caps, "cpu_cores", 0) == 0
                and getattr(caps, "total_memory_mb", 0) == 0
                and getattr(caps, "gpu_count", 0) == 0
            ):
                out["skipped_no_caps"] += 1
                continue

            result = evaluate(caps)
            out["tier_distribution"][result.hw_tier] += 1

            old_tier = getattr(r, "hw_tier", None)
            old_score = float(getattr(r, "hw_score", 0) or 0)

            if old_tier != result.hw_tier or abs(old_score - result.hw_score) > 0.5:
                out["tier_changes"].append({
                    "worker_id": str(worker.id),
                    "name": worker.name,
                    "old_tier": old_tier, "new_tier": result.hw_tier,
                    "old_score": round(old_score, 2),
                    "new_score": result.hw_score,
                    "sub_scores": result.sub_scores,
                })

            if not dry_run:
                cap_snap = {
                    "cpu_brand": getattr(caps, "cpu_brand", ""),
                    "cpu_cores": getattr(caps, "cpu_cores", 0),
                    "total_memory_mb": getattr(caps, "total_memory_mb", 0),
                    "gpu_model": getattr(caps, "gpu_model", ""),
                    "gpu_count": getattr(caps, "gpu_count", 0),
                    "vram_mb": getattr(caps, "vram_mb", 0),
                }
                persist_score(
                    str(worker.id), result,
                    trigger=trigger,
                    capabilities_snapshot=cap_snap,
                    session=s,
                )
                out["updated"] += 1

        if not dry_run:
            s.commit()

    logger.info(
        "hw_scoring.recompute_all · total=%d updated=%d distribution=%s changes=%d (trigger=%s dry_run=%s)",
        out["total"], out["updated"], out["tier_distribution"],
        len(out["tier_changes"]), trigger, dry_run,
    )
    return out
