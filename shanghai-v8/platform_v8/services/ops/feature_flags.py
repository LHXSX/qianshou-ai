"""
Feature Flag · NCE 灰度开关 (P0 基建核心)

设计要点 (考虑全链路):
  1. 双层缓存 · 极致性能:
     L1: 进程内 dict (TTL 10s) · 单次派单调用 < 1μs
     L2: Redis (TTL 30s) · 跨进程一致
     L3: DB we_feature_flags (真相源)
  2. fail-safe: 任何环节挂 · is_enabled 默认返回 False (保证不出事)
  3. 灰度一致性:
     - 按 subject_id (通常 owner_id) 一致性 hash 分桶
     - 同 owner 永远在同一桶 · 不会忽好忽坏
     - 全局 flag (subject_id=None) 走 enabled 字段
  4. rollout_filter 支持白名单 (admin 测试用):
     {"owner_ids": [1, 2, 3], "worker_ids": ["uuid1", "uuid2"]}
  5. 改 flag 后会自动 invalidate Redis · 不需重启 backend

使用示例:
  from platform_v8.services.ops import feature_flags as ff

  # 派单时检查
  if ff.is_enabled('nce_planner_use_reputation', subject_id=owner_id):
      # 走新逻辑
  else:
      # 走旧逻辑

  # admin 改 flag
  ff.update_flag('nce_planner_use_reputation', enabled=True, rollout_pct=10,
                 updated_by='pangdundun')
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass, field, asdict
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from platform_v8.storage import db as db_mod
from platform_v8.storage import kv as kv_mod

logger = logging.getLogger(__name__)


# ════════════════════════════════════════════════════════════════════════════
# 数据模型
# ════════════════════════════════════════════════════════════════════════════

@dataclass
class FeatureFlag:
    flag_name: str
    enabled: bool = False
    rollout_pct: int = 0
    rollout_filter: dict = field(default_factory=dict)
    description: str = ""
    updated_at: str = ""
    updated_by: str = "system"


# 迁移种子 + 代码里用到但未进早期 migration 的 flag
_DEFAULT_FLAGS: list[tuple[str, str]] = [
    ("nce_planner_use_reputation",
     "P1 · planner 把 reputation 加入排序 (修 P0 bug)"),
    ("nce_planner_shadow_mode",
     "P1 · 影子模式 · 算新排序但用旧排序 · 写对照日志"),
    ("nce_hw_tier_filter",
     "P2 · planner 启用硬件等级硬性过滤"),
    ("nce_hw_tier_soft_auto",
     "P2 · 难度自动推断的 hw_tier 改软排序(不硬踢)"),
    ("nce_hw_score_cron",
     "P2 · 每日 cron 重算 hw_score / hw_tier"),
    ("nce_rep_multi_dim",
     "P3 · 启用 4 子分 + 调和平均主分"),
    ("nce_rep_multi_dim_cron",
     "P3 · 每日 cron 重算 4 子分"),
    ("nce_difficulty_factor",
     "P3 · 任务难度因子参与 SUCCESS 加分"),
    ("nce_api_expose_multi_dim",
     "P3 · /api/v8/workers/{id}/reputation 返回 4 子分"),
    ("nce_capability_feedback",
     "学习型不胜任冷却 · 近窗口跑挂某 task_type 的节点暂时跳过"
     "（片级 excluded_workers 换机已始终生效，不依赖本 flag）"),
    ("nce_one_shard_per_worker",
     "一节点一片 + 按 max_shards 切片排队"),
    ("nce_trust_ws_online",
     "信任 live WS 在线 · 不被滞后的 DB status 否决"),
    ("nce_work_steal_dispatched",
     "【已默认代码开启】shard DONE 后空闲节点抢他人未开跑 DISPATCHED"),
    ("nce_work_race_running",
     "【已默认代码开启】shard DONE 后空闲节点竞速仍 RUNNING 的片 · 先回传者胜"),
    ("nce_platform_hidden_business",
     "平台自营业务总开关"),
    ("nce_business_ip_proxy",
     "IP 代理池子开关"),
    ("nce_business_geo_monitor",
     "GEO 监测子开关"),
    ("nce_business_cdn_edge",
     "CDN 边缘缓存子开关"),
]

# 本地 SQLite 联调默认打开的派单相关 flag (影子模式故意不开 · 否则仍走旧排序)
_LOCAL_NCE_ENABLE: list[str] = [
    "nce_planner_use_reputation",
    "nce_hw_tier_filter",
    "nce_hw_tier_soft_auto",
    "nce_capability_feedback",
    "nce_trust_ws_online",
    "nce_work_steal_dispatched",
    "nce_work_race_running",
]


def _dialect_name(s: Session) -> str:
    return s.get_bind().dialect.name


def _sql_json_param(dialect: str, key: str = "f") -> str:
    """Postgres 用 jsonb cast · SQLite/其他直接绑 JSON 文本。"""
    if dialect == "postgresql":
        return f"CAST(:{key} AS jsonb)"
    return f":{key}"


def _sql_now(dialect: str) -> str:
    return "NOW()" if dialect == "postgresql" else "CURRENT_TIMESTAMP"


def _parse_rollout_filter(raw: Any) -> dict:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}
    return {}


def _fmt_updated_at(raw: Any) -> str:
    if raw is None:
        return ""
    if hasattr(raw, "isoformat"):
        try:
            return raw.isoformat()
        except Exception:
            pass
    return str(raw)


def _row_to_flag(row) -> FeatureFlag:
    return FeatureFlag(
        flag_name=row[0],
        enabled=bool(row[1]),
        rollout_pct=int(row[2] or 0),
        rollout_filter=_parse_rollout_filter(row[3]),
        description=row[4] or "",
        updated_at=_fmt_updated_at(row[5]),
        updated_by=row[6] or "",
    )


# ════════════════════════════════════════════════════════════════════════════
# 缓存 · L1 进程内 (TTL 10s · 派单热路径用)
# ════════════════════════════════════════════════════════════════════════════

_L1_TTL_SEC = 10
_L1_CACHE: dict[str, tuple[float, FeatureFlag | None]] = {}


def _l1_lookup(flag_name: str) -> tuple[bool, FeatureFlag | None]:
    """返回 (是否命中, flag)；命中 None 表示已缓存“不存在”结果。"""
    entry = _L1_CACHE.get(flag_name)
    if entry is None:
        return False, None
    expires_at, flag = entry
    if time.time() >= expires_at:
        _L1_CACHE.pop(flag_name, None)
        return False, None
    return True, flag


def _l1_get(flag_name: str) -> FeatureFlag | None:
    """兼容测试/旧调用；内部读取需用 _l1_lookup 区分负缓存。"""
    return _l1_lookup(flag_name)[1]


def _l1_set(flag_name: str, flag: FeatureFlag | None) -> None:
    _L1_CACHE[flag_name] = (time.time() + _L1_TTL_SEC, flag)


def _l1_clear(flag_name: str | None = None) -> None:
    if flag_name is None:
        _L1_CACHE.clear()
    else:
        _L1_CACHE.pop(flag_name, None)


# ════════════════════════════════════════════════════════════════════════════
# 缓存 · L2 Redis (TTL 30s · 跨进程一致)
# ════════════════════════════════════════════════════════════════════════════

_L2_TTL_SEC = 30
_L2_KEY_PREFIX = "ff:"


def _l2_key(flag_name: str) -> str:
    return _L2_KEY_PREFIX + flag_name


def _l2_get(flag_name: str) -> FeatureFlag | None:
    data = kv_mod.get_json(_l2_key(flag_name))
    if data is None:
        return None
    try:
        return FeatureFlag(**data)
    except Exception:
        return None


def _l2_set(flag_name: str, flag: FeatureFlag | None) -> None:
    if flag is None:
        kv_mod.delete(_l2_key(flag_name))
    else:
        kv_mod.set_json(_l2_key(flag_name), asdict(flag), ttl_s=_L2_TTL_SEC)


# ════════════════════════════════════════════════════════════════════════════
# DB · L3 真相源
# ════════════════════════════════════════════════════════════════════════════

def _l3_get(s: Session, flag_name: str) -> FeatureFlag | None:
    row = s.execute(
        text("""
            SELECT flag_name, enabled, rollout_pct, rollout_filter,
                   description, updated_at, updated_by
            FROM we_feature_flags
            WHERE flag_name = :name
        """),
        {"name": flag_name},
    ).fetchone()
    if row is None:
        return None
    return _row_to_flag(row)


def _l3_list(s: Session, prefix: str | None = None) -> list[FeatureFlag]:
    if prefix:
        rows = s.execute(
            text("""
                SELECT flag_name, enabled, rollout_pct, rollout_filter,
                       description, updated_at, updated_by
                FROM we_feature_flags
                WHERE flag_name LIKE :pat
                ORDER BY flag_name
            """),
            {"pat": prefix + "%"},
        ).fetchall()
    else:
        rows = s.execute(
            text("""
                SELECT flag_name, enabled, rollout_pct, rollout_filter,
                       description, updated_at, updated_by
                FROM we_feature_flags
                ORDER BY flag_name
            """)
        ).fetchall()
    return [_row_to_flag(r) for r in rows]


# ════════════════════════════════════════════════════════════════════════════
# 三层联动取 flag
# ════════════════════════════════════════════════════════════════════════════

def get_flag(flag_name: str, session: Session | None = None) -> FeatureFlag | None:
    """三层缓存读: L1 → L2 → L3 · 找到任一层即返回"""
    # L1 进程内
    hit, flag = _l1_lookup(flag_name)
    if hit:
        return flag

    # L2 Redis
    flag = _l2_get(flag_name)
    if flag is not None:
        _l1_set(flag_name, flag)
        return flag

    # L3 DB (任何 DB 异常 · 返回 None · 保证 fail-safe)
    try:
        if session is not None:
            flag = _l3_get(session, flag_name)
        else:
            with db_mod.session_scope() as s:
                flag = _l3_get(s, flag_name)
    except Exception as exc:
        logger.warning("feature_flag L3 (DB) read failed flag=%s err=%s",
                       flag_name, exc)
        return None

    _l2_set(flag_name, flag)
    _l1_set(flag_name, flag)
    return flag


# ════════════════════════════════════════════════════════════════════════════
# 灰度判定 (核心 · 派单热路径)
# ════════════════════════════════════════════════════════════════════════════

def _hash_bucket(subject_id: Any) -> int:
    """一致性 hash · 同 subject 永远落同桶 [0, 99]"""
    s = str(subject_id).encode("utf-8")
    h = hashlib.md5(s).digest()
    # 取前 4 字节当 int · mod 100
    n = int.from_bytes(h[:4], "big")
    return n % 100


def is_enabled(
    flag_name: str,
    subject_id: Any = None,
    session: Session | None = None,
) -> bool:
    """
    检查 flag 对 subject_id 是否启用 (派单热路径调用)

    判定逻辑:
      1. flag 不存在 → False (fail-safe)
      2. enabled=False → False
      3. rollout_filter 白名单命中 → True
      4. rollout_pct=100 → True
      5. rollout_pct=0 → False
      6. 其他: hash(subject_id) % 100 < rollout_pct → True
      7. subject_id=None 时只看 enabled+rollout_pct=100 (用作全局 flag)
    """
    try:
        flag = get_flag(flag_name, session=session)
    except Exception as exc:
        logger.warning("feature_flag.is_enabled error flag=%s err=%s",
                       flag_name, exc)
        return False

    if flag is None or not flag.enabled:
        return False

    # 白名单优先
    if subject_id is not None and flag.rollout_filter:
        owner_ids = flag.rollout_filter.get("owner_ids") or []
        worker_ids = flag.rollout_filter.get("worker_ids") or []
        try:
            if int(subject_id) in [int(x) for x in owner_ids]:
                return True
        except (ValueError, TypeError):
            pass
        if str(subject_id) in [str(x) for x in worker_ids]:
            return True

    # 全量
    if flag.rollout_pct >= 100:
        return True
    if flag.rollout_pct <= 0:
        return False

    # subject_id 为 None 的全局 flag · 走 0/100 二值
    if subject_id is None:
        return False

    # 灰度: 一致性 hash
    return _hash_bucket(subject_id) < flag.rollout_pct


# ════════════════════════════════════════════════════════════════════════════
# 写操作 (admin 用 · 改完自动 invalidate 缓存)
# ════════════════════════════════════════════════════════════════════════════

def update_flag(
    flag_name: str,
    *,
    enabled: bool | None = None,
    rollout_pct: int | None = None,
    rollout_filter: dict | None = None,
    description: str | None = None,
    updated_by: str = "system",
    session: Session | None = None,
) -> FeatureFlag:
    """admin 改 flag · 直写 DB · 同步 invalidate L1+L2 缓存"""

    def _do(s: Session) -> FeatureFlag:
        dialect = _dialect_name(s)
        json_expr = _sql_json_param(dialect)
        now_expr = _sql_now(dialect)
        existing = _l3_get(s, flag_name)
        if existing is None:
            # 不存在则插入 · description 是必填
            if description is None:
                raise ValueError(
                    f"flag {flag_name} not exists · must provide description on create"
                )
            s.execute(
                text(f"""
                    INSERT INTO we_feature_flags
                        (flag_name, enabled, rollout_pct, rollout_filter,
                         description, updated_at, updated_by)
                    VALUES
                        (:n, :e, :p, {json_expr}, :d, {now_expr}, :u)
                """),
                {
                    "n": flag_name,
                    "e": bool(enabled) if enabled is not None else False,
                    "p": max(0, min(100, int(rollout_pct or 0))),
                    "f": _json_dumps(rollout_filter or {}),
                    "d": description,
                    "u": updated_by,
                },
            )
        else:
            # update (只改提供的字段)
            sets, params = [], {"n": flag_name, "u": updated_by}
            if enabled is not None:
                sets.append("enabled = :e")
                params["e"] = bool(enabled)
            if rollout_pct is not None:
                sets.append("rollout_pct = :p")
                params["p"] = max(0, min(100, int(rollout_pct)))
            if rollout_filter is not None:
                sets.append(f"rollout_filter = {json_expr}")
                params["f"] = _json_dumps(rollout_filter)
            if description is not None:
                sets.append("description = :d")
                params["d"] = description
            sets.append(f"updated_at = {now_expr}")
            sets.append("updated_by = :u")
            s.execute(
                text(f"UPDATE we_feature_flags SET {', '.join(sets)} "
                     "WHERE flag_name = :n"),
                params,
            )

        new_flag = _l3_get(s, flag_name)
        if new_flag is None:
            raise RuntimeError(f"flag {flag_name} write succeeded but read-back failed")
        return new_flag

    if session is not None:
        result = _do(session)
    else:
        with db_mod.session_scope() as s:
            result = _do(s)
            s.commit()

    # invalidate
    _l1_clear(flag_name)
    _l2_set(flag_name, None)

    logger.info(
        "feature_flag updated · name=%s enabled=%s pct=%d by=%s",
        flag_name, result.enabled, result.rollout_pct, updated_by,
    )
    return result


def seed_default_flags(session: Session) -> int:
    """插入缺失的默认 flag 行 (enabled=False) · 已存在不覆盖。返新插入条数。"""
    dialect = _dialect_name(session)
    json_expr = _sql_json_param(dialect)
    now_expr = _sql_now(dialect)
    if dialect == "sqlite":
        insert_sql = f"""
            INSERT OR IGNORE INTO we_feature_flags
                (flag_name, enabled, rollout_pct, rollout_filter,
                 description, updated_at, updated_by)
            VALUES
                (:n, 0, 0, {json_expr}, :d, {now_expr}, 'system')
        """
    else:
        insert_sql = f"""
            INSERT INTO we_feature_flags
                (flag_name, enabled, rollout_pct, rollout_filter,
                 description, updated_at, updated_by)
            VALUES
                (:n, FALSE, 0, {json_expr}, :d, {now_expr}, 'system')
            ON CONFLICT (flag_name) DO NOTHING
        """
    inserted = 0
    for name, desc in _DEFAULT_FLAGS:
        before = _l3_get(session, name)
        session.execute(
            text(insert_sql),
            {"n": name, "f": "{}", "d": desc},
        )
        if before is None and _l3_get(session, name) is not None:
            inserted += 1
    return inserted


def enable_local_nce_flags(session: Session) -> list[str]:
    """本地联调：把派单相关 NCE flag 全量打开 (rollout_pct=100)。"""
    turned_on: list[str] = []
    for name in _LOCAL_NCE_ENABLE:
        existing = _l3_get(session, name)
        desc = existing.description if existing else next(
            (d for n, d in _DEFAULT_FLAGS if n == name), name
        )
        update_flag(
            name,
            enabled=True,
            rollout_pct=100,
            description=desc or name,
            updated_by="local_sqlite_bootstrap",
            session=session,
        )
        turned_on.append(name)
    return turned_on


def bootstrap_sqlite_flags(engine: Engine) -> None:
    """SQLite 本地 bootstrap: 建表后种子 flag；默认打开派单 NCE 项。

    环境变量:
      V8_LOCAL_ENABLE_NCE_FLAGS=0  → 只种子、保持 OFF (贴近生产默认)
      未设或其它值               → 打开 _LOCAL_NCE_ENABLE 列表
    """
    enable = os.environ.get("V8_LOCAL_ENABLE_NCE_FLAGS", "1") != "0"
    with Session(engine) as s:
        n = seed_default_flags(s)
        on: list[str] = []
        if enable:
            on = enable_local_nce_flags(s)
        s.commit()
    invalidate_all()
    logger.warning(
        "sqlite feature_flags bootstrap · seeded=%d · local_nce_on=%s",
        n, on if enable else "(skipped)",
    )


def list_flags(prefix: str | None = None,
               session: Session | None = None) -> list[FeatureFlag]:
    """列出所有 flag (admin 用)"""
    if session is not None:
        return _l3_list(session, prefix)
    with db_mod.session_scope() as s:
        return _l3_list(s, prefix)


def invalidate_all() -> None:
    """admin 触发 · 清所有缓存 (改了又改 · 急用时)"""
    _l1_clear()
    # L2 不批量删 (Redis pattern delete 风险) · 等 TTL 自然过期


# ════════════════════════════════════════════════════════════════════════════
# 工具
# ════════════════════════════════════════════════════════════════════════════

def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)
