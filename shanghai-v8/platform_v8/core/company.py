"""公司主体信息 · 单一信源 (SSoT) · 2026-06-09

全平台(后端开票/协议/页脚 + 前端展示)统一引用本文件,改一处全站生效。

数据来源:营业执照(2026-06-09 核发)
  统一社会信用代码 91210105MAKFULTQ5F · 登记机关 沈阳市皇姑区市场监督管理局

⚠️ TODO(执照上没有 · 待补真实值,当前为占位):
  - BANK_NAME / BANK_ACCOUNT  对公开户行 + 账号(开票销方 & 提现打款用)
  - WECHAT_MP                 微信公众号 ID(原 wujisuanli 已弃用 · 待注册新号)
  补齐后删除对应占位标记。

✅ 已完成(2026-09-25):
  - ICP_RECORD                辽ICP备2026013448号(官网展示使用 qsnode.com 备案号)
"""
from __future__ import annotations

# ── 法律主体(营业执照,均为真实值)──────────────────────────
LEGAL_NAME = "沈阳千手执棋网络科技有限公司"
UNIFIED_SOCIAL_CREDIT_CODE = "91210105MAKFULTQ5F"   # = 税号
LEGAL_REPRESENTATIVE = "庞茂帅"
COMPANY_TYPE = "有限责任公司(自然人独资)"
REGISTERED_CAPITAL_CNY = 100_000                     # 壹拾万圆整
FOUNDED_DATE = "2026-06-09"
REGISTERED_ADDRESS = "辽宁省沈阳市皇姑区塔湾街9号(塔湾街9号)11002-047室"
REGISTRATION_AUTHORITY = "沈阳市皇姑区市场监督管理局"

# ── 品牌 / 域名 ──────────────────────────────────────────────
# 2026-06-19 cutover:统一切到 qianshousuanli.com · wujisuanli/pidbai 彻底废弃
BRAND_NAME = "千手算力"
BRAND_NAME_EN = "Qianshou Compute"
PRIMARY_DOMAIN = "qianshousuanli.com"

# ── 联系方式(真实,已确认)──────────────────────────────────
CONTACT_PHONE = "156 6886 6606"
CONTACT_QQ = "330814121"
WECHAT_MP = "qianshousuanli"                         # TODO: 待去微信公众平台注册同名公众号(原 wujisuanli 已弃用)
CONTACT_EMAIL = f"contact@{PRIMARY_DOMAIN}"
SUPPORT_EMAIL = f"support@{PRIMARY_DOMAIN}"

# ── ICP 备案(已下) ──────────────────────────────────────────
ICP_RECORD = "辽ICP备2026013448号"                    # 2026-09-25 官网备案号更新
ICP_QUERY_URL = "https://beian.miit.gov.cn/"          # 合规要求:页脚 ICP 号链接到此

# ── 待补占位(执照上没有)────────────────────────────────────
_BANK_PLACEHOLDER = True
BANK_NAME = "（开户行待补）"                           # TODO 对公账户
BANK_ACCOUNT = "（对公账号待补）"                       # TODO

# ── 版权串(页脚用)──────────────────────────────────────────
COPYRIGHT_YEAR = 2026


def copyright_line() -> str:
    """页脚版权行 · 例:© 2026 千手算力 · 沈阳千手执棋网络科技有限公司 · 辽ICP备2026013448号"""
    return f"© {COPYRIGHT_YEAR} {BRAND_NAME} · {LEGAL_NAME} · {ICP_RECORD}"


def public_info() -> dict:
    """前端/官网可公开展示的字段(不含银行账号等敏感财务信息)"""
    return {
        "legal_name": LEGAL_NAME,
        "brand_name": BRAND_NAME,
        "brand_name_en": BRAND_NAME_EN,
        "unified_social_credit_code": UNIFIED_SOCIAL_CREDIT_CODE,
        "legal_representative": LEGAL_REPRESENTATIVE,
        "company_type": COMPANY_TYPE,
        "founded_date": FOUNDED_DATE,
        "registered_address": REGISTERED_ADDRESS,
        "registration_authority": REGISTRATION_AUTHORITY,
        "primary_domain": PRIMARY_DOMAIN,
        "icp_record": ICP_RECORD,
        "icp_query_url": ICP_QUERY_URL,
        "contact_email": CONTACT_EMAIL,
        "support_email": SUPPORT_EMAIL,
        "contact_phone": CONTACT_PHONE,
        "contact_qq": CONTACT_QQ,
        "wechat_mp": WECHAT_MP,
        "copyright": copyright_line(),
        "icp_pending": False,
    }


def invoice_seller() -> dict:
    """开票销方信息 · 税票上盖的就是这套(we_tax_invoices 开票时引用)

    ⚠️ BANK_NAME / BANK_ACCOUNT 为占位 · 真正开票前必须补真实对公账户。
    """
    return {
        "seller_name": LEGAL_NAME,
        "seller_tax_id": UNIFIED_SOCIAL_CREDIT_CODE,
        "seller_address": REGISTERED_ADDRESS,
        "seller_phone": CONTACT_PHONE,
        "seller_bank_name": BANK_NAME,
        "seller_bank_account": BANK_ACCOUNT,
        "default_tax_rate": 0.06,      # 现代服务业 6%(与 we_tax_invoices 默认一致)
        "_bank_placeholder": _BANK_PLACEHOLDER,
    }
