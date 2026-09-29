"""
Economy HTTP router · /api/v8/economy/*
"""
from __future__ import annotations
import logging
import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session, get_current_account, get_admin_account
from platform_v8.core import Account
from platform_v8.services.economy import ledger as ledger_svc
from platform_v8.services.economy import balance as balance_svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/economy", tags=["economy"])


# ── GET /balance ─────────────────────────────────────
class BalanceResponse(BaseModel):
    ok: bool = True
    account_id: int
    balance: Decimal
    currency: str = "CNY"
    # 2026-05-19 · 补齐前端 Wallet.vue 期望的字段，让数据贯通
    total_earned: Decimal = Decimal("0")
    total_spent: Decimal = Decimal("0")
    transaction_count: int = 0


@router.get("/balance", response_model=BalanceResponse, summary="当前余额（含累计收入/支出/交易笔数）")
def get_balance_endpoint(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
    force_recompute: bool = Query(default=False,
                                  description="从 ledger SUM 重算 (admin 审计用)"),
):
    if force_recompute and not current.is_admin:
        raise HTTPException(status_code=403, detail="force_recompute 需要 admin 权限")
    bal = balance_svc.get_balance(session, current.id, force_recompute=force_recompute)

    # 聚合 we_ledger，一次拿 income/expense/count 三个值
    total_earned = Decimal("0")
    total_spent = Decimal("0")
    tx_count = 0
    try:
        from sqlalchemy import text
        row = session.execute(text("""
            SELECT
              COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0)      AS income,
              COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0)     AS expense,
              COUNT(*)                                                            AS cnt
            FROM we_ledger
            WHERE account_id = :aid
        """), {"aid": int(current.id)}).one_or_none()
        if row:
            total_earned = Decimal(str(row[0] or 0))
            total_spent = Decimal(str(row[1] or 0))
            tx_count = int(row[2] or 0)
    except Exception as exc:
        logger.warning("balance: ledger 聚合失败（不影响 balance）: %s", exc)

    return BalanceResponse(
        account_id=current.id,
        balance=bal,
        total_earned=total_earned,
        total_spent=total_spent,
        transaction_count=tx_count,
    )


# ── GET /ledger · 流水查询 ──────────────────────────
@router.get("/ledger", summary="账本流水")
def list_ledger_endpoint(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
    type: str | None = Query(default=None, description="筛选类型 e.g. ESCROW_HOLD"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    from platform_v8.storage.repo import LedgerRepo
    entries = LedgerRepo.list_by_account(session, current.id,
                                         type=type, limit=limit, offset=offset)
    # 序列化 (Decimal → str · datetime → iso)
    out = []
    for e in entries:
        out.append({
            "id": e["id"],
            "type": e["type"],
            "amount": str(e["amount"]),
            "currency": e["currency"],
            "workload_id": e.get("workload_id"),
            "shard_id": e.get("shard_id"),
            "note": e.get("note", ""),
            "created_at": e["created_at"].isoformat() if e.get("created_at") else None,
        })
    return {"ok": True, "items": out, "limit": limit, "offset": offset}


# ── POST /admin/deposit · admin 给用户充值 ──────────
class DepositRequest(BaseModel):
    account_id: int
    amount: Decimal = Field(..., gt=0)
    note: str = ""
    idempotent_key: str | None = None


@router.post("/admin/deposit", summary="管理员: 给用户充值")
def admin_deposit_endpoint(
    body: DepositRequest,
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    key = body.idempotent_key or f"deposit:{body.account_id}:{uuid.uuid4().hex}"
    try:
        entry = ledger_svc.deposit(
            session,
            account_id=body.account_id,
            amount=body.amount,
            idempotent_key=key,
            note=body.note,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # S2-T8 · 2026-06-07 · 高危操作补 audit (admin 给用户充钱)
    try:
        from platform_v8.storage.repo import AuditRepo as _AuditRepo
        _AuditRepo.write(
            session,
            action="admin.economy.deposit",
            actor_account_id=_admin.id,
            actor_kind="admin",
            target_kind="account",
            target_id=str(body.account_id),
            detail={
                "amount": str(body.amount),
                "idempotent_key": key,
                "note": body.note,
                "ledger_id": entry.id,
            },
        )
    except Exception as _exc:
        logger.warning("admin.deposit audit 写入失败 (静默): %s", _exc)

    return {
        "ok": True,
        "ledger_id": entry.id,
        "account_id": body.account_id,
        "amount": str(body.amount),
        "idempotent_key": key,
    }


# ── POST /withdraw · 用户提现 ──────────────────────
class WithdrawRequestBody(BaseModel):
    amount: Decimal = Field(..., gt=0)
    note: str = ""


@router.post("/withdraw", summary="旧提现接口已停用", deprecated=True)
def withdraw_endpoint(
    body: WithdrawRequestBody,
    current: Account = Depends(get_current_account),
):
    # 历史实现直接记负向 WITHDRAW 流水，但没有提现申请、资金冻结或打款记录。
    # 禁止继续从此入口变更余额；客户端应改走申请式提现流程。
    raise HTTPException(
        status_code=410,
        detail="旧提现接口已停用，请改用 /api/v8/payment/withdraw 提交提现申请",
    )


# ── GET /daily-report?date= · admin 看日报 ─────────
@router.get("/daily-report", summary="管理员: 当日汇总报告")
def daily_report_endpoint(
    date: str | None = Query(default=None,
                             description="YYYY-MM-DD · 不填默认今天"),
    regenerate: bool = Query(default=False,
                             description="True = 强制重新计算 (不读 cache)"),
    session: Session = Depends(get_session),
    _admin: Account = Depends(get_admin_account),
):
    from datetime import date as date_cls
    from platform_v8.services.economy import settlement as settle_svc

    if date:
        try:
            day = date_cls.fromisoformat(date)
        except ValueError:
            raise HTTPException(status_code=400, detail="date 格式应为 YYYY-MM-DD")
    else:
        day = date_cls.today()

    if regenerate:
        report = settle_svc.generate_daily_report(session, day)
    else:
        report = settle_svc.get_daily_report(session, day)
        if report is None:
            report = settle_svc.generate_daily_report(session, day)

    return {"ok": True, "report": report}


# ════════════════════════════════════════════════════════════════════
# P1-1 · 2026-05-24 · 经济参数后台 + 报价模拟 (完善计划第一阶段)
#
# 设计:
#   - 配置存 we_kv (key = 'economy:settings:v1') · 不新增表 · 无 migration
#   - 默认值跟 split.py / admin EconomyControl.vue 对齐 (兼容 risk_pool_share)
#   - 报价是纯计算 · 不创建订单 · 不锁钱 · 不影响主链路
#   - PUT 必须 admin · 写 audit log + 版本递增
#   - /workloads 提交已闭环: 普通账号强制服务端价 (见 services/economy/task_pricing.py)
#     (灰度接入在第四阶段 quote_id · 本阶段只补 UI 后端 + 报价模拟器)
# ════════════════════════════════════════════════════════════════════
_ECONOMY_SETTINGS_KEY = "economy:settings:v1"

_DEFAULT_SETTINGS: dict = {
    "version": 0,
    "updated_at": None,
    "updated_by": None,
    # 分润 (跟 split.py V8_SETTLEMENT_*_RATIO 默认对齐)
    "node_share": 0.65,
    "platform_share": 0.30,
    "channel_share": 0.05,
    "risk_pool_share": 0.0,
    # 积分锚定
    "cp_per_yuan": 100,
    # 时效系数
    "speed_t24": 1.0,
    "speed_t8": 1.3,
    "speed_t2": 1.8,
    # 质量系数
    "quality_standard": 1.0,
    "quality_double": 1.2,
    "quality_high": 1.5,
    # 失败返还
    "refund_node_failure": 1.0,
    "refund_quality_partial": 0.6,
    "refund_owner_cancel_done_ratio": True,
    # 任务定价表 (前端 EconomyControl.vue task_pricing)
    # 空表时由 _BUILTIN_TASK_PRICING 兜底填充，避免 quote/estimate 脱节
    "task_pricing": [],
    # 已审阅执行/验收策略共用的人民币价目。每一策略只需管理一次。
    "reviewed_adapter_tariffs": [],
    # Official versioned media profiles start empty. The historical task-level
    # video tariff does not prove a model/workflow or paid media channel exists.
    "media_profiles": [],
}

# 内置常用任务定价 · 与历史 estimate 兜底单价 0.50 对齐；admin 可在设置里覆盖
_BUILTIN_TASK_PRICING: list[dict] = [
    {"task_type": tt, "base_price": 0.50, "min_charge": 0.10, "unit": "次"}
    for tt in (
        "base64_encode",
        "base64_decode",
        "dedup_lines",
        "line_count",
        "word_count",
        "hash_batch",
        "md5_batch",
        "crc32_batch",
        "json_filter",
        "json_validate",
        "regex_extract",
        "text_diff",
        "text_extract",
        "text_mask",
        "text_replace",
        "text_sort",
        "text_split",
        "pdf_to_text",
        "pdf_info",
        "pdf_ocr",
        "ocr_image",
        "image_info",
        "image_compress",
        "image_convert",
        "image_resize",
        "image_thumbnail",
        "image_caption",
        "excel_export",
        "url_check",
        "url_parse",
        "crawl_url_fetch",
        "crawl_url_extract",
        "crawl_batch_fetch",
    )
]

# QS_VIDEOGEN_20260918 · 出片按秒计价(1 秒 = 0.5 元)；5 秒片 = 2.50 元
_BUILTIN_TASK_PRICING.append(
    {"task_type": "video_generate", "base_price": 0.50, "min_charge": 0.10, "unit": "秒"},
)


def _apply_builtin_task_pricing(merged: dict) -> dict:
    """settings / admin 桥接后仍无定价表时，填入内置常用价目。"""
    if not merged.get("task_pricing"):
        merged["task_pricing"] = [dict(row) for row in _BUILTIN_TASK_PRICING]
        logger.info(
            "_load_settings · 使用内置 task_pricing · %d 项",
            len(merged["task_pricing"]),
        )
    return merged


def _load_settings(session: Session) -> dict:
    """从 we_kv 读经济设置 · 不存在则返回默认值 (不写入)
    
    S3-T4 · 2026-06-07 · SSoT 桥接:
      历史 admin_v2 用 4 个独立 kv(economy:split/pricing/levels/withdraw),与
      本模块用的 economy:settings:v1(单 key)分裂。本函数读时优先 settings:v1,
      task_pricing[]/分润比例为空时回落桥接 admin_v2 的 kv,避免 admin 在
      前端录入定价后 estimate/quote 仍报"未配置"。
      长期方案: admin_v2 经济页迁到 settings:v1 SSoT(P2 单独 PR)。
    """
    from platform_v8.storage.repo import kv_t
    from sqlalchemy import select as _select
    row = session.execute(
        _select(kv_t).where(kv_t.c.k == _ECONOMY_SETTINGS_KEY)
    ).one_or_none()
    if row is None:
        merged = dict(_DEFAULT_SETTINGS)
    else:
        v = row.v
        if isinstance(v, str):
            import json as _json
            try:
                v = _json.loads(v)
            except Exception:
                v = {}
        merged = dict(_DEFAULT_SETTINGS)
        merged.update(v or {})

    # S3-T4 · 桥接:task_pricing 为空 → 从 admin_v2 economy:pricing(map) 转 list
    if not merged.get("task_pricing"):
        adm_row = session.execute(
            _select(kv_t).where(kv_t.c.k == "economy:pricing")
        ).one_or_none()
        if adm_row is not None:
            adm_v = adm_row.v
            if isinstance(adm_v, str):
                import json as _json
                try:
                    adm_v = _json.loads(adm_v)
                except Exception:
                    adm_v = {}
            if isinstance(adm_v, dict) and adm_v:
                # map {task_type: price} → task_pricing[{task_type, base_price, min_charge, unit}]
                merged["task_pricing"] = [
                    {"task_type": tt, "base_price": float(price),
                     "min_charge": 0.10, "unit": "次"}
                    for tt, price in adm_v.items()
                    if isinstance(price, (int, float)) and price > 0
                ]
                logger.debug("_load_settings · 从 admin_v2 economy:pricing 桥接 %d 个 task_type",
                             len(merged["task_pricing"]))

    # 桥接 split 比例 (admin_v2 用 0-100 整数 · settings:v1 用 0-1 float)
    adm_split_row = session.execute(
        _select(kv_t).where(kv_t.c.k == "economy:split")
    ).one_or_none()
    if adm_split_row is not None:
        adm_split = adm_split_row.v
        if isinstance(adm_split, str):
            import json as _json
            try:
                adm_split = _json.loads(adm_split)
            except Exception:
                adm_split = {}
        if isinstance(adm_split, dict):
            # admin_v2 的 node/platform/risk_pool 是完整的 100% 分润表；
            # 它没有 channel 一栏，不能再叠加 settings:v1 的默认 5%。
            if all(key in adm_split for key in ("node", "platform", "risk_pool")):
                merged["channel_share"] = 0.0
            if "node" in adm_split:
                merged["node_share"] = float(adm_split["node"]) / 100.0
            if "platform" in adm_split:
                merged["platform_share"] = float(adm_split["platform"]) / 100.0
            if "risk_pool" in adm_split:
                merged["risk_pool_share"] = float(adm_split["risk_pool"]) / 100.0
            # channel 不在 admin_v2,保留默认
    return _apply_builtin_task_pricing(merged)


def _validate_settings(data: dict) -> None:
    """全字段一致性校验 · 失败抛 400"""
    from platform_v8.services.media_profiles import official_profiles, MediaProfileError
    try:
        official_profiles(data)
    except MediaProfileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # 1. 分润之和 (node + platform + channel + risk_pool) 必须 ≈ 1.0
    try:
        node = float(data.get("node_share", 0))
        platform = float(data.get("platform_share", 0))
        channel = float(data.get("channel_share", 0))
        risk = float(data.get("risk_pool_share", 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="分润比例必须是数字")
    total = node + platform + channel + risk
    if not (0.999 <= total <= 1.001):
        raise HTTPException(
            status_code=400,
            detail=(f"分润比例之和必须 = 1.0 (当前 {total:.4f} = "
                    f"node {node} + platform {platform} + channel {channel} + risk {risk})"),
        )
    # 2. 系数非负
    for k in ("cp_per_yuan", "speed_t24", "speed_t8", "speed_t2",
              "quality_standard", "quality_double", "quality_high"):
        try:
            if float(data.get(k, 1.0)) < 0:
                raise HTTPException(status_code=400, detail=f"{k} 必须 >= 0")
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{k} 必须是数字")
    # 3. 退款比例 [0,1]
    for k in ("refund_node_failure", "refund_quality_partial"):
        try:
            v = float(data.get(k, 0))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{k} 必须是数字")
        if not (0 <= v <= 1):
            raise HTTPException(status_code=400, detail=f"{k} 必须在 [0, 1]")
    # 4. task_pricing 每项校验
    for idx, row in enumerate(data.get("task_pricing") or []):
        if not isinstance(row, dict):
            raise HTTPException(status_code=400, detail=f"task_pricing[{idx}] 必须是对象")
        if not row.get("task_type"):
            raise HTTPException(status_code=400, detail=f"task_pricing[{idx}].task_type 不能为空")
        try:
            if float(row.get("base_price", 0)) < 0:
                raise HTTPException(status_code=400, detail=f"{row['task_type']}.base_price 必须 >= 0")
            if float(row.get("min_charge", 0)) < 0:
                raise HTTPException(status_code=400, detail=f"{row['task_type']}.min_charge 必须 >= 0")
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{row['task_type']} 价格字段必须是数字")
    from platform_v8.services.economy.reviewed_adapter_tariffs import valid_tariff_rows
    if not valid_tariff_rows(data.get("reviewed_adapter_tariffs")):
        raise HTTPException(status_code=400, detail="reviewed_adapter_tariffs 必须是唯一、有效的人民币策略价目")


def _save_settings(session: Session, partial_update: dict, actor_username: str) -> dict:
    """合并 + 写入 we_kv · 版本递增 · 返回完整新设置"""
    from platform_v8.storage.repo import kv_t
    from sqlalchemy import insert as _insert
    from datetime import datetime as _dt
    cur = _load_settings(session)
    cur_version = int(cur.get("version", 0) or 0)

    merged = dict(cur)
    for k, v in partial_update.items():
        if k in ("version", "updated_at", "updated_by"):
            continue  # 这三个由服务端控制
        merged[k] = v
    merged["version"] = cur_version + 1
    merged["updated_at"] = _dt.utcnow().isoformat() + "Z"
    merged["updated_by"] = actor_username

    session.execute(kv_t.delete().where(kv_t.c.k == _ECONOMY_SETTINGS_KEY))
    session.execute(_insert(kv_t).values(
        k=_ECONOMY_SETTINGS_KEY,
        v=merged,
        updated_at=_dt.utcnow(),
    ))
    return merged


@router.get("/settings", summary="读经济参数 (分润 + 定价 + 时效/质量系数)")
def get_economy_settings(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    """admin 后台 + 企业端报价器都用 · 普通用户也可读 (用于展示报价)"""
    return _load_settings(session)


class EconomySettingsUpdate(BaseModel):
    """全字段 optional · 支持 PATCH-like 部分更新"""
    node_share: float | None = None
    platform_share: float | None = None
    channel_share: float | None = None
    risk_pool_share: float | None = None
    cp_per_yuan: float | None = None
    speed_t24: float | None = None
    speed_t8: float | None = None
    speed_t2: float | None = None
    quality_standard: float | None = None
    quality_double: float | None = None
    quality_high: float | None = None
    refund_node_failure: float | None = None
    refund_quality_partial: float | None = None
    refund_owner_cancel_done_ratio: bool | None = None
    task_pricing: list[dict] | None = None
    reviewed_adapter_tariffs: list[dict] | None = None
    media_profiles: list[dict] | None = None


@router.put("/settings", summary="管理员: 保存经济参数 (版本递增)")
def put_economy_settings(
    body: EconomySettingsUpdate,
    session: Session = Depends(get_session),
    admin: Account = Depends(get_admin_account),
):
    """
    PUT 等价 PATCH (合并语义) · 只传字段会被更新 · 其余保留旧值。

    重要: task_pricing 同时驱动 quote/estimate 与 submit 冻结金额（普通账号强制服务端价；
    admin / profile.honor_client_budget 可走客户端 budget 特殊通道）。
    第四阶段引入 quote_id 灰度后才会真正影响 escrow_hold + 分润。
    """
    partial = {k: v for k, v in body.model_dump().items() if v is not None}
    # 先 merge 完整 view 做校验 (避免单字段更新破坏整体一致性)
    previous_settings = _load_settings(session)
    merged_for_validate = dict(previous_settings)
    merged_for_validate.update(partial)
    _validate_settings(merged_for_validate)
    from platform_v8.services.media_profiles import validate_profile_update, MediaProfileError
    try:
        validate_profile_update(previous_settings, merged_for_validate)
    except MediaProfileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    saved = _save_settings(session, partial, actor_username=admin.username)
    # 审计
    try:
        from platform_v8.storage.repo import AuditRepo as _AuditRepo
        _AuditRepo.write(
            session,
            action="economy.settings.update",
            actor_account_id=admin.id,
            actor_kind="admin",
            target_kind="economy_settings",
            target_id=str(saved["version"]),
            detail={"changed_keys": list(partial.keys())},
        )
    except Exception as exc:
        logger.warning("economy.settings audit 写入失败 (静默): %s", exc)

    logger.info("economy.settings 已更新 · version=%s by=%s changed=%s",
                saved["version"], admin.username, list(partial.keys()))
    return saved


class QuoteRequest(BaseModel):
    task_type: str
    workload: float = Field(..., ge=0, description="工作量 (按 unit 计 · 如 1000 张图)")
    speed: str = Field(default="t24", description="t24 / t8 / t2")
    quality: str = Field(default="standard", description="standard / double / high")


@router.post("/quote", summary="任务报价 (按当前经济参数计算 · 不创建订单 · 不锁钱)")
def quote_task(
    body: QuoteRequest,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    """
    报价模拟器: workload × base_price × speed × quality → total_yuan → CP 三方分配。

    不会:
      - 创建订单
      - 写 ledger
      - 占用余额
      - 影响后续任务提交
    """
    from platform_v8.services.media_profiles import require_formal_media_channel, MediaProfileError
    try:
        require_formal_media_channel({"task_type": body.task_type})
    except MediaProfileError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    settings = _load_settings(session)
    pricing_rows = settings.get("task_pricing") or []
    row = next((r for r in pricing_rows if r.get("task_type") == body.task_type), None)
    if row is None:
        raise HTTPException(
            status_code=400,
            detail=f"task_type={body.task_type} 未配置定价 (请在管理后台·经济中枢·任务定价中添加)",
        )

    base_price = Decimal(str(row.get("base_price", 0)))
    min_charge = Decimal(str(row.get("min_charge", 0)))
    unit = row.get("unit", "次")

    speed_key = {"t24": "speed_t24", "t8": "speed_t8", "t2": "speed_t2"}.get(body.speed)
    if speed_key is None:
        raise HTTPException(status_code=400, detail="speed 必须是 t24 / t8 / t2")
    quality_key = {"standard": "quality_standard", "double": "quality_double",
                   "high": "quality_high"}.get(body.quality)
    if quality_key is None:
        raise HTTPException(status_code=400, detail="quality 必须是 standard / double / high")

    speed_factor = Decimal(str(settings.get(speed_key, 1.0)))
    quality_factor = Decimal(str(settings.get(quality_key, 1.0)))

    base_yuan = (Decimal(str(body.workload)) * base_price).quantize(Decimal("0.0001"))
    pre_min_total = (base_yuan * speed_factor * quality_factor).quantize(Decimal("0.0001"))
    if pre_min_total < min_charge:
        total_yuan = min_charge
        min_charge_applied = True
    else:
        total_yuan = pre_min_total
        min_charge_applied = False

    cp_per_yuan = Decimal(str(settings.get("cp_per_yuan", 100)))
    total_cp = (total_yuan * cp_per_yuan).quantize(Decimal("0.01"))

    node_share = Decimal(str(settings.get("node_share", 0.65)))
    platform_share = Decimal(str(settings.get("platform_share", 0.30)))
    channel_share = Decimal(str(settings.get("channel_share", 0.05)))
    risk_pool_share = Decimal(str(settings.get("risk_pool_share", 0.0)))

    node_cp = (total_cp * node_share).quantize(Decimal("0.01"))
    platform_cp = (total_cp * platform_share).quantize(Decimal("0.01"))
    channel_cp = (total_cp * channel_share).quantize(Decimal("0.01"))
    risk_pool_cp = (total_cp * risk_pool_share).quantize(Decimal("0.01"))

    return {
        "task_type": body.task_type,
        "unit": unit,
        "workload": float(body.workload),
        "base_price": str(base_price),
        "base_yuan": str(base_yuan),
        "speed_factor": str(speed_factor),
        "quality_factor": str(quality_factor),
        "min_charge_applied": min_charge_applied,
        "total_yuan": str(total_yuan),
        "total_cp": str(total_cp),
        "node_cp": str(node_cp),
        "platform_cp": str(platform_cp),
        "channel_cp": str(channel_cp),
        "risk_pool_cp": str(risk_pool_cp),
        "settings_version": int(settings.get("version", 0)),
        "currency": "CNY",
        "note": "此为报价模拟 · 不创建订单 · 不锁定预算 · 不影响任务提交",
    }


# ── POST /estimate ───────────────────────────────────
# 企业客户端 (apps/enterprise-agent · Setup.vue) 在提交前调用:
# 基于「这个具体任务的 spec + 我的真实余额」给出预估,而非 quote 的纯定价模拟。
# 与 quote 的区别: estimate 接收完整 workload spec、自动推导工作量/分片、回传余额够不够。
# 同样不创建订单、不锁钱、不写 ledger。

_ESTIMATE_FALLBACK_BASE_PRICE = Decimal("0.5")   # 未配置定价时的兜底单价 (元/unit)
_ESTIMATE_FALLBACK_MIN_CHARGE = Decimal("0.10")  # 兜底最低收费 (元)


class EstimateRequest(BaseModel):
    name: str | None = None
    spec: dict = Field(default_factory=dict, description="完整 workload spec")
    budget: float | None = Field(default=None, ge=0, description="客户端拟用预算 (可选·仅用于对比)")


def _estimate_units_shards(spec: dict) -> tuple[int, int]:
    """从 spec 推导工作量 (units) 与分片数 (shards)。

    units: multi_file 按文件数; 其余按 1 (单文件/归档/内联/纯参数)。
    shards: 受 max_shards 上限约束, 不超过 units, 至少 1。
    """
    from platform_v8.services.economy.task_pricing import estimate_units_shards
    return estimate_units_shards(spec)


@router.post("/estimate", summary="任务预估 (基于 spec + 真实余额 · 不创建订单 · 不锁钱)")
def estimate_workload(
    body: EstimateRequest,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    from platform_v8.services.economy import task_pricing as task_pricing_svc
    from platform_v8.services.economy import workload_quote as workload_quote_svc

    spec = body.spec or {}
    task_type = str(spec.get("task_type") or "").strip()
    if not task_type:
        raise HTTPException(status_code=400, detail="spec.task_type 不能为空")
    from platform_v8.services.workloads import submit as submit_svc
    try:
        submit_svc._validate_required_task_params(task_type, spec.get("params"))
    except submit_svc.SubmitWorkloadError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    from platform_v8.services.media_profiles import require_formal_media_channel, MediaProfileError
    try:
        media_plan = require_formal_media_channel(spec, session=session, account_id=current.id)
    except MediaProfileError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None

    try:
        priced_spec = workload_quote_svc.pricing_spec(
            spec, session=session, account_id=current.id,
        )
        quote = task_pricing_svc.compute_price_for_spec(
            session, priced_spec, account_id=current.id
        )
        special_budget = task_pricing_svc.honor_client_budget(
            session, account_id=current.id, is_admin=current.is_admin,
        )
        if quote.profile_id:
            special_budget = False  # formal media has one authoritative official price for every account
        if not special_budget and quote.price_basis.startswith("default("):
            raise ValueError("当前任务尚未配置服务端价目，暂不能报价")
        if not special_budget and (not quote.total_yuan.is_finite() or quote.total_yuan <= 0):
            raise ValueError("当前任务没有有效的正数服务端价格，暂不能报价")
        quote_token, quote_expires_at = workload_quote_svc.issue_confirmation(
            account_id=current.id, spec=spec, quote=quote,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    input_kind = priced_spec["input_kind"]
    total_yuan = quote.total_yuan
    settings = _load_settings(session)
    node_share = Decimal(str(settings.get("node_share", 0.65)))
    platform_share = Decimal(str(settings.get("platform_share", 0.30)))
    channel_share = Decimal(str(settings.get("channel_share", 0.05)))
    risk_pool_share = Decimal(str(settings.get("risk_pool_share", 0.0)))

    worker_reward_pool = (total_yuan * node_share).quantize(Decimal("0.01"))
    platform_fee = (total_yuan * platform_share).quantize(Decimal("0.01"))
    script_author_fee = (total_yuan * channel_share).quantize(Decimal("0.01"))
    risk_pool = (total_yuan * risk_pool_share).quantize(Decimal("0.01"))

    recommended_budget = total_yuan

    try:
        balance = balance_svc.get_balance(session, current.id)
    except Exception as exc:
        logger.warning("estimate · 取余额失败 (按 0 处理): %s", exc)
        balance = Decimal("0")
    balance = Decimal(str(balance))
    balance_enough = balance >= recommended_budget

    return {
        "ok": True,
        "task_type": task_type,
        "input_kind": input_kind,
        "units": quote.units,
        "shards": quote.shards,
        "estimated_total": str(total_yuan),
        "recommended_budget": str(recommended_budget),
        "requested_budget": str(Decimal(str(body.budget)).quantize(Decimal("0.01"))) if body.budget is not None else "",
        "worker_reward_pool": str(worker_reward_pool),
        "platform_fee": str(platform_fee),
        "risk_pool": str(risk_pool),
        "script_author_fee": str(script_author_fee),
        "currency": "CNY",
        "price_basis": quote.price_basis,
        "settings_version": quote.settings_version,
        "quote_token": quote_token,
        "quote_expires_at": quote_expires_at,
        "media_plan": media_plan if quote.profile_id else None,
        "refund_policy": "任务失败或取消全额退款 (escrow 冻结·完成后按 65/30/5 结算)",
        "balance": str(balance.quantize(Decimal("0.01"))),
        "balance_enough": balance_enough,
        "billing_mode": "client_budget" if special_budget else "server_price",
        "note": ("该账号获准使用合同预算，提交仍会记录服务端参考价" if special_budget else
                 "提交时须带 quote_token 并确认 recommended_budget；报价 5 分钟内有效，提交时重新计价"),
    }


@router.get("/media-profiles", summary="官方媒体 profile 目录（元数据；非执行就绪证明）")
def media_profiles_endpoint(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    from platform_v8.services.media_profiles import official_profiles, MediaProfileError
    try:
        profiles = official_profiles(_load_settings(session))
    except MediaProfileError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    from platform_v8.services.media_channel import _preflight
    try:
        _preflight(session)
        ready = True
    except Exception:
        ready = False
    return {"ok": True, "billing_status": "ready" if ready else "unavailable",
            "code": "ok" if ready else "quote_unavailable",
            "profiles": [p.model_dump(mode="json") for p in profiles if p.enabled],
            "missing_integrations": [] if ready else ["live_signed_preflight", "trusted_device_bindings",
                                                        "purpose_separated_service_identities"],
            "note": "官方目录参数不能证明线上媒体执行或计费已接通；试跑须明确 non_billable"}
