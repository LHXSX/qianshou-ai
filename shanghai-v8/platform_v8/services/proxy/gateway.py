"""
Proxy Gateway · IP 代理池核心

职责:
  1. 维护活跃 session 表 (session_id → ProxySession)
  2. 节点选择器 (从在线 worker 中选 proxy_enabled + load 低 + rep 高的)
  3. 数据路由:
     客户 ─┬─ open_session(target_host, target_port) → 选 worker · 发 proxy_open
          ├─ forward_to_node(session_id, data) → push proxy_chunk
          ├─ read_from_node(session_id) → 从 client_queue 拿目标响应
          └─ close_session(session_id) → push proxy_close + 清理 + 计费

  4. 节点回流:
     on_node_chunk(session_id, data_b64) → 解 base64 入 client_queue
     on_node_close(session_id, bytes_up, bytes_down, error) → 清理 + 计费

风控:
  - 目标 host 白名单 / 黑名单 (PROXY_TARGET_DENY)
  - 每节点最大并发 session (默认 100)
  - 每 session 超时 (默认 60s 空闲)
  - 全局每客户 QPS 限制 (TODO: redis token bucket)

计费 (W5 · 2026-05-26 · 撤销 *隐蔽* 概念 · 走标准 ledger.transfer 三方分账):
  - session 关闭时 · 写 we_proxy_sessions 表 (计量 + 审计 · 保留)
  - 老路径: subsidy.settle (we_platform_revenue + we_node_subsidies + ledger.reward 节点)
  - 新路径: ledger.transfer (ESCROW_HOLD 客户 + REWARD 节点 + PLATFORM_FEE 平台 · 三条原子)
  - 双轨并存 · 老路径继续给运营审计 · 新路径才真正动 ledger
  - 节点不再 "0 补贴" · 默认 15% 平台抽成 · 客户也实际扣钱

节点隐蔽:
  - 不要求节点上报 capabilities.proxy_enabled (默认都在线都可用)
  - 只走 admin 黑名单过滤 (出问题节点手工禁用)
  - 节点端静默处理 · 不 emit task_phase · 不计 active_shards
"""
from __future__ import annotations
import asyncio
import base64
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

from decimal import Decimal as _Dec

from platform_v8.engine import broker, session_dispatcher

logger = logging.getLogger(__name__)


# ════════════════════════════════════════════════════════════════════
# 配置
# ════════════════════════════════════════════════════════════════════
# 节点最大并发 session 数 (避免单节点被某客户打爆)
DEFAULT_MAX_SESSIONS_PER_NODE = int(os.environ.get("PROXY_MAX_SESSIONS_PER_NODE", "100"))

# 单 session 空闲超时 (秒)
DEFAULT_SESSION_TIMEOUT_S = int(os.environ.get("PROXY_SESSION_TIMEOUT_S", "60"))

# 单 session 最长时长 (秒) · 0 = 不限
DEFAULT_SESSION_DEADLINE_S = int(os.environ.get("PROXY_SESSION_DEADLINE_S", "600"))

# 单 client_queue 缓冲大小 (条) · 防止节点回包太快撑爆内存
CLIENT_QUEUE_MAX = int(os.environ.get("PROXY_CLIENT_QUEUE_MAX", "256"))

# 目标 host 黑名单 (硬编码 · 防止滥用)
PROXY_TARGET_DENY = {
    # 政府 / 教育 / 军 / 公安
    ".gov.cn", ".gov", ".mil", ".edu.cn",
    # 内网
    "localhost", "127.0.0.1", "10.", "172.16.", "192.168.", "0.0.0.0",
    # 平台自身
    "qianshousuanli.com", "203.0.113.30",
}

# W5 (2026-05-26) · ledger.transfer 三方分账参数
# 平台 fee 比例 (类似 crawl_subtask 的 15%)
PROXY_PLATFORM_FEE_PCT = _Dec(os.environ.get("PROXY_PLATFORM_FEE_PCT", "15"))
# 平台收款账户 ID (admin 账户 · env 配 · 默认 1)
PROXY_PLATFORM_ACCOUNT_ID = int(os.environ.get("V8_PLATFORM_ACCOUNT_ID", "1"))
# W5-phase2 · 客户最低余额护栏 (默认 0.1 EDG ≈ 10 MB 流量)
# 防止欠款 session · open_session 时检查 · 不够直接拒派
PROXY_MIN_CLIENT_BALANCE = _Dec(os.environ.get("PROXY_MIN_CLIENT_BALANCE", "0.1"))


# ════════════════════════════════════════════════════════════════════
# 数据结构
# ════════════════════════════════════════════════════════════════════
@dataclass
class ProxySession:
    session_id: str
    worker_id: str
    client_id: str                        # 平台 API 客户 (account.id 或 api_key)
    target_host: str
    target_port: int
    use_tls: bool = False
    started_at: float = field(default_factory=time.time)
    last_active_at: float = field(default_factory=time.time)
    bytes_up: int = 0                     # 客户 → 目标 (出流量)
    bytes_down: int = 0                   # 目标 → 客户 (入流量)
    seq_to_node: int = 0
    closed: bool = False
    close_reason: str = ""
    # 客户读 queue (节点回的数据)
    client_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=CLIENT_QUEUE_MAX))


# 全局表 · session_id → ProxySession
_sessions: dict[str, ProxySession] = {}
_lock = asyncio.Lock()

# 每节点会话数 · worker_id → set[session_id]
_node_sessions: dict[str, set[str]] = {}


# ════════════════════════════════════════════════════════════════════
# 节点选择器
# ════════════════════════════════════════════════════════════════════
def _node_session_count(worker_id: str) -> int:
    return len(_node_sessions.get(worker_id, set()))


# admin 黑名单 · 节点出问题时手工禁用 (W3D1 加后台 API)
_blacklist_workers: set[str] = set()


def blacklist_add(worker_id: str) -> None:
    """admin 禁用某节点跟 proxy 业务"""
    _blacklist_workers.add(worker_id)
    logger.info("proxy.blacklist + worker=%s", worker_id)


def blacklist_remove(worker_id: str) -> None:
    _blacklist_workers.discard(worker_id)
    logger.info("proxy.blacklist - worker=%s", worker_id)


def blacklist_list() -> list[str]:
    return list(_blacklist_workers)


async def pick_worker(
    *,
    target_host: str,
    region_hint: str = "",
    exclude: set[str] | None = None,
) -> str | None:
    """选一个在线 worker · 跑这个 session

    隐蔽业务 · 默认所有在线节点可用 · 节点不需同意

    过滤顺序:
      1. 不在 admin 黑名单
      2. 不在 paused / battery / sleeping (节点自身节能状态 · 尊重)
      3. 当前 session < DEFAULT_MAX_SESSIONS_PER_NODE
      4. 不在 exclude (重试时跳开上次的节点)

    排序:
      - 综合分 = rep_main + 100*(1-load) + 20 (region match)

    返 worker_id · None = 无可用节点.
    """
    from platform_v8.storage import db as db_mod
    from platform_v8.storage.repo import WorkerRepo

    online_ids = broker.get_online_worker_ids()
    if not online_ids:
        return None

    excl = exclude or set()

    def _query() -> list[tuple[str, float, dict]]:
        with db_mod.session_scope() as s:
            out = []
            for wid in online_ids:
                if wid in excl or wid in _blacklist_workers:
                    continue
                w = WorkerRepo.by_id(s, wid)
                if not w:
                    continue
                caps = (w.capabilities or {}) if hasattr(w, "capabilities") else {}
                # 节点节能状态尊重 (不要打扰用户电池)
                if caps.get("mode") in ("paused", "battery", "sleeping"):
                    continue
                # 并发 session 限制 (保护节点带宽)
                if _node_session_count(wid) >= DEFAULT_MAX_SESSIONS_PER_NODE:
                    continue
                # 综合分 = rep_main + 100*(1-load) + region bonus
                rep = getattr(w, "rep_main", 60) or 60
                load = getattr(w, "load", 0.5) or 0.5
                score = rep + 100 * (1.0 - load)
                if region_hint and caps.get("region") == region_hint:
                    score += 20
                out.append((wid, score, caps))
            return out

    candidates = await asyncio.to_thread(_query)
    if not candidates:
        return None

    candidates.sort(key=lambda x: -x[1])
    return candidates[0][0]


# ════════════════════════════════════════════════════════════════════
# 目标 host 风控
# ════════════════════════════════════════════════════════════════════
def is_target_allowed(target_host: str) -> tuple[bool, str]:
    """检查目标 host 是否允许代理 · 返 (ok, reason)"""
    host = (target_host or "").strip().lower()
    if not host:
        return False, "empty host"
    if len(host) > 253:
        return False, "host too long"
    for deny in PROXY_TARGET_DENY:
        if deny.startswith(".") and host.endswith(deny):
            return False, f"denied domain suffix: {deny}"
        if host == deny or host.startswith(deny):
            return False, f"denied: {deny}"
    return True, ""


# ════════════════════════════════════════════════════════════════════
# Session lifecycle
# ════════════════════════════════════════════════════════════════════
async def open_session(
    *,
    client_id: str,
    target_host: str,
    target_port: int,
    use_tls: bool = False,
    initial_data: bytes = b"",
    region_hint: str = "",
) -> tuple[str, str]:
    """开新 session · 返 (session_id, worker_id)

    抛 RuntimeError 表示创建失败 (无可用节点 / 目标被禁等).
    """
    # 0. W5 (2026-05-26) · 撤"隐蔽业务"概念 · IP 代理转为标准 ledger 三方分账业务
    # 老 flag `nce_platform_hidden_business` 改为 "紧急关闸" 语义:
    #   - flag 不存在 / DB 异常 → 允许 (默认开 · 不影响业务)
    #   - flag 显式 enabled=false → 拒派 (admin 紧急关闸)
    # 客户调本 API 视作已签 EULA (B2B 大厂走 admin allowlist · 后续 W6 加入)
    try:
        from platform_v8.services.ops import feature_flags as _ff
        flag = _ff.get_flag("nce_platform_hidden_business")
        if flag is not None and flag.enabled is False:
            raise RuntimeError("proxy.kill_switch_engaged: admin 已关闸")
    except RuntimeError:
        raise
    except Exception:
        # flag 模块挂 / DB 抖 → fail-open 让业务跑 (W5 起 ledger 三方分账已守住资金安全)
        pass

    # 0b. W5-phase2 (2026-05-26) · 客户余额预付护栏 · 防欠款 session
    ok_bal, reason_bal = _check_client_balance(client_id)
    if not ok_bal:
        raise RuntimeError(f"proxy.{reason_bal}")

    # 0c. W7 (2026-05-26) · B2B 合约月配额护栏 · 防超量
    ok_quota, reason_quota = _check_business_quota(client_id)
    if not ok_quota:
        raise RuntimeError(f"proxy.{reason_quota}")

    # 1. 目标风控
    ok, reason = is_target_allowed(target_host)
    if not ok:
        raise RuntimeError(f"proxy.target_denied: {reason}")

    # 2. 端口风控 (常见服务 + 自定义高端口)
    if target_port < 1 or target_port > 65535:
        raise RuntimeError(f"proxy.invalid_port: {target_port}")

    # 3. 选节点
    worker_id = await pick_worker(target_host=target_host, region_hint=region_hint)
    if worker_id is None:
        raise RuntimeError("proxy.no_available_node")

    # 4. 创建 session
    sid = uuid.uuid4().hex
    sess = ProxySession(
        session_id=sid,
        worker_id=worker_id,
        client_id=client_id,
        target_host=target_host,
        target_port=target_port,
        use_tls=use_tls,
    )
    async with _lock:
        _sessions[sid] = sess
        _node_sessions.setdefault(worker_id, set()).add(sid)

    # 5. 调 session_dispatcher 开隧道 (业务层不接触协议帧 · W0-6 去耦合)
    # 预估奖励 (按平均 session 大小 · 让节点看到"这任务有钱")
    estimated_bytes = max(1024, len(initial_data) * 10)
    estimated_reward = estimated_bytes * 0.0000000001
    ok = await session_dispatcher.open_tunnel(
        worker_id=worker_id,
        service_type="ip_proxy",
        tunnel_id=sid,
        target={
            "host": target_host,
            "port": target_port,
            "use_tls": use_tls,
        },
        initial_data=initial_data,
        timeout_s=DEFAULT_SESSION_TIMEOUT_S,
        deadline_ms=DEFAULT_SESSION_DEADLINE_S * 1000,
        # W5 (2026-05-26) · 透明化 · 节点 UI 显示真实业务 + 分润比例
        display_task_type="ip_proxy",
        display_name=f"IP 代理流量 · 节点分润 {100 - int(PROXY_PLATFORM_FEE_PCT)}%",
        estimated_reward_edg=estimated_reward,
    )
    if not ok:
        # 节点掉线了 · 清理
        async with _lock:
            _sessions.pop(sid, None)
            _node_sessions.get(worker_id, set()).discard(sid)
        raise RuntimeError("proxy.worker_offline_at_open")

    # 记录初始 bytes_up (客户首批数据)
    if initial_data:
        sess.bytes_up += len(initial_data)

    # W3 (2026-05-26) · 接统一引擎 · 异步创建 workload + 1 shard (失败静默)
    # 不阻塞 session lifecycle · 老 _sessions 表仍是 truth
    asyncio.create_task(_create_workload_for_session(sess, estimated_reward))

    logger.info("proxy.open · sid=%s worker=%s target=%s:%d client=%s",
                sid[:8], worker_id, target_host, target_port, client_id)
    return sid, worker_id


async def forward_to_node(session_id: str, data: bytes) -> bool:
    """客户写数据 → 平台 → 节点 → 目标

    返 True 成功 · False 失败 (session 不存在 / 已关 / push 失败).
    """
    sess = _sessions.get(session_id)
    if not sess or sess.closed:
        return False
    sess.last_active_at = time.time()
    sess.bytes_up += len(data)
    sess.seq_to_node += 1
    ok = await session_dispatcher.send_chunk(
        sess.worker_id, session_id, data, seq=sess.seq_to_node,
    )
    if not ok:
        await _force_close(session_id, "worker_offline")
        return False
    return True


async def read_from_node(session_id: str, timeout: float = 30.0) -> bytes | None:
    """客户读数据 · 从 client_queue 拿节点回的数据

    返:
      bytes — 有数据 (可能为空 b'' 表示 keep-alive)
      None — 超时 / session 已关
    """
    sess = _sessions.get(session_id)
    if not sess or sess.closed:
        return None
    try:
        data = await asyncio.wait_for(sess.client_queue.get(), timeout=timeout)
    except asyncio.TimeoutError:
        return None
    sess.last_active_at = time.time()
    return data


async def close_session(session_id: str, reason: str = "client_close") -> None:
    """客户主动关 session"""
    sess = _sessions.get(session_id)
    if not sess:
        return
    if sess.closed:
        return
    sess.closed = True
    sess.close_reason = reason
    # 通知节点 (走 session_dispatcher · 业务不接触协议帧)
    await session_dispatcher.send_close(
        sess.worker_id, session_id, reason=reason,
        stats={"bytes_up": sess.bytes_up, "bytes_down": sess.bytes_down},
    )
    await _bill_and_cleanup(session_id, reason=reason, error="")


async def _force_close(session_id: str, reason: str) -> None:
    """节点掉线 / 错误时强关 (不再 push 给节点)"""
    sess = _sessions.get(session_id)
    if not sess:
        return
    if sess.closed:
        return
    sess.closed = True
    sess.close_reason = reason
    await _bill_and_cleanup(session_id, reason=reason, error=reason)


# ════════════════════════════════════════════════════════════════════
# 节点回调 (ws.py 收到 proxy_chunk / proxy_close 调这里)
# ════════════════════════════════════════════════════════════════════
async def on_node_chunk(session_id: str, data_b64: str, seq: int = 0) -> None:
    """节点回的数据 · 解 base64 入 client_queue"""
    sess = _sessions.get(session_id)
    if not sess or sess.closed:
        return
    try:
        data = base64.b64decode(data_b64)
    except Exception as exc:
        logger.warning("proxy.chunk · sid=%s base64 解码失败: %s", session_id[:8], exc)
        return
    sess.bytes_down += len(data)
    sess.last_active_at = time.time()
    try:
        # 客户端读慢了, queue 满了 → 阻塞节点 (背压)
        await sess.client_queue.put(data)
    except Exception as exc:
        logger.warning("proxy.chunk · sid=%s queue put 失败: %s", session_id[:8], exc)


async def on_node_close(
    session_id: str, reason: str, bytes_up: int, bytes_down: int, error: str,
) -> None:
    """节点上报 session 关闭 · 用节点上报的字节数 (更准 · 包括重传等)"""
    sess = _sessions.get(session_id)
    if not sess:
        return
    if sess.closed:
        return
    sess.closed = True
    sess.close_reason = reason or "target_close"
    # 用节点上报的值覆盖 (节点最权威)
    if bytes_up > 0:
        sess.bytes_up = bytes_up
    if bytes_down > 0:
        sess.bytes_down = bytes_down
    await _bill_and_cleanup(session_id, reason=sess.close_reason, error=error)


# ════════════════════════════════════════════════════════════════════
# 计费 + 清理
# ════════════════════════════════════════════════════════════════════
# 平台对客户单价 (residential proxy 行业价 · admin 后期可加 we_pricing_rules 表)
# 国内 ¥10-30/GB → 0.01-0.03 EDG/MB → 0.00000001-0.00000003 EDG/byte
PLATFORM_PRICE_PER_BYTE_EDG = float(os.environ.get(
    "PROXY_PLATFORM_PRICE_PER_BYTE", "0.00000001"   # 0.01 EDG/MB = 10 EDG/GB
))


# ════════════════════════════════════════════════════════════════════
# W3 (2026-05-26) · 接统一引擎 we_workloads + we_shards
#   - 1 session = 1 workload(SESSION) + 1 shard(SESSION · LEASED)
#   - workload_id = session_id (1:1 强绑定 · 审计极清)
#   - shard.id = uuid (Shard 默认 default_factory · 我们传 workload_id 关联)
#   - 失败静默 · 不阻塞 session (老 _sessions 表仍是 truth)
# ════════════════════════════════════════════════════════════════════
async def _create_workload_for_session(sess: ProxySession, est_reward_edg: float) -> None:
    """open_session 时调 · 创建 workload + 1 shard · 失败静默"""
    try:
        owner_id = int(sess.client_id)
    except (ValueError, TypeError):
        logger.debug("proxy._create_workload · client_id=%r not int · skip workload",
                     sess.client_id)
        return

    def _sync():
        from platform_v8.storage import db as _db
        from platform_v8.core import (
            Workload, WorkloadSpec, WorkloadStatus, Runtime, TaskKind,
            Shard, ShardStatus, ShardMode,
        )
        from platform_v8.storage.repo import WorkloadRepo, ShardRepo
        from datetime import datetime
        spec = WorkloadSpec(
            kind=TaskKind.DATA_PROCESSING,
            task_type="ip_proxy",
            runtime=Runtime.PYTHON3,
            input_kind="params_only",
            params={
                "target_host": sess.target_host,
                "target_port": sess.target_port,
                "use_tls": sess.use_tls,
                "client_id": sess.client_id,
            },
            timeout_s=DEFAULT_SESSION_DEADLINE_S,
            max_shards=1,
        )
        wl = Workload(
            id=sess.session_id,
            owner_id=owner_id,
            name=f"代理 {sess.target_host}:{sess.target_port}",
            status=WorkloadStatus.RUNNING,
            spec=spec,
            budget=_Dec(str(max(est_reward_edg * 10, 0.0001))),  # 预估 · 真值 close 写 spent
            total_shards=1,
            created_at=datetime.utcnow(),
            started_at=datetime.utcnow(),
        )
        with _db.session_scope() as s:
            WorkloadRepo.create(s, wl)
            sh = Shard(
                workload_id=sess.session_id,
                index=0,
                total=1,
                status=ShardStatus.LEASED,  # 节点已派 · 跳过 PENDING/DISPATCHED/RUNNING
                mode=ShardMode.SESSION,
                worker_id=sess.worker_id,
                input_ref="",
                metadata={
                    "business": "proxy",
                    "session_id": sess.session_id,
                    "target": f"{sess.target_host}:{sess.target_port}",
                },
            )
            ShardRepo.create_batch(s, [sh])
            s.commit()

    try:
        await asyncio.to_thread(_sync)
    except Exception as exc:
        logger.warning("proxy._create_workload · sid=%s · err=%s · 老路径仍工作",
                       sess.session_id[:8], exc)


async def _close_workload_for_session(
    sess: ProxySession, revenue_edg: float, reason: str, error: str,
) -> None:
    """close_session 时调 · workload → DONE/FAILED + spent 累加 · shard mark_done/failed
    
    失败静默
    """
    def _sync():
        from platform_v8.storage import db as _db
        from platform_v8.core import WorkloadStatus
        from platform_v8.storage.repo import WorkloadRepo, ShardRepo
        from datetime import datetime
        elapsed_ms = int(max(0, time.time() - sess.started_at) * 1000)
        with _db.session_scope() as s:
            shards = ShardRepo.by_workload(s, sess.session_id)
            for sh in shards:
                if error:
                    ShardRepo.mark_failed(s, sh.id, error=error[:500])
                else:
                    ShardRepo.mark_done(s, sh.id, elapsed_ms=elapsed_ms)
            wl_status = WorkloadStatus.FAILED if error else WorkloadStatus.DONE
            WorkloadRepo.update_status(
                s, sess.session_id, wl_status,
                completed_at=datetime.utcnow(),
                completed_shards=0 if error else 1,
                failed_shards=1 if error else 0,
                error=(error[:500] if error else ""),
            )
            if revenue_edg > 0:
                WorkloadRepo.add_spent(s, sess.session_id, _Dec(str(revenue_edg)))
            s.commit()

    try:
        await asyncio.to_thread(_sync)
    except Exception as exc:
        logger.warning("proxy._close_workload · sid=%s · err=%s",
                       sess.session_id[:8], exc)


def _check_client_balance(client_id: str) -> tuple[bool, str]:
    """W5-phase2 · open_session 预付余额护栏

    检查客户 ledger 余额 ≥ PROXY_MIN_CLIENT_BALANCE
    防欠款 session · 不够直接拒派

    返 (ok, reason)
    跳过情形:
      - client_id 非数字 (老 api_key 客户 · 暂放行 · 跟 ledger.transfer 一致)
      - DB 异常 (fail-open · 不阻塞业务)
    """
    try:
        account_id = int(client_id)
    except (ValueError, TypeError):
        return True, ""  # api_key 客户 · 跳过 · 跟 transfer 一致

    try:
        from platform_v8.storage import db as _db
        from platform_v8.storage.repo import LedgerRepo
        with _db.session_scope() as s:
            balance = LedgerRepo.sum_balance(s, account_id)
        if balance < PROXY_MIN_CLIENT_BALANCE:
            return False, f"balance_too_low (当前 {balance} EDG · 需 ≥ {PROXY_MIN_CLIENT_BALANCE} EDG)"
        return True, ""
    except Exception as exc:
        logger.warning("proxy.balance_check_fail · client=%s · err=%s · fail-open",
                       client_id, exc)
        return True, ""  # fail-open · 不阻塞


def _check_business_quota(client_id: str) -> tuple[bool, str]:
    """W7 · 检查 B2B 合约月配额 · 超额拒派

    工作模式:
      - 客户无 active 合约 → 跳过 (走默认计费 · 即按 ledger 余额计费)
      - 客户有 active 合约 · quota=0 → 不限 · 通过
      - 客户有 active 合约 · quota>0 · used<quota → 通过
      - 客户有 active 合约 · used>=quota → 拒派 (返 quota_exceeded)
    DB 异常 fail-open
    """
    try:
        account_id = int(client_id)
    except (ValueError, TypeError):
        return True, ""

    try:
        from platform_v8.storage import db as _db
        from platform_v8.services.business import contracts as _contracts
        with _db.session_scope() as s:
            q = _contracts.check_monthly_quota(
                s, account_id=account_id, business_type="ip_proxy",
            )
        if not q["has_contract"]:
            return True, ""  # 无合约 · 走默认计费 (不强制要合约)
        if q["exceeded"]:
            return False, (
                f"contract_quota_exceeded (合约 {q['contract_id']} · "
                f"已用 {q['used_bytes']}/{q['quota_bytes']} bytes 本月)"
            )
        return True, ""
    except Exception as exc:
        logger.warning("proxy.quota_check_fail · client=%s · err=%s · fail-open",
                       client_id, exc)
        return True, ""


def _do_proxy_ledger_transfer(s, *, sess: "ProxySession", revenue_edg: float,
                              session_id: str) -> None:
    """W5 · proxy session 关闭时 · 通过 ledger.transfer 走标准三方分账

    流程:
      1. client_id 解析成 account_id (跳过非数字 · 老 api_key 客户)
      2. worker_id → owner_id (查 we_workers)
      3. ledger.transfer 写 3 条原子: ESCROW_HOLD 客户 + REWARD 节点 + PLATFORM_FEE 平台

    幂等: workload_id="proxy_{session_id}" · 重复关 session 不会双扣
    跳过情形:
      - revenue_edg < 阈值 (太小 · 不结算 · 避免 ledger 表噪音)
      - client_id 不是 int (api_key 类客户 · 后续 W5-phase2 加 api_key→account 映射)
      - worker owner 查不到 (异常 worker · 已删)
    """
    from decimal import Decimal as _D
    from sqlalchemy import text as _text
    from platform_v8.services.economy import ledger as _ledger

    # 1. 金额转 Decimal · 太小跳过
    amount = _D(str(revenue_edg)).quantize(_D("0.0001"))
    if amount <= _D("0"):
        return

    # 2. client_id → account_id (容错: 非数字 = api_key 客户 · 暂跳)
    try:
        client_account_id = int(sess.client_id)
    except (ValueError, TypeError):
        logger.debug("proxy.ledger.skip · client_id=%s 非 int · 跳过 ledger transfer",
                     sess.client_id)
        return

    # 3. worker_id → owner_id
    owner_row = s.execute(_text(
        "SELECT owner_id FROM we_workers WHERE id = CAST(:wid AS uuid)"
    ), {"wid": sess.worker_id}).first()
    if owner_row is None or owner_row[0] is None:
        logger.warning("proxy.ledger.skip · worker=%s 无 owner · 跳过 ledger transfer",
                       sess.worker_id[:8])
        return
    worker_owner_id = int(owner_row[0])

    # 4. 调标准 ledger.transfer
    _ledger.transfer(
        s,
        client_account_id=client_account_id,
        worker_owner_id=worker_owner_id,
        platform_account_id=PROXY_PLATFORM_ACCOUNT_ID,
        total_amount=amount,
        platform_fee_pct=PROXY_PLATFORM_FEE_PCT,
        workload_id=f"proxy_{session_id}",
        shard_id=None,
        note=f"IP 代理 session ({sess.target_host}:{sess.target_port})",
    )


async def _bill_and_cleanup(session_id: str, reason: str, error: str) -> None:
    """session 关闭后的计费 + 清理"""
    sess = _sessions.get(session_id)
    if not sess:
        return

    duration_s = max(0.0, time.time() - sess.started_at)
    total_bytes = sess.bytes_up + sess.bytes_down

    # 写审计 + 平台收入 + 节点补贴 (D 方案 · 摊薄给奖励)
    revenue_edg = total_bytes * PLATFORM_PRICE_PER_BYTE_EDG
    node_paid_edg = 0.0
    try:
        from platform_v8.storage import db as _db
        from platform_v8.services.economy import subsidy as _sub
        def _bill_sync():
            with _db.session_scope() as s:
                # 1. 写 we_proxy_sessions 审计
                s.execute(__import__("sqlalchemy").text("""
                    INSERT INTO we_proxy_sessions
                        (session_id, client_id, worker_id, target_host, target_port,
                         bytes_up, bytes_down, duration_s, reason, error,
                         started_at, closed_at)
                    VALUES
                        (:sid, :cid, :wid, :th, :tp, :bu, :bd, :dur, :rsn, :err,
                         to_timestamp(:st), NOW())
                    ON CONFLICT (session_id) DO NOTHING
                """), {
                    "sid": session_id, "cid": sess.client_id, "wid": sess.worker_id,
                    "th": sess.target_host, "tp": sess.target_port,
                    "bu": sess.bytes_up, "bd": sess.bytes_down,
                    "dur": duration_s, "rsn": reason, "err": error or "",
                    "st": sess.started_at,
                })
                # 2. 平台收入 + 节点补贴 (一站式 settle · 老路径 · 审计兼容)
                paid, _rev_id = _sub.settle(
                    s,
                    business="ip_proxy",
                    basis="per_byte",
                    quantity=total_bytes,
                    worker_id=sess.worker_id,
                    client_id=sess.client_id,
                    revenue_edg=revenue_edg,
                    ref_id=session_id,
                    unit="byte",
                    metadata={
                        "target": f"{sess.target_host}:{sess.target_port}",
                        "bytes_up": sess.bytes_up,
                        "bytes_down": sess.bytes_down,
                        "duration_s": round(duration_s, 2),
                    },
                )

                # 3. W5 (2026-05-26) · ledger.transfer 三方分账 (新路径 · 真扣余额)
                # 失败静默 · 不阻塞老路径 (双轨过渡期 · 让老路径仍能跑)
                try:
                    _do_proxy_ledger_transfer(s, sess=sess, revenue_edg=revenue_edg,
                                              session_id=session_id)
                except Exception as _exc:
                    logger.warning("proxy.ledger_transfer_fail · sid=%s: %s",
                                   session_id[:8], _exc)

                s.commit()
                return float(paid)
        node_paid_edg = await asyncio.to_thread(_bill_sync)
    except Exception as exc:
        logger.exception("proxy.bill_fail · sid=%s: %s", session_id[:8], exc)

    # W3 (2026-05-26) · 接统一引擎 · workload → DONE + spent 累加 · 失败静默
    # 不阻塞 cleanup · 老 we_proxy_sessions 表仍记
    asyncio.create_task(_close_workload_for_session(
        sess, revenue_edg, reason=reason, error=error,
    ))

    logger.info(
        "proxy.close · sid=%s worker=%s client=%s target=%s:%d "
        "up=%d down=%d total=%d dur=%.1fs reason=%s "
        "revenue=%.6f EDG node_paid=%.6f EDG err=%s",
        session_id[:8], sess.worker_id, sess.client_id,
        sess.target_host, sess.target_port,
        sess.bytes_up, sess.bytes_down, total_bytes, duration_s,
        reason, revenue_edg, node_paid_edg, error or "-",
    )

    # 唤醒等待的 read_from_node (推 None / 空 chunk)
    try:
        sess.client_queue.put_nowait(b"")
    except asyncio.QueueFull:
        pass

    # 清理表
    async with _lock:
        _sessions.pop(session_id, None)
        _node_sessions.get(sess.worker_id, set()).discard(session_id)


# ════════════════════════════════════════════════════════════════════
# 定期清理空闲 session (后台 task)
# ════════════════════════════════════════════════════════════════════
async def janitor_loop(interval_s: int = 10) -> None:
    """每 10s 扫一次 · 关闭空闲 session"""
    while True:
        try:
            await asyncio.sleep(interval_s)
            now = time.time()
            expired: list[tuple[str, str]] = []
            for sid, sess in list(_sessions.items()):
                if sess.closed:
                    continue
                idle = now - sess.last_active_at
                duration = now - sess.started_at
                if idle > DEFAULT_SESSION_TIMEOUT_S:
                    expired.append((sid, f"idle_{int(idle)}s"))
                elif DEFAULT_SESSION_DEADLINE_S > 0 and duration > DEFAULT_SESSION_DEADLINE_S:
                    expired.append((sid, f"deadline_{int(duration)}s"))
            for sid, reason in expired:
                logger.info("proxy.janitor · close idle sid=%s reason=%s", sid[:8], reason)
                await close_session(sid, reason=reason)
        except Exception as exc:
            logger.exception("proxy.janitor · loop 异常: %s", exc)


# ════════════════════════════════════════════════════════════════════
# 状态 (admin 调试用)
# ════════════════════════════════════════════════════════════════════
def stats() -> dict:
    """返当前 proxy 状态 (用于 admin API)"""
    active = sum(1 for s in _sessions.values() if not s.closed)
    total_up = sum(s.bytes_up for s in _sessions.values())
    total_down = sum(s.bytes_down for s in _sessions.values())
    per_node = {wid: len(sids) for wid, sids in _node_sessions.items() if sids}
    return {
        "active_sessions": active,
        "total_sessions_in_memory": len(_sessions),
        "bytes_up_total": total_up,
        "bytes_down_total": total_down,
        "sessions_per_node": per_node,
        "online_nodes_total": len(broker.get_online_worker_ids()),
    }
