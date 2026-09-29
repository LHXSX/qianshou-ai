"""
§5.6 扫描队列闭环单测 · 2026-05-21
─────────────────────────────────────────────────────────────────────────
覆盖: enqueue → get_status(pending) → claim_next(scanning) → mark_result(done)
     → queue_stats 统计正确

策略: 用 sqlite in-memory + monkey-patch _kv_set/_kv_get 处理 JSON
     (生产是 Postgres JSONB 自动转 · sqlite TEXT 列需手动 json.dumps)

跑法:
  pytest platform_v8/tests/services/test_scan_queue.py -v
  或 python platform_v8/tests/services/test_scan_queue.py  (standalone)
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

# 让 import 找到 platform_v8 (standalone 跑时)
_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, Session

from platform_v8.services import scan_queue as sq


# ── fixture: sqlite + we_kv 表 + JSON-aware _kv helpers ──
def _make_sqlite_session() -> Session:
    eng = create_engine("sqlite:///:memory:", future=True)
    with eng.begin() as con:
        con.execute(text("""
            CREATE TABLE we_kv (
                k TEXT PRIMARY KEY,
                v TEXT NOT NULL,
                expires_at TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """))
    Sess = sessionmaker(bind=eng, autoflush=False, expire_on_commit=False, future=True)
    return Sess()


def _patch_json_kv():
    """sqlite TEXT 列需把 dict → json.dumps · 读时 json.loads · 替换 scan_queue 内部 helpers"""
    from datetime import datetime, timedelta

    def kv_set_json(s: Session, k: str, v: dict, ttl_hours: int = sq._TTL_HOURS) -> None:
        v_json = json.dumps(v, ensure_ascii=False)
        expires = datetime.utcnow() + timedelta(hours=ttl_hours)
        now = datetime.utcnow()
        n = s.execute(text(
            "UPDATE we_kv SET v=:v, expires_at=:e, updated_at=:u WHERE k=:k"
        ), {"v": v_json, "e": expires, "u": now, "k": k}).rowcount
        if not n:
            s.execute(text(
                "INSERT INTO we_kv (k,v,expires_at,updated_at) VALUES (:k,:v,:e,:u)"
            ), {"k": k, "v": v_json, "e": expires, "u": now})
        s.flush()

    def kv_get_json(s: Session, k: str):
        row = s.execute(text("SELECT v FROM we_kv WHERE k=:k"), {"k": k}).fetchone()
        if row is None:
            return None
        try:
            return json.loads(row.v)
        except Exception:
            return None

    sq._kv_set = kv_set_json
    sq._kv_get = kv_get_json


# ── tests ────────────────────────────────────────────────────
def test_full_cycle():
    """enqueue → pending → claim → scanning → mark → done · 全链路"""
    _patch_json_kv()
    s = _make_sqlite_session()

    # 1. enqueue
    job_id = sq.enqueue(s, object_key="oss/test/foo.pdf", account_id=42, task_id=99)
    assert job_id and len(job_id) == 16

    # 2. status = pending
    job = sq.get_status(s, job_id)
    assert job is not None
    assert job.status == sq.STATUS_PENDING
    assert job.object_key == "oss/test/foo.pdf"
    assert job.account_id == 42
    assert job.task_id == 99

    # 3. claim → scanning
    claimed = sq.claim_next(s, limit=10)
    assert len(claimed) == 1
    assert claimed[0].job_id == job_id
    assert claimed[0].status == sq.STATUS_SCANNING

    # 4. 第二次 claim 应该空 (已被 scanning 占走)
    claimed2 = sq.claim_next(s, limit=10)
    assert len(claimed2) == 0, "scanning 状态不应被重复 claim"

    # 5. mark_result → done
    sq.mark_result(s, job_id, result={
        "verdict": "clean",
        "threats": [],
        "sensitive_matches": [],
    }, error="")
    job = sq.get_status(s, job_id)
    assert job is not None
    assert job.status == sq.STATUS_DONE
    assert job.result is not None
    assert job.result["verdict"] == "clean"

    print("  ✓ test_full_cycle")


def test_queue_stats():
    """投 3 个 · claim 1 个 · done 1 个 · 剩 1 pending + 1 scanning + 1 done"""
    _patch_json_kv()
    s = _make_sqlite_session()

    j1 = sq.enqueue(s, object_key="k1", account_id=1)
    j2 = sq.enqueue(s, object_key="k2", account_id=1)
    j3 = sq.enqueue(s, object_key="k3", account_id=1)

    # claim 1 → scanning
    claimed = sq.claim_next(s, limit=1)
    assert len(claimed) == 1
    scanning_id = claimed[0].job_id

    # 另一个再 claim 后立即 done
    claimed2 = sq.claim_next(s, limit=1)
    assert len(claimed2) == 1
    sq.mark_result(s, claimed2[0].job_id, result={"verdict": "clean"})

    stats = sq.queue_stats(s)
    # 剩 1 pending · 1 scanning · 1 done
    assert stats.get(sq.STATUS_PENDING, 0) == 1, f"pending 应该 1 · 实际 {stats}"
    assert stats.get(sq.STATUS_SCANNING, 0) == 1, f"scanning 应该 1 · 实际 {stats}"
    assert stats.get(sq.STATUS_DONE, 0) == 1, f"done 应该 1 · 实际 {stats}"

    # 防止 unused 警告
    _ = j1, j2, j3, scanning_id
    print("  ✓ test_queue_stats")


def test_get_status_missing():
    """不存在的 job_id 应返回 None · 不抛"""
    _patch_json_kv()
    s = _make_sqlite_session()
    assert sq.get_status(s, "nonexistent") is None
    print("  ✓ test_get_status_missing")


def test_mark_result_missing_safe():
    """mark 不存在的 job_id 应静默 log 不抛 (worker 可能误删)"""
    _patch_json_kv()
    s = _make_sqlite_session()
    sq.mark_result(s, "nonexistent", result={"verdict": "clean"})
    print("  ✓ test_mark_result_missing_safe")


# ── standalone runner ────────────────────────────────────────
if __name__ == "__main__":
    print("§5.6 scan_queue 闭环单测 · 2026-05-21")
    print("─" * 50)
    test_full_cycle()
    test_queue_stats()
    test_get_status_missing()
    test_mark_result_missing_safe()
    print("─" * 50)
    print("✓ 全部通过")
