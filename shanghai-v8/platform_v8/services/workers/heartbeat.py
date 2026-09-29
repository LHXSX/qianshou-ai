"""
Worker 心跳 + 离线判定

设计要点 (考虑全链路):
  - 心跳通过 WS hb 帧 (api/v8/ws.py 调本函数)
  - 心跳同时更新 load + active_shards (调度器用 · 链路 5)
  - reap_stale 给后台任务用: 超时节点 → OFFLINE + 写审计
"""
from __future__ import annotations
import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from platform_v8.core import WorkerStatus, AuditAction
from platform_v8.storage.repo import WorkerRepo, AuditRepo

logger = logging.getLogger(__name__)

# ════════════════════════════════════════════════════════════════════════════
# M1 扩容 · 心跳走 Redis + 批量回写 (2026-06-02)
#
# 痛点 (实测): 每个 hb 都同步写 PG (update_heartbeat + 可能 update_capabilities) ·
#   N 节点 = N 次写/周期 · 单进程 ~1.4k 节点封顶 (写放大是元凶)
#
# 方案 (flag hb_via_redis · 默认关 · 零回归):
#   1. hb 写 Redis ZSET v8:worker:hb (member=worker_id score=epoch) → 在线权威 + last_seen
#      (为 M2 多网关共享在线态铺路 · 当前单进程也用作 reaper 旁路)
#   2. load/active_shards/last_seen 进进程内缓冲 _HB_BUFFER · 不每次写 PG
#   3. capabilities 补丁仅在"变化时"才写 PG (throttle/mode/software 极少变 · 变更检测去重)
#   4. sweeper 每轮 flush_hb_buffer() → 1 条 bulk UPDATE 把缓冲批量回写 PG
#      (N 次写 → 每 30s 1 次 · 写放大从 O(N/周期) 降到 O(1/周期))
#   5. reaper 仍读 PG last_seen (靠 30s 批量回写保持新鲜 · TTL 60s > 回写周期 · 不误杀)
#
#   Redis 挂 → get_redis()=None → 自动退回逐条写 PG (fail-safe · backend 不挂)
# ════════════════════════════════════════════════════════════════════════════

_HB_ZKEY = "v8:worker:hb"          # Redis ZSET · 在线权威 (raw key · 不经 kv._k)
_HB_BUFFER: dict[str, dict] = {}   # worker_id -> {"load","active_shards","last_seen"}
_HB_LAST_CAP: dict[str, str] = {}  # worker_id -> 上次 cap patch 的 json (变更检测)
_HB_LOCK = threading.Lock()


def _hb_buffered_enabled() -> bool:
    """心跳批量回写默认开启；环境变量或已存在的 flag 可显式关闭。"""
    override = os.environ.get("V8_HB_BUFFERED_ENABLED", "").strip().lower()
    if override in {"0", "false", "off"}:
        return False
    if override in {"1", "true", "on"}:
        return True
    try:
        from platform_v8.services.ops import feature_flags as _ff
        flag = _ff.get_flag("hb_via_redis")
        if flag is None:
            return True
        return _ff.is_enabled("hb_via_redis")
    except Exception:
        return True


# 客户端 capabilities_full / 单字段上报的硬件清单白名单
_CAP_INVENTORY_KEYS = frozenset({
    "cpu_brand", "cpu_cores", "cpu_threads",
    "total_memory_mb", "memory_gb", "ram_gb",
    "total_disk_mb", "free_disk_mb", "total_disk_gb", "free_disk_gb", "disk_mb",
    "gpu_count", "gpu_model", "gpu_vram_gb", "vram_mb", "accelerators",
    "supports_cuda", "supports_metal", "supports_mlx", "supports_rocm",
    "supports_nvenc", "supports_nvdec", "supports_videotoolbox", "supports_qsv",
    "supports_tensor_cores", "supports_neural_engine", "unified_memory",
    "os", "os_name", "os_version", "kernel_version", "arch",
    "hostname", "device_name", "tier",
    "bench_cpu_mb_per_sec", "bench_memory_gb_per_sec",
    "bench_disk_mb_per_sec", "bench_capability_score",
    "native_binaries", "onnx_models", "supported_executors",
    "runtimes", "software", "runtime_tiers",
    "installed_skills", "installed_apps",
    "runtime_install_mode", "runtime_host_python",
    "throttle_pct", "mode",
    "ollama_models", "llm_models", "llm_backend", "ai_runtime_ready",
})


def _merge_inventory_into_patch(patch: dict, inventory: dict) -> None:
    """把硬件清单字段并入 patch（仅白名单 key）"""
    if not isinstance(inventory, dict):
        return
    for key, value in inventory.items():
        if key in _CAP_INVENTORY_KEYS:
            patch[key] = value


# 客户端 capabilities_full / 单字段上报的硬件清单白名单
_CAP_INVENTORY_KEYS = frozenset({
    "cpu_brand", "cpu_cores", "cpu_threads",
    "total_memory_mb", "memory_gb", "ram_gb",
    "total_disk_mb", "free_disk_mb", "total_disk_gb", "free_disk_gb", "disk_mb",
    "gpu_count", "gpu_model", "gpu_vram_gb", "vram_mb", "accelerators",
    "supports_cuda", "supports_metal", "supports_mlx", "supports_rocm",
    "supports_nvenc", "supports_nvdec", "supports_videotoolbox", "supports_qsv",
    "supports_tensor_cores", "supports_neural_engine", "unified_memory",
    "os", "os_name", "os_version", "kernel_version", "arch",
    "hostname", "device_name", "tier",
    "bench_cpu_mb_per_sec", "bench_memory_gb_per_sec",
    "bench_disk_mb_per_sec", "bench_capability_score",
    "native_binaries", "onnx_models", "supported_executors",
    "runtimes", "software", "runtime_tiers",
    "runtime_install_mode", "runtime_host_python",
    "throttle_pct", "mode",
    "ollama_models", "llm_models", "llm_backend", "ai_runtime_ready",
})


def _merge_inventory_into_patch(patch: dict, inventory: dict) -> None:
    """把硬件清单字段并入 patch（仅白名单 key）"""
    if not isinstance(inventory, dict):
        return
    for key, value in inventory.items():
        if key in _CAP_INVENTORY_KEYS:
            patch[key] = value


def _build_cap_patch(throttle_pct: int | None, mode: str | None,
                     extra: dict | None) -> dict:
    """从 hb 帧抽出要合并进 capabilities 的字段 (推/拉两路共用)"""
    patch: dict = {}
    if throttle_pct is not None:
        patch["throttle_pct"] = max(0, min(100, int(throttle_pct)))
    if mode:
        patch["mode"] = str(mode)
    # P0 NCE · 仅取 extra 中服务端真消费的字段 (避免客户端乱丢 key)
    if extra:
        if "uptime_sec" in extra:
            try:
                patch["uptime_sec"] = int(extra["uptime_sec"])
            except (TypeError, ValueError):
                pass
        # 2026-05-27 · 节点装/卸 tier 后 · 通过 hb.extra 同步新能力快照
        if "software" in extra and isinstance(extra["software"], list):
            patch["software"] = sorted({x for x in extra["software"] if isinstance(x, str)})
        if "runtime_tiers" in extra and isinstance(extra["runtime_tiers"], list):
            patch["runtime_tiers"] = sorted({t for t in extra["runtime_tiers"] if isinstance(t, str)})
        if "runtime_install_mode" in extra and isinstance(extra["runtime_install_mode"], str):
            patch["runtime_install_mode"] = extra["runtime_install_mode"]
        if "runtime_host_python" in extra and isinstance(extra["runtime_host_python"], str):
            patch["runtime_host_python"] = extra["runtime_host_python"]
        if "llm_models" in extra and isinstance(extra["llm_models"], list):
            patch["llm_models"] = [
                x for x in extra["llm_models"] if isinstance(x, str)
            ]
        if "ollama_models" in extra and isinstance(extra["ollama_models"], list):
            patch["ollama_models"] = [
                x for x in extra["ollama_models"] if isinstance(x, str)
            ]
        # 过渡双写：只报一侧时镜像到另一侧
        if "llm_models" in patch and "ollama_models" not in patch:
            patch["ollama_models"] = list(patch["llm_models"])
        elif "ollama_models" in patch and "llm_models" not in patch:
            patch["llm_models"] = list(patch["ollama_models"])
        if "llm_backend" in extra and isinstance(extra["llm_backend"], str):
            patch["llm_backend"] = extra["llm_backend"]
        if "ai_runtime_ready" in extra:
            patch["ai_runtime_ready"] = bool(extra["ai_runtime_ready"])
        # 完整硬件清单（CPU/GPU/内存/磁盘/系统/跑分）· 客户端 caps-full 后一次上报
        if isinstance(extra.get("capabilities_full"), dict):
            _merge_inventory_into_patch(patch, extra["capabilities_full"])
        else:
            # 兼容：单字段直接塞在 extra 顶层
            _merge_inventory_into_patch(patch, extra)
    return patch


def _cap_patch_changed(worker_id: str, patch: dict) -> bool:
    """能力补丁去重；持续变化的 uptime_sec 按 5 分钟桶比较。"""
    comparable = dict(patch)
    if "uptime_sec" in comparable:
        try:
            comparable["uptime_sec"] = max(0, int(comparable["uptime_sec"])) // 300
        except (TypeError, ValueError):
            comparable.pop("uptime_sec", None)
    try:
        patch_key = json.dumps(comparable, sort_keys=True, default=str)
    except Exception:
        patch_key = repr(comparable)
    with _HB_LOCK:
        if _HB_LAST_CAP.get(worker_id) == patch_key:
            return False
        _HB_LAST_CAP[worker_id] = patch_key
        return True


def _throttle_change_payload(
    s: Session, worker_id: str, patch: dict,
) -> tuple[int, int, str] | None:
    """返回 (owner_id, pct, mode)，仅当本次 patch 真的改变节流状态。"""
    if "throttle_pct" not in patch and "mode" not in patch:
        return None
    worker = WorkerRepo.by_id(s, worker_id)
    if worker is None:
        return None
    current_throttle_pct = int(worker.capabilities.throttle_pct)
    current_mode = str(worker.capabilities.contribute_mode)
    throttle_pct = int(patch.get("throttle_pct", current_throttle_pct))
    mode = str(patch.get("mode", current_mode))
    if throttle_pct == current_throttle_pct and mode == current_mode:
        return None
    return int(worker.owner_id), throttle_pct, mode


def _publish_throttle_change(
    worker_id: str, owner_id: int, throttle_pct: int, mode: str,
) -> None:
    """节流能力变更后推给节点拥有者，供企业端无需刷新页面即可更新。"""
    try:
        from platform_v8.api.v8.events import publish_event_sync
        publish_event_sync("worker.status", {
            "worker_id": worker_id,
            "owner_id": owner_id,
            "throttle_pct": throttle_pct,
            "contribute_mode": mode,
        }, owner_id=owner_id)
    except Exception as exc:
        # 状态推送失败不能影响 worker 心跳或调度。
        logger.warning("hb · 广播节流状态失败 (静默): %s", exc)


def heartbeat(s: Session, worker_id: str, *, load: float = 0.0,
              active_shards: int = 0,
              throttle_pct: int | None = None,
              mode: str | None = None,
              extra: dict | None = None) -> bool:
    """
    更新 worker 心跳 · 返 True 表示节点存在并更新成功

    调用方: api/v8/ws.py 收到 hb 帧时

    2026-05-21 P0-2:
      throttle_pct + mode 合并到 capabilities JSON · planner 调度用
      throttle_pct=0 或 mode=paused 节点会被 planner 排除

    2026-05-26 P0 NCE:
      extra.uptime_sec · 合并到 capabilities.uptime_sec · rep_stability 子分可用
      旧客户端不发 extra = None · 向后兼容

    2026-06-02 M1:
      flag hb_via_redis ON → 走缓冲批量回写 (见 _heartbeat_buffered) · 否则老逐条写 PG
    """
    if _hb_buffered_enabled():
        return _heartbeat_buffered(s, worker_id, load=load,
                                   active_shards=active_shards,
                                   throttle_pct=throttle_pct, mode=mode, extra=extra)

    ok = WorkerRepo.update_heartbeat(
        s, worker_id, load=load, active_shards=active_shards,
    )
    # 新字段合并到 capabilities (旧客户端不发 = None · 跳过)
    if ok and (throttle_pct is not None or mode is not None or extra):
        patch = _build_cap_patch(throttle_pct, mode, extra)
        if not patch or not _cap_patch_changed(worker_id, patch):
            return ok
        try:
            throttle_change = _throttle_change_payload(s, worker_id, patch)
            if WorkerRepo.update_capabilities(s, worker_id, patch):
                if throttle_change is not None:
                    _publish_throttle_change(worker_id, *throttle_change)
        except Exception as exc:
            logger.warning("hb · merge capabilities 失败 (静默): %s", exc)
    return ok


def _heartbeat_buffered(s: Session, worker_id: str, *, load: float,
                        active_shards: int, throttle_pct: int | None,
                        mode: str | None, extra: dict | None) -> bool:
    """
    M1 · 心跳缓冲路径 (flag hb_via_redis ON):
      - 写 Redis ZSET (在线权威 · best-effort)
      - load/active_shards/last_seen 进进程内缓冲 (sweeper 批量回写 PG)
      - capabilities 补丁仅变更时写 PG (throttle/mode/software 极少变)
    """
    now = datetime.utcnow()

    # 1. Redis ZSET (best-effort · 挂了不影响心跳成功)
    #    score 必须用真实 epoch time.time() · 不能用 naive utcnow().timestamp()
    #    (naive datetime.timestamp() 按本地时区折算 · 会比 time.time() 偏 8h ·
    #     导致 zrangebyscore(now-ttl) 全判过期 + 修剪误删全员 · M2 在线集会瞎)
    try:
        from platform_v8.storage import kv as kv_mod
        r = kv_mod.get_redis()
        if r is not None:
            r.zadd(_HB_ZKEY, {worker_id: time.time()})
    except Exception as exc:
        logger.debug("hb · redis zadd 失败 (静默 · 退回 PG 回写): %s", exc)

    # 2. 进程内缓冲 (覆盖式 · 只留每个 worker 最新一次)
    with _HB_LOCK:
        _HB_BUFFER[worker_id] = {
            "load": float(load),
            "active_shards": int(active_shards),
            "last_seen": now,
        }

    # 3. capabilities 补丁 · 仅变更时写 PG (去重 · 避免每 hb 写 jsonb)
    patch = _build_cap_patch(throttle_pct, mode, extra)
    if patch and _cap_patch_changed(worker_id, patch):
        try:
            throttle_change = _throttle_change_payload(s, worker_id, patch)
            if WorkerRepo.update_capabilities(s, worker_id, patch):
                if throttle_change is not None:
                    _publish_throttle_change(worker_id, *throttle_change)
        except Exception as exc:
            logger.warning("hb · merge capabilities 失败 (静默): %s", exc)
    return True


def flush_hb_buffer() -> int:
    """
    M1 · 把进程内心跳缓冲批量回写 PG (sweeper 每轮调 · 同步函数 · 放 to_thread 跑)

    返回回写的 worker 数。把 N 次 update 合并成 1 条 bulk UPDATE。
    flag OFF 后缓冲也会被本函数排空 (兜底 · 不丢最后一批)。
    """
    global _HB_BUFFER
    with _HB_LOCK:
        if not _HB_BUFFER:
            return 0
        snapshot = _HB_BUFFER
        _HB_BUFFER = {}
    try:
        from platform_v8.storage import db as db_mod
        with db_mod.session_scope() as s:
            n = WorkerRepo.bulk_update_heartbeat(s, snapshot)
            s.commit()
    except Exception as exc:
        # 回写失败 · 把这批塞回缓冲 (下轮重试 · 不丢心跳 last_seen)
        logger.warning("hb · flush 批量回写失败 (下轮重试): %s", exc)
        with _HB_LOCK:
            for wid, v in snapshot.items():
                _HB_BUFFER.setdefault(wid, v)
        return 0

    # 顺带修剪 Redis ZSET 陈旧成员 (score 早于 now-600s · 节点掉线没 ZREM 干净时兜底 · 防无限增长)
    try:
        import time as _t
        from platform_v8.storage import kv as kv_mod
        r = kv_mod.get_redis()
        if r is not None:
            r.zremrangebyscore(_HB_ZKEY, "-inf", _t.time() - 600)
    except Exception as exc:
        logger.debug("hb · ZSET 修剪失败 (静默): %s", exc)
    return n


def mark_offline(s: Session, worker_id: str, reason: str = "ws_closed") -> bool:
    """节点 ws 断开 / 主动 disconnect 时调"""
    worker = WorkerRepo.by_id(s, worker_id)
    if worker is None:
        return False
    if worker.status == WorkerStatus.OFFLINE:
        return True  # 已 offline · idempotent

    WorkerRepo.mark_offline(s, worker_id)
    # M1 · 同步从 Redis 在线 ZSET 摘除 (best-effort · 失败靠 flush 的按 score 修剪兜底)
    try:
        from platform_v8.storage import kv as kv_mod
        r = kv_mod.get_redis()
        if r is not None:
            r.zrem(_HB_ZKEY, worker_id)
    except Exception:
        pass
    AuditRepo.write(
        s,
        action=AuditAction.WORKER_OFFLINE,
        actor_account_id=worker.owner_id,
        actor_kind="worker",
        target_kind="worker",
        target_id=worker_id,
        detail={"reason": reason},
    )
    logger.info("worker.offline · id=%s reason=%s", worker_id, reason)

    # 2026-05-18 实时推 worker.offline
    try:
        from platform_v8.api.v8.events import publish_event_sync
        publish_event_sync("worker.offline", {
            "worker_id": worker_id,
            "owner_id": worker.owner_id,
            "reason": reason,
        }, owner_id=worker.owner_id)
    except Exception:
        pass

    return True


def reap_stale_workers(s: Session, ttl_seconds: int = 60) -> int:
    """
    后台任务定期跑: 超过 ttl_seconds 没心跳的 worker → OFFLINE

    返回标记为 offline 的 worker 数
    """
    count = WorkerRepo.reap_stale(s, ttl_seconds=ttl_seconds)
    if count:
        logger.info("reaper · %d 个 worker 因心跳超时下线 (TTL=%ds)", count, ttl_seconds)
    return count
