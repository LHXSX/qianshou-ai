"""
Worker WebSocket router · WSS /api/v8/ws/worker

设计要点 (考虑全链路):
  1. 这是 worker 的**唯一长连通道** (替代 v1 的 WS+HTTP polling 双套并行)
  2. 完整状态机:
     accept → recv hello (5s) → send welcome → recv auth (10s)
     → send auth_ok + 注册 worker + fire on_worker_online hook
     → 主循环: recv (hb | shard_result | ...) → 对应处理
  3. 断连只清理该连接代际；DB 离线状态由心跳超时回收器确认
  4. 后续链路 5 在主循环里加 shard_result/shard_progress 处理
  5. 后续链路 5 在 hook 接 auto-queue (节点上线立即重提 WAITING 任务)

ws 帧协议: protocol/ws_schema.py
"""
from __future__ import annotations
import asyncio
import json
import logging
import time
import uuid as _uuid
from dataclasses import replace

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from platform_v8.protocol import ws_schema as ws_proto
from platform_v8.protocol.capability_profile import profile_from_hello
from platform_v8.services.auth import validation as auth_validation
from platform_v8.services.observability import record_lifecycle_event
from platform_v8.services.workers import register as register_svc
from platform_v8.services.workers import heartbeat as hb_svc
from platform_v8.storage import db as db_mod
from platform_v8.engine import registry as registry_mod
from platform_v8.engine import broker as broker_mod
from platform_v8.engine import gateway as gateway_mod
from platform_v8.engine import aggregator as aggregator_mod
from platform_v8.engine import frame_router  # W0-5 · 通用帧路由 (业务自己注册 handler)
from platform_v8.services.workers import order_adapter_ws_observations as challenge_observations

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/ws", tags=["ws"])

HELLO_TIMEOUT_S = 5
AUTH_TIMEOUT_S = 10
HB_TIMEOUT_S = 120     # 客户端默认 15s 心跳一次 · 120s没收 → close (给任务执行留余量)
AUTH_RECHECK_S = 15     # 空闲长连仍定期复核 access、会话和 JTI 撤销

_RETIRED_BUILD_MARKERS = ("eco-sidecar", "eco-client", "eco-v3")


def _persist_order_adapter_challenge_observation(frame: ws_proto.OrderAdapterChallengeResult,
                                                 worker_id: str, owner_id: int,
                                                 connection_id: str) -> None:
    with db_mod.session_scope() as s:
        challenge_observations.record_from_worker_ws(
            s, worker_id=worker_id, owner_id=owner_id,
            connection_id=connection_id, payload=frame.payload.model_dump(),
        )
        s.commit()


def _retired_eco_hello(hello) -> bool:
    """Refuse retired 千手生态 clients. Official nodes that omit client_build stay.

    千手 AI hello carries protocol qianshou.isolated-inline-session.v1 and is never
    treated as eco even if provided_capabilities later grows object items.
    """
    build = (hello.payload.client_build or "").strip().lower()
    if any(marker in build for marker in _RETIRED_BUILD_MARKERS):
        return True
    caps = hello.payload.capabilities if isinstance(hello.payload.capabilities, dict) else {}
    proto = str(caps.get("protocol") or "")
    if proto.startswith("qianshou.isolated-inline-session"):
        return False
    provided = caps.get("provided_capabilities")
    if not isinstance(provided, list):
        return False
    for item in provided:
        if not isinstance(item, dict):
            continue
        if "repairTier" in item or str(item.get("provider") or "").startswith("runtime:"):
            return True
    return False


def _validate_connected_worker_access(raw_token: str, owner_id: int) -> None:
    """Recheck one live worker against the same access/session/JTI gate as HTTP."""
    with db_mod.session_scope() as s:
        validated = auth_validation.validate_v8_access(s, raw_token, touch=False)
        if validated.account.id != owner_id:
            raise auth_validation.AuthValidationError("worker owner changed")



def _persist_shard_progress(payload, worker_id: str) -> int | None:
    """同步 DB 工作；调用方必须放入 asyncio.to_thread。"""
    from platform_v8.core import ShardMode, ShardStatus
    from platform_v8.engine.effective_task import soft_reclaim_running_horizon_s
    from platform_v8.services.artifact_lease import verify_lease_token
    from platform_v8.storage.repo import ShardRepo, WorkloadRepo

    if payload.attempt is None or not payload.lease_token:
        # 老客户端没有 assignment 凭据：不采信 progress，生命周期按
        # started_at/dispatched_at + effective horizon 保守兜底。
        return None
    with db_mod.session_scope() as s:
        shard = ShardRepo.by_id(s, payload.shard_id)
        if shard is None:
            return None
        owner = (
            shard.lease_by_node
            if shard.status == ShardStatus.LEASED
            else shard.worker_id
        )
        if str(owner or "") != str(worker_id):
            return None
        if int(shard.attempts) != int(payload.attempt):
            return None
        if not verify_lease_token(
            payload.lease_token,
            shard_id=str(payload.shard_id),
            worker_id=str(worker_id),
            attempt=int(payload.attempt),
        ):
            return None
        workload = WorkloadRepo.by_id(s, shard.workload_id)
        if workload is None:
            return None
        lease_seconds = None
        if shard.mode == ShardMode.PULL or shard.lease_expires_at is not None:
            lease_seconds = soft_reclaim_running_horizon_s(workload, shard)
        accepted = ShardRepo.touch_progress(
            s,
            payload.shard_id,
            expected_worker_id=worker_id,
            expected_attempt=int(payload.attempt),
            lease_seconds=lease_seconds,
        )
        if not accepted:
            return None
        s.commit()
        return int(workload.owner_id)


def _persist_legacy_shard_progress(envelope) -> int | None:
    """Persist one delivery-bound legacy progress frame with attempt CAS."""
    from platform_v8.core import ShardMode
    from platform_v8.engine.effective_task import soft_reclaim_running_horizon_s
    from platform_v8.storage.repo import ShardRepo, WorkloadRepo

    binding = envelope.binding
    with db_mod.session_scope() as s:
        shard = ShardRepo.by_id(s, binding.shard_id)
        if shard is None or str(shard.workload_id) != str(binding.workload_id):
            return None
        workload = WorkloadRepo.by_id(s, shard.workload_id)
        if workload is None:
            return None
        lease_seconds = None
        if shard.mode == ShardMode.PULL or shard.lease_expires_at is not None:
            lease_seconds = soft_reclaim_running_horizon_s(workload, shard)
        accepted = ShardRepo.touch_progress(
            s,
            binding.shard_id,
            expected_worker_id=binding.worker_id,
            expected_attempt=binding.attempt,
            lease_seconds=lease_seconds,
        )
        if not accepted:
            return None
        s.commit()
        return int(workload.owner_id)


def _resolve_strict_result_attempt(payload, worker_id: str) -> int | None:
    """Validate a modern result lease and return its current attempt."""
    from platform_v8.core import ShardStatus
    from platform_v8.services.artifact_lease import verify_lease_token
    from platform_v8.storage.repo import ShardRepo

    with db_mod.session_scope() as s:
        shard = ShardRepo.by_id(s, payload.shard_id)
        if shard is None or shard.status not in {
            ShardStatus.DISPATCHED,
            ShardStatus.LEASED,
            ShardStatus.RUNNING,
        }:
            return None
        active_workers = ShardRepo.race_workers_of(shard)
        if shard.lease_by_node:
            active_workers.add(str(shard.lease_by_node))
        if str(worker_id) not in active_workers:
            return None
        attempt = int(shard.attempts)
        if payload.worker_id is not None and str(payload.worker_id) != str(worker_id):
            return None
        if (
            payload.workload_id is not None
            and str(payload.workload_id) != str(shard.workload_id)
        ):
            return None
        if payload.attempt is not None and int(payload.attempt) != attempt:
            return None
        if not verify_lease_token(
            payload.lease_token,
            shard_id=str(payload.shard_id),
            worker_id=str(worker_id),
            attempt=attempt,
        ):
            return None
        return attempt


def _adapt_legacy_worker_frame(
    raw: str,
    *,
    worker_id: str,
    connection_id: str,
    enabled: bool = True,
):
    """DB-bound legacy fallback; caller must have tried ws_schema first."""
    from platform_v8.services.legacy_compat import accept_decision
    from platform_v8.services.legacy_result_adapter import (
        adapt_after_strict_failure,
    )

    with db_mod.session_scope() as s:
        decision = accept_decision(worker_id, session=s)
        envelope = adapt_after_strict_failure(
            s,
            raw,
            authenticated_worker_id=worker_id,
            connection_id=connection_id,
            enabled=enabled,
            decision=decision,
        )
        return replace(envelope, adapter_metadata=decision.audit())


def _observe_strict_profile(worker_id: str, *, artifact: bool) -> str:
    from platform_v8.protocol.capability_profile import CapabilityProfile
    from platform_v8.storage.repo import WorkerRepo

    observed = (
        CapabilityProfile.SECURE_ARTIFACT_V1
        if artifact
        else CapabilityProfile.LEASE_INLINE_V1
    )
    with db_mod.session_scope() as s:
        profile = WorkerRepo.observe_protocol_profile(
            s,
            worker_id,
            observed,
            observation=f"accepted:{observed.value}",
        )
        s.commit()
        return profile


def _observe_legacy_profile(worker_id: str, shape: object) -> str:
    from platform_v8.protocol.capability_profile import (
        observation_for_legacy_shape,
    )
    from platform_v8.storage.repo import WorkerRepo

    observed = observation_for_legacy_shape(shape)
    with db_mod.session_scope() as s:
        profile = WorkerRepo.observe_protocol_profile(
            s,
            worker_id,
            observed,
            observation=f"normalized:{getattr(shape, 'value', shape)}",
        )
        s.commit()
        return profile


def _apply_native_adapter_update(*, owner_id, worker_id, connection_id, payload):
    """Commit verified metadata and evict both registry views before an accepted ACK."""
    from platform_v8.services.workers import native_h3_adapter_updates
    with db_mod.session_scope() as s:
        result = native_h3_adapter_updates.apply_update(s, owner_id=owner_id,
            worker_id=worker_id, connection_id=connection_id, payload=payload)
        s.commit()
    # A concurrent reconnect cannot receive an accepted receipt on the old socket.
    native_h3_adapter_updates._require_current(owner_id, worker_id, connection_id)
    registry_mod.invalidate_cache(owner_id=owner_id)
    return result


@router.websocket("/worker")
async def worker_ws(ws: WebSocket):
    """...
    Worker 唯一长连通道 · subprotocol 必须是 'edgecompute.v8'
    """
    # 验证 subprotocol
    subprotos = ws.headers.get("sec-websocket-protocol", "").split(",")
    if ws_proto.SUBPROTOCOL not in [s.strip() for s in subprotos]:
        await ws.accept()  # accept 才能 close 时返 reason
        await ws.send_text(ws_proto.build_err(
            1000, f"subprotocol 不匹配 · 期望 {ws_proto.SUBPROTOCOL}", fatal=True,
        ))
        await ws.close(code=1002)
        return
    await ws.accept(subprotocol=ws_proto.SUBPROTOCOL)

    worker_id: str | None = None
    owner_id: int | None = None
    trace_id = _uuid.uuid4().hex[:12]
    connection_id = str(_uuid.uuid4())
    native_connection_published = False

    try:
        # ── 1. hello (5s) ─────────────────────────────
        try:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=HELLO_TIMEOUT_S)
        except asyncio.TimeoutError:
            await ws.send_text(ws_proto.build_err(1001, "hello timeout", fatal=True))
            await ws.close(code=1002)
            return

        try:
            frame = ws_proto.parse_incoming(raw)
        except ws_proto.ProtocolError as exc:
            await ws.send_text(ws_proto.build_err(1002, str(exc), fatal=True))
            await ws.close(code=1002)
            return

        if not isinstance(frame, ws_proto.Hello):
            await ws.send_text(ws_proto.build_err(1003, "expected hello", fatal=True))
            await ws.close(code=1002)
            return

        hello = frame
        logger.info("ws.hello · trace=%s client_version=%s os=%s arch=%s worker_id=%s",
                    trace_id, hello.payload.client_version,
                    hello.payload.os, hello.payload.arch, hello.payload.worker_id)

        if _retired_eco_hello(hello):
            logger.warning("ws.hello refused retired eco client · trace=%s build=%s",
                           trace_id, hello.payload.client_build)
            await ws.send_text(ws_proto.build_err(1010, "retired client · use 千手智能体", fatal=True))
            await ws.close(code=1002)
            return

        # ── 2. send welcome ─────────────────────────────
        await ws.send_text(ws_proto.build_welcome())

        # ── 3. auth (10s) ──────────────────────────────
        try:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=AUTH_TIMEOUT_S)
        except asyncio.TimeoutError:
            await ws.send_text(ws_proto.build_err(2001, "auth timeout", fatal=True))
            await ws.close(code=1002)
            return

        try:
            frame = ws_proto.parse_incoming(raw)
        except ws_proto.ProtocolError as exc:
            await ws.send_text(ws_proto.build_err(2002, str(exc), fatal=True))
            await ws.close(code=1002)
            return

        if not isinstance(frame, ws_proto.Auth):
            await ws.send_text(ws_proto.build_err(2003, "expected auth", fatal=True))
            await ws.close(code=1002)
            return

        auth = frame
        # WS accepts only the current v8 access token. Refresh belongs solely
        # to /auth/refresh; legacy agent/user tokens cannot bypass SID/JTI.
        access_token = auth.payload.access_token

        # ── 4. 注册 worker + send auth_ok ───────────────
        # worker_id: 优先用 hello 带的 (重连场景) · 没传就服务器生成
        # 注意: we_workers.id 是 UUID 类型 · v1 老客户端传 "v3-xxx" 字符串 → 转 uuid5
        raw_wid = hello.payload.worker_id or f"w-{_uuid.uuid4().hex[:12]}"
        try:
            wid = str(_uuid.UUID(raw_wid))  # 已经是合法 UUID
        except (ValueError, TypeError):
            # v1 老客户端格式 (如 "v3-69b5dd07cfa7") · 用 uuid5 转成确定性 UUID
            wid = str(_uuid.uuid5(_uuid.NAMESPACE_DNS, raw_wid))
            logger.info("ws.auth · 老 worker_id %s → uuid5 %s", raw_wid, wid)

        def _register():
            with db_mod.session_scope() as s:
                validated = auth_validation.validate_v8_access(s, access_token)
                account = validated.account

                w = register_svc.register_worker(
                    s,
                    register_svc.RegisterWorkerInput(
                        worker_id=wid,
                        owner_id=account.id,
                        name=auth.payload.name or wid,
                        capabilities=hello.payload.capabilities,
                        client_version=hello.payload.client_version,
                        client_build=hello.payload.client_build,
                        protocol_capabilities=hello.payload.protocol_capabilities,
                        trace_id=trace_id,
                    ),
                )
                s.commit()
                return w, account

        try:
            worker, account = await asyncio.to_thread(_register)
        except auth_validation.AuthValidationError:
            await ws.send_text(ws_proto.build_err(
                2004, "access token 无效、过期或已撤销 · 请续期后重连", fatal=True,
            ))
            await ws.close(code=4401)
            return
        except register_svc.WorkerTemporarilyDisabledError as exc:
            logger.info(
                "ws.register_worker 临时禁用 trace=%s wid=%s until=%s",
                trace_id, wid, exc.disabled_until.isoformat(),
            )
            await ws.send_text(ws_proto.build_err(
                2010,
                f"节点临时禁止上线至 {exc.disabled_until.isoformat()}",
                fatal=True,
            ))
            await ws.close(code=4403, reason="temporarily disabled")
            return
        except register_svc.WorkerDeletedByOwnerError as exc:
            logger.info(
                "ws.register_worker 已删除 trace=%s wid=%s",
                trace_id, wid,
            )
            await ws.send_text(ws_proto.build_err(
                2011,
                str(exc),
                fatal=True,
            ))
            await ws.close(code=4401, reason="node_deleted")
            return
        except RuntimeError as exc:
            await ws.send_text(ws_proto.build_err(2005, str(exc), fatal=True))
            await ws.close(code=4401)
            return
        except ValueError as exc:
            # 典型：worker_id 已绑定其他账号 · 客户端应清本地 node_id 后重连
            logger.warning("ws.register_worker 业务拒绝 trace=%s · %s", trace_id, exc)
            await ws.send_text(ws_proto.build_err(2005, str(exc), fatal=True))
            await ws.close(code=4401)
            return
        except Exception as exc:
            logger.exception("ws.register_worker 异常 trace=%s", trace_id)
            await ws.send_text(ws_proto.build_err(5001, "internal error", fatal=True))
            await ws.close(code=1011)
            return

        worker_id = str(worker.id)   # UUID → str (pydantic AuthOkPayload 要求 str)
        owner_id = worker.owner_id
        welcome_back = hello.payload.worker_id is not None

        from platform_v8.services.workers import native_h3_bindings as native_connections
        async def _require_current_access(*, registered: bool) -> bool:
            try:
                await asyncio.to_thread(
                    _validate_connected_worker_access, access_token, owner_id,
                )
            except auth_validation.AuthValidationError:
                await ws.send_text(ws_proto.build_err(
                    2004, "access token 无效、过期或已撤销 · 请续期后重连", fatal=True,
                ))
                await ws.close(code=4401)
                return False
            except Exception:
                logger.exception("ws.auth recheck unavailable · worker=%s", worker_id)
                await ws.send_text(ws_proto.build_err(
                    5001, "鉴权服务暂不可用 · 请稍后重连", fatal=True,
                ))
                await ws.close(code=1011)
                return False

            if registered:
                current = broker_mod.get_session_metadata(worker_id)
                if (current is None or current.ws is not ws
                        or current.connection_id != connection_id):
                    await ws.close(code=4409, reason="connection superseded")
                    return False
            if native_connection_published:
                current_id = await asyncio.to_thread(
                    native_connections.current_connection_id,
                    worker_id, owner_id=owner_id,
                )
                if current_id != connection_id:
                    await ws.close(code=4409, reason="connection superseded")
                    return False
            return True

        # A revoked reconnect must not overwrite a healthy worker's shared
        # connection record. Check before publication, then again afterwards.
        if not await _require_current_access(registered=False):
            return
        native_connection_published = await asyncio.to_thread(
            native_connections.observe_connection, worker_id,
            owner_id=owner_id, connection_id=connection_id,
        )

        # With multiple gateways, a Redis connection identity is required to
        # stop a replaced socket on another process from submitting frames.
        if await asyncio.to_thread(gateway_mod.multi_enabled) and not native_connection_published:
            await ws.send_text(ws_proto.build_err(
                5001, "共享连接登记不可用 · 请稍后重连", fatal=True,
            ))
            await ws.close(code=1011)
            return

        # The login session can be revoked while registration is in flight.
        # Never publish this socket to the dispatch broker without a fresh gate.
        if not await _require_current_access(registered=False):
            return

        await ws.send_text(ws_proto.build_auth_ok(
            worker_id=worker_id,
            owner_id=owner_id,
            welcome_back=welcome_back,
            connection_id=connection_id,
        ))

        # invalidate cache + 注册 ws session (broker 用) + fire hook (auto-queue 重提)
        registry_mod.invalidate_cache(owner_id=owner_id)
        await broker_mod.register_session(
            worker_id,
            ws,
            connection_id=connection_id,
            client_version=hello.payload.client_version,
            client_build=hello.payload.client_build or "",
            protocol_capabilities=hello.payload.protocol_capabilities or [],
            protocol_mode=(
                "legacy"
                if (
                    hello.payload.client_build is None
                    or hello.payload.protocol_capabilities is None
                )
                else "negotiated"
            ),
            capability_profile=profile_from_hello(
                hello.payload.protocol_capabilities
            ).value,
            recover=False,
        )
        if not await _require_current_access(registered=True):
            return
        await broker_mod.resume_session(worker_id, ws)
        await registry_mod.fire_worker_online(worker_id, owner_id)

        logger.info("ws.auth_ok · trace=%s worker=%s owner=%s welcome_back=%s",
                    trace_id, worker_id, owner_id, welcome_back)

        # ── 5. 主循环: hb + shard_result + shard_progress ────
        last_message_at = time.monotonic()
        while True:
            remaining_hb = HB_TIMEOUT_S - (time.monotonic() - last_message_at)
            if remaining_hb <= 0:
                logger.info("ws.hb_timeout · worker=%s · 超过 %ds 无消息 · close",
                            worker_id, HB_TIMEOUT_S)
                break
            try:
                raw = await asyncio.wait_for(
                    ws.receive_text(), timeout=min(AUTH_RECHECK_S, remaining_hb),
                )
            except asyncio.TimeoutError:
                raw = None

            # Validate before processing every inbound frame, including result
            # and heartbeat, and on idle intervals even when the peer is silent.
            if not await _require_current_access(registered=True):
                return
            if raw is None:
                continue
            last_message_at = time.monotonic()

            from platform_v8.services.legacy_result_adapter import (
                LegacyAdapterError,
                LegacyProgressEnvelope,
                LegacyResultEnvelope,
                ensure_frame_size,
            )

            try:
                # Applies to strict and legacy frames before either JSON parser.
                ensure_frame_size(raw)
            except LegacyAdapterError as exc:
                logger.warning(
                    "ws.frame rejected · worker=%s reason=%s",
                    worker_id, exc.reason.value,
                )
                await ws.send_text(ws_proto.build_err(1002, "frame rejected"))
                continue

            try:
                # Security invariant: modern Pydantic parsing always runs first.
                frame = ws_proto.parse_incoming(raw)
            except ws_proto.ProtocolError:
                try:
                    frame = await asyncio.to_thread(
                        _adapt_legacy_worker_frame,
                        raw,
                        worker_id=worker_id,
                        connection_id=connection_id,
                    )
                except LegacyAdapterError as exc:
                    logger.warning(
                        "legacy_event=reject reason=%s frame_type=%s",
                        exc.reason.value,
                        exc.frame_type or "unknown",
                    )
                    await ws.send_text(ws_proto.build_err(
                        1002, f"legacy frame rejected: {exc.reason.value}"
                    ))
                    continue

            if isinstance(frame, LegacyProgressEnvelope):
                logger.debug(
                    "legacy_event=progress shape=%s",
                    frame.shape.value,
                )
                try:
                    from platform_v8.engine.broker import broadcast_to_owner as _bo
                    _owner = await asyncio.to_thread(
                        _persist_legacy_shard_progress, frame
                    )
                    if _owner:
                        await _bo(_owner, "task_event", {
                            "shard_id": frame.binding.shard_id,
                            "status": "progress",
                            "pct": frame.pct,
                            "message": frame.message,
                        })
                except Exception:
                    logger.debug(
                        "legacy_event=progress_persist "
                        "reason=infrastructure_unavailable"
                    )
                continue

            if isinstance(frame, LegacyResultEnvelope):
                logger.info(
                    "legacy_event=result shape=%s ok=%s binding=%s",
                    frame.shape.value,
                    frame.ok,
                    frame.binding.method.value,
                )
                if not frame.ok:
                    # HOTPATCH_LOG_SHARD_FAIL
                    logger.warning(
                        "ws.shard_fail · shard=%s worker=%s attempt=%s class=%s err=%s stderr=%s",
                        frame.binding.shard_id,
                        frame.binding.worker_id,
                        frame.binding.attempt,
                        frame.failure_class,
                        (frame.error or "")[:500],
                        (frame.stderr_tail or "")[:300],
                    )
                    await aggregator_mod.on_shard_failed(
                        frame.binding.shard_id,
                        error=frame.error or "legacy worker reported failure",
                        expected_worker_id=frame.binding.worker_id,
                        expected_attempt=frame.binding.attempt,
                        stderr_tail=frame.stderr_tail,
                        exit_code=frame.exit_code,
                        python_used=frame.python_used,
                        failure_class=frame.failure_class,
                        missing_dep=frame.missing_dep,
                    )
                else:
                    normalization_started = time.perf_counter()
                    from platform_v8.services.legacy_result_normalizer import (
                        LegacyNormalizationError,
                        LegacyResultNormalizer,
                    )
                    from platform_v8.services.result_verifier import (
                        ResultIsolationError,
                    )

                    try:
                        normalized = await asyncio.to_thread(
                            LegacyResultNormalizer().normalize_and_enqueue,
                            frame,
                        )
                    except ResultIsolationError as exc:
                        # 不整单隔离: 拒绝 inline 结算，排除该节点并重派本片。
                        # 企业端/借调共用 · 仍禁止用 legacy inline 过结算门。
                        await aggregator_mod.on_shard_failed(
                            frame.binding.shard_id,
                            error=(
                                "LEGACY_ARTIFACT_REQUIRED: "
                                "artifact 策略下节点回了 inline · 改派其他节点"
                            ),
                            expected_worker_id=frame.binding.worker_id,
                            expected_attempt=exc.attempt,
                            failure_class="protocol_legacy_inline",
                        )
                        await ws.send_text(ws_proto.build_err(
                            1004, "artifact required; shard will retry on another node"
                        ))
                        continue
                    except LegacyNormalizationError as exc:
                        logger.warning(
                            "legacy_event=normalization_reject reason=%s",
                            getattr(exc, "reason", "other"),
                        )
                        await ws.send_text(ws_proto.build_err(
                            1003, "legacy result normalization rejected"
                        ))
                        continue
                    except Exception:
                        logger.warning(
                            "legacy_event=normalization_unavailable "
                            "reason=infrastructure_unavailable"
                        )
                        await ws.send_text(ws_proto.build_err(
                            1005, "verification infrastructure unavailable"
                        ))
                        continue
                    record_lifecycle_event(
                        "verification",
                        shard_id=frame.binding.shard_id,
                        worker_id=frame.binding.worker_id,
                        attempt=frame.binding.attempt,
                        reason_code=(
                            "VERIFICATION_ALREADY_QUEUED"
                            if normalized.idempotent
                            else "VERIFICATION_QUEUED"
                        ),
                        latency_ms=(
                            time.perf_counter() - normalization_started
                        ) * 1000,
                        bytes_count=normalized.artifact.size_bytes,
                        outcome="pending",
                    )
                    from platform_v8.protocol.capability_profile import (
                        observation_for_legacy_shape,
                    )
                    from platform_v8.services.observability import (
                        record_legacy_profile,
                    )

                    previous_profile = broker_mod.get_session_profile(worker_id)
                    observed_profile = await asyncio.to_thread(
                        _observe_legacy_profile,
                        worker_id,
                        frame.shape,
                    )
                    record_legacy_profile(
                        observed=observation_for_legacy_shape(frame.shape),
                        previous=previous_profile,
                        current=observed_profile,
                    )
                    await broker_mod.observe_session_profile(
                        worker_id,
                        observed_profile,
                    )
                continue

            if isinstance(frame, ws_proto.NativeH3AdapterUpdate):
                try:
                    answer = await asyncio.to_thread(_apply_native_adapter_update, owner_id=owner_id,
                        worker_id=worker_id, connection_id=connection_id, payload=frame.payload.model_dump())
                except (ValueError, TypeError):
                    answer = {"request_id": frame.payload.request_id, "connection_id": connection_id,
                        "status": "rejected", "task_types": []}
                except Exception:
                    logger.warning("native adapter synchronization unavailable · worker=%s", worker_id)
                    answer = {"request_id": frame.payload.request_id, "connection_id": connection_id,
                        "status": "rejected", "task_types": []}
                await ws.send_text(json.dumps({"type": "native_h3_adapter_update_ack", "v": "8.0",
                    "payload": answer}, separators=(",", ":")))
                continue

            if isinstance(frame, ws_proto.NativeH3DevicePresence):
                def _native_presence_witness():
                    from platform_v8.services.workers.native_h3_versions import witness
                    with db_mod.session_scope() as s:
                        witness(s, owner_id=owner_id, worker_id=worker_id, connection_id=connection_id,
                                payload=frame.payload.model_dump())
                        s.commit()
                try:
                    await asyncio.to_thread(_native_presence_witness)
                except ValueError:
                    await ws.send_text(ws_proto.build_err(1003, "native device presence rejected"))
                    continue
                await ws.send_text(json.dumps({"type":"native_h3_device_presence_ack","v":"8.0",
                    "payload":{"challenge_nonce":frame.payload.challenge_nonce}},separators=(",", ":")))
                continue

            if isinstance(frame, ws_proto.NativeH3DeviceConfigProof):
                def _native_config_witness():
                    from platform_v8.services.workers.native_h3_device_configs import witness
                    with db_mod.session_scope() as s:
                        witness(s,owner_id=owner_id,worker_id=worker_id,connection_id=connection_id,
                            payload=frame.payload.model_dump())
                        s.commit()
                try:
                    await asyncio.to_thread(_native_config_witness)
                except ValueError:
                    await ws.send_text(ws_proto.build_err(1003,"native device config proof rejected"))
                    continue
                await ws.send_text(json.dumps({"type":"native_h3_device_config_proof_ack","v":"8.0",
                    "payload":{"challenge_id":frame.payload.challenge_id}},separators=(",",":")))
                continue

            if isinstance(frame, ws_proto.NativeH3DeviceKeyProof):
                def _native_device_witness():
                    from platform_v8.services.workers.native_h3_device_keys import witness
                    with db_mod.session_scope() as s:
                        witness(s, owner_id=owner_id, worker_id=worker_id, connection_id=connection_id,
                                payload=frame.payload.model_dump())
                        s.commit()
                try:
                    await asyncio.to_thread(_native_device_witness)
                except ValueError:
                    await ws.send_text(ws_proto.build_err(1003, "native device key proof rejected"))
                    continue
                await ws.send_text(json.dumps({"type":"native_h3_device_key_proof_ack","v":"8.0",
                    "payload":{"challenge_id":frame.payload.challenge_id}},separators=(",", ":")))
                continue

            # A result observed on this authenticated socket is independently
            # readable by the attestor. The client does not get to assert its
            # own worker/owner identity or a successful platform receipt.
            if isinstance(frame, ws_proto.OrderAdapterChallengeResult):
                try:
                    await asyncio.to_thread(
                        _persist_order_adapter_challenge_observation,
                        frame, worker_id, owner_id, connection_id,
                    )
                except challenge_observations.ObservationError:
                    await ws.send_text(ws_proto.build_err(1003, "challenge observation rejected"))
                    continue
                await ws.send_text(json.dumps({
                    "type": "order_adapter_challenge_ack", "v": "8.0",
                    "payload": {"challenge_nonce": frame.payload.challenge_nonce},
                }, separators=(",", ":")))
                continue

            # ── 心跳 ──
            if isinstance(frame, ws_proto.Hb):
                def _hb():
                    with db_mod.session_scope() as s:
                        if native_connection_published:
                            native_connections.renew_connection(worker_id, owner_id=owner_id, connection_id=connection_id)
                        hb_svc.heartbeat(
                            s, worker_id,
                            load=frame.payload.load,
                            active_shards=frame.payload.active_shards,
                            throttle_pct=frame.payload.throttle_pct,
                            mode=frame.payload.mode,
                            extra=frame.payload.extra,
                        )
                        s.commit()
                await asyncio.to_thread(_hb)
                # 续约该worker所有RUNNING shard的租约
                from platform_v8.engine.lifecycle import renew_shard_leases
                await renew_shard_leases(str(worker_id), frame.payload.active_shards)
                await ws.send_text(ws_proto.build_hb_ack())
                continue

            # ── 任务结果 (链路 5) ──
            if isinstance(frame, ws_proto.ShardResult):
                p = frame.payload
                expected_attempt = await asyncio.to_thread(
                    _resolve_strict_result_attempt, p, worker_id
                )
                if expected_attempt is None:
                    await ws.send_text(ws_proto.build_err(
                        1003, "result rejected by assignment validation"
                    ))
                    continue
                if p.ok:
                    verification_started = time.perf_counter()
                    artifact_bytes = (
                        p.artifact.get("size_bytes")
                        if isinstance(p.artifact, dict)
                        and isinstance(p.artifact.get("size_bytes"), (int, float))
                        else None
                    )
                    try:
                        from platform_v8.services.result_verifier import (
                            ResultIsolationError,
                            prepare_verification_request,
                        )
                        prepared = await asyncio.to_thread(
                            prepare_verification_request,
                            shard_id=p.shard_id,
                            worker_id=worker_id,
                            lease_token=p.lease_token,
                            output_ref=p.output_ref,
                            inline_output=p.inline_output,
                            artifact=p.artifact,
                        )
                    except Exception as exc:
                        logger.warning(
                            "ws.shard_result rejected · worker=%s shard=%s reason=%s detail=%s",
                            worker_id, p.shard_id, type(exc).__name__, str(exc)[:300],
                        )
                        if isinstance(exc, ResultIsolationError):
                            record_lifecycle_event(
                                "verification",
                                shard_id=p.shard_id,
                                worker_id=worker_id,
                                attempt=exc.attempt,
                                reason_code="LEGACY_ARTIFACT_REQUIRED",
                                latency_ms=(time.perf_counter() - verification_started) * 1000,
                                bytes_count=artifact_bytes,
                                outcome="rejected_retry",
                            )
                            # 不整单 QUARANTINED: 排除该节点 + 重派本片（结算仍要 artifact）
                            await aggregator_mod.on_shard_failed(
                                p.shard_id,
                                error=(
                                    "LEGACY_ARTIFACT_REQUIRED: "
                                    "artifact 策略下节点回了 inline · 改派其他节点"
                                ),
                                expected_worker_id=worker_id,
                                expected_attempt=exc.attempt,
                                failure_class="protocol_legacy_inline",
                            )
                            await ws.send_text(ws_proto.build_err(
                                1004, "artifact required; shard will retry on another node"
                            ))
                            continue
                        record_lifecycle_event(
                            "verification",
                            shard_id=p.shard_id,
                            worker_id=worker_id,
                            reason_code="RESULT_VALIDATION_FAILED",
                            latency_ms=(time.perf_counter() - verification_started) * 1000,
                            bytes_count=artifact_bytes,
                            outcome="failed",
                        )
                        await ws.send_text(ws_proto.build_err(1003, "result rejected by validation"))
                        continue
                    if prepared.policy == "quarantine":
                        quarantined = await aggregator_mod.quarantine_shard_result(
                            p.shard_id,
                            expected_worker_id=worker_id,
                            expected_attempt=prepared.attempt,
                            reason_code="REGISTRY_QUARANTINE",
                        )
                        if quarantined:
                            await ws.send_text(ws_proto.build_err(
                                1004,
                                "result quarantined for manual review",
                            ))
                        continue
                    observed_profile = await asyncio.to_thread(
                        _observe_strict_profile,
                        worker_id,
                        artifact=bool(p.artifact),
                    )
                    await broker_mod.observe_session_profile(
                        worker_id,
                        observed_profile,
                    )
                    try:
                        from platform_v8.services.result_verification_jobs import (
                            enqueue_verification,
                        )
                        accepted = await asyncio.to_thread(
                            enqueue_verification,
                            prepared,
                            elapsed_ms=p.elapsed_ms,
                        )
                    except Exception as exc:
                        logger.exception(
                            "ws.verification enqueue failed · shard=%s", p.shard_id
                        )
                        await ws.send_text(ws_proto.build_err(
                            1005, "verification infrastructure unavailable"
                        ))
                        continue
                    if not accepted:
                        continue
                    record_lifecycle_event(
                        "verification",
                        shard_id=p.shard_id,
                        worker_id=worker_id,
                        attempt=prepared.attempt,
                        reason_code="VERIFICATION_QUEUED",
                        latency_ms=(time.perf_counter() - verification_started) * 1000,
                        bytes_count=artifact_bytes,
                        outcome="pending",
                    )
                    # Durable worker performs verification and aggregation.
                    # Do not broadcast completion before the hard gate succeeds.
                    continue
                else:
                    # HOTPATCH_LOG_SHARD_FAIL2
                    logger.warning(
                        "ws.shard_fail · shard=%s worker=%s attempt=%s class=%s err=%s stderr=%s py=%s",
                        p.shard_id, worker_id, expected_attempt, p.failure_class,
                        (p.error or "")[:500], (p.stderr_tail or "")[:400], p.python_used,
                    )
                    await aggregator_mod.on_shard_failed(
                        p.shard_id, error=p.error, expected_worker_id=worker_id,
                        expected_attempt=expected_attempt,
                        # v8.1.8 失败诊断三件套 (老客户端字段为空,完全向后兼容)
                        stderr_tail=p.stderr_tail, exit_code=p.exit_code,
                        python_used=p.python_used,
                        # v8.1.8 失败分类 (调度据此区分对待 env vs resource)
                        failure_class=p.failure_class, missing_dep=p.missing_dep)
                continue

            # ── 任务进度 (链路 5 · 2026-05-21 P0-5 · 推 task_event) ──
            if isinstance(frame, ws_proto.ShardProgress):
                p = frame.payload
                logger.debug("ws.shard_progress · worker=%s shard=%s pct=%.2f msg=%s",
                             worker_id, p.shard_id, p.pct, p.message)
                try:
                    from platform_v8.engine.broker import broadcast_to_owner as _bo
                    _owner = await asyncio.to_thread(
                        _persist_shard_progress, p, worker_id
                    )
                    if _owner:
                        await _bo(_owner, "task_event", {
                            "shard_id": p.shard_id,
                            "status": "progress",
                            "pct": p.pct,
                            "message": p.message,
                        })
                except Exception as exc:
                    logger.debug("shard_progress · persist/broadcast 失败 (静默): %s", exc)
                continue

            # ── control 回报：市场安装与自愈分别落库 ──
            if isinstance(frame, ws_proto.ControlResult):
                p = frame.payload
                logger.info("ws.control_result · worker=%s control=%s action=%s ok=%s detail=%s",
                            worker_id, p.control_id, p.action, p.ok, (p.detail or "")[:120])
                try:
                    if p.action in ("install_app", "uninstall_app"):
                        from platform_v8.services.marketplace import provisioning as _provisioning
                        accepted = await asyncio.to_thread(
                            _provisioning.record_result_from_worker,
                            worker_id, p.control_id, p.action, p.ok, p.detail,
                        )
                        if not accepted:
                            logger.warning(
                                "marketplace control_result rejected · worker=%s control=%s action=%s",
                                worker_id, p.control_id, p.action,
                            )
                    else:
                        from platform_v8.services.heal import decider as _heal
                        await asyncio.to_thread(
                            _heal.record_control_result,
                            worker_id, p.control_id, p.action, p.ok, p.detail,
                        )
                except Exception as exc:
                    if p.action in ("install_app", "uninstall_app"):
                        logger.exception(
                            "marketplace control_result persistence failed · worker=%s control=%s",
                            worker_id, p.control_id,
                        )
                    else:
                        logger.debug("control_result · record 失败 (静默): %s", exc)
                continue

            # ── 通用帧路由 (W0-5 · 业务自己注册 handler · 引擎不知道业务) ──
            # tunnel_chunk / tunnel_close / 任意业务帧都从这里走
            # 业务在启动时调 frame_router.register_handler(type, handler)
            if await frame_router.dispatch(frame, worker_id, owner_id):
                continue

            await ws.send_text(ws_proto.build_err(1004, f"未知帧类型: {frame.type}"))

    except WebSocketDisconnect:
        logger.info("ws.disconnect · trace=%s worker=%s", trace_id, worker_id)
    except Exception:
        logger.exception("ws.unhandled · trace=%s worker=%s", trace_id, worker_id)
    finally:
        # 清理: remove this exact connection generation. DB offline status is
        # handled by heartbeat reaper; an immediate unconditional update could
        # overwrite a new gateway's reconnect between Redis and DB operations.
        if worker_id:
            try:
                unregistered = await broker_mod.unregister_session(worker_id, ws)
                if native_connection_published:
                    await asyncio.to_thread(
                        native_connections.close_connection, worker_id,
                        owner_id=owner_id, connection_id=connection_id,
                    )
                registry_mod.invalidate_cache(owner_id=owner_id)
                logger.info("ws.cleanup · worker=%s local_unregistered=%s", worker_id, unregistered)
            except Exception:
                logger.exception("ws.cleanup 失败 worker=%s", worker_id)

        # 兜底 close (如果还没 close)
        if ws.application_state == WebSocketState.CONNECTED:
            try:
                await ws.close(code=1000)
            except Exception:
                pass


# ── 事件总线 · 企业/管理员 ws 连接 ──────────────────
# 2026-06-07 S2-T4 · 此处 handler 已删除 (IDOR 修复)
# 原 handler 接受客户端传 owner_id 时跳过 token 校验,可被伪造 owner_id 订阅他人事件。
# 统一改走 platform_v8/api/v8/events.py 的 /events 实现(query token + 严格从 token 解析 owner_id)。
# 路由优先级: events_router 在 app.py 中 include 顺序覆盖本 router 的 /events,
# 因此即便此处保留也无效,但代码隐患仍在 — 彻底删除杜绝未来 include 顺序变更时的回归。
