"""
Gateway · M2 网关横扩跨进程协调层 (2026-06-02)

设计要点 (配套 docs/高并发改造执行计划_PLAN.md 第 9 节):
  把后端从"单 uvicorn 进程"扩成"N 个网关进程共享 Redis/PG"。节点的 WebSocket
  对象只活在接它的那个进程内存里 · 无法跨进程共享 · 本模块解决由此带来的 4 个难点:

    A 全局在线真相  : 派发候选改读 Redis ZSET v8:worker:hb (M1 已建)
    B 会话属主登记  : v8:ws:owner (HASH) field=worker_id value=gateway_id
    C 跨进程定向推送: 本地无 WS → 查属主 → PUBLISH v8:gw:<owner> → 属主进程本地发
    E 后台循环单例  : v8:gw:leader (SET NX EX) 选 leader · 仅 leader 跑 sweeper/reaper

铁律:
  - 全部走 flag `gw_multi` (默认 OFF) · OFF 时所有路径短路 · 行为与单进程逐字节一致。
  - Redis 挂 → 各操作 fail-safe 降级 (push 退本地 / leader 退"我是 leader" 配合幂等)。
  - 依赖 M1 flag `hb_via_redis` (ZSET v8:worker:hb 是全局在线真相)。
"""
from __future__ import annotations

RUNTIME_CONTRACT_ID = "2026-08-13.delivery-evidence"  # keep in sync with platform_v8.runtime_contract.CONTRACT_ID

import asyncio
import json
import logging
import os
import socket
import uuid

logger = logging.getLogger(__name__)

# ── Redis key / channel 命名 (全部 v8: 前缀 · 不跟其他 key 冲突) ──
_OWNER_HKEY = "v8:ws:owner"        # HASH worker_id → gateway_id
_HB_ZKEY = "v8:worker:hb"          # ZSET (M1 建) member=worker_id score=last_hb_epoch
_DISABLED_ZKEY = "v8:worker:disabled"  # ZSET member=worker_id score=disabled_until_epoch
_CH_PREFIX = "v8:gw:"              # 每网关定向频道 v8:gw:<gateway_id>
_CH_BROADCAST = "v8:gw:broadcast"  # 全网关广播频道
_CH_LEADER_JOBS = "v8:gw:leader_jobs"  # 派发作业委派频道 (非leader→leader · 单一权威)
_LEADER_KEY = "v8:gw:leader"       # 后台循环单例锁
_LEADER_TTL = 30                   # leader 锁 TTL(秒) · 续租周期应远小于此

_GATEWAY_ID: str | None = None
_is_leader = False


# ════════════════════════════════════════════════════════════════════
# 身份 + flag
# ════════════════════════════════════════════════════════════════════
def gateway_id() -> str:
    """本进程稳定网关 id (hostname:pid:rand) · 进程生命周期内不变"""
    global _GATEWAY_ID
    if _GATEWAY_ID is None:
        _GATEWAY_ID = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:6]}"
    return _GATEWAY_ID


def multi_enabled() -> bool:
    """flag gw_multi · 静默 (任何异常默认 OFF · 零回归)"""
    try:
        from platform_v8.services.ops import feature_flags as ff
        return ff.is_enabled("gw_multi")
    except Exception:
        return False


def _redis():
    try:
        from platform_v8.storage import kv as kv_mod
        return kv_mod.get_redis()
    except Exception:
        return None


# ════════════════════════════════════════════════════════════════════
# B · 会话属主登记 (sync · 单条 HASH 操作 · 亚毫秒 · 连接/断开时调 · 非热路径)
# ════════════════════════════════════════════════════════════════════
def set_owner(worker_id: str, *, connection_id: str | None = None) -> None:
    """Record the gateway and connection generation (later reconnect wins)."""
    try:
        r = _redis()
        if r is not None:
            owner = gateway_id()
            r.hset(_OWNER_HKEY, worker_id,
                   f"{owner}|{connection_id}" if connection_id else owner)
    except Exception as exc:
        logger.debug("gateway.set_owner fail wid=%s: %s", worker_id, exc)


def clear_owner(
    worker_id: str, *, only_if_mine: bool = True,
    connection_id: str | None = None,
) -> None:
    """Atomically remove only the exact socket generation that is closing."""
    try:
        r = _redis()
        if r is None:
            return
        if only_if_mine:
            expected = gateway_id()
            if connection_id:
                expected = f"{expected}|{connection_id}"
            r.eval(
                "if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] "
                "then return redis.call('HDEL', KEYS[1], ARGV[1]) end return 0",
                1, _OWNER_HKEY, worker_id, expected,
            )
        else:
            r.hdel(_OWNER_HKEY, worker_id)
    except Exception as exc:
        logger.debug("gateway.clear_owner fail wid=%s: %s", worker_id, exc)


def get_owner(worker_id: str) -> str | None:
    try:
        r = _redis()
        value = r.hget(_OWNER_HKEY, worker_id) if r is not None else None
        if isinstance(value, bytes):
            value = value.decode("utf-8")
        return value.split("|", 1)[0] if value else None
    except Exception:
        return None


# ════════════════════════════════════════════════════════════════════
# A · 全局在线集 (派发候选用 · 读 M1 的 ZSET · 比本地 _ws_sessions 全)
# ════════════════════════════════════════════════════════════════════
def online_worker_ids_global(ttl_s: int = 90) -> list[str] | None:
    """
    返全局在线 worker (ZSET 中 score 新鲜的)。
    返 None 表示拿不到 (Redis 挂 / ZSET 空) · 调用方应降级用本地 broker 在线集。
    """
    try:
        r = _redis()
        if r is None:
            return None
        import time as _t
        cutoff = _t.time() - ttl_s
        ids = r.zrangebyscore(_HB_ZKEY, cutoff, "+inf")
        return list(ids) if ids else None
    except Exception as exc:
        logger.debug("gateway.online_worker_ids_global fail: %s", exc)
        return None


# ════════════════════════════════════════════════════════════════════
# C · 跨进程定向推送 (本地无 WS 时 broker.push_to_worker 调)
# ════════════════════════════════════════════════════════════════════


def set_worker_disabled_until(worker_id: str, until_epoch: float) -> None:
    """缓存临时禁用状态并从全局心跳在线集中移除。DB 仍是最终权威。"""
    try:
        r = _redis()
        if r is None:
            return
        r.zadd(_DISABLED_ZKEY, {worker_id: float(until_epoch)})
        r.zrem(_HB_ZKEY, worker_id)
    except Exception as exc:
        logger.debug("gateway.set_worker_disabled fail wid=%s: %s", worker_id, exc)


def filter_disabled_workers(worker_ids: list[str]) -> list[str]:
    """从派发候选中移除尚未到期的临时禁用节点。Redis 不可用时由 DB 再兜底。"""
    if not worker_ids:
        return worker_ids
    try:
        import time as _t
        r = _redis()
        if r is None:
            return worker_ids
        now = _t.time()
        r.zremrangebyscore(_DISABLED_ZKEY, "-inf", now)
        blocked = set(r.zrangebyscore(_DISABLED_ZKEY, now, "+inf") or [])
        return [wid for wid in worker_ids if wid not in blocked]
    except Exception as exc:
        logger.debug("gateway.filter_disabled fail: %s", exc)
        return worker_ids


async def route_push(
    worker_id: str,
    frame_json: str,
    idem_key: str | None = None,
    source: str = "dispatch",
) -> bool:
    """
    把一帧路由到持有该 worker WS 的属主网关。
    返 True = 已投递到某个在听的属主网关 (乐观 · confirm-reaper/watchdog 兜底丢帧)。
    返 False = 无属主 / 属主是本进程(但本地没 WS·真离线) / 属主网关没在听。
    idem_key(shard_id) 随帧带给属主 · 属主 _local_send 成功后打送达确认。
    """
    owner = get_owner(worker_id)
    if not owner or owner == gateway_id():
        return False
    try:
        r = _redis()
        if r is None:
            return False
        msg = json.dumps({
            "wid": worker_id,
            "frame": frame_json,
            "idem": idem_key,
            "source": source,
        }, ensure_ascii=False)
        # publish 返回收到该消息的订阅者数 · 0 = 属主网关没在听(可能刚挂)→ False 让上层重派
        n = r.publish(_CH_PREFIX + owner, msg)
        return int(n or 0) > 0
    except Exception as exc:
        logger.warning("gateway.route_push fail wid=%s owner=%s: %s", worker_id, owner, exc)
        return False


async def route_push_broadcast(
    worker_id: str,
    frame_json: str,
    idem_key: str | None = None,
    source: str = "dispatch",
) -> bool:
    """v8.1.10 · 定向投递兜底:广播带 wid 的帧,所有网关收到后**只发给本地持有该 wid 的 worker**。
    不依赖 owner 登记准确性(谁真持有该 worker WS 谁发)· 修 owner 登记滞后/错位导致的丢帧。
    返 True = 至少有网关进程在听(乐观 · 真送达靠 _local_send 的 confirm · 没送达靠 watchdog 兜底)。
    """
    try:
        r = _redis()
        if r is None:
            return False
        msg = json.dumps({
            "wid": worker_id,
            "frame": frame_json,
            "idem": idem_key,
            "source": source,
        }, ensure_ascii=False)
        n = r.publish(_CH_BROADCAST, msg)
        return int(n or 0) > 0
    except Exception as exc:
        logger.debug("gateway.route_push_broadcast fail wid=%s: %s", worker_id, exc)
        return False



async def route_kick(worker_id: str, reason: str = "kicked") -> bool:
    """把强制断连指令路由到真正持有 Worker WS 的网关进程。"""
    try:
        r = _redis()
        if r is None:
            return False
        owner = get_owner(worker_id)
        channel = (
            _CH_PREFIX + owner
            if owner and owner != gateway_id()
            else _CH_BROADCAST
        )
        msg = json.dumps(
            {"op": "kick", "wid": worker_id, "reason": reason[:120]},
            ensure_ascii=False,
        )
        return int(r.publish(channel, msg) or 0) > 0
    except Exception as exc:
        logger.warning("gateway.route_kick fail wid=%s: %s", worker_id, exc)
        return False


async def publish_broadcast(frame_json: str) -> None:
    """广播一帧给所有网关 (各网关订阅器收到后本地分发给自己连的 worker)"""
    try:
        r = _redis()
        if r is None:
            return
        r.publish(_CH_BROADCAST, json.dumps({"frame": frame_json}, ensure_ascii=False))
    except Exception as exc:
        logger.debug("gateway.publish_broadcast fail: %s", exc)


# ════════════════════════════════════════════════════════════════════
# C2 · 派发作业委派 (L1 单一权威 · 非 leader 把"驱动派发"交给 leader)
#   纯传输原语: gateway 只负责 publish + 把消息回调给引擎注册的处理器,
#   不认识 lifecycle/start/redispatch 语义 (依赖只向内 · L1 引擎注册回调)。
#   fire-and-forget · leader 漏收由 sweeper(leader-only)兜底自愈。
# ════════════════════════════════════════════════════════════════════
_leader_job_cb = None  # async fn(action: str, workload_id: str, payload: dict) · 由引擎层注册


def register_leader_job_handler(cb) -> None:
    """引擎层 (lifecycle) 注册派发作业处理器 · leader 收到委派后回调它。"""
    global _leader_job_cb
    _leader_job_cb = cb


def publish_leader_job(
    action: str, workload_id: str, *, payload: dict | None = None
) -> bool:
    """非 leader 把一项派发作业 (start|redispatch) 委派给 leader 执行。
       返 True = 已发布 (best-effort · leader 漏收靠 sweeper 兜底)。
       gw_multi OFF / Redis 挂 → False (调用方本地兜底执行 · 零回归)。"""
    if not multi_enabled():
        return False
    try:
        r = _redis()
        if r is None:
            return False
        job = {"action": action, "workload_id": workload_id}
        if payload:
            job["payload"] = payload
        r.publish(_CH_LEADER_JOBS, json.dumps(job, ensure_ascii=False))
        return True
    except Exception as exc:
        logger.debug("gateway.publish_leader_job fail action=%s wid=%s: %s",
                     action, workload_id, exc)
        return False


# ════════════════════════════════════════════════════════════════════
# 每进程订阅器 (app lifespan 启动 · 收定向/广播帧 → 本地 send)
# ════════════════════════════════════════════════════════════════════
async def _handle_sub_message(channel: str, data: str) -> None:
    from platform_v8.engine import broker
    try:
        obj = json.loads(data)
    except Exception:
        return
    if obj.get("op") == "kick":
        wid_kick = obj.get("wid")
        if wid_kick:
            await broker.kick_worker(
                wid_kick,
                reason=obj.get("reason") or "kicked",
                route_remote=False,
            )
        return
    if channel == _CH_LEADER_JOBS:
        # 派发作业委派 · 只有 leader 执行 (单一权威) · 非 leader 丢弃
        if _leader_job_cb is None or not is_leader_fresh():
            return
        action = obj.get("action")
        wid_job = obj.get("workload_id")
        if action and wid_job:
            try:
                payload = obj.get("payload")
                await _leader_job_cb(
                    action, wid_job, payload if isinstance(payload, dict) else {}
                )
            except Exception as exc:
                logger.warning("gateway.leader_job · 执行异常 action=%s wid=%s: %s",
                               action, wid_job, exc)
        return
    if channel == _CH_BROADCAST:
        frame = obj.get("frame")
        wid_b = obj.get("wid")
        # v8.1.10 · 带 wid = 定向投递兜底(route_push 定向失败时广播)·
        # 只有本地真持有该 wid WS 的进程会发,其余静默(绕过 owner 登记不准·谁持有谁发)
        if frame and wid_b:
            await broker._local_send(
                wid_b, frame, obj.get("idem"), obj.get("source") or "dispatch",
            )
        elif frame:
            await broker._local_broadcast(frame)
        return
    wid = obj.get("wid")
    frame = obj.get("frame")
    if wid and frame:
        idem = obj.get("idem")
        src = obj.get("source") or "dispatch"
        sent = await broker._local_send(wid, frame, idem, src)
        if not sent:
            # 2026-09-17 · 定向投递"乐观成功"(publish 有订阅者) != 本进程真有该 worker 的活会话:
            # 属主登记滞后 / 同一 worker 行多会话时,帧会静默丢在这里,15s 后被按 OFFLINE_WORKER 召回。
            # → 转广播兜底: 谁真持有该 worker 的 WS 谁发(复用 v8.1.10 既有兜底路径)。
            await route_push_broadcast(wid, frame, idem_key=idem, source=src)


async def subscriber_loop() -> None:
    """
    每个网关进程跑一份 · 订阅 v8:gw:<本网关> + v8:gw:broadcast。
    flag OFF 时空转 (5s 轮询) · ON 时建 async redis 连接订阅 · 异常 5s 重连。
    """
    logger.info("gateway.subscriber · 启动 (gw=%s · 等待 gw_multi)", gateway_id())
    while True:
        if not multi_enabled():
            await asyncio.sleep(5)
            continue
        url = os.environ.get("V8_REDIS_URL") or os.environ.get("REDIS_URL")
        if not url:
            logger.warning("gateway.subscriber · 无 V8_REDIS_URL · 5s 重试")
            await asyncio.sleep(5)
            continue
        r = None
        ps = None
        try:
            import redis.asyncio as aredis
            r = aredis.from_url(url, decode_responses=True)
            ps = r.pubsub()
            my_ch = _CH_PREFIX + gateway_id()
            await ps.subscribe(my_ch, _CH_BROADCAST, _CH_LEADER_JOBS)
            logger.info("gateway.subscriber · 已订阅 %s + broadcast + leader_jobs", my_ch)
            async for msg in ps.listen():
                if msg.get("type") != "message":
                    continue
                try:
                    await _handle_sub_message(msg.get("channel"), msg.get("data"))
                except Exception as exc:
                    logger.debug("gateway.subscriber · 处理消息异常: %s", exc)
                if not multi_enabled():
                    logger.info("gateway.subscriber · gw_multi 已关 · 断开订阅")
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("gateway.subscriber · 异常 · 5s 重连: %s", exc)
            await asyncio.sleep(5)
        finally:
            try:
                if ps is not None:
                    await ps.aclose()
            except Exception:
                pass
            try:
                if r is not None:
                    await r.aclose()
            except Exception:
                pass


# ════════════════════════════════════════════════════════════════════
# E · 后台循环单例 (leader 锁 · 仅 leader 跑 sweeper/reaper · 防 N 进程 N 份)
# ════════════════════════════════════════════════════════════════════
def acquire_or_renew_leader() -> bool:
    """尝试成为 / 续租 leader · 返当前是否 leader。Redis 挂 → 退化"我是 leader"(配合幂等)"""
    global _is_leader
    try:
        r = _redis()
        if r is None:
            _is_leader = True
            return True
        gid = gateway_id()
        cur = r.get(_LEADER_KEY)
        if cur == gid:
            r.expire(_LEADER_KEY, _LEADER_TTL)   # 续租
            _is_leader = True
        elif cur is None:
            got = r.set(_LEADER_KEY, gid, nx=True, ex=_LEADER_TTL)  # 抢锁
            _is_leader = bool(got)
        else:
            _is_leader = False
        return _is_leader
    except Exception as exc:
        logger.debug("gateway.leader fail · 退化为 leader: %s", exc)
        _is_leader = True
        return True


def is_leader() -> bool:
    """当前进程是否 leader (缓存值 · 10s 续租刷新 · 单例循环门控用)"""
    return _is_leader


def is_leader_fresh() -> bool:
    """派发委派决策专用 · 直接查 Redis leader key 判定当前是否 leader,
       不依赖 10s 续租缓存(避免重启/抖动窗口误判导致非 leader 本地派发)。
       Redis 挂 → 退化 True(本地执行 · 由 per-workload 锁 + shard_id 幂等兜底 · 安全)。"""
    try:
        r = _redis()
        if r is None:
            return True
        return r.get(_LEADER_KEY) == gateway_id()
    except Exception:
        return True


def should_run_singleton() -> bool:
    """后台单例任务(派发驱动/reaper)本轮是否该在本进程跑:
       flag OFF (单进程) → 永远 True;flag ON → 仅 leader True。"""
    if not multi_enabled():
        return True
    return is_leader()


# ════════════════════════════════════════════════════════════════════
# G · per-workload 派发互斥 (M2-fix 2026-06-02 · 防多网关脱脑重复派发)
#   背景:should_run_singleton() 只门控了 sweeper/reaper 循环,但事件驱动派发
#   (register_session→retry / reclaim→redispatch / event_bus→redispatch) 在任意
#   网关进程都会跑。多 worker 下多进程抢派同一 workload → 同一分片重复下发到节点
#   → 节点并发跑同片(临时目录/文件冲突)→ exit 1 → 重试预算被并发烧光 → 误判 FAILED。
#   修法:派发入口 (lifecycle.start / redispatch_pending) 抢 per-workload 锁,
#   拿不到 = 别人在驱动该 workload → 跳过 (持有者会派完;漏的靠 sweeper 兜底重派)。
#
#   gw_multi OFF (单进程) → 返 "local" 直接放行 · 零开销 · 行为逐字节不变。
#   Redis 挂 / 异常       → 降级放行 (配合 CAS 分配 + watchdog 兜底 · 不致死锁)。
# ════════════════════════════════════════════════════════════════════
_WL_LOCK_PREFIX = "v8:wl:lock:"
_WL_LOCK_TTL = 30                 # 秒 · 远大于一次派发操作耗时 · 持有者崩溃自动过期
_LOCAL_TOKEN = "local"            # 哨兵 token · 表示"无需加锁/降级放行"

# 释放锁的 Lua: 仅当 token 匹配才删 (防误删别人重新抢到的同名锁)
_RELEASE_LUA = (
    "if redis.call('get', KEYS[1]) == ARGV[1] then "
    "return redis.call('del', KEYS[1]) else return 0 end"
)


def acquire_workload_lock(workload_id: str, ttl_s: int = _WL_LOCK_TTL) -> str | None:
    """抢某 workload 的派发锁。
       返 token(成功 · 调用方需在 finally 调 release_workload_lock 归还)
       返 "local"(gw_multi OFF / Redis 挂 / 异常 · 无锁直接放行)
       返 None(锁被其他网关持有 · 调用方应跳过本次派发)"""
    if not multi_enabled():
        return _LOCAL_TOKEN
    try:
        r = _redis()
        if r is None:
            return _LOCAL_TOKEN  # Redis 挂 → 降级放行 (CAS + watchdog 兜底)
        token = uuid.uuid4().hex
        got = r.set(_WL_LOCK_PREFIX + str(workload_id), token, nx=True, ex=ttl_s)
        return token if got else None
    except Exception as exc:
        logger.debug("gateway.acquire_workload_lock fail wl=%s: %s", workload_id, exc)
        return _LOCAL_TOKEN  # 异常降级放行


def release_workload_lock(workload_id: str, token: str | None) -> None:
    """归还派发锁 (token 为 None/local 时 no-op)。"""
    if not token or token == _LOCAL_TOKEN:
        return
    try:
        r = _redis()
        if r is None:
            return
        r.eval(_RELEASE_LUA, 1, _WL_LOCK_PREFIX + str(workload_id), token)
    except Exception as exc:
        logger.debug("gateway.release_workload_lock fail wl=%s: %s", workload_id, exc)


# ════════════════════════════════════════════════════════════════════
# H · 投递埋点 + 重复投递探测 (Phase0 看 · 根因确认 · gw_multi 门控)
#   每次"把一帧发给某节点"都记一次: shard_id / 节点 / 路径 / 来源。
#   用 Redis INCR per-shard 计数 (短 TTL),count>1 即重复投递 → WARNING。
#   gw_multi OFF → no-op 返 1 (零开销)。纯观测,不改变任何投递行为。
# ════════════════════════════════════════════════════════════════════
_DELIV_PREFIX = "v8:deliv:"      # STRING per-shard 投递计数 (短 TTL)
_DELIV_TTL = 300                 # 秒 · 覆盖一次任务生命周期足矣


def track_delivery(shard_id: str | None, node_id: str, *, path: str, source: str) -> int:
    """记录一次"shard_assign 帧发往节点" · 返该 shard 累计投递次数。
       path: local | route_push | local-recover  source: dispatch | recover
       count>1 → 重复投递告警 (Phase0 根因证据)。gw_multi OFF / 无 shard_id → no-op 返 1。"""
    if not multi_enabled() or not shard_id:
        return 1
    try:
        r = _redis()
        if r is None:
            return 1
        key = _DELIV_PREFIX + str(shard_id)
        n = int(r.incr(key) or 1)
        if n == 1:
            r.expire(key, _DELIV_TTL)
        if n > 1:
            logger.warning("deliver.DUP · shard=%s node=%s path=%s source=%s count=%d · 重复投递!",
                           shard_id, str(node_id)[:8], path, source, n)
        else:
            logger.info("deliver.track · shard=%s node=%s path=%s source=%s count=%d",
                        shard_id, str(node_id)[:8], path, source, n)
        return n
    except Exception as exc:
        logger.debug("gateway.track_delivery fail shard=%s: %s", shard_id, exc)
        return 1


async def leader_renew_loop(interval_s: int = 10) -> None:
    """leader 锁续租后台循环 (app lifespan 启动)。flag OFF 时空转。"""
    logger.info("gateway.leader_renew · 启动 · interval=%ds", interval_s)
    while True:
        try:
            if multi_enabled():
                acquire_or_renew_leader()
        except Exception as exc:
            logger.debug("gateway.leader_renew · 异常 (继续): %s", exc)
        await asyncio.sleep(interval_s)
