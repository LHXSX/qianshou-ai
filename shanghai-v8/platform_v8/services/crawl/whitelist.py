"""
URL 白名单服务 · crawl 任务合规层 (2026-05-24)

用法:
  submit 阶段:
    from platform_v8.services.crawl.whitelist import check_url_allowed
    ok, reason, entry = check_url_allowed(session, "https://en.wikipedia.org/wiki/AI")
    if not ok: raise SubmitWorkloadError(reason)

  admin CRUD:
    list_whitelist(session, status="active", limit=200)
    add_whitelist(session, domain, path_pattern, added_by, max_qps, notes)
    disable_whitelist(session, entry_id, by_account_id)
    enable_whitelist(session, entry_id)
    update_whitelist(session, entry_id, **fields)
    delete_whitelist(session, entry_id)  # 物理删 (不推荐 · 用 disable)

设计:
  - 域名精确匹配 (host == domain) + 子域匹配 (host endswith "." + domain)
  - path_pattern 用 fnmatch.fnmatch (支持 /* /wiki/* /api/v1/* 等 glob)
  - status='active' 的条目才生效 · disabled 的不删 (审计)
  - max_qps 暴露给节点 · 节点 rate_limit 用
"""
from __future__ import annotations
import fnmatch
import logging
from datetime import datetime
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import (
    Table, Column, MetaData,
    BigInteger, Integer, String, Text, DateTime,
    select, insert, update, delete,
)
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# ════════════════════════════════════════════════════════════════════
# Table 定义 · 跟 migrations/v8_003_crawl_whitelist.sql 对齐
# 独立 metadata · 不污染 storage/repo.py 主表集合
# ════════════════════════════════════════════════════════════════════
_metadata = MetaData()

# SQLite 兼容 (BigInteger 自增在 sqlite 走 INTEGER)
_BIGINT_PK = BigInteger().with_variant(Integer(), "sqlite")

crawl_whitelist_t = Table(
    "we_crawl_url_whitelist", _metadata,
    Column("id",            _BIGINT_PK, primary_key=True, autoincrement=True),
    Column("domain",        String(255), nullable=False),
    Column("path_pattern",  String(500), nullable=False, default="/*"),
    Column("status",        String(20),  nullable=False, default="active"),
    Column("max_qps",       Integer,     nullable=False, default=1),
    Column("added_by",      _BIGINT_PK,  nullable=True),
    Column("added_at",      DateTime,    nullable=False, default=datetime.utcnow),
    Column("updated_at",    DateTime,    nullable=False, default=datetime.utcnow),
    Column("disabled_at",   DateTime,    nullable=True),
    Column("notes",         Text,        nullable=True),
    Column("approval_ref",  String(120), nullable=True),
)


def ensure_schema(engine) -> None:
    """测试/首次启动用 · 生产走 SQL migration"""
    _metadata.create_all(engine)


# ════════════════════════════════════════════════════════════════════
# 查询 API
# ════════════════════════════════════════════════════════════════════
def _row_to_entry(row) -> dict[str, Any]:
    return {
        "id": row.id,
        "domain": row.domain,
        "path_pattern": row.path_pattern,
        "status": row.status,
        "max_qps": row.max_qps,
        "added_by": row.added_by,
        "added_at": row.added_at.isoformat() if row.added_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "disabled_at": row.disabled_at.isoformat() if row.disabled_at else None,
        "notes": row.notes or "",
        "approval_ref": row.approval_ref or "",
    }


def list_whitelist(
    session: Session,
    status: str | None = "active",
    domain_like: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """列白名单条目 · admin / submit 都可调"""
    stmt = select(crawl_whitelist_t).order_by(crawl_whitelist_t.c.domain, crawl_whitelist_t.c.path_pattern)
    if status:
        stmt = stmt.where(crawl_whitelist_t.c.status == status)
    if domain_like:
        stmt = stmt.where(crawl_whitelist_t.c.domain.like(f"%{domain_like}%"))
    stmt = stmt.limit(limit).offset(offset)
    rows = session.execute(stmt).all()
    return [_row_to_entry(r) for r in rows]


def get_whitelist_entry(session: Session, entry_id: int) -> dict[str, Any] | None:
    row = session.execute(
        select(crawl_whitelist_t).where(crawl_whitelist_t.c.id == entry_id)
    ).first()
    return _row_to_entry(row) if row else None


def check_url_allowed(
    session: Session,
    url: str,
) -> tuple[bool, str, dict[str, Any] | None]:
    """
    检查 URL 是否在白名单 · submit 时调
    返回: (ok, reason, matched_entry_or_None)
    """
    try:
        parts = urlparse(url)
    except Exception as e:
        return False, f"URL 解析失败: {e}", None
    if parts.scheme not in ("http", "https"):
        return False, "URL 必须是 http(s) scheme", None
    host = (parts.hostname or "").lower()
    if not host:
        return False, "URL 没有 hostname", None
    path = parts.path or "/"

    # 拉所有 active 条目 (一般 < 100 · 全量内存匹配最简单)
    # 后续条目变多可加 domain → entries 索引缓存
    rows = session.execute(
        select(crawl_whitelist_t).where(crawl_whitelist_t.c.status == "active")
    ).all()
    candidates = []
    for r in rows:
        d = (r.domain or "").lower()
        if not d:
            continue
        # 精确域名匹配
        if host == d:
            candidates.append(r)
            continue
        # 子域匹配 (en.wikipedia.org 匹配 wikipedia.org 的条目)
        if host.endswith("." + d):
            candidates.append(r)
            continue
    if not candidates:
        from platform_v8.services import lan_qa

        if lan_qa.host_in_crawl_allowlist(host):
            # LAN/验收额外域名（EDGE_LAN_QA_CRAWL_ALLOW_DOMAINS）；不写生产白名单表
            return True, "ok_lan_qa_extra_domain", {
                "id": None,
                "domain": host,
                "path_pattern": "/*",
                "status": "active",
                "max_qps": 1,
                "added_by": None,
                "added_at": None,
                "updated_at": None,
                "disabled_at": None,
                "notes": "EDGE_LAN_QA_CRAWL_ALLOW_DOMAINS",
                "approval_ref": "lan_qa",
            }
        return False, f"域名 {host} 不在白名单 · 请联系管理员添加", None

    # 取所有 candidate 里 path_pattern 匹配 path 的
    for r in candidates:
        pat = r.path_pattern or "/*"
        if fnmatch.fnmatch(path, pat):
            return True, "ok", _row_to_entry(r)
    pats = [r.path_pattern for r in candidates]
    return False, f"域名 {host} 在白名单但路径不匹配 (允许的 path: {pats})", None


def check_urls_allowed(
    session: Session,
    urls: list[str],
) -> tuple[bool, str, list[dict[str, Any]]]:
    """批量校验 · 任何一个 fail 就 fail · 返回每个 URL 的明细"""
    results = []
    all_ok = True
    first_fail_reason = ""
    for url in urls:
        ok, reason, entry = check_url_allowed(session, url)
        results.append({
            "url": url,
            "ok": ok,
            "reason": reason,
            "matched_entry_id": entry["id"] if entry else None,
        })
        if not ok:
            all_ok = False
            if not first_fail_reason:
                first_fail_reason = f"{url}: {reason}"
    return all_ok, first_fail_reason, results


# ════════════════════════════════════════════════════════════════════
# 写 API (admin only · 调用方负责鉴权)
# ════════════════════════════════════════════════════════════════════
def add_whitelist(
    session: Session,
    domain: str,
    path_pattern: str = "/*",
    added_by: int | None = None,
    max_qps: int = 1,
    notes: str = "",
    approval_ref: str = "",
) -> dict[str, Any]:
    """加白名单条目 · 重复 (domain, path) 抛 IntegrityError"""
    domain = (domain or "").strip().lower()
    if not domain:
        raise ValueError("domain 不能为空")
    path_pattern = path_pattern or "/*"
    if not path_pattern.startswith("/"):
        raise ValueError("path_pattern 必须以 / 开头")

    res = session.execute(
        insert(crawl_whitelist_t).values(
            domain=domain,
            path_pattern=path_pattern,
            status="active",
            max_qps=max(0, int(max_qps)),
            added_by=added_by,
            notes=notes or None,
            approval_ref=approval_ref or None,
        ).returning(crawl_whitelist_t.c.id)
    )
    new_id = res.scalar_one()
    session.commit()
    logger.info("crawl_whitelist · add id=%s domain=%s pattern=%s by=%s",
                new_id, domain, path_pattern, added_by)
    return get_whitelist_entry(session, new_id)  # type: ignore[return-value]


def disable_whitelist(session: Session, entry_id: int, by_account_id: int | None = None) -> bool:
    """禁用 (不物理删 · 保留审计)"""
    res = session.execute(
        update(crawl_whitelist_t)
        .where(crawl_whitelist_t.c.id == entry_id)
        .values(
            status="disabled",
            disabled_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
    )
    session.commit()
    ok = res.rowcount > 0
    if ok:
        logger.info("crawl_whitelist · disable id=%s by=%s", entry_id, by_account_id)
    return ok


def enable_whitelist(session: Session, entry_id: int) -> bool:
    res = session.execute(
        update(crawl_whitelist_t)
        .where(crawl_whitelist_t.c.id == entry_id)
        .values(
            status="active",
            disabled_at=None,
            updated_at=datetime.utcnow(),
        )
    )
    session.commit()
    return res.rowcount > 0


def update_whitelist(
    session: Session,
    entry_id: int,
    *,
    path_pattern: str | None = None,
    max_qps: int | None = None,
    notes: str | None = None,
    approval_ref: str | None = None,
) -> bool:
    fields: dict[str, Any] = {"updated_at": datetime.utcnow()}
    if path_pattern is not None:
        if not path_pattern.startswith("/"):
            raise ValueError("path_pattern 必须以 / 开头")
        fields["path_pattern"] = path_pattern
    if max_qps is not None:
        fields["max_qps"] = max(0, int(max_qps))
    if notes is not None:
        fields["notes"] = notes or None
    if approval_ref is not None:
        fields["approval_ref"] = approval_ref or None
    if len(fields) == 1:  # 只有 updated_at · 啥都没改
        return False
    res = session.execute(
        update(crawl_whitelist_t).where(crawl_whitelist_t.c.id == entry_id).values(**fields)
    )
    session.commit()
    return res.rowcount > 0


def delete_whitelist(session: Session, entry_id: int) -> bool:
    """物理删 · 不推荐 · 优先用 disable_whitelist"""
    res = session.execute(
        delete(crawl_whitelist_t).where(crawl_whitelist_t.c.id == entry_id)
    )
    session.commit()
    return res.rowcount > 0
