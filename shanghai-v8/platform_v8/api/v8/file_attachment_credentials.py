"""Metadata-only attachment credential endpoint, mounted below the existing files scope."""
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.services.file_attachment_credentials import AttachmentCredentialError, issue_read_credential

router = APIRouter()


class AttachmentReadCredentialRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    workload_id: str = Field(min_length=36, max_length=36)
    shard_id: str = Field(min_length=36, max_length=36)
    worker_id: str = Field(min_length=36, max_length=36)
    attempt: StrictInt = Field(ge=1, le=1_000_000)
    account_id: StrictInt = Field(ge=1)
    task_type: str = Field(pattern=r"^[a-z][a-z0-9_]{2,63}$")
    contract_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    slot: str = Field(pattern=r"^[a-z][a-z0-9_]{0,31}$")
    lease_token: str = Field(min_length=1, max_length=2048, repr=False)


@router.post("/attachment-read-credential", summary="当前租约的精确版本附件读取授权")
def attachment_read_credential(body: AttachmentReadCredentialRequest, response: Response,
                               current=Depends(get_current_account), session=Depends(get_session)):
    try:
        grant = issue_read_credential(session, node_account_id=int(current.id), request=body.model_dump())
        session.commit()
    except AttachmentCredentialError as exc:
        session.rollback()
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    response.headers["Cache-Control"] = "no-store"
    return grant
