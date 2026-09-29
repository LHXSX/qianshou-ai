"""Steam 式应用市场 HTTP 接口（引擎零改）。"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_admin_account, get_current_account, get_session
from platform_v8.api.market_queue_delegation import get_market_queue_reader
from platform_v8.core import Account
from platform_v8.engine import task_registry
from platform_v8.services.marketplace import apps as apps_svc
from platform_v8.services.marketplace import provisioning as provision_svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/marketplace", tags=["marketplace"])
admin_router = APIRouter(prefix="/api/v8/admin/marketplace", tags=["marketplace-admin"])


class AppCreateIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=200)
    slug: str = Field(..., min_length=2, max_length=100)
    category: str = "other"
    description: str = ""
    icon_url: Optional[str] = None
    pricing_model: str = "free"
    price: float = Field(0, ge=0, allow_inf_nan=False)
    free_trials: int = Field(0, ge=0)
    task_type: Optional[str] = None
    input_kind: str = "single_file"
    accept_formats: list[str] = Field(default_factory=list)
    tiers: list[str] = Field(default_factory=list)
    min_memory_mb: int = 1024
    gpu_required: bool = False
    sandbox_network: str = "none"
    launch_kind: str = "workload"
    deep_link_url: Optional[str] = None
    author_name: Optional[str] = None
    version: str = Field("1.0.0", min_length=1, max_length=20)
    script_bundle_url: Optional[str] = None
    model_bundle_url: Optional[str] = None
    changelog: str = ""
    sha256: Optional[str] = None
    size_bytes: int = Field(0, ge=0)
    signed: bool = False
    # 作者提交的插件材料；保存供审核查看，绝不视为平台验签结果。
    package_kind: Optional[str] = None
    runtime_api: Optional[str] = None
    capabilities: list[Any] = Field(default_factory=list)
    plugin_package_url: Optional[str] = None
    plugin_manifest_url: Optional[str] = None
    plugin_signature_url: Optional[str] = None
    manifest: dict[str, Any] = Field(default_factory=dict)
    config_schema: dict[str, Any] = Field(default_factory=dict)
    version_summary: str = Field("", max_length=240)
    # 富展示内容（商店详情页运营区）：tagline/features/scenarios/capability_tags，
    # 服务层白名单消毒后落 we_apps.display_meta（v8_041）
    display_meta: dict[str, Any] = Field(default_factory=dict)


class AppUpdateIn(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon_url: Optional[str] = None
    category: Optional[str] = None
    pricing_model: Optional[str] = None
    price: Optional[float] = Field(None, ge=0, allow_inf_nan=False)
    free_trials: Optional[int] = Field(None, ge=0)
    input_kind: Optional[str] = None
    accept_formats: Optional[list[str]] = None
    tiers: Optional[list[str]] = None
    min_memory_mb: Optional[int] = None
    gpu_required: Optional[bool] = None
    sandbox_network: Optional[str] = None
    deep_link_url: Optional[str] = None
    launch_kind: Optional[str] = None
    display_meta: Optional[dict[str, Any]] = None
    package_kind: Optional[str] = None
    runtime_api: Optional[str] = None
    capabilities: Optional[list[Any]] = None
    plugin_package_url: Optional[str] = None
    plugin_manifest_url: Optional[str] = None
    plugin_signature_url: Optional[str] = None
    manifest: Optional[dict[str, Any]] = None
    config_schema: Optional[dict[str, Any]] = None
    version_summary: Optional[str] = Field(None, max_length=240)
    script_bundle_url: Optional[str] = None
    model_bundle_url: Optional[str] = None
    sha256: Optional[str] = None
    size_bytes: Optional[int] = Field(None, ge=0)
    signed: Optional[bool] = None
    changelog: Optional[str] = None


class ReviewIn(BaseModel):
    rating: int = Field(..., ge=1, le=5)
    comment: str = ""


class ModerateIn(BaseModel):
    action: str = Field(..., description="approve|reject|suspend")
    note: str = ""


class ReadinessIn(BaseModel):
    installed_tiers: list[str] = Field(default_factory=list)
    installed_software: list[str] = Field(default_factory=list)
    ram_gb: Optional[float] = None
    has_gpu: Optional[bool] = None
    bundle_cached: bool = False
    law_shell_available: Optional[bool] = None
    deep_link_available: Optional[bool] = None


class SessionCreateIn(BaseModel):
    exec_mode: str = Field("local", description="local|edge|deep_link")
    input_ref: Optional[str] = None
    name: Optional[str] = None
    budget: Optional[float] = None
    meta: dict[str, Any] = Field(default_factory=dict)


class SessionBindIn(BaseModel):
    workload_id: str = Field(..., min_length=8)


class ProvisionIn(BaseModel):
    worker_id: str = Field(..., min_length=4, max_length=128, description="目标在线节点 ID")


@router.get("/apps", summary="应用列表/搜索")
def list_apps(
    q: str = Query(""),
    category: str = Query(""),
    sort: str = Query("popular"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    session: Session = Depends(get_session),
) -> dict:
    return apps_svc.list_apps(
        session,
        q=q,
        category=category or None,
        sort=sort,
        page=page,
        page_size=page_size,
        status="published",
    )


@router.get("/apps/mine", summary="我提交的应用（含审核状态）")
def list_my_apps(
    current: Account = Depends(get_current_account),
    session: Session = Depends(get_session),
) -> dict:
    return apps_svc.list_my_apps(session, author_id=current.id)


def _task_spec_out(task_type: Optional[str]) -> Optional[dict]:
    """引擎 TaskTypeSpec 只读透出（分布式加速声明 · 详情页/启动器消费）。

    只查显式注册项（不回退 DEFAULT_SPEC）——未注册的 task 如实返 None，
    客户端据此显示「单机串行」而非编造并行度。
    """
    if not task_type:
        return None
    spec = task_registry.TASK_REGISTRY.get(task_type)
    if spec is None:
        return None
    required_tier, fallback_tiers = task_registry.resolve_tier_routing(spec)
    return {
        "task_type": spec.task_type,
        "category": spec.category,
        "description": spec.description,
        "executor": spec.executor.value,
        "slicer": spec.slicer,
        "aggregator": spec.aggregator,
        "default_max_shards": spec.default_max_shards,
        "max_shards_limit": spec.max_shards_limit,
        "required_software": list(spec.required_software),
        "required_tier": required_tier,
        "fallback_tiers": list(fallback_tiers),
        "min_memory_mb": spec.min_memory_mb,
        "requires_gpu": spec.requires_gpu,
    }


@router.get("/apps/{slug}", summary="应用详情")
def get_app(slug: str, session: Session = Depends(get_session)) -> dict:
    try:
        app = apps_svc.get_by_slug(session, slug)
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    app["run_hint"] = apps_svc.build_run_hint(app)
    # 2.0 分布式加速贯通：详情附带引擎调度契约（并行切片上限/执行器/资源门槛）
    app["task_spec"] = _task_spec_out(app.get("task_type"))
    return app


@router.post("/apps", summary="开发者提交应用")
def create_app(
    body: AppCreateIn,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    try:
        return apps_svc.create_app(session, current.id, body.model_dump())
    except apps_svc.MarketplaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/apps/{slug}", summary="更新应用")
def update_app(
    slug: str,
    body: AppUpdateIn,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    try:
        return apps_svc.update_app(
            session,
            slug,
            current.id,
            body.model_dump(exclude_unset=True),
            is_admin=bool(current.is_admin),
        )
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    except apps_svc.AppAccessDenied as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except apps_svc.MarketplaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/apps/{slug}/submit", summary="重新提交已驳回应用")
def submit_app(
    slug: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    try:
        return apps_svc.submit_app(session, slug, current.id)
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    except apps_svc.AppAccessDenied as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except apps_svc.MarketplaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/apps/{slug}/install", summary="安装应用到我的库")
def install_app(
    slug: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    try:
        return apps_svc.install_app(session, slug, current.id)
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    except apps_svc.MarketplaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/apps/{slug}/install", summary="卸载应用")
def uninstall_app(
    slug: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    try:
        return apps_svc.uninstall_app(session, slug, current.id)
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")


async def _push_app_control(
    *,
    session: Session,
    user_id: int,
    worker_id: str,
    action: str,
    params: dict,
    reason: str,
) -> dict:
    import time
    import uuid

    from platform_v8.engine import broker
    from platform_v8.protocol import ws_schema as wsp

    control_id = uuid.uuid4().hex
    frame = wsp.build_control(
        control_id=control_id,
        action=action,
        params=params or {},
        reason=reason or "",
        expires_at_ms=int((time.time() + 900) * 1000),
    )
    provision_svc.create_attempt(
        session,
        control_id=control_id,
        user_id=user_id,
        worker_id=worker_id,
        slug=str(params.get("slug") or ""),
        version=str(params.get("version")) if params.get("version") else None,
        action=action,
    )
    # 先提交账户权限与 pending 回执，节点才能立即回报且不会遇到不存在的 control_id。
    session.commit()
    try:
        delivered = bool(await broker.push_to_worker(
            worker_id, frame, source="marketplace_provision",
        ))
    except Exception:
        logger.exception("marketplace control push failed · control=%s worker=%s", control_id, worker_id)
        delivered = False
    provision_svc.record_delivery(session, control_id=control_id, delivered=delivered)
    session.commit()
    receipt = provision_svc.get_attempt(session, control_id=control_id, user_id=user_id)
    return {
        "control_id": control_id,
        "delivered": delivered,
        "status": receipt["status"] if receipt else "pending",
        "device_installed": receipt["device_installed"] if receipt else False,
        "receipt_path": f"/api/v8/marketplace/provisions/{control_id}",
    }


@router.post("/apps/{slug}/provision", summary="远程安装应用到指定在线设备")
async def provision_app(
    slug: str,
    body: ProvisionIn,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    """先落账户应用库权限，再经 WS control(install_app) 下发到节点本机快照。"""
    try:
        prepared = apps_svc.prepare_remote_install(
            session, slug, current.id, body.worker_id.strip(),
        )
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    except apps_svc.WorkerNotOwned as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except apps_svc.WorkerOffline as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except apps_svc.MarketplaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    push = await _push_app_control(
        session=session,
        user_id=current.id,
        worker_id=prepared["worker_id"],
        action=prepared["action"],
        params=prepared["params"],
        reason=prepared["reason"],
    )
    return {
        "ok": True,
        "worker_id": prepared["worker_id"],
        "worker_name": prepared["worker_name"],
        "slug": prepared["params"].get("slug"),
        "version": prepared["params"].get("version"),
        "install": prepared.get("install"),
        **push,
    }


@router.post("/apps/{slug}/deprovision", summary="远程从指定在线设备卸载应用")
async def deprovision_app(
    slug: str,
    body: ProvisionIn,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    """仅从设备本机快照移除；账户应用库权限保留（另调 DELETE .../install 可卸库）。"""
    try:
        prepared = apps_svc.prepare_remote_uninstall(
            session, slug, current.id, body.worker_id.strip(),
        )
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    except apps_svc.WorkerNotOwned as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except apps_svc.WorkerOffline as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except apps_svc.MarketplaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    push = await _push_app_control(
        session=session,
        user_id=current.id,
        worker_id=prepared["worker_id"],
        action=prepared["action"],
        params=prepared["params"],
        reason=prepared["reason"],
    )
    return {
        "ok": True,
        "worker_id": prepared["worker_id"],
        "worker_name": prepared["worker_name"],
        "slug": prepared["params"].get("slug"),
        **push,
    }


@router.get("/provisions/{control_id}", summary="查询设备安装或卸载回执")
def get_provision_receipt(
    control_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    receipt = provision_svc.get_attempt(
        session, control_id=control_id, user_id=current.id,
    )
    if receipt is None:
        raise HTTPException(status_code=404, detail="回执不存在")
    return receipt


@router.get("/library", summary="我的应用库")
def my_library(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    return apps_svc.library(session, current.id)


@router.post("/apps/{slug}/run", summary="标记启动并返回 workload 组包提示")
def run_app(
    slug: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    """
    不新增引擎协议：返回客户端应如何提交现有 /workloads。
    律所官方 App 返回 deep_link。
    推荐新链路走 POST .../sessions。
    """
    try:
        # 未安装则自动安装
        apps_svc.install_app(session, slug, current.id)
        used = apps_svc.mark_used(session, slug, current.id)
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    except apps_svc.MarketplaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    app = used["app"]
    return {
        "ok": True,
        "app": app,
        "run_hint": apps_svc.build_run_hint(app),
        "workload_submit_path": "/api/v8/workloads",
    }


@router.get("/apps/{slug}/requirements", summary="应用就绪声明（只读门槛）")
def app_requirements(slug: str, session: Session = Depends(get_session)) -> dict:
    from platform_v8.services.marketplace import readiness as readiness_svc

    try:
        app = apps_svc.get_by_slug(session, slug)
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    return readiness_svc.build_requirements(app)


@router.post("/apps/{slug}/readiness", summary="上报本机 caps 并评估就绪")
def app_readiness(
    slug: str,
    body: ReadinessIn,
    session: Session = Depends(get_session),
    _current: Account = Depends(get_current_account),
) -> dict:
    from platform_v8.services.marketplace import readiness as readiness_svc

    try:
        app = apps_svc.get_by_slug(session, slug)
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    return readiness_svc.evaluate_readiness(app, body.model_dump())


@router.post("/apps/{slug}/sessions", summary="创建 RunSession")
def create_app_session(
    slug: str,
    body: SessionCreateIn,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    from platform_v8.services.marketplace import sessions as sessions_svc

    try:
        return sessions_svc.create_session(
            session,
            slug=slug,
            user_id=current.id,
            exec_mode=body.exec_mode,
            input_ref=body.input_ref,
            name=body.name,
            budget=body.budget,
            meta=body.meta,
        )
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    except (apps_svc.MarketplaceError, sessions_svc.SessionError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/sessions/{session_id}", summary="查询 RunSession")
def get_app_session(
    session_id: int,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    from platform_v8.services.marketplace import sessions as sessions_svc

    try:
        return sessions_svc.get_session(session, session_id, user_id=current.id)
    except sessions_svc.SessionError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/sessions/{session_id}/bind", summary="绑定 workload_id")
def bind_app_session(
    session_id: int,
    body: SessionBindIn,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    from platform_v8.services.marketplace import sessions as sessions_svc

    try:
        return sessions_svc.bind_workload(
            session, session_id, user_id=current.id, workload_id=body.workload_id,
        )
    except sessions_svc.SessionError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/sessions/{session_id}/settle", summary="主动结算 RunSession")
def settle_app_session(
    session_id: int,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    from platform_v8.services.marketplace import sessions as sessions_svc

    try:
        return sessions_svc.settle_session(session, session_id, user_id=current.id)
    except sessions_svc.SessionError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/sessions/{session_id}/cancel", summary="取消 RunSession")
def cancel_app_session(
    session_id: int,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    from platform_v8.services.marketplace import sessions as sessions_svc

    try:
        return sessions_svc.cancel_session(session, session_id, user_id=current.id)
    except sessions_svc.SessionError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/billing/me", summary="我的应用运行账单")
def billing_me(
    limit: int = Query(50, ge=1, le=200),
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    from platform_v8.services.marketplace import sessions as sessions_svc

    return sessions_svc.list_billing_me(session, current.id, limit=limit)


@router.get("/apps/{slug}/reviews", summary="评价列表")
def get_reviews(slug: str, session: Session = Depends(get_session)) -> dict:
    try:
        return apps_svc.list_reviews(session, slug)
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")


@router.post("/apps/{slug}/reviews", summary="发表/更新评价")
def post_review(
    slug: str,
    body: ReviewIn,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    try:
        return apps_svc.upsert_review(session, slug, current.id, body.rating, body.comment)
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    except apps_svc.MarketplaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@admin_router.get("/review", summary="待审核应用队列")
def admin_review_queue(
    request: Request,
    limit: int = Query(50, ge=1, le=200),
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_market_queue_reader),
) -> dict:
    return apps_svc.list_review_queue(session, limit=limit)


@admin_router.post("/review/{app_id}", summary="审核通过/拒绝/下架")
def admin_moderate(
    app_id: int,
    body: ModerateIn,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
) -> dict:
    try:
        return apps_svc.moderate_app(session, app_id, action=body.action,
                                     note=body.note, operator_id=_admin.id)
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    except (apps_svc.MarketplaceError, Exception) as exc:
        from platform_v8.services.marketplace import sandbox as sandbox_svc
        if isinstance(exc, sandbox_svc.SandboxPolicyError):
            raise HTTPException(status_code=400, detail=str(exc))
        if isinstance(exc, apps_svc.MarketplaceError):
            raise HTTPException(status_code=400, detail=str(exc))
        raise


# ── 应用内按用量计费（外链应用 · 千手创作等）────────────────────────
# 应用侧按公开价目算好金额来扣，order_key 幂等防双扣；失败整笔退回。


class AppChargeIn(BaseModel):
    amount: float = Field(..., gt=0, le=100000, description="扣款金额 EDG")
    order_key: str = Field(..., min_length=8, max_length=200, description="全局唯一幂等键")
    note: str = Field("", max_length=200, description="用途，进流水 note")


class AppRefundIn(BaseModel):
    order_key: str = Field(..., min_length=8, max_length=200)
    reason: str = Field("", max_length=200)


@router.post("/apps/{slug}/charge", summary="应用内按用量扣款（幂等）")
def charge_app_usage_endpoint(
    slug: str,
    body: AppChargeIn,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    from decimal import Decimal

    from platform_v8.services.marketplace import billing as billing_svc
    from platform_v8.storage.repo import LedgerRepo

    try:
        app = apps_svc.get_by_slug(session, slug)
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    try:
        out = billing_svc.charge_app_usage(
            session,
            user_id=current.id,
            app=app,
            amount=Decimal(str(body.amount)),
            order_key=body.order_key,
            note=body.note,
        )
    except billing_svc.BillingError as exc:
        raise HTTPException(status_code=402, detail=str(exc))
    balance = LedgerRepo.sum_balance(session, current.id)
    return {
        "ok": True,
        "charged": out["charged"],
        "idempotent_hit": not out["wrote"],
        "balance": float(balance),
        "order_key": body.order_key,
    }


@router.post("/apps/{slug}/refund", summary="应用内扣款整笔退回（幂等）")
def refund_app_usage_endpoint(
    slug: str,
    body: AppRefundIn,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict:
    from platform_v8.services.marketplace import billing as billing_svc
    from platform_v8.storage.repo import LedgerRepo

    try:
        app = apps_svc.get_by_slug(session, slug)
    except apps_svc.AppNotFound:
        raise HTTPException(status_code=404, detail="应用不存在")
    try:
        out = billing_svc.refund_app_usage(
            session,
            user_id=current.id,
            app=app,
            order_key=body.order_key,
            reason=body.reason,
        )
    except billing_svc.BillingError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    balance = LedgerRepo.sum_balance(session, current.id)
    return {
        "ok": True,
        "refunded": out["refunded"],
        "already_refunded": out["already_refunded"],
        "balance": float(balance),
        "order_key": body.order_key,
    }
