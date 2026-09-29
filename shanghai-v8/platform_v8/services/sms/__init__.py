"""
短信服务 —— 手机号注册 / 登录的验证码通道。

| 模块 | 职责 |
| --- | --- |
| `config` | 从环境读配置，缺项即失败 |
| `aliyun` | 阿里云 Dysmsapi 的签名与发送（唯一的出网点） |
| `verifications` | 验证码的签发与核销（唯一的数据库面） |

**这个包不 import 平台的任何业务模块，也不被业务模块 import 业务逻辑**——
`api/v8/auth.py` 只调 `issue_and_send` 和 `consume` 两个入口，
这样"短信"和"账号"两边可以各自演进。
"""
from __future__ import annotations

import logging

from .aliyun import SmsSendError, SmsSendResult, send_sms
from .config import SmsConfig, SmsConfigError, load_config
from .verifications import (
    CodeRejected,
    IssuedCode,
    PhoneError,
    SmsLimitError,
    consume,
    issue,
    mark_failed,
    mark_sent,
    normalize_phone,
)

logger = logging.getLogger(__name__)

__all__ = [
    "SmsConfig",
    "SmsConfigError",
    "SmsSendError",
    "SmsSendResult",
    "CodeRejected",
    "IssuedCode",
    "PhoneError",
    "SmsLimitError",
    "load_config",
    "normalize_phone",
    "issue_and_send",
    "verify_code",
]


def issue_and_send(
    session,
    *,
    phone_raw: str,
    purpose: str,
    request_ip: str | None = None,
) -> dict:
    """签发一条验证码并真的发出去。返回给 API 层的安全摘要（**不含明文码**）。

    失败语义：
      - 限额 → 抛 `SmsLimitError`（调用方转 429，带 `retry_after`）
      - 号码不合法 → 抛 `PhoneError`（调用方转 400）
      - 上游失败 → 抛 `SmsSendError`（调用方转 502/503）

    **发送失败时不抛"验证码已发送"**：先把记录标成 `failed` 再抛，
    这样用户看到的和库里记的是一致的。
    """
    phone = normalize_phone(phone_raw)
    config = load_config()

    issued = issue(
        session,
        phone=phone,
        purpose=purpose,
        pepper=config.code_pepper,
        daily_cap=config.daily_cap,
        request_ip=request_ip,
    )
    # **必须在这里 commit 一次。** FastAPI 的 `get_session` 只在"出 endpoint 无异常"时提交，
    # 而发送失败会抛 HTTPException → 整个请求事务回滚。若把"这次尝试"绑在同一个事务里，
    # 失败请求就既不计入限额、也不留痕 —— 等于给了一条"只发失败的请求"绕过限额的路。
    # 实测踩到过：库里一行都没有，而上游已经收到并拒绝了 40 次。
    session.commit()

    try:
        result: SmsSendResult = send_sms(config=config, phone=phone, code=issued.code)
    except SmsSendError:
        mark_failed(session, record_id=issued.id)
        session.commit()  # 同上：失败也要留在限额账上
        raise

    mark_sent(session, record_id=issued.id, provider_msg_id=result.biz_id)
    logger.info(
        "sms.issue · purpose=%s · phone=%s · biz=%s",
        purpose,
        _mask(phone),
        result.biz_id,
    )
    return {
        "phone": _mask(phone),
        "purpose": purpose,
        "expires_in": int((issued.expires_at - _utcnow()).total_seconds()),
        "resend_after": 60,
    }


def verify_code(session, *, phone_raw: str, purpose: str, code: str) -> str:
    """核销验证码，返回**归一化后的手机号**（调用方拿它去查/建账号）。

    `CodeRejected` 之前**先 commit**：猜错的 `attempts` 计数必须落盘，
    否则请求一回滚，"猜错"就不留痕，5 次上限形同虚设。
    """
    phone = normalize_phone(phone_raw)
    config = load_config()
    try:
        consume(session, phone=phone, purpose=purpose, code=code, pepper=config.code_pepper)
    except CodeRejected:
        session.commit()
        raise
    return phone


def _utcnow():
    from datetime import datetime
    return datetime.utcnow()


def _mask(phone: str) -> str:
    """日志里只留 `138****8888` —— 库里有明文号码是业务需要，日志里没有必要。"""
    return phone[:3] + "****" + phone[-4:] if len(phone) == 11 else "***"
