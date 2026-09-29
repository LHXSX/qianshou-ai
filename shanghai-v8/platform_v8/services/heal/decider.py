"""
services/heal/decider.py · 后端自愈决策器 (2026-06-05)

职责:
  1. maybe_dispatch_heal: 节点 env 失败钩子 → 累计达阈 → 决策 action → 下发 control 帧
  2. record_control_result: 节点回报 control 执行结果 → 记 we_node_repairs + 维护去重

安全/防风暴铁律:
  - 全 flag 门控 nce_backend_heal · 默认 OFF · OFF 时全部 no-op (零回归)
  - 只下发白名单 action (经 ws_schema.build_control 校验)
  - Redis 去重: 同 (worker, action) 冷却窗口内只下发一次 · 防指令风暴
  - 客户端本地自愈仍是第一道防线 · 后端是增强/兜底
  - 依赖向内: 用 Redis(kv) + broker.push_to_worker · Redis 挂 → 降级不下发 (不阻塞主链路)
"""
from __future__ import annotations

import logging
import time
import uuid

logger = logging.getLogger(__name__)

_FLAG = "nce_backend_heal"

# Redis 去重 key: 同 worker 同 action 在窗口内只下发一次
_SENT_PREFIX = "v8:heal:sent:"      # v8:heal:sent:<worker>:<action>
# env 失败累计: 达阈才下发后端修复 (给客户端本地自愈先尝试的机会)
_FAIL_PREFIX = "v8:heal:envfail:"   # v8:heal:envfail:<worker>:<tier_or_dep>

ENVFAIL_THRESHOLD = 2               # 同节点同目标 env 失败 N 次 → 后端介入下发修复
FAIL_WINDOW_S = 1800                # 失败累计滑窗 (30 min)
SENT_COOLDOWN_S = 1800             # 同 worker+action 下发冷却 (30 min · 防风暴)


def enabled() -> bool:
    try:
        from platform_v8.services.ops import feature_flags as ff
        return ff.is_enabled(_FLAG, subject_id=None)
    except Exception:
        return False


def _redis():
    try:
        from platform_v8.storage import kv as kv_mod
        return kv_mod.get_redis()
    except Exception:
        return None


def _decide_action(failure_class: str, missing_dep: str, required_tier: str) -> tuple[str, dict] | None:
    """根据失败类别决策一条白名单修复指令。返回 (action, params) 或 None(不处理)。

    决策原则 (保守 · 从轻到重):
      - env_broken_venv  → fix_venv_cfg (修 pyvenv.cfg CI 路径 · 全局无副作用 · Win 头号根因)
      - env_missing_pkg  → reinstall_tier (带 tier/missing_dep · 客户端定位 tier 重装)
      - env_missing_tool → reinstall_tier (同上 · 缺 ffmpeg/blender 等)
      - 其他 (resource/script/timeout/unknown) → None (非环境问题 · 自愈无意义)
    """
    if failure_class == "env_broken_venv":
        return ("fix_venv_cfg", {})
    if failure_class in ("env_missing_pkg", "env_missing_tool"):
        params: dict = {}
        if required_tier:
            params["tier"] = required_tier
        if missing_dep:
            params["missing_dep"] = missing_dep
        # tier 与 missing_dep 都没有 → 退回 reprobe (让节点重探测 · 配合本地自愈)
        if not params:
            return ("reprobe", {})
        return ("reinstall_tier", params)
    return None


def _heal_target(failure_class: str, missing_dep: str, required_tier: str) -> str:
    """去重/累计用的目标标识 (tier 优先 · 否则 dep · 否则 class)。"""
    return required_tier or missing_dep or failure_class


async def maybe_dispatch_heal(
    worker_id: str | None,
    task_type: str | None,
    failure_class: str,
    missing_dep: str = "",
    required_tier: str = "",
) -> None:
    """env 失败钩子 (aggregator.on_shard_failed 调) · 决策并下发 control。

    OFF / 无 worker / 非 env 失败 / Redis 挂 → no-op。不抛错 (绝不阻塞主链路)。
    """
    if not enabled() or not worker_id or not failure_class.startswith("env_"):
        return
    try:
        r = _redis()
        if r is None:
            return
        target = _heal_target(failure_class, missing_dep, required_tier)

        # 1. 累计失败 · 达阈才介入 (给客户端本地自愈先试的机会)
        fk = f"{_FAIL_PREFIX}{worker_id}:{target}"
        n = int(r.incr(fk) or 1)
        if n == 1:
            r.expire(fk, FAIL_WINDOW_S)
        if n < ENVFAIL_THRESHOLD:
            return

        # 2. 决策 action
        decided = _decide_action(failure_class, missing_dep, required_tier)
        if decided is None:
            return
        action, params = decided

        # 3. 去重: 同 worker+action 冷却窗口内只发一次
        sk = f"{_SENT_PREFIX}{worker_id}:{action}"
        # set nx · 已存在则跳过 (返回 None/False)
        if not r.set(sk, "1", ex=SENT_COOLDOWN_S, nx=True):
            logger.debug("heal · worker=%s action=%s 冷却中 · 跳过下发", str(worker_id)[:8], action)
            return

        # 4. 下发 control 帧
        from platform_v8.protocol import ws_schema as wsp
        control_id = uuid.uuid4().hex
        reason = f"后端自愈: {failure_class} (target={target}, 累计{n}次)"
        frame = wsp.build_control(
            control_id=control_id,
            action=action,
            params=params,
            reason=reason,
            expires_at_ms=int((time.time() + 600) * 1000),  # 10min 内有效 · 防重放
        )
        from platform_v8.engine import broker
        ok = await broker.push_to_worker(worker_id, frame, source="heal")
        # 记一条 pending (回报时更新 ok)
        _record(worker_id, control_id, action, ok=None,
                detail=f"dispatched reason={reason} delivered={ok}")
        logger.warning("heal · 下发 control · worker=%s action=%s params=%s delivered=%s",
                       str(worker_id)[:8], action, params, ok)
    except Exception as exc:
        logger.debug("heal.maybe_dispatch_heal skip: %s", exc)


def record_control_result(
    worker_id: str, control_id: str, action: str, ok: bool, detail: str = ""
) -> None:
    """节点回报 control 执行结果 (ws.py 收 control_result 调)。
    记 we_node_repairs · 失败时解除下发去重 (允许重试别的修复)。"""
    try:
        _record(worker_id, control_id, action, ok=ok, detail=detail)
        # 执行失败 → 解去重 · 允许后续换别的 action 再试
        if not ok:
            r = _redis()
            if r is not None:
                r.delete(f"{_SENT_PREFIX}{worker_id}:{action}")
        else:
            # 成功 → 清该 worker 的 env 失败累计 (容忍偶发)
            r = _redis()
            if r is not None:
                for k in r.scan_iter(f"{_FAIL_PREFIX}{worker_id}:*"):
                    r.delete(k)
    except Exception as exc:
        logger.debug("heal.record_control_result skip: %s", exc)


def _record(worker_id: str, control_id: str, action: str, ok: bool | None, detail: str) -> None:
    """写 we_node_repairs (best-effort · 表不存在/DB 挂 → 静默)。"""
    try:
        from platform_v8.storage import db as db_mod
        from sqlalchemy import text as _text
        with db_mod.session_scope() as s:
            s.execute(_text(
                "INSERT INTO we_node_repairs (worker_id, control_id, action, ok, detail) "
                "VALUES (CAST(:w AS uuid), :cid, :act, :ok, :det) "
                "ON CONFLICT (control_id) DO UPDATE SET ok=EXCLUDED.ok, detail=EXCLUDED.detail, updated_at=NOW()"
            ), {"w": worker_id, "cid": control_id, "act": action, "ok": ok, "det": detail[:2000]})
            s.commit()
    except Exception as exc:
        logger.debug("heal._record skip (表可能未建): %s", exc)
