"""
Admin Runtime Tiers · /api/v8/admin/runtime/*

运行时环境热管理面板 API:
  GET    /tiers       列出所有 tier 配置 (含硬件门控字段)
  PUT    /tiers       新增/更新 tier (同一 tier_name + platform 组合 upsert)
  DELETE /tiers/{id}  软删除 (enabled=false)
  GET    /tiers/{id}  单个 tier 详情

设计:
  - 全 admin 鉴权 (Depends(get_admin_account))
  - 改完即时生效 · bundles.py 从 DB 动态读 · 无需重启
  - mirror_sources JSONB 支持多下载源 · 客户端按序尝试
"""
from __future__ import annotations
import json
import logging
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import text

from platform_v8.api.deps import get_session, get_admin_account
from platform_v8.core import Account

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/admin/runtime", tags=["admin-runtime"])

# ── Pydantic Schemas ─────────────────────────────────

class TierSourceIn(BaseModel):
    label: str = ""
    url: str = ""
    sha256: str = ""
    size_mb: float = 0

class TierCreateIn(BaseModel):
    tier_name: str = Field(..., description="唯一标识: lite / crawl / ffmpeg / ocr / speech / vision-ai / render")
    display_name: str = ""
    icon: str = ""
    description: str = ""
    task_types: List[str] = []
    skills: List[str] = []
    platform: str = Field(default="any", description="macos-arm64 / linux-x86_64 / windows-x86_64 / any")
    required: bool = False
    auto_install: bool = False
    enabled: bool = True
    display_order: int = 0
    source_type: str = Field(default="self_mirror", description="self_mirror / public_mirror")
    prebuilt_url: str = ""
    prebuilt_sha256: str = ""
    prebuilt_size_mb: float = 0
    prebuilt_version: str = ""
    mirror_sources: List[TierSourceIn] = []
    verify_cmd: str = ""
    verify_timeout_secs: int = 60
    packages: List[str] = []
    depends_on: List[str] = []
    requires_gpu: bool = False
    requires_cuda: bool = False
    requires_metal: bool = False
    min_vram_gb: float = 0
    min_ram_gb: float = 0

class TierUpdateIn(BaseModel):
    display_name: Optional[str] = None
    icon: Optional[str] = None
    description: Optional[str] = None
    task_types: Optional[List[str]] = None
    skills: Optional[List[str]] = None
    platform: Optional[str] = None
    required: Optional[bool] = None
    auto_install: Optional[bool] = None
    enabled: Optional[bool] = None
    display_order: Optional[int] = None
    source_type: Optional[str] = None
    prebuilt_url: Optional[str] = None
    prebuilt_sha256: Optional[str] = None
    prebuilt_size_mb: Optional[float] = None
    prebuilt_version: Optional[str] = None
    mirror_sources: Optional[List[TierSourceIn]] = None
    verify_cmd: Optional[str] = None
    verify_timeout_secs: Optional[int] = None
    packages: Optional[List[str]] = None
    depends_on: Optional[List[str]] = None
    requires_gpu: Optional[bool] = None
    requires_cuda: Optional[bool] = None
    requires_metal: Optional[bool] = None
    min_vram_gb: Optional[float] = None
    min_ram_gb: Optional[float] = None

# ── Helpers ──────────────────────────────────────────

def _js(v):
    return json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v

def _row_to_tier_dict(r) -> dict:
    d = dict(r)
    for k in ("mirror_sources",):
        if k in d and isinstance(d[k], str):
            try:
                d[k] = json.loads(d[k])
            except Exception:
                d[k] = []
    for k in ("task_types", "skills", "packages", "depends_on"):
        if k in d and d[k] is None:
            d[k] = []
        if k in d and isinstance(d[k], str):
            d[k] = json.loads(d[k]) if d[k].startswith("[") else [d[k]]
    for k in ("created_at", "updated_at"):
        if k in d and d[k]:
            d[k] = str(d[k])
    return d

# ── ① 列表 ──────────────────────────────────────────

@router.get("/tiers", response_model=dict, summary="列出所有运行时 tier 配置")
def list_tiers(
    tier_name: Optional[str] = Query(None),
    platform: Optional[str] = Query(None),
    enabled: Optional[str] = Query(None),
    source_type: Optional[str] = Query(None),
    db: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    conds = []
    params = {}
    if tier_name:
        conds.append("tier_name = :tier_name")
        params["tier_name"] = tier_name
    if platform:
        conds.append("platform = :platform")
        params["platform"] = platform
    if enabled == "true":
        conds.append("enabled = TRUE")
    elif enabled == "false":
        conds.append("enabled = FALSE")
    if source_type:
        conds.append("source_type = :source_type")
        params["source_type"] = source_type

    where = "WHERE " + " AND ".join(conds) if conds else ""
    rows = db.execute(
        text(f"SELECT * FROM v8_runtime_tiers {where} ORDER BY display_order, tier_name, platform"),
        params
    ).mappings().all()

    return {"ok": True, "count": len(rows), "tiers": [_row_to_tier_dict(r) for r in rows]}

# ── ② 单个详情 ──────────────────────────────────────

@router.get("/tiers/{tier_id}", response_model=dict, summary="查看单个 tier 配置")
def get_tier(
    tier_id: int,
    db: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    row = db.execute(
        text("SELECT * FROM v8_runtime_tiers WHERE id = :id"),
        {"id": tier_id}
    ).mappings().first()
    if not row:
        raise HTTPException(404, f"Tier #{tier_id} 不存在")
    return {"ok": True, "tier": _row_to_tier_dict(row)}

# ── ③ 新增/更新 (upsert) ────────────────────────────

@router.put("/tiers", response_model=dict, summary="新增或更新 tier (同一 tier_name+platform 组合 upsert)")
def upsert_tier(
    body: TierCreateIn,
    db: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    mirrors_json = _js([m.dict() for m in body.mirror_sources])

    db.execute(text("""
        INSERT INTO v8_runtime_tiers (
            tier_name, display_name, icon, description,
            task_types, skills, platform,
            required, auto_install, enabled, display_order,
            source_type,
            prebuilt_url, prebuilt_sha256, prebuilt_size_mb, prebuilt_version,
            mirror_sources,
            verify_cmd, verify_timeout_secs,
            packages, depends_on,
            requires_gpu, requires_cuda, requires_metal,
            min_vram_gb, min_ram_gb
        ) VALUES (
            :tn, :dn, :icon, :desc,
            :tt, :sk, :plat,
            :req, :ai, :en, :ord,
            :st,
            :purl, :psha, :psize, :pver,
            :mirrors::jsonb,
            :vcmd, :vto,
            :pkgs, :deps,
            :rgpu, :rcuda, :rmetal,
            :mvram, :mram
        )
        ON CONFLICT (tier_name, platform) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            icon = EXCLUDED.icon,
            description = EXCLUDED.description,
            task_types = EXCLUDED.task_types,
            skills = EXCLUDED.skills,
            required = EXCLUDED.required,
            auto_install = EXCLUDED.auto_install,
            enabled = EXCLUDED.enabled,
            display_order = EXCLUDED.display_order,
            source_type = EXCLUDED.source_type,
            prebuilt_url = EXCLUDED.prebuilt_url,
            prebuilt_sha256 = EXCLUDED.prebuilt_sha256,
            prebuilt_size_mb = EXCLUDED.prebuilt_size_mb,
            prebuilt_version = EXCLUDED.prebuilt_version,
            mirror_sources = EXCLUDED.mirror_sources,
            verify_cmd = EXCLUDED.verify_cmd,
            verify_timeout_secs = EXCLUDED.verify_timeout_secs,
            packages = EXCLUDED.packages,
            depends_on = EXCLUDED.depends_on,
            requires_gpu = EXCLUDED.requires_gpu,
            requires_cuda = EXCLUDED.requires_cuda,
            requires_metal = EXCLUDED.requires_metal,
            min_vram_gb = EXCLUDED.min_vram_gb,
            min_ram_gb = EXCLUDED.min_ram_gb,
            updated_at = NOW()
    """), {
        "tn": body.tier_name, "dn": body.display_name, "icon": body.icon, "desc": body.description,
        "tt": body.task_types, "sk": body.skills, "plat": body.platform,
        "req": body.required, "ai": body.auto_install, "en": body.enabled, "ord": body.display_order,
        "st": body.source_type,
        "purl": body.prebuilt_url, "psha": body.prebuilt_sha256, "psize": body.prebuilt_size_mb, "pver": body.prebuilt_version,
        "mirrors": mirrors_json,
        "vcmd": body.verify_cmd, "vto": body.verify_timeout_secs,
        "pkgs": body.packages, "deps": body.depends_on,
        "rgpu": body.requires_gpu, "rcuda": body.requires_cuda, "rmetal": body.requires_metal,
        "mvram": body.min_vram_gb, "mram": body.min_ram_gb,
    })
    db.commit()

    logger.info("runtime_tier_upsert · tier=%s platform=%s", body.tier_name, body.platform)
    return {"ok": True, "tier_name": body.tier_name, "platform": body.platform}

# ── ④ 更新 (PATCH 部分字段) ─────────────────────────

@router.patch("/tiers/{tier_id}", response_model=dict, summary="更新单个 tier 配置 (部分字段)")
def update_tier(
    tier_id: int,
    body: TierUpdateIn,
    db: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    updates = body.dict(exclude_none=True)
    if not updates:
        return {"ok": True, "updated": []}

    sets = []
    params = {"tier_id": tier_id}
    for k, v in updates.items():
        if k == "mirror_sources":
            sets.append(f"{k} = :{k}::jsonb")
            params[k] = _js([m.dict() if hasattr(m, 'dict') else m for m in v])
        elif k in ("task_types", "skills", "packages", "depends_on"):
            sets.append(f"{k} = :{k}")
            params[k] = v
        else:
            sets.append(f"{k} = :{k}")
            params[k] = v
    sets.append("updated_at = NOW()")

    res = db.execute(
        text(f"UPDATE v8_runtime_tiers SET {', '.join(sets)} WHERE id = :tier_id"),
        params
    )
    db.commit()
    if res.rowcount == 0:
        raise HTTPException(404, f"Tier #{tier_id} 不存在")

    logger.info("runtime_tier_updated · id=%s fields=%s", tier_id, list(updates.keys()))
    return {"ok": True, "updated": list(updates.keys())}

# ── ⑤ 软删除 ────────────────────────────────────────

@router.delete("/tiers/{tier_id}", response_model=dict, summary="软删除 tier (enabled=false)")
def delete_tier(
    tier_id: int,
    db: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    res = db.execute(
        text("UPDATE v8_runtime_tiers SET enabled = FALSE, updated_at = NOW() WHERE id = :id"),
        {"id": tier_id}
    )
    db.commit()
    if res.rowcount == 0:
        raise HTTPException(404, f"Tier #{tier_id} 不存在")

    logger.info("runtime_tier_disabled · id=%s", tier_id)
    return {"ok": True, "disabled": tier_id}

# ── ⑥ 批量启用/禁用 ─────────────────────────────────

class BatchToggleIn(BaseModel):
    tier_ids: List[int]
    enabled: bool

@router.post("/tiers/batch-toggle", response_model=dict, summary="批量启用/禁用 tier")
def batch_toggle_tiers(
    body: BatchToggleIn,
    db: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    if not body.tier_ids:
        raise HTTPException(400, "tier_ids 不能为空")
    res = db.execute(
        text("UPDATE v8_runtime_tiers SET enabled = :en, updated_at = NOW() WHERE id = ANY(:ids)"),
        {"en": body.enabled, "ids": body.tier_ids}
    )
    db.commit()
    logger.info("runtime_tier_batch_toggle · ids=%s enabled=%s", body.tier_ids, body.enabled)
    return {"ok": True, "affected": res.rowcount, "enabled": body.enabled}