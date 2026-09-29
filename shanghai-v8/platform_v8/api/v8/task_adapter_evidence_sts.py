"""Purpose-isolated, server-to-server COS evidence read credential endpoint."""
from __future__ import annotations

import hmac
import json
import os
import re
from uuid import UUID

from fastapi import APIRouter, Body, Header, HTTPException, Response

from platform_v8.services.workers import task_adapter_evidence_sts

router = APIRouter(prefix="/api/v8/internal/task-adapter-evidence",
                   tags=["task-adapter-evidence-internal"])


def _authorized(purpose: str | None, authorization: str | None) -> bool:
    if (purpose not in task_adapter_evidence_sts.PURPOSES
            or not isinstance(authorization, str)):
        return False
    try:
        tokens = json.loads(os.environ.get("V8_TASK_ADAPTER_EVIDENCE_READ_STS_TOKENS", ""))
    except (TypeError, ValueError):
        return False
    configured = set(tokens) if isinstance(tokens, dict) else set()
    if (not isinstance(tokens, dict)
            or not task_adapter_evidence_sts.BASE_PURPOSES.issubset(configured)
            or not configured.issubset(task_adapter_evidence_sts.PURPOSES)
            or any(not isinstance(token, str) or not 32 <= len(token) <= 2048
                   for token in tokens.values())
            or len(set(tokens.values())) != len(tokens)):
        return False
    if purpose == "file-result":
        # A new deployment must explicitly enroll the independent file reader.
        # The ordinary JSON purpose map never supplies this Bearer.
        token = os.environ.get("V8_TASK_ADAPTER_EVIDENCE_FILE_RESULT_READER_TOKEN", "")
        return (32 <= len(token) <= 2048 and token not in tokens.values()
                and hmac.compare_digest(authorization, "Bearer " + token))
    return purpose in tokens and hmac.compare_digest(
        authorization, "Bearer " + tokens[purpose])


@router.post("/read-credential", summary="广州独立服务更新短期 COS 只读身份")
def read_credential(
    response: Response,
    attestor_scope: dict | None = Body(default=None),
    authorization: str | None = Header(default=None),
    x_qianshou_evidence_purpose: str | None = Header(default=None),
) -> dict:
    if not _authorized(x_qianshou_evidence_purpose, authorization):
        raise HTTPException(status_code=403, detail="证据桶只读身份调用方未授权")
    try:
        if x_qianshou_evidence_purpose == "attestor":
            if not isinstance(attestor_scope, dict) or set(attestor_scope) != {
                    "owner_id", "publication_id"}:
                raise HTTPException(status_code=400, detail="独立验收只读范围无效")
            credential = task_adapter_evidence_sts.issue_read_credential(
                "attestor", owner_id=attestor_scope["owner_id"],
                publication_id=attestor_scope["publication_id"])
        elif x_qianshou_evidence_purpose == "official-image":
            if attestor_scope is not None and (
                    not isinstance(attestor_scope, dict) or set(attestor_scope) != {
                        "issuance_receipt", "object_version_id"}):
                raise HTTPException(status_code=400, detail="只读身份请求范围无效")
            # The Bearer selects one configured official worker. A receipt
            # signed after a live worker lease binds the *buyer's* one object;
            # the provider account cannot simply read its own account prefix.
            owner = os.environ.get("V8_OFFICIAL_IMAGE_WORKER_OWNER_ID", "")
            worker_id = os.environ.get("V8_OFFICIAL_IMAGE_WORKER_ID", "")
            try:
                canonical_worker = str(UUID(worker_id)) == worker_id
            except (TypeError, ValueError):
                canonical_worker = False
            if not re.fullmatch(r"[1-9][0-9]*", owner) or not canonical_worker:
                raise task_adapter_evidence_sts.EvidenceReadCredentialError(
                    "官方节点身份未配置")
            credential = task_adapter_evidence_sts.issue_read_credential(
                "official-image",
                issuance_receipt=(attestor_scope["issuance_receipt"]
                                  if attestor_scope is not None else None),
                object_version_id=(attestor_scope["object_version_id"]
                                   if attestor_scope is not None else None))
        else:
            if attestor_scope is not None:
                raise HTTPException(status_code=400, detail="只读身份请求范围无效")
            credential = task_adapter_evidence_sts.issue_read_credential(
                x_qianshou_evidence_purpose)
    except task_adapter_evidence_sts.EvidenceReadCredentialError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    response.headers["Cache-Control"] = "no-store, private"
    response.headers["Pragma"] = "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return credential
