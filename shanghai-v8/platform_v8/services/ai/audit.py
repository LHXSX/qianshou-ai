"""AI 工具调用审计 (v8)

每次 AI tool 执行都写一条到 we_audit 表 · actor_kind='ai_tool'
合规要求 (GDPR / 个保法) + 安全溯源
"""
from __future__ import annotations
import logging
import uuid
from typing import Any

logger = logging.getLogger("backend.ai_audit")


def log_audit(
    *,
    user_id: int,
    role: str = "",
    session_id: str = "",
    tool_name: str = "",
    args: dict | None = None,
    result: Any = None,
    ok: bool = True,
    error_code: str | None = None,
    error_msg: str | None = None,
    latency_ms: int = 0,
    risk_level: str = "low",
    ip_address: str = "",
    user_agent: str = "",
) -> bool:
    """同步写一条审计记录到 we_audit"""
    try:
        from platform_v8.storage.db import session_scope
        from sqlalchemy import text as _t
        import json as _json

        detail = {
            "role": str(role or "")[:20],
            "args": _truncate(args or {}),
            "result": _truncate(result),
            "ok": bool(ok),
            "error_code": str(error_code or "")[:32] if error_code else None,
            "error_msg": str(error_msg or "")[:1000] if error_msg else None,
            "latency_ms": int(latency_ms or 0),
            "risk_level": str(risk_level or "low")[:16],
        }
        sql = _t("""
            INSERT INTO we_audit
              (id, actor_account_id, actor_kind, action,
               target_kind, target_id, trace_id, ip, user_agent, detail)
            VALUES
              (:id, :user_id, 'ai_tool', :tool_name,
               'ai_tool', :tool_name, :session_id, :ip, :ua, cast(:detail as jsonb))
        """)
        with session_scope() as s:
            s.execute(sql, {
                "id": str(uuid.uuid4()),
                "user_id": int(user_id) if user_id else None,
                "tool_name": str(tool_name or "")[:60],
                "session_id": str(session_id or "")[:36],
                "ip": str(ip_address or "")[:45],
                "ua": str(user_agent or "")[:500],
                "detail": _json.dumps(detail, ensure_ascii=False, default=str)[:16000],
            })
            s.commit()
        return True
    except Exception as exc:
        logger.warning("[ai_audit] write failed: %s", exc)
        return False


def _truncate(v: Any, max_len: int = 1000) -> Any:
    """截断大字段 (防止 audit 表爆)"""
    try:
        if isinstance(v, str) and len(v) > max_len:
            return v[:max_len] + "...(truncated)"
        if isinstance(v, dict):
            return {k: _truncate(val, max_len) for k, val in list(v.items())[:50]}
        if isinstance(v, list):
            return [_truncate(x, max_len) for x in v[:20]]
        return v
    except Exception:
        return str(v)[:max_len]


def query_audit(
    user_id: int | None = None,
    tool_name: str | None = None,
    risk_level: str | None = None,
    limit: int = 100,
) -> list[dict]:
    """查询审计日志 (admin 用 · 从 we_audit)"""
    try:
        from platform_v8.storage.db import session_scope
        from sqlalchemy import text as _t

        where = ["actor_kind = 'ai_tool'"]
        params: dict = {"limit": int(max(1, min(limit, 500)))}
        if user_id is not None:
            where.append("actor_account_id = :uid"); params["uid"] = int(user_id)
        if tool_name:
            where.append("action = :tn"); params["tn"] = str(tool_name)
        if risk_level:
            where.append("(detail->>'risk_level') = :rl"); params["rl"] = str(risk_level)
        where_clause = "WHERE " + " AND ".join(where)

        sql = _t(f"""
            SELECT id, actor_account_id AS user_id,
                   (detail->>'role') AS role,
                   action AS tool_name,
                   (detail->'args') AS args,
                   ((detail->>'ok')::boolean) AS ok,
                   (detail->>'error_msg') AS error_msg,
                   ((detail->>'latency_ms')::int) AS latency_ms,
                   (detail->>'risk_level') AS risk_level,
                   created_at
              FROM we_audit
              {where_clause}
             ORDER BY created_at DESC
             LIMIT :limit
        """)
        with session_scope() as s:
            rows = s.execute(sql, params).fetchall()
        return [{
            "id": str(r.id), "user_id": r.user_id, "role": r.role,
            "tool_name": r.tool_name, "args": r.args, "ok": r.ok,
            "error_msg": r.error_msg, "latency_ms": r.latency_ms,
            "risk_level": r.risk_level,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        } for r in rows]
    except Exception as exc:
        logger.warning("[ai_audit] query failed: %s", exc)
        return []


def stats_by_user(user_id: int, days: int = 7) -> dict:
    """某用户最近 N 天 AI 工具使用统计 (从 we_audit)"""
    try:
        from platform_v8.storage.db import session_scope
        from sqlalchemy import text as _t

        sql = _t("""
            SELECT
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE (detail->>'ok')::boolean = true)  AS success,
              COUNT(*) FILTER (WHERE (detail->>'ok')::boolean = false) AS failed,
              COUNT(*) FILTER (WHERE (detail->>'risk_level') IN ('high','critical')) AS high_risk,
              COALESCE(AVG(((detail->>'latency_ms')::int)), 0)::int AS avg_latency,
              COUNT(DISTINCT action) AS unique_tools
              FROM we_audit
             WHERE actor_kind = 'ai_tool'
               AND actor_account_id = :uid
               AND created_at >= NOW() - (:days || ' days')::interval
        """)
        with session_scope() as s:
            r = s.execute(sql, {"uid": int(user_id), "days": str(days)}).fetchone()
        return {
            "total": int(r[0] or 0),
            "success": int(r[1] or 0),
            "failed": int(r[2] or 0),
            "high_risk": int(r[3] or 0),
            "avg_latency_ms": int(r[4] or 0),
            "unique_tools": int(r[5] or 0),
            "period_days": days,
        }
    except Exception as exc:
        logger.warning("[ai_audit] stats failed: %s", exc)
        return {}
