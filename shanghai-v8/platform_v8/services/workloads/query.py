"""
查询任务业务
"""
from __future__ import annotations
from sqlalchemy.orm import Session

from platform_v8.core import Workload, Account
from platform_v8.storage.repo import WorkloadRepo


class WorkloadNotFound(Exception):
    pass


class WorkloadAccessDenied(Exception):
    pass


class WorkloadResultDenied(Exception):
    """接单节点可看任务进度，但不能读派发账户的结果。"""


def can_read_result(w: Workload, caller: Account) -> bool:
    """结果 / 下载仅派发账户（owner）或 admin。跨户接单不可读产出。"""
    if caller.is_admin:
        return True
    return int(getattr(w, "owner_id", 0) or 0) == int(caller.id)


def require_result_access(w: Workload, caller: Account) -> None:
    if not can_read_result(w, caller):
        raise WorkloadResultDenied(getattr(w, "id", ""))


def get_workload(s: Session, workload_id: str, *,
                 caller: Account) -> Workload:
    """单个任务详情 · owner / admin / 被派到该任务的节点所有者可读。

    进度与分片状态对承接节点可见；结果正文 / 下载另走 can_read_result。
    """
    w = WorkloadRepo.by_id(s, workload_id)
    if w is None:
        raise WorkloadNotFound(workload_id)
    if w.owner_id != caller.id and not caller.is_admin:
        if not WorkloadRepo.account_has_assignment(s, w.id, caller.id):
            raise WorkloadAccessDenied(workload_id)
    return w


def list_workloads(s: Session, *, caller: Account,
                   status: str | None = None,
                   owner_id: int | None = None,
                   limit: int = 50, offset: int = 0) -> list[Workload]:
    """列任务

    - 普通用户: 自己发布的排单 ∪ 自己节点接到的单（跨用户）
    - admin: 默认看所有, 可用 ?owner_id=X 过滤某用户
    """
    if caller.is_admin:
        # admin: 不限定 owner (除非显式传 owner_id)
        return WorkloadRepo.list_by_owner(s, owner_id=owner_id, status=status,
                                          limit=limit, offset=offset)
    return WorkloadRepo.list_visible_to_account(
        s, caller.id, status=status, limit=limit, offset=offset,
    )
