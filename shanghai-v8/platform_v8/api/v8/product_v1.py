"""
产品级稳定 API · /api/v8/product/v1/*

设计原则（未来所有产品共用）:
  1. 产品只接本目录下的契约字段，不依赖引擎 task_type / slicer / broker。
  2. 引擎内部可热更、可换实现；只要本 API 的请求/响应字段不变。
  3. job_id 对外稳定；内部可等于 workload_id，但不保证永远同构——以本 API 为准。

当前产品:
  POST   /package-digest           提交混合材料编排
  GET    /package-digest/{job_id}  查状态
  GET    /package-digest/{job_id}/result  取稳定结果
  DELETE /package-digest/{job_id}  硬取消（回收分片）
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.api.rate_limit import rate_limit
from platform_v8.core import Account
from platform_v8.engine.privacy_titles import opaque_create_name
from platform_v8.services.archive_normalization_jobs import (
    start_submitted_workload,
)
from platform_v8.services.product import package_digest_api as pkg
from platform_v8.services.storage_refs import (
    StorageReferenceError,
    canonicalize_owned_reference,
)
from platform_v8.services.workloads import query as query_svc
from platform_v8.services.workloads import submit as submit_svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/product/v1", tags=["product-api-v1"])


class PackageDigestFileIn(BaseModel):
    """已上传到 OSS 的材料（先走 /api/v8/files/upload-url）。"""

    object_key: str = Field(..., min_length=1, max_length=1024, description="OSS object_key")
    name: str | None = Field(default=None, max_length=512)
    size: int | None = Field(default=None, ge=0)
    content_type: str | None = Field(default=None, max_length=128)
    pdf_page_count: int | None = Field(default=None, ge=1, le=100000)
    pdf_page_approx: bool | None = None


class PackageDigestCreateIn(BaseModel):
    files: list[PackageDigestFileIn] = Field(..., min_length=1, max_length=200)
    name: str | None = Field(default=None, max_length=255)
    lang: str = Field(default="ch", max_length=16)
    # recipe 默认 law_materials；产品一般不用改。保留是为扩展其他 recipe 而不破契约。
    recipe: str = Field(default=pkg.DEFAULT_RECIPE, max_length=64)
    # multi_file=多文件直传（推荐）；archive=单个 zip
    input_kind: str = Field(default="multi_file", max_length=32)
    total_files: int | None = Field(default=None, ge=1, le=200, description="archive 时原始材料份数")
    slice_mode: str | None = Field(
        default=None,
        max_length=32,
        description="node_pack=按节点粗切(默认) · page_first=旧按页细切 · client_presliced=客户端已本机切好",
    )
    client_presliced: bool | None = Field(
        default=None,
        description="True=App 已本机切好并上传切片，服务端 1:1 分发不再拆页",
    )
    client_online_workers: int | None = Field(
        default=None, ge=0, le=500,
        description="App 提交前探测到的在线节点数（切片回退用）",
    )
    shards_per_worker: int | None = Field(
        default=None, ge=1, le=5,
        description="每节点目标片数 K（默认 2 · 与 admission C=5 兼容）",
    )
    budget: Decimal = Field(default=Decimal("0"), ge=0)
    timeout_s: int = Field(default=3600, ge=60, le=3600)
    max_shards: int = Field(default=100, ge=1, le=100)


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def _async_wrap(coro_func, *args):
    try:
        await coro_func(*args)
    except Exception:
        logger.exception("product.v1 background start failed")


def _get_owned_job(session: Session, current: Account, job_id: str):
    # 非法 UUID 不得打进 PG（否则 DataError→500）；统一 404
    try:
        from uuid import UUID

        UUID(str(job_id))
    except (TypeError, ValueError):
        raise HTTPException(status_code=404, detail="job 不存在") from None

    try:
        w = query_svc.get_workload(session, job_id, caller=current)
    except query_svc.WorkloadNotFound:
        raise HTTPException(status_code=404, detail="job 不存在") from None
    except query_svc.WorkloadAccessDenied:
        raise HTTPException(status_code=403, detail="无权访问该 job") from None
    # 仅允许本产品创建的任务（防拿任意 workload_id 冒充）
    params = {}
    try:
        spec = getattr(w, "spec", None)
        params = dict(getattr(spec, "params", None) or {})
        if isinstance(spec, dict):
            params = dict(spec.get("params") or {})
    except Exception:
        params = {}
    if params.get("_product_api") != pkg.PRODUCT:
        # 兼容：引擎 task_type 仍是 package_digest 时也允许（迁移期）
        task_type = ""
        try:
            task_type = str(getattr(getattr(w, "spec", None), "task_type", "") or "")
            if isinstance(getattr(w, "spec", None), dict):
                task_type = str(w.spec.get("task_type") or "")
        except Exception:
            task_type = ""
        if task_type != pkg.ENGINE_TASK_TYPE:
            raise HTTPException(status_code=404, detail="job 不存在")
    return w


@router.get(
    "/package-digest/_ready",
    summary="产品 API 就绪探测（不打库）",
    dependencies=[Depends(rate_limit("product_package_digest_ready", per_minute=120, key="uid"))],
)
def package_digest_ready(
    current: Account = Depends(get_current_account),
):
    """能力探测专用：鉴权通过即表示产品口已挂载。"""
    _ = current
    return {
        "ok": True,
        "api_version": pkg.API_VERSION,
        "product": pkg.PRODUCT,
        "ready": True,
    }


class PackageDigestCapacityFileIn(BaseModel):
    """容量探测用的轻量文件元数据（无需 object_key）。"""

    name: str | None = Field(default=None, max_length=512)
    size: int | None = Field(default=None, ge=0)
    pdf_page_count: int | None = Field(default=None, ge=1, le=100000)
    content_type: str | None = Field(default=None, max_length=128)


class PackageDigestCapacityIn(BaseModel):
    materials: int | None = Field(default=None, ge=0, le=500)
    files: list[PackageDigestCapacityFileIn] | None = Field(default=None, max_length=200)


@router.get(
    "/package-digest/_capacity",
    summary="在线算力容量（仅材料份数 · 粗估）",
    dependencies=[Depends(rate_limit("product_package_digest_capacity", per_minute=120, key="uid"))],
)
def package_digest_capacity(
    materials: int = 0,
    current: Account = Depends(get_current_account),
):
    """兼容旧 App：只传份数。精确预估请用 POST 带 files[].size/页数。"""
    _ = current
    try:
        mats = max(0, min(500, int(materials or 0)))
    except (TypeError, ValueError):
        mats = 0
    return pkg.cluster_capacity(material_count=mats)


@router.post(
    "/package-digest/_capacity",
    summary="在线算力容量（带文件大小/页数 · 自适应预估）",
    dependencies=[Depends(rate_limit("product_package_digest_capacity", per_minute=120, key="uid"))],
)
def package_digest_capacity_post(
    body: PackageDigestCapacityIn,
    current: Account = Depends(get_current_account),
):
    """App 上传前：带 name/size/pdf_page_count，按整包页当量估路数。"""
    _ = current
    files_raw = [f.model_dump() for f in (body.files or [])]
    mats = body.materials
    if mats is None:
        mats = len(files_raw)
    try:
        mats_i = max(0, min(500, int(mats or 0)))
    except (TypeError, ValueError):
        mats_i = len(files_raw)
    return pkg.cluster_capacity(material_count=mats_i, files=files_raw or None)


@router.post(
    "/package-digest",
    status_code=202,
    summary="提交混合材料编排（产品稳定契约）",
    dependencies=[Depends(rate_limit("product_package_digest_create", per_minute=30, key="uid"))],
)
def create_package_digest(
    body: PackageDigestCreateIn,
    request: Request,
    bg: BackgroundTasks,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    files_raw = [f.model_dump() for f in body.files]
    try:
        refs = [
            canonicalize_owned_reference(current.id, f["object_key"])
            for f in files_raw
        ]
    except StorageReferenceError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    for i, f in enumerate(files_raw):
        f["object_key"] = refs[i]
    extra: dict[str, Any] = {}
    if body.total_files:
        extra["total_files"] = body.total_files
    if body.slice_mode:
        extra["slice_mode"] = str(body.slice_mode).strip().lower()
    if body.client_presliced:
        extra["client_presliced"] = True
        extra["slice_mode"] = "client_presliced"
    if body.shards_per_worker:
        extra["shards_per_worker"] = int(body.shards_per_worker)
    # 提交瞬间：在线数 + 按文件页/体积估推荐片数（切片权威仍在 package_recipe）
    try:
        cap = pkg.cluster_capacity(
            material_count=len(files_raw),
            files=files_raw,
        )
        extra["submit_online_workers"] = int(cap.get("online_workers") or 0)
        extra["recommended_shards"] = int(cap.get("recommended_shards") or 0)
        if cap.get("shards_per_worker_max") is not None:
            extra["shards_per_worker_max"] = int(cap["shards_per_worker_max"])
    except Exception as exc:
        logger.debug("product.create capacity snapshot skip: %s", exc)
    if body.client_online_workers is not None:
        extra["client_online_workers"] = int(body.client_online_workers)
    try:
        spec_dict = pkg.build_submit_spec(
            input_refs=refs,
            files=files_raw,
            recipe=body.recipe,
            lang=body.lang,
            timeout_s=body.timeout_s,
            max_shards=body.max_shards,
            input_kind=body.input_kind,
            extra_params=extra or None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # 校验 recipe 已上线（与 submit 层一致，提前给产品清晰错误）
    try:
        from platform_v8.engine import package_recipes as _pkg

        recipe = _pkg.get_recipe(str(spec_dict["params"].get("recipe") or pkg.DEFAULT_RECIPE))
        if recipe is None:
            raise HTTPException(status_code=400, detail=f"未知 recipe: {body.recipe}")
        if not getattr(recipe, "ready", True):
            raise HTTPException(status_code=400, detail=f"recipe 未上线: {body.recipe}")
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("product.package-digest recipe check skipped: %s", exc)

    # 节点/流水可见名用专业代号；真实文件名只在 file_manifest
    name = opaque_create_name(
        "pending",
        task_type=pkg.ENGINE_TASK_TYPE,
        recipe=body.recipe or pkg.DEFAULT_RECIPE,
    )
    try:
        workload = submit_svc.submit_workload(
            session,
            submit_svc.SubmitInput(
                owner_id=current.id,
                name=name,
                spec_dict=spec_dict,
                budget=body.budget,
                trace_id=getattr(request.state, "trace_id", None),
                ip=_client_ip(request),
                is_admin=current.is_admin,
            ),
        )
    except submit_svc.SubmitWorkloadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 创建后写入带真实短码的专业名（pending → QS-xxxxxx）
    # Workload 是 dataclass，不能 session.add；走 Repo 更新
    from platform_v8.storage.repo import WorkloadRepo
    final_name = opaque_create_name(
        str(workload.id),
        task_type=pkg.ENGINE_TASK_TYPE,
        recipe=body.recipe or pkg.DEFAULT_RECIPE,
    )
    WorkloadRepo.update_name(session, str(workload.id), final_name)
    session.commit()
    workload.name = final_name

    bg.add_task(_async_wrap, start_submitted_workload, workload.id)
    payload = pkg.status_payload(workload)
    payload["status"] = "queued"
    return payload


@router.get(
    "/package-digest/{job_id}",
    summary="查询混合编排状态",
    dependencies=[Depends(rate_limit("product_package_digest_get", per_minute=180, key="uid"))],
)
def get_package_digest(
    job_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    w = _get_owned_job(session, current, job_id)
    shards = None
    try:
        from platform_v8.storage.repo import ShardRepo

        shards = ShardRepo.by_workload(session, job_id)
    except Exception:
        shards = None
    return pkg.status_payload(w, shards=shards)


@router.get(
    "/package-digest/{job_id}/result",
    summary="获取混合编排稳定结果",
    dependencies=[Depends(rate_limit("product_package_digest_result", per_minute=120, key="uid"))],
)
def get_package_digest_result(
    job_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    w = _get_owned_job(session, current, job_id)
    if not query_svc.can_read_result(w, current):
        raise HTTPException(status_code=403, detail="结果仅派发账户可查看")
    try:
        return pkg.result_payload(w)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.delete(
    "/package-digest/{job_id}",
    summary="取消混合编排（硬取消 · 回收分片）",
    dependencies=[Depends(rate_limit("product_package_digest_cancel", per_minute=60, key="uid"))],
)
def cancel_package_digest(
    job_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    """产品契约取消：内部走 workloads.cancel（退款 + shard_cancel）+ stop-nodes 补推。"""
    from platform_v8.services.workloads import cancel as cancel_svc

    # 先校验归属 / 产品标记
    _get_owned_job(session, current, job_id)
    try:
        w = cancel_svc.cancel_workload(session, job_id, caller=current, reason="product_api_cancel")
    except cancel_svc.CancelError as exc:
        msg = str(exc)
        if "不存在" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        if "无法取消" in msg or "已" in msg:
            # 已取消：仍补发 stop-nodes，清节点僵尸跑
            try:
                cancel_svc.stop_workload_nodes(
                    session, job_id, caller=current, reason="product_api_cancel_retry_stop",
                )
            except Exception:
                pass
            raise HTTPException(status_code=409, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc

    # 双保险：cancel 已推一次；再 stop-nodes（含 CANCELLED 分片上的 worker_id）
    try:
        cancel_svc.stop_workload_nodes(
            session, job_id, caller=current, reason="product_api_cancel_stop",
        )
    except Exception as exc:
        logger.warning("product.cancel · stop-nodes 补推失败 job=%s: %s", job_id[:8], exc)

    payload = pkg.status_payload(w)
    payload["status"] = "canceled"
    return payload


@router.post(
    "/package-digest/{job_id}/stop-nodes",
    summary="强制停节点（已取消任务也可补发 shard_cancel）",
    dependencies=[Depends(rate_limit("product_package_digest_stop_nodes", per_minute=60, key="uid"))],
)
def stop_package_digest_nodes(
    job_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    """产品侧清场：内部走 stop_workload_nodes。"""
    from platform_v8.services.workloads import cancel as cancel_svc

    _get_owned_job(session, current, job_id)
    try:
        return cancel_svc.stop_workload_nodes(
            session, job_id, caller=current, reason="product_api_stop_nodes",
        )
    except cancel_svc.CancelError as exc:
        msg = str(exc)
        if "不存在" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        if "无权" in msg:
            raise HTTPException(status_code=403, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc
