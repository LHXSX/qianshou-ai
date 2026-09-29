"""应用市场业务：列表/详情/安装/评价/审核。"""
from __future__ import annotations

import logging
import json
import re
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import and_, delete, func, insert, or_, select, update
from sqlalchemy.orm import Session

from platform_v8.engine import task_registry
from platform_v8.services.marketplace import commission as commission_svc
from platform_v8.services.marketplace import sandbox as sandbox_svc
from platform_v8.storage.repo import (
    AuditRepo,
    accounts_t,
    apps_t,
    app_versions_t,
    installs_t,
    reviews_t,
)

_MONTH_DAYS = 30

logger = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$")
_CAPABILITY_RE = re.compile(r"^[a-z][a-z0-9_.-]{1,95}$")
_SHA256_RE = re.compile(r"^[a-fA-F0-9]{64}$")
# P1-10/11 · 上架深链 / 外链白名单（与 eco-client shell.open 对齐）
_DEEP_LINK_RE = re.compile(
    r"^(https?://|mailto:|tel:|qianshou-law://|qianshou://).+",
    re.IGNORECASE,
)


class MarketplaceError(Exception):
    pass


def _validate_launch_fields(body: dict[str, Any], *, require_url_for_link: bool = True) -> None:
    kind = str(body.get("launch_kind") or "workload").strip().lower()
    url = (body.get("deep_link_url") or "").strip()
    if kind in ("deep_link", "webview"):
        if require_url_for_link and not url:
            raise MarketplaceError(f"{kind} 应用必须填写入口地址 deep_link_url")
        if url and not _DEEP_LINK_RE.match(url):
            raise MarketplaceError(
                "入口地址非法：仅支持 https/http、mailto、tel、qianshou* 深链"
            )
        if kind == "webview" and url and not url.lower().startswith("https://"):
            raise MarketplaceError("webview 入口必须是 https:// 地址")
    elif url and not _DEEP_LINK_RE.match(url):
        raise MarketplaceError("deep_link_url 格式非法")


def _submission_document(raw: Any, *, name: str, max_bytes: int) -> dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise MarketplaceError(f"{name} 必须是 JSON 对象")
    try:
        size = len(json.dumps(raw, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    except (TypeError, ValueError) as exc:
        raise MarketplaceError(f"{name} 必须是有效 JSON") from exc
    if size > max_bytes:
        raise MarketplaceError(f"{name} 超过 {max_bytes // 1024} KiB 上限")
    return raw


def _author_url(raw: Any, *, name: str) -> str | None:
    if raw is None or raw == "":
        return None
    url = str(raw).strip()
    try:
        parsed = urlsplit(url)
        host = parsed.hostname
        parsed.port  # malformed ports must be a normal 400, not an unhandled 500
    except ValueError as exc:
        raise MarketplaceError(f"{name} 必须是合法 HTTPS 地址") from exc
    if (len(url) > 2048 or any(ch.isspace() for ch in url)
            or parsed.scheme.lower() != "https" or not host
            or parsed.username or parsed.password or parsed.fragment):
        raise MarketplaceError(f"{name} 必须是无账号和片段的 HTTPS 地址")
    return url


def _validate_runtime_plugin_fields(body: dict[str, Any], *, for_publish: bool) -> dict[str, Any]:
    """规范作者声明的插件字段；这里只检验格式，**不**做发布者验签。"""
    launch = str(body.get("launch_kind") or "workload").strip().lower()
    kind = str(body.get("package_kind") or ("plugin" if launch == "plugin" else "app")).strip().lower()
    if kind not in ("app", "plugin", "bundle"):
        raise MarketplaceError("package_kind 仅支持 app、plugin、bundle")
    if launch == "plugin" and kind != "plugin":
        raise MarketplaceError("plugin 启动方式必须声明 package_kind=plugin")
    runtime_api = str(body.get("runtime_api") or "1.0.0").strip()
    if len(runtime_api) > 64 or not re.match(r"^[0-9A-Za-z.<>~=^* +_-]+$", runtime_api):
        raise MarketplaceError("runtime_api 格式非法")
    raw_caps = body.get("capabilities") or []
    if not isinstance(raw_caps, list) or len(raw_caps) > 32:
        raise MarketplaceError("capabilities 必须是最多 32 项的列表")
    caps: list[Any] = []
    for item in raw_caps:
        if isinstance(item, str):
            name = item.strip()
            if not _CAPABILITY_RE.fullmatch(name):
                raise MarketplaceError(f"Capability 名称非法：{name[:80]}")
            caps.append(name)
        elif isinstance(item, dict):
            name = str(item.get("name") or "").strip()
            version = str(item.get("version") or "1.0.0").strip()
            if not _CAPABILITY_RE.fullmatch(name) or len(version) > 64:
                raise MarketplaceError("Capability 对象必须有合法 name/version")
            caps.append({"name": name, "version": version})
        else:
            raise MarketplaceError("Capability 只能是名称或 {name, version} 对象")
    fields = {
        "package_kind": kind,
        "runtime_api": runtime_api,
        "capabilities": caps,
        "plugin_package_url": _author_url(body.get("plugin_package_url"), name="plugin_package_url"),
        "plugin_manifest_url": _author_url(body.get("plugin_manifest_url"), name="plugin_manifest_url"),
        "plugin_signature_url": _author_url(body.get("plugin_signature_url"), name="plugin_signature_url"),
    }
    if for_publish and launch == "plugin":
        if not caps:
            raise MarketplaceError("插件至少声明 1 个 Capability")
        if not fields["plugin_package_url"]:
            raise MarketplaceError("插件必须填写 HTTPS package URL")
    return fields


class AppNotFound(MarketplaceError):
    pass


class AppAccessDenied(MarketplaceError):
    pass


def _row(m) -> dict[str, Any]:
    d = dict(m)
    for k, v in list(d.items()):
        if isinstance(v, Decimal):
            d[k] = float(v)
        elif isinstance(v, datetime):
            d[k] = v.isoformat()
    return d


def _official_task_types() -> set[str]:
    try:
        return {s.task_type for s in task_registry.list_specs()}
    except Exception:
        return {
            "ocr_image", "pdf_ocr", "contract_review",
            "whisper_transcribe", "excel_export", "package_digest",
        }


def _serialize_app(row: dict[str, Any], *, latest: dict | None = None) -> dict[str, Any]:
    out = dict(row)
    if latest:
        out["latest_version"] = latest.get("version")
        out["script_bundle_url"] = latest.get("script_bundle_url")
        out["model_bundle_url"] = latest.get("model_bundle_url")
        out["sha256"] = latest.get("sha256")
        out["signed"] = latest.get("signed")
        out["size_bytes"] = latest.get("size_bytes")
        out["manifest"] = latest.get("manifest") or {}
        out["config_schema"] = latest.get("config_schema") or {}
        out["pricing_snapshot"] = latest.get("pricing_snapshot") or {}
        out["version_summary"] = latest.get("version_summary") or ""
        out["changelog"] = latest.get("changelog") or ""
    out.setdefault("package_kind", "app")
    out.setdefault("runtime_api", None)
    out.setdefault("capabilities", [])
    out.setdefault("plugin_package_url", None)
    out.setdefault("plugin_manifest_url", None)
    out.setdefault("plugin_signature_url", None)
    # display_meta 一等展开（详情页 / 列表均可直接读 usage · 兼容旧客户端只读 meta）
    meta = out.get("display_meta") if isinstance(out.get("display_meta"), dict) else {}
    if meta:
        for key in ("tagline", "features", "scenarios", "capability_tags", "usage"):
            if out.get(key) is None and key in meta:
                out[key] = meta[key]
        if out.get("coming_soon") is None and "coming_soon" in meta:
            out["coming_soon"] = bool(meta.get("coming_soon"))
    out["policy"] = sandbox_svc.app_to_policy_dict(out)
    # R7 · manifest v2 / 执行模型分流字段（老客户端可忽略）
    try:
        from platform_v8.services.marketplace.execution_model import marketplace_manifest_v2_fields
        out.update(marketplace_manifest_v2_fields(out))
    except Exception:
        out.setdefault("execution_model", "legacy_script")
    if out.get("status") in ("draft", "review", "rejected", "suspended"):
        out["review_issues"] = review_issues(out)
        out["can_approve"] = not out["review_issues"]
    return out


def get_latest_version(s: Session, app_id: int) -> dict | None:
    row = s.execute(
        select(app_versions_t)
        .where(app_versions_t.c.app_id == app_id)
        .order_by(app_versions_t.c.created_at.desc())
        .limit(1)
    ).mappings().first()
    return _row(row) if row else None


def get_by_slug(s: Session, slug: str, *, include_unpublished: bool = False) -> dict:
    stmt = select(apps_t).where(apps_t.c.slug == slug)
    if not include_unpublished:
        stmt = stmt.where(apps_t.c.status == "published")
    row = s.execute(stmt).mappings().first()
    if not row:
        raise AppNotFound(slug)
    app = _row(row)
    return _serialize_app(app, latest=get_latest_version(s, app["id"]))


def list_apps(
    s: Session,
    *,
    q: str = "",
    category: str | None = None,
    sort: str = "popular",
    page: int = 1,
    page_size: int = 20,
    status: str = "published",
) -> dict[str, Any]:
    page = max(1, page)
    page_size = min(100, max(1, page_size))
    conds = []
    if status != "all":
        conds.append(apps_t.c.status == status)
    if category:
        conds.append(apps_t.c.category == category)
    if q.strip():
        like = f"%{q.strip()}%"
        conds.append(or_(
            apps_t.c.name.ilike(like),
            apps_t.c.description.ilike(like),
            apps_t.c.slug.ilike(like),
            apps_t.c.task_type.ilike(like),
        ))
    where = and_(*conds) if conds else True
    total = s.execute(select(func.count()).select_from(apps_t).where(where)).scalar_one()
    order = {
        "popular": apps_t.c.install_count.desc(),
        "rating": apps_t.c.rating_avg.desc(),
        "newest": apps_t.c.created_at.desc(),
        "price": apps_t.c.price.asc(),
    }.get(sort, apps_t.c.install_count.desc())
    rows = s.execute(
        select(apps_t).where(where).order_by(order)
        .limit(page_size).offset((page - 1) * page_size)
    ).mappings().all()
    items = []
    for r in rows:
        app = _row(r)
        items.append(_serialize_app(app, latest=get_latest_version(s, app["id"])))
    return {
        "items": items,
        "total": int(total),
        "page": page,
        "page_size": page_size,
    }


def list_my_apps(s: Session, *, author_id: int) -> dict[str, Any]:
    """开发者「我的提交」：含 draft/review/published/rejected/suspended。"""
    rows = s.execute(
        select(apps_t)
        .where(apps_t.c.author_id == author_id)
        .order_by(apps_t.c.updated_at.desc())
        .limit(100)
    ).mappings().all()
    items = []
    for r in rows:
        app = _row(r)
        items.append(_serialize_app(app, latest=get_latest_version(s, app["id"])))
    return {"ok": True, "items": items, "total": len(items)}


def _sanitize_display_meta(raw: Any) -> dict[str, Any]:
    """富展示内容白名单消毒（防注入任意 JSON 撑爆详情页/夹带脚本）。

    结构约定（与官方应用 display_meta 一致，客户端详情页直接消费）：
    - tagline: 一句话简介（≤120 字）
    - features: 功能亮点列表（≤8 条，每条 ≤200 字）
    - scenarios: 典型场景（≤6 条，{icon?, title, desc} 或纯字符串）
    - capability_tags: 能力标签（≤8 个，每个 ≤24 字）
    - usage: 使用方法步骤（≤8 条，每条 ≤200 字 · 输入/参数/输出/计费说明）
    """
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    if "coming_soon" in raw:
        out["coming_soon"] = bool(raw.get("coming_soon"))
    tagline = raw.get("tagline")
    if isinstance(tagline, str) and tagline.strip():
        out["tagline"] = tagline.strip()[:120]
    features = raw.get("features")
    if isinstance(features, list):
        cleaned = [str(f).strip()[:200] for f in features if str(f).strip()][:8]
        if cleaned:
            out["features"] = cleaned
    scenarios = raw.get("scenarios")
    if isinstance(scenarios, list):
        sc_out = []
        for sc in scenarios[:6]:
            if isinstance(sc, dict):
                title = str(sc.get("title") or "").strip()[:60]
                if not title:
                    continue
                item: dict[str, str] = {"title": title}
                desc = str(sc.get("desc") or "").strip()[:200]
                icon = str(sc.get("icon") or "").strip()[:32]
                if desc:
                    item["desc"] = desc
                if icon:
                    item["icon"] = icon
                sc_out.append(item)
            elif isinstance(sc, str) and sc.strip():
                sc_out.append({"title": sc.strip()[:60]})
        if sc_out:
            out["scenarios"] = sc_out
    tags = raw.get("capability_tags")
    if isinstance(tags, list):
        cleaned = [str(t).strip()[:24] for t in tags if str(t).strip()][:8]
        if cleaned:
            out["capability_tags"] = cleaned
    usage = raw.get("usage")
    if isinstance(usage, list):
        cleaned = [str(u).strip()[:200] for u in usage if str(u).strip()][:8]
        if cleaned:
            out["usage"] = cleaned
    em = raw.get("execution_model") or raw.get("executionModel")
    if isinstance(em, str) and em.strip():
        text = em.strip().lower().replace("-", "_")[:32]
        if text in ("legacy_script", "runtime_v2"):
            out["execution_model"] = text
    caps = raw.get("required_capabilities")
    if isinstance(caps, list):
        cap_out = []
        for c in caps[:16]:
            if isinstance(c, str) and c.strip():
                cap_out.append({"name": c.strip()[:64], "version": "1.0.0"})
            elif isinstance(c, dict) and str(c.get("name") or "").strip():
                name = str(c.get("name")).strip()[:64]
                ver = str(c.get("version") or "1.0.0").strip()[:32] or "1.0.0"
                cap_out.append({"name": name, "version": ver})
        if cap_out:
            out["required_capabilities"] = cap_out
    return out


def create_app(s: Session, author_id: int, body: dict[str, Any]) -> dict:
    slug = (body.get("slug") or "").strip().lower()
    if not _SLUG_RE.match(slug):
        raise MarketplaceError("slug 格式非法（小写字母数字连字符）")
    _validate_launch_fields(body)
    plugin_fields = _validate_runtime_plugin_fields(body, for_publish=False)
    manifest = _submission_document(body.get("manifest"), name="manifest", max_bytes=64 * 1024)
    config_schema = _submission_document(body.get("config_schema"), name="config_schema", max_bytes=32 * 1024)
    task_type = (body.get("task_type") or "").strip() or None
    launch_kind = str(body.get("launch_kind") or "workload").strip().lower()
    official = _official_task_types()
    if launch_kind == "workload" and not task_type:
        raise MarketplaceError("workload 应用必须指定 task_type")
    if task_type and task_type not in official:
        # M1–M2：仅允许映射已有 task_type；第三方 custom 后置
        raise MarketplaceError(f"task_type 未在 task_registry: {task_type}")
    net = sandbox_svc.resolve_sandbox_network(
        requested=body.get("sandbox_network"),
        verified_author=bool(body.get("verified_author")),
        author_name=body.get("author_name"),
        is_official_task_type=bool(task_type and task_type in official),
    )
    values = {
        "name": body["name"].strip(),
        "slug": slug,
        "author_id": author_id,
        "author_name": (body.get("author_name") or "").strip() or None,
        "category": body.get("category") or "other",
        "description": body.get("description") or "",
        "icon_url": body.get("icon_url"),
        "pricing_model": body.get("pricing_model") or "free",
        "price": Decimal(str(body.get("price") or 0)),
        "free_trials": int(body.get("free_trials") or 0),
        "task_type": task_type,
        "input_kind": body.get("input_kind") or "single_file",
        "accept_formats": body.get("accept_formats") or [],
        "tiers": body.get("tiers") or [],
        "min_memory_mb": int(body.get("min_memory_mb") or 1024),
        "gpu_required": bool(body.get("gpu_required")),
        "sandbox_network": net,
        "launch_kind": body.get("launch_kind") or "workload",
        "deep_link_url": body.get("deep_link_url"),
        "display_meta": _sanitize_display_meta(body.get("display_meta")),
        **plugin_fields,
        "status": "review",
        "verified_author": False,
        "platform_share_pct": float(commission_svc.PLATFORM_APP_SHARE * 100),
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
    }
    try:
        res = s.execute(insert(apps_t).values(**values).returning(apps_t.c.id))
        app_id = res.scalar_one()
    except Exception as exc:
        raise MarketplaceError(f"创建失败: {exc}") from exc
    version = (body.get("version") or "1.0.0").strip()
    sha = body.get("sha256")
    signed = bool(body.get("signed", False))
    pricing_snapshot = {
        "pricing_model": values["pricing_model"],
        "price": str(values["price"]),
        "free_trials": values["free_trials"],
        "currency": "EDG",
        "platform_share_pct": str(values["platform_share_pct"]),
    }
    # 开发者提交进入审核；签名校验在审核通过时强制
    s.execute(insert(app_versions_t).values(
        app_id=app_id,
        version=version,
        script_bundle_url=body.get("script_bundle_url"),
        model_bundle_url=body.get("model_bundle_url"),
        changelog=body.get("changelog") or "初始提交",
        sha256=sha,
        size_bytes=int(body.get("size_bytes") or 0),
        signed=signed,
        manifest=manifest,
        config_schema=config_schema,
        pricing_snapshot=pricing_snapshot,
        version_summary=str(body.get("version_summary") or "").strip()[:240],
        created_at=datetime.utcnow(),
    ))
    s.flush()
    return get_by_slug(s, slug, include_unpublished=True)


def update_app(s: Session, slug: str, author_id: int, body: dict[str, Any], *, is_admin: bool) -> dict:
    app = get_by_slug(s, slug, include_unpublished=True)
    merged = {
        "launch_kind": body.get("launch_kind", app.get("launch_kind")),
        "deep_link_url": body.get("deep_link_url", app.get("deep_link_url")),
    }
    _validate_launch_fields(merged, require_url_for_link=True)
    if not is_admin and app.get("author_id") != author_id:
        raise AppAccessDenied("仅作者或管理员可更新")
    allowed = {
        "name", "description", "icon_url", "category", "pricing_model", "price",
        "free_trials", "input_kind", "accept_formats", "tiers", "min_memory_mb",
        "gpu_required", "deep_link_url", "launch_kind",
    }
    patch = {k: body[k] for k in allowed if k in body}
    plugin_keys = {
        "package_kind", "runtime_api", "capabilities", "plugin_package_url",
        "plugin_manifest_url", "plugin_signature_url",
    }
    if plugin_keys.intersection(body):
        normalized = _validate_runtime_plugin_fields({
            **{key: app.get(key) for key in plugin_keys},
            "launch_kind": body.get("launch_kind", app.get("launch_kind")),
            **{key: body[key] for key in plugin_keys if key in body},
        }, for_publish=False)
        patch.update({key: normalized[key] for key in plugin_keys if key in body})
    version_keys = {
        "manifest", "config_schema", "version_summary", "script_bundle_url",
        "model_bundle_url", "sha256", "size_bytes", "signed", "changelog",
    }
    version_patch: dict[str, Any] = {}
    for key in version_keys.intersection(body):
        value = body[key]
        if key in ("manifest", "config_schema"):
            value = _submission_document(value, name=key, max_bytes=(64 if key == "manifest" else 32) * 1024)
        elif key == "sha256" and value is not None and not _SHA256_RE.fullmatch(value):
            raise MarketplaceError("sha256 必须是 64 位十六进制摘要")
        elif key == "size_bytes" and (value is None or value < 0):
            raise MarketplaceError("size_bytes 不能为负数")
        elif key == "version_summary" and value is not None:
            value = str(value).strip()[:240]
        version_patch[key] = value
    if "display_meta" in body and body["display_meta"] is not None:
        patch["display_meta"] = _sanitize_display_meta(body["display_meta"])
    if "sandbox_network" in body:
        patch["sandbox_network"] = sandbox_svc.resolve_sandbox_network(
            requested=body["sandbox_network"],
            verified_author=bool(app.get("verified_author")),
            author_name=app.get("author_name"),
            is_official_task_type=bool(app.get("task_type") in _official_task_types()),
        )
    if app.get("status") == "published" and (patch or version_patch):
        raise MarketplaceError("已上架商品不可直接改价或改展示/执行要求；请先下架并重新审核版本")
    # 字段分级（对齐上架文档承诺）：仅执行/资源/沙箱类敏感字段回审核，
    # 运营类字段（名称/描述/定价/富展示）即时生效
    SENSITIVE = {
        "input_kind", "accept_formats", "tiers", "min_memory_mb",
        "gpu_required", "sandbox_network", "launch_kind", "deep_link_url",
    }
    if not is_admin and (any(k in patch for k in SENSITIVE | plugin_keys) or version_patch):
        patch["status"] = "review"
    if {"pricing_model", "price", "free_trials"}.intersection(patch):
        version_patch["pricing_snapshot"] = {
            "pricing_model": patch.get("pricing_model", app.get("pricing_model") or "free"),
            "price": str(patch.get("price", app.get("price") or 0)),
            "free_trials": patch.get("free_trials", app.get("free_trials") or 0),
            "currency": "EDG",
            "platform_share_pct": str(app.get("platform_share_pct") or 20),
        }
    patch["updated_at"] = datetime.utcnow()
    if patch:
        s.execute(update(apps_t).where(apps_t.c.id == app["id"]).values(**patch))
    if version_patch:
        latest = get_latest_version(s, app["id"])
        if latest is None:
            raise MarketplaceError("应用缺少版本记录，无法修改审核材料")
        s.execute(update(app_versions_t).where(app_versions_t.c.id == latest["id"]).values(**version_patch))
    s.flush()
    return get_by_slug(s, slug, include_unpublished=True)


def submit_app(s: Session, slug: str, author_id: int) -> dict:
    """Return an author's rejected draft to the review queue after corrections."""
    app = get_by_slug(s, slug, include_unpublished=True)
    if app.get("author_id") != author_id:
        raise AppAccessDenied("仅作者可重新提交审核")
    if app.get("status") not in ("draft", "rejected"):
        raise MarketplaceError("仅草稿或已驳回投稿可重新提交审核")
    s.execute(update(apps_t).where(apps_t.c.id == app["id"]).values(
        status="review", updated_at=datetime.utcnow(),
    ))
    AuditRepo.write(s, action="marketplace.review.resubmit", actor_account_id=author_id,
                    target_kind="app", target_id=str(app["id"]),
                    detail={"from": app["status"]})
    s.flush()
    return get_by_slug(s, slug, include_unpublished=True)


def _charge_monthly(
    s: Session, *, user_id: int, app: dict[str, Any],
) -> tuple[Decimal, datetime]:
    from platform_v8.services.marketplace import billing as billing_svc

    now = datetime.utcnow()
    period_key = now.strftime("%Y%m")
    try:
        out = billing_svc.charge_monthly_subscribe(
            s, user_id=user_id, app=app, period_key=period_key,
        )
    except billing_svc.BillingError as exc:
        raise MarketplaceError(str(exc)) from exc
    expires = now + timedelta(days=_MONTH_DAYS)
    return Decimal(str(out["charged"])), expires


def subscription_active(install_row: Any) -> bool:
    if install_row is None:
        return False
    exp = install_row.get("subscription_expires_at") if hasattr(install_row, "get") else None
    if exp is None and hasattr(install_row, "__getitem__"):
        try:
            exp = install_row["subscription_expires_at"]
        except Exception:
            exp = None
    if exp is None:
        return False
    if getattr(exp, "tzinfo", None) is not None:
        exp = exp.replace(tzinfo=None)
    return exp > datetime.utcnow()


def ensure_monthly_subscription(s: Session, slug: str, user_id: int) -> dict:
    """确保月订有效：未装则安装；已过期则续费。"""
    app = get_by_slug(s, slug)
    pricing = str(app.get("pricing_model") or "free").lower()
    if pricing != "monthly":
        return install_app(s, slug, user_id)

    existing = s.execute(
        select(installs_t).where(
            installs_t.c.app_id == app["id"],
            installs_t.c.user_id == user_id,
        )
    ).mappings().first()
    if existing and subscription_active(existing):
        return {
            "ok": True,
            "already_installed": True,
            "app": app,
            "version": existing["version"],
            "charged_edg": 0.0,
            "subscription_expires_at": (
                existing["subscription_expires_at"].isoformat() + "Z"
                if existing.get("subscription_expires_at") else None
            ),
            "install": _row(existing),
        }
    if existing:
        charged, sub_expires = _charge_monthly(s, user_id=user_id, app=app)
        s.execute(
            update(installs_t)
            .where(installs_t.c.id == existing["id"])
            .values(subscription_expires_at=sub_expires)
        )
        s.flush()
        inst = s.execute(
            select(installs_t).where(installs_t.c.id == existing["id"])
        ).mappings().first()
        return {
            "ok": True,
            "already_installed": True,
            "renewed": True,
            "app": app,
            "version": existing["version"],
            "charged_edg": float(charged),
            "subscription_expires_at": sub_expires.isoformat() + "Z",
            "install": _row(inst) if inst else None,
        }
    return install_app(s, slug, user_id)


def install_app(s: Session, slug: str, user_id: int) -> dict:
    app = get_by_slug(s, slug)
    latest = get_latest_version(s, app["id"])
    version = (latest or {}).get("version") or "1.0.0"
    pricing = str(app.get("pricing_model") or "free").lower()
    existing = s.execute(
        select(installs_t).where(
            installs_t.c.app_id == app["id"],
            installs_t.c.user_id == user_id,
        )
    ).mappings().first()
    if existing:
        if pricing == "monthly" and not subscription_active(existing):
            return ensure_monthly_subscription(s, slug, user_id)
        return {
            "ok": True,
            "already_installed": True,
            "app": app,
            "version": existing["version"],
            "subscription_expires_at": (
                existing["subscription_expires_at"].isoformat() + "Z"
                if existing.get("subscription_expires_at") else None
            ),
            "install": _row(existing),
        }

    price = Decimal(str(app.get("price") or 0))
    charged = Decimal("0")
    sub_expires: datetime | None = None

    # per_use 在 RunSession settle 扣款；one_time 在安装时买断；monthly 在安装/续费时扣款
    if pricing == "monthly":
        charged, sub_expires = _charge_monthly(s, user_id=user_id, app=app)
    elif pricing == "one_time" and price > 0:
        from platform_v8.services.marketplace import billing as billing_svc

        try:
            out = billing_svc.charge_one_time_install(s, user_id=user_id, app=app)
        except billing_svc.BillingError as exc:
            raise MarketplaceError(str(exc)) from exc
        charged = Decimal(str(out["charged"]))

    s.execute(insert(installs_t).values(
        app_id=app["id"],
        user_id=user_id,
        version=version,
        installed_at=datetime.utcnow(),
        use_count=0,
        subscription_expires_at=sub_expires,
    ))
    s.execute(
        update(apps_t)
        .where(apps_t.c.id == app["id"])
        .values(install_count=apps_t.c.install_count + 1, updated_at=datetime.utcnow())
    )
    s.flush()
    inst = s.execute(
        select(installs_t).where(
            installs_t.c.app_id == app["id"],
            installs_t.c.user_id == user_id,
        )
    ).mappings().first()
    return {
        "ok": True,
        "already_installed": False,
        "app": app,
        "version": version,
        "charged_edg": float(charged),
        "subscription_expires_at": (
            sub_expires.isoformat() + "Z" if sub_expires else None
        ),
        "install": _row(inst) if inst else None,
        "bundle": {
            "script_bundle_url": (latest or {}).get("script_bundle_url"),
            "model_bundle_url": (latest or {}).get("model_bundle_url"),
            "sha256": (latest or {}).get("sha256"),
            "signed": (latest or {}).get("signed"),
        },
    }


def uninstall_app(s: Session, slug: str, user_id: int) -> dict:
    app = get_by_slug(s, slug, include_unpublished=True)
    res = s.execute(
        delete(installs_t).where(
            installs_t.c.app_id == app["id"],
            installs_t.c.user_id == user_id,
        )
    )
    s.flush()
    return {"ok": True, "removed": res.rowcount > 0}


class WorkerNotOwned(MarketplaceError):
    """节点不存在或不属于当前用户。"""


class WorkerOffline(MarketplaceError):
    """目标节点不在线，无法远程下发。"""


def _require_owned_online_worker(s: Session, *, worker_id: str, user_id: int):
    from platform_v8.storage.repo import WorkerRepo

    worker = WorkerRepo.by_id(s, worker_id)
    if worker is None or int(getattr(worker, "owner_id", -1) or -1) != int(user_id):
        raise WorkerNotOwned("节点不存在或不属于你")
    if not getattr(worker, "is_online", False):
        raise WorkerOffline("目标节点不在线，请选择在线设备或改为安装到应用库")
    return worker


def _app_control_params(app: dict[str, Any], *, version: str | None = None) -> dict[str, Any]:
    """下发给节点的 install_app / uninstall_app 参数（白名单字段，不含任意 URL 执行）。"""
    bundle = {
        "script_bundle_url": app.get("script_bundle_url"),
        "model_bundle_url": app.get("model_bundle_url"),
        "sha256": app.get("sha256"),
        "signed": bool(app.get("signed")),
        "size_bytes": int(app.get("size_bytes") or 0),
    }
    return {
        "slug": str(app.get("slug") or ""),
        "name": str(app.get("name") or app.get("slug") or ""),
        "version": str(version or app.get("version") or "1.0.0"),
        "task_type": app.get("task_type"),
        "icon_url": app.get("icon_url"),
        "coming_soon": bool(app.get("coming_soon")),
        "bundle": bundle,
    }


def prepare_remote_install(s: Session, slug: str, user_id: int, worker_id: str) -> dict[str, Any]:
    """Read an existing free entitlement and prepare a device control without billing.

    The broker only confirms a frame was sent; a matching node result is a later
    event. This path must not call ``install_app`` before that result because a
    paid install could charge EDG even if the device rejects the control. Free
    apps must first be added through the separate library endpoint.
    """
    worker = _require_owned_online_worker(s, worker_id=worker_id, user_id=user_id)
    app = get_by_slug(s, slug)
    if bool(app.get("coming_soon")):
        raise MarketplaceError("应用即将上线，暂不可安装")
    pricing = str(app.get("pricing_model") or "free").lower()
    price = Decimal(str(app.get("price") or 0))
    if pricing != "free" or price != 0:
        raise MarketplaceError("付费应用暂不支持远程安装；需先完成设备回执与收费结算验收")
    existing = s.execute(
        select(installs_t).where(
            installs_t.c.app_id == app["id"],
            installs_t.c.user_id == user_id,
        )
    ).mappings().first()
    if existing is None:
        raise MarketplaceError("请先将免费应用加入我的应用库，再安装到设备")
    version = str(existing["version"] or app.get("latest_version") or "1.0.0")
    params = _app_control_params(app, version=version)
    return {
        "ok": True,
        "action": "install_app",
        "worker_id": str(worker.id),
        "worker_name": getattr(worker, "name", "") or str(worker.id),
        "params": params,
        "install": {
            "ok": True,
            "already_installed": True,
            "charged_edg": 0.0,
            "version": version,
            "install": _row(existing),
        },
        "reason": f"portal remote install · slug={slug}",
    }


def prepare_remote_uninstall(s: Session, slug: str, user_id: int, worker_id: str) -> dict[str, Any]:
    """校验节点归属/在线，返回待下发 uninstall_app control 参数（不删账户库权限）。"""
    worker = _require_owned_online_worker(s, worker_id=worker_id, user_id=user_id)
    app = get_by_slug(s, slug, include_unpublished=True)
    params = {
        "slug": str(app.get("slug") or slug),
        "name": str(app.get("name") or slug),
    }
    return {
        "ok": True,
        "action": "uninstall_app",
        "worker_id": str(worker.id),
        "worker_name": getattr(worker, "name", "") or str(worker.id),
        "params": params,
        "reason": f"portal remote uninstall · slug={slug}",
    }


def library(s: Session, user_id: int) -> dict:
    insts = s.execute(
        select(installs_t).where(installs_t.c.user_id == user_id)
        .order_by(installs_t.c.installed_at.desc())
    ).mappings().all()
    items = []
    for inst in insts:
        app_row = s.execute(
            select(apps_t).where(apps_t.c.id == inst["app_id"])
        ).mappings().first()
        if not app_row:
            continue
        app = _serialize_app(_row(app_row), latest=get_latest_version(s, app_row["id"]))
        items.append({
            "install": _row(inst),
            "app": app,
        })
    return {"items": items, "total": len(items)}


def mark_used(s: Session, slug: str, user_id: int) -> dict:
    app = get_by_slug(s, slug, include_unpublished=True)
    s.execute(
        update(installs_t)
        .where(installs_t.c.app_id == app["id"], installs_t.c.user_id == user_id)
        .values(
            last_used_at=datetime.utcnow(),
            use_count=installs_t.c.use_count + 1,
        )
    )
    s.flush()
    return {"ok": True, "app": app}


def list_reviews(s: Session, slug: str, *, limit: int = 50) -> dict:
    app = get_by_slug(s, slug, include_unpublished=True)
    rows = s.execute(
        select(reviews_t, accounts_t.c.username.label("user_name"))
        .join(accounts_t, accounts_t.c.id == reviews_t.c.user_id, isouter=True)
        .where(reviews_t.c.app_id == app["id"])
        .order_by(reviews_t.c.created_at.desc()).limit(limit)
    ).mappings().all()
    return {"items": [_row(r) for r in rows], "app_id": app["id"]}


def upsert_review(s: Session, slug: str, user_id: int, rating: int, comment: str = "") -> dict:
    if rating < 1 or rating > 5:
        raise MarketplaceError("rating 须在 1–5")
    app = get_by_slug(s, slug)
    existing = s.execute(
        select(reviews_t).where(
            reviews_t.c.app_id == app["id"],
            reviews_t.c.user_id == user_id,
        )
    ).mappings().first()
    if existing:
        s.execute(
            update(reviews_t)
            .where(reviews_t.c.id == existing["id"])
            .values(rating=rating, comment=comment or existing.get("comment"))
        )
    else:
        s.execute(insert(reviews_t).values(
            app_id=app["id"],
            user_id=user_id,
            rating=rating,
            comment=comment or "",
            created_at=datetime.utcnow(),
        ))
    s.flush()
    # 重算均分
    stats = s.execute(
        select(func.avg(reviews_t.c.rating), func.count())
        .where(reviews_t.c.app_id == app["id"])
    ).one()
    avg, cnt = stats[0], stats[1]
    s.execute(
        update(apps_t).where(apps_t.c.id == app["id"]).values(
            rating_avg=round(float(avg or 0), 2),
            rating_count=int(cnt or 0),
            updated_at=datetime.utcnow(),
        )
    )
    s.flush()
    return list_reviews(s, slug)


def list_review_queue(s: Session, *, limit: int = 50) -> dict:
    rows = s.execute(
        select(apps_t).where(apps_t.c.status == "review")
        .order_by(apps_t.c.updated_at.asc()).limit(limit)
    ).mappings().all()
    items = []
    for row in rows:
        app = _serialize_app(_row(row), latest=get_latest_version(s, row["id"]))
        app["review_issues"] = review_issues(app)
        app["can_approve"] = not app["review_issues"]
        items.append(app)
    return {"items": items}


def review_issues(app: dict[str, Any]) -> list[str]:
    """给审核人与作者展示阻断项；作者自填 signed/SHA/URL 均不是信任凭据。"""
    issues = []
    if not app.get("verified_author") and (app.get("author_name") or "").strip() in sandbox_svc.OFFICIAL_AUTHOR_NAMES:
        issues.append("作者填写了官方名称，但账号没有经过官方身份核验")
    if app.get("pricing_model") != "free" or Decimal(str(app.get("price") or 0)) != 0:
        issues.append("付费插件需版本化价格与分账政策；已保存报价草案，但尚无购买、退款和结算验收")
    kind = str(app.get("launch_kind") or "workload")
    if kind in ("workload", "plugin"):
        issues.append("可执行插件缺少独立验包与发布者签名核验；自填 signed 和 SHA 不构成凭据")
        if not app.get("manifest"):
            issues.append("请提交版本 manifest，说明入口、权限和运行时要求")
        bundle_url = app.get("plugin_package_url") or app.get("script_bundle_url")
        if not bundle_url:
            issues.append("请提交 HTTPS 插件包来源")
        if not _SHA256_RE.fullmatch(str(app.get("sha256") or "")):
            issues.append("请提交插件包 SHA-256 摘要")
        if kind == "plugin":
            try:
                _validate_runtime_plugin_fields(app, for_publish=True)
            except MarketplaceError as exc:
                issues.append(str(exc))
        issues.append("平台尚无可信发布者验签回执与不可变包存储证明，不能批准可执行包")
    elif kind == "webview":
        if not str(app.get("deep_link_url") or "").lower().startswith("https://"):
            issues.append("网页入口必须是 HTTPS")
        if app.get("sandbox_network") != "none":
            issues.append("网页展示不能申请本机脚本网络权限")
        if app.get("script_bundle_url") or app.get("model_bundle_url"):
            issues.append("网页展示不可夹带可执行文件或模型包")
        if (app.get("plugin_package_url") or app.get("plugin_manifest_url")
                or app.get("plugin_signature_url") or app.get("manifest")
                or app.get("package_kind") == "plugin"):
            issues.append("网页展示不可夹带插件包或可执行 manifest")
    else:
        issues.append("旧审核入口仅支持免费 HTTPS 网页展示；其他启动方式待独立安全审核")
    return issues


def moderate_app(s: Session, app_id: int, *, action: str, note: str = "", operator_id: int | None = None) -> dict:
    row = s.execute(select(apps_t).where(apps_t.c.id == app_id)).mappings().first()
    if not row:
        raise AppNotFound(str(app_id))
    app = _serialize_app(_row(row), latest=get_latest_version(s, app_id))
    if not note.strip():
        raise MarketplaceError("请填写审核原因，便于之后追溯")
    if action == "approve":
        if app.get("status") not in ("review", "suspended"):
            raise MarketplaceError("仅待审核或管理员下架的商品可以审核通过")
        # P1-10 · 深链/网页应用上架前必须有合法入口，禁止「可填不可跑」进商店
        _validate_launch_fields(
            {
                "launch_kind": app.get("launch_kind") or "workload",
                "deep_link_url": app.get("deep_link_url"),
            },
            require_url_for_link=True,
        )
        issues = review_issues(app)
        if issues:
            raise MarketplaceError("无法上架：" + "；".join(issues))
        new_status = "published"
        s.execute(update(apps_t).where(apps_t.c.id == app_id).values(
            status=new_status,
            updated_at=datetime.utcnow(),
        ))
    elif action == "reject":
        if app.get("status") != "review":
            raise MarketplaceError("仅待审核投稿可驳回")
        s.execute(update(apps_t).where(apps_t.c.id == app_id).values(
            status="rejected",
            updated_at=datetime.utcnow(),
        ))
    elif action == "suspend":
        if app.get("status") != "published":
            raise MarketplaceError("仅已上架商品可下架")
        s.execute(update(apps_t).where(apps_t.c.id == app_id).values(
            status="suspended",
            updated_at=datetime.utcnow(),
        ))
    else:
        raise MarketplaceError(f"未知审核动作: {action}")
    AuditRepo.write(s, action=f"marketplace.review.{action}", actor_account_id=operator_id,
                    actor_kind="admin", target_kind="app", target_id=str(app_id),
                    detail={"from": app.get("status"), "note": note.strip()[:500]})
    s.flush()
    logger.info("marketplace moderate app_id=%s action=%s note=%s", app_id, action, note[:200])
    return get_by_slug(s, app["slug"], include_unpublished=True)


def build_run_hint(app: dict[str, Any]) -> dict[str, Any]:
    """客户端组 workload / 深链唤起的提示（不改引擎）。"""
    kind = app.get("launch_kind") or "workload"
    if kind == "plugin":
        return {
            "mode": "plugin",
            "executor": "plugin.v1",
            "runtime_api": app.get("runtime_api") or "1.0.0",
            "capabilities": app.get("capabilities") or [],
            "ready": False,
            "reason": "平台尚未核验发布者签名与不可变包来源",
        }
    if kind in ("deep_link", "webview"):
        url = (app.get("deep_link_url") or "").strip()
        return {
            "mode": kind,
            "url": url,
            "task_type": app.get("task_type"),
            "ready": bool(url and _DEEP_LINK_RE.match(url)),
        }
    return {
        "mode": "workload",
        "task_type": app.get("task_type"),
        "input_kind": app.get("input_kind") or "single_file",
        "accept_formats": app.get("accept_formats") or [],
        "pricing_model": app.get("pricing_model"),
        "price": app.get("price"),
        "sandbox_network": app.get("sandbox_network") or "none",
    }
