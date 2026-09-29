"""
Broker · 通过 ws 长连给 worker 推 shard_assign

设计要点 (考虑全链路):
  1. 全局 ws session 注册表: worker_id → WebSocket
     api/v8/ws.py auth_ok 后调 register_session
     ws 断开后调 unregister_session
  2. dispatch_assignments(assignments) — 批量推 shard_assign
     失败的 shard 重置回 PENDING (让 lifecycle 重派)
  3. cancel_shard(shard_id) — workload 取消时通知 worker
  4. push_to_worker(worker_id, frame) — 通用 push (后续 admin 命令也用)
"""
from __future__ import annotations
import asyncio
import json
import logging
import time
from dataclasses import dataclass, replace
from datetime import datetime

from fastapi import WebSocket

from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine.planner import Assignment
from platform_v8.engine.privacy_titles import title_for_workload
from platform_v8.protocol import ws_schema as wsp
from platform_v8.protocol.capability_profile import (
    CapabilityProfile,
    merge_observation,
    parse_profile,
)
from platform_v8.services.artifact_lease import mint_lease_token
from platform_v8.services.observability import record_lifecycle_event
from platform_v8.storage import db as db_mod
from platform_v8.storage.repo import ShardRepo, WorkloadRepo

logger = logging.getLogger(__name__)

def _resolve_shard_routing(workload, shard_meta, shard=None):
    """分片级 task_type / code_url / tier · 无 metadata 覆盖时与旧行为一致."""
    from platform_v8.engine.effective_task import resolve_code_sha256, resolve_dispatch_task
    class _S:
        pass
    sh = shard
    if sh is None:
        sh = _S()
        sh.metadata = shard_meta or {}
    tt, code_url, _tr_spec = resolve_dispatch_task(workload, sh)
    if _tr_spec is not None:
        from platform_v8.engine.task_registry import resolve_tier_routing
        _req_tier, _fb_tiers = resolve_tier_routing(_tr_spec)
        _executor = getattr(_tr_spec.executor, "value", str(_tr_spec.executor))
        _native_binary = _tr_spec.native_binary or ""
        _onnx_model = _tr_spec.onnx_model or ""
    else:
        _req_tier, _fb_tiers = "", ()
        _executor, _native_binary, _onnx_model = "", "", ""
    meta = shard_meta if isinstance(shard_meta, dict) else {}
    code_sha256 = resolve_code_sha256(tt, code_url, meta)
    return tt, code_url, code_sha256, _req_tier, _fb_tiers, _executor, _native_binary, _onnx_model, _tr_spec



# ── 全局 ws session 注册表 ──────────────────────────
_ws_sessions: dict[str, WebSocket] = {}    # worker_id → WebSocket


@dataclass(frozen=True)
class WorkerSessionMetadata:
    ws: WebSocket
    connection_id: str
    client_version: str = ""
    client_build: str = ""
    protocol_capabilities: tuple[str, ...] = ()
    protocol_mode: str = "legacy"
    capability_profile: str = CapabilityProfile.LEGACY_INLINE.value


_ws_session_metadata: dict[str, WorkerSessionMetadata] = {}
_ws_session_ready: dict[str, WebSocket] = {}  # post-registration auth gate passed
# 事件总线 ws session · owner_id（用户/管理员）→ WebSocket 集合
_event_sessions: dict[int, set[WebSocket]] = {}
_lock = asyncio.Lock()

# 2026-05-25 P1 修复 · asyncio.create_task GC 防护
# 之前: asyncio.create_task(_reclaim/watchdog/...) 未保留引用
#       → Python 官方警告 "task disappearing mid-execution"
#       → 事件循环短暂繁忙时弱引用被 GC · 故障转移/watchdog 静默丢失
# 现在: 全部进 _bg_tasks set · done_callback 自动 discard
_bg_tasks: set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    """安全 create_task · 保留强引用直到完成 · 防 GC"""
    t = asyncio.create_task(coro)
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)
    return t


# 2026-06-01 P0 修复 · 关闭 ws 必须带超时
# 根因: 经代理半死的 TCP (对端无 FIN) · ws.close() 的关闭握手会永久等待 (无超时)。
#   register_session 原来"持全局 _lock 时 await old.close()" → close 卡死则
#   _lock 永不释放 → 所有节点注册/心跳/广播全部冻结 (全员 last_seen 停在同一秒)。
# 修复: close 一律 wait_for 超时兜底 · 且永远在锁外/后台执行。
_WS_CLOSE_TIMEOUT_S = 5.0


async def _safe_close(ws: WebSocket, code: int = 1000, reason: str = "") -> None:
    """带超时关闭 ws · 半死连接最多卡 _WS_CLOSE_TIMEOUT_S · 绝不无限阻塞"""
    try:
        await asyncio.wait_for(ws.close(code=code, reason=reason),
                               timeout=_WS_CLOSE_TIMEOUT_S)
    except (asyncio.TimeoutError, Exception):
        # 超时/已断/任何异常都吞掉 · 这是尽力而为的清理
        pass


async def register_session(
    worker_id: str,
    ws: WebSocket,
    *,
    connection_id: str | None = None,
    client_version: str = "",
    client_build: str = "",
    protocol_capabilities: list[str] | tuple[str, ...] | None = None,
    protocol_mode: str = "legacy",
    capability_profile: str = CapabilityProfile.LEGACY_INLINE.value,
    recover: bool = True,
) -> None:
    """worker auth_ok 后调用 · 注册 ws session

    2026-06-01 P0 死锁修复:
      持 _lock 期间只做内存字典 pop/set (纯 CPU · 瞬时)。
      旧连接的 close() 是网络操作 · 可能在半死 TCP 上永久阻塞 ·
      必须挪到锁外 + 带超时 + 后台执行 · 否则一个卡死的 close 会
      永久占住全局锁 → 整个 worker WS 子系统冻结。
    """
    async with _lock:
        # 如果 worker 已经有旧 session (重连场景) · 先摘下来 (锁外再关)
        old = _ws_sessions.pop(worker_id, None)
        _ws_session_metadata.pop(worker_id, None)
        _ws_session_ready.pop(worker_id, None)
        _ws_sessions[worker_id] = ws
        if connection_id:
            _ws_session_metadata[worker_id] = WorkerSessionMetadata(
                ws=ws,
                connection_id=str(connection_id),
                client_version=str(client_version or "")[:40],
                client_build=str(client_build or "")[:128],
                protocol_capabilities=tuple(protocol_capabilities or ()),
                protocol_mode=str(protocol_mode or "legacy")[:24],
                capability_profile=parse_profile(capability_profile).value,
            )
    # 锁已释放 · 旧连接的关闭放后台 + 带超时 · 绝不阻塞本次注册
    if old is not None and old is not ws:
        _spawn(_safe_close(old, code=1000, reason="新连接接管"))
    # M2 · 多进程登记属主 (本进程持有该 worker 的 WS) · flag OFF 时短路不碰 Redis
    try:
        from platform_v8.engine import gateway
        if gateway.multi_enabled():
            gateway.set_owner(worker_id, connection_id=connection_id)
    except Exception as exc:
        logger.debug("broker.register · set_owner 失败 (静默): %s", exc)
    logger.info("broker.register_session · worker=%s · total online=%d",
                worker_id, len(_ws_sessions))

    if recover:
        await resume_session(worker_id, ws)


async def resume_session(worker_id: str, ws: WebSocket) -> None:
    """Run dispatch recovery only after the WS handler's second access check."""
    async with _lock:
        if _ws_sessions.get(worker_id) is not ws:
            return
        _ws_session_ready[worker_id] = ws
    # 2026-05-20 · 重连自动恢复：查是否有 ASSIGNED/RUNNING 的 shard，重新派发
    try:
        await _recover_pending_shards(worker_id, ws)
    except Exception as exc:
        logger.warning("broker.register_session · recover 异常 (静默): %s", exc)

    # 2026-05-20 · 节点上线后，触发所有 WAITING 任务的重新调度
    try:
        await _retry_waiting_workloads()
    except Exception as exc:
        logger.warning("broker.register_session · retry 异常 (静默): %s", exc)


async def unregister_session(worker_id: str, ws: WebSocket | None = None) -> bool:
    """ws 断开时调用 (ws 参数: 只删 == 自己注册的那个 · 防止"新连接接管"被误删)

    Disconnect only removes the exact socket generation and gateway owner.
    Immediate shard reset is disabled: a reconnect on another gateway can race
    the Redis identity check. Lease expiry and the lifecycle sweeper recover
    abandoned shards with unchanged-row CAS instead.
    """
    async with _lock:
        cur = _ws_sessions.get(worker_id)
        was_registered = cur is ws or ws is None
        metadata = _ws_session_metadata.get(worker_id) if was_registered else None
        if was_registered:
            _ws_sessions.pop(worker_id, None)
            _ws_session_metadata.pop(worker_id, None)
            _ws_session_ready.pop(worker_id, None)
    # M2 · 清属主 (only_if_mine: 别人已接管则不删) · flag OFF 时短路
    if was_registered:
        try:
            from platform_v8.engine import gateway
            if gateway.multi_enabled():
                gateway.clear_owner(
                    worker_id, only_if_mine=True,
                    connection_id=metadata.connection_id if metadata else None,
                )
        except Exception as exc:
            logger.debug("broker.unregister · clear_owner 失败 (静默): %s", exc)
    logger.info("broker.unregister_session · worker=%s · total online=%d",
                worker_id, len(_ws_sessions))
    # The cross-gateway connection generation is not stored on shard rows.
    # A reconnect can race a DB reset even after checking Redis identity, so
    # disconnect never performs immediate shard reclaim. The lifecycle sweeper
    # uses lease expiry and unchanged-row CAS to recover genuinely lost work.
    return was_registered


async def _reclaim_offline_worker_shards(
    worker_id: str, *, connection_id: str | None = None,
) -> None:
    """Legacy immediate reclaim helper, intentionally not called on disconnect.

    2026-05-24 · 不分单片/多片 · 全部秒级回收
      - 关键洞察: 多片任务一片挂 → 阻塞所有片聚合 → 多片反而最需要秒换
      - 防重复执行: mark_done 已加 CAS (expected_worker_id) · 老 worker 残留结果会被拒
      - 短暂断线只暂停该 worker 30 秒；真正执行失败由验收链记录重试排除
    """
    import asyncio
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import ShardRepo

    def _private_review_sample(s, shard) -> bool:
        """A registered zero-budget audit lease survives a transient WS drop.

        Only the fixed review runner can reclaim it through the review service
        after reconnect. Merely setting user-controlled shard metadata is not
        enough to bypass ordinary reclaim.
        """
        if (not isinstance(shard.metadata, dict)
                or shard.metadata.get("review_sample_only") is not True):
            return False
        from sqlalchemy import select
        from platform_v8.storage.repo import (
            WorkloadRepo, task_adapter_review_samples_t as samples_t,
        )
        workload = WorkloadRepo.by_id(s, shard.workload_id)
        if (workload is None
                or getattr(workload.status, "value", workload.status) != "QUARANTINED"
                or workload.budget != 0
                or not isinstance(workload.spec.params, dict)
                or workload.spec.params.get("review_sample_only") is not True):
            return False
        return s.execute(select(samples_t.c.shard_id).where(
            samples_t.c.shard_id == shard.id,
            samples_t.c.worker_id == worker_id,
            samples_t.c.status.in_(["leased", "upload_issued", "verified"]),
        )).first() is not None

    # 2026-09-17 · 连坐召回闸门: 仅当"本进程确实是该 worker 的属主"时才召回。
    # unregister_session 顺序 = _ws_sessions.pop → clear_owner(only_if_mine=True) → 本函数,
    # 故本进程是属主时 owner 已被清成 None(照旧召回 · 真掉线不受影响);
    # 属主是别的进程(同一 worker 行多会话) 时 owner 仍是别人 → 跳过,不连坐召回。
    # 拿不到 owner(Redis 挂/异常) → 照旧召回(fail-safe · 与历史行为逐字一致)。
    try:
        from platform_v8.engine import gateway
        _owner = gateway.get_owner(worker_id)
        if _owner and _owner != gateway.gateway_id():
            logger.info("broker.reclaim · worker=%s 仍由 %s 持有会话 · 跳过连坐召回",
                        worker_id[:8], _owner)
            return
    except Exception:
        pass

    def _scan_and_reset() -> set[str]:
        """返 涉及的 workload_id 集合 · 每个 workload 触发一次 redispatch"""
        affected_workloads: set[str] = set()
        with db_mod.session_scope() as s:
            active_shards = ShardRepo.by_worker_active(s, worker_id)
            for sh in active_shards:
                if _private_review_sample(s, sh):
                    # Review leases never enter the paid redispatch planner.
                    # Resetting only we_shards would strand the separate
                    # samples_t lease and invalidate its signed token.
                    logger.info("broker.reclaim · 保留独立审核样单 shard=%s worker=%s",
                                sh.id, worker_id[:8])
                    continue
                # A gateway restart can drop a healthy node. Prefer another
                # worker immediately, but let this one retry after reconnect.
                try:
                    ShardRepo.exclude_worker_for_retry(
                        s, sh.id, worker_id, ttl_seconds=30,
                    )
                except Exception as exc:
                    logger.warning("reclaim · exclude_worker_for_retry 失败: %s", exc)
                # reset 回 PENDING (load 计数同时回退)
                ok = ShardRepo.reset_pending(s, sh.id)
                if ok:
                    affected_workloads.add(str(sh.workload_id))
                    record_lifecycle_event(
                        "reclaim",
                        workload_id=sh.workload_id,
                        shard_id=sh.id,
                        worker_id=worker_id,
                        attempt=int(sh.attempts),
                        reason_code="OFFLINE_WORKER",
                        outcome="reclaimed",
                    )
                    logger.info(
                        "broker.reclaim · shard=%s workload=%s (total=%d) "
                        "from offline worker=%s → PENDING + 30s cooldown",
                        sh.id, sh.workload_id, sh.total, worker_id[:8],
                    )
            s.commit()
        return affected_workloads

    try:
        # Serialize same-process reconnect with the DB reset. A queued reclaim
        # from the replaced socket must never reset the new socket's shards.
        async with _lock:
            if _ws_sessions.get(worker_id) is not None:
                return
            if connection_id:
                from platform_v8.services.workers import native_h3_bindings as connections
                current = await asyncio.to_thread(
                    connections.current_connection_id, worker_id,
                )
                if current is not None and current != connection_id:
                    return
            affected = await asyncio.to_thread(_scan_and_reset)
        if not affected:
            return
        # 立即触发 redispatch · 多片任务的"卡死片"也能秒级转移
        from platform_v8.engine import lifecycle
        for wid in affected:
            try:
                await lifecycle.redispatch_pending(wid)
            except Exception as exc:
                logger.warning("broker.reclaim · redispatch workload=%s 失败: %s", wid, exc)
    except Exception as exc:
        logger.exception("broker._reclaim_offline_worker_shards · 异常: %s", exc)


def get_online_worker_ids() -> list[str]:
    """当前 ws 在线 worker 列表 (本进程本地)"""
    return [wid for wid, ws in _ws_sessions.items()
            if _ws_session_ready.get(wid) is ws]


def get_session_metadata(worker_id: str) -> WorkerSessionMetadata | None:
    """Return immutable server connection metadata for the active socket."""
    return _ws_session_metadata.get(worker_id)


def get_session_profile(worker_id: str) -> CapabilityProfile:
    metadata = get_session_metadata(worker_id)
    if metadata is None:
        return CapabilityProfile.UNSUPPORTED
    return parse_profile(metadata.capability_profile)


async def observe_session_profile(worker_id: str, observed: object) -> str:
    """Monotonically update the active connection after validated wire input."""
    async with _lock:
        metadata = _ws_session_metadata.get(str(worker_id))
        if metadata is None:
            return CapabilityProfile.UNSUPPORTED.value
        merged = merge_observation(metadata.capability_profile, observed)
        _ws_session_metadata[str(worker_id)] = replace(
            metadata,
            capability_profile=merged.value,
        )
        return merged.value


def online_worker_ids_for_dispatch() -> list[str]:
    """
    派发候选用的在线集:
      - 单进程 / gw_multi OFF → 本地 _ws_sessions (与历史一致)
      - 多进程 / gw_multi ON  → Redis ZSET 全局在线集 (M1 建 · 跨进程可见)
                                 拿不到则降级回本地 (fail-safe)
      - V8_DISPATCH_EXCLUDE_WORKERS=id1,id2 可临时踢出不更新的节点
    """
    try:
        from platform_v8.engine import gateway
        if gateway.multi_enabled():
            ids = gateway.online_worker_ids_global()
            if ids is not None:
                return _filter_excluded_workers(ids)
    except Exception as exc:
        logger.debug("broker.online_for_dispatch · 全局集失败 · 降级本地: %s", exc)
    return _filter_excluded_workers(list(_ws_sessions.keys()))


def _filter_excluded_workers(ids: list[str]) -> list[str]:
    import os
    raw = (os.environ.get("V8_DISPATCH_EXCLUDE_WORKERS") or "").strip()
    if not raw:
        return ids
    excluded = {x.strip() for x in raw.split(",") if x.strip()}
    if not excluded:
        return ids
    return [w for w in ids if w not in excluded]


async def kick_worker(worker_id: str, *, reason: str = "kicked") -> bool:
    """主动断开某 worker 的 WS · 使其离开派发池 (本地联调踢坏节点用)."""
    ws = _ws_sessions.get(worker_id)
    if ws is None:
        return False
    await unregister_session(worker_id, ws)
    await _safe_close(ws, code=1000, reason=reason[:120])
    return True


def _assignment_rows_from_server_frame(
    frame_json: str,
    *,
    source: str,
) -> list[dict[str, object]]:
    """Extract only server-built assignment identities from an outbound frame."""
    try:
        frame = json.loads(frame_json)
    except (TypeError, ValueError):
        return []
    frame_type = frame.get("type") if isinstance(frame, dict) else None
    payload = frame.get("payload") if isinstance(frame, dict) else None
    if frame_type == "shard_assign" and isinstance(payload, dict):
        payloads = [payload]
    elif frame_type == "pull_assign" and isinstance(payload, dict):
        payloads = payload.get("shards")
        if not isinstance(payloads, list):
            return []
    else:
        return []
    mode = {
        "dispatch": "push",
        "pull": "pull",
        "race": "race",
        "recover": "recovery",
        "reconnect": "recovery",
    }.get(source, str(source or "unknown").lower()[:24])
    rows: list[dict[str, object]] = []
    for item in payloads:
        if not isinstance(item, dict):
            continue
        shard_id = item.get("shard_id")
        workload_id = item.get("workload_id")
        attempt = item.get("attempt")
        if (
            not isinstance(shard_id, str)
            or not shard_id
            or not isinstance(workload_id, str)
            or not workload_id
            or isinstance(attempt, bool)
            or not isinstance(attempt, int)
            or attempt < 0
        ):
            continue
        rows.append({
            "shard_id": shard_id,
            "workload_id": workload_id,
            "attempt": attempt,
            "mode": mode,
            "assignment_manifest": {
                "task_type": str(item.get("task_type") or ""),
                "input_kind": str(item.get("input_kind") or ""),
                "input_manifest": dict(item.get("input_manifest") or {}),
                "input_refs_count": len(item.get("input_refs") or []),
                "executor": str(item.get("executor") or ""),
                "code_url_present": bool(item.get("code_url")),
            },
        })
    return rows


async def _record_assignment_deliveries_after_send(
    worker_id: str,
    session_meta: WorkerSessionMetadata | None,
    frame_json: str,
    *,
    source: str,
) -> None:
    """Persist only after send_text succeeds; missing connection context fails closed."""
    if session_meta is None or session_meta.ws is None:
        return
    rows = _assignment_rows_from_server_frame(frame_json, source=source)
    if not rows:
        return

    def _persist() -> None:
        from platform_v8.storage.repo import AssignmentDeliveryRepo
        with db_mod.session_scope() as s:
            for row in rows:
                AssignmentDeliveryRepo.record_after_send(
                    s,
                    shard_id=str(row["shard_id"]),
                    workload_id=str(row["workload_id"]),
                    worker_id=str(worker_id),
                    attempt=int(row["attempt"]),
                    connection_id=session_meta.connection_id,
                    mode=str(row["mode"]),
                    client_version=session_meta.client_version,
                    client_build=session_meta.client_build,
                    protocol_capabilities=session_meta.protocol_capabilities,
                    assignment_manifest={
                        **dict(row.get("assignment_manifest") or {}),
                        "capability_profile": session_meta.capability_profile,
                    },
                )
            s.commit()

    try:
        await asyncio.to_thread(_persist)
    except Exception as exc:
        logger.warning(
            "broker.delivery_evidence · persist failed worker=%s connection=%s: %s",
            worker_id,
            session_meta.connection_id,
            exc,
        )


async def _socket_generation_current(
    worker_id: str, ws: WebSocket, metadata: WorkerSessionMetadata | None,
) -> bool:
    """Refuse outbound work to a socket superseded on another gateway."""
    from platform_v8.engine import gateway
    if not gateway.multi_enabled():
        return True
    if metadata is None or metadata.ws is not ws:
        return False
    from platform_v8.services.workers import native_h3_bindings as connections
    current = await asyncio.to_thread(connections.current_connection_id, worker_id)
    return current == metadata.connection_id


async def _local_send(
    worker_id: str,
    frame_json: str,
    idem_key: str | None = None,
    source: str = "dispatch",
) -> bool:
    """只发本进程本地持有的 WS (gateway 订阅器收到跨进程帧时调) · 无本地 ws 返 False。
       idem_key(shard_id) 给定时 · 发送成功后打送达确认 · 供 confirm-reaper 区分丢帧。"""
    ws = _ws_sessions.get(worker_id)
    if ws is None:
        return False
    if _ws_session_ready.get(worker_id) is not ws:
        return False
    session_meta = _ws_session_metadata.get(worker_id)
    if session_meta is not None and session_meta.ws is not ws:
        session_meta = None
    if not await _socket_generation_current(worker_id, ws, session_meta):
        await unregister_session(worker_id, ws)
        return False
    try:
        await ws.send_text(frame_json)
        await _record_assignment_deliveries_after_send(
            worker_id, session_meta, frame_json, source=source,
        )
        if idem_key:
            _confirm_delivery_safe(idem_key)  # 跨进程已写入节点 socket · 标送达确认
        return True
    except Exception as exc:
        logger.warning("broker._local_send · worker=%s 发送失败: %s", worker_id, exc)
        await unregister_session(worker_id, ws)
        return False


async def _local_broadcast(frame_json: str) -> int:
    """把一帧发给本进程所有本地 worker (gateway 广播扇出时调)"""
    async with _lock:
        worker_ids = list(_ws_sessions.keys())
    sent = 0
    for wid in worker_ids:
        ws = _ws_sessions.get(wid)
        if ws is None or _ws_session_ready.get(wid) is not ws:
            continue
        try:
            await ws.send_text(frame_json)
            sent += 1
        except Exception:
            pass
    return sent


def is_worker_online(worker_id: str) -> bool:
    return worker_id in _ws_sessions


# ── 事件总线 · 企业/管理员 ws 注册 ─────────────────
async def register_event_listener(owner_id: int, ws: WebSocket) -> None:
    """企业端/管理端 ws 连接后注册"""
    async with _lock:
        if owner_id not in _event_sessions:
            _event_sessions[owner_id] = set()
        _event_sessions[owner_id].add(ws)
    logger.info("broker.event_listener.register · owner=%s · total=%d",
                owner_id, sum(len(s) for s in _event_sessions.values()))


async def unregister_event_listener(owner_id: int, ws: WebSocket) -> None:
    """ws 断开时注销"""
    async with _lock:
        s = _event_sessions.get(owner_id)
        if s:
            s.discard(ws)
            if not s:
                del _event_sessions[owner_id]
    logger.info("broker.event_listener.unregister · owner=%s · total=%d",
                owner_id, sum(len(s) for s in _event_sessions.values()))


async def broadcast_to_all_workers(frame_type: str, payload: dict) -> int:
    """
    2026-05-23 · 广播一帧给所有在线 worker (v8 ws 通道)

    用途：运营位变更 / 全局公告等需要立即同步到所有客户端的场景。
    返回成功推送的连接数。失败的连接静默忽略（不抛异常）。
    """
    import json as _json
    frame = _json.dumps({"type": frame_type, "payload": payload}, ensure_ascii=False)
    # M2 · 多进程 → 发布到广播频道 · 各网关(含本进程)订阅器收到后本地分发 (避免只覆盖本进程)
    try:
        from platform_v8.engine import gateway
        if gateway.multi_enabled():
            await gateway.publish_broadcast(frame)
            return len(_ws_sessions)  # 返回本地连接数作估计 (广播非关键路径)
    except Exception as exc:
        logger.debug("broker.broadcast · 跨网关扇出失败 · 降级本地: %s", exc)
    sent = 0
    # 拷贝 worker_id 列表 · 避免遍历时 dict 变化
    async with _lock:
        worker_ids = list(_ws_sessions.keys())
    for wid in worker_ids:
        ws = _ws_sessions.get(wid)
        if ws is None or _ws_session_ready.get(wid) is not ws:
            continue
        try:
            await ws.send_text(frame)
            sent += 1
        except Exception:
            # 连接已断 · 由 unregister_session 清理 · 这里静默
            pass
    return sent


async def broadcast_to_owner(owner_id: int, event_type: str, data: dict) -> None:
    """推事件给指定 owner 的所有 ws 连接 + 所有管理员"""
    targets: set[WebSocket] = set()
    async with _lock:
        # owner 本人的连接
        if owner_id in _event_sessions:
            targets.update(_event_sessions[owner_id])
        # 管理员连接（owner_id=1 通常是 admin）
        if 1 in _event_sessions:
            targets.update(_event_sessions[1])
    if not targets:
        return
    payload = json.dumps({"type": event_type, "data": data}, ensure_ascii=False)
    # 2026-05-25 P2 修复 · 失败 ws 从注册表清理 (防泄漏 + 防下次再发又异常)
    dead_ws: list = []
    for ws in targets:
        try:
            await ws.send_text(payload)
        except Exception as exc:
            logger.debug("broker.broadcast · send_text 失败 (将清理): %s", exc)
            dead_ws.append(ws)
    if dead_ws:
        async with _lock:
            for s in _event_sessions.values():
                for w in dead_ws:
                    s.discard(w)


# ── push_to_worker · 通用发送 ───────────────────────
async def push_to_worker(worker_id: str, frame_json: str,
                         *, shard_id: str | None = None,
                         source: str = "dispatch") -> bool:
    """给 worker 推一帧 · 返 True=成功 · False=worker 不在线 / 发送失败

    2026-06-02 M2 · 本地无此 worker 的 WS 时:
      gw_multi ON → 查属主网关 · 跨进程 PUBLISH 投递 (route_push)
      gw_multi OFF → 维持原"不在线丢帧"语义 (单进程零回归)
    Phase0 · shard_id/source 仅用于投递埋点(重复投递探测) · 不影响投递行为。
    """
    ws = _ws_sessions.get(worker_id)
    if ws is not None:
        if _ws_session_ready.get(worker_id) is not ws:
            return False
        session_meta = _ws_session_metadata.get(worker_id)
        if session_meta is not None and session_meta.ws is not ws:
            session_meta = None
        if not await _socket_generation_current(worker_id, ws, session_meta):
            await unregister_session(worker_id, ws)
            ws = None
    if ws is not None:
        try:
            await ws.send_text(frame_json)
            await _record_assignment_deliveries_after_send(
                worker_id, session_meta, frame_json, source=source,
            )
            _track_delivery_safe(shard_id, worker_id, path="local", source=source)
            _confirm_delivery_safe(shard_id)  # 本地已写入节点 socket · 标送达确认
            return True
        except Exception as exc:
            logger.warning("broker.push · worker=%s 发送失败: %s", worker_id, exc)
            await unregister_session(worker_id, ws)
            return False
    # 本地无该 worker 的 WS · 尝试跨网关定向投递
    try:
        from platform_v8.engine import gateway
        if gateway.multi_enabled():
            if await gateway.route_push(
                worker_id, frame_json, idem_key=shard_id, source=source,
            ):
                _track_delivery_safe(shard_id, worker_id, path="route_push", source=source)
                return True
            # v8.1.10 · 定向(owner)投递失败 → 广播兜底:谁真持有该 worker WS 谁发
            # 修 owner 登记滞后/错位(重连/多进程) 导致的 shard 卡 PENDING 丢帧
            if await gateway.route_push_broadcast(
                worker_id, frame_json, idem_key=shard_id, source=source,
            ):
                _track_delivery_safe(shard_id, worker_id, path="route_broadcast", source=source)
                return True
            logger.warning("broker.push · worker=%s 跨网关(定向+广播)均未投递 · 丢帧", worker_id)
            return False
    except Exception as exc:
        logger.debug("broker.push · 跨网关路由异常: %s", exc)
    logger.warning("broker.push · worker=%s 不在线 · 丢帧", worker_id)
    return False


def _track_delivery_safe(shard_id: str | None, worker_id: str, *, path: str, source: str) -> None:
    """投递埋点 (Phase0) · 静默 · 绝不影响主路径"""
    try:
        from platform_v8.engine import gateway
        gateway.track_delivery(shard_id, worker_id, path=path, source=source)
    except Exception:
        pass


def _confirm_delivery_safe(shard_id: str | None) -> None:
    """送达确认 (M2横扩) · 帧已写入节点 socket · 静默 · 绝不影响主路径"""
    try:
        from platform_v8.engine import delivery as _delivery
        _delivery.mark_confirmed(shard_id)
    except Exception:
        pass


# ── dispatch_assignments · 链路 5 核心 ──────────────
async def dispatch_assignments(
    workload: Workload,
    shards: list[Shard],
    assignments: list[Assignment],
) -> dict[str, int]:
    """
    给每个 assignment 推 shard_assign 帧

    返回: {"dispatched": N, "failed": M}
    失败的 shard 已被 reset_pending · 让 lifecycle 重派
    """
    if not assignments:
        return {"dispatched": 0, "failed": 0}

    # shard_id → Shard 索引
    shard_by_id = {sh.id: sh for sh in shards}

    # Quote against the original logical total, never the current retry batch.
    per_shard_reward = float(workload.budget) / max(len(shards), 1)

    # 2026-05-21 · 取发布人信息 (UI 展示用)
    # 一次性查 1 次 Account · 同一 workload 复用 · 避免 N+1
    requester_name = ""
    requester_avatar = ""
    try:
        def _fetch_owner():
            from platform_v8.storage.repo import AccountRepo
            with db_mod.session_scope() as s:
                acc = AccountRepo.by_id(s, workload.owner_id)
                if acc:
                    av = ""
                    if isinstance(acc.profile, dict):
                        av = str(acc.profile.get("avatar") or acc.profile.get("avatar_url") or "")
                    return acc.username or "", av
                return "", ""
        requester_name, requester_avatar = await asyncio.to_thread(_fetch_owner)
    except Exception as e:
        logger.warning("broker.dispatch · 查 owner=%s 失败: %s", workload.owner_id, e)

    # workload.created_at → ms
    created_ms = 0
    try:
        if workload.created_at:
            created_ms = int(workload.created_at.timestamp() * 1000)
    except Exception:
        pass

    dispatched = 0
    failed = 0
    for asn in assignments:
        dispatch_started = time.perf_counter()
        sh = shard_by_id.get(asn.shard_id)
        if sh is None:
            logger.warning("broker.dispatch · shard %s 不存在", asn.shard_id)
            continue

        # 1. DB 标记 assign (CAS · 只有 status=PENDING 才能 assign)
        def _assign():
            with db_mod.session_scope() as s:
                attempt = ShardRepo.assign_to_worker(
                    s, asn.shard_id, asn.worker_id, score=asn.score)
                s.commit()
                return attempt
        assigned_attempt = await asyncio.to_thread(_assign)
        if assigned_attempt is None:
            logger.warning("broker.dispatch · shard %s assign 失败 (可能已被别人抢)", asn.shard_id)
            record_lifecycle_event(
                "dispatch",
                workload_id=workload.id,
                shard_id=asn.shard_id,
                worker_id=asn.worker_id,
                reason_code="ASSIGNMENT_CAS_MISS",
                latency_ms=(time.perf_counter() - dispatch_started) * 1000,
                outcome="failed",
            )
            failed += 1
            continue

        # 1.5 input_ref 预校验 (2026-05-24 · 旁路 · 仅 4xx 才拦截 · 网络错/超时不影响主路径)
        # 防止 worker 拿到死链 / 过期 OSS URL 浪费时间
        shard_meta_for_check = sh.metadata or {}
        if await _precheck_input_refs(
            sh,
            shard_meta_for_check,
            str(workload.id),
            owner_id=int(workload.owner_id),
            input_kind=str(workload.spec.input_kind or ""),
        ):
            record_lifecycle_event(
                "dispatch",
                workload_id=workload.id,
                shard_id=sh.id,
                worker_id=asn.worker_id,
                attempt=int(assigned_attempt),
                reason_code="INPUT_PRECHECK_FAILED",
                latency_ms=(time.perf_counter() - dispatch_started) * 1000,
                outcome="failed",
            )
            failed += 1
            continue

        # 2. 构造 shard_assign 帧 (UUID 强转 str · ShardAssignPayload 字段是 str)
        # 2026-05-18 · slicer 把 input_refs / slice_meta / input_kind 塞进 sh.metadata
        # 这里从 metadata 提出来塞给 ws frame · 节点端能拿到完整切片描述
        try:
            from platform_v8.engine.assignment_payload import build_assignment_payload
            payload = build_assignment_payload(
                sh,
                workload,
                worker_id=str(asn.worker_id),
                capability_profile=(
                    get_session_metadata(str(asn.worker_id)).capability_profile
                    if get_session_metadata(str(asn.worker_id)) is not None
                    else None
                ),
                attempt=int(assigned_attempt),
                reward=per_shard_reward,
                requester_name=requester_name,
                requester_avatar=requester_avatar,
                created_at_ms=created_ms,
                input_expires=_OSS_REFRESH_EXPIRES,
            )
            frame = wsp.ShardAssign(payload=payload).model_dump_json()
            _timeout_s = payload.timeout_s
        except Exception as exc:
            logger.warning(
                "broker.dispatch · payload materialization failed shard=%s: %s · %s",
                str(sh.id)[:8], type(exc).__name__, str(exc)[:2000],
            )
            def _reset_materialize():
                with db_mod.session_scope() as s:
                    ShardRepo.reset_pending(s, asn.shard_id)
                    s.commit()
            await asyncio.to_thread(_reset_materialize)
            failed += 1
            continue

        # 3. 推给 worker · 走 L2 投递 Port (幂等键=shard_id · 防重复砸同节点)
        from platform_v8.engine import delivery as _delivery
        pushed = await _delivery.deliver(str(asn.worker_id), frame,
                                         idem_key=str(sh.id), source="dispatch")
        if pushed:
            dispatched += 1
            record_lifecycle_event(
                "dispatch",
                workload_id=workload.id,
                shard_id=sh.id,
                worker_id=asn.worker_id,
                attempt=int(assigned_attempt),
                latency_ms=(time.perf_counter() - dispatch_started) * 1000,
                outcome="sent",
                extra={"mode": "push"},
            )
            logger.info("broker.dispatch · shard=%s → worker=%s reward=%.4f",
                        sh.id, asn.worker_id, per_shard_reward)
            # 2026-05-24 · 启动 watchdog · 按分片有效超时 + 缓冲
            # （OCR 按页超时，避免 workload.timeout_s=3600 导致尾片干等九百秒）
            watchdog_timeout = max(90, int(_timeout_s) + 45)
            _spawn(_watchdog_shard_timeout(
                str(asn.shard_id), str(asn.worker_id), watchdog_timeout
            ))
        else:
            # 推送失败 · 重置回 PENDING (让 lifecycle 重派给别的 worker)
            def _reset():
                with db_mod.session_scope() as s:
                    ShardRepo.reset_pending(s, asn.shard_id)
                    s.commit()
            await asyncio.to_thread(_reset)
            record_lifecycle_event(
                "dispatch",
                workload_id=workload.id,
                shard_id=sh.id,
                worker_id=asn.worker_id,
                attempt=int(assigned_attempt),
                reason_code="DELIVERY_FAILED",
                latency_ms=(time.perf_counter() - dispatch_started) * 1000,
                outcome="failed",
                extra={"mode": "push"},
            )
            failed += 1

    return {"dispatched": dispatched, "failed": failed}


async def dispatch_race_assign(
    workload: Workload,
    shard: Shard,
    racer_worker_id: str,
) -> bool:
    """竞速派发: 同一 shard 再推给空闲节点 · 不改 DB status/owner (join_race 已写 metadata)。

    失败不 reset 原片 · 仅返回 False。幂等键带 worker · 避免挡住原节点投递位。
    """
    if shard is None or not racer_worker_id:
        return False

    per_shard_reward = float(workload.budget) / max(int(shard.total or 1), 1)
    requester_name = ""
    requester_avatar = ""
    try:
        def _fetch_owner():
            from platform_v8.storage.repo import AccountRepo
            with db_mod.session_scope() as s:
                acc = AccountRepo.by_id(s, workload.owner_id)
                if acc:
                    av = ""
                    if isinstance(acc.profile, dict):
                        av = str(acc.profile.get("avatar") or acc.profile.get("avatar_url") or "")
                    return acc.username or "", av
                return "", ""
        requester_name, requester_avatar = await asyncio.to_thread(_fetch_owner)
    except Exception:
        pass

    created_ms = 0
    try:
        if workload.created_at:
            created_ms = int(workload.created_at.timestamp() * 1000)
    except Exception:
        pass

    try:
        from platform_v8.engine.assignment_payload import build_assignment_payload
        payload = build_assignment_payload(
            shard,
            workload,
            worker_id=str(racer_worker_id),
            capability_profile=(
                get_session_metadata(str(racer_worker_id)).capability_profile
                if get_session_metadata(str(racer_worker_id)) is not None
                else None
            ),
            reward=per_shard_reward,
            requester_name=requester_name,
            requester_avatar=requester_avatar,
            created_at_ms=created_ms,
            input_expires=_OSS_REFRESH_EXPIRES,
        )
        frame = wsp.ShardAssign(payload=payload).model_dump_json()
    except Exception as exc:
        logger.warning(
            "broker.race · payload materialization failed shard=%s: %s",
            str(shard.id)[:8], type(exc).__name__,
        )
        return False

    from platform_v8.engine import delivery as _delivery
    idem = f"{shard.id}:race:{racer_worker_id}"
    pushed = await _delivery.deliver(
        str(racer_worker_id), frame, idem_key=idem, source="race"
    )
    if pushed:
        logger.info(
            "broker.race · shard=%s → racer=%s (owner=%s)",
            shard.id, str(racer_worker_id)[:8],
            str(shard.worker_id or "")[:8],
        )
    return bool(pushed)


async def _watchdog_shard_timeout(shard_id: str, worker_id: str, timeout_s: int) -> None:
    """派发后启动的 watchdog · 超时仍未完成 → 主动 mark failed + 触发重派

    2026-05-24 · 防节点"ws 未断 + 任务静默卡死"场景 (sweep 兜底)
    timeout_s = workload.spec.timeout_s + 30 (节点本身有 timeout · 给 30s 网络余量)
    """
    import asyncio
    await asyncio.sleep(timeout_s)

    def _check() -> tuple | None:
        from platform_v8.core import ShardStatus
        with db_mod.session_scope() as s:
            sh = ShardRepo.by_id(s, shard_id)
            if sh is None:
                return None
            # 已完成 / 已 fail / 已重派给别人 · 不动
            if sh.status not in (ShardStatus.DISPATCHED, ShardStatus.RUNNING):
                return None
            # 竞速中: 原 owner 超时不整片判死 · 交给 race 同伴继续
            if str(sh.worker_id) != worker_id:
                return None
            if len(ShardRepo.race_workers_of(sh)) > 1:
                return ("race_active", sh.workload_id, worker_id)
            return (sh.workload_id, sh.attempts, sh.max_attempts)

    try:
        result = await asyncio.to_thread(_check)
        if result is None:
            return
        if result[0] == "race_active":
            # 仅取消超时的原节点 · 竞速同伴继续
            try:
                await cancel_shard(shard_id, worker_id, reason="watchdog_timeout_race")

                def _drop():
                    from sqlalchemy import update as _upd
                    from platform_v8.storage.repo import shards_t as _st
                    with db_mod.session_scope() as s:
                        sh = ShardRepo.by_id(s, shard_id)
                        if sh is None:
                            return
                        peers = [
                            x for x in ShardRepo.race_workers_of(sh)
                            if x != str(worker_id)
                        ]
                        ShardRepo.drop_race_worker(s, shard_id, worker_id)
                        if peers and str(sh.worker_id) == str(worker_id):
                            s.execute(
                                _upd(_st)
                                .where(_st.c.id == shard_id)
                                .values(worker_id=peers[0])
                            )
                        s.commit()

                await asyncio.to_thread(_drop)
            except Exception as exc:
                logger.debug("broker.watchdog race timeout handle: %s", exc)
            return
        workload_id, attempts, max_attempts = result
        logger.warning(
            "broker.watchdog · shard=%s 超时 %ds (worker=%s attempts=%d/%d) · 主动失败",
            shard_id, timeout_s, worker_id, attempts, max_attempts,
        )
        # 延迟 import 避免循环依赖
        from platform_v8.engine import aggregator
        await aggregator.on_shard_failed(
            shard_id, error=f"watchdog timeout {timeout_s}s (worker {worker_id[:8]})",
        )
    except Exception as exc:
        logger.exception("broker.watchdog · shard=%s 异常: %s", shard_id, exc)


# ── dispatch 预校验辅助 (2026-05-24) ──────────────────────
# 完全旁路:
#   - 网络错/超时/连接失败 → 跳过校验 · 仍然派单 (让 worker 自己重试)
#   - 仅 HTTP 4xx (403/404/410) 才 mark FAILED 不派单 · 避免 worker 浪费时间
#   - 用 GET + Range bytes=0-0 (而非 HEAD) · 兼容 OSS V1 presigned GET 签名
# 2026-05-26 · 加 OSS URL 自动续签 · 灭 60% image_resize 失败 (URL Expires 过期)
_PRECHECK_TIMEOUT_S = 3.0
_PRECHECK_FAIL_CODES = {403, 404, 410}
_OSS_REFRESH_MIN_REMAIN_SEC = 300  # URL 剩余 < 5 分钟就重签
_OSS_REFRESH_EXPIRES = 3600  # 重签后有效 1 小时


def _parse_oss_url(url: str) -> tuple[str, int] | None:
    """从预签名 URL 解出 (object_key, expires_unix_ts)。

    支持：
      - 阿里云 OSS V1：…aliyuncs.com/…?OSSAccessKeyId=&Expires=
      - MinIO / S3 SigV4：…/bucket/key?X-Amz-Algorithm=&X-Amz-Expires=&X-Amz-Date=
    非预签名 https（如旧 blob API）返回 None（不续签）。
    """
    try:
        from urllib.parse import urlparse, parse_qs, unquote
        from datetime import datetime, timezone

        p = urlparse(url)
        qs = parse_qs(p.query)
        expires_ts: int | None = None
        full_key = unquote(p.path.lstrip("/"))

        if "Expires" in qs and "OSSAccessKeyId" in qs:
            # 阿里云 V1
            if "aliyuncs.com" not in p.netloc and "oss." not in p.netloc:
                # 仍允许历史 URL；新链路以 SigV4 为主
                pass
            expires_ts = int(qs["Expires"][0])
        elif "X-Amz-Expires" in qs and "X-Amz-Date" in qs:
            # AWS SigV4 / MinIO
            amz_date = (qs.get("X-Amz-Date") or [""])[0]
            expires_in = int((qs.get("X-Amz-Expires") or ["0"])[0])
            # 形如 20260804T213000Z
            dt = datetime.strptime(amz_date, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            expires_ts = int(dt.timestamp()) + expires_in
            # path-style：/{bucket}/{key}
            try:
                from platform_v8.services.oss_provider import get_oss_provider
                bucket = (getattr(get_oss_provider(), "bucket", "") or "").strip("/")
                if bucket and full_key.startswith(bucket + "/"):
                    full_key = full_key[len(bucket) + 1 :]
            except Exception:
                pass
        else:
            return None

        if expires_ts is None:
            return None

        try:
            from platform_v8.services.oss_provider import get_oss_provider
            provider = get_oss_provider()
            prefix = (getattr(provider, "prefix", "") or "").strip("/")
            # Aliyun provider 可能有 prefix 属性在 config
            if not prefix:
                prefix = (getattr(getattr(provider, "config", None), "prefix", "") or "").strip("/")
            if prefix and full_key.startswith(prefix + "/"):
                key_without_prefix = full_key[len(prefix) + 1:]
            else:
                key_without_prefix = full_key
        except Exception:
            key_without_prefix = full_key
        return (key_without_prefix, expires_ts)
    except Exception as e:
        from platform_v8.services.url_safety import redact_url
        logger.debug("broker.url_parse · 解析失败: %s · url=%s", e, redact_url(url))
        return None


def _refresh_oss_url(url: str) -> str:
    """如果 URL 是 OSS signed URL 且 Expires 剩余 < 5 分钟 · 自动重签返回新 URL · 否则原样返回"""
    parsed = _parse_oss_url(url)
    if not parsed:
        return url
    object_key, expires_ts = parsed
    remain = expires_ts - int(time.time())
    if remain > _OSS_REFRESH_MIN_REMAIN_SEC:
        return url  # 还有充足时间 · 不重签
    try:
        from platform_v8.services.oss_provider import get_oss_provider
        provider = get_oss_provider()
        presigned = provider.presign_get(object_key, expires=_OSS_REFRESH_EXPIRES)
        new_url = presigned.url if hasattr(presigned, "url") else str(presigned)
        logger.info("broker.url_refresh · key=%s 续签 (原 remain=%ds → 新 %ds)",
                    object_key, remain, _OSS_REFRESH_EXPIRES)
        return new_url
    except Exception as e:
        logger.warning("broker.url_refresh · key=%s 续签失败 (旁路): %s", object_key, e)
        return url  # 失败不阻塞 · 让原 precheck 决定


def _dispatch_input_url(ref: object) -> str:
    """Compatibility wrapper; assignment_payload is authoritative."""
    value = str(ref or "").strip()
    if not value:
        return ""
    if value.startswith(("v8/account-", "uploads/tenant_")):
        import re
        match = re.match(r"^(?:v8/account-|uploads/tenant_)(\d+)/", value)
        if match is None:
            raise ValueError("invalid tenant object key")
        from platform_v8.services.storage_refs import materialize_get_url
        return materialize_get_url(
            int(match.group(1)), value, _OSS_REFRESH_EXPIRES,
        )
    if value.startswith(("http://", "https://")):
        return _refresh_oss_url(value)
    return value


def _head_check(url: str, timeout: float = _PRECHECK_TIMEOUT_S) -> int | None:
    """
    模拟 HEAD: GET + Range bytes=0-0 只取首字节 · 兼容 OSS V1 presigned GET URL
    返回 HTTP code · 异常返 None (调用方视为不可判断 · 不阻塞)
    """
    try:
        from platform_v8.services.url_safety import URLPolicy, safe_open
        policy = URLPolicy(
            max_redirects=3,
            max_response_bytes=1,
            timeout=timeout,
        )
        with safe_open(
            url,
            method="GET",
            headers={"Range": "bytes=0-0", "User-Agent": "edge-compute-precheck/1.0"},
            policy=policy,
        ) as resp:
            return resp.status  # 200 / 206
    except Exception:
        return None  # DNS / 网络 / 超时 / SSL · 不阻塞


async def _precheck_input_refs(
    sh: Shard,
    shard_meta: dict,
    workload_id: str,
    *,
    owner_id: int,
    input_kind: str = "",
) -> bool:
    """
    校验 shard 的 input_ref / input_refs 是否可达
    返回 True 表示已 mark FAILED · 调用方应跳过派单
    返回 False 表示可继续派单 (含校验跳过)
    
    2026-05-26 · 加 OSS URL 自动续签 · URL 剩余 < 5min 自动重生 1h 新签名 · 写回 shard
    """
    refs = [sh.input_ref, *(shard_meta.get("input_refs") or [])]
    from platform_v8.services.workloads.submit import input_ref_allowed
    input_kind = str(shard_meta.get("input_kind") or input_kind or "")
    for ref in refs:
        allowed = input_ref_allowed(str(ref), owner_id=owner_id)
        if ref and input_kind == "stream":
            try:
                from platform_v8.services.url_safety import validate_url
                validate_url(str(ref))
                allowed = True
            except Exception:
                allowed = False
        if ref and not allowed:
            logger.warning(
                "broker.precheck · blocked unsafe input ref shard=%s",
                str(sh.id)[:8],
            )
            def _mark_unsafe():
                with db_mod.session_scope() as s:
                    ShardRepo.mark_failed(
                        s,
                        str(sh.id),
                        error="dispatch_input_policy:unsafe_or_foreign_reference",
                    )
                    s.commit()
            await asyncio.to_thread(_mark_unsafe)
            return True

    # ── 第 1 步 · 为本次校验生成短期 URL ──
    # Canonical object key must stay in the workload/shard record: persisting
    # signed URLs leaks credentials into storage and causes expiry on retries.
    from platform_v8.services.storage_refs import materialize_get_url
    try:
        checked_input_ref = (
            str(sh.input_ref)
            if input_kind == "stream"
            else await asyncio.to_thread(
                    materialize_get_url, owner_id, sh.input_ref, _OSS_REFRESH_EXPIRES,
                )
            if sh.input_ref else ""
        )
        checked_input_refs = [
            str(ref)
            if input_kind == "stream"
            else await asyncio.to_thread(
                    materialize_get_url, owner_id, ref, _OSS_REFRESH_EXPIRES,
                )
            for ref in (shard_meta.get("input_refs") or [])
        ]
    except Exception:
        logger.warning(
            "broker.precheck · input signing failed shard=%s",
            str(sh.id)[:8],
        )
        def _reset_signing_failure():
            with db_mod.session_scope() as s:
                ShardRepo.reset_pending(s, str(sh.id))
                s.commit()
        await asyncio.to_thread(_reset_signing_failure)
        return True

    # ── 第 2 步 · HEAD 校验 (跟之前一样) ──
    urls: list[str] = []
    if checked_input_ref.startswith(("http://", "https://")):
        urls.append(checked_input_ref)
    for u in checked_input_refs:
        if isinstance(u, str) and u.startswith(("http://", "https://")):
            urls.append(u)
    if not urls:
        return False  # 没 URL 可校验 (inline_input / 本地脚本) · 跳过

    for url in urls:
        code = await asyncio.to_thread(_head_check, url)
        if code in _PRECHECK_FAIL_CODES:
            err = f"dispatch 预校验失败: HTTP {code}"
            def _mark_fail():
                with db_mod.session_scope() as s:
                    ShardRepo.mark_failed(s, str(sh.id), error=err)
                    s.commit()
            try:
                await asyncio.to_thread(_mark_fail)
            except Exception as exc:
                logger.warning("broker.precheck · mark_failed 异常 · 旁路 · %s", exc)
                return False
            from platform_v8.services.url_safety import redact_url
            logger.warning(
                "broker.precheck · shard=%s HTTP %s · url=%s · 跳过派单",
                sh.id, code, redact_url(url),
            )
            # 触发 workload finalize 检查 (lazy import 避免循环)
            try:
                from platform_v8.engine import aggregator as _agg
                await _agg._maybe_finalize_workload(workload_id)
            except Exception as exc:
                logger.debug("broker.precheck · finalize 跳过: %s", exc)
            return True
    return False


# ── cancel_shard · workload 取消时 ──────────────────
async def cancel_shard(shard_id: str, worker_id: str, reason: str = "") -> bool:
    """给已派给 worker 的 shard 发 shard_cancel"""
    return await push_to_worker(
        worker_id,
        wsp.build_shard_cancel(shard_id, reason),
        shard_id=shard_id,
        source="cancel",
    )


# ── 重连自动恢复 ──────────────────────────────────
async def _recover_pending_shards(worker_id: str, ws: WebSocket) -> None:
    """worker 重连后 · 查 DB 中 DISPATCHED/RUNNING shard · 重发 shard_assign

    2026-05-23 修 P0: 原来写的 "ASSIGNED" 不在 ShardStatus 枚举里 (只有
    PENDING/DISPATCHED/RUNNING/DONE/FAILED/CANCELLED) · 导致 worker 重连
    后所有 DISPATCHED 的 shard 全部漏召回。
    """
    from platform_v8.storage import db as _db
    from platform_v8.storage.repo import ShardRepo, WorkerRepo, WorkloadRepo
    from sqlalchemy import select
    from platform_v8.storage.repo import shards_t

    def _fetch() -> list[tuple]:
        with _db.session_scope() as s:
            worker = WorkerRepo.by_id(s, worker_id)
            if worker is not None and worker.capabilities.review_only:
                # A dedicated review identity may reconnect, but never receive
                # an old paid shard through the ordinary recovery channel.
                return []
            rows = s.execute(
                select(shards_t).where(
                    shards_t.c.worker_id == worker_id,
                    shards_t.c.status.in_(["DISPATCHED", "RUNNING"])
                )
            ).fetchall()
            return [(r.id, r.workload_id) for r in rows if r.id]
    pending = await asyncio.to_thread(_fetch)
    if not pending:
        return

    logger.info("broker.recover · worker=%s 有 %d 个未完成 shard · 重新派发",
                worker_id, len(pending))

    for shard_id, wl_id in pending:
        def _get_shard() -> tuple | None:
            with _db.session_scope() as s:
                sh = ShardRepo.by_id(s, shard_id)
                wl = WorkloadRepo.by_id(s, wl_id) if wl_id else None
                if not sh:
                    return None
                return (sh, wl)
        result = await asyncio.to_thread(_get_shard)
        if not result:
            continue
        sh, wl = result
        if not wl:
            continue

        if (getattr(wl.spec, "params", {}) or {}).get("review_sample_only") is True:
            # The registered Mac audit runner owns this private lease. A
            # normal node reconnect must neither push it as a paid shard nor
            # cancel it merely because its workload is QUARANTINED.
            continue

        # 2026-08-05 · 任务已终态(含 CANCELLED) · 禁止重连复活，顺手清残留片
        if getattr(wl, "is_terminal", False):
            def _cancel_zombie(_sid=str(sh.id)):
                with _db.session_scope() as s:
                    from sqlalchemy import update as _upd
                    from datetime import datetime as _dt
                    s.execute(
                        _upd(shards_t)
                        .where(shards_t.c.id == _sid)
                        .where(shards_t.c.status.in_([
                            "PENDING", "DISPATCHED", "LEASED", "RUNNING",
                        ]))
                        .values(
                            status="CANCELLED",
                            completed_at=_dt.utcnow(),
                            progress_at=None,
                            lease_by_node=None,
                            lease_expires_at=None,
                            error="cancelled:recover_skip_terminal_workload",
                        )
                    )
                    s.commit()
            try:
                await asyncio.to_thread(_cancel_zombie)
                logger.info(
                    "broker.recover · skip terminal workload=%s shard=%s status=%s",
                    str(wl.id)[:8], str(sh.id)[:8],
                    getattr(wl.status, "value", wl.status),
                )
            except Exception as exc:
                logger.debug("broker.recover · cancel zombie 旁路: %s", exc)
            continue

        per_shard_reward = float(wl.budget) / max(sh.total, 1)
        try:
            from platform_v8.engine.assignment_payload import build_assignment_payload
            payload = build_assignment_payload(
                sh,
                wl,
                worker_id=str(worker_id),
                capability_profile=(
                    get_session_metadata(str(worker_id)).capability_profile
                    if get_session_metadata(str(worker_id)) is not None
                    else None
                ),
                reward=per_shard_reward,
                input_expires=_OSS_REFRESH_EXPIRES,
            )
            frame = wsp.ShardAssign(payload=payload).model_dump_json()
        except Exception as exc:
            logger.warning(
                "broker.recover · payload materialization failed shard=%s: %s",
                str(sh.id)[:8], type(exc).__name__,
            )
            continue
        # 走 L2 投递 Port · 幂等保护: 若该 shard 仍在 watchdog 窗口内已派发给本节点,
        # deliver 会去重跳过(只召回真正孤儿片),从源头消除"recover 重发 + 原派发"双砸。
        from platform_v8.engine import delivery as _delivery
        delivered = await _delivery.deliver(worker_id, frame,
                                            idem_key=str(shard_id), source="recover")
        if delivered:
            logger.info("broker.recover · 召回 shard=%s → worker=%s", shard_id, worker_id)


async def _retry_waiting_workloads() -> None:
    """节点上线后，重新调度所有 WAITING_FOR_WORKERS / CREATED 的任务"""
    from platform_v8.storage import db as _db
    from platform_v8.storage.repo import WorkloadRepo
    from platform_v8.engine.lifecycle import start as lifecycle_start

    def _fetch_waiting() -> list[str]:
        with _db.session_scope() as s:
            from sqlalchemy import select
            from platform_v8.storage.repo import workloads_t
            rows = s.execute(
                select(workloads_t.c.id).where(
                    workloads_t.c.status.in_(["CREATED", "WAITING_FOR_WORKERS"])
                )
            ).fetchall()
            return [r.id for r in rows if r.id]

    waiting_ids = await asyncio.to_thread(_fetch_waiting)
    if not waiting_ids:
        return

    logger.info("broker.retry · 有 %d 个等待调度的任务 · 重新触发 lifecycle.start",
                len(waiting_ids))
    for wid in waiting_ids:
        try:
            await lifecycle_start(wid)
        except Exception as exc:
            logger.warning("broker.retry · workload=%s 重试失败: %s", wid, exc)
