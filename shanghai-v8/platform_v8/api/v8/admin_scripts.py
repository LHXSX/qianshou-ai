"""
脚本目录后台管理 · /api/v8/admin/scripts/*

设计要点 (P2 · 2026-05-24 · 完善计划第二阶段):
  - admin 后台 CRUD · 不影响节点执行链路
  - import_builtin: 把文件系统脚本扫描入库 (幂等 upsert · 已存在仅刷新可变字段)
  - update_meta: 改 name/description/category/tags/version
  - update_status: active / disabled / archived
  - 不允许在线编辑源代码 (太大风险 · 第三阶段做)

零影响:
  - 节点拉脚本仍走 /api/v8/scripts/{name} → 文件系统 (不读 catalog)
  - 任务提交不强制要求 catalog 记录
  - catalog 出错企业端 ScriptMarket 自动回退文件扫描
"""
from __future__ import annotations
import logging
import re
from typing import Optional
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session, get_admin_account
from platform_v8.api.v8.scripts import _resolve_scripts_dir, _ALLOWED_SCRIPT_EXTENSIONS
from platform_v8.api.v8.script_market import _build_item
from platform_v8.core import Account
from platform_v8.services.scripts import catalog as catalog_svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/admin/scripts", tags=["admin-scripts"])


# ── GET 列表 (admin · 含 disabled / archived) ────────────────────────
@router.get("", summary="管理员: 脚本目录列表 (含全状态)")
def admin_list_scripts(
    status: Optional[str] = Query(default=None, description="active / disabled / archived · 不填返全部"),
    category: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None, description="模糊匹配 task_type/name/description"),
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    if status and status not in catalog_svc.ALLOWED_STATUS:
        raise HTTPException(status_code=400, detail=f"status 必须是 {catalog_svc.ALLOWED_STATUS}")
    items = catalog_svc.list_catalog(
        session, status=status, category=category, q=q, limit=limit, offset=offset,
    )
    total = catalog_svc.count_all(session, status=status)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


# ── GET 详情 ────────────────────────────────────────────────────────
@router.get("/{script_id}", summary="管理员: 脚本目录详情")
def admin_get_script(
    script_id: str,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    row = _resolve_script(session, script_id)
    return row


# ── POST import-builtin (扫文件系统 → 批量 upsert catalog) ──────────
@router.post("/import-builtin", summary="管理员: 从文件系统批量导入内置脚本到 catalog")
def admin_import_builtin(
    session: Session = Depends(get_session),
    admin: Account = Depends(get_admin_account),
):
    """
    扫描 platform_v8/scripts/tasks · 把每个脚本 upsert 到 catalog
      - 已存在: 仅刷新 name/description/category/code_url/version/size (不动 status/tags)
      - 不存在: 创建为 status='active' source_kind='builtin'

    幂等 · 多次调用结果相同
    """
    script_dir = Path(_resolve_scripts_dir()).resolve()
    if not script_dir.exists():
        raise HTTPException(status_code=500, detail=f"脚本目录不存在: {script_dir}")

    imported = 0
    updated = 0
    failed = []
    for p in sorted(script_dir.iterdir()):
        if not p.is_file():
            continue
        if p.suffix.lower() not in _ALLOWED_SCRIPT_EXTENSIONS:
            continue
        try:
            # 复用 script_market._build_item 抽取 description + category
            built = _build_item(p)
            existed = catalog_svc.get_by_task_type(session, built["task_type"]) is not None
            catalog_svc.upsert(
                session,
                task_type=built["task_type"],
                name=built["name"],
                code_url=built["code_url"],
                description=built["description"],
                category=built["category"],
                source_kind="builtin",
                version=built.get("version") or "1.0.0",
                size_bytes=built.get("size") or 0,
                tags=[],
                created_by=admin.id,
            )
            if existed:
                updated += 1
            else:
                imported += 1
        except Exception as exc:
            logger.warning("import_builtin · %s 失败: %s", p.name, exc)
            failed.append({"name": p.name, "error": str(exc)})

    total_in_catalog = catalog_svc.count_all(session)
    logger.info("admin.scripts.import-builtin · admin=%s imported=%d updated=%d failed=%d catalog_total=%d",
                admin.username, imported, updated, len(failed), total_in_catalog)
    return {
        "imported": imported,
        "updated": updated,
        "failed": failed,
        "catalog_total": total_in_catalog,
    }


# ── PATCH 元信息 ────────────────────────────────────────────────────
class ScriptMetaUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    tags: Optional[list[str]] = None
    version: Optional[str] = None
    pricing_ref: Optional[str] = None


@router.patch("/{script_id}", summary="管理员: 改脚本展示信息 (不改 status/code_url)")
def admin_update_script(
    script_id: str,
    body: ScriptMetaUpdate,
    session: Session = Depends(get_session),
    admin: Account = Depends(get_admin_account),
):
    row = _resolve_script(session, script_id)
    updated = catalog_svc.update_meta(
        session, int(row["id"]),
        name=body.name,
        description=body.description,
        category=body.category,
        tags=body.tags,
        version=body.version,
        pricing_ref=body.pricing_ref,
    )
    logger.info("admin.scripts.update · admin=%s script_id=%s changed=%s",
                admin.username, row["id"], list(body.model_dump(exclude_none=True).keys()))
    return updated


# ── PATCH 状态 ──────────────────────────────────────────────────────
class ScriptStatusUpdate(BaseModel):
    status: str = Field(..., description="active / disabled / archived")


@router.patch("/{script_id}/status", summary="管理员: 改脚本状态")
@router.put("/{script_id}/status", summary="管理员: 改脚本状态")
def admin_update_status(
    script_id: str,
    body: ScriptStatusUpdate,
    session: Session = Depends(get_session),
    admin: Account = Depends(get_admin_account),
):
    # 技能广场可能仍在文件系统扫描模式；首次点“屏蔽”时自动纳入 catalog，
    # 以便 disabled 状态能阻止它被市场回退扫描重新显示。
    try:
        row = _resolve_script(session, script_id)
    except HTTPException:
        script_path = Path(_resolve_scripts_dir()).resolve() / f"{script_id}.py"
        if not script_path.is_file():
            raise
        built = _build_item(script_path)
        catalog_svc.upsert(
            session,
            task_type=built["task_type"],
            name=built["name"],
            code_url=built["code_url"],
            description=built["description"],
            category=built["category"],
            source_kind="builtin",
            version=built.get("version") or "1.0.0",
            size_bytes=built.get("size") or 0,
            tags=[],
            created_by=admin.id,
        )
        row = _resolve_script(session, script_id)
    if body.status not in catalog_svc.ALLOWED_STATUS:
        raise HTTPException(status_code=400, detail=f"status 必须是 {catalog_svc.ALLOWED_STATUS}")
    updated = catalog_svc.update_status(session, int(row["id"]), body.status)
    logger.info("admin.scripts.status · admin=%s script_id=%s status=%s",
                admin.username, row["id"], body.status)
    return updated


# ── DELETE (软删 → status='archived') ──────────────────────────────
@router.delete("/{script_id}", summary="管理员: 软删脚本 (status='archived' · 不物理删)")
def admin_archive_script(
    script_id: str,
    session: Session = Depends(get_session),
    admin: Account = Depends(get_admin_account),
):
    row = _resolve_script(session, script_id)
    archived = catalog_svc.archive(session, int(row["id"]))
    logger.info("admin.scripts.archive · admin=%s script_id=%s", admin.username, row["id"])
    return archived


# ── 工具 ─────────────────────────────────────────────────────────────
def _resolve_script(session: Session, script_id: str) -> dict:
    """script_id 既可以是数字 id · 也可以是 task_type · 找不到 → 404"""
    row = None
    if re.fullmatch(r"\d+", script_id):
        row = catalog_svc.get_by_id(session, int(script_id))
    if row is None and re.fullmatch(r"[A-Za-z0-9._-]+", script_id):
        row = catalog_svc.get_by_task_type(session, script_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"script {script_id} not found in catalog")
    return row
