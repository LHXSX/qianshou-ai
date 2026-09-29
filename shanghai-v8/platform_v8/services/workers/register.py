"""
Worker 注册业务

设计要点 (考虑全链路):
  1. 注册 = upsert (同 worker_id 二次 = 更新 capabilities + name)
  2. 必须有合法 access_token · 取出 owner_id (调用方就是节点 owner)
  3. ws 和 HTTP 两个入口都调这里 (统一业务)
  4. 写审计 we_audit
  5. 触发 on_worker_online hook (engine.registry · 链路 5 用)
"""
from __future__ import annotations
import logging
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from platform_v8.core import Worker, WorkerStatus, AuditAction
from platform_v8.protocol.capability_profile import (
    merge_observation,
    profile_from_hello,
)
from platform_v8.storage.repo import WorkerRepo, AuditRepo, unknown_capability_fields

logger = logging.getLogger(__name__)


class WorkerTemporarilyDisabledError(Exception):
    """节点被临时禁用（处罚/租约冲突），禁止注册直到 disabled_until。"""
    def __init__(self, disabled_until):
        self.disabled_until = disabled_until
        super().__init__(f"worker temporarily disabled until {disabled_until}")


class WorkerDeletedByOwnerError(Exception):
    """节点已被账号从「我的节点」删除 · 客户端应注销并清本地 identity。"""

    def __init__(self, worker_id: str):
        self.worker_id = worker_id
        super().__init__(
            "AUTH_FAILED:node_deleted 该设备已从账号移除，请重新登录客户端"
        )

@dataclass
class RegisterWorkerInput:
    worker_id: str
    owner_id: int
    name: str
    capabilities: dict
    client_version: str = ""
    client_build: str | None = None
    protocol_capabilities: list[str] | None = None
    # 审计上下文
    trace_id: str | None = None
    ip: str | None = None


class WorkerTemporarilyDisabledError(ValueError):
    def __init__(self, disabled_until: datetime):
        self.disabled_until = disabled_until
        now = (
            datetime.now(disabled_until.tzinfo)
            if disabled_until.tzinfo is not None
            else datetime.utcnow()
        )
        self.retry_after_seconds = max(
            1, int((disabled_until - now).total_seconds()),
        )
        super().__init__(
            f"节点临时禁止上线至 {disabled_until.isoformat()}"
        )


def register_worker(s: Session, inp: RegisterWorkerInput) -> Worker:
    """
    注册 / 重连 worker · 返回 Worker · 失败抛 ValueError
    """
    if not inp.worker_id or len(inp.worker_id) < 6:
        raise ValueError("worker_id 不合法 (长度 < 6)")
    if not inp.name:
        inp.name = inp.worker_id

    # 机身指纹去重：本地 identity 丢失时复用同账号同机旧节点，避免「我的节点」堆幽灵
    from platform_v8.services.workers import machine_identity as mid_svc
    final_wid, fingerprint, remapped = mid_svc.resolve_worker_id_for_register(
        s,
        owner_id=inp.owner_id,
        worker_id=inp.worker_id,
        capabilities=inp.capabilities,
    )
    if remapped:
        inp.worker_id = final_wid

    # 2026-05-25 P0 安全修复 · worker_id 越权劫持
    # 之前: WorkerRepo.upsert 没校验归属 · 任何用户拿到他人 worker_id 都能 ws 连入接管
    # → 偷别人 reward / 污染信誉 / 伪造任务结果
    # 现在: 已存在的 worker_id 必须 owner_id 一致才允许 upsert
    existed_worker = WorkerRepo.by_id(s, inp.worker_id)
    existed = existed_worker is not None
    # Owner 删除后的墓碑：禁止同 identity 立刻复活
    try:
        from platform_v8.services.workers import tombstone as tombstone_svc
        if tombstone_svc.is_deleted(inp.worker_id):
            raise WorkerDeletedByOwnerError(inp.worker_id)
    except WorkerDeletedByOwnerError:
        raise
    except Exception as exc:
        logger.debug("worker.register tombstone check skip: %s", exc)
    if existed_worker is not None and existed_worker.owner_id != inp.owner_id:
        logger.warning(
            "worker.register · 拒绝越权 · worker_id=%s 已属于 owner=%s · 当前请求 owner=%s",
            inp.worker_id, existed_worker.owner_id, inp.owner_id,
        )
        raise ValueError(
            f"worker_id {inp.worker_id} 已被注册给其他账号 · 请联系管理员"
        )
    if existed_worker is not None and existed_worker.is_temporarily_disabled:
        raise WorkerTemporarilyDisabledError(existed_worker.disabled_until)

    capabilities = dict(inp.capabilities or {})
    if fingerprint and not capabilities.get("machine_fingerprint"):
        capabilities["machine_fingerprint"] = fingerprint
    # 复用已归档节点时清归档标记
    capabilities = mid_svc.unarchive_worker_caps(capabilities)
    declared_profile = profile_from_hello(inp.protocol_capabilities)
    existing_profile = (
        existed_worker.capabilities.protocol_profile
        if existed_worker is not None else None
    )
    capabilities["protocol_profile"] = merge_observation(
        existing_profile,
        declared_profile,
    ).value
    capabilities["protocol_profile_source"] = (
        "hello_capabilities"
        if inp.protocol_capabilities is not None
        else "legacy_baseline"
    )
    if existed_worker is not None:
        existing_observations = list(
            getattr(
                existed_worker.capabilities,
                "protocol_profile_observations",
                [],
            )
            or []
        )
        if existing_observations:
            capabilities["protocol_profile_observations"] = existing_observations[-16:]

    # QS-17 阶段①（影子）：只记录，不拦截、不改 capabilities；写审计失败也不影响注册。
    unknown_fields = unknown_capability_fields(capabilities)
    if unknown_fields:
        try:
            with s.begin_nested():
                AuditRepo.write(
                    s,
                    action="worker.unknown_fields",
                    actor_kind="system",
                    target_kind="worker",
                    target_id=str(inp.worker_id),
                    detail={
                        "unknown_fields": unknown_fields,
                        "count": len(unknown_fields),
                        "client_version": inp.client_version,
                        "client_build": inp.client_build,
                        "mode": "shadow",
                    },
                )
        except Exception:
            logger.error("worker.unknown_fields audit write failed (registration continues)", exc_info=True)
        logger.info(
            "worker.unknown_fields · worker=%s n=%d keys=%s",
            inp.worker_id, len(unknown_fields), ",".join(unknown_fields),
        )

    worker = WorkerRepo.upsert(
        s,
        worker_id=inp.worker_id,
        owner_id=inp.owner_id,
        name=inp.name,
        capabilities=capabilities,
        client_version=inp.client_version,
        client_build=inp.client_build,
        protocol_capabilities=inp.protocol_capabilities,
        legacy_protocol=(
            inp.client_build is None or inp.protocol_capabilities is None
        ),
        status=WorkerStatus.ONLINE,
    )

    # 同名离线幽灵 + 同指纹兄弟 → 软归档（列表隐藏，历史收益保留）
    try:
        mid_svc.archive_sibling_ghosts(
            s,
            owner_id=inp.owner_id,
            keep_worker_id=str(worker.id),
            name=inp.name,
            fingerprint=fingerprint or mid_svc.extract_fingerprint(capabilities),
        )
    except Exception as exc:
        logger.warning("worker.archive_ghosts skip id=%s: %s", worker.id, exc)

    AuditRepo.write(
        s,
        action=AuditAction.WORKER_REGISTER if not existed else AuditAction.WORKER_ONLINE,
        actor_account_id=inp.owner_id,
        actor_kind="user",
        target_kind="worker",
        target_id=worker.id,
        trace_id=inp.trace_id,
        ip=inp.ip,
        detail={
            "name": worker.name,
            "client_version": inp.client_version,
            "client_build": inp.client_build or "",
            "protocol_legacy": (
                inp.client_build is None or inp.protocol_capabilities is None
            ),
            "protocol_profile": declared_profile.value,
            "welcome_back": existed,
            "capabilities_keys": sorted({
                *inp.capabilities.keys(),
                "client_build",
                "protocol_capabilities",
                "protocol_legacy",
            }),
        },
    )

    logger.info("worker.%s · id=%s owner=%s welcome_back=%s",
                "online" if existed else "register",
                worker.id, inp.owner_id, existed)

    # 2026-05-18 实时推 worker.online 给 owner + admin
    try:
        from platform_v8.api.v8.events import publish_event_sync
        publish_event_sync("worker.online", {
            "worker_id": str(worker.id),
            "owner_id": inp.owner_id,
            "welcome_back": existed,
        }, owner_id=inp.owner_id)
    except Exception:
        pass

    return worker
