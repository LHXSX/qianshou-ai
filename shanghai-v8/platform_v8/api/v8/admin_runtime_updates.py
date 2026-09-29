"""管理员发布客户端/运行时更新通知。

此接口只广播“有更新”信号，二进制签名、manifest 上传与安装确认仍由受控发布
流水线和客户端处理，避免把任意下载地址当作远程执行入口。
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from platform_v8.api.v8.admin_v2 import require_admin
from platform_v8.core import Account
from platform_v8.engine.broker import broadcast_to_all_workers

router = APIRouter(prefix="/api/v8/admin/runtime-updates", tags=["admin-runtime-updates"])


class RuntimeUpdatePushIn(BaseModel):
    kind: str = Field(default="runtime", pattern="^(runtime|client)$")
    tier: str = Field(default="ocr", pattern="^ocr$")
    version: str = Field(..., min_length=1, max_length=64)
    notes: str = Field(default="", max_length=500)
    min_client_version: str = Field(default="", max_length=64)


@router.post("/push", summary="通知在线客户端有 OCR runtime 或签名客户端更新")
async def push_update(
    body: RuntimeUpdatePushIn,
    _admin: Account = Depends(require_admin),
):
    frame_type = "runtime_update_available" if body.kind == "runtime" else "update_required"
    payload = {
        "tier": body.tier,
        "version": body.version,
        "notes": body.notes,
        "min_client_version": body.min_client_version,
        "ts": datetime.utcnow().isoformat(),
        "requires_user_confirmation": True,
    }
    sent = await broadcast_to_all_workers(frame_type, payload)
    return {"ok": True, "frame_type": frame_type, "sent": sent, "payload": payload}
