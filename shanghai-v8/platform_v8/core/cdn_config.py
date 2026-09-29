"""OSS + CDN 最终配置 · 2026-06-19 定稿

单一信源 · 后端/脚本/AI 开发统一引用。
运维细节见 docs/OSS_CDN_最终配置_2026-06-19.md
"""
from __future__ import annotations

from dataclasses import dataclass

# ── OSS Bucket ────────────────────────────────────────────────
OSS_BUCKET = "edgecompute"
OSS_REGION = "cn-guangzhou"
OSS_ENDPOINT = "https://oss-cn-guangzhou.aliyuncs.com"
OSS_INTERNAL_ENDPOINT = "https://oss-cn-guangzhou-internal.aliyuncs.com"

# OSS 顶层 prefix（bucket 内目录）
OSS_PREFIX_RELEASES = "releases/"
OSS_PREFIX_RUNTIME = "runtime/"
OSS_PREFIX_MODELS = "models/"
OSS_PREFIX_UPLOADS = "uploads/"

# ── CDN 加速域（阿里云 CDN · 回源 edgecompute · 原样回源）────
RELEASES_CDN_BASE = "https://dl.qianshousuanli.com/releases"
RUNTIME_CDN_BASE = "https://by.qianshousuanli.com/runtime"
MODELS_CDN_BASE = "https://models.qianshousuanli.com/models"

# 用户上传入口（不走 CDN · A 记录 → 205 nginx · STS 直传 OSS）
UPLOADS_PUBLIC_BASE = "https://oss.qianshousuanli.com/uploads"

# 主 API 域（updater / manifest / STS 签发）
API_BASE = "https://qianshousuanli.com/api/v8"

# 平台签名 302 兜底（BPA-on 私有 bucket · CDN 不可用时）
ASSET_MIRROR_BASE = "https://www.qianshousuanli.com/api/v8/oss/asset-mirror"


@dataclass(frozen=True)
class CdnDomainSpec:
    """CDN 域规格 · 文档/监控用 · 不含密钥。"""
    subdomain: str
    fqdn: str
    dns_type: str
    dns_value: str
    cdn_enabled: bool
    https_enabled: bool
    cert_id: str
    cert_expires: str
    oss_prefix: str
    cdn_base_url: str


CDN_DOMAINS: dict[str, CdnDomainSpec] = {
    "dl": CdnDomainSpec(
        subdomain="dl",
        fqdn="dl.qianshousuanli.com",
        dns_type="CNAME",
        dns_value="dl.qianshousuanli.com.w.kunlunaq.com",
        cdn_enabled=True,
        https_enabled=True,
        cert_id="cert-hubf4p",
        cert_expires="2026-09-17",
        oss_prefix=OSS_PREFIX_RELEASES,
        cdn_base_url=RELEASES_CDN_BASE,
    ),
    "by": CdnDomainSpec(
        subdomain="by",
        fqdn="by.qianshousuanli.com",
        dns_type="CNAME",
        dns_value="by.qianshousuanli.com.w.kunlunaq.com",
        cdn_enabled=True,
        https_enabled=True,
        cert_id="cert-62qcik",
        cert_expires="2026-09-17",
        oss_prefix=OSS_PREFIX_RUNTIME,
        cdn_base_url=RUNTIME_CDN_BASE,
    ),
    "models": CdnDomainSpec(
        subdomain="models",
        fqdn="models.qianshousuanli.com",
        dns_type="CNAME",
        dns_value="models.qianshousuanli.com.w.kunlunaq.com",
        cdn_enabled=True,
        https_enabled=True,
        cert_id="cert-ymiy14",
        cert_expires="2026-09-17",
        oss_prefix=OSS_PREFIX_MODELS,
        cdn_base_url=MODELS_CDN_BASE,
    ),
    "oss": CdnDomainSpec(
        subdomain="oss",
        fqdn="oss.qianshousuanli.com",
        dns_type="A",
        dns_value="203.0.113.30",
        cdn_enabled=False,
        https_enabled=True,
        cert_id="*.qianshousuanli.com (Let's Encrypt 通配符)",
        cert_expires="2026-09-17",
        oss_prefix=OSS_PREFIX_UPLOADS,
        cdn_base_url=UPLOADS_PUBLIC_BASE,
    ),
}

# ── 客户端交互 URL 模板 ─────────────────────────────────────
# GET {API_BASE}/client/updates/{os}/{arch}/{version} → download_url: {RELEASES_CDN_BASE}/...
# GET {API_BASE}/runtime/manifest → by/models CDN URL
# POST {API_BASE}/files/sts → 直传 {OSS_ENDPOINT} bucket/{OSS_PREFIX_UPLOADS}...
