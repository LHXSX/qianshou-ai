/**
 * AI 运营管理台的服务端：白名单 → 会话 → RBAC → 审计，四道关卡一条流水线。
 *
 * ## 为什么是一个独立进程
 *
 * 用户的硬边界是「算力运营台与 AI 产品后台必须两套」。这里再加一条工程理由：
 * 管理台要能在**工作台挂掉时仍然可登录**（否则出了事故连审计都查不了），
 * 也要能单独重启、单独升级、单独限流。所以它是自己的 systemd 服务、
 * 自己的端口、自己的数据目录，只把"账号身份"这一件事复用上游。
 *
 * ## 请求流水线（顺序不能换）
 *
 * 1. **来源地址**：只有 socket 对端是回环时才采信代理头（见 `client-ip.ts`）。
 * 2. **IP 白名单**：默认拒绝；回环永远放行（逃生路径）。被拒也写审计。
 * 3. **同源检查**：带 Origin/Referer 的请求必须与本站一致。
 * 4. **会话**：cookie 里的随机串 → 内存会话；同时校验管理员记录与角色仍在。
 * 5. **权限**：每条路由都声明所需权限键；**没有声明权限的路由根本注册不上**（fail-closed）。
 * 6. **二次确认**：高危操作分 preflight / apply 两步，令牌绑定载荷。
 * 7. **审计**：写操作、被拒的请求、登录成功/失败、白名单拒绝，全部留痕。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createAuditLog, computeDiff, type AuditEntry, type AuditLog } from './audit.ts'
import {
  clearSessionCookie,
  createSessionStore,
  readSessionCookie,
  sessionCookie,
  type SessionRecord,
} from './session.ts'
import { createConfirmStore, type ConfirmStore } from './confirm.ts'
import { createJsonStore, dataFilePath, readJson, type JsonStore } from './store.ts'
import {
  BUILTIN_ROLES,
  MODULE_TITLES,
  can,
  findRole,
  menuFor,
  permissionGroups,
  roleGrantable,
  validateRoleInput,
  type AdminRecord,
  type DataScope,
  type RoleRecord,
} from './rbac.ts'
import { decideWhitelist, emptyWhitelist, isValidRule, type WhitelistConfig, type WhitelistEntry } from './whitelist.ts'
import { blockedReadiness, type ModuleReadiness } from './modules.ts'
import {
  createLedgerReader,
  createSubscriptionReader,
  readTierCatalog,
  type LedgerReader,
  type SubscriptionReader,
} from './data-sources.ts'
import { createWorkbenchUpstream, type WorkbenchAdminConfig } from './workbench-upstream.ts'
import { registerOperationalModules } from './operational-modules.ts'
import { registerWorkbenchRoutes } from './workbench-routes.ts'
import { createApiConnectionsUpstream } from './api-connections-upstream.ts'
import type { ApiPlatformConfig } from './api-connections-platform.ts'
import { registerApiConnectionsRoutes } from './api-connections-routes.ts'
import { registerPaymentRoutes } from './payment-routes.ts'
import { createPaymentUpstream } from './payment-upstream.ts'
import { registerEnterpriseLeadRoutes } from './enterprise-leads-routes.ts'
import { createEnterpriseLeadsUpstream } from './enterprise-leads-upstream.ts'
import { registerMarketplaceRoutes } from './marketplace-routes.ts'
import { createCommunityStore, COMMUNITY_PREFIX } from './community.ts'
import { createCommunityHttp } from './community-http.ts'
import { registerCommunityRoutes } from './community-routes.ts'
import { createMarketplaceUpstream } from './marketplace-upstream.ts'
import { createAccountUpstream, type AccountUpstream } from './account-upstream.ts'
import {
  CredentialsDocumentError,
  createUpstreamKeyStore,
  fingerprintOf,
  shadowedByEnvironment,
  type UpstreamKeyStore,
} from './upstream-keys.ts'
import { createKeyMetadataStore, type KeyMetadataStore } from './upstream-key-meta.ts'
import {
  CURSOR_POOL_PROBE_TARGET,
  probeTargetFor,
  probeUpstreamKey,
  type ProbeDeps,
  type ProbeFailureKind,
} from './connectivity.ts'
import { isCursorPoolRef } from './cursor-credential.ts'
import { createPool, duplicateBasisLabel, type PoolPreparation, type PoolStore } from './pool.ts'
import {
  MAX_BODY_BYTES,
  checkOrigin,
  clientAddressOf,
  pathnameOf,
  readJsonBody,
  safeJoin,
  sendFile,
  sendJson,
  sendText,
} from './http.ts'

/** 服务版本（`/health` 与响应头里用）。 */
export const SERVICE_VERSION = '0.1.0'

/** 接口前缀。 */
export const API_PREFIX = '/api/qianshou/ai/admin'

/** 会话 cookie 名（与 `session.ts` 一致，导出便于测试）。 */
export { SESSION_COOKIE } from './session.ts'

/** 配置。 */
export interface AdminConfig {
  /** Dedicated service configuration; secrets remain in the existing refs document. */
  readonly workbench?: WorkbenchAdminConfig
  /** Dedicated node-control service identity, independent from finance and dispatcher credentials. */
  readonly apiConnections?: WorkbenchAdminConfig
  /** Public bootstrap probe only; never a private exchange/service origin. */
  readonly apiConnectionsPlatform?: ApiPlatformConfig
  /** 数据目录（管理员、角色、白名单、开关、审计）。 */
  readonly dataDir: string
  /** 前端产物目录。 */
  readonly webRoot: string
  /** 本站源（同源检查与 cookie 用）。 */
  readonly origin: string
  /** 上游账号服务基址。 */
  readonly accountBaseUrl: string
  /** 上游前缀。 */
  readonly accountPrefix?: string
  /** 工作台的 `DSH_HOME`（账本与订阅快照所在）。 */
  readonly dshHome: string
  /** 模型网关 `tiers.ts` 路径（档位目录的唯一来源）。 */
  readonly tiersPath: string
  /** 是否采信 nginx 写的来源头。 */
  readonly trustProxy: boolean
  /** 会话绝对有效期。 */
  readonly sessionTtlMs?: number
  /** 两次上游身份核验之间的最小间隔。 */
  readonly verifyIntervalMs?: number
  /** 时钟（测试注入）。 */
  readonly now?: () => number
  /** fetch（测试注入）。 */
  readonly fetch?: typeof fetch
  /**
   * 上游密钥的连通性探测依赖（测试注入）。
   *
   * 真实部署下不需要给：默认打真实上游。测试里必须注入，原因不是"图快"，
   * 而是**测试绝不能拿真密钥发请求**，也不能把用例的成败绑在上游的可用性上。
   */
  readonly probe?: ProbeDeps
}

/** 功能开关记录。 */
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

/** 管理员文件。 */
interface AdminsFile {
  readonly version: 1
  readonly admins: readonly AdminRecord[]
}

/** 角色文件（只存自定义角色）。 */
interface RolesFile {
  readonly version: 1
  readonly roles: readonly RoleRecord[]
}

/** 开关文件。 */
interface FlagsFile {
  readonly version: 1
  readonly flags: readonly FlagRecord[]
}

/** 白名单文件。 */
interface WhitelistFile extends WhitelistConfig {
  readonly version: 1
}

/** 服务句柄。 */
export interface AdminService {
  /** 处理一个请求。 */
  readonly handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  /** 就绪度（接口与 CLI 共用）。 */
  readonly readiness: () => Promise<readonly ModuleReadiness[]>
  /** 存储与组件（测试与 CLI 用）。 */
  readonly components: {
    readonly admins: JsonStore<AdminsFile>
    readonly roles: JsonStore<RolesFile>
    readonly whitelist: JsonStore<WhitelistFile>
    readonly flags: JsonStore<FlagsFile>
    readonly audit: AuditLog
    readonly sessions: ReturnType<typeof createSessionStore>
    readonly confirms: ConfirmStore
    readonly ledger: LedgerReader
    readonly subscriptions: SubscriptionReader
    readonly upstream: AccountUpstream
    /** 上游号池（测试与运维要看元数据文件在哪、池里此刻有什么）。 */
    readonly pool: PoolStore
  }
}

/** 取对象字段的辅助。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 字符串字段。 */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 布尔字段（只有真布尔才算）。 */
function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** 数字字段。 */
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 校验管理员文件。 */
function validateAdminsFile(raw: unknown): AdminsFile | null {
  if (!isRecord(raw) || !Array.isArray(raw['admins'])) return null
  const admins: AdminRecord[] = []
  for (const row of raw['admins']) {
    if (!isRecord(row)) return null
    const accountId = asString(row['accountId'])
    const roleId = asString(row['roleId'])
    if (accountId === null || roleId === null) return null
    admins.push({
      accountId,
      displayName: asString(row['displayName']) ?? accountId,
      roleId,
      scope: row['scope'] === 'self' ? 'self' : 'all',
      enabled: asBoolean(row['enabled']) ?? true,
      createdAt: asNumber(row['createdAt']) ?? 0,
      createdBy: asString(row['createdBy']) ?? 'unknown',
    })
  }
  return { version: 1, admins }
}

/** 校验角色文件。 */
function validateRolesFile(raw: unknown): RolesFile | null {
  if (!isRecord(raw) || !Array.isArray(raw['roles'])) return null
  const roles: RoleRecord[] = []
  for (const row of raw['roles']) {
    if (!isRecord(row)) return null
    const id = asString(row['id'])
    const name = asString(row['name'])
    if (id === null || name === null) return null
    // 面不对的角色**直接丢弃**：两套角色表分离不能靠"写入时小心"，读取时也要挡。
    if (row['surface'] !== 'ai-admin') continue
    const permissions = Array.isArray(row['permissions'])
      ? row['permissions'].filter((item): item is string => typeof item === 'string')
      : []
    roles.push({
      id,
      name,
      kind: 'custom',
      surface: 'ai-admin',
      description: asString(row['description']) ?? '',
      permissions,
      scopeDefault: row['scopeDefault'] === 'self' ? 'self' : 'all',
    })
  }
  return { version: 1, roles }
}

/** 校验开关文件。 */
function validateFlagsFile(raw: unknown): FlagsFile | null {
  if (!isRecord(raw) || !Array.isArray(raw['flags'])) return null
  const flags: FlagRecord[] = []
  for (const row of raw['flags']) {
    if (!isRecord(row)) return null
    const key = asString(row['key'])
    if (key === null) return null
    const rollout = asNumber(row['rolloutPercent'])
    flags.push({
      key,
      title: asString(row['title']) ?? key,
      enabled: asBoolean(row['enabled']) ?? false,
      rolloutPercent: rollout === null ? 100 : Math.min(Math.max(Math.round(rollout), 0), 100),
      description: asString(row['description']) ?? '',
      updatedAt: asNumber(row['updatedAt']) ?? 0,
      updatedBy: asString(row['updatedBy']) ?? 'unknown',
      version: asNumber(row['version']) ?? 1,
    })
  }
  return { version: 1, flags }
}

/** 校验白名单文件。 */
function validateWhitelistFile(raw: unknown): WhitelistFile | null {
  if (!isRecord(raw)) return null
  const entries: WhitelistEntry[] = []
  for (const row of Array.isArray(raw['entries']) ? raw['entries'] : []) {
    if (!isRecord(row)) continue
    const cidr = asString(row['cidr'])
    if (cidr === null) continue
    entries.push({
      cidr,
      note: asString(row['note']) ?? '',
      addedBy: asString(row['addedBy']) ?? 'unknown',
      addedAt: asNumber(row['addedAt']) ?? 0,
    })
  }
  // `enabled` 只认真布尔；其它值按**启用**处理（fail-closed：不认识就当白名单生效）。
  return { version: 1, enabled: raw['enabled'] === false ? false : true, entries }
}

/** 一条路由。 */
export interface Route {
  /** 路径（不含前缀）。 */
  readonly path: string
  /** `public` 无需登录；`session` 需登录；`permission` 需指定权限。 */
  readonly auth: 'public' | 'session' | 'permission'
  /** 权限键（`auth: 'permission'` 时必填）。 */
  readonly permission?: string
  /** 这条路由会不会改状态（决定要不要写审计）。 */
  readonly mutating: boolean
  /** 处理器；同步也算合法（有些路由只是读内存里的一个值）。 */
  readonly handler: (ctx: RouteContext) => Promise<void> | void
}

/** 一条路由的执行上下文。 */
export interface RouteContext {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly body: Record<string, unknown>
  readonly ip: string
  readonly addressSource: string
  readonly requestId: string
  /** 已登录时的管理员记录与角色。 */
  readonly admin: AdminRecord | null
  readonly role: RoleRecord | null
  /** 有效数据范围。 */
  readonly scope: DataScope
  /** 会话令牌（登出用）。 */
  readonly sessionToken: string | null
  /** 会话记录（定期核验用）。 */
  readonly session: SessionRecord | null
  /** 发 JSON 响应（可带额外响应头，例如 Set-Cookie）。 */
  readonly json: (status: number, value: unknown, headers?: Record<string, string>) => void
}

/**
 * 登录失败限流：同一来源在窗口内失败太多次就先拒绝一会儿。
 *
 * 为什么管理台需要自己的这一层（上游账号服务也可能限流，但那不是我们的边界）：
 * 管理台在公网上，登录入口就是唯一的口令入口。没有本地限流时，攻击者能不能试出
 * 口令只取决于上游的限流策略——而那是另一个团队、另一套规则的资产，
 * 我们不该把自己的门锁托付给别人。窗口内计数是**按来源 IP** 的（白名单已经把
 * 来源收得很窄，所以这里不需要更复杂的键）。
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000
/** 窗口内允许的失败次数。10 次足够真人打错几次，也不给暴力试口令留空间。 */
const LOGIN_MAX_FAILURES = 10

/** 生成请求 id（审计里用它把一次请求的若干条记录串起来）。 */
function newRequestId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * 建管理台服务。
 * @param config - 配置。
 * @returns 服务句柄。
 */
export function createAdminService(config: AdminConfig): AdminService {
  const now = config.now ?? (() => Date.now())
  const startedAt = now()

  const admins = createJsonStore<AdminsFile>({
    path: join(config.dataDir, 'admins.json'),
    defaults: () => ({ version: 1, admins: [] }),
    validate: validateAdminsFile,
  })
  const roles = createJsonStore<RolesFile>({
    path: join(config.dataDir, 'roles.json'),
    defaults: () => ({ version: 1, roles: [] }),
    validate: validateRolesFile,
  })
  const whitelist = createJsonStore<WhitelistFile>({
    path: join(config.dataDir, 'whitelist.json'),
    defaults: () => ({ version: 1, ...emptyWhitelist() }),
    validate: validateWhitelistFile,
  })
  const flags = createJsonStore<FlagsFile>({
    path: join(config.dataDir, 'flags.json'),
    defaults: () => ({ version: 1, flags: [] }),
    validate: validateFlagsFile,
  })
  const audit = createAuditLog({ path: dataFilePath(config.dataDir, 'audit'), now })
  const sessions = createSessionStore({
    ...(config.sessionTtlMs === undefined ? {} : { ttlMs: config.sessionTtlMs }),
    now,
  })
  const confirms = createConfirmStore({ now })
  const ledger = createLedgerReader({ dshHome: config.dshHome })
  const subscriptions = createSubscriptionReader({ dshHome: config.dshHome, now })
  /**
   * 上游密钥存储。
   *
   * 凭据文件在**工作台的 `DSH_HOME`** 下（默认 `/srv/qianshou-home`），
   * 而不是管理台自己的数据目录 —— 这是"两份数据各有其主"的落点：
   * 密钥归凭据体系，管理面元数据归管理台。
   */
  const upstreamKeys: UpstreamKeyStore = createUpstreamKeyStore({
    dshHome: config.dshHome,
    backupDir: join(config.dataDir, 'credential-backups'),
    now,
  })
  const keyMetadata: KeyMetadataStore = createKeyMetadataStore(join(config.dataDir, 'upstream-key-meta.json'))
  /**
   * 上游号池。
   *
   * 号池的号**就是凭据文件 `refs:` 段里的一个 ref**（`CURSOR_CK_<sha256(authId) 前 8 位>`），
   * 所以它复用同一个 `UpstreamKeyStore`（同一条写入协议），只把标签/状态/验活时间
   * 这类管理面元数据放在管理台自己的数据目录里。
   */
  const pool: PoolStore = createPool({
    entries: async () => await upstreamKeys.readEntries(),
    metadataPath: join(config.dataDir, 'pool.json'),
    upstream: config.probe ?? {},
  })
  const upstream = createAccountUpstream({
    baseUrl: config.accountBaseUrl,
    ...(config.accountPrefix === undefined ? {} : { prefix: config.accountPrefix }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  })
  const community = createCommunityStore({ dataDir: config.dataDir, now })
  const communityHttp = createCommunityHttp({ upstream, store: community, origin: config.origin })
  const workbench = createWorkbenchUpstream({
    ...(config.workbench === undefined ? {} : { config: config.workbench }),
    dshHome: config.dshHome, ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  })
  const apiConnections = createApiConnectionsUpstream({
    ...(config.apiConnections === undefined ? {} : { config: config.apiConnections }),
    ...(config.apiConnectionsPlatform === undefined ? {} : { platform: config.apiConnectionsPlatform }), now,
    dshHome: config.dshHome, ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  })
  const verifyIntervalMs = config.verifyIntervalMs ?? 10 * 60 * 1000

  /** 写审计（永不抛：审计写失败不该让业务动作消失，但要在 stderr 留痕）。 */
  const recordAudit = async (draft: Parameters<AuditLog['record']>[0]): Promise<AuditEntry | null> => {
    try {
      return await audit.record(draft)
    } catch (error) {
      // 这里刻意不抛：一次磁盘满不该让"改白名单"变成半成功半失败的状态。
      process.stderr.write(`[admin-console] 审计写入失败：${String(error)}\n`)
      return null
    }
  }

  /** 登录失败记录：来源 IP → 失败时刻列表。 */
  const loginFailures = new Map<string, number[]>()

  /** 这个来源当前是否因为失败过多被拒。 */
  const loginThrottled = (ip: string): boolean => {
    const at = now()
    const recent = (loginFailures.get(ip) ?? []).filter(stamp => at - stamp < LOGIN_WINDOW_MS)
    loginFailures.set(ip, recent)
    return recent.length >= LOGIN_MAX_FAILURES
  }

  /** 记一次失败。 */
  const recordLoginFailure = (ip: string): void => {
    const recent = (loginFailures.get(ip) ?? []).filter(stamp => now() - stamp < LOGIN_WINDOW_MS)
    recent.push(now())
    loginFailures.set(ip, recent)
  }

  /** 就绪度（每次实时算：数据源可读性会变）。 */
  const readiness = async (): Promise<readonly ModuleReadiness[]> => {
    const ledgerStatus = await ledger.status()
    const subscriptionStatus = await subscriptions.status()
    const tierCatalog = await readTierCatalog({ tiersPath: config.tiersPath })
    return [
      { key: 'apiConnections', title: 'API管理', status: apiConnections.configured ? 'ready' : 'dependency-unavailable',
        summary: apiConnections.configured ? '查询广州持久节点目录；暂停、恢复和吊销经两步确认、属主事务与审计。接口不可达时如实返回不可用。' : '广州节点管理专用服务身份尚未配置。',
        missing: apiConnections.configured ? [] : [{ interface: 'POST /internal/media/admin/*', why: '需配置节点管理独立服务凭据，不可借用用户或调度令牌。', owner: '广州节点目录属主' }] },
      {
        key: 'account',
        title: MODULE_TITLES['account'] ?? '账号与额度',
        status: workbench.configured && ledgerStatus.available ? 'ready' : 'read-only',
        summary: workbench.configured ? 'SP 调整已配置工作台服务身份；每次预览查询工作台实时值，确认后由属主记账。' : ledgerStatus.available
          ? '可读真实账本（授予额度、已用、逐次调用流水）。'
          : `账本暂不可读：${ledgerStatus.detail}`,
        missing: workbench.configured ? [] : [
          {
            interface: 'POST /internal/ledger/adjust',
            why: '「处理异常扣费」要给账号补扣/退还 SP，必须由账本属主服务执行（它持有内存态与结算逻辑）。',
            owner: '模型网关（工作台进程）',
          },
        ],
      },
      {
        key: 'subscription',
        title: MODULE_TITLES['subscription'] ?? '订阅与档位',
        status: workbench.configured && subscriptionStatus.available && tierCatalog.available ? 'ready' : 'read-only',
        summary: workbench.configured ? '订阅管理已配置工作台服务身份；期限由操作者明确选择，预览验证实际可用性。' : subscriptionStatus.available
          ? '可读真实订阅记录与档位目录；开通/降级/改价需要属主服务。'
          : `订阅暂不可读：${subscriptionStatus.detail}`,
        missing: [
          ...(workbench.configured ? [] : [{
            interface: 'POST /internal/subscriptions/grant',
            why: '开通和变更需要属主订阅存储；退款不在此接口范围。',
            owner: '模型网关（工作台进程）',
          }]),
          ...(tierCatalog.available
            ? []
            : [{
              interface: `GET 档位目录（当前读不到 ${config.tiersPath}）`,
              why: '档位价格与额度是计费口径，只能有一个来源。',
              owner: '模型网关（工作台进程）',
            }]),
        ],
      },
      {
        key: 'market', title: MODULE_TITLES['market'] ?? '技能 / 专家市场', status: 'read-only',
        summary: '广州管理员可查看上海平台待审投稿并审核符合现行规则的条目。可执行接单技能仍需可信验包、外置媒体核验与专用派单授权。',
        missing: [{ interface: '接单技能验签与媒体结果核验', why: '可执行技能不能仅凭作者填写的摘要审核通过。', owner: '发布与媒体核验服务' }],
      },
      { key: 'community', title: MODULE_TITLES['community'] ?? '讨论区', status: 'ready',
        summary: '复用上海账号身份的发帖、回复、已解决和举报；管理员可审核和发布活动。', missing: [] },
      ...await operationalModules.readiness(),
      {
        key: 'rbac',
        title: MODULE_TITLES['rbac'] ?? '权限与角色',
        status: 'ready',
        summary: '角色与权限服务端强制、高危操作两步确认、全部写操作留痕。',
        missing: [],
      },
      {
        key: 'audit',
        title: MODULE_TITLES['audit'] ?? '审计日志',
        status: 'ready',
        summary: '只追加的审计（含被拒的越权尝试与白名单拒绝）。',
        missing: [],
      },
      {
        key: 'whitelist',
        title: MODULE_TITLES['whitelist'] ?? 'IP 白名单',
        status: 'ready',
        summary: '默认拒绝；白名单为空时仅回环可访问（逃生路径）。',
        missing: [],
      },
      {
        key: 'flags',
        title: MODULE_TITLES['flags'] ?? '功能开关',
        status: 'ready',
        summary: '功能开关与灰度比例，改动两步确认并留痕。',
        missing: [],
      },
    ]
  }

  /**
   * 解析这次授权最终生效的数据范围。
   *
   * preflight 与 apply **必须走同一个函数**：两步确认的令牌绑的是载荷哈希，
   * 两处各算一遍只要有一处漏掉角色默认值，管理员就会看到"确认的内容与提交的内容不一致"。
   * 默认顺序：请求里显式指定 > 该管理员原有的范围 > 角色的默认范围 > `all`。
   */
  const desiredScope = (
    body: Record<string, unknown>,
    before: AdminRecord | null,
    roleDefault: DataScope | undefined,
  ): DataScope => {
    if (body['scope'] === 'self') return 'self'
    if (body['scope'] === 'all') return 'all'
    return before?.scope ?? roleDefault ?? 'all'
  }

  /** 取当前自定义角色列表。 */
  const customRoles = async (): Promise<readonly RoleRecord[]> => {
    // 角色与授权同样可能被 CLI 改（比如"给第一个人授权"），所以读取前也刷新一次。
    await roles.refresh()
    return (await roles.load()).roles
  }

  /** 取管理员记录。 */
  const adminRecord = async (accountId: string): Promise<AdminRecord | null> => {
    await admins.refresh()
    return (await admins.load()).admins.find(item => item.accountId === accountId) ?? null
  }

  /** 发一个带统一信封的拒绝响应。 */
  const deny = (
    ctx: RouteContext,
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): void => {
    ctx.json(status, { ok: false, code, message, ...extra })
  }

  /**
   * 解析会话（cookie → 内存会话 → 管理员记录 → 角色）。
   *
   * 每一步都可能失败，且失败原因**必须区分**：没登录（401）、不是管理员（403）、
   * 管理员被停用（403）、角色被删（403 但说清是配置问题）。
   */
  const resolveSession = async (
    token: string | null,
  ): Promise<
    | { readonly kind: 'anonymous' }
    | { readonly kind: 'invalid'; readonly reason: string }
    | { readonly kind: 'ok'; readonly session: SessionRecord; readonly admin: AdminRecord; readonly role: RoleRecord }
  > => {
    if (token === null) return { kind: 'anonymous' }
    const session = sessions.get(token)
    // 令牌认不出来（过期、被吊销、服务重启后内存里没有）就是**没登录**，
    // 回 401 请他去登录；回 403「你不是管理员」会把人引到错误的方向。
    if (session === null) return { kind: 'anonymous' }
    const admin = await adminRecord(session.accountId)
    if (admin === null) return { kind: 'invalid', reason: '这个账号已经不是管理台管理员了。' }
    if (!admin.enabled) return { kind: 'invalid', reason: '这个管理员已被停用。' }
    const role = findRole(await customRoles(), admin.roleId)
    if (role === undefined) return { kind: 'invalid', reason: `管理员记录指向的角色「${admin.roleId}」不存在，请联系超级管理员。` }
    // 面判定（两套角色表分离的执行点之一）。
    const grantable = roleGrantable(role)
    if (grantable !== null) return { kind: 'invalid', reason: grantable }
    return { kind: 'ok', session, admin, role }
  }

  /**
   * 定期向上游确认身份仍然有效。
   *
   * 上游明确拒绝（401/停用）→ **立刻吊销**管理台会话；上游不可达 → 保持会话
   * （避免一次网络抖动把正在对账的管理员踢出去），并在 stderr 记一条。
   */
  const refreshIdentity = async (session: SessionRecord): Promise<'ok' | 'unauthorized' | 'skipped'> => {
    if (session.tokens === null) return 'skipped'
    if (now() - session.lastVerifiedAt < verifyIntervalMs) return 'ok'
    const outcome = await upstream.verify(session.tokens)
    session.lastVerifiedAt = now()
    if (outcome.kind === 'ok') return 'ok'
    if (outcome.kind === 'unauthorized') return 'unauthorized'
    process.stderr.write('[admin-console] 上游账号服务不可达，本次跳过身份核验（会话保留）。\n')
    return 'skipped'
  }

  /**
   * 必须走两步确认的写操作：先签发令牌。
   * @returns 令牌与差异；差异为空时仍然签发（幂等写入也需要留痕）。
   */
  const issueConfirm = (ctx: RouteContext, action: string, payload: Record<string, unknown>, diff: unknown): void => {
    const issued = confirms.issue({ actorId: ctx.admin?.accountId ?? '-', action, payload })
    ctx.json(200, {
      ok: true,
      confirm: { token: issued.token, expiresAt: issued.expiresAt, diff },
    })
  }

  /**
   * 消费令牌；失败时已经写好响应。
   * @returns 通过返回 `true`。
   */
  const consumeConfirm = async (
    ctx: RouteContext,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> => {
    const token = asString(ctx.body['token'])
    if (token === null) {
      deny(ctx, 409, 'confirm_required', '这个操作需要先预览再确认（两步确认）。')
      return false
    }
    const outcome = confirms.consume({
      token,
      actorId: ctx.admin?.accountId ?? '-',
      action,
      payload,
    })
    if (!outcome.ok) {
      const message = outcome.code === 'confirm_expired'
        ? '确认已过期（60 秒），请重新预览。'
        : outcome.code === 'confirm_invalid'
          ? '确认令牌无效，请重新预览。'
          : '确认的内容与提交的内容不一致，请重新预览。'
      await recordAudit({
        actorType: 'admin',
        actorId: ctx.admin?.accountId ?? '-',
        actorRole: ctx.role?.id ?? '-',
        ip: ctx.ip,
        addressSource: ctx.addressSource,
        action: `${action}.apply`,
        target: asString(ctx.body['target']) ?? '-',
        result: 'deny',
        reason: outcome.code,
        summary: `两步确认失败（${outcome.code}）`,
      })
      deny(ctx, 409, outcome.code, message)
      return false
    }
    const reason = asString(ctx.body['reason'])
    if (reason === null || reason.trim().length < 4) {
      deny(ctx, 400, 'bad_request', '请填写原因（至少 4 个字）：将来对账的人要知道为什么改。')
      return false
    }
    return true
  }

  /** 路由表。 */
  const routes: Route[] = []

  /**
   * 注册一条路由。
   *
   * **fail-closed 的落点**：`auth: 'permission'` 必须给出权限键，否则直接抛——
   * 一个"忘了写权限"的路由会让整条管理面出现一个无声的缺口，
   * 那种错误必须在启动时就炸掉，而不是等上线后被扫出来。
   */
  const route = (entry: Route): void => {
    if (entry.auth === 'permission' && (entry.permission === undefined || entry.permission.length === 0)) {
      throw new Error(`admin-console: 路由 ${entry.path} 声明了权限校验但没有给权限键`)
    }
    routes.push(entry)
  }

  registerWorkbenchRoutes({ route, upstream: workbench, issueConfirm, consumeConfirm, audit: recordAudit })
  registerApiConnectionsRoutes({ route, upstream: apiConnections, issueConfirm, consumeConfirm, audit: recordAudit, now })
  registerPaymentRoutes({
    route,
    upstream: createPaymentUpstream({
      baseUrl: config.accountBaseUrl,
      ...(config.accountPrefix === undefined ? {} : { prefix: config.accountPrefix }),
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    }),
    issueConfirm,
    consumeConfirm,
    audit: recordAudit,
  })

  registerEnterpriseLeadRoutes({
    route,
    upstream: createEnterpriseLeadsUpstream({
      baseUrl: config.accountBaseUrl,
      ...(config.accountPrefix === undefined ? {} : { prefix: config.accountPrefix }),
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    }),
  })

  registerMarketplaceRoutes({
    route,
    upstream: createMarketplaceUpstream({
      baseUrl: config.accountBaseUrl,
      ...(config.accountPrefix === undefined ? {} : { prefix: config.accountPrefix }),
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    }),
    audit: recordAudit,
  })

  registerCommunityRoutes({ route, store: community, audit: recordAudit })

  // ── 公开路由 ────────────────────────────────────────────────────────────
  route({
    path: '/health',
    auth: 'public',
    mutating: false,
    handler: (ctx) => {
      ctx.json(200, {
        ok: true,
        service: 'qianshou-admin-console',
        version: SERVICE_VERSION,
        uptimeMs: now() - startedAt,
      })
    },
  })

  route({
    path: '/session/login',
    auth: 'public',
    mutating: true,
    handler: async (ctx) => {
      const username = asString(ctx.body['username'])
      const password = asString(ctx.body['password'])
      if (username === null || password === null) {
        deny(ctx, 400, 'bad_request', '请填写账号和密码。')
        return
      }
      const outcome = await upstream.login({ username, password })
      await finishLogin(ctx, outcome)
    },
  })

  route({
    path: '/session/login-totp',
    auth: 'public',
    mutating: true,
    handler: async (ctx) => {
      const challengeToken = asString(ctx.body['challengeToken'])
      const code = asString(ctx.body['code'])
      if (challengeToken === null || code === null) {
        deny(ctx, 400, 'bad_request', '请填写验证码。')
        return
      }
      const outcome = await upstream.loginTotp({
        challengeToken,
        code,
        trustDevice: ctx.body['trustDevice'] === true,
      })
      await finishLogin(ctx, outcome)
    },
  })

  /** 登录结果的统一落点：账号对了还要**是本管理台的管理员**。 */
  async function finishLogin(ctx: RouteContext, outcome: Awaited<ReturnType<AccountUpstream['login']>>): Promise<void> {
    // 限流闸门在最前面：连打 10 次错的就先停一会儿，别把上游也拖下水。
    if (loginThrottled(ctx.ip)) {
      await recordAudit({
        actorType: 'anonymous', actorId: '-', actorRole: '-',
        ip: ctx.ip, addressSource: ctx.addressSource,
        action: 'session.login', target: '-', result: 'deny',
        reason: 'rate_limited', summary: `登录失败次数过多（>${LOGIN_MAX_FAILURES} 次/15 分钟），已暂时拒绝`,
      })
      deny(ctx, 429, 'rate_limited', '登录尝试过于频繁，请稍后再试。')
      return
    }
    if (outcome.kind === 'two-factor') {
      await recordAudit({
        actorType: 'anonymous', actorId: '-', actorRole: '-',
        ip: ctx.ip, addressSource: ctx.addressSource,
        action: 'session.login.two-factor', target: '-', result: 'allow',
        reason: '需要两步验证', summary: '登录进入两步验证',
      })
      ctx.json(200, { ok: true, twoFactor: true, challenge: { challengeToken: outcome.challengeToken } })
      return
    }
    if (outcome.kind !== 'ok') {
      if (outcome.kind === 'invalid') recordLoginFailure(ctx.ip)
      const status = outcome.kind === 'invalid' ? 401 : outcome.kind === 'rate-limited' ? 429 : 502
      const code = outcome.kind === 'invalid' ? 'invalid_credentials' : outcome.kind === 'rate-limited' ? 'rate_limited' : 'upstream_unavailable'
      await recordAudit({
        actorType: 'anonymous', actorId: '-', actorRole: '-',
        ip: ctx.ip, addressSource: ctx.addressSource,
        action: 'session.login', target: '-', result: 'deny',
        reason: code, summary: `登录失败（${code}）`,
      })
      deny(ctx, status, code, outcome.message)
      return
    }

    const admin = await adminRecord(outcome.account.id)
    if (admin === null) {
      // 账号是真的，但没有管理台授权。**必须留痕**：这是一次真实的越权尝试，
      // 也可能是"该给人授权了"的信号。
      await recordAudit({
        actorType: 'anonymous', actorId: outcome.account.id, actorRole: '-',
        ip: ctx.ip, addressSource: ctx.addressSource,
        action: 'session.login', target: `admin:${outcome.account.id}`, result: 'deny',
        reason: 'not_an_admin', summary: '账号密码正确，但该账号没有管理台角色',
      })
      deny(ctx, 403, 'not_an_admin', '这个账号不是 AI 运营管理台的管理员。')
      return
    }
    if (!admin.enabled) {
      await recordAudit({
        actorType: 'admin', actorId: outcome.account.id, actorRole: admin.roleId,
        ip: ctx.ip, addressSource: ctx.addressSource,
        action: 'session.login', target: `admin:${outcome.account.id}`, result: 'deny',
        reason: 'admin_disabled', summary: '管理员已被停用，登录被拒',
      })
      deny(ctx, 403, 'admin_disabled', '这个管理员已被停用。')
      return
    }
    // 登录成功就清掉这个来源的失败记录：真人打错几次之后成功登录，不该继续被计数。
    loginFailures.delete(ctx.ip)
    const token = sessions.issue({
      accountId: outcome.account.id,
      displayName: admin.displayName !== '' ? admin.displayName : outcome.account.displayName,
      createdAt: now(),
      expiresAt: now() + (config.sessionTtlMs ?? 12 * 60 * 60 * 1000),
      ip: ctx.ip,
      tokens: outcome.tokens,
    })
    await recordAudit({
      actorType: 'admin', actorId: outcome.account.id, actorRole: admin.roleId,
      ip: ctx.ip, addressSource: ctx.addressSource,
      action: 'session.login', target: `admin:${outcome.account.id}`, result: 'allow',
      reason: '', summary: '登录成功',
    })
    ctx.json(200, { ok: true, twoFactor: false }, { 'set-cookie': sessionCookie(token, Math.floor((config.sessionTtlMs ?? 12 * 60 * 60 * 1000) / 1000)) })
  }

  // ── 需要登录 ────────────────────────────────────────────────────────────
  route({
    path: '/session/logout',
    auth: 'session',
    mutating: true,
    handler: async (ctx) => {
      if (ctx.sessionToken !== null) sessions.revoke(ctx.sessionToken)
      await recordAudit({
        actorType: 'admin', actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
        ip: ctx.ip, addressSource: ctx.addressSource,
        action: 'session.logout', target: `admin:${ctx.admin?.accountId ?? '-'}`, result: 'allow',
        reason: '', summary: '退出登录',
      })
      ctx.json(200, { ok: true }, { 'set-cookie': clearSessionCookie() })
    },
  })

  route({
    path: '/session/me',
    auth: 'session',
    mutating: false,
    handler: async (ctx) => {
      const role = ctx.role as RoleRecord
      const admin = ctx.admin as AdminRecord
      ctx.json(200, {
        ok: true,
        admin: {
          accountId: admin.accountId,
          displayName: admin.displayName,
          roleId: role.id,
          roleName: role.name,
          roleKind: role.kind,
          scope: ctx.scope,
          surface: role.surface,
        },
        permissions: role.permissions,
        menu: menuFor(role),
        readiness: await readiness(),
        clientIp: ctx.ip,
        addressSource: ctx.addressSource,
      })
    },
  })

  route({
    path: '/modules',
    auth: 'session',
    mutating: false,
    handler: async (ctx) => {
      ctx.json(200, { ok: true, modules: await readiness() })
    },
  })

  // ── 账号与额度（只读 + 依赖未就绪的写操作） ──────────────────────────────
  route({
    path: '/account/list',
    auth: 'permission',
    permission: 'account.read',
    mutating: false,
    handler: async (ctx) => {
      const query = (asString(ctx.body['query']) ?? '').toLowerCase()
      const limit = Math.min(Math.max(Math.floor(asNumber(ctx.body['limit']) ?? 50), 1), 500)
      const offset = Math.max(Math.floor(asNumber(ctx.body['offset']) ?? 0), 0)
      const status = await ledger.status()
      let rows = await ledger.accounts()
      // 数据范围在**服务端**裁剪：`self` 只看到自己那个账号。
      if (ctx.scope === 'self') rows = rows.filter(item => item.accountId === ctx.admin?.accountId)
      if (query.length > 0) rows = rows.filter(item => item.accountId.toLowerCase().includes(query))
      ctx.json(200, {
        ok: true,
        total: rows.length,
        accounts: rows.slice(offset, offset + limit),
        source: status,
      })
    },
  })

  route({
    path: '/account/detail',
    auth: 'permission',
    permission: 'account.read',
    mutating: false,
    handler: async (ctx) => {
      const accountId = asString(ctx.body['accountId'])
      if (accountId === null) {
        deny(ctx, 400, 'bad_request', '请给出 accountId。')
        return
      }
      if (ctx.scope === 'self' && accountId !== ctx.admin?.accountId) {
        await auditDenied(ctx, 'account.read', `account:${accountId}`)
        deny(ctx, 403, 'forbidden', '你的数据范围只允许看自己账号的记录。', { need: 'account.read' })
        return
      }
      const account = await ledger.account(accountId)
      if (account === null) {
        deny(ctx, 404, 'bad_request', '账本里没有这个账号（它可能从未产生过调用）。')
        return
      }
      ctx.json(200, { ok: true, account, source: await ledger.status() })
    },
  })

  route({
    path: '/account/ledger',
    auth: 'permission',
    permission: 'account.ledger.read',
    mutating: false,
    handler: async (ctx) => {
      const accountId = asString(ctx.body['accountId'])
      if (accountId === null) {
        deny(ctx, 400, 'bad_request', '请给出 accountId。')
        return
      }
      if (ctx.scope === 'self' && accountId !== ctx.admin?.accountId) {
        await auditDenied(ctx, 'account.ledger.read', `account:${accountId}`)
        deny(ctx, 403, 'forbidden', '你的数据范围只允许看自己账号的流水。', { need: 'account.ledger.read' })
        return
      }
      const limit = asNumber(ctx.body['limit']) ?? 50
      const offset = asNumber(ctx.body['offset']) ?? 0
      const result = await ledger.calls(accountId, { limit, offset })
      ctx.json(200, { ok: true, total: result.total, entries: result.entries })
    },
  })



  // ── 订阅与档位 ──────────────────────────────────────────────────────────
  route({
    path: '/subscription/list',
    auth: 'permission',
    permission: 'subscription.read',
    mutating: false,
    handler: async (ctx) => {
      const query = (asString(ctx.body['query']) ?? '').toLowerCase()
      const limit = Math.min(Math.max(Math.floor(asNumber(ctx.body['limit']) ?? 50), 1), 500)
      const offset = Math.max(Math.floor(asNumber(ctx.body['offset']) ?? 0), 0)
      let rows = await subscriptions.list()
      if (ctx.scope === 'self') rows = rows.filter(item => item.accountId === ctx.admin?.accountId)
      if (query.length > 0) rows = rows.filter(item => item.accountId.toLowerCase().includes(query))
      ctx.json(200, { ok: true, total: rows.length, entries: rows.slice(offset, offset + limit), source: await subscriptions.status() })
    },
  })

  route({
    path: '/subscription/tiers',
    auth: 'permission',
    permission: 'subscription.read',
    mutating: false,
    handler: async (ctx) => {
      const catalog = await readTierCatalog({ tiersPath: config.tiersPath })
      ctx.json(200, {
        ok: true,
        source: catalog.source,
        available: catalog.available,
        detail: catalog.detail,
        tiers: catalog.tiers,
      })
    },
  })



  const operationalModules = registerOperationalModules({ route, community, workbench, payment: createPaymentUpstream({
    baseUrl: config.accountBaseUrl, ...(config.accountPrefix === undefined ? {} : { prefix: config.accountPrefix }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  }) })

  // ── 四个占位模块（市场 / 发现 / 订单未建；模型路由属主在 7080） ──────────
  for (const [key, permission] of [
    ['market', 'market.read'],
  ] as const) {
    route({
      path: `/${key}/overview`,
      auth: 'permission',
      permission,
      mutating: false,
      handler: (ctx) => {
        const spec = blockedReadiness(key)
        deny(ctx, 503, 'dependency_unavailable', spec.summary, { module: key, missing: spec.missing })
      },
    })
  }

  // ── 权限与角色 ──────────────────────────────────────────────────────────
  route({
    path: '/rbac/permissions',
    auth: 'permission',
    permission: 'rbac.read',
    mutating: false,
    handler: (ctx) => {
      ctx.json(200, { ok: true, groups: permissionGroups() })
    },
  })

  route({
    path: '/rbac/roles/list',
    auth: 'permission',
    permission: 'rbac.read',
    mutating: false,
    handler: async (ctx) => {
      const custom = await customRoles()
      const adminsFile = await admins.load()
      const roles = [...BUILTIN_ROLES, ...custom].map(role => ({
        ...role,
        memberCount: adminsFile.admins.filter(admin => admin.roleId === role.id).length,
      }))
      ctx.json(200, { ok: true, roles })
    },
  })

  route({
    path: '/rbac/roles/preflight',
    auth: 'permission',
    permission: 'rbac.manage',
    mutating: true,
    handler: async (ctx) => {
      const op = asString(ctx.body['op'])
      const id = asString(ctx.body['id'])
      if (op === null) {
        deny(ctx, 400, 'bad_request', 'op 只能是 create / update / delete。')
        return
      }
      const custom = await customRoles()
      const before = id === null ? null : custom.find(role => role.id === id) ?? BUILTIN_ROLES.find(role => role.id === id) ?? null
      if (op !== 'create' && before === null) {
        deny(ctx, 400, 'bad_request', '这个角色不存在。')
        return
      }
      if (before !== null && before.kind === 'builtin') {
        deny(ctx, 400, 'bad_request', `「${before.id}」是内置角色，权限不可改（要不同的权限组合请新建自定义角色）。`)
        return
      }
      const permissions = Array.isArray(ctx.body['permissions'])
        ? ctx.body['permissions'].filter((item): item is string => typeof item === 'string')
        : []
      let after: RoleRecord | null
      if (op === 'delete') {
        after = null
      } else {
        const name = asString(ctx.body['name']) ?? ''
        const scopeDefault: DataScope = ctx.body['scopeDefault'] === 'self' ? 'self' : 'all'
        const candidateId = op === 'create' ? (id ?? '') : id as string
        const invalid = validateRoleInput({ id: candidateId, name, permissions })
        if (invalid !== null) {
          deny(ctx, 400, 'bad_request', invalid)
          return
        }
        after = {
          id: candidateId,
          name,
          kind: 'custom',
          surface: 'ai-admin',
          description: asString(ctx.body['description']) ?? '',
          permissions,
          scopeDefault,
        }
      }
      if (op === 'delete') {
        const members = (await admins.load()).admins.filter(admin => admin.roleId === id)
        if (members.length > 0) {
          deny(ctx, 409, 'version_conflict', `还有 ${members.length} 个管理员在用「${id}」，先把他们换到别的角色。`)
          return
        }
      }
      const payload = { op, id, permissions, name: asString(ctx.body['name']) ?? '', scopeDefault: ctx.body['scopeDefault'] === 'self' ? 'self' : 'all' }
      issueConfirm(ctx, 'rbac.roles', payload, { before, after })
    },
  })

  route({
    path: '/rbac/roles/apply',
    auth: 'permission',
    permission: 'rbac.manage',
    mutating: true,
    handler: async (ctx) => {
      const op = asString(ctx.body['op'])
      const id = asString(ctx.body['id'])
      const permissions = Array.isArray(ctx.body['permissions'])
        ? ctx.body['permissions'].filter((item): item is string => typeof item === 'string')
        : []
      const name = asString(ctx.body['name']) ?? ''
      const scopeDefault: DataScope = ctx.body['scopeDefault'] === 'self' ? 'self' : 'all'
      if (op === null || id === null) {
        deny(ctx, 400, 'bad_request', 'op 与 id 必填。')
        return
      }
      const payload = { op, id, permissions, name, scopeDefault }
      if (!await consumeConfirm(ctx, 'rbac.roles', payload)) return

      const file = await roles.load()
      const before = file.roles.find(role => role.id === id) ?? null
      const next = file.roles.filter(role => role.id !== id)
      const after: RoleRecord | null = op === 'delete'
        ? null
        : {
          id,
          name,
          kind: 'custom',
          surface: 'ai-admin',
          description: asString(ctx.body['description']) ?? '',
          permissions,
          scopeDefault,
        }
      if (after !== null) next.push(after)
      await roles.save({ version: 1, roles: next })
      const entry = await recordAudit({
        actorType: 'admin', actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
        ip: ctx.ip, addressSource: ctx.addressSource,
        action: `rbac.roles.${op}`, target: `role:${id}`, result: 'allow',
        reason: asString(ctx.body['reason']) ?? '',
        summary: op === 'delete' ? `删除角色 ${id}` : `${op === 'create' ? '新建' : '修改'}角色 ${id}（${permissions.length} 个权限）`,
        before, after, diff: computeDiff(before, after),
      })
      ctx.json(200, { ok: true, auditId: entry?.id ?? null, result: { role: after } })
    },
  })

  route({
    path: '/rbac/admins/list',
    auth: 'permission',
    permission: 'rbac.read',
    mutating: false,
    handler: async (ctx) => {
      const file = await admins.load()
      ctx.json(200, { ok: true, admins: file.admins })
    },
  })

  route({
    path: '/rbac/admins/preflight',
    auth: 'permission',
    permission: 'rbac.manage',
    mutating: true,
    handler: async (ctx) => {
      const op = asString(ctx.body['op'])
      const accountId = asString(ctx.body['accountId'])
      if (op === null || accountId === null || !['grant', 'update', 'revoke'].includes(op)) {
        deny(ctx, 400, 'bad_request', 'op 只能是 grant / update / revoke，且要给出 accountId。')
        return
      }
      const file = await admins.load()
      const before = file.admins.find(admin => admin.accountId === accountId) ?? null
      if (op !== 'grant' && before === null) {
        deny(ctx, 400, 'bad_request', '这个账号还不是管理员。')
        return
      }
      if (op === 'grant' && before !== null) {
        deny(ctx, 409, 'version_conflict', '这个账号已经是管理员了，请用 update。')
        return
      }
      const roleId = asString(ctx.body['roleId']) ?? before?.roleId ?? ''
      const role = op === 'revoke' ? undefined : findRole(await customRoles(), roleId)
      if (op !== 'revoke') {
        const problem = roleGrantable(role)
        if (problem !== null) {
          deny(ctx, 400, 'bad_request', problem)
          return
        }
      }
      // 自锁保护：不许用一次 apply 把自己的管理权限收掉（除了 super-admin 自降级——
      // 那是常见操作，但会很危险，所以要求显式确认 scope/role 之后仍然允许，
      // 由下面的"至少留一个可用超级管理员"检查兜底）。
      const scope = desiredScope(ctx.body, before, role?.scopeDefault)
      const displayName = asString(ctx.body['displayName']) ?? before?.displayName ?? accountId
      const after: AdminRecord | null = op === 'revoke'
        ? null
        : { accountId, displayName, roleId, scope, enabled: true, createdAt: before?.createdAt ?? now(), createdBy: before?.createdBy ?? (ctx.admin?.accountId ?? 'unknown') }
      if (op !== 'grant' && before !== null) {
        // 停用/降级最后一个可用的超级管理员 = 把自己锁死，必须先补一个人。
        const superAdmins = file.admins.filter(admin => admin.roleId === 'super-admin' && admin.enabled)
        const losesSuper = before.roleId === 'super-admin' && before.enabled && (op === 'revoke' || roleId !== 'super-admin' || ctx.body['enabled'] === false)
        if (losesSuper && superAdmins.length <= 1) {
          deny(ctx, 409, 'version_conflict', '这是最后一个可用的超级管理员，先授予另一个人再做这个改动。')
          return
        }
      }
      const payload = { op, accountId, roleId, scope, displayName }
      issueConfirm(ctx, 'rbac.admins', payload, { before, after })
    },
  })

  route({
    path: '/rbac/admins/apply',
    auth: 'permission',
    permission: 'rbac.manage',
    mutating: true,
    handler: async (ctx) => {
      const op = asString(ctx.body['op'])
      const accountId = asString(ctx.body['accountId'])
      if (op === null || accountId === null) {
        deny(ctx, 400, 'bad_request', 'op 与 accountId 必填。')
        return
      }
      const file = await admins.load()
      const before = file.admins.find(admin => admin.accountId === accountId) ?? null
      const roleId = asString(ctx.body['roleId']) ?? before?.roleId ?? ''
      const role = op === 'revoke' ? undefined : findRole(await customRoles(), roleId)
      const problem = op === 'revoke' ? null : roleGrantable(role)
      if (problem !== null) {
        deny(ctx, 400, 'bad_request', problem)
        return
      }
      const scope = desiredScope(ctx.body, before, role?.scopeDefault)
      const displayName = asString(ctx.body['displayName']) ?? before?.displayName ?? accountId
      const payload = { op, accountId, roleId, scope, displayName }
      if (!await consumeConfirm(ctx, 'rbac.admins', payload)) return

      const next = file.admins.filter(admin => admin.accountId !== accountId)
      const after: AdminRecord | null = op === 'revoke'
        ? null
        : {
          accountId,
          displayName,
          roleId,
          scope,
          enabled: true,
          createdAt: before?.createdAt ?? now(),
          createdBy: before?.createdBy ?? (ctx.admin?.accountId ?? 'unknown'),
        }
      if (after !== null) next.push(after)
      await admins.save({ version: 1, admins: next })
      // 授权变了就必须让旧会话立刻失效：否则"刚被撤销的管理员"还能继续用 12 小时。
      const revoked = sessions.revokeByAccount(accountId)
      const entry = await recordAudit({
        actorType: 'admin', actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
        ip: ctx.ip, addressSource: ctx.addressSource,
        action: `rbac.admins.${op}`, target: `admin:${accountId}`, result: 'allow',
        reason: asString(ctx.body['reason']) ?? '',
        summary: op === 'revoke' ? `撤销管理员 ${accountId}` : `${op === 'grant' ? '授予' : '调整'}管理员 ${accountId} → ${roleId}（${scope}）`,
        before, after, diff: computeDiff(before, after),
      })
      ctx.json(200, { ok: true, auditId: entry?.id ?? null, result: { admin: after, revokedSessions: revoked } })
    },
  })

  // ── 审计 ────────────────────────────────────────────────────────────────
  route({
    path: '/audit/list',
    auth: 'permission',
    permission: 'audit.read',
    mutating: false,
    handler: async (ctx) => {
      const result = await audit.query({
        ...(asNumber(ctx.body['from']) === null ? {} : { from: asNumber(ctx.body['from']) as number }),
        ...(asNumber(ctx.body['to']) === null ? {} : { to: asNumber(ctx.body['to']) as number }),
        ...(asString(ctx.body['actorId']) === null ? {} : { actorId: asString(ctx.body['actorId']) as string }),
        ...(asString(ctx.body['actionPrefix']) === null ? {} : { actionPrefix: asString(ctx.body['actionPrefix']) as string }),
        ...(asString(ctx.body['target']) === null ? {} : { target: asString(ctx.body['target']) as string }),
        ...(asString(ctx.body['result']) === null ? {} : { result: asString(ctx.body['result']) as 'allow' | 'deny' | 'error' }),
        limit: asNumber(ctx.body['limit']) ?? 50,
        offset: asNumber(ctx.body['offset']) ?? 0,
        scope: ctx.scope,
        selfId: ctx.admin?.accountId ?? '',
      })
      ctx.json(200, { ok: true, ...result })
    },
  })

  route({
    path: '/audit/detail',
    auth: 'permission',
    permission: 'audit.read',
    mutating: false,
    handler: async (ctx) => {
      const id = asString(ctx.body['id'])
      if (id === null) {
        deny(ctx, 400, 'bad_request', '请给出审计 id。')
        return
      }
      const entry = await audit.detail(id)
      if (entry === null) {
        deny(ctx, 404, 'bad_request', '没有这条审计记录。')
        return
      }
      if (ctx.scope === 'self' && entry.actorId !== ctx.admin?.accountId) {
        await auditDenied(ctx, 'audit.read', `audit:${id}`)
        deny(ctx, 403, 'forbidden', '你的数据范围只允许看自己经办的记录。', { need: 'audit.read' })
        return
      }
      ctx.json(200, { ok: true, entry })
    },
  })

  // ── 白名单 ──────────────────────────────────────────────────────────────
  route({
    path: '/whitelist/status',
    auth: 'permission',
    permission: 'whitelist.read',
    mutating: false,
    handler: async (ctx) => {
      const file = await whitelist.load()
      ctx.json(200, {
        ok: true,
        enabled: file.enabled,
        clientIp: ctx.ip,
        addressSource: ctx.addressSource,
        entries: file.entries,
        escapeHatch: {
          loopbackAlwaysAllowed: true,
          cliHint: 'ssh root@<广州服务器> "node <仓库>/packages/host/admin-console/src/main.ts whitelist add <你的IP>/32"',
          note: '白名单为空时，只有本机回环可访问；在服务器上用 CLI 或 curl 127.0.0.1 可以把自己加回来。',
        },
      })
    },
  })

  route({
    path: '/whitelist/entries/preflight',
    auth: 'permission',
    permission: 'whitelist.manage',
    mutating: true,
    handler: async (ctx) => {
      const op = asString(ctx.body['op'])
      const cidr = asString(ctx.body['cidr'])
      if (op === null || cidr === null || !['add', 'remove'].includes(op)) {
        deny(ctx, 400, 'bad_request', 'op 只能是 add / remove，且要给出 cidr。')
        return
      }
      if (!isValidRule(cidr)) {
        deny(ctx, 400, 'bad_request', `不是合法的 IP 或 CIDR：${cidr}。`)
        return
      }
      const file = await whitelist.load()
      const before = { enabled: file.enabled, entries: file.entries }
      const entries = op === 'add'
        ? (file.entries.some(entry => entry.cidr === cidr)
          ? file.entries
          : [...file.entries, { cidr, note: asString(ctx.body['note']) ?? '', addedBy: ctx.admin?.accountId ?? '-', addedAt: now() }])
        : file.entries.filter(entry => entry.cidr !== cidr)
      // 自锁保护：删掉"正在生效的那条"会立刻把自己关在门外。只有在回环
      // （逃生路径）或规则并不匹配自己时才允许。
      if (op === 'remove' && file.entries.some(entry => entry.cidr === cidr)) {
        const decision = decideWhitelist(ctx.ip, { enabled: file.enabled, entries: [{ cidr, note: '', addedBy: '', addedAt: 0 }] })
        if (decision.allowed && ctx.ip.split('/')[0] !== '127.0.0.1' && ctx.addressSource !== 'socket') {
          deny(ctx, 409, 'version_conflict', `这条规则正在放行你自己（${ctx.ip}）。删掉它会立刻把你锁在外面；要删请先在服务器上从回环地址操作。`)
          return
        }
      }
      issueConfirm(ctx, 'whitelist.entries', { op, cidr }, { before, after: { enabled: file.enabled, entries } })
    },
  })

  route({
    path: '/whitelist/entries/apply',
    auth: 'permission',
    permission: 'whitelist.manage',
    mutating: true,
    handler: async (ctx) => {
      const op = asString(ctx.body['op'])
      const cidr = asString(ctx.body['cidr'])
      if (op === null || cidr === null) {
        deny(ctx, 400, 'bad_request', 'op 与 cidr 必填。')
        return
      }
      const payload = { op, cidr }
      if (!await consumeConfirm(ctx, 'whitelist.entries', payload)) return
      const file = await whitelist.load()
      const before = { enabled: file.enabled, entries: file.entries }
      const entries = op === 'remove'
        ? file.entries.filter(entry => entry.cidr !== cidr)
        : (file.entries.some(entry => entry.cidr === cidr)
          ? file.entries
          : [...file.entries, { cidr, note: asString(ctx.body['note']) ?? '', addedBy: ctx.admin?.accountId ?? '-', addedAt: now() }])
      await whitelist.save({ version: 1, enabled: file.enabled, entries })
      const after = { enabled: file.enabled, entries }
      const entry = await recordAudit({
        actorType: 'admin', actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
        ip: ctx.ip, addressSource: ctx.addressSource,
        action: `whitelist.entries.${op}`, target: `whitelist:${cidr}`, result: 'allow',
        reason: asString(ctx.body['reason']) ?? '',
        summary: op === 'add' ? `加入白名单 ${cidr}` : `移出白名单 ${cidr}`,
        before, after, diff: computeDiff(before, after),
      })
      ctx.json(200, { ok: true, auditId: entry?.id ?? null, result: { entries } })
    },
  })

  // ── 功能开关 ────────────────────────────────────────────────────────────
  route({
    path: '/flags/list',
    auth: 'permission',
    permission: 'flags.read',
    mutating: false,
    handler: async (ctx) => {
      ctx.json(200, { ok: true, flags: (await flags.refresh()).flags })
    },
  })

  route({
    path: '/flags/preflight',
    auth: 'permission',
    permission: 'flags.manage',
    mutating: true,
    handler: async (ctx) => {
      const key = asString(ctx.body['key'])
      if (key === null || !/^[a-z][a-z0-9._-]{1,60}$/.test(key)) {
        deny(ctx, 400, 'bad_request', '开关 key 只能是小写字母开头、含字母数字与 . _ -（2–61 字符）。')
        return
      }
      const file = await flags.load()
      const before = file.flags.find(flag => flag.key === key) ?? null
      const rolloutRaw = asNumber(ctx.body['rolloutPercent'])
      if (rolloutRaw !== null && (rolloutRaw < 0 || rolloutRaw > 100)) {
        deny(ctx, 400, 'bad_request', '灰度比例必须在 0–100 之间。')
        return
      }
      const after: FlagRecord = {
        key,
        title: asString(ctx.body['title']) ?? before?.title ?? key,
        enabled: ctx.body['enabled'] === undefined ? (before?.enabled ?? false) : ctx.body['enabled'] === true,
        rolloutPercent: rolloutRaw === null ? (before?.rolloutPercent ?? 100) : Math.round(rolloutRaw),
        description: asString(ctx.body['description']) ?? before?.description ?? '',
        updatedAt: now(),
        updatedBy: ctx.admin?.accountId ?? '-',
        version: (before?.version ?? 0) + 1,
      }
      issueConfirm(ctx, 'flags', { key, enabled: after.enabled, rolloutPercent: after.rolloutPercent, title: after.title, description: after.description }, { before, after })
    },
  })

  route({
    path: '/flags/apply',
    auth: 'permission',
    permission: 'flags.manage',
    mutating: true,
    handler: async (ctx) => {
      const key = asString(ctx.body['key'])
      if (key === null) {
        deny(ctx, 400, 'bad_request', 'key 必填。')
        return
      }
      const file = await flags.load()
      const before = file.flags.find(flag => flag.key === key) ?? null
      const rolloutRaw = asNumber(ctx.body['rolloutPercent'])
      const after: FlagRecord = {
        key,
        title: asString(ctx.body['title']) ?? before?.title ?? key,
        enabled: ctx.body['enabled'] === undefined ? (before?.enabled ?? false) : ctx.body['enabled'] === true,
        rolloutPercent: rolloutRaw === null ? (before?.rolloutPercent ?? 100) : Math.round(rolloutRaw),
        description: asString(ctx.body['description']) ?? before?.description ?? '',
        updatedAt: now(),
        updatedBy: ctx.admin?.accountId ?? '-',
        version: (before?.version ?? 0) + 1,
      }
      const payload = {
        key,
        enabled: after.enabled,
        rolloutPercent: after.rolloutPercent,
        title: after.title,
        description: after.description,
      }
      if (!await consumeConfirm(ctx, 'flags', payload)) return
      const next = file.flags.filter(flag => flag.key !== key)
      next.push(after)
      await flags.save({ version: 1, flags: next })
      const entry = await recordAudit({
        actorType: 'admin', actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
        ip: ctx.ip, addressSource: ctx.addressSource,
        action: 'flags.apply', target: `flag:${key}`, result: 'allow',
        reason: asString(ctx.body['reason']) ?? '',
        summary: `开关 ${key} → ${after.enabled ? '开' : '关'}（灰度 ${after.rolloutPercent}%）`,
        before, after, diff: computeDiff(before, after),
      })
      ctx.json(200, { ok: true, auditId: entry?.id ?? null, result: { flag: after } })
    },
  })

  // ── 上游密钥 ────────────────────────────────────────────────────────────
  /**
   * 密钥管理是**受控**的：改这一件事比改白名单还危险 —— 白名单改错锁的是自己，
   * 密钥改错挂的是所有用户的对话。
   *
   * 所以这条线上有三道，缺一不可：
   *   1. 权限键 `credential.manage`（RBAC，能授权给角色）；
   *   2. **角色硬判定**：必须是 `super-admin`（见 `requireSuperAdmin`）；
   *   3. 两步确认 + 写入前真实连通性测试。
   */
  const credentialTargetOf = (ref: string): { restartRequired: boolean; restartService: string | null } => {
    // 走 `probeTargetFor` 而不是直接查表：号池的 ref 是**按账号派生的动态名字**，
    // 只有前缀兜底能找到它的目标。这样"改完要不要重启"这件事只有一个出处。
    const target = probeTargetFor(ref)
    return {
      restartRequired: target?.restartRequired ?? false,
      restartService: target?.restartService ?? null,
    }
  }

  /**
   * 组装"看得见但不泄漏"的密钥视图。
   *
   * 唯一允许出现在响应里的字段是：键名、是否已配置、**指纹**、更新时间、更新人。
   * 值本身在函数体内出现一次（算指纹），随后立刻离开作用域 ——
   * 这个函数是唯一读值的地方，也是唯一能泄漏的地方，所以它刻意做得很小。
   */
  const keyViews = async (): Promise<readonly Record<string, unknown>[]> => {
    /**
     * 文档读不懂时**不抛**，而是返回一个带 `documentError` 的空视图。
     *
     * 为什么：把"文件坏了"做成 500 是最没用的反应 —— 管理员看不到任何上下文，
     * 也不知道该修什么。而没有这个兜底时，"列表"与"预览"会一起炸，
     * 恰恰在**最需要看见状态**的时候把界面变成一片红。
     * 注意：这里只是**降级展示**；写入路径仍然会因为文档不合格而拒绝（见 `writeKey`）。
     */
    let entries: ReadonlyMap<string, string>
    try {
      entries = await upstreamKeys.readEntries()
    } catch (error) {
      const detail = error instanceof CredentialsDocumentError
        ? { code: error.code, message: error.message }
        : { code: 'unreadable', message: error instanceof Error ? error.message : String(error) }
      return [{
        ref: '(凭据文件读不懂)',
        configured: false,
        fingerprint: null,
        updatedAt: null,
        updatedBy: null,
        previousFingerprint: null,
        shadowedByEnvironment: false,
        restartRequired: false,
        restartService: null,
        restartCommand: null,
        documentError: detail,
      }]
    }
    const meta = await keyMetadata.load()
    const file = await upstreamKeys.statFile()
    const refs = [...new Set([...entries.keys(), ...Object.keys(meta)])].sort()
    return refs.map((ref) => {
      const value = entries.get(ref)
      const record = meta[ref]
      const { restartRequired, restartService } = credentialTargetOf(ref)
      return {
        ref,
        configured: value !== undefined,
        // 指纹只从**当前值**算。键被删掉之后不能再报旧指纹——那会让人以为它还在。
        fingerprint: value === undefined ? null : fingerprintOf(value),
        updatedAt: record?.updatedAt ?? (value === undefined ? null : file.mtimeMs),
        updatedBy: record?.updatedBy ?? null,
        previousFingerprint: record?.previousFingerprint ?? null,
        shadowedByEnvironment: shadowedByEnvironment(ref),
        restartRequired,
        restartService,
        restartCommand: restartRequired && restartService !== null ? `systemctl restart ${restartService}` : null,
      }
    })
  }

  /** 取某个引用的当前视图；文档读不懂时返回 `null`（预览要能照常给出差异）。 */
  const keyViewOf = async (ref: string): Promise<Record<string, unknown> | null> => {
    try {
      return (await keyViews()).find(view => view['ref'] === ref) ?? null
    } catch {
      return null
    }
  }

  /**
   * 改密钥的**角色硬判定**。
   *
   * 为什么权限键之外还要这一道：权限键是可以被授权给自定义角色的，而"换上游密钥"
   * 是**能影响全部用户**的动作，权限体系里加一个勾选就能扩散出去，太轻了。
   * 需求原文是"只有 super-admin 可改"，那就把它**写死在接口层**：
   * 不认角色表以外的东西，也不给前端留"按钮藏起来就算拦住"的余地。
   *
   * 号池走**同一个**判定（`requireSuperAdminFor`）：加一个号就是往全部用户可能用到的
   * 池子里放凭据，危险等级与换密钥同级。
   * @param ctx - 请求上下文。
   * @param target - 审计里的目标（形如 `credential:DEEPSEEK_API_KEY`）。
   * @returns 通过返回 `true`；否则已写好响应与审计。
   */
  const requireSuperAdmin = async (ctx: RouteContext, target: string): Promise<boolean> =>
    await requireSuperAdminFor(ctx, 'credential.apply', target, '上游密钥')

  /**
   * 角色硬判定 + 越权留痕（动作名可变）。
   * @param ctx - 请求上下文。
   * @param action - 审计里的动作名（写 `result: "deny"` 的那一条）。
   * @param target - 审计里的目标。
   * @param what - 给管理员看的东西名字。
   * @returns 通过返回 `true`；否则已写好响应与审计。
   */
  const requireSuperAdminFor = async (
    ctx: RouteContext,
    action: string,
    target: string,
    what: string,
  ): Promise<boolean> => {
    if (ctx.role?.id === 'super-admin') return true
    await recordAudit({
      actorType: 'admin', actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
      ip: ctx.ip, addressSource: ctx.addressSource,
      action, target, result: 'deny',
      reason: 'not_super_admin',
      summary: `越权尝试：${what}只有 super-admin 可改（当前角色 ${ctx.role?.id ?? '-'}）`,
    })
    deny(ctx, 403, 'forbidden', `${what}只有 super-admin 可以修改。`, { need: 'super-admin' })
    return false
  }

  route({
    path: '/credential/list',
    auth: 'permission',
    permission: 'credential.read',
    mutating: false,
    handler: async (ctx) => {
      const file = await upstreamKeys.statFile()
      const { restartRequired, restartService } = credentialTargetOf('DEEPSEEK_API_KEY')
      ctx.json(200, {
        ok: true,
        // 值永不回显：这里只给"存在与否 + 指纹 + 谁何时改的"。
        credentialsPath: upstreamKeys.credentialsPath,
        fileExists: file.exists,
        fileMode: file.mode === null ? null : `0${file.mode.toString(8)}`,
        keys: await keyViews(),
        // 生效机制如实暴露：文件层会热加载，但网关的成功值缓存不会失效。
        activation: {
          fileWatcher: '工作台的凭据插件监听该文件，改动会被自动加载。',
          gatewayCache: '模型网关对已解析成功的密钥**永久缓存**，进程内不会重读。',
          restartRequired,
          restartService,
          restartCommand: restartRequired && restartService !== null ? `systemctl restart ${restartService}` : null,
          note: restartRequired
            ? '改完必须重启工作台才生效。管理台不会代为重启（重启会断开全部在线会话），请由运维执行上面这条命令。'
            : '改完由工作台自行加载。',
        },
        backups: { dir: upstreamKeys.backupDir },
      })
    },
  })

  route({
    path: '/credential/preflight',
    auth: 'permission',
    permission: 'credential.manage',
    mutating: true,
    handler: async (ctx) => {
      if (!await requireSuperAdmin(ctx, 'credential:DEEPSEEK_API_KEY')) return
      const ref = asString(ctx.body['ref'])
      const value = asString(ctx.body['value'])
      if (ref === null || value === null) {
        deny(ctx, 400, 'bad_request', 'ref 与 value 必填。')
        return
      }
      const { restartRequired, restartService } = credentialTargetOf(ref)
      const before = await keyViewOf(ref)
      // 预览阶段就把连通性测出来：让管理员在**按下确认之前**知道这把密钥能不能用。
      // 真正的强制点是 apply（预览可以被绕过），这里只是省一次往返。
      const probe = await probeUpstreamKey(ref, value, config.probe ?? {})
      issueConfirm(ctx, 'credential', { ref, value }, {
        ref,
        before,
        after: {
          ref,
          configured: true,
          fingerprint: fingerprintOf(value),
          restartRequired,
        },
        // 值本身**绝不进差异**；差异里只出现指纹与状态。
        probe: probe.ok
          ? { ok: true, latencyMs: probe.latencyMs, model: probe.model }
          : { ok: false, kind: probe.kind, message: probe.message, status: probe.status },
        restartCommand: restartRequired && restartService !== null ? `systemctl restart ${restartService}` : null,
      })
    },
  })

  route({
    path: '/credential/apply',
    auth: 'permission',
    permission: 'credential.manage',
    mutating: true,
    handler: async (ctx) => {
      if (!await requireSuperAdmin(ctx, 'credential:DEEPSEEK_API_KEY')) return
      const ref = asString(ctx.body['ref'])
      const value = asString(ctx.body['value'])
      if (ref === null || value === null) {
        deny(ctx, 400, 'bad_request', 'ref 与 value 必填。')
        return
      }
      if (!await consumeConfirm(ctx, 'credential', { ref, value })) return

      const target = credentialTargetOf(ref)
      const auditBase = {
        actorType: 'admin' as const,
        actorId: ctx.admin?.accountId ?? '-',
        actorRole: ctx.role?.id ?? '-',
        ip: ctx.ip,
        addressSource: ctx.addressSource,
      }

      // 第 1 道：写入前**真打一次上游**。失败绝不写入 —— 这是"防手滑把网关弄挂"的
      // 关键一环，也是这条链路上唯一能证明"这把密钥真的能用"的证据。
      const probe = await probeUpstreamKey(ref, value, config.probe ?? {})
      if (!probe.ok) {
        const entry = await recordAudit({
          ...auditBase,
          action: 'credential.apply', target: `credential:${ref}`, result: 'deny',
          reason: probe.kind,
          // 只写"哪一类失败"。探测返回的 message 已经把原因说清楚了，
          // 而它**来自上游响应**，不是我们发出去的密钥。
          summary: `连通性测试未通过，拒绝写入：${probe.kind}`,
        })
        ctx.json(probe.kind === 'credential_rejected' ? 400 : 502, {
          ok: false,
          code: probe.kind === 'credential_rejected'
            ? 'credential_rejected'
            : probe.kind === 'probe_not_configured'
              ? 'probe_not_configured'
              : 'upstream_unavailable',
          message: `未写入：${probe.message}`,
          probeKind: probe.kind,
          probeStatus: probe.status,
          auditId: entry?.id ?? null,
          written: false,
        })
        return
      }

      // 第 2 道：备份 → 加锁 → 原子替换 → 校验；失败回滚。
      let written: { readonly fingerprint: string; readonly previousFingerprint: string | null; readonly backupPath: string | null; readonly updatedAt: number }
      try {
        written = await upstreamKeys.writeKey(ref, value)
      } catch (error) {
        const problem = error instanceof CredentialsDocumentError
          ? { code: error.code, message: error.message }
          : { code: 'write_failed', message: error instanceof Error ? error.message : String(error) }
        const entry = await recordAudit({
          ...auditBase,
          action: 'credential.apply', target: `credential:${ref}`, result: 'error',
          reason: problem.code,
          summary: `写入失败（${problem.code}），已回滚：${problem.message}`,
        })
        ctx.json(problem.code === 'bad_ref' || problem.code === 'bad_value' ? 400 : 500, {
          ok: false,
          code: problem.code,
          message: `未写入：${problem.message}`,
          auditId: entry?.id ?? null,
          written: false,
        })
        return
      }

      const updatedBy = ctx.admin?.accountId ?? '-'
      await keyMetadata.record(ref, {
        fingerprint: written.fingerprint,
        updatedAt: written.updatedAt,
        updatedBy,
        previousFingerprint: written.previousFingerprint,
      })

      // 第 3 道：审计只留**指纹**，绝不留明文。before → after 也是指纹级。
      const entry = await recordAudit({
        ...auditBase,
        action: 'credential.apply', target: `credential:${ref}`, result: 'allow',
        reason: asString(ctx.body['reason']) ?? '',
        summary: `更换上游密钥 ${ref}：指纹 ${written.previousFingerprint ?? '（原先未配置）'} → ${written.fingerprint}`
          + (target.restartRequired ? '（需重启工作台才生效）' : ''),
        before: { ref, fingerprint: written.previousFingerprint },
        after: { ref, fingerprint: written.fingerprint },
      })

      ctx.json(200, {
        ok: true,
        auditId: entry?.id ?? null,
        result: {
          ref,
          fingerprint: written.fingerprint,
          previousFingerprint: written.previousFingerprint,
          // 指纹只是"改没改"的凭据；往返延迟给个诚实区间，不假装是 SLA。
          propagatedByFileWatcher: true,
          restartRequired: target.restartRequired,
          restartService: target.restartService,
          restartCommand: target.restartRequired && target.restartService !== null
            ? `systemctl restart ${target.restartService}`
            : null,
          backupPath: written.backupPath,
          updatedAt: written.updatedAt,
          updatedBy,
        },
      })
    },
  })

  // ── 上游号池 ────────────────────────────────────────────────────────────
  /**
   * 号池：运营在后台贴一枚 Cursor 凭据就能往池子里加一个号（不用 SSH、不用敲命令）。
   *
   * 与 §8.7 **同构**，因为危险等级相同：同一个权限键 + 同一个 super-admin 硬判定、
   * 同一套两步确认（令牌绑"同一个人 + 同一个动作 + 同一份载荷"）、同一条写入协议
   * （直接复用 `writeKey`）、同一张探测失败四类表、同一条"值永不回显"。
   *
   * 唯一多出来的一步是**归一化**：会话凭据（会过期）先换成不过期的 `crsr_…` 长期 key
   * 再落盘 —— 否则号池会埋一个"过几天全线 401"的雷（见 `cursor-credential.ts`）。
   */

  /**
   * 读运营贴进来的凭据。
   *
   * 先 trim 再处理：粘贴带上的首尾空白是剪贴板噪声；**预览与提交用同一个函数**，
   * 所以载荷哈希在两步之间必然一致（否则会误报 `confirm_mismatch`）。
   */
  const credentialInputOf = (body: Record<string, unknown>): string | null => {
    const raw = body['credential']
    return typeof raw === 'string' ? raw.trim() : null
  }

  /**
   * 写前探测没通过 → 拒绝写入，分类照 §8.7 的四类表。
   *
   * 分类不同则建议不同：401/403 是凭据的确定性结论；429 与 5xx 是"无法确认"，
   * 说成"凭据无效"会让管理员去换一枚本来没问题的凭据。
   */
  const denyPoolProbe = async (
    ctx: RouteContext,
    action: string,
    target: string,
    failure: { readonly kind: ProbeFailureKind; readonly message: string; readonly status: number | null },
  ): Promise<void> => {
    const entry = await recordAudit({
      actorType: 'admin', actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
      ip: ctx.ip, addressSource: ctx.addressSource,
      action, target, result: 'deny',
      reason: failure.kind,
      summary: `写前探测未通过，拒绝写入号池：${failure.kind}`,
    })
    ctx.json(failure.kind === 'credential_rejected' ? 400 : 502, {
      ok: false,
      code: failure.kind === 'credential_rejected'
        ? 'credential_rejected'
        : failure.kind === 'probe_not_configured'
          ? 'probe_not_configured'
          : 'upstream_unavailable',
      message: `未写入：${failure.message}`,
      probeKind: failure.kind,
      probeStatus: failure.status,
      auditId: entry?.id ?? null,
      written: false,
    })
  }

  /** 把一次号池准备失败翻成响应。 */
  const denyPoolPreparation = async (
    ctx: RouteContext,
    action: string,
    target: string,
    prepared: Extract<PoolPreparation, { ok: false }>,
  ): Promise<void> => {
    if (prepared.code === 'invalid_input') {
      // 每个失败响应都带 `written: false`：管理员第一个问题永远是"号到底进没进池"。
      deny(ctx, 400, 'bad_request', prepared.message, { written: false })
      return
    }
    if (prepared.code === 'credentials_unreadable') {
      await recordAudit({
        actorType: 'admin', actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
        ip: ctx.ip, addressSource: ctx.addressSource,
        action, target, result: 'error',
        reason: 'credentials_unreadable',
        summary: `凭据文件读不懂，号池操作已拒绝：${prepared.message}`,
      })
      deny(ctx, 500, 'bad_request', prepared.message, { written: false })
      return
    }
    // 连身份都没拿到（输入凭据被上游拒了/上游不可达）：分类照四类表。
    await denyPoolProbe(ctx, action, target, prepared)
  }

  route({
    path: '/pool/list',
    auth: 'permission',
    permission: 'credential.read',
    mutating: false,
    handler: async (ctx) => {
      const listing = await pool.list()
      ctx.json(200, {
        ok: true,
        // 值永不回显：列表里只有 ref/标签/状态/指纹/验活时间/身份。
        keys: listing.keys,
        // 凭据文件读不懂时**降级展示**（和 §8.7 的列表同一个取舍）：让管理员看得见状态，
        // 而不是收到一个什么都不说的 500。写入路径仍然会因此拒绝。
        fileError: listing.fileError,
        activation: {
          fileWatcher: '工作台的凭据插件监听该文件，改动会被自动加载。',
          consumer: '模型网关的号池路由（尚未接入）',
          restartRequired: CURSOR_POOL_PROBE_TARGET.restartRequired,
          restartService: CURSOR_POOL_PROBE_TARGET.restartService ?? null,
          restartCommand: CURSOR_POOL_PROBE_TARGET.restartRequired && CURSOR_POOL_PROBE_TARGET.restartService !== undefined
            ? `systemctl restart ${CURSOR_POOL_PROBE_TARGET.restartService}`
            : null,
          note: '号池的号就是凭据文件 `refs:` 段里的一个 ref；管理台负责让它进池并留下记录，'
            + '"把号用起来"是消费方（模型网关）的事 —— 那条路由还没建，所以这里不声称已经生效。',
        },
        metadataPath: pool.metadataPath,
      })
    },
  })

  route({
    path: '/pool/preflight',
    auth: 'permission',
    permission: 'credential.manage',
    mutating: true,
    handler: async (ctx) => {
      const op = asString(ctx.body['op']) ?? 'add'
      if (op !== 'add' && op !== 'remove') {
        deny(ctx, 400, 'bad_request', 'op 只能是 add / remove。')
        return
      }

      // 删除的预览：确认令牌必须绑住**确切的 ref**，所以移除也有自己的预览分支
      // （令牌是一次性、绑动作的：add 的令牌换不出 remove 的执行）。
      if (op === 'remove') {
        const ref = asString(ctx.body['ref'])
        if (ref === null) {
          deny(ctx, 400, 'bad_request', 'ref 必填。')
          return
        }
        if (!isCursorPoolRef(ref)) {
          deny(ctx, 400, 'bad_request', '这不是号池里的号：号池 ref 形如 `CURSOR_CK_xxxxxxxx`（其余引用不属于号池，不能从这里删）。')
          return
        }
        if (!await requireSuperAdminFor(ctx, 'pool.remove.apply', `pool:${ref}`, '上游号池')) return
        const current = await pool.snapshot()
        if (!current.ok) {
          deny(ctx, 500, 'bad_request', `凭据文件读不懂，为免写坏它已拒绝操作：${current.problem.message}`)
          return
        }
        const existing = current.entries.find(entry => entry.ref === ref)
        if (existing === undefined || existing.value === null) {
          deny(ctx, 404, 'bad_request', `号池里没有「${ref}」。`)
          return
        }
        issueConfirm(ctx, 'pool.remove', { op: 'remove', ref }, {
          ref,
          action: 'remove',
          before: { ref, label: existing.label, fingerprint: existing.fingerprint, authId: existing.authId, email: existing.email },
          after: null,
          // 删除不需要探测：没有新凭据要验。探测结论在这里是"不适用"，而不是"通过"。
          probe: null,
        })
        return
      }

      // 新增的预览：先做**真实探测**，再把差异给管理员看。
      const credential = credentialInputOf(ctx.body)
      if (credential === null) {
        deny(ctx, 400, 'bad_request', '请把 Cursor 凭据贴进 credential 字段。')
        return
      }
      const label = asString(ctx.body['label']) ?? ''
      if (!await requireSuperAdminFor(ctx, 'pool.add.apply', 'pool:add', '上游号池')) return

      // 预览**只验活 + 取身份，不铸新 key**：预览不能有持久副作用，也不能给出一个
      // 写入时会被换掉的"落盘指纹"（那正是两步确认要防的"预览看到 A、执行的是 B"）。
      const prepared = await pool.prepare({ credential, label, mode: 'preview' })
      if (!prepared.ok) {
        await denyPoolPreparation(ctx, 'pool.add.apply', 'pool:add', prepared)
        return
      }
      issueConfirm(ctx, 'pool.add', { op: 'add', credential, label }, {
        ref: prepared.candidate.ref,
        action: prepared.plan.action,
        identity: { authId: prepared.identity.authId, email: prepared.identity.email },
        // 指纹只从**将要落盘的那把值**算；会话形态在预览阶段还没有那把值，
        // 所以这里是 `null` 而不是"贴进来那一串的指纹" —— 后者会与写入结果对不上，
        // 让人以为凭据被换了。
        fingerprint: prepared.candidate.value === null ? null : fingerprintOf(prepared.candidate.value),
        fingerprintSubject: prepared.valueKnown ? 'stored-value' : null,
        valueKnown: prepared.valueKnown,
        shape: prepared.shape,
        existingRef: prepared.plan.existingRef,
        duplicateBasis: prepared.plan.basis,
        previousFingerprint: prepared.plan.previousFingerprint,
        probe: prepared.probe,
        note: prepared.valueKnown
          ? '贴进来的已经是归一化后的长期 key，落盘的就是它本身；指纹就是它的指纹。'
          : '这是会话凭据：写入时会先归一化成一把新的长期 key（`crsr_…`）再落盘，'
            + '所以预览里没有落盘指纹（`fingerprint: null`）—— 能确定的是这个号的身份与 ref。',
      })
    },
  })

  route({
    path: '/pool/apply',
    auth: 'permission',
    permission: 'credential.manage',
    mutating: true,
    handler: async (ctx) => {
      const action = 'pool.add.apply'
      const credential = credentialInputOf(ctx.body)
      if (credential === null) {
        deny(ctx, 400, 'bad_request', '请把 Cursor 凭据贴进 credential 字段。')
        return
      }
      const label = asString(ctx.body['label']) ?? ''
      if (!await requireSuperAdminFor(ctx, action, 'pool:add', '上游号池')) return
      // 令牌绑"同一个人 + 同一个动作 + 同一份载荷"：预览看到的凭据与这里提交的必须是同一份。
      if (!await consumeConfirm(ctx, 'pool.add', { op: 'add', credential, label })) return

      const auditBase = {
        actorType: 'admin' as const,
        actorId: ctx.admin?.accountId ?? '-',
        actorRole: ctx.role?.id ?? '-',
        ip: ctx.ip,
        addressSource: ctx.addressSource,
      }

      // 再准备一次（**不信任预览时算出来的任何东西**）：形态 → 剥包装 → 验活 → 归一化
      // → 判重 → 对将要落盘的那把值再探测一次。探测失败一律不写盘。
      const prepared = await pool.prepare({ credential, label, mode: 'commit' })
      if (!prepared.ok) {
        await denyPoolPreparation(ctx, action, 'pool:add', prepared)
        return
      }
      const { candidate, plan, identity, probe, shape } = prepared
      // `commit` 模式下落盘值必然已确定（归一化就在这一步发生）；这一行是给类型收口，
      // 也是"没拿到可落盘的值就绝不往下走"的显式声明。
      const value = candidate.value
      if (value === null) {
        deny(ctx, 500, 'bad_request', '归一化没有拿到可落盘的值，已拒绝写入。')
        return
      }
      const ref = candidate.ref
      const updatedBy = ctx.admin?.accountId ?? '-'
      const reason = asString(ctx.body['reason']) ?? ''

      /**
       * 已经在池子里的同一枚凭据：**不重复写入**，如实回一个"池子已是这个状态"。
       *
       * 为什么不是报错：运营的意图是"让这个号在池子里"，而它已经在池子里了。
       * 报错会让人以为失败了并反复重试；报成功又不写盘、并在摘要里写清"判据是哪一条"
       * 才是诚实的。审计同样留痕（否则这次操作在事后完全看不见）。
       */
      if (plan.action === 'duplicate') {
        const fingerprint = fingerprintOf(value)
        const entry = await recordAudit({
          ...auditBase,
          action, target: `pool:${ref}`, result: 'allow',
          reason,
          summary: `号池已有这枚凭据（判据：${duplicateBasisLabel(plan.basis)}，命中 ${plan.existingRef ?? ref}），未重复写入`,
          before: { ref, fingerprint, present: true },
          after: { ref, fingerprint, present: true, action: plan.action, duplicateBasis: plan.basis },
        })
        ctx.json(200, {
          ok: true,
          auditId: entry?.id ?? null,
          result: {
            ref,
            fingerprint,
            action: plan.action,
            duplicateBasis: plan.basis,
            existingRef: plan.existingRef,
            backupPath: null,
            // 没有写入就没有"这次改动的时刻"：回 `null` 而不是编一个时间。
            updatedAt: null,
            updatedBy,
            written: false,
          },
        })
        return
      }

      /**
       * 第 1 道：**写入前真打一次上游**，而且打的是**将要落盘的那把值**。
       *
       * 这是这条链路上唯一能证明"写进去的这枚凭据真的能用"的证据，也是"写前探测"
       * 这条硬要求真正的强制点（预览可以被绕过，写入前不行）。
       * 放在判重之后：判重命中"已经在池子里"时**什么都不会写**，没有要验的东西。
       */
      if (!probe.ok) {
        await denyPoolProbe(ctx, action, `pool:${ref}`, probe)
        return
      }

      // 第 2 道：写入协议整条复用：备份 → 跨进程锁 → 原子替换 → 权限复核 0600 → 失败回滚。
      let written: {
        readonly fingerprint: string
        readonly previousFingerprint: string | null
        readonly backupPath: string | null
        readonly updatedAt: number
      }
      try {
        written = await upstreamKeys.writeKey(ref, value)
      } catch (error) {
        const problem = error instanceof CredentialsDocumentError
          ? { code: error.code, message: error.message }
          : { code: 'write_failed', message: error instanceof Error ? error.message : String(error) }
        const entry = await recordAudit({
          ...auditBase,
          action, target: `pool:${ref}`, result: 'error',
          reason: problem.code,
          summary: `号池写入失败（${problem.code}），已回滚：${problem.message}`,
        })
        ctx.json(problem.code === 'bad_ref' || problem.code === 'bad_value' ? 400 : 500, {
          ok: false,
          code: problem.code,
          message: `未写入：${problem.message}`,
          auditId: entry?.id ?? null,
          written: false,
        })
        return
      }

      /**
       * 元数据是**记账**，不是凭据本身。
       *
       * 这次写失败时凭据**已经在池子里了** —— 所以既要如实说"写成功了"（`written: true`），
       * 又要如实说"账没记上"（`ok: false` + 原因）。把这一半悄悄吞掉，会让界面显示成
       * "新增失败"，而运营会因此再贴一次（虽然判重会挡住，但那是一次没有意义的惊吓）。
       */
      try {
        await pool.record({
          ref,
          label,
          fingerprint: written.fingerprint,
          authId: identity.authId,
          email: identity.email,
          shape,
          addedAt: written.updatedAt,
          addedBy: updatedBy,
          lastVerifiedAt: written.updatedAt,
          previousFingerprint: written.previousFingerprint,
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const entry = await recordAudit({
          ...auditBase,
          action, target: `pool:${ref}`, result: 'error',
          reason: 'metadata_write_failed',
          summary: `凭据已写入号池 ${ref}（指纹 ${written.fingerprint}），但管理台元数据没写成：${detail}`,
          before: { ref, fingerprint: written.previousFingerprint },
          after: { ref, fingerprint: written.fingerprint },
        })
        ctx.json(500, {
          ok: false,
          code: 'metadata_write_failed',
          message: `凭据**已经写入号池**（${ref}），但管理台的标签/验活记录没写成：${detail}。`
            + '号本身是可用的；请让运维检查管理台数据目录的写权限。',
          auditId: entry?.id ?? null,
          written: true,
        })
        return
      }

      // 审计只留**指纹与探测分类**，绝不留明文（那等于把凭据抄一份进审计文件）。
      const before = { ref, fingerprint: written.previousFingerprint, present: written.previousFingerprint !== null }
      const after = {
        ref,
        fingerprint: written.fingerprint,
        label,
        authId: identity.authId,
        email: identity.email,
        shape,
        action: plan.action,
        duplicateBasis: plan.basis,
        probeKind: 'ok',
        probeStatus: probe.status,
      }
      const entry = await recordAudit({
        ...auditBase,
        action, target: `pool:${ref}`, result: 'allow',
        reason,
        summary: `号池${plan.action === 'add' ? '新增' : '替换'} ${ref}（${identity.email ?? identity.authId}）：`
          + `指纹 ${written.previousFingerprint ?? '（原先未配置）'} → ${written.fingerprint}；`
          + `探测通过（${probe.endpoint}，HTTP ${probe.status}，${probe.latencyMs} 毫秒）`,
        before, after, diff: computeDiff(before, after),
      })

      ctx.json(200, {
        ok: true,
        auditId: entry?.id ?? null,
        result: {
          ref,
          fingerprint: written.fingerprint,
          previousFingerprint: written.previousFingerprint,
          action: plan.action,
          backupPath: written.backupPath,
          updatedAt: written.updatedAt,
          updatedBy,
          written: true,
        },
      })    },
  })

  route({
    path: '/pool/remove',
    auth: 'permission',
    permission: 'credential.manage',
    mutating: true,
    handler: async (ctx) => {
      const action = 'pool.remove.apply'
      const ref = asString(ctx.body['ref'])
      if (ref === null) {
        deny(ctx, 400, 'bad_request', 'ref 必填。')
        return
      }
      if (!isCursorPoolRef(ref)) {
        deny(ctx, 400, 'bad_request', '这不是号池里的号：号池 ref 形如 `CURSOR_CK_xxxxxxxx`（其余引用不属于号池，不能从这里删）。')
        return
      }
      if (!await requireSuperAdminFor(ctx, action, `pool:${ref}`, '上游号池')) return
      if (!await consumeConfirm(ctx, 'pool.remove', { op: 'remove', ref })) return

      const auditBase = {
        actorType: 'admin' as const,
        actorId: ctx.admin?.accountId ?? '-',
        actorRole: ctx.role?.id ?? '-',
        ip: ctx.ip,
        addressSource: ctx.addressSource,
      }

      const current = await pool.snapshot()
      if (!current.ok) {
        deny(ctx, 500, 'bad_request', `凭据文件读不懂，为免写坏它已拒绝操作：${current.problem.message}`)
        return
      }
      const existing = current.entries.find(entry => entry.ref === ref)
      if (existing === undefined || existing.value === null) {
        deny(ctx, 404, 'bad_request', `号池里没有「${ref}」。`)
        return
      }

      // 真的把 `refs:` 段里那一行删掉：只删元数据会留下一个**还能被取到**的凭据。
      let removed: {
        readonly fingerprint: string
        readonly previousFingerprint: string | null
        readonly backupPath: string | null
        readonly updatedAt: number
      }
      try {
        removed = await upstreamKeys.deleteKey(ref)
      } catch (error) {
        const problem = error instanceof CredentialsDocumentError
          ? { code: error.code, message: error.message }
          : { code: 'write_failed', message: error instanceof Error ? error.message : String(error) }
        const entry = await recordAudit({
          ...auditBase,
          action, target: `pool:${ref}`, result: 'error',
          reason: problem.code,
          summary: `号池移除失败（${problem.code}）：${problem.message}`,
        })
        ctx.json(problem.code === 'bad_ref' || problem.code === 'ref_not_found' ? 400 : 500, {
          ok: false,
          code: problem.code,
          message: `未移除：${problem.message}`,
          auditId: entry?.id ?? null,
          written: false,
        })
        return
      }

      // 凭据文件里那一行**已经删掉了**：元数据清不掉只是记账问题，不能报成"没移除"。
      try {
        await pool.forget(ref)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const entry = await recordAudit({
          ...auditBase,
          action, target: `pool:${ref}`, result: 'error',
          reason: 'metadata_write_failed',
          summary: `号池已移除 ${ref}，但管理台元数据没清掉：${detail}`,
          before: { ref, fingerprint: removed.previousFingerprint, present: true },
          after: { ref, fingerprint: null, present: false },
        })
        ctx.json(500, {
          ok: false,
          code: 'metadata_write_failed',
          message: `号**已经从号池里移除**（${ref}），但管理台的元数据没清掉：${detail}。`
            + '凭据文件里那一行确实没了；请让运维检查管理台数据目录的写权限。',
          auditId: entry?.id ?? null,
          written: true,
        })
        return
      }

      const before = {
        ref,
        fingerprint: removed.previousFingerprint,
        present: true,
        label: existing.label,
        authId: existing.authId,
        email: existing.email,
      }
      const after = { ref, fingerprint: null, present: false }
      const entry = await recordAudit({
        ...auditBase,
        action, target: `pool:${ref}`, result: 'allow',
        reason: asString(ctx.body['reason']) ?? '',
        summary: `号池移除 ${ref}（${existing.email ?? existing.authId ?? '身份未知'}）：指纹 ${removed.previousFingerprint ?? '（未知）'} → （已删除）`,
        before, after, diff: computeDiff(before, after),
      })

      ctx.json(200, {
        ok: true,
        auditId: entry?.id ?? null,
        result: {
          ref,
          // 删除之后没有"新指纹"：`null` 是显式表示，比留一个旧指纹诚实。
          fingerprint: null,
          previousFingerprint: removed.previousFingerprint,
          action: 'remove',
          backupPath: removed.backupPath,
          updatedAt: removed.updatedAt,
          updatedBy: ctx.admin?.accountId ?? '-',
          written: true,
        },
      })
    },
  })

  /** 越权尝试的统一留痕。 */
  async function auditDenied(ctx: RouteContext, need: string, target: string): Promise<void> {
    await recordAudit({
      actorType: 'admin', actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
      ip: ctx.ip, addressSource: ctx.addressSource,
      action: 'access.denied', target, result: 'deny',
      reason: `缺少权限 ${need}`,
      summary: `越权尝试：需要 ${need}（数据范围 ${ctx.scope}）`,
    })
  }

  /** 静态资源：SPA + 产物。 */
  const serveStatic = async (response: ServerResponse, pathname: string): Promise<void> => {
    if (pathname === '/') {
      if (await sendFile(response, join(config.webRoot, 'index.html'))) return
      sendText(response, 503, '管理台前端产物还没部署到这台服务器（webRoot 里没有 index.html）。接口本身是可用的。')
      return
    }
    const target = safeJoin(config.webRoot, pathname)
    if (target !== null && await sendFile(response, target, { immutable: pathname.startsWith('/assets/') })) return
    if (pathname.includes('.')) {
      sendText(response, 404, '资源不存在。')
      return
    }
    // SPA 路由：交给前端。
    if (await sendFile(response, join(config.webRoot, 'index.html'))) return
    sendText(response, 503, '管理台前端产物还没部署（webRoot 里没有 index.html）。')
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const pathname = pathnameOf(request.url)
    const address = clientAddressOf(request, config.trustProxy)
    const requestId = newRequestId()

    if (pathname.startsWith(`${COMMUNITY_PREFIX}/`)) {
      try { await communityHttp(request, response, pathname) }
      catch (error) {
        process.stderr.write(`[admin-console] community request failed: ${error instanceof Error ? error.message : String(error)}\n`)
        if (!response.headersSent) sendJson(response, 500, { ok: false, code: 'internal_error', message: '讨论区暂时不可用，请稍后重试。' })
      }
      return
    }

    // ── 第一道门：IP 白名单 ────────────────────────────────────────────────
    // 每次请求都先看文件有没有被改过：白名单的逃生路径是"在服务器上用 CLI 加回自己"，
    // 而 CLI 是另一个进程——不刷新就等于"加了也不生效"（实测踩到过）。
    const whitelistFile = await whitelist.refresh()
    const decision = decideWhitelist(address.ip, whitelistFile)
    if (!decision.allowed) {
      await recordAudit({
        actorType: 'anonymous', actorId: '-', actorRole: '-',
        ip: address.ip, addressSource: address.source,
        action: 'access.whitelist.reject', target: pathname, result: 'deny',
        reason: decision.reason,
        summary: `白名单拒绝：${address.ip}（${decision.reason}）`,
      })
      const payload = {
        ok: false,
        code: 'ip_not_allowed',
        message: '这个来源 IP 不在管理台白名单里。要放行请让管理员在服务器上用 CLI 添加（回环地址永远可以访问）。',
        clientIp: address.ip,
      }
      if (pathname.startsWith(API_PREFIX)) sendJson(response, 403, payload)
      else sendText(response, 403, `${payload.message}\n来源 IP：${address.ip}\n`)
      return
    }

    if (!pathname.startsWith(API_PREFIX)) {
      await serveStatic(response, pathname)
      return
    }

    // ── 同源检查 ───────────────────────────────────────────────────────────
    const originProblem = checkOrigin(request, config.origin)
    if (originProblem !== null) {
      await recordAudit({
        actorType: 'anonymous', actorId: '-', actorRole: '-',
        ip: address.ip, addressSource: address.source,
        action: 'access.origin.reject', target: pathname, result: 'deny',
        reason: originProblem, summary: '跨站请求被拒绝',
      })
      sendJson(response, 403, { ok: false, code: 'forbidden', message: originProblem })
      return
    }

    const relative = pathname.slice(API_PREFIX.length)
    const routeEntry = routes.find(candidate => candidate.path === relative)
    if (routeEntry === undefined) {
      sendJson(response, 404, { ok: false, code: 'bad_request', message: `没有这个接口：${pathname}。` })
      return
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, code: 'bad_request', message: '管理台接口只接受 POST。' })
      return
    }

    const bodyResult = await readJsonBody(request, MAX_BODY_BYTES)
    if (!bodyResult.ok) {
      sendJson(response, bodyResult.code === 'too_large' ? 413 : 400, { ok: false, code: bodyResult.code, message: bodyResult.message })
      return
    }

    const sessionToken = readSessionCookie(request.headers.cookie)
    let admin: AdminRecord | null = null
    let role: RoleRecord | null = null
    let session: SessionRecord | null = null
    let scope: DataScope = 'all'

    if (routeEntry.auth !== 'public') {
      const resolved = await resolveSession(sessionToken)
      if (resolved.kind === 'anonymous') {
        sendJson(response, 401, { ok: false, code: 'unauthenticated', message: '请先登录。' })
        return
      }
      if (resolved.kind === 'invalid') {
        // 会话存在但已经不成立：清掉 cookie，避免浏览器反复带着一个死令牌。
        if (sessionToken !== null) sessions.revoke(sessionToken)
        await recordAudit({
          actorType: 'anonymous', actorId: '-', actorRole: '-',
          ip: address.ip, addressSource: address.source,
          action: 'access.session.reject', target: pathname, result: 'deny',
          reason: resolved.reason, summary: `会话无效：${resolved.reason}`,
        })
        sendJson(response, 403, { ok: false, code: 'not_an_admin', message: resolved.reason }, { 'set-cookie': clearSessionCookie() })
        return
      }
      const verdict = await refreshIdentity(resolved.session)
      if (verdict === 'unauthorized') {
        sessions.revoke(sessionToken as string)
        await recordAudit({
          actorType: 'admin', actorId: resolved.admin.accountId, actorRole: resolved.admin.roleId,
          ip: address.ip, addressSource: address.source,
          action: 'access.session.revoked', target: pathname, result: 'deny',
          reason: 'upstream_unauthorized',
          summary: '上游账号会话已失效，管理台会话被吊销',
        })
        sendJson(response, 401, { ok: false, code: 'unauthenticated', message: '上游账号会话已失效，请重新登录。' }, { 'set-cookie': clearSessionCookie() })
        return
      }
      admin = resolved.admin
      role = resolved.role
      session = resolved.session
      scope = resolved.admin.scope ?? resolved.role.scopeDefault
      if (sessionToken !== null) sessions.touch(sessionToken)

      if (routeEntry.auth === 'permission') {
        const permission = routeEntry.permission as string
        if (!can(role, permission)) {
          await auditDenied(
            {
              request, response, body: bodyResult.value,
              ip: address.ip, addressSource: address.source, requestId,
              admin, role, scope, sessionToken, session, json: () => { /* 这里只用来算权限，不需要回响应 */ },
            },
            permission,
            pathname,
          )
          sendJson(response, 403, { ok: false, code: 'forbidden', message: `这个操作需要权限：${permission}。`, need: permission })
          return
        }
      }
    }

    const ctx: RouteContext = {
      request,
      response,
      body: bodyResult.value,
      ip: address.ip,
      addressSource: address.source,
      requestId,
      admin,
      role,
      scope,
      sessionToken,
      session,
      json: (status, value, headers) => {
        sendJson(response, status, value, headers ?? {})
      },
    }
    try {
      await routeEntry.handler(ctx)
    } catch (error) {
      // 未预期的异常：留痕 + 固定文案（不把堆栈漏给浏览器）。
      await recordAudit({
        actorType: admin === null ? 'anonymous' : 'admin',
        actorId: admin?.accountId ?? '-', actorRole: role?.id ?? '-',
        ip: address.ip, addressSource: address.source,
        action: `error.${relative}`, target: pathname, result: 'error',
        reason: error instanceof Error ? error.message : String(error),
        summary: '接口处理出现未预期异常',
      })
      process.stderr.write(`[admin-console] ${pathname} 处理失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      if (!response.headersSent) {
        sendJson(response, 500, { ok: false, code: 'bad_request', message: '服务端出错了，已记录。请稍后再试或联系维护者。' })
      }
    }
  }

  return {
    handle,
    readiness,
    components: { admins, roles, whitelist, flags, audit, sessions, confirms, ledger, subscriptions, upstream, pool },
  }
}

/** 读一个 JSON 文件（CLI 用）。 */
export async function peekJson(path: string): Promise<unknown> {
  return await readJson(path)
}
