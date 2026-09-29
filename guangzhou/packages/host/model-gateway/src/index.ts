/**
 * 千手订阅模型网关。
 *
 * 一句话：**用户不填密钥，我们统一出；订阅三档管额度，按 token 真实用量扣费，
 * 换后端模型不惊动用户。**
 *
 * 模块分工：
 * - `tiers.ts`：档位、模型目录、限额判定（纯逻辑）
 * - `ledger.ts`：额度账本（预留-结算、五小时滚动刹车、逐调用审计）
 * - `forward.ts`：转发（流式、用量回执）
 * - `service.ts`：把上面三段串成一条线
 * - `routes.ts`：HTTP 面（对话 + 额度状态）
 * - `routing.ts` + `admin-routes.ts`：模型路由控制台（数据面 + 管理面）
 * - `plugin.ts`：挂进工作台的插件面
 */

export { BACKENDS, CNY_PER_USD, PUBLISHED_MODELS, SP_PER_YUAN, TIERS, TIER_IDS, admit, estimateTokens, isTierId, spForUsage } from './tiers.ts'
export type { Admission, BackendModel, CreditState, GatewayMessage, GatewayRequest, PublishedModel, Rejection, RejectionKind, Tier, TierId, Usage } from './tiers.ts'

export { MICRO_SP_PER_SP, WINDOW_MS, createCreditLedger } from './ledger.ts'
export { LEDGER_STORE_FILENAME, createLedgerStore } from './persistence.ts'
export { TIER_STORE_FILENAME, createTierStore } from './tier-store.ts'
export type { Subscription, TierStore, TierStoreSnapshot } from './tier-store.ts'
export { ADMIN_SUBSCRIPTIONS_PATH, ADMIN_SUBSCRIPTION_PATH, createSubscriptionAdminRoutes } from './subscription-routes.ts'
export type { LedgerSnapshot, LedgerStore } from './persistence.ts'
export type { CallRecord, CreditLedger, CreditLedgerOptions, LedgerOutcome } from './ledger.ts'

export { FORWARD_COPY, ForwardFailure, classifyForwardStatus, forwardStream, parseWholeResponse } from './forward.ts'
export type { ForwardCall, ForwardFailureKind, ForwardHandlers, ForwardStream, ForwarderConfig, ProviderUsage } from './forward.ts'

export { createGateway, resolveModel, resolveModelAt } from './service.ts'
export { createConcurrencyGuard } from './concurrency.ts'
export { createPluginMarketRoute, readApprovedPluginCatalog, PLUGIN_MARKET_PATH } from './plugin-market.ts'
export { ADMIN_MARKETPLACE_PATH, createMarketplaceAdminRoute } from './marketplace-admin.ts'
export type { ApprovedPluginListing, PluginMarketOptions } from './plugin-market.ts'
export { createPluginReleasesRoute, readApprovedPluginReleases, readPinnedApprovedPluginReleases,
  validateApprovedPluginRelease, assertAppendOnlyReleases,
  pluginReleasePayload, pluginApprovalPayload, PLUGIN_RELEASES_PATH } from './plugin-releases.ts'
export type { ApprovedPluginRelease, PluginReleaseOptions } from './plugin-releases.ts'
export { createPluginFreeLicenseService, PLUGIN_LICENSE_PATH } from './plugin-license.ts'
export type { PluginFreeLicenseOptions } from './plugin-license.ts'
export { createPluginLicenseBearerRoute, createPluginLicenseBearerVerifier,
  PLUGIN_LICENSE_BEARER_PATH } from './plugin-license-bearer.ts'
export type { PluginLicenseBearerOptions } from './plugin-license-bearer.ts'
export { verifyDeclarationPluginPackage, verifySeedPluginPackage } from './plugin-seed-package.ts'
export type { DeclarationPackageManifest, VerifiedDeclarationPackage,
  SeedPackageManifest, VerifiedSeedPackage } from './plugin-seed-package.ts'
export { verifyReviewableExecutionPackage } from './plugin-reviewable-execution.ts'
export type { ReviewableExecutionManifest, VerifiedReviewableExecutionPackage } from './plugin-reviewable-execution.ts'
export { pluginExecutionApprovalPayload, pluginExecutionPublisherPayload,
  validateExecutionCandidate } from './plugin-execution-candidate.ts'
export type { PluginExecutionCandidate } from './plugin-execution-candidate.ts'
export { createPluginSubmissionRoute, pluginDeclarationReviewPayload, pluginRejectionPayload,
  PLUGIN_SUBMISSIONS_PATH } from './plugin-submissions.ts'
export type { PluginDeclarationReviewReceipt, PluginRejectionReceipt,
  PluginSubmissionOptions } from './plugin-submissions.ts'
export { createPluginSubmissionBearerRoute, PLUGIN_SUBMISSIONS_BEARER_PATH } from './plugin-submission-bearer.ts'
export { createPluginExecutionAccessRoute, PLUGIN_EXECUTION_ACCESS_PATH } from './plugin-execution-access.ts'
export { forwardRaw, RawForwardFailure } from './raw-forward.ts'
export type { ConcurrencyGuard } from './concurrency.ts'
export type { Gateway, GatewayCall, GatewayDeps, GatewayFailure, GatewayHandlers } from './service.ts'

export { AI_API_VERSION, AI_CHAT_PATH, AI_COMPLETIONS_PATH, AI_STATUS_PATH, createAiCompletionsRoute, createAiRoutes, statusForRejection } from './routes.ts'
export type { AiRoutesDeps } from './routes.ts'

export { bucketOf, createRoutingConsole } from './routing.ts'
export type { BackendBinding, LifecycleStage, PublishedNameRecord, ResolveOutcome, RoutingConsole, UpgradeRule } from './routing.ts'

export { ADMIN_BIND_PATH, ADMIN_NAMES_PATH, createAiAdminRoutes, normalizeBindInput, normalizeNameRecord } from './admin-routes.ts'
export { ADMIN_AUDIT_PATH, AI_AUDIT_PATH, createAiAdminAuditRoutes, createAiAuditRoutes } from './audit-routes.ts'
export type { AiAdminDeps, Principal } from './admin-routes.ts'

export { apply, inject, name } from './plugin.ts'
export type { Config } from './plugin.ts'
