"""
任务级技能包 · /api/v8/skill-packs/* + /api/v8/admin/skill-packs (2026-06-06)

补全客户端 skill_pack.rs 已就绪的链路:
  GET  /api/v8/skill-packs/{pack_id}  节点拉定制 runner (公开·与 /scripts 一致·客户端无 auth header)
  POST /api/v8/admin/skill-packs       admin 创建/更新 pack (自动算 code_sha256·防篡改)

安全:
  - GET 公开:返回的是要分发给节点执行的脚本(同 /api/v8/scripts/{name}.py 公开语义)·靠 code_sha256 防中间人篡改
  - 创建仅 admin (get_admin_account)
  - 表不存在/DB 挂 → 404 (不暴露内部错误)
"""
from __future__ import annotations
import hashlib
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from platform_v8.api.deps import get_session, get_admin_account
from platform_v8.core import Account

logger = logging.getLogger(__name__)

# 节点拉取 (公开) · prefix 与客户端 skill_pack.rs 的 /api/v8/skill-packs/{id} 对齐
router = APIRouter(prefix="/api/v8/skill-packs", tags=["skill-packs"])

# admin 管理
admin_router = APIRouter(prefix="/api/v8/admin/skill-packs", tags=["admin-skill-packs"])


@router.get("/{pack_id}")
def get_skill_pack(pack_id: str, session=Depends(get_session)) -> dict:
    """节点拉定制 runner · 返回 skill_pack.rs 期望的 JSON 结构。"""
    try:
        row = session.execute(
            text(
                "SELECT pack_id, forked_from, name, description, runner_code, "
                "code_sha256, revision, expires_at "
                "FROM we_skill_packs WHERE pack_id = :pid AND enabled = TRUE"
            ),
            {"pid": pack_id},
        ).mappings().first()
    except Exception as exc:
        logger.debug("get_skill_pack DB err (表可能未建): %s", exc)
        raise HTTPException(status_code=404, detail="skill_pack not found")
    if not row:
        raise HTTPException(status_code=404, detail="skill_pack not found")
    d = dict(row)
    # expires_at 转 float (客户端 f64) · revision 转 int
    d["expires_at"] = float(d.get("expires_at") or 0)
    d["revision"] = int(d.get("revision") or 1)
    return d


class SkillPackCreate(BaseModel):
    pack_id: str = Field("", description="空则自动生成 uuid")
    forked_from: str = ""
    name: str = ""
    description: str = ""
    runner_code: str = Field(..., description="定制 runner.py 全文")
    expires_at: float = 0


@admin_router.post("")
def create_skill_pack(
    body: SkillPackCreate,
    session=Depends(get_session),
    admin: Account = Depends(get_admin_account),
) -> dict:
    """admin 创建/更新一个 skill-pack · 自动算 code_sha256。"""
    if not body.runner_code.strip():
        raise HTTPException(status_code=400, detail="runner_code 不能为空")
    pid = body.pack_id.strip() or uuid.uuid4().hex
    sha = hashlib.sha256(body.runner_code.encode("utf-8")).hexdigest()
    session.execute(
        text(
            "INSERT INTO we_skill_packs "
            "(pack_id, forked_from, name, description, runner_code, code_sha256, expires_at, created_by) "
            "VALUES (:pid, :ff, :nm, :de, :rc, :sha, :exp, :by) "
            "ON CONFLICT (pack_id) DO UPDATE SET "
            "  runner_code=EXCLUDED.runner_code, code_sha256=EXCLUDED.code_sha256, "
            "  revision=we_skill_packs.revision+1, name=EXCLUDED.name, "
            "  description=EXCLUDED.description, expires_at=EXCLUDED.expires_at, updated_at=NOW()"
        ),
        {
            "pid": pid, "ff": body.forked_from, "nm": body.name,
            "de": body.description, "rc": body.runner_code, "sha": sha,
            "exp": body.expires_at, "by": str(getattr(admin, "id", "")),
        },
    )
    session.commit()
    # S2-T8 · 2026-06-07 · 高危补 audit (skill-pack 直接影响节点执行任意代码)
    try:
        from platform_v8.storage.repo import AuditRepo as _AuditRepo
        _AuditRepo.write(
            session,
            action="admin.skill_pack.upsert",
            actor_account_id=admin.id,
            actor_kind="admin",
            target_kind="skill_pack",
            target_id=pid,
            detail={
                "name": body.name,
                "code_sha256": sha,
                "code_len": len(body.runner_code),
                "forked_from": body.forked_from,
                "expires_at": str(body.expires_at) if body.expires_at else None,
            },
        )
    except Exception:
        pass
    return {"ok": True, "pack_id": pid, "code_sha256": sha}
