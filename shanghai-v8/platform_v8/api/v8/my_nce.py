"""
节点 owner 端 NCE API · /api/v8/my/workers/{worker_id}/nce

设计要点 (考虑全链路):
  - 鉴权: get_current_account (owner 自己看)
  - 权限: 只能看自己 owner_id 的节点 (其他 owner 看不到)
  - flag nce_api_expose_multi_dim 控:
       ON  → 返回完整 4 子分 + hw_tier 详情
       OFF → 只返老 reputation + 简化 hw_score (兼容旧 client)
  - 节点端 UI (千手 client v3) 可调本接口 · 给节点主看自己评分
  - 返回 + 改进建议 (e.g. "你的 stability 59 偏低 · 建议保持长连接")
"""
from __future__ import annotations
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.core import Account
from platform_v8.storage.repo import WorkerRepo
from platform_v8.services.ops import feature_flags as ff
from platform_v8.services.economy import hw_scoring, rep_scoring

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/my", tags=["my-nce"])


@router.get("/workers/{worker_id}/nce", summary="节点 owner 看自己节点的 NCE 评分")
def get_my_worker_nce(
    worker_id: str,
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
):
    """
    节点主看自己节点的 NCE (硬件等级 + 4 子分) · 含改进建议
    
    权限: 只能看自己 owner_id 的节点 · 404 = 不存在或不属于你
    
    feature flag nce_api_expose_multi_dim:
      ON  → 完整 4 子分 + detail
      OFF → 兼容模式 · 只返 reputation 0-1
    """
    worker = WorkerRepo.by_id(session, worker_id)
    if worker is None or worker.owner_id != current.id:
        raise HTTPException(status_code=404, detail="节点不存在或不属于你")

    expose_multi_dim = ff.is_enabled("nce_api_expose_multi_dim", subject_id=current.id)

    # 兼容模式: 只返老字段
    if not expose_multi_dim:
        return {
            "ok": True,
            "worker_id": worker_id,
            "name": worker.name,
            "status": worker.status.value if hasattr(worker.status, "value") else str(worker.status),
            "reputation": float(worker.reputation),
            "capability_score": float(worker.capability_score),
            "load": float(worker.load),
            "compatibility_mode": True,
            "message": "完整评分尚未对外开放 · 联系 admin",
        }

    # 完整模式
    hw_fresh = hw_scoring.evaluate(worker.capabilities)
    rep_fresh = rep_scoring.evaluate_worker(worker_id, session=session)

    # 5 条 hw history
    hw_hist = session.execute(
        text("""
            SELECT hw_tier, hw_score, sub_scores, trigger, created_at
            FROM we_hw_score_history
            WHERE worker_id = CAST(:wid AS uuid)
            ORDER BY created_at DESC LIMIT 5
        """),
        {"wid": worker_id},
    ).fetchall()

    # 改进建议
    suggestions = _build_suggestions(worker, hw_fresh, rep_fresh)

    return {
        "ok": True,
        "worker_id": worker_id,
        "name": worker.name,
        "status": worker.status.value if hasattr(worker.status, "value") else str(worker.status),
        "compatibility_mode": False,
        "hardware": {
            "hw_tier": worker.hw_tier,
            "hw_score": float(worker.hw_score),
            "sub_scores": hw_fresh.sub_scores,
            "detail": hw_fresh.detail,
            "history": [
                {
                    "hw_tier": r[0],
                    "hw_score": float(r[1]),
                    "sub_scores": r[2] or {},
                    "trigger": r[3],
                    "created_at": r[4].isoformat() if r[4] else None,
                }
                for r in hw_hist
            ],
        },
        "reputation": {
            "rep_main": worker.rep_main,
            "rep_stability": worker.rep_stability,
            "rep_correctness": worker.rep_correctness,
            "rep_speed": worker.rep_speed,
            "rep_resource": worker.rep_resource,
            "fresh_eval": {
                "rep_main": rep_fresh.rep_main,
                "sub_scores": rep_fresh.sub_scores,
                "is_default": rep_fresh.is_default,
                "detail": rep_fresh.detail,
            },
        },
        "runtime": {
            "load": float(worker.load),
            "active_shards": worker.active_shards,
            "onboarding_status": worker.onboarding_status,
        },
        "suggestions": suggestions,
    }


def _build_suggestions(worker, hw_fresh, rep_fresh) -> list[dict]:
    """根据评分生成改进建议 · 节点主可读"""
    out = []

    # 硬件相关
    if worker.hw_tier in ("C", "D"):
        sub = hw_fresh.sub_scores
        weakest = min(sub.items(), key=lambda kv: kv[1])
        out.append({
            "category": "hardware",
            "level": "info",
            "message": f"硬件档位 {worker.hw_tier} · 最低子分: {weakest[0]}={weakest[1]}",
            "advice": "升级硬件可解锁更多 SLA 任务 · 收益更高",
        })

    if worker.hw_tier == "S":
        out.append({
            "category": "hardware",
            "level": "praise",
            "message": "旗舰硬件 S 档 · 可接最高 SLA 任务",
            "advice": "保持当前配置 · 享受最优派单",
        })

    # 信誉相关
    if rep_fresh.is_default:
        out.append({
            "category": "reputation",
            "level": "info",
            "message": "新节点实习期 · 信誉默认 60",
            "advice": "完成 10+ 任务后系统会基于真实表现重新评分",
        })
    else:
        sub = rep_fresh.sub_scores
        for k, v in sub.items():
            if v < 50:
                advice_map = {
                    "stability": "保持长连接 · 减少离线时长",
                    "correctness": "检查任务失败原因 · 减少 FAILED",
                    "speed": "升级硬件或网络 · 提高 elapsed_ms 表现",
                    "resource": "等 benchmark 上线再说",
                }
                out.append({
                    "category": "reputation",
                    "level": "warning",
                    "message": f"信誉子分 {k} 偏低 ({v})",
                    "advice": advice_map.get(k, "联系客服"),
                })

    # 运行状态
    if worker.load >= 0.9:
        out.append({
            "category": "runtime",
            "level": "warning",
            "message": f"当前负载 {worker.load*100:.0f}% · 接近满载",
            "advice": "新任务可能派给其他节点",
        })

    return out
