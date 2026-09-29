"""
engine/delivery.py · L2 投递层 Port (M2 洋葱重构 · 2026-06-02)

洋葱边界 · 依赖只向内:
  引擎(L1 lifecycle / dispatch)只通过 `deliver(node, frame, idem_key=shard_id)`
  把一帧交出去 · 不关心走本地内存 / 跨进程 Redis / 未来 MQ。
  内层引擎从此不认识 WebSocket / 进程 / Redis 路由。

本层职责:
  1. 统一出口: 收编 broker.push_to_worker (本地直发) + gateway.route_push (跨进程) 为底层适配器。
  2. 幂等: idem_key = shard_id。同一 (shard, node) 在短窗口内重复投递 → 跳过,
     使 recover 重发 / 跨进程重复 / 多网关脱脑接力 产生的"重复下发到同一节点"变无害
     (根除节点并发跑同一分片 → 临时目录冲突 → exit code 1)。

铁律:
  - gw_multi OFF (单进程) → 幂等短路 (不碰 Redis) · deliver 行为与直接 push 逐字节一致 · 零回归。
  - Redis 挂 / 异常 → 降级放行 (不去重 · 配合 CAS 分配 + watchdog 兜底 · 绝不死锁/丢任务)。
  - 本层不改变"投不投得到"的语义,只去掉"同一分片重复砸到同一节点"。
"""
from __future__ import annotations
import logging

logger = logging.getLogger(__name__)

_GUARD_PREFIX = "v8:deliv:guard:"   # SET NX per (shard_id, node) · 投递幂等位
_OK_PREFIX = "v8:deliv:ok:"         # 送达确认 · 帧已真正写入节点 socket(本地/跨进程)
_DEFAULT_TTL_S = 90                 # 幂等窗口(秒) · 覆盖一次分片执行 + 网络余量
_OK_TTL_S = 3600                    # 送达确认 TTL · 远大于一次执行 · release_shard 主动清


def _multi() -> bool:
    try:
        from platform_v8.engine import gateway
        return gateway.multi_enabled()
    except Exception:
        return False


def _redis():
    try:
        from platform_v8.storage import kv as kv_mod
        return kv_mod.get_redis()
    except Exception:
        return None


def _guard_key(idem_key: str, node_id: str) -> str:
    return f"{_GUARD_PREFIX}{idem_key}:{node_id}"


def _claim_delivery(idem_key: str, node_id: str, ttl_s: int) -> bool:
    """抢"把 idem_key 投给 node_id"的投递权(SET NX EX)。
       返 True  = 首次 · 应投递。
       返 False = 窗口内已投递过(重复)· 应跳过。
       gw_multi OFF / Redis 挂 / 异常 → True(不去重 · 零回归)。"""
    if not _multi() or not idem_key:
        return True
    try:
        r = _redis()
        if r is None:
            return True
        return bool(r.set(_guard_key(idem_key, node_id), "1",
                          nx=True, ex=max(5, int(ttl_s))))
    except Exception as exc:
        logger.debug("delivery._claim fail shard=%s node=%s: %s", idem_key, node_id, exc)
        return True


def _release_delivery(idem_key: str, node_id: str) -> None:
    """投递失败 → 释放幂等位 · 允许立刻重派(给别的节点/重试)。"""
    if not _multi() or not idem_key:
        return
    try:
        r = _redis()
        if r is not None:
            r.delete(_guard_key(idem_key, node_id))
    except Exception as exc:
        logger.debug("delivery._release fail shard=%s node=%s: %s", idem_key, node_id, exc)


def release_shard(idem_key: str) -> None:
    """清空某 shard 的所有投递幂等位 + 送达确认。
       调用时机: shard 回到 PENDING 准备重派时 (reclaim / retry / redispatch / confirm-reaper)。
       目的: 幂等位语义 = "该分片正被投递且在某节点活跃"; 一旦回 PENDING(需重派),
       必须清位, 否则重派给同一节点会被误去重 → 标 DISPATCHED 却没真正下发(幻影派发);
       同时清送达确认, 让下一轮投递重新计 confirm。gw_multi OFF → no-op。"""
    if not _multi() or not idem_key:
        return
    try:
        r = _redis()
        if r is None:
            return
        keys = list(r.scan_iter(match=f"{_GUARD_PREFIX}{idem_key}:*", count=64))
        keys.append(f"{_OK_PREFIX}{idem_key}")
        if keys:
            r.delete(*keys)
    except Exception as exc:
        logger.debug("delivery.release_shard fail shard=%s: %s", idem_key, exc)


def mark_confirmed(idem_key: str | None) -> None:
    """送达确认: 帧已真正写入某节点的 WS socket(push_to_worker 本地 / _local_send 跨进程)。
       confirm-reaper 据此区分"已送达节点"与"丢在传输途中"。gw_multi OFF / 无 key → no-op。"""
    if not _multi() or not idem_key:
        return
    try:
        r = _redis()
        if r is not None:
            r.set(f"{_OK_PREFIX}{idem_key}", "1", ex=_OK_TTL_S)
    except Exception as exc:
        logger.debug("delivery.mark_confirmed fail shard=%s: %s", idem_key, exc)


def is_confirmed(idem_key: str) -> bool:
    """该 shard 是否已确认送达过任一节点 socket。Redis 挂/异常 → True(保守 · 不误判丢帧)。"""
    if not _multi() or not idem_key:
        return True
    try:
        r = _redis()
        if r is None:
            return True
        return r.get(f"{_OK_PREFIX}{idem_key}") is not None
    except Exception:
        return True


async def deliver(node_id: str, frame_json: str, *,
                  idem_key: str | None = None,
                  source: str = "dispatch",
                  ttl_s: int = _DEFAULT_TTL_S) -> bool:
    """L2 投递 Port · 引擎把一帧交给某节点的唯一出口。

    idem_key: 幂等键(shard_assign 用 shard_id)· 同一 (shard, node) 窗口内重复 → 跳过。
    source  : dispatch | recover | redispatch (仅观测/日志)。
    返 True  = 已投递 或 幂等跳过(视作已投递)。
    返 False = 真正投递失败(节点不在线/发送失败)· 幂等位已释放 · 调用方可重派。
    """
    from platform_v8.engine import broker
    claimed = _claim_delivery(idem_key, node_id, ttl_s) if idem_key else True
    if not claimed:
        logger.info("delivery.dedup · shard=%s node=%s source=%s · 窗口内重复 · 跳过下发(幂等)",
                    idem_key, str(node_id)[:8], source)
        return True
    ok = await broker.push_to_worker(node_id, frame_json, shard_id=idem_key, source=source)
    if not ok and idem_key:
        _release_delivery(idem_key, node_id)
    return ok
