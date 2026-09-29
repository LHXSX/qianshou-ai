"""Current-account research directory view; this router never creates orders or workers."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from platform_v8.api.deps import get_current_account
from platform_v8.storage.db import get_session
from platform_v8.core import Account
from platform_v8.services.media_research import owner_directory, ResearchDirectoryError

router = APIRouter(prefix="/api/v8/media/research", tags=["research API metadata"])


@router.get("/nodes")
def nodes(s: Session = Depends(get_session), current: Account = Depends(get_current_account)):
    try:
        return owner_directory(s, current.id)
    except ResearchDirectoryError:
        raise HTTPException(503, "research API metadata unavailable") from None
