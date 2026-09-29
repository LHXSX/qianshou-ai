"""
验证码的**签发**与**核销** —— 本模块只碰数据库，不发短信。

## 三条不可让步的规则

1. **只存哈希**：库里放 `HMAC-SHA256(pepper, phone|purpose|code)`，不放明文。
   与 `we_auth_sessions.token_hash` / `we_auth_devices.credential_hash` 同一纪律。
   验证码只有 6 位数字（10^6 空间），**没有 pepper 的话拿到库就能反查**——
   所以 pepper 不是可选项。
2. **一次一码**：核销即写 `consumed_at`；同一码不能重放。
3. **尝试次数封顶**：超过 `max_attempts` 直接作废，不给暴力猜的机会。

## 限额是分层的

| 层 | 值 | 挡什么 |
| --- | --- | --- |
| 单手机号 60 秒 | 1 条 | 连点"获取验证码" |
| 单手机号 1 小时 | 5 条 | 换号段刷 |
| 单手机号 1 天 | 10 条 | 慢速刷 |
| **全站 1 天** | `QIANSHOU_SMS_DAILY_CAP` | 代码漏洞/被刷时的总闸 |
| 单 IP 每分钟 | 见 router 的 `rate_limit` | 分布式前的基本面 |

最后一层是**成本护栏**：它不完美（对方换 IP 就绕过前四层里的 IP 层），
但它是唯一拦住"整夜烧短信费"的东西。
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import (
    DateTime,
    func,
    insert,
    select,
    text,
    update,
)

logger = logging.getLogger(__name__)

# 表定义放在 `storage/repo.py`（与平台其它表同一个住处），这里只取来用。
# 这么放的原因是 `auth_schema_healthcheck()` 会检查这张表 —— 它跑在
# `metadata.create_all()` 之后，而只有 `repo` 被导入时表才会注册进 metadata。
# 表定义留在这个文件里的话，自检会在测试里误报"迁移缺失"。
from platform_v8.storage.repo import sms_verifications_t  # noqa: E402

CODE_TTL_SECONDS = 300
MAX_ATTEMPTS = 5
CODE_LENGTH = 6

PURPOSES = ("register", "login", "bind", "reset")

PER_PHONE_CAP_MINUTE = 1
PER_PHONE_CAP_HOUR = 5
PER_PHONE_CAP_DAY = 10

_CN_MOBILE = re.compile(r"^1[3-9]\d{9}$")


class PhoneError(Exception):
    """手机号不合法。"""


class SmsLimitError(Exception):
    """触发限额。**要告诉用户"多久之后可以再试"**，所以带 `retry_after_seconds`。"""

    def __init__(self, message: str, *, retry_after_seconds: int | None = None):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class CodeRejected(Exception):
    """验证码不对 / 过期 / 用过了。**不区分具体哪一种**给前端——区分等于告诉攻击者猜对了几位。"""


def normalize_phone(raw: str | None) -> str:
    """归一化中国大陆手机号。

    只接受 11 位 `1[3-9]xxxxxxxxx`。带 `+86` / 空格 / 连字符的先剥掉再判——
    用户从通讯录粘过来的号码经常带这些。
    """
    if not raw:
        raise PhoneError("请填写手机号")
    cleaned = re.sub(r"[\s\-()]", "", str(raw).strip())
    if cleaned.startswith("+86"):
        cleaned = cleaned[3:]
    elif cleaned.startswith("86") and len(cleaned) == 13:
        cleaned = cleaned[2:]
    if not _CN_MOBILE.match(cleaned):
        raise PhoneError("手机号格式不对")
    return cleaned


def hash_code(pepper: str, phone: str, purpose: str, code: str) -> str:
    """HMAC-SHA256 十六进制摘要。"""
    message = f"{phone}|{purpose}|{code}".encode("utf-8")
    return hmac.new(pepper.encode("utf-8"), message, hashlib.sha256).hexdigest()


def generate_code() -> str:
    """6 位数字 · 用 `secrets` 而不是 `random`（后者可预测）。"""
    return "".join(str(secrets.randbelow(10)) for _ in range(CODE_LENGTH))


def _now() -> datetime:
    return datetime.utcnow()


def _count_since(s, *, phone: str, since: datetime) -> int:
    return int(
        s.execute(
            select(func.count()).select_from(sms_verifications_t).where(
                sms_verifications_t.c.phone == phone,
                sms_verifications_t.c.sent_at >= since,
            )
        ).scalar_one()
    )


def _global_count_since(s, *, since: datetime) -> int:
    return int(
        s.execute(
            select(func.count()).select_from(sms_verifications_t).where(
                sms_verifications_t.c.sent_at >= since
            )
        ).scalar_one()
    )


def check_limits(s, *, phone: str, daily_cap: int, now: datetime | None = None) -> None:
    """按由紧到松的顺序检查。触发就抛 `SmsLimitError`。"""
    moment = now or _now()
    if _global_count_since(s, since=moment - timedelta(days=1)) >= daily_cap:
        logger.error("sms.issue · 全站日上限已到 · cap=%s", daily_cap)
        raise SmsLimitError("今天短信通道已达上限，请明天再试或联系客服")

    if _count_since(s, phone=phone, since=moment - timedelta(minutes=1)) >= PER_PHONE_CAP_MINUTE:
        raise SmsLimitError("验证码刚发过，请 60 秒后再试", retry_after_seconds=60)
    if _count_since(s, phone=phone, since=moment - timedelta(hours=1)) >= PER_PHONE_CAP_HOUR:
        raise SmsLimitError("这个号码一小时内请求太多次了，请稍后再试", retry_after_seconds=3600)
    if _count_since(s, phone=phone, since=moment - timedelta(days=1)) >= PER_PHONE_CAP_DAY:
        raise SmsLimitError("这个号码今天请求次数已达上限，请明天再试", retry_after_seconds=86400)


@dataclass(frozen=True)
class IssuedCode:
    """签发结果。`code` 是明文——**只允许用于立刻发短信，不得落库、不得进日志**。"""

    id: str
    phone: str
    purpose: str
    code: str
    expires_at: datetime


def issue(
    s,
    *,
    phone: str,
    purpose: str,
    pepper: str,
    daily_cap: int,
    request_ip: str | None = None,
    now: datetime | None = None,
) -> IssuedCode:
    """检查限额 → 生成 → **落库** → 返回明文码供调用方发送。

    落库在发送**之前**：发送失败也要留痕（否则限额就被失败请求绕过了），
    调用方随后用 `mark_sent` / `mark_failed` 补状态。
    """
    if purpose not in PURPOSES:
        raise ValueError(f"不支持的验证码用途：{purpose}")
    moment = now or _now()
    # All send attempts share the daily cost cap. Serialize check + insert on
    # PostgreSQL so concurrent workers cannot each pass just below the limit.
    # issue_and_send commits immediately after this insert, before network I/O.
    if s.get_bind().dialect.name == "postgresql":
        s.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": 6367180568676910715})
    check_limits(s, phone=phone, daily_cap=daily_cap, now=moment)

    code = generate_code()
    record_id = str(uuid.uuid4())
    s.execute(
        insert(sms_verifications_t).values(
            id=record_id,
            phone=phone,
            purpose=purpose,
            code_hash=hash_code(pepper, phone, purpose, code),
            sent_at=moment,
            expires_at=moment + timedelta(seconds=CODE_TTL_SECONDS),
            attempts=0,
            max_attempts=MAX_ATTEMPTS,
            consumed_at=None,
            request_ip=request_ip,
            provider_msg_id=None,
            status="pending",
        )
    )
    s.flush()
    return IssuedCode(
        id=record_id, phone=phone, purpose=purpose, code=code,
        expires_at=moment + timedelta(seconds=CODE_TTL_SECONDS),
    )


def mark_sent(s, *, record_id: str, provider_msg_id: str | None) -> None:
    s.execute(
        update(sms_verifications_t)
        .where(sms_verifications_t.c.id == record_id)
        .values(status="sent", provider_msg_id=provider_msg_id)
    )


def mark_failed(s, *, record_id: str) -> None:
    s.execute(
        update(sms_verifications_t)
        .where(sms_verifications_t.c.id == record_id)
        .values(status="failed")
    )


def consume(
    s,
    *,
    phone: str,
    purpose: str,
    code: str,
    pepper: str,
    now: datetime | None = None,
) -> None:
    """核销一个验证码。通过则写 `consumed_at`；否则抛 `CodeRejected`。

    **取最近一条未核销的记录**判定：这样"重新发送"之后的旧码自然失效。
    """
    moment = now or _now()
    row = s.execute(
        select(sms_verifications_t)
        .where(
            sms_verifications_t.c.phone == phone,
            sms_verifications_t.c.purpose == purpose,
            sms_verifications_t.c.consumed_at.is_(None),
        )
        .order_by(sms_verifications_t.c.sent_at.desc())
        .limit(1)
        .with_for_update()
    ).one_or_none()
    if row is None:
        raise CodeRejected("验证码不正确或已失效")

    if row.expires_at < moment or int(row.attempts or 0) >= int(row.max_attempts or MAX_ATTEMPTS):
        s.execute(
            update(sms_verifications_t)
            .where(sms_verifications_t.c.id == row.id)
            .values(consumed_at=moment, status="expired")
        )
        raise CodeRejected("验证码不正确或已失效")

    expected = hash_code(pepper, phone, purpose, code)
    if not hmac.compare_digest(expected, row.code_hash):
        s.execute(
            update(sms_verifications_t)
            .where(sms_verifications_t.c.id == row.id,
                   sms_verifications_t.c.consumed_at.is_(None))
            .values(attempts=sms_verifications_t.c.attempts + 1)
        )
        raise CodeRejected("验证码不正确或已失效")

    claimed = s.execute(
        update(sms_verifications_t)
        .where(sms_verifications_t.c.id == row.id,
               sms_verifications_t.c.consumed_at.is_(None),
               sms_verifications_t.c.expires_at >= moment,
               sms_verifications_t.c.attempts < sms_verifications_t.c.max_attempts)
        .values(consumed_at=moment, status="verified")
    )
    if claimed.rowcount != 1:
        raise CodeRejected("验证码不正确或已失效")
