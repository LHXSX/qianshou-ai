// 站点 / 公司主体单一信源(前端)· 2026-06-09 对齐营业执照
// 后端对应:platform_v8/core/company.py · 公开端点 GET /api/v8/public/company
//
// 2026-06-19 · ICP 备案下来:辽ICP备2026012682号
// ⚠️ 待补真值:微信公众号(原 wujisuanli 弃用) / 对公账户(开票/提现用)

export const SITE_NAME = '千手算力'
export const SITE_NAME_EN = 'Qianshou Compute'
export const SITE_SLOGAN = '千手执算 · 算力问道'
export const AI_BRAND = '千手问道'
export const COMPUTE_BRAND = '千手算力'
// 2026-06-19 cutover:统一切到 qianshousuanli.com · wujisuanli/pidbai 彻底废弃
export const DOMAIN = 'qianshousuanli.com'

// ── 公司法律主体(营业执照真实信息)──────────────────────────
export const COMPANY = {
  legalName: '沈阳千手执棋网络科技有限公司',
  unifiedSocialCreditCode: '91210105MAKFULTQ5F',     // 税号
  legalRepresentative: '庞茂帅',
  companyType: '有限责任公司(自然人独资)',
  foundedDate: '2026-06-09',
  registeredAddress: '辽宁省沈阳市皇姑区塔湾街9号(塔湾街9号)11002-047室',
  registrationAuthority: '沈阳市皇姑区市场监督管理局',
  // 联系方式(真实,已确认)
  contactPhone: '156 6886 6606',
  contactQQ: '330814121',
  wechatMp: 'qianshousuanli',                         // TODO: 待去微信公众平台注册同名公众号(原 wujisuanli 已弃用)
  icpRecord: '辽ICP备2026012682号',                   // 2026-06-19 备案通过
  icpQueryUrl: 'https://beian.miit.gov.cn/',          // 合规要求:页脚 ICP 链接到此
  icpPending: false,
}

export const OFFICIAL_LINKS = {
  home: '/',
  docs: '/docs',
  downloadCenter: '/#/downloads-center',
  beta: '/beta',
  login: '/login',
  register: '/register',
  dashboard: '/dashboard',
  enterprise: '/wq/#/login',
  enterpriseRoot: '/wq/',
  admin: '/admin/#/login',
  api: '/api',
  terms: '/terms',
  privacy: '/privacy',
  supportEmail: 'support@qianshousuanli.com',
  contactEmail: 'contact@qianshousuanli.com',
}

// 页脚版权行(全站统一)· 例:© 2026 千手算力 · 沈阳千手执棋网络科技有限公司 · 辽ICP备2026012682号
export const COPYRIGHT_LINE =
  `© ${new Date().getFullYear()} ${SITE_NAME} · ${COMPANY.legalName} · ${COMPANY.icpRecord}`
