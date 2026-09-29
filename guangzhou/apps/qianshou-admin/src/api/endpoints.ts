/**
 * 契约端点全集 —— 与 `packages/host/admin-console/API.md` 一一对应。
 *
 * 全站只有这一处出现路径字面量：视图只引用本表，避免路径散落导致契约漂移。
 * 所有接口一律 `POST` + JSON（API.md §1）。
 */

/** 接口前缀（API.md §1）：生产 `https://admin.qianshousuanli.com` 的同源相对路径。 */
export const ADMIN_API_PREFIX = '/api/qianshou/ai/admin'

export const ENDPOINTS = {
  apiConnectionsList: `${ADMIN_API_PREFIX}/api-connections/list`,
  apiConnectionsGuide: `${ADMIN_API_PREFIX}/api-connections/guide`,
  apiConnectionsDetail: `${ADMIN_API_PREFIX}/api-connections/detail`,
  apiConnectionsPreflight: `${ADMIN_API_PREFIX}/api-connections/preflight`,
  apiConnectionsApply: `${ADMIN_API_PREFIX}/api-connections/apply`,
  apiConnectionsCheck: `${ADMIN_API_PREFIX}/api-connections/check`,
  paymentOrders: `${ADMIN_API_PREFIX}/payment/orders`,
  paymentOrder: `${ADMIN_API_PREFIX}/payment/order`,
  paymentWithdrawals: `${ADMIN_API_PREFIX}/payment/withdrawals`,
  paymentPreflight: `${ADMIN_API_PREFIX}/payment/preflight`,
  paymentApply: `${ADMIN_API_PREFIX}/payment/apply`,
  enterpriseLeads: `${ADMIN_API_PREFIX}/enterprise/leads`,
  enterpriseLead: `${ADMIN_API_PREFIX}/enterprise/lead`,
  // §2 会话与身份
  sessionLogin: `${ADMIN_API_PREFIX}/session/login`,
  sessionLoginTotp: `${ADMIN_API_PREFIX}/session/login-totp`,
  sessionLogout: `${ADMIN_API_PREFIX}/session/logout`,
  sessionMe: `${ADMIN_API_PREFIX}/session/me`,

  // §3 模块就绪度
  modules: `${ADMIN_API_PREFIX}/modules`,

  // §4 权限模型
  rbacPermissions: `${ADMIN_API_PREFIX}/rbac/permissions`,
  rbacRolesList: `${ADMIN_API_PREFIX}/rbac/roles/list`,
  rbacRolesPreflight: `${ADMIN_API_PREFIX}/rbac/roles/preflight`,
  rbacRolesApply: `${ADMIN_API_PREFIX}/rbac/roles/apply`,
  rbacAdminsList: `${ADMIN_API_PREFIX}/rbac/admins/list`,
  rbacAdminsPreflight: `${ADMIN_API_PREFIX}/rbac/admins/preflight`,
  rbacAdminsApply: `${ADMIN_API_PREFIX}/rbac/admins/apply`,

  // §5 审计
  auditList: `${ADMIN_API_PREFIX}/audit/list`,
  auditDetail: `${ADMIN_API_PREFIX}/audit/detail`,

  // §6 功能开关
  flagsList: `${ADMIN_API_PREFIX}/flags/list`,
  flagsPreflight: `${ADMIN_API_PREFIX}/flags/preflight`,
  flagsApply: `${ADMIN_API_PREFIX}/flags/apply`,

  // §7 IP 白名单
  whitelistStatus: `${ADMIN_API_PREFIX}/whitelist/status`,
  whitelistEntriesPreflight: `${ADMIN_API_PREFIX}/whitelist/entries/preflight`,
  whitelistEntriesApply: `${ADMIN_API_PREFIX}/whitelist/entries/apply`,

  // §8.1 账号与额度
  accountList: `${ADMIN_API_PREFIX}/account/list`,
  accountDetail: `${ADMIN_API_PREFIX}/account/detail`,
  accountLedger: `${ADMIN_API_PREFIX}/account/ledger`,
  accountAdjustmentApply: `${ADMIN_API_PREFIX}/account/adjustment/apply`,
  accountAdjustmentCheck: `${ADMIN_API_PREFIX}/account/adjustment/check`,
  accountAdjustmentPreflight: `${ADMIN_API_PREFIX}/account/adjustment/preflight`,

  // §8.2 订阅与档位
  subscriptionList: `${ADMIN_API_PREFIX}/subscription/list`,
  subscriptionTiers: `${ADMIN_API_PREFIX}/subscription/tiers`,
  subscriptionManageApply: `${ADMIN_API_PREFIX}/subscription/manage/apply`,
  subscriptionManageCheck: `${ADMIN_API_PREFIX}/subscription/manage/check`,
  subscriptionManagePreflight: `${ADMIN_API_PREFIX}/subscription/manage/preflight`,

  // §8.3 技能 / 专家市场：中央服务器真实队列和既有人工审核
  marketOverview: `${ADMIN_API_PREFIX}/market/overview`,
  marketReviews: `${ADMIN_API_PREFIX}/market/reviews`,
  marketReview: `${ADMIN_API_PREFIX}/market/review`,
  marketManagedOrderPublications: `${ADMIN_API_PREFIX}/market/order-publications/managed`,
  marketOrderPublicationLifecycle: `${ADMIN_API_PREFIX}/market/order-publication/lifecycle`,
  marketOrderPublications: `${ADMIN_API_PREFIX}/market/order-publications`,
  marketOrderPublicationReview: `${ADMIN_API_PREFIX}/market/order-publication/review`,
  marketOrderAdapterProducts: `${ADMIN_API_PREFIX}/market/order-adapter-products`,
  marketOrderAdapterProductReview: `${ADMIN_API_PREFIX}/market/order-adapter-product/review`,

  // 广州讨论区：保留既有社区发布的审核与公告接口。
  communityList: `${ADMIN_API_PREFIX}/community/list`,
  communityModerate: `${ADMIN_API_PREFIX}/community/moderate`,
  communityReportResolve: `${ADMIN_API_PREFIX}/community/report/resolve`,
  communityAnnouncementCreate: `${ADMIN_API_PREFIX}/community/announcement/create`,

  // §8.4 发现页内容（占位）
  discoveryOverview: `${ADMIN_API_PREFIX}/discovery/overview`,

  // §8.5 订单与工单（占位）
  orderOverview: `${ADMIN_API_PREFIX}/order/overview`,

  // §8.5b 模型路由（占位：属主在 7080）
  modelsOverview: `${ADMIN_API_PREFIX}/models/overview`,

  // §8.6 健康检查
  health: `${ADMIN_API_PREFIX}/health`,

  // §9 上游密钥（只有 super-admin 可改；值永不回显）
  credentialList: `${ADMIN_API_PREFIX}/credential/list`,
  credentialPreflight: `${ADMIN_API_PREFIX}/credential/preflight`,
  credentialApply: `${ADMIN_API_PREFIX}/credential/apply`,

  // §8.8 上游号池（与上游密钥同一套权限：看 `credential.read`、改 `credential.manage` + super-admin；
  // 写操作两步确认，移除与加号共用 `pool/preflight` 的两个 op 分支）
  poolList: `${ADMIN_API_PREFIX}/pool/list`,
  poolPreflight: `${ADMIN_API_PREFIX}/pool/preflight`,
  poolApply: `${ADMIN_API_PREFIX}/pool/apply`,
  poolRemove: `${ADMIN_API_PREFIX}/pool/remove`,
} as const
