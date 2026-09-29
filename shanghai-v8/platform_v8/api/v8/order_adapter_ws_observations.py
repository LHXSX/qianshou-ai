"""Read-only, service-authenticated witness view for the independent attestor."""
from __future__ import annotations

import hmac
import os
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session
from platform_v8.services.workers import order_adapter_ws_observations as observations

router = APIRouter(prefix="/api/v8/internal/order-adapter-challenge-observations",
                   tags=["order-adapter-observations"])


def _service_only(request: Request, authorization: str | None) -> None:
    token = os.getenv("V8_ORDER_ADAPTER_OBSERVATION_READ_TOKEN", "")
    if (request.url.scheme != "https" or len(token) < 32
            or not isinstance(authorization, str)
            or not authorization.startswith("Bearer ")
            or not hmac.compare_digest(authorization[7:], token)):
        raise HTTPException(status_code=403, detail="independent observation reader denied")


@router.get("/health")
def observation_health(request: Request, response: Response,
                       nonce: str = Query(..., min_length=36, max_length=36),
                       authorization: str | None = Header(default=None),
                       session: Session = Depends(get_session)) -> dict[str, Any]:
    _service_only(request, authorization)
    response.headers["Cache-Control"] = "no-store"
    if not observations._uuid(nonce) or not observations.probe_storage(session):
        raise HTTPException(status_code=503, detail="observation storage unavailable")
    return {"schema": "qianshou.order-adapter-ws-observation-health.v1",
            "nonce": nonce, "ready": True}


@router.get("/{nonce}")
def read_observation(nonce: str, request: Request, response: Response,
                     device_id: str = Query(..., min_length=36, max_length=36),
                     authorization: str | None = Header(default=None),
                     session: Session = Depends(get_session)) -> dict[str, Any]:
    _service_only(request, authorization)
    response.headers["Cache-Control"] = "no-store"
    result = observations.read_for_attestor(session, nonce=nonce, device_id=device_id)
    if result is None:
        raise HTTPException(status_code=404, detail="observation unavailable")
    return result
