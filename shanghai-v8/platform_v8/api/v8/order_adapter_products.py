"""Independent order-adapter marketplace. No we_apps / we_installs shortcuts."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_admin_account, get_current_account, get_session
from platform_v8.api.market_queue_delegation import get_market_queue_reader
from platform_v8.core import Account
from platform_v8.services.workers import order_adapter_products as service

router = APIRouter(prefix="/api/v8/order-adapter-products", tags=["order-adapter-products"])
admin_router = APIRouter(prefix="/api/v8/admin/order-adapter-products",
                         tags=["order-adapter-products-admin"])


class ProductIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    publication_id: str = Field(..., min_length=36, max_length=36)
    sale_price_yuan: str = Field(..., min_length=1, max_length=16)
    currency: Literal["CNY"] = "CNY"


class ReviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str = Field(..., min_length=1, max_length=1000)


class InstallReceiptIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key_id: str = Field(..., min_length=1, max_length=64)
    payload: dict[str, Any]
    signature: str = Field(..., min_length=1, max_length=128)


def _jwt(request: Request) -> None:
    if getattr(request.state, "auth_via", None) != "jwt":
        raise HTTPException(status_code=403, detail="商品购买与审核仅支持账号 JWT 登录")


def _raise(exc: service.ProductError) -> None:
    if isinstance(exc, service.ProductNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, service.ProductConflict):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("", summary="公开已上架接单技能商品")
def list_products(session: Session = Depends(get_session)) -> dict[str, Any]:
    return service.list_public(session)


@router.get("/my-entitlements", summary="本人购买权益与当前设备验收状态")
def my_entitlements(request: Request, response: Response,
                    worker_id: str | None = None,
                    current: Account = Depends(get_current_account),
                    session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return service.buyer_entitlements(
            session, buyer_id=current.id, worker_id=worker_id)
    except service.ProductError as exc:
        _raise(exc)


@router.get("/capabilities", summary="按任务类型聚合的公开市场能力目录")
def list_market_capabilities(session: Session = Depends(get_session)) -> dict[str, Any]:
    return service.list_capabilities(session)


@router.post("", summary="作者申请独立商品上架")
def submit_product(body: ProductIn, request: Request,
                   current: Account = Depends(get_current_account),
                   session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    try:
        return service.submit(session, owner_id=current.id,
                              **body.model_dump())
    except service.ProductError as exc:
        _raise(exc)


@router.get("/mine", summary="作者的商品上架申请")
def my_products(request: Request, current: Account = Depends(get_current_account),
                session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    return service.mine(session, owner_id=current.id)


@router.get("/{product_id}", summary="公开商品详情")
def product_detail(product_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    try:
        return service.get_public(session, product_id)
    except service.ProductError as exc:
        _raise(exc)


@router.post("/{product_id}/purchase", summary="人民币余额购买并取得账户权益")
def purchase_product(product_id: str, request: Request,
                     idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
                     current: Account = Depends(get_current_account),
                     session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    try:
        return service.purchase(session, product_id=product_id,
                                buyer_id=current.id, request_key=idempotency_key)
    except service.ProductError as exc:
        _raise(exc)


@router.post("/{product_id}/author-entitlement", summary="作者免购买取得本商品安装权益")
def claim_author_entitlement(product_id: str, request: Request,
                             response: Response,
                             current: Account = Depends(get_current_account),
                             session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return service.author_entitlement(session, product_id=product_id,
                                          owner_id=current.id)
    except service.ProductError as exc:
        _raise(exc)


@router.get("/{product_id}/install-manifest", summary="有权益买家的版本化安装清单")
def buyer_install_manifest(product_id: str, request: Request,
                           response: Response,
                           current: Account = Depends(get_current_account),
                           session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return service.install_manifest(session, product_id=product_id,
                                        buyer_id=current.id)
    except service.ProductError as exc:
        _raise(exc)


@router.post("/{product_id}/cancel-purchase", summary="安装前取消并退还人民币托管款")
def cancel_purchase(product_id: str, request: Request,
                    current: Account = Depends(get_current_account),
                    session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    try:
        return service.cancel_pending_purchase(
            session, product_id=product_id, buyer_id=current.id)
    except service.ProductError as exc:
        _raise(exc)


@router.post("/{product_id}/install-receipt", summary="独立签名设备安装回执并结算")
def installed_receipt(product_id: str, body: InstallReceiptIn, request: Request,
                      current: Account = Depends(get_current_account),
                      session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    try:
        return service.report_device_install(
            session, product_id=product_id, buyer_id=current.id,
            receipt=body.model_dump())
    except service.ProductError as exc:
        _raise(exc)


@admin_router.get("/pending", summary="待审接单技能商品")
def pending_products(request: Request, _admin: Account = Depends(get_market_queue_reader),
                     session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    # Route availability does not grant this queue reader review authority.
    mounted_paths = request.app.openapi().get("paths", {})
    review_available = all(
        "post" in mounted_paths.get(f"{admin_router.prefix}/{{product_id}}/{action}", {})
        for action in ("approve", "reject"))
    return {**service.pending(session),
            "reviewActionsAvailable": review_available}


@admin_router.post("/{product_id}/approve", summary="核实不可变归档后上架")
def approve_product(product_id: str, body: ReviewIn, request: Request,
                    admin: Account = Depends(get_admin_account),
                    session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    try:
        return service.approve(session, product_id=product_id,
                               reviewer_id=admin.id, note=body.note)
    except service.ProductError as exc:
        _raise(exc)


@admin_router.post("/{product_id}/reject", summary="驳回接单技能商品")
def reject_product(product_id: str, body: ReviewIn, request: Request,
                   admin: Account = Depends(get_admin_account),
                   session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    try:
        return service.reject(session, product_id=product_id,
                              reviewer_id=admin.id, note=body.note)
    except service.ProductError as exc:
        _raise(exc)


@admin_router.post("/{product_id}/suspend", summary="暂停商品及新设备授权")
def suspend_product(product_id: str, body: ReviewIn, request: Request,
                    admin: Account = Depends(get_admin_account),
                    session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    try:
        return service.suspend(session, product_id=product_id,
                               reviewer_id=admin.id, note=body.note)
    except service.ProductError as exc:
        _raise(exc)


@admin_router.post("/{product_id}/entitlements/{entitlement_id}/refund",
                   summary="溯源撤销后按原分账冲正退款")
def refund_revoked_product(product_id: str, entitlement_id: str, body: ReviewIn,
                           request: Request, admin: Account = Depends(get_admin_account),
                           session: Session = Depends(get_session)) -> dict[str, Any]:
    _jwt(request)
    try:
        return service.refund_revoked_purchase(
            session, product_id=product_id, entitlement_id=entitlement_id,
            reviewer_id=admin.id, note=body.note)
    except service.ProductError as exc:
        _raise(exc)


@admin_router.post("/sweep-expired", summary="幂等回收超时未安装的人民币托管款")
def sweep_expired_purchases(request: Request,
                            _admin: Account = Depends(get_admin_account),
                            session: Session = Depends(get_session)) -> dict[str, int]:
    _jwt(request)
    return service.expire_pending_purchases(session)
