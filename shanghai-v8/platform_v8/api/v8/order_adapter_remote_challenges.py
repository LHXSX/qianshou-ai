"""Authenticated buyer entry for a one-click remote adapter challenge."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.core import Account
from platform_v8.services.workers import order_adapter_products as products
from platform_v8.services.workers import order_adapter_remote_challenges as service

router = APIRouter(prefix="/api/v8/order-adapter-products",
                   tags=["order-adapter-activation"])


class ActivationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    worker_id: str = Field(..., min_length=36, max_length=36)


@router.post("/{product_id}/activation-challenge",
             summary="购买后自动为本人在线设备发起独立随机验收")
def activation_challenge(product_id: str, body: ActivationIn, request: Request,
                         response: Response,
                         current: Account = Depends(get_current_account),
                         session: Session = Depends(get_session)) -> dict[str, Any]:
    if getattr(request.state, "auth_via", None) != "jwt":
        raise HTTPException(status_code=403, detail="设备激活仅支持账号 JWT 登录")
    response.headers["Cache-Control"] = "private, no-store"
    try:
        reserved = service.reserve_remote_challenge(
            session, product_id=product_id, buyer_id=current.id,
            worker_id=body.worker_id)
        planned = service.request_attestor_plan(session, reserved)
        return {"schema": "qianshou.order-adapter-activation-challenge.v1",
                "product_id": product_id, "worker_id": body.worker_id, **planned}
    except products.ProductNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (products.ProductError, service.RemoteChallengeError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
