"""节点机身指纹去重 + 同名离线幽灵归档。

去重口径（仅限同一 owner_id）：
  1. 客户端上报 capabilities.machine_fingerprint（强指纹 v1:…）优先
  2. 否则用 hostname+os+arch 派生弱指纹 weak:…（兼容旧客户端）
  3. 新 worker_id 且库中无此行时，若指纹命中已有节点 → 复用该 id（避免再插一行）

归档口径：
  - 同名：同 owner + 同 name，保留最优一条，其余 OFFLINE 幽灵标 archived
  - 同指纹：同 owner + 同 fingerprint，保留当前上线 id，其余标 archived
  - 归档行不出现在「我的节点」；调度只看 ONLINE，本不受影响
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

ARCHIVED_KEY = "archived"
FP_KEY = "machine_fingerprint"


def is_archived_caps(caps: dict | None) -> bool:
    if not isinstance(caps, dict):
        return False
    val = caps.get(ARCHIVED_KEY)
    if val is True or val == 1:
        return True
    if isinstance(val, str) and val.strip().lower() in {"1", "true", "yes"}:
        return True
    return False


def extract_fingerprint(capabilities: dict | None) -> str | None:
    """从 hello capabilities 提取机身指纹；无强指纹时回退弱指纹。"""
    caps = capabilities if isinstance(capabilities, dict) else {}
    raw = caps.get(FP_KEY) or caps.get("fingerprint")
    if isinstance(raw, str):
        fp = raw.strip()
        if len(fp) >= 8:
            return fp[:128]

    host = str(
        caps.get("hostname") or caps.get("device_name") or ""
    ).strip().lower()
    if not host or host in {"unknown", "localhost", "none"}:
        return None
    os_ = str(caps.get("os") or caps.get("os_name") or "").strip().lower()
    arch = str(caps.get("arch") or "").strip().lower()
    digest = hashlib.sha256(
        f"host:{host}|os:{os_}|arch:{arch}".encode("utf-8")
    ).hexdigest()[:32]
    return f"weak:{digest}"


def _row_field(row: Any, key: str, default: Any = None) -> Any:
    """兼容 SQLAlchemy Row：勿用 row.name（会撞上 Row API）。"""
    mapping = getattr(row, "_mapping", None)
    if mapping is not None:
        return mapping.get(key, default)
    return getattr(row, key, default)


def _caps_of_row(row: Any) -> dict:
    caps = _row_field(row, "capabilities")
    if isinstance(caps, str):
        import json
        try:
            caps = json.loads(caps)
        except Exception:
            caps = {}
    return dict(caps or {}) if isinstance(caps, dict) else {}


def _fingerprint_of_row(row: Any) -> str | None:
    caps = _caps_of_row(row)
    fp = extract_fingerprint(caps)
    if fp:
        return fp
    # 历史行可能只有 name=hostname、capabilities 里无 hostname
    name = str(_row_field(row, "name", "") or "").strip().lower()
    if name and name not in {"unknown", "v8-node", "eco-node"}:
        os_ = str(caps.get("os") or caps.get("os_name") or "").strip().lower()
        arch = str(caps.get("arch") or "").strip().lower()
        digest = hashlib.sha256(
            f"host:{name}|os:{os_}|arch:{arch}".encode("utf-8")
        ).hexdigest()[:32]
        return f"weak:{digest}"
    return None


def _status_rank(status: str) -> int:
    s = (status or "").upper()
    if s in {"ONLINE", "BUSY"}:
        return 2
    if s == "OFFLINE":
        return 1
    return 0


def find_canonical_by_fingerprint(
    s: Session,
    *,
    owner_id: int,
    fingerprint: str,
    exclude_worker_id: str | None = None,
) -> str | None:
    """同账号下按指纹找应复用的 worker_id；跳过墓碑与空指纹。"""
    from platform_v8.services.workers import tombstone as tombstone_svc
    from platform_v8.storage.repo import workers_t
    from sqlalchemy import select

    fp = (fingerprint or "").strip()
    if len(fp) < 8:
        return None

    rows = s.execute(
        select(workers_t).where(workers_t.c.owner_id == int(owner_id))
    ).all()

    candidates: list[tuple[int, datetime | None, str]] = []
    for row in rows:
        wid = str(_row_field(row, "id"))
        if exclude_worker_id and wid == str(exclude_worker_id):
            continue
        if tombstone_svc.is_deleted(wid):
            continue
        row_fp = _fingerprint_of_row(row)
        if not row_fp or row_fp != fp:
            continue
        caps = _caps_of_row(row)
        # 已归档也可复用（重装后带回），但优先未归档 + 在线
        rank = _status_rank(str(_row_field(row, "status") or ""))
        if not is_archived_caps(caps):
            rank += 10
        candidates.append((rank, _row_field(row, "last_seen"), wid))

    if not candidates:
        return None
    candidates.sort(
        key=lambda x: (x[0], x[1] or datetime.min.replace(tzinfo=timezone.utc)),
        reverse=True,
    )
    return candidates[0][2]


def resolve_worker_id_for_register(
    s: Session,
    *,
    owner_id: int,
    worker_id: str,
    capabilities: dict | None,
) -> tuple[str, str | None, bool]:
    """注册前解析最终 worker_id。

    返回 (final_worker_id, fingerprint, remapped)。
    仅当请求的 worker_id 在库中不存在时才按指纹复用，避免把已绑定 id 拽走。
    """
    from platform_v8.storage.repo import WorkerRepo

    wid = str(worker_id or "").strip()
    fp = extract_fingerprint(capabilities)
    existed = WorkerRepo.by_id(s, wid) if wid else None
    if existed is not None:
        return wid, fp, False
    if not fp:
        return wid, None, False

    canonical = find_canonical_by_fingerprint(
        s, owner_id=owner_id, fingerprint=fp, exclude_worker_id=wid or None,
    )
    if canonical and canonical != wid:
        logger.info(
            "worker.fingerprint_remap owner=%s from=%s to=%s fp=%s",
            owner_id, (wid or "")[:12], canonical[:12], fp[:24],
        )
        return canonical, fp, True
    return wid, fp, False


def archive_worker(
    s: Session,
    worker_id: str,
    *,
    reason: str,
) -> bool:
    """软归档：标 OFFLINE + capabilities.archived=true（不删行、保留收益关联）。"""
    from sqlalchemy import select, update
    from platform_v8.storage.repo import workers_t
    from platform_v8.core import WorkerStatus

    row = s.execute(
        select(workers_t.c.id, workers_t.c.capabilities, workers_t.c.status)
        .where(workers_t.c.id == str(worker_id))
    ).first()
    if row is None:
        return False
    caps = _caps_of_row(row)
    if is_archived_caps(caps):
        return False
    caps[ARCHIVED_KEY] = True
    caps["archived_at"] = datetime.now(timezone.utc).isoformat()
    caps["archived_reason"] = str(reason or "ghost")[:80]
    s.execute(
        update(workers_t)
        .where(workers_t.c.id == str(worker_id))
        .values(
            status=WorkerStatus.OFFLINE.value,
            capabilities=caps,
        )
    )
    return True


def unarchive_worker_caps(capabilities: dict | None) -> dict:
    """上线复用已归档节点时清掉归档标记。"""
    caps = dict(capabilities or {})
    if ARCHIVED_KEY in caps:
        caps.pop(ARCHIVED_KEY, None)
        caps.pop("archived_at", None)
        caps.pop("archived_reason", None)
    return caps


def archive_sibling_ghosts(
    s: Session,
    *,
    owner_id: int,
    keep_worker_id: str,
    name: str | None = None,
    fingerprint: str | None = None,
) -> int:
    """归档同账号下同名/同指纹的幽灵节点（保留 keep）。"""
    from platform_v8.storage.repo import workers_t
    from sqlalchemy import select

    keep = str(keep_worker_id)
    rows = s.execute(
        select(workers_t).where(workers_t.c.owner_id == int(owner_id))
    ).all()
    n = 0
    keep_name = (name or "").strip()
    for row in rows:
        wid = str(_row_field(row, "id"))
        if wid == keep:
            continue
        caps = _caps_of_row(row)
        if is_archived_caps(caps):
            continue
        reason = None
        if fingerprint:
            row_fp = _fingerprint_of_row(row)
            if row_fp and row_fp == fingerprint:
                reason = "duplicate_fingerprint"
        if reason is None and keep_name:
            if str(_row_field(row, "name") or "").strip() == keep_name:
                # 同名：只收离线幽灵；在线同名留给指纹路径处理，避免误伤两台真机
                if str(_row_field(row, "status") or "").upper() == "OFFLINE":
                    reason = "duplicate_name_offline"
        if reason is None:
            continue
        if archive_worker(s, wid, reason=reason):
            n += 1
            logger.info(
                "worker.archive_ghost owner=%s keep=%s ghost=%s reason=%s",
                owner_id, keep[:12], wid[:12], reason,
            )
    return n


def archive_offline_name_duplicates(s: Session, owner_id: int) -> int:
    """打开「我的节点」时自愈：同名多条离线只留最近一条。"""
    from platform_v8.storage.repo import workers_t
    from sqlalchemy import select
    from collections import defaultdict

    rows = s.execute(
        select(workers_t).where(workers_t.c.owner_id == int(owner_id))
    ).all()
    groups: dict[str, list[Any]] = defaultdict(list)
    for row in rows:
        caps = _caps_of_row(row)
        if is_archived_caps(caps):
            continue
        name = str(_row_field(row, "name") or "").strip()
        if not name:
            continue
        groups[name].append(row)

    archived = 0
    for name, members in groups.items():
        if len(members) < 2:
            continue
        # 有在线则只归档离线兄弟；全离线则留 last_seen 最新
        online = [
            m for m in members
            if str(_row_field(m, "status") or "").upper() in {"ONLINE", "BUSY"}
        ]
        if online:
            keep_ids = {str(_row_field(m, "id")) for m in online}
            for m in members:
                if str(_row_field(m, "id")) in keep_ids:
                    continue
                if str(_row_field(m, "status") or "").upper() != "OFFLINE":
                    continue
                if archive_worker(s, str(_row_field(m, "id")), reason="duplicate_name_offline"):
                    archived += 1
            continue
        members_sorted = sorted(
            members,
            key=lambda m: _row_field(m, "last_seen")
            or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )
        for m in members_sorted[1:]:
            if archive_worker(s, str(_row_field(m, "id")), reason="duplicate_name_offline"):
                archived += 1
    return archived
