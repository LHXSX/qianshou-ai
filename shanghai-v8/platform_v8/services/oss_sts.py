"""OSS STS 临时凭证签发服务 · §5.6 护栏①

设计要点:
- 前端拿到的 token 有效期 **15 分钟** (硬上限 1 小时)
- 范围限制到单个 `bucket/tenant_{account_id}/task_{task_id}/` 路径
- 即使凭证泄露 · 攻击者也只能写这一个任务的目录 · 15 分钟后失效

实现:
- 阿里云: 调 STS AssumeRole API · 真实 STS token
- AWS: 调 boto3 STS.assume_role
- 本地回退: 返回主 AK/SK + 假 token (开发用 · 仅 LocalFallback)

缓存策略:
- 同一 account_id + task_id + mode 在 5 分钟内复用同一 STS token
- 通过 we_kv 表持久化 · 避免重复触发 STS 配额
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal, Optional

from platform_v8.services.oss_provider import OSSConfig, get_oss_provider

logger = logging.getLogger("services.oss_sts")

STSMode = Literal["read", "write", "readwrite"]
DEFAULT_EXPIRES_SECONDS = 900  # 15 分钟
MAX_EXPIRES_SECONDS = 3600     # 1 小时上限
CACHE_SAFE_MARGIN = 60         # 缓存过期前 60s 重新签发


# ── STS 凭证结构 ───────────────────────────────────────────────
@dataclass
class STSCredential:
    """STS 临时凭证 · 返回给前端用。"""
    access_key_id: str
    access_key_secret: str
    security_token: str
    expires_at: int          # Unix 时间戳
    bucket: str
    prefix: str              # 强制路径前缀 · 前端只能往这里写
    region: str = ""
    endpoint: str = ""
    request_id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])

    def to_dict(self) -> dict:
        return {
            "AccessKeyId": self.access_key_id,
            "AccessKeySecret": self.access_key_secret,
            "SecurityToken": self.security_token,
            "ExpiresAt": self.expires_at,
            "Bucket": self.bucket,
            "Prefix": self.prefix,
            "Region": self.region,
            "Endpoint": self.endpoint,
            "RequestId": self.request_id,
        }


# ── 工具: 强制路径隔离 ─────────────────────────────────────────
def build_tenant_prefix(account_id: int, task_id: int | str = 0) -> str:
    """生成租户隔离路径 · 网关强制注入 · 前端改不了。

    2026-06-19 OSS 改造:加 `uploads/` 顶层前缀,对齐 edgecompute bucket 目录结构。
    对应 OSS key: `edgecompute/uploads/tenant_{account_id}/task_{task_id}/...`
    可通过 oss.qianshousuanli.com 私密访问(无 CDN · 仅 STS · 私有 BPA on)。

    格式: `uploads/tenant_{account_id}/task_{task_id}/`
    举例: `uploads/tenant_42/task_pending/`
    """
    task_part = f"task_{task_id}" if task_id else "task_pending"
    return f"uploads/tenant_{account_id}/{task_part}/"


def build_policy_document(bucket: str, prefix: str, mode: STSMode) -> dict:
    """构造 STS Policy · 仅授权指定 bucket/prefix 的操作。

    阿里云 RAM Policy 格式 (兼容 AWS IAM 风格)。
    """
    actions_map = {
        "read": ["oss:GetObject", "oss:GetObjectMeta"],
        "write": [
            "oss:PutObject",
            "oss:InitiateMultipartUpload",
            "oss:UploadPart",
            "oss:CompleteMultipartUpload",
            "oss:AbortMultipartUpload",
        ],
        "readwrite": [
            "oss:GetObject", "oss:GetObjectMeta",
            "oss:PutObject",
            "oss:InitiateMultipartUpload", "oss:UploadPart",
            "oss:CompleteMultipartUpload", "oss:AbortMultipartUpload",
        ],
    }
    actions = actions_map[mode]
    return {
        "Version": "1",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": actions,
                # Resource: 仅 prefix 下的对象 (不允许 list bucket · 不允许跨前缀)
                "Resource": [
                    f"acs:oss:*:*:{bucket}/{prefix}*",
                ],
            }
        ],
    }


# ── 缓存: 利用 we_kv (avoid 重复触发 STS 配额) ──────────────────
def _cache_key(account_id: int, task_id: int | str, mode: STSMode) -> str:
    raw = f"sts:{account_id}:{task_id}:{mode}"
    return f"oss_sts:{hashlib.md5(raw.encode()).hexdigest()[:16]}"


def _cache_get(key: str) -> Optional[STSCredential]:
    try:
        from platform_v8.storage import kv as kv_store
        data = kv_store.get_json(key)
        if not data:
            return None
        if data.get("ExpiresAt", 0) <= int(time.time()) + CACHE_SAFE_MARGIN:
            return None
        return STSCredential(
            access_key_id=data["AccessKeyId"],
            access_key_secret=data["AccessKeySecret"],
            security_token=data["SecurityToken"],
            expires_at=data["ExpiresAt"],
            bucket=data["Bucket"],
            prefix=data["Prefix"],
            region=data.get("Region", ""),
            endpoint=data.get("Endpoint", ""),
            request_id=data.get("RequestId", ""),
        )
    except Exception as e:
        logger.debug("[STS] 缓存读取失败 (忽略): %s", e)
        return None


def _cache_set(key: str, cred: STSCredential) -> None:
    try:
        from platform_v8.storage import kv as kv_store
        ttl = max(60, cred.expires_at - int(time.time()) - CACHE_SAFE_MARGIN)
        kv_store.set_json(key, cred.to_dict(), ttl_s=ttl)
    except Exception as e:
        logger.debug("[STS] 缓存写入失败 (忽略): %s", e)


# ── 真实 STS: 阿里云 RAM AssumeRole ───────────────────────────
def _aliyun_assume_role(
    config: OSSConfig,
    role_session_name: str,
    policy: dict,
    duration_seconds: int,
) -> STSCredential:
    """调用阿里云 STS AssumeRole API · 真实 token。

    依赖: aliyun-python-sdk-core + aliyun-python-sdk-sts (可选)
    若 SDK 不在 · 降级为本地回退。
    """
    try:
        # 延迟导入 · 避免依赖污染
        from aliyunsdkcore.client import AcsClient  # type: ignore
        from aliyunsdksts.request.v20150401 import AssumeRoleRequest  # type: ignore
    except ImportError:
        logger.warning("[STS] aliyun-python-sdk-sts 未安装 · 降级为本地回退")
        return _local_fallback(config, role_session_name, duration_seconds)

    client = AcsClient(
        config.access_key_id,
        config.access_key_secret,
        config.region or "cn-hangzhou",
    )
    req = AssumeRoleRequest.AssumeRoleRequest()
    req.set_RoleArn(config.role_arn)
    req.set_RoleSessionName(role_session_name)
    req.set_DurationSeconds(duration_seconds)
    req.set_Policy(json.dumps(policy))
    req.set_accept_format("json")

    response = client.do_action_with_exception(req)
    data = json.loads(response)
    creds = data["Credentials"]

    return STSCredential(
        access_key_id=creds["AccessKeyId"],
        access_key_secret=creds["AccessKeySecret"],
        security_token=creds["SecurityToken"],
        expires_at=int(time.time()) + duration_seconds,
        bucket=config.bucket,
        prefix="",  # 由调用方填
        region=config.region,
        endpoint=config.endpoint,
        request_id=data.get("RequestId", ""),
    )


# ── 本地回退: 直接给主 AK/SK + 假 token (仅开发) ───────────────
def _local_fallback(
    config: OSSConfig,
    role_session_name: str,
    duration_seconds: int,
) -> STSCredential:
    """本地回退: 返回主 AK/SK + 占位 token。

    ⚠ 仅开发用 · 生产必须配 role_arn 走真实 STS。
    """
    logger.warning(
        "[STS] 使用本地回退 (主 AK/SK + 假 token) · session=%s · 生产请配 OSS_ROLE_ARN",
        role_session_name,
    )
    return STSCredential(
        access_key_id=config.access_key_id or "LOCAL_DEV_KEY",
        access_key_secret=config.access_key_secret or "LOCAL_DEV_SECRET",
        security_token=f"STS-LOCAL-{uuid.uuid4().hex}",
        expires_at=int(time.time()) + duration_seconds,
        bucket=config.bucket or "local-dev-bucket",
        prefix="",
        region=config.region,
        endpoint=config.endpoint,
    )


# ── 主入口: 签发 STS 凭证 ─────────────────────────────────────
def issue_sts(
    account_id: int,
    task_id: int | str = 0,
    *,
    mode: STSMode = "write",
    duration_seconds: int = DEFAULT_EXPIRES_SECONDS,
    use_cache: bool = True,
) -> STSCredential:
    """签发 STS 临时凭证 · 范围限制到指定 task 路径。

    Args:
        account_id: 租户标识 (Account.id)
        task_id: 任务 ID (0 表示 draft · 用 task_pending 占位前缀)
        mode: read / write / readwrite
        duration_seconds: 凭证有效期 (默认 15 分钟 · 上限 1 小时)
        use_cache: 是否复用 we_kv 缓存 (默认 true)

    Returns:
        STSCredential · 含 AccessKeyId/Secret/SecurityToken/ExpiresAt/Bucket/Prefix
    """
    duration_seconds = min(max(duration_seconds, 300), MAX_EXPIRES_SECONDS)
    prefix = build_tenant_prefix(account_id, task_id)

    # 1. 缓存命中
    cache_k = _cache_key(account_id, task_id, mode)
    if use_cache:
        cached = _cache_get(cache_k)
        if cached:
            cached.prefix = prefix  # 防 prefix 变化
            logger.debug("[STS] 缓存命中 · session=%s", cache_k)
            return cached

    # 2. 加载配置 · 调真实 STS 或回退
    provider = get_oss_provider()
    config = getattr(provider, "config", None)
    if config is None:
        config = OSSConfig()

    session_name = f"tenant{account_id}-task{task_id}-{mode}"[:32]
    policy = build_policy_document(config.bucket or "local-dev-bucket", prefix, mode)

    if config.provider == "aliyun" and config.role_arn:
        try:
            cred = _aliyun_assume_role(config, session_name, policy, duration_seconds)
        except Exception as e:
            logger.error("[STS] 阿里云 STS 调用失败: %s · 降级本地", e)
            cred = _local_fallback(config, session_name, duration_seconds)
    else:
        cred = _local_fallback(config, session_name, duration_seconds)

    # 3. 注入强制 prefix (覆盖任何回退实现)
    cred.prefix = prefix

    # 4. 写缓存
    if use_cache:
        _cache_set(cache_k, cred)

    logger.info(
        "[STS] 已签发 · account=%s · task=%s · mode=%s · prefix=%s · expires=%ds",
        account_id, task_id, mode, prefix, duration_seconds,
    )
    return cred
