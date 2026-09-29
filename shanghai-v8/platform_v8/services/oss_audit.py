"""OSS 全链路审计 · §5.6 护栏⑥

设计要点:
- 所有 OSS 操作 (sts_issue / presign_put / presign_get / scan / delete) 写 we_audit
- 谁 (account_id + IP) · 何时 · 操作了哪个文件 — 一字不漏
- 保留 90 天 (复用 we_audit 表 · 不新建)
- 审计员可一键导出 CSV · 走合规检查 (SOC 2 / 等保 2.0)

复用现有基础设施:
- 表: we_audit (id/actor_account_id/action/target_kind/target_id/detail JSONB/created_at)
- detail JSONB 装 OSS 元数据 (bucket/prefix/object_key/mode/ip/expires_at 等)
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger("services.oss_audit")

# OSS 审计 action 命名空间 · 所有以 oss.* 开头
ACTION_STS_ISSUE = "oss.sts_issue"
ACTION_PRESIGN_PUT = "oss.presign_put"
ACTION_PRESIGN_GET = "oss.presign_get"
ACTION_RESULT_URL = "oss.result_url"
ACTION_SCAN_START = "oss.scan_start"
ACTION_SCAN_COMPLETE = "oss.scan_complete"
ACTION_SCAN_HIT = "oss.scan_hit"           # 病毒/敏感词命中 · 高优先级
ACTION_SCAN_INCOMPLETE = "oss.scan_incomplete"  # skipped/error · 不等于安全通过
ACTION_DELETE = "oss.delete"
ACTION_ATTACH = "oss.attach_to_task"       # 文件关联到任务


def write_oss_audit(
    session: Session,
    *,
    account_id: Optional[int],
    action: str,
    object_key: str = "",
    task_id: int | str = 0,
    bucket: str = "",
    ip: str = "",
    user_agent: str = "",
    detail: Optional[dict] = None,
) -> None:
    """写一条 OSS 审计日志到 we_audit 表。

    Args:
        account_id: 操作发起者 (Account.id) · 系统操作可传 None
        action: 标准 action (用 ACTION_* 常量)
        object_key: OSS 对象 key (如 tenant_42/task_abc/input.pdf)
        task_id: 关联任务 ID
        bucket: bucket 名
        ip: 客户端 IP
        user_agent: 客户端 UA
        detail: 额外元数据 (合并入 JSONB detail 字段)
    """
    full_detail = {
        "object_key": object_key,
        "bucket": bucket,
        "ip": ip,
        "user_agent": user_agent[:200] if user_agent else "",
    }
    if detail:
        full_detail.update(detail)

    try:
        session.execute(
            text("""
                INSERT INTO we_audit
                    (id, actor_account_id, actor_kind, action,
                     target_kind, target_id, detail, created_at)
                VALUES
                    (gen_random_uuid(), :uid, :kind, :action,
                     'oss_object', :tid, CAST(:detail AS jsonb), NOW())
            """),
            {
                "uid": account_id,
                "kind": "system" if account_id is None else "user",
                "action": action,
                "tid": object_key or f"task_{task_id}",
                "detail": json.dumps(full_detail, default=str, ensure_ascii=False),
            },
        )
    except Exception as e:
        # 审计写失败不能阻塞业务 · 但要醒目记录
        logger.error("[OSS-AUDIT] 写审计失败 (action=%s · key=%s): %s", action, object_key, e)


def query_oss_audit(
    session: Session,
    *,
    account_id: Optional[int] = None,
    action: Optional[str] = None,
    object_key_prefix: Optional[str] = None,
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    limit: int = 200,
    offset: int = 0,
) -> dict[str, Any]:
    """查询 OSS 审计日志 (90 天内默认范围)。

    Returns:
        {
            "total": int,
            "rows": [
                {
                    "id": uuid,
                    "actor_account_id": int,
                    "action": "oss.presign_put",
                    "object_key": "tenant_42/task_abc/input.pdf",
                    "ip": "203.0.113.42",
                    "detail": {...},
                    "created_at": ISO datetime,
                },
                ...
            ]
        }
    """
    if until is None:
        until = datetime.now(timezone.utc)
    if since is None:
        since = until - timedelta(days=90)

    where_parts = [
        "action LIKE 'oss.%'",
        "created_at >= :since",
        "created_at <= :until",
    ]
    params: dict[str, Any] = {"since": since, "until": until, "limit": limit, "offset": offset}

    if account_id is not None:
        where_parts.append("actor_account_id = :uid")
        params["uid"] = account_id
    if action:
        where_parts.append("action = :action")
        params["action"] = action
    if object_key_prefix:
        where_parts.append("target_id LIKE :keyp")
        params["keyp"] = f"{object_key_prefix}%"

    where = " AND ".join(where_parts)

    total = session.execute(
        text(f"SELECT COUNT(*) FROM we_audit WHERE {where}"),
        params,
    ).scalar() or 0

    rows = session.execute(
        text(f"""
            SELECT id, actor_account_id, action, target_id, detail, created_at
            FROM we_audit
            WHERE {where}
            ORDER BY created_at DESC
            LIMIT :limit OFFSET :offset
        """),
        params,
    ).fetchall()

    return {
        "total": int(total),
        "rows": [
            {
                "id": str(r[0]),
                "actor_account_id": r[1],
                "action": r[2],
                "object_key": r[3] or "",
                "detail": r[4] if isinstance(r[4], dict) else (json.loads(r[4]) if r[4] else {}),
                "created_at": r[5].isoformat() if r[5] else None,
            }
            for r in rows
        ],
    }


def export_oss_audit_csv(
    session: Session,
    *,
    account_id: Optional[int] = None,
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    max_rows: int = 10000,
) -> str:
    """导出 OSS 审计为 CSV 字符串 (合规审计员用)。"""
    import csv
    from io import StringIO

    result = query_oss_audit(
        session,
        account_id=account_id,
        since=since,
        until=until,
        limit=max_rows,
    )

    buf = StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "audit_id", "account_id", "action", "object_key",
        "ip", "user_agent", "task_id", "bucket", "created_at",
    ])
    for r in result["rows"]:
        d = r.get("detail") or {}
        writer.writerow([
            r["id"], r["actor_account_id"], r["action"], r["object_key"],
            d.get("ip", ""), d.get("user_agent", ""),
            d.get("task_id", ""), d.get("bucket", ""),
            r["created_at"],
        ])
    return buf.getvalue()
