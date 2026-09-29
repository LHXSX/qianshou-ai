"""
异步扫描任务队列 (持久化 · 基于 we_kv) · §5.6 续

为啥用 we_kv 而非新表:
  1. 避免迁移成本 · 0 SQL 变更即可上线
  2. value JSON 字段已支持 · 写入/查询都简单
  3. expires_at 自带 · TTL 24h 自动清理
  4. 量级合理 (单租户 < 1k 待扫/分钟 · 远低于 we_kv 设计上限)

key 规范:
  scanjob:{job_id}        → 单作业状态 (含 result)
  scanjob_idx:{ts}:{job}  → 时序索引 (worker poll 用 · 后续可拆 redis)

状态机:
  pending → scanning → done (verdict in clean/skipped/suspicious/infected/error)
  pending → expired (超 24h 未拉)

调用方:
  enqueue(s, ...)        · oss.py POST /scan
  claim_next(s, limit)   · scan_worker 拉
  mark_result(s, ...)    · scan_worker 写
  get_status(s, job_id)  · oss.py GET /scan/{id}
"""
from __future__ import annotations
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# ── 常量 ────────────────────────────────────────────────────────
STATUS_PENDING = "pending"
STATUS_SCANNING = "scanning"
STATUS_DONE = "done"
STATUS_EXPIRED = "expired"

_JOB_PREFIX = "scanjob:"
_TTL_HOURS = 24


@dataclass
class ScanJob:
    job_id: str
    object_key: str
    account_id: int
    task_id: int | str
    status: str
    enable_virus: bool = True
    enable_sensitive: bool = True
    created_at: str = ""
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    result: Optional[dict] = None        # ScanResult.to_dict() · status=done 才有
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "object_key": self.object_key,
            "account_id": self.account_id,
            "task_id": self.task_id,
            "status": self.status,
            "enable_virus": self.enable_virus,
            "enable_sensitive": self.enable_sensitive,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "result": self.result,
            "error": self.error,
        }


# ── 内部: kv 读写 ─────────────────────────────────────────────
def _now_iso() -> str:
    return datetime.utcnow().isoformat()


def _kv_get(s: Session, k: str) -> Optional[dict]:
    row = s.execute(text("SELECT v FROM we_kv WHERE k = :k"), {"k": k}).fetchone()
    if row is None:
        return None
    v = row.v
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return None
    return v if isinstance(v, dict) else None


def _kv_set(s: Session, k: str, v: dict, ttl_hours: int = _TTL_HOURS) -> None:
    expires = datetime.utcnow() + timedelta(hours=ttl_hours)
    now = datetime.utcnow()
    # Postgres ON CONFLICT · sqlite 用 INSERT OR REPLACE 也行 (we_kv pk 是 k)
    # 先 UPDATE · 0 行影响则 INSERT (兼容两种 db)
    n = s.execute(text("""
        UPDATE we_kv SET v = :v, expires_at = :e, updated_at = :u WHERE k = :k
    """), {"v": v, "e": expires, "u": now, "k": k}).rowcount
    if not n:
        s.execute(text("""
            INSERT INTO we_kv (k, v, expires_at, updated_at)
            VALUES (:k, :v, :e, :u)
        """), {"k": k, "v": v, "e": expires, "u": now})
    s.flush()


# ── 对外: enqueue ────────────────────────────────────────────
def enqueue(
    s: Session,
    *,
    object_key: str,
    account_id: int,
    task_id: int | str = 0,
    enable_virus: bool = True,
    enable_sensitive: bool = True,
) -> str:
    job_id = uuid.uuid4().hex[:16]
    job = ScanJob(
        job_id=job_id,
        object_key=object_key,
        account_id=account_id,
        task_id=task_id,
        status=STATUS_PENDING,
        enable_virus=enable_virus,
        enable_sensitive=enable_sensitive,
        created_at=_now_iso(),
    )
    _kv_set(s, f"{_JOB_PREFIX}{job_id}", job.to_dict())
    logger.info("scan_queue.enqueue · job=%s key=%s account=%s", job_id, object_key, account_id)
    return job_id


# ── 对外: get_status ─────────────────────────────────────────
def get_status(s: Session, job_id: str) -> Optional[ScanJob]:
    d = _kv_get(s, f"{_JOB_PREFIX}{job_id}")
    if d is None:
        return None
    try:
        return ScanJob(**{k: d.get(k) for k in ScanJob.__dataclass_fields__})
    except Exception as exc:
        logger.warning("scan_queue.get_status decode failed: %s", exc)
        return None


# ── 对外: worker claim · 简单版 (单 worker · 抓 limit 个 pending) ────
def claim_next(s: Session, limit: int = 5) -> list[ScanJob]:
    """
    1. SELECT pending jobs LIMIT N
    2. UPDATE → status=scanning + started_at
    3. 返回 ScanJob[]

    并发安全: 当前实现单 worker 跑即可 (避免抢锁). 多 worker 需 SELECT FOR UPDATE
    SKIP LOCKED (Postgres) · sqlite 不支持 · 不在 MVP 范围.
    """
    # Postgres JSON 操作符: v->>'status' = 'pending'
    # sqlite 兼容: 退化为全扫. 当前生产环境是 Postgres · 优先用 jsonb 操作.
    try:
        rows = s.execute(text(f"""
            SELECT k, v FROM we_kv
            WHERE k LIKE :p AND v->>'status' = :st
            ORDER BY (v->>'created_at')
            LIMIT :n
        """), {"p": f"{_JOB_PREFIX}%", "st": STATUS_PENDING, "n": limit}).fetchall()
    except Exception:
        # sqlite 兜底
        rows = s.execute(text("""
            SELECT k, v FROM we_kv WHERE k LIKE :p
        """), {"p": f"{_JOB_PREFIX}%"}).fetchall()
        rows = [r for r in rows if (isinstance(r.v, dict) and r.v.get("status") == STATUS_PENDING)
                                  or (isinstance(r.v, str) and '"pending"' in r.v)]
        rows = rows[:limit]

    claimed: list[ScanJob] = []
    for r in rows:
        d = r.v if isinstance(r.v, dict) else (json.loads(r.v) if isinstance(r.v, str) else {})
        if not d or d.get("status") != STATUS_PENDING:
            continue
        d["status"] = STATUS_SCANNING
        d["started_at"] = _now_iso()
        _kv_set(s, r.k, d)
        try:
            claimed.append(ScanJob(**{k: d.get(k) for k in ScanJob.__dataclass_fields__}))
        except Exception:
            continue
    return claimed


# ── 对外: mark_result ────────────────────────────────────────
def mark_result(
    s: Session,
    job_id: str,
    *,
    result: dict | None = None,
    error: str = "",
) -> None:
    d = _kv_get(s, f"{_JOB_PREFIX}{job_id}")
    if d is None:
        logger.warning("mark_result · job %s 不存在 (可能已过期)", job_id)
        return
    d["status"] = STATUS_DONE
    d["completed_at"] = _now_iso()
    d["result"] = result
    d["error"] = error
    _kv_set(s, f"{_JOB_PREFIX}{job_id}", d)
    logger.info("scan_queue.mark_result · job=%s verdict=%s",
                job_id, (result or {}).get("verdict"))


# ── 队列统计 (admin 用 · 后续可加 endpoint) ────────────────────
def queue_stats(s: Session) -> dict[str, int]:
    """返回 {pending, scanning, done} 计数"""
    try:
        rows = s.execute(text(f"""
            SELECT v->>'status' AS st, COUNT(*) AS n
            FROM we_kv WHERE k LIKE :p
            GROUP BY v->>'status'
        """), {"p": f"{_JOB_PREFIX}%"}).fetchall()
        return {r.st: int(r.n) for r in rows if r.st}
    except Exception:
        # sqlite 兜底
        rows = s.execute(text("SELECT v FROM we_kv WHERE k LIKE :p"),
                         {"p": f"{_JOB_PREFIX}%"}).fetchall()
        counts: dict[str, int] = {}
        for r in rows:
            d = r.v if isinstance(r.v, dict) else (json.loads(r.v) if isinstance(r.v, str) else {})
            st = d.get("status") if isinstance(d, dict) else None
            if st:
                counts[st] = counts.get(st, 0) + 1
        return counts
