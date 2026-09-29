"""
管理后台·进阶 endpoints · /api/v8/admin/v2/*

2026-05-25 新增 · 配合 admin 桌面端进阶功能
  GET  /reputation-history/{worker_id}    信誉变化时间线 (从 we_audit 推)
  GET  /anti-cheat/events                  反作弊事件 (冗余任务 shards 对比)
  POST /db/query                           DB SQL 沙盒 (仅 SELECT)
  WS   /logs/stream                        实时日志流 (journalctl tail)

设计要点:
  - 所有接口都强制 admin 权限
  - SQL 沙盒只读 · 拦截 INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/COPY/GRANT
  - 日志流用 WS · 后端 spawn journalctl -fn 转推 (生产环境用 systemd-journal)
  - 反作弊事件: 找 redundancy_factor>1 的任务 + 副本结果差异
"""
from __future__ import annotations
import asyncio
import logging
import re
import shlex
import subprocess
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session
from platform_v8.api.v8.admin_v2 import require_admin
from platform_v8.core import Account
from platform_v8.services.auth import validation as auth_validation

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/admin/v2", tags=["admin-advanced"])


# ════════════════════════════════════════════════════════════════════
# ① 信誉变化历史 · 从 we_audit 推
# ════════════════════════════════════════════════════════════════════
@router.get("/reputation-history/{worker_id}")
def reputation_history(
    worker_id: str,
    days: int = Query(30, ge=1, le=365),
    session: Session = Depends(get_session),
    _adm: Account = Depends(require_admin),
) -> dict:
    """返回该节点最近 N 天信誉变化事件 (audit 推)"""
    cutoff = datetime.utcnow() - timedelta(days=days)
    rows = session.execute(text("""
        SELECT created_at, action, detail
        FROM we_audit
        WHERE target_id = :wid
          AND created_at >= :cutoff
          AND (action LIKE '%reputation%' OR action LIKE 'worker.%')
        ORDER BY created_at
    """), {"wid": worker_id, "cutoff": cutoff}).mappings().all()

    events = []
    for r in rows:
        d = dict(r["detail"] or {})
        events.append({
            "at": r["created_at"].isoformat() if r["created_at"] else None,
            "action": r["action"],
            "old": d.get("old"),
            "new": d.get("new") or d.get("reputation"),
            "reason": d.get("reason") or d.get("event"),
            "detail": d,
        })
    return {"worker_id": worker_id, "days": days, "events": events, "count": len(events)}


# ════════════════════════════════════════════════════════════════════
# ② 反作弊事件 · 冗余任务结果对比
# ════════════════════════════════════════════════════════════════════
@router.get("/anti-cheat/events")
def anti_cheat_events(
    limit: int = Query(50, ge=1, le=500),
    session: Session = Depends(get_session),
    _adm: Account = Depends(require_admin),
) -> dict:
    """
    返回最近的冗余任务 + 它们的 shards 一致性
      包括:
        - workload_id / task_type / redundancy_factor
        - shard 组列表 (按 metadata.replica_of 分组 · output_ref 比对)
        - 一致性 = 同组 shards output_ref hash 是否全相等
    """
    rows = session.execute(text("""
        SELECT w.id, w.name, w.spec, w.status, w.created_at
        FROM we_workloads w
        WHERE (w.spec->>'redundancy_factor')::int > 1
        ORDER BY w.created_at DESC
        LIMIT :lim
    """), {"lim": limit}).mappings().all()

    events = []
    for w in rows:
        spec = dict(w["spec"] or {})
        # 查 shards · 按 replica_of 分组
        shards = session.execute(text("""
            SELECT id, index, status, worker_id, output_ref, metadata
            FROM we_shards
            WHERE workload_id = :wid
        """), {"wid": w["id"]}).mappings().all()

        groups: dict = {}
        for sh in shards:
            meta = dict(sh["metadata"] or {})
            canonical = meta.get("replica_of") or sh["id"]
            groups.setdefault(str(canonical), []).append({
                "shard_id": sh["id"], "worker_id": sh["worker_id"],
                "status": sh["status"], "output_ref": sh["output_ref"],
                "replica_index": meta.get("replica_index", 0),
            })

        mismatch_groups = 0
        consistent_groups = 0
        for g in groups.values():
            done = [s for s in g if s["status"] == "DONE"]
            if len(done) < 2:
                continue
            outs = {s["output_ref"] for s in done if s["output_ref"]}
            if len(outs) > 1:
                mismatch_groups += 1
            else:
                consistent_groups += 1

        events.append({
            "workload_id": w["id"],
            "name": w["name"],
            "task_type": spec.get("task_type"),
            "redundancy": spec.get("redundancy_factor", 1),
            "status": w["status"],
            "created_at": w["created_at"].isoformat() if w["created_at"] else None,
            "groups_total": len(groups),
            "consistent": consistent_groups,
            "mismatch": mismatch_groups,
            "anti_cheat_ok": mismatch_groups == 0,
            "shard_groups": list(groups.values()),
        })
    return {"events": events, "total": len(events)}


# ════════════════════════════════════════════════════════════════════
# ③ SQL 沙盒 · 只读 SELECT
# ════════════════════════════════════════════════════════════════════
_FORBIDDEN_KW = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|COPY|GRANT|REVOKE|CREATE|VACUUM|"
    r"REINDEX|CLUSTER|EXECUTE|CALL|DO|NOTIFY|LISTEN|UNLISTEN)\b",
    re.IGNORECASE,
)


class SqlIn(BaseModel):
    sql: str = Field(..., min_length=3, max_length=5000)
    limit: int = Field(200, ge=1, le=1000)


@router.post("/db/query")
def db_query(
    body: SqlIn,
    session: Session = Depends(get_session),
    adm: Account = Depends(require_admin),
) -> dict:
    """
    只读 SQL 沙盒 · 仅允许 SELECT · 自动加 LIMIT · 审计每一次查询

    安全检查:
      1. 必须以 SELECT 或 WITH (CTE) 开头
      2. 拦截危险关键字 INSERT/UPDATE/DELETE/DROP/...
      3. 包成 SUBQUERY 自动套 LIMIT N
      4. 5 秒超时
    """
    sql = body.sql.strip().rstrip(";")
    sql_upper = sql.upper().lstrip()
    if not (sql_upper.startswith("SELECT") or sql_upper.startswith("WITH")):
        raise HTTPException(400, "仅支持 SELECT 或 WITH 起头")
    m = _FORBIDDEN_KW.search(sql)
    if m:
        raise HTTPException(400, f"拒绝执行: 包含禁用关键字 {m.group(0)}")

    # 套 LIMIT
    if "LIMIT" not in sql_upper:
        sql = f"SELECT * FROM ({sql}) AS _sandbox LIMIT {body.limit}"

    # 审计
    logger.info("sql_console · admin=%s sql=%r", adm.id, body.sql[:200])

    try:
        # 5s 超时
        session.execute(text("SET LOCAL statement_timeout = '5s'"))
        result = session.execute(text(sql))
        columns = list(result.keys())
        rows = [list(r) for r in result.fetchall()]
        # 转 str 防 datetime/uuid JSON 不可序列化
        rows_str = [[str(c) if c is not None else None for c in row] for row in rows]
        session.rollback()  # 即使 SELECT 也 rollback · 不留任何痕迹
        return {"ok": True, "columns": columns, "rows": rows_str, "count": len(rows)}
    except Exception as e:
        session.rollback()
        raise HTTPException(400, f"SQL 错: {e}")


# ════════════════════════════════════════════════════════════════════
# ④ 实时日志流 · WS · journalctl 转推
# ════════════════════════════════════════════════════════════════════
@router.websocket("/logs/stream")
async def logs_stream(ws: WebSocket):
    """
    管理员实时日志流 · 默认 tail edge-backend systemd journal

    协议:
      Client → {token: <access_token>, service?: "edge-backend", lines?: 50}
      Server ← {ok: true, type: "ready"}
      Server ← {type: "log", line: "..."} × N (持续推)

    安全:
      - 必须 admin token
      - service 名白名单: edge-backend / edge-frontend
      - lines 上限 200
    """
    await ws.accept()
    try:
        raw = await asyncio.wait_for(ws.receive_json(), timeout=10)
        token = raw.get("token", "")
        service = raw.get("service", "edge-backend")
        lines = min(int(raw.get("lines", 50)), 200)

        # 鉴权
        from platform_v8.storage import db as _db
        with _db.session_scope() as s:
            try:
                validated = auth_validation.validate_v8_access(s, token)
            except auth_validation.AuthValidationError as exc:
                await ws.send_json({"ok": False, "error": f"auth: {exc}"})
                await ws.close(code=4401)
                return
            claims = validated.claims
            acc = validated.account
            if not acc or not acc.is_admin:
                await ws.send_json({"ok": False, "error": "需要 admin 权限"})
                await ws.close(code=4403)
                return
            s.commit()

        # service 白名单
        if service not in {"edge-backend", "edge-frontend", "nginx"}:
            await ws.send_json({"ok": False, "error": f"service {service} 不允许"})
            await ws.close(code=1003)
            return

        await ws.send_json({"ok": True, "type": "ready", "service": service})

        # spawn journalctl -fn N -u service
        cmd = ["journalctl", "-fn", str(lines), "-u", service, "--no-pager", "--output=cat"]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        logger.info("logs_stream · admin=%s service=%s start", claims.account_id, service)

        try:
            while True:
                try:
                    line = await asyncio.wait_for(
                        proc.stdout.readline(),
                        timeout=30,
                    )
                except asyncio.TimeoutError:
                    with _db.session_scope() as s:
                        try:
                            current = auth_validation.validate_v8_access(
                                s,
                                token,
                                touch=False,
                            )
                        except auth_validation.AuthValidationError:
                            await ws.close(code=4401)
                            break
                        if not current.account.is_admin:
                            await ws.close(code=4403)
                            break
                    continue
                if not line:
                    break
                with _db.session_scope() as s:
                    try:
                        current = auth_validation.validate_v8_access(
                            s,
                            token,
                            touch=False,
                        )
                    except auth_validation.AuthValidationError:
                        await ws.close(code=4401)
                        break
                    if not current.account.is_admin:
                        await ws.close(code=4403)
                        break
                txt = line.decode(errors="replace").rstrip("\n")
                try:
                    await ws.send_json({"type": "log", "line": txt})
                except Exception:
                    break
        finally:
            try:
                proc.terminate()
                await proc.wait()
            except Exception:
                pass
    except asyncio.TimeoutError:
        await ws.send_json({"ok": False, "error": "auth timeout"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.exception("logs_stream 异常: %s", e)
    finally:
        try:
            await ws.close()
        except Exception:
            pass
