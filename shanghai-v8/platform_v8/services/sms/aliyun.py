"""
阿里云短信（Dysmsapi）客户端 —— 只做一件事：把一条验证码发出去。

## 为什么自己实现签名而不是装 SDK

项目其它部分（OSS）也没有装 `aliyun-python-sdk-*`，而是直接用 HTTP。
保持一致的好处是：**依赖面不变**、升级不会牵动平台其它模块。
代价是签名算法必须自己写对，所以这一版**逐字段对齐官方 RPC 签名步骤**，
并由 `tests/services/test_sms_aliyun.py` 用固定输入做回归。

## 签名步骤（阿里云 RPC 风格）

1. 公共参数 + 业务参数放一个 dict；
2. 按参数名**字典序**排序；
3. 对每个 k、v 分别做 RFC3986 百分号编码（`~` 不编码，空格编码成 `%20`）；
4. 用 `&` 拼成规范化查询串；
5. `StringToSign = "GET" + "&" + "%2F" + "&" + percentEncode(规范化查询串)`；
6. `Signature = Base64(HMAC-SHA1(AccessKeySecret + "&", StringToSign))`；
7. 把 `Signature` 也放进查询串。

**容易写错的三个地方**（都在本文件里显式处理了）：
  - 空格必须编成 `%20` 而不是 `+`（`urllib.parse.quote` 默认的 `quote_plus` 会错）；
  - `~` 不能编码；
  - 排序要在**编码前**按原始参数名做（不是按编码后的串）。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 10.0
SEND_ACTION = "SendSms"


class SmsSendError(Exception):
    """短信发送失败。

    `retryable` 区分"上游抖动可以重试"和"参数/权限错了重试也没用"——
    调用方据此决定是否让用户点"重新发送"。
    """

    def __init__(self, message: str, *, code: str | None = None, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class SmsSendResult:
    """一次成功发送的回执。"""

    biz_id: str | None
    request_id: str | None
    code: str


def percent_encode(value: object) -> str:
    """RFC3986 编码：`~` 保留，空格变 `%20`。"""
    return urllib.parse.quote(str(value), safe="~")


def canonical_query(params: dict[str, object]) -> str:
    """按**原始参数名**字典序排序后编码拼接。"""
    return "&".join(
        f"{percent_encode(key)}={percent_encode(params[key])}"
        for key in sorted(params)
    )


def sign(params: dict[str, object], access_key_secret: str, *, method: str = "GET") -> str:
    """算出 Signature（Base64(HMAC-SHA1)）。"""
    string_to_sign = f"{method}&%2F&{percent_encode(canonical_query(params))}"
    digest = hmac.new(
        (access_key_secret + "&").encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha1,
    ).digest()
    return base64.b64encode(digest).decode("ascii")


def build_send_params(
    *,
    config,
    phone: str,
    code: str,
    now: datetime | None = None,
    nonce: str | None = None,
) -> dict[str, object]:
    """组装 SendSms 的完整参数（**不含 Signature**）。"""
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "AccessKeyId": config.access_key_id,
        "Action": SEND_ACTION,
        "Format": "JSON",
        "RegionId": config.region,
        "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": nonce or str(uuid.uuid4()),
        "SignatureVersion": "1.0",
        "Timestamp": stamp,
        "Version": config.api_version,
        "PhoneNumbers": phone,
        "SignName": config.sign_name,
        "TemplateCode": config.template_code,
        "TemplateParam": json.dumps({"code": code}, ensure_ascii=False, separators=(",", ":")),
    }


# 明确的"重试也没用"：号码写错了、模板参数对不上、模板被停了。
# 其余一律按可重试处理 —— 宁可让用户多点一次"重新发送"，
# 也不要把"上游抖了一下"显示成"你的号码有问题"。
_NOT_RETRYABLE = {
    "isv.MOBILE_NUMBER_ILLEGAL",
    "isv.TEMPLATE_MISSING_PARAMETERS",
    "isv.INVALID_PARAMETERS",
    "isv.SMS_TEMPLATE_ILLEGAL",
}


def send_sms(
    *,
    config,
    phone: str,
    code: str,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    opener=None,
    now: datetime | None = None,
    nonce: str | None = None,
) -> SmsSendResult:
    """发一条验证码短信。失败抛 `SmsSendError`。

    `opener` 只为测试注入（默认用 `urllib.request.urlopen`）。
    """
    params = build_send_params(config=config, phone=phone, code=code, now=now, nonce=nonce)
    signature = sign(params, config.access_key_secret)
    query = canonical_query({**params, "Signature": signature})
    url = f"https://{config.endpoint}/?{query}"

    call = opener or urllib.request.urlopen
    try:
        with call(url, timeout=timeout) as response:
            body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:  # 4xx/5xx 也带 JSON body，要读出来
        body = exc.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - 网络层什么都可能抛，统一兜住
        raise SmsSendError(f"短信网关不可达：{type(exc).__name__}", retryable=True) from exc

    try:
        payload = json.loads(body)
    except ValueError as exc:
        raise SmsSendError("短信网关返回了非 JSON 内容", retryable=True) from exc

    code_value = str(payload.get("Code") or "")
    if code_value != "OK":
        message = str(payload.get("Message") or "未知错误")
        # 真实的失败原因必须能被看到：把它带进异常，而不是吞掉换成"发送失败"。
        retryable = code_value not in _NOT_RETRYABLE
        logger.warning("sms.send · failed · code=%s · message=%s", code_value, message)
        raise SmsSendError(f"{message}（{code_value}）", code=code_value, retryable=retryable)

    result = SmsSendResult(
        biz_id=payload.get("BizId"),
        request_id=payload.get("RequestId"),
        code=code_value,
    )
    logger.info("sms.send · ok · biz=%s · request=%s", result.biz_id, result.request_id)
    return result
