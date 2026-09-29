"""
短信服务的配置读取。

设计要点（考虑全链路）：
  1. **只从环境读**：`/etc/qianshou/sms.env` 由 systemd 的 `EnvironmentFile=` 注入，
     本模块不自己读文件——"配置在哪"只有一个答案。
  2. **缺失即失败**：缺 AccessKey / 签名 / 模板号时抛 `SmsConfigError`，
     而不是"静默不发"。静默不发会让用户看到"验证码已发送"却永远收不到，
     这正是本模块最想避免的故障。
  3. **不打印密钥**：`describe()` 只报"配没配"和长度，不报内容。
"""
from __future__ import annotations

import os
from dataclasses import dataclass


class SmsConfigError(Exception):
    """短信配置缺失或不合法。"""


REQUIRED_KEYS = (
    "QIANSHOU_SMS_ACCESS_KEY_ID",
    "QIANSHOU_SMS_ACCESS_KEY_SECRET",
    "QIANSHOU_SMS_SIGN_NAME",
    "QIANSHOU_SMS_TEMPLATE_CODE",
)

DEFAULT_ENDPOINT = "dysmsapi.aliyuncs.com"
DEFAULT_REGION = "cn-hangzhou"
DEFAULT_API_VERSION = "2017-05-25"
DEFAULT_DAILY_CAP = 300


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise SmsConfigError(f"{name} 不是整数：{raw!r}") from exc
    if value < 0:
        raise SmsConfigError(f"{name} 不能为负：{value}")
    return value


@dataclass(frozen=True)
class SmsConfig:
    """一次解析出来的短信配置。"""

    access_key_id: str
    access_key_secret: str
    sign_name: str
    template_code: str
    endpoint: str = DEFAULT_ENDPOINT
    region: str = DEFAULT_REGION
    api_version: str = DEFAULT_API_VERSION
    daily_cap: int = DEFAULT_DAILY_CAP
    code_pepper: str = ""

    def describe(self) -> dict[str, object]:
        """给人看的"配没配"摘要 · **不含任何密钥内容**。"""
        return {
            "endpoint": self.endpoint,
            "region": self.region,
            "sign_name": self.sign_name,
            "template_code": self.template_code,
            "access_key_id_len": len(self.access_key_id),
            "access_key_secret_len": len(self.access_key_secret),
            "daily_cap": self.daily_cap,
            "pepper_from_env": bool((os.environ.get("QIANSHOU_SMS_CODE_PEPPER") or "").strip()),
        }


def load_config() -> SmsConfig:
    """读环境变量并校验。**缺任何一项就抛**，不做部分可用。"""
    missing = [key for key in REQUIRED_KEYS if not (os.environ.get(key) or "").strip()]
    if missing:
        raise SmsConfigError(
            "短信配置缺失：" + "、".join(missing) + "（应来自 /etc/qianshou/sms.env）"
        )

    access_key_secret = os.environ["QIANSHOU_SMS_ACCESS_KEY_SECRET"].strip()
    # 验证码哈希用的椒盐：优先专用变量；没配就退回"用 AccessKey Secret 派生"。
    # 退路是**可用的**（Secret 本身就是高熵密钥），但专用变量更干净——
    # 轮换 AccessKey 时不会把历史验证码哈希变成不可校验。
    pepper = (os.environ.get("QIANSHOU_SMS_CODE_PEPPER") or "").strip() or access_key_secret

    return SmsConfig(
        access_key_id=os.environ["QIANSHOU_SMS_ACCESS_KEY_ID"].strip(),
        access_key_secret=access_key_secret,
        sign_name=os.environ["QIANSHOU_SMS_SIGN_NAME"].strip(),
        template_code=os.environ["QIANSHOU_SMS_TEMPLATE_CODE"].strip(),
        endpoint=(os.environ.get("QIANSHOU_SMS_ENDPOINT") or DEFAULT_ENDPOINT).strip(),
        region=(os.environ.get("QIANSHOU_SMS_REGION") or DEFAULT_REGION).strip(),
        api_version=(os.environ.get("QIANSHOU_SMS_API_VERSION") or DEFAULT_API_VERSION).strip(),
        daily_cap=_int_env("QIANSHOU_SMS_DAILY_CAP", DEFAULT_DAILY_CAP),
        code_pepper=pepper,
    )
