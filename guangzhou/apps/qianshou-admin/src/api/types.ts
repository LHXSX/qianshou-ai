/**
 * 契约类型定义 —— 唯一事实来源：`packages/host/admin-console/API.md`（冻结版 v1）。
 *
 * 本文件只描述服务端返回的形状，不含任何权限判断逻辑：
 * 前端不做安全边界判断，菜单、权限键、数据范围全部由服务端裁剪后下发。
 */

/** 某模块缺失的上游接口（API.md §3 的 `missing[]`）。 */
export interface MissingDependency {
  readonly interface: string
  readonly why: string
}

/** 服务端就绪度三档（API.md §3）。 */
export type ModuleStatus = 'ready' | 'read-only' | 'dependency-unavailable'

/** 就绪度条目（API.md §2.2 `session/me` 的 `readiness`，与 §3 `modules` 同形）。 */
export interface ReadinessEntry {
  readonly key: string
  readonly title: string
  readonly status: ModuleStatus
  readonly summary: string
  readonly missing: readonly MissingDependency[]
}

/** 侧栏菜单项：完全来自 `session/me`，前端不硬编码「哪个角色能看哪个菜单」。 */
export interface MenuEntry {
  readonly key: string
  readonly title: string
  readonly group: string
  /** 该菜单项需要的权限键；`null` 表示登录即可见。展示用，不用于前端鉴权。 */
  readonly perm: string | null
}

/** 当前登录管理员（API.md §2.2）。 */
export interface AdminIdentity {
  readonly accountId: string
  readonly displayName: string
  readonly roleId: string
  readonly roleName: string
  readonly roleKind: 'builtin' | 'custom'
  readonly scope: 'all' | 'self'
  /** 必须恒为 `ai-admin`，与算力运营台的角色不互通（API.md §0）。 */
  readonly surface: 'ai-admin'
}

/** `POST session/me` 响应。 */
export interface SessionMe {
  readonly admin: AdminIdentity
  readonly permissions: readonly string[]
  readonly menu: readonly MenuEntry[]
  readonly readiness: readonly ReadinessEntry[]
  /** 服务端看到的来源 IP（白名单页高亮展示）。 */
  readonly clientIp: string
}

/** 两步确认令牌与差异预览（API.md §1.3）。 */
export interface ConfirmPreview<TBefore = unknown, TAfter = unknown> {
  readonly token: string
  readonly expiresAt: number
  readonly diff: { readonly before: TBefore; readonly after: TAfter }
}

/** `…/apply` 的成功结果（API.md §1.3）。 */
export interface ApplyResult {
  readonly auditId: string
  readonly result: unknown
}

// —— §4 权限模型 ————————————————————————————————————————————————

export interface PermissionItem {
  readonly key: string
  readonly title: string
  /** `true` = 必须走 §1.3 两步确认。 */
  readonly highRisk: boolean
  readonly description: string
}

export interface PermissionGroup {
  readonly module: string
  readonly title: string
  readonly items: readonly PermissionItem[]
}

export type RoleKind = 'builtin' | 'custom'

export interface RoleRecord {
  readonly id: string
  readonly name: string
  readonly kind: RoleKind
  readonly surface: string
  readonly description: string
  readonly permissions: readonly string[]
  readonly scopeDefault: 'all' | 'self'
  readonly memberCount: number
}

export interface AdminRecord {
  readonly accountId: string
  readonly displayName: string
  readonly roleId: string
  readonly scope: 'all' | 'self'
  readonly enabled: boolean
  readonly createdAt: number
  readonly createdBy: string
}

export type RoleOp = 'create' | 'update' | 'delete'
export type AdminOp = 'grant' | 'update' | 'revoke'

export interface RoleDraft {
  readonly op: RoleOp
  readonly id?: string
  readonly name?: string
  readonly permissions?: readonly string[]
  readonly scopeDefault?: 'all' | 'self'
  readonly description?: string
}

export interface AdminDraft {
  readonly op: AdminOp
  readonly accountId: string
  readonly roleId?: string
  readonly scope?: 'all' | 'self'
  readonly displayName?: string
}

// —— §5 审计 ————————————————————————————————————————————————

export type AuditResult = 'allow' | 'deny'

export interface AuditQuery {
  readonly from?: number
  readonly to?: number
  readonly actorId?: string
  readonly actionPrefix?: string
  readonly result?: AuditResult
  readonly limit?: number
  readonly offset?: number
}

export interface AuditEntry {
  readonly id: string
  readonly at: number
  readonly actorId: string
  readonly actorRole: string
  readonly ip: string
  readonly action: string
  readonly target: string
  readonly result: AuditResult
  readonly reason: string
  readonly summary: string
}

export interface AuditDiffRow {
  readonly path: string
  readonly before: unknown
  readonly after: unknown
}

export interface AuditEntryDetail extends AuditEntry {
  readonly before: unknown
  readonly after: unknown
  readonly diff: readonly AuditDiffRow[]
}

// —— §6 功能开关 ————————————————————————————————————————————————

export interface FlagRecord {
  readonly key: string
  readonly title: string
  readonly enabled: boolean
  readonly rolloutPercent: number
  readonly description: string
  readonly updatedAt: number
  readonly updatedBy: string
  readonly version: number
}

export interface FlagDraft {
  readonly key: string
  readonly title?: string
  readonly enabled?: boolean
  readonly rolloutPercent?: number
  readonly description?: string
}

// —— §7 IP 白名单 ————————————————————————————————————————————————

export interface WhitelistEntry {
  readonly cidr: string
  readonly note: string
  readonly addedBy: string
  readonly addedAt: number
}

export interface WhitelistEscapeHatch {
  readonly loopbackAlwaysAllowed: boolean
  readonly cliHint: string
}

export interface WhitelistStatus {
  readonly enabled: boolean
  readonly clientIp: string
  readonly entries: readonly WhitelistEntry[]
  readonly escapeHatch: WhitelistEscapeHatch
}

export type WhitelistOp = 'add' | 'remove'

export interface WhitelistDraft {
  readonly op: WhitelistOp
  readonly cidr: string
  readonly note?: string
}

// —— §8.1 账号与额度 ——————————————————————————————————————————————

export interface AccountRow {
  readonly accountId: string
  readonly tier: string
  readonly grantedSp: number
  readonly usedSp: number
  readonly remainingSp: number
  readonly callCount: number
  readonly lastCallAt: number
}

export interface AccountDetail {
  readonly accountId: string
  readonly tier: string
  readonly grantedSp: number
  readonly usedSp: number
  readonly remainingSp: number
  readonly callCount: number
  readonly lastCallAt: number
}

export interface AccountReservation {
  readonly [key: string]: unknown
}

export interface LedgerRow {
  readonly at: number
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly sp: number
}

export interface AccountAdjustmentDraft {
  readonly accountId: string
  readonly deltaSp: number
  readonly reason: string
}

// —— §8.2 订阅与档位 ——————————————————————————————————————————————

export interface SubscriptionRow {
  readonly accountId: string
  readonly tier: string
  readonly from: number
  readonly to: number
  readonly grantedBy: string
  readonly reason: string
  readonly active: boolean
}

export interface TierRecord {
  readonly id: string
  readonly label: string
  readonly monthlySp: number
  readonly priceCny: number
}

export interface SubscriptionTierCatalog {
  readonly source: string
  readonly tiers: readonly TierRecord[]
}

// —— §8.6 健康检查 ——————————————————————————————————————————————

export interface HealthPayload {
  readonly service: string
  readonly version: string
  readonly uptimeMs: number
}

// —— 取数函数的返回信封（服务端 `{ok:true,…}` 去掉 ok 后的业务字段） ——————
// 集中在这里，避免每个模块各自定义一份「同一契约的不同类型」。

export interface AccountListResult {
  readonly total: number
  readonly accounts: readonly AccountRow[]
}

export interface AccountDetailResult {
  readonly account: AccountDetail
  readonly reservations: readonly AccountReservation[]
}

export interface LedgerResult {
  readonly total: number
  readonly entries: readonly LedgerRow[]
}

export interface SubscriptionListResult {
  readonly total: number
  readonly entries: readonly SubscriptionRow[]
}

export interface AuditListResult {
  readonly total: number
  readonly entries: readonly AuditEntry[]
}

// —— §9 上游密钥（契约 §9）————————————————————————————————————————
// 安全前提：**任何响应里都不会出现密钥明文**。这里也没有装明文的字段，
// 所以"忘记脱敏"在类型层面就写不出来。

/** 一个上游密钥的状态（**不含值**）。 */
export interface UpstreamKeyRow {
  readonly ref: string
  readonly configured: boolean
  /** sha256 前 8 位；键不存在时为 `null`。 */
  readonly fingerprint: string | null
  readonly updatedAt: number | null
  readonly updatedBy: string | null
  readonly previousFingerprint: string | null
  /** 环境变量里已提供同名的键 → 写文件不会生效（必须让管理员看见）。 */
  readonly shadowedByEnvironment: boolean
  /** 改完是否需要重启工作台才生效（网关对已解析成功的密钥永久缓存）。 */
  readonly restartRequired: boolean
  readonly restartService: string | null
  readonly restartCommand: string | null
  /** 凭据文件读不懂时的原因（此时列表是降级展示）。 */
  readonly documentError?: { readonly code: string; readonly message: string }
}

/** `POST credential/list` 的业务字段。 */
export interface UpstreamKeysResult {
  readonly credentialsPath: string
  readonly fileExists: boolean
  readonly fileMode: string | null
  readonly keys: readonly UpstreamKeyRow[]
  readonly activation: {
    readonly fileWatcher: string
    readonly gatewayCache: string
    readonly restartRequired: boolean
    readonly restartService: string | null
    readonly restartCommand: string | null
    readonly note: string
  }
  readonly backups: { readonly dir: string }
}

/** 连通性探测结论（预览与执行都会带）。 */
export interface UpstreamProbeOutcome {
  readonly ok: boolean
  readonly latencyMs?: number
  readonly model?: string | null
  readonly kind?: string
  readonly message?: string
  readonly status?: number | null
}

/** `POST credential/apply` 成功时的 `result`。 */
export interface UpstreamKeyWriteResult {
  readonly ref: string
  readonly fingerprint: string
  readonly previousFingerprint: string | null
  readonly propagatedByFileWatcher: boolean
  readonly restartRequired: boolean
  readonly restartService: string | null
  readonly restartCommand: string | null
  readonly backupPath: string | null
  readonly updatedAt: number
  readonly updatedBy: string
}
