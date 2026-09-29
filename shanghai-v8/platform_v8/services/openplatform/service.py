"""
开放平台业务 · key 鉴权 / 配额 / 套餐购买分账 / invoke 计量网关

设计（08_生态扩展蓝图）:
  - 鉴权复用 we_api_keys(v8_031)：X-API-Key → sha256 比对 → account
  - 配额先扣后跑：consume + submit_workload 同事务，提交失败整体回滚
  - 套餐购买：we_ledger 三条腿（买家 ESCROW_HOLD 负 / 作者 REWARD / 平台 PLATFORM_FEE），
    应用专属包作者分成 80%（与商店 platform_share_pct 一致），通用包收入归平台
  - 引擎零改：invoke 只是 submit_svc 前面的计量计费层
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from platform_v8.core import LedgerEntry, LedgerType
from platform_v8.storage.repo import IdempotentConflict, LedgerRepo

logger = logging.getLogger(__name__)

AUTHOR_SHARE_PCT = Decimal("80")


class OpenPlatformError(Exception):
    """业务拒绝（配额不足 / 套餐限购 / 余额不足等）"""


class InvalidApiKey(OpenPlatformError):
    """key 不存在 / 已吊销 / 已过期"""


# ════════════════════════════════════════════════════════════════════
# key 鉴权（X-API-Key → account_id）
# ════════════════════════════════════════════════════════════════════
def verify_api_key(s: Session, raw_key: str) -> dict:
    """校验 X-API-Key，返回 {key_id, account_id}；顺手 touch last_used_at。

    兼容两代前缀：qs_（developer.py / ApiKeyRepo 签发）与 qsk_（enterprise_stub 存量）。
    """
    raw = (raw_key or "").strip()
    if not raw or not raw.startswith(("qs_", "qsk_")):
        raise InvalidApiKey("无效的 API Key")
    sha = hashlib.sha256(raw.encode()).hexdigest()
    row = s.execute(text("""
        SELECT id, account_id FROM we_api_keys
         WHERE key_sha256 = :sha AND revoked = false
           AND (expires_at IS NULL OR expires_at > NOW())
    """), {"sha": sha}).fetchone()
    if row is None:
        raise InvalidApiKey("API Key 不存在、已吊销或已过期")
    s.execute(text("UPDATE we_api_keys SET last_used_at = NOW() WHERE id = :kid"),
              {"kid": row.id})
    return {"key_id": int(row.id), "account_id": int(row.account_id)}


# ════════════════════════════════════════════════════════════════════
# 配额
# ════════════════════════════════════════════════════════════════════
def _grant_quota(s: Session, account_id: int, app_id: Optional[int], calls: int) -> None:
    """配额入账（upsert · 表达式唯一索引 COALESCE(app_id,0)）。"""
    s.execute(text("""
        INSERT INTO we_api_quotas (account_id, app_id, remaining, total_purchased, updated_at)
        VALUES (:aid, :app, :calls, :calls, NOW())
        ON CONFLICT (account_id, COALESCE(app_id, 0)) DO UPDATE
           SET remaining = we_api_quotas.remaining + :calls,
               total_purchased = we_api_quotas.total_purchased + :calls,
               updated_at = NOW()
    """), {"aid": account_id, "app": app_id, "calls": calls})


def consume_quota(s: Session, account_id: int, app_id: int) -> dict:
    """原子扣 1 次：应用专属配额优先，通用配额兜底。返回扣减后余量信息。"""
    # 先试应用专属
    row = s.execute(text("""
        UPDATE we_api_quotas SET remaining = remaining - 1, updated_at = NOW()
         WHERE account_id = :aid AND app_id = :app AND remaining > 0
        RETURNING remaining
    """), {"aid": account_id, "app": app_id}).fetchone()
    if row is not None:
        return {"scope": "app", "remaining": int(row.remaining)}
    # 再试通用
    row = s.execute(text("""
        UPDATE we_api_quotas SET remaining = remaining - 1, updated_at = NOW()
         WHERE account_id = :aid AND app_id IS NULL AND remaining > 0
        RETURNING remaining
    """), {"aid": account_id}).fetchone()
    if row is not None:
        return {"scope": "general", "remaining": int(row.remaining)}
    raise OpenPlatformError("调用配额不足，请先购买套餐（GET /api/v8/openapi/packs）")


def quota_summary(s: Session, account_id: int) -> list[dict]:
    rows = s.execute(text("""
        SELECT q.app_id, a.name AS app_name, a.slug AS app_slug,
               q.remaining, q.total_purchased
          FROM we_api_quotas q
          LEFT JOIN we_apps a ON a.id = q.app_id
         WHERE q.account_id = :aid
         ORDER BY q.app_id NULLS FIRST
    """), {"aid": account_id}).mappings().all()
    return [dict(r) for r in rows]


# ════════════════════════════════════════════════════════════════════
# 套餐
# ════════════════════════════════════════════════════════════════════
def list_packs(s: Session, account_id: Optional[int] = None) -> list[dict]:
    rows = s.execute(text("""
        SELECT p.id, p.name, p.description, p.calls, p.price_edg, p.app_id,
               a.name AS app_name, a.slug AS app_slug,
               p.once_per_account
          FROM we_api_packs p
          LEFT JOIN we_apps a ON a.id = p.app_id
         WHERE p.active = true
         ORDER BY p.price_edg ASC, p.id ASC
    """)).mappings().all()
    items = [dict(r) for r in rows]
    if account_id:
        bought = {
            int(r.pack_id)
            for r in s.execute(text(
                "SELECT DISTINCT pack_id FROM we_api_pack_orders WHERE account_id = :aid"
            ), {"aid": account_id}).fetchall()
        }
        for it in items:
            it["purchased"] = int(it["id"]) in bought
    for it in items:
        it["price_edg"] = float(it["price_edg"])
    return items


def buy_pack(s: Session, account_id: int, pack_id: int) -> dict:
    """购买套餐：限购检查 → ledger 扣款/分账 → 配额入账 → 订单行（同事务）。"""
    pack = s.execute(text("""
        SELECT p.*, a.author_id AS app_author_id
          FROM we_api_packs p
          LEFT JOIN we_apps a ON a.id = p.app_id
         WHERE p.id = :pid AND p.active = true
    """), {"pid": pack_id}).mappings().fetchone()
    if pack is None:
        raise OpenPlatformError("套餐不存在或已下架")

    if pack["once_per_account"]:
        dup = s.execute(text("""
            SELECT 1 FROM we_api_pack_orders
             WHERE account_id = :aid AND pack_id = :pid LIMIT 1
        """), {"aid": account_id, "pid": pack_id}).fetchone()
        if dup:
            raise OpenPlatformError("该套餐每账户限购一次，你已领取过")

    price = Decimal(str(pack["price_edg"]))
    author_share = Decimal("0")
    order_uuid = uuid.uuid4().hex

    if price > 0:
        from platform_v8.services.economy import balance as balance_svc
        if balance_svc.get_balance(s, account_id) < price:
            raise OpenPlatformError(f"余额不足（需要 {price} EDG），请先充值")

        def _write(entry: LedgerEntry) -> None:
            try:
                LedgerRepo.write(s, entry)
            except IdempotentConflict:
                logger.info("apipack ledger idempotent: %s", entry.idempotent_key)

        # 买家扣款（即时消费语义，同 transfer 的用法）
        _write(LedgerEntry(
            account_id=account_id, type=LedgerType.ESCROW_HOLD, amount=-price,
            idempotent_key=f"apipack:{order_uuid}:client",
            note=f"购买 API 套餐「{pack['name']}」",
        ))
        # 应用专属包 → 作者分成 80%；通用包 → 全额平台
        if pack["app_id"] and pack["app_author_id"]:
            author_share = (price * AUTHOR_SHARE_PCT / Decimal("100")).quantize(Decimal("0.01"))
            _write(LedgerEntry(
                account_id=int(pack["app_author_id"]), type=LedgerType.REWARD,
                amount=author_share,
                idempotent_key=f"apipack:{order_uuid}:author",
                note=f"API 套餐「{pack['name']}」作者分成 {AUTHOR_SHARE_PCT}%",
            ))
        platform_take = price - author_share
        if platform_take > 0:
            from platform_v8.services.auth.admin_lookup import resolve_admin_account_id
            _write(LedgerEntry(
                account_id=resolve_admin_account_id(), type=LedgerType.PLATFORM_FEE,
                amount=platform_take,
                idempotent_key=f"apipack:{order_uuid}:platform",
                note=f"API 套餐「{pack['name']}」平台收入",
            ))
        # 刷余额 cache（买家必刷，作者/平台顺带）
        from platform_v8.services.economy.ledger import _refresh_balance_cache
        _refresh_balance_cache(s, account_id)
        if pack["app_author_id"]:
            _refresh_balance_cache(s, int(pack["app_author_id"]))

    _grant_quota(s, account_id, pack["app_id"], int(pack["calls"]))
    s.execute(text("""
        INSERT INTO we_api_pack_orders (account_id, pack_id, calls, price_edg, author_share_edg)
        VALUES (:aid, :pid, :calls, :price, :share)
    """), {"aid": account_id, "pid": pack_id, "calls": int(pack["calls"]),
           "price": price, "share": author_share})
    s.commit()
    logger.info("openapi.buy_pack · account=%s pack=%s calls=%s price=%s",
                account_id, pack_id, pack["calls"], price)
    return {"ok": True, "pack": pack["name"], "calls": int(pack["calls"]),
            "paid_edg": float(price)}


# ════════════════════════════════════════════════════════════════════
# invoke · 计量网关（X-API-Key）
# ════════════════════════════════════════════════════════════════════
def invoke_app(
    s: Session,
    *,
    account_id: int,
    key_id: int,
    slug: str,
    inline_input: Optional[str] = None,
    input_url: Optional[str] = None,
    params: Optional[dict[str, Any]] = None,
    timeout_s: int = 600,
    is_admin: bool = False,
) -> dict:
    """扣 1 配额 → 组真实 WorkloadSpec → submit_workload → usage 落行（同事务）。"""
    from platform_v8.services.marketplace import apps as apps_svc
    from platform_v8.services.workloads import submit as submit_svc

    try:
        app = apps_svc.get_by_slug(s, slug)
    except apps_svc.AppNotFound:
        raise OpenPlatformError(f"应用 {slug} 不存在或未上架")
    if not app.get("task_type"):
        raise OpenPlatformError(f"应用 {slug} 不支持 API 调用（无 task_type）")
    if (app.get("launch_kind") or "workload") != "workload":
        raise OpenPlatformError(f"应用 {slug} 为本地/深链应用，不支持 API 调用")
    if not inline_input and not input_url:
        raise OpenPlatformError("必须提供 inline_input（文本/JSON）或 input_url（可公网 GET 的文件直链）")

    quota = consume_quota(s, account_id, int(app["id"]))

    spec: dict[str, Any] = {
        "kind": "DATA_PROCESSING",
        "task_type": app["task_type"],
        "params": {"app_slug": slug, "channel": "openapi", **(params or {})},
        "timeout_s": max(30, min(int(timeout_s), 3600)),
        "max_shards": 1,
    }
    if inline_input:
        spec["input_kind"] = "inline"
        spec["inline_input"] = inline_input
    else:
        spec["input_kind"] = "single_file"
        spec["input_ref"] = input_url

    try:
        # budget=0：成本已在套餐价里收讫（配额通道）
        from platform_v8.protocol.http_schema import WorkloadSpecIn
        spec_model = WorkloadSpecIn.model_validate(spec)
        workload = submit_svc.submit_workload(
            s,
            submit_svc.SubmitInput(
                owner_id=account_id,
                name=f"API·{app['name']}",
                spec_dict=spec_model.model_dump(),
                budget=Decimal("0"),
                is_admin=is_admin,
            ),
        )
    except submit_svc.SubmitWorkloadError as exc:
        raise OpenPlatformError(f"任务提交失败: {exc}")

    s.execute(text("""
        INSERT INTO we_api_usage (key_id, account_id, app_id, workload_id, status)
        VALUES (:kid, :aid, :app, :wid, 'submitted')
    """), {"kid": key_id, "aid": account_id, "app": int(app["id"]),
           "wid": str(workload.id)})
    s.commit()

    # commit 后异步拉起引擎（与 /workloads 端点一致）
    logger.info("openapi.invoke · account=%s app=%s workload=%s quota_left=%s",
                account_id, slug, workload.id, quota["remaining"])
    return {
        "ok": True,
        "task_id": str(workload.id),
        "status": str(getattr(workload.status, "value", workload.status)),
        "quota_scope": quota["scope"],
        "quota_remaining": quota["remaining"],
        "poll": f"/api/v8/open/tasks/{workload.id}",
    }


# ════════════════════════════════════════════════════════════════════
# 用量
# ════════════════════════════════════════════════════════════════════
def usage_summary(s: Session, account_id: int) -> dict:
    total = s.execute(text("""
        SELECT COUNT(*) AS n30,
               COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS n24h
          FROM we_api_usage
         WHERE account_id = :aid AND created_at > NOW() - INTERVAL '30 days'
    """), {"aid": account_id}).fetchone()
    keys = s.execute(text("""
        SELECT COUNT(*) FROM we_api_keys WHERE account_id = :aid AND revoked = false
    """), {"aid": account_id}).scalar() or 0
    return {
        "calls_30d": int(total.n30 or 0),
        "calls_24h": int(total.n24h or 0),
        "active_keys": int(keys),
        "quotas": quota_summary(s, account_id),
    }


def usage_list(s: Session, account_id: int, *, limit: int = 50) -> list[dict]:
    rows = s.execute(text("""
        SELECT u.id, u.workload_id, u.status, u.created_at,
               a.name AS app_name, a.slug AS app_slug,
               k.key_prefix
          FROM we_api_usage u
          LEFT JOIN we_apps a ON a.id = u.app_id
          LEFT JOIN we_api_keys k ON k.id = u.key_id
         WHERE u.account_id = :aid
         ORDER BY u.created_at DESC
         LIMIT :lim
    """), {"aid": account_id, "lim": limit}).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["workload_id"] = str(d["workload_id"]) if d["workload_id"] else None
        d["created_at"] = d["created_at"].isoformat() if d["created_at"] else None
        out.append(d)
    return out


# ════════════════════════════════════════════════════════════════════
# 目录（文档页数据源 · 匿名可读）
# ════════════════════════════════════════════════════════════════════
def api_catalog(s: Session) -> list[dict]:
    rows = s.execute(text("""
        SELECT id, name, slug, category, description, task_type, input_kind,
               accept_formats, pricing_model, price
          FROM we_apps
         WHERE status = 'published' AND task_type IS NOT NULL
           AND launch_kind = 'workload'
         ORDER BY install_count DESC
    """)).mappings().all()
    items = []
    for r in rows:
        d = dict(r)
        d["price"] = float(d["price"] or 0)
        d["invoke_path"] = f"/api/v8/open/apps/{d['slug']}/invoke"
        d["input_mode"] = "inline" if (d["input_kind"] or "") in ("json", "inline", "params_only") else "file_url"
        items.append(d)
    return items
