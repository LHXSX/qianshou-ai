"""
Model Catalog 路由 — /api/v8/models/*
自建 OSS 模型分发框架: CRUD + catalog + provision
"""
from __future__ import annotations
import json, logging
from typing import Optional, List, Literal
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import text

from platform_v8.api.deps import get_session, get_current_account
from platform_v8.core import Account
from platform_v8.storage.repo import WorkerRepo

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/models", tags=["models"])

# ── Pydantic Schemas ─────────────────────────────────

class ModelCreateIn(BaseModel):
    id: str = Field(..., description="模型唯一标识")
    name: str = Field(..., description="模型显示名")
    version: str = "1.0"
    description: str = ""
    size_mb: float = 0
    sha256: str = ""
    filename: str = ""
    download_path: str = ""
    mirrors: list = []
    runtime: str = "python"
    serve_cmd: str = ""
    health_endpoint: str = ""
    stop_cmd: str = ""
    requirements: dict = {}
    industry: list = []
    tags: list = []

class ModelUpdateIn(BaseModel):
    name: Optional[str] = None
    version: Optional[str] = None
    description: Optional[str] = None
    size_mb: Optional[float] = None
    sha256: Optional[str] = None
    filename: Optional[str] = None
    download_path: Optional[str] = None
    mirrors: Optional[list] = None
    runtime: Optional[str] = None
    serve_cmd: Optional[str] = None
    health_endpoint: Optional[str] = None
    stop_cmd: Optional[str] = None
    requirements: Optional[dict] = None
    industry: Optional[list] = None
    tags: Optional[list] = None
    status: Optional[str] = None

class ProvisionRequest(BaseModel):
    model_ids: List[str] = Field(..., description="要安装的模型 ID 列表")
    priority: str = Field("normal", description="normal | urgent")

# ── helpers ──────────────────────────────────────────

def _js(v):
    return json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v

_PUBLIC_MODEL_COLUMNS = (
    "id, name, version, description, size_mb, sha256, filename, "
    "download_path, mirrors, runtime, requirements, industry, tags, status"
)
_PUBLIC_MODEL_FIELDS = frozenset(
    ("id", "name", "version", "description", "size_mb", "sha256", "filename",
     "download_path", "mirrors", "runtime", "requirements", "industry", "tags", "status")
)
_CATALOG_MODEL_FIELDS = frozenset(_PUBLIC_MODEL_FIELDS - {"description", "status"})


def _public_model(r, *, catalog: bool = False):
    # Public routes must never serialize DB rows wholesale: they can contain
    # serve/stop commands, internal health endpoints, and future admin fields.
    allowed = _CATALOG_MODEL_FIELDS if catalog else _PUBLIC_MODEL_FIELDS
    d = {key: value for key, value in dict(r).items() if key in allowed}
    for k in ("mirrors", "requirements"):
        if k in d and isinstance(d[k], str):
            d[k] = json.loads(d[k])
    for k in ("industry", "tags"):
        if k in d and d[k] is None:
            d[k] = []
    return d

# ── ① 列表 (行业/标签过滤) ──────────────────────────

@router.get("", response_model=dict)
def list_models(
    industry: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    status: str = Query("active"),
    db: Session = Depends(get_session),
):
    # This is an anonymous catalog. Hidden/draft models have no public list
    # mode; administrators manage them through authenticated admin routes.
    if status != "active":
        raise HTTPException(status_code=403, detail="仅公开已上架模型")
    conds, params = ["status = 'active'"], {}
    if industry:
        conds.append(":industry = ANY(industry)"); params["industry"] = industry
    if tag:
        conds.append(":tag = ANY(tags)"); params["tag"] = tag
    where = "WHERE " + " AND ".join(conds) if conds else ""
    rows = db.execute(text(f"SELECT {_PUBLIC_MODEL_COLUMNS} FROM we_models {where} ORDER BY name"), params).mappings().all()
    return {"ok": True, "count": len(rows), "models": [_public_model(r) for r in rows]}

# ── ② 单个详情 ──────────────────────────────────────

@router.get("/{model_id}", response_model=dict)
def get_model(model_id: str, db: Session = Depends(get_session)):
    row = db.execute(
        text(f"SELECT {_PUBLIC_MODEL_COLUMNS} FROM we_models WHERE id = :id AND status = 'active'"),
        {"id": model_id},
    ).mappings().first()
    if not row:
        raise HTTPException(404, f"模型 {model_id} 不存在")
    return {"ok": True, "model": _public_model(row)}

# ── ③ 创建 (admin) ──────────────────────────────────

@router.post("", response_model=dict)
def create_model(body: ModelCreateIn, acct: Account = Depends(get_current_account), db: Session = Depends(get_session)):
    if acct.role != "admin":
        raise HTTPException(403, "仅管理员可注册模型")
    dp = body.download_path or f"/models/{body.id}/{body.filename or 'model.bin'}"
    db.execute(text("""
        INSERT INTO we_models (id,name,version,description,size_mb,sha256,filename,download_path,mirrors,runtime,serve_cmd,health_endpoint,stop_cmd,requirements,industry,tags)
        VALUES (:id,:name,:ver,:desc,:size,:sha,:fn,:dp,:mirrors::jsonb,:rt,:scmd,:hep,:stop,:req::jsonb,:ind,:tgs)
    """), {"id":body.id,"name":body.name,"ver":body.version,"desc":body.description,"size":body.size_mb,"sha":body.sha256,"fn":body.filename,"dp":dp,"mirrors":_js(body.mirrors),"rt":body.runtime,"scmd":body.serve_cmd,"hep":body.health_endpoint,"stop":body.stop_cmd,"req":_js(body.requirements),"ind":body.industry,"tgs":body.tags})
    db.commit()
    logger.info("model_created id=%s", body.id)
    return {"ok": True, "model_id": body.id}

# ── ④ 更新 (admin) ──────────────────────────────────

@router.patch("/{model_id}", response_model=dict)
def update_model(model_id: str, body: ModelUpdateIn, acct: Account = Depends(get_current_account), db: Session = Depends(get_session)):
    if acct.role != "admin":
        raise HTTPException(403, "仅管理员可更新模型")
    updates = body.dict(exclude_none=True)
    if not updates:
        return {"ok": True, "updated": []}
    sets, params = [], {"model_id": model_id}
    for k, v in updates.items():
        if k in ("mirrors","requirements"):
            sets.append(f"{k} = :{k}::jsonb"); params[k] = _js(v)
        else:
            sets.append(f"{k} = :{k}"); params[k] = v
    sets.append("updated_at = NOW()")
    res = db.execute(text(f"UPDATE we_models SET {', '.join(sets)} WHERE id = :model_id"), params)
    db.commit()
    if res.rowcount == 0:
        raise HTTPException(404, f"模型 {model_id} 不存在")
    return {"ok": True, "updated": list(updates.keys())}

# ── ⑤ 删除 (admin) ──────────────────────────────────

@router.delete("/{model_id}", response_model=dict)
def delete_model(model_id: str, acct: Account = Depends(get_current_account), db: Session = Depends(get_session)):
    if acct.role != "admin":
        raise HTTPException(403, "仅管理员可删除模型")
    res = db.execute(text("DELETE FROM we_models WHERE id = :id"), {"id": model_id})
    db.commit()
    if res.rowcount == 0:
        raise HTTPException(404, f"模型 {model_id} 不存在")
    return {"ok": True, "deleted": model_id}

# ── ⑥ catalog.json (客户端拉取) ─────────────────────

@router.get("/catalog/full", response_model=dict)
def get_catalog(industry: Optional[str] = Query(None), db: Session = Depends(get_session)):
    """客户端拉取完整模型目录 · 含下载地址和镜像"""
    conds = ["status = 'active'"]
    params = {}
    if industry:
        conds.append(":industry = ANY(industry)"); params["industry"] = industry
    rows = db.execute(text(f"SELECT {_PUBLIC_MODEL_COLUMNS} FROM we_models WHERE {' AND '.join(conds)} ORDER BY name"), params).mappings().all()
    models = [_public_model(r, catalog=True) for r in rows]
    return {
        "ok": True, "version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(models), "models": models,
    }

# ── ⑦ 节点模型安装状态 ──────────────────────────────

@router.get("/workers/{worker_id}/installed", response_model=dict)
def list_worker_models(worker_id: str, db: Session = Depends(get_session), acct: Account = Depends(get_current_account)):
    """查询节点已安装/安装中的模型"""
    _require_worker_access(db, worker_id, acct)
    rows = db.execute(text("""
        SELECT wm.*, m.name as model_name, m.size_mb
        FROM we_worker_models wm JOIN we_models m ON wm.model_id = m.id
        WHERE wm.worker_id = :wid ORDER BY wm.model_id
    """), {"wid": worker_id}).mappings().all()
    return {"ok": True, "worker_id": worker_id, "count": len(rows), "models": [dict(r) for r in rows]}

@router.post("/workers/{worker_id}/installed", response_model=dict)
def upsert_worker_model(worker_id: str, model_id: str = Query(...), status: Literal["pending", "downloading", "ready", "failed", "removed"] = Query("pending"), progress_pct: float = Query(0, ge=0, le=100), error: str = Query("", max_length=2048), db: Session = Depends(get_session), acct: Account = Depends(get_current_account)):
    """节点上报模型安装进度"""
    _require_worker_access(db, worker_id, acct)
    installed_clause = ", installed_at = NOW()" if status == "ready" else ""
    db.execute(text(f"""
        INSERT INTO we_worker_models (worker_id, model_id, status, progress_pct, error)
        VALUES (:wid, :mid, :st, :pct, :err)
        ON CONFLICT (worker_id, model_id) DO UPDATE SET
            status = :st, progress_pct = :pct, error = :err,
            last_health = NOW(){installed_clause}
    """), {"wid": worker_id, "mid": model_id, "st": status, "pct": progress_pct, "err": error})
    db.commit()
    return {"ok": True, "worker_id": worker_id, "model_id": model_id, "status": status}


def _require_worker_access(db: Session, worker_id: str, acct: Account) -> None:
    worker = WorkerRepo.by_id(db, worker_id)
    if worker is None:
        raise HTTPException(status_code=404, detail="节点不存在")
    if int(worker.owner_id) != int(acct.id) and not acct.is_admin:
        raise HTTPException(status_code=403, detail="无权访问该节点")

# ── ⑧ provision 指令 (admin → 指定节点安装模型) ─────

@router.post("/workers/{worker_id}/provision", response_model=dict)
def provision_models(worker_id: str, body: ProvisionRequest, acct: Account = Depends(get_current_account), db: Session = Depends(get_session)):
    """管理员指令: 让指定节点安装模型列表"""
    if acct.role != "admin":
        raise HTTPException(403, "仅管理员可下发模型安装指令")
    # 验证模型存在
    existing = db.execute(text("SELECT id FROM we_models WHERE id = ANY(:ids)"), {"ids": body.model_ids}).scalars().all()
    missing = set(body.model_ids) - set(existing)
    if missing:
        raise HTTPException(404, f"模型不存在: {missing}")
    # 写入 pending 记录
    for mid in body.model_ids:
        db.execute(text("""
            INSERT INTO we_worker_models (worker_id, model_id, status, progress_pct)
            VALUES (:wid, :mid, 'pending', 0)
            ON CONFLICT (worker_id, model_id) DO UPDATE SET status = 'pending', progress_pct = 0, error = ''
        """), {"wid": worker_id, "mid": mid})
    db.commit()
    # TODO: 通过 WS 推送 model.provision 给在线节点
    logger.info("provision worker=%s models=%s priority=%s", worker_id, body.model_ids, body.priority)
    return {"ok": True, "worker_id": worker_id, "provisioned": body.model_ids, "priority": body.priority}
