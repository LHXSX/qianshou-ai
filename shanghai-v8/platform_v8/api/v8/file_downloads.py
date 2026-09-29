"""Authenticated owner downloads: Shanghai authorizes metadata, Guangzhou serves bytes."""
from __future__ import annotations

import re
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.api.rate_limit import rate_limit
from platform_v8.core import Account
from platform_v8.services import file_download_grants
from platform_v8.storage.repo import ResultVerificationRepo, ShardRepo, WorkloadRepo

router = APIRouter(prefix="/api/v8/workloads", tags=["file-downloads"])


@router.get("/{workload_id}/file-download-grant", summary="获取已核验文件的短期下载授权",
            dependencies=[Depends(rate_limit("workload_file_download_grant", per_minute=120, key="uid"))])
def get_workload_file_download_grant(workload_id: str, asset_id: str,
                                    session: Session = Depends(get_session),
                                    current: Account = Depends(get_current_account)):
    try:
        canonical_id = str(UUID(workload_id)) == workload_id
    except (TypeError, ValueError):
        canonical_id = False
    if not canonical_id or not re.fullmatch(r"[a-f0-9]{64}", asset_id):
        raise HTTPException(status_code=400, detail="文件引用无效")
    # Operator/admin status is deliberately irrelevant to owner authorization.
    # These locks keep the current worker/attempt/result stable until signing.
    workload = WorkloadRepo.by_id_for_update(session, workload_id)
    if workload is None or workload.owner_id != current.id:
        raise HTTPException(status_code=404, detail="文件结果不存在")
    if getattr(workload.status, "value", None) != "DONE" or workload.result is None:
        raise HTTPException(status_code=409, detail="任务尚未完成")
    shards = ShardRepo.by_workload_for_update(session, str(workload.id))
    rows = {str(shard.id): ResultVerificationRepo.current(session, str(shard.id)) for shard in shards}
    try:
        asset = file_download_grants.attested_asset(workload, shards, asset_id, rows)
        if asset is None:
            raise HTTPException(status_code=404, detail="文件结果不存在或尚未核验")
        grant = file_download_grants.issue(account_id=current.id, task_id=str(workload.id), asset_id=asset_id,
                                          bucket=file_download_grants.bucket(), asset=asset)
    except file_download_grants.FileDownloadUnavailable as exc:
        raise HTTPException(status_code=503, detail="文件交付服务尚未就绪") from exc
    return JSONResponse({"ok": True, "grant": grant}, headers={"Cache-Control": "private, no-store",
                         "Pragma": "no-cache", "X-Content-Type-Options": "nosniff"})
