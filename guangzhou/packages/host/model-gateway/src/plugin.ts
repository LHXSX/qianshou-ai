/**
 * 模型网关的插件面：把它挂进工作台，从「一个库」变成「产品里能用的东西」。
 *
 * 与账号面同形（`packages/host/account-session/src/plugin.ts`）：cordis 插件、
 * 路由挂在既有的已鉴权 owner connection 之下、不新开监听端口。
 *
 * 三条刻意的取舍：
 *
 * 1. **密钥缺失不让插件挂掉**。插件负责注册路由与会话；密钥是**运行时**的东西。
 *    没有密钥时：额度状态照常可查（用户至少能看到自己还剩多少），对话返回一句
 *    「服务暂时不可用」。反过来（没密钥就整个插件不加载）会让用户连额度都看不到，
 *    而且排查时看不出到底是没配好还是插件坏了。
 * 2. **档位从账号角色映射，但映射表可注入**。账号只有一个 `role` 字段，
 *    而"谁是什么档位"是商业决定，不该写死在网关里。
 * 3. **密钥从凭据服务读，不落配置、不进日志**。取到的值只活在调用瞬间的闭包里。
 */

// 只为类型增强而导入：`ctx.connection` 的声明来自这个包。
import '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createCreditLedger, type CreditLedger } from './ledger.ts'
import { createLedgerStore, LEDGER_STORE_FILENAME } from './persistence.ts'
import { CREDENTIALS_FILENAME } from '@deepseek-ai/dsh-credentials-local'
import { createTierStore, TIER_STORE_FILENAME, type TierStore } from './tier-store.ts'
import { createGateway, resolveModel } from './service.ts'
import { createAiCompletionsRoute, createAiRoutes, AI_CHAT_PATH, AI_COMPLETIONS_PATH, AI_STATUS_PATH } from './routes.ts'
import { createAiAdminRoutes, ADMIN_BIND_PATH, ADMIN_NAMES_PATH } from './admin-routes.ts'
import { createAiAdminAuditRoutes, createAiAuditRoutes, ADMIN_AUDIT_PATH, AI_AUDIT_PATH } from './audit-routes.ts'
import { createLocalOpenAiRoute, LOCAL_OPENAI_PREFIX } from './local-openai.ts'
import { createMobileStaticRoute } from './mobile-static.ts'
import { createPluginMarketRoute } from './plugin-market.ts'
import { createPluginReleasesRoute } from './plugin-releases.ts'
import { createPluginFreeLicenseService, PLUGIN_LICENSE_PATH } from './plugin-license.ts'
import { createPluginLicenseBearerRoute, createPluginLicenseBearerVerifier,
  PLUGIN_LICENSE_BEARER_PATH } from './plugin-license-bearer.ts'
import { createPluginSubmissionRoute, PLUGIN_SUBMISSIONS_PATH,
  PLUGIN_SUBMISSION_MAX_BODY_BYTES, type PluginSubmissionOptions } from './plugin-submissions.ts'
import { createPluginSubmissionBearerRoute, PLUGIN_SUBMISSIONS_BEARER_PATH } from './plugin-submission-bearer.ts'
import { createOrdinarySkillPublication, ORDINARY_SKILL_PATH, ORDINARY_SKILL_ADMIN_PATH } from './ordinary-skill-publication.ts'
import { createOrdinarySkillBearerRoute } from './ordinary-skill-bearer.ts'
import { createPluginExecutionAccessRoute } from './plugin-execution-access.ts'
import { ADMIN_MARKETPLACE_PATH, createMarketplaceAdminRoute } from './marketplace-admin.ts'
import { createSubscriptionAdminRoutes, ADMIN_SUBSCRIPTIONS_PATH, ADMIN_SUBSCRIPTION_PATH } from './subscription-routes.ts'
import { createRoutingConsole, type RoutingConsole } from './routing.ts'
import { TIERS, type PublishedModel, type TierId } from './tiers.ts'
import type { Principal } from './admin-routes.ts'
import { MediaNodeStore } from './media-node-store.ts'
import { createMediaNodeRoutes } from './media-node-http.ts'
import { createMediaExchangeHttp } from './media-exchange-http.ts'

/** Cordis 插件身份。 */
export const name = 'qianshou-model-gateway'

/**
 * 依赖声明：路由挂在既有的已鉴权 owner 连接上。
 *
 * ⚠️ 这里连踩两个坑，都写下来：
 *
 * **坑一（症状：一个没有正文的 400）**：早期版本只声明 `connection`，却在
 * `principalOf()` 里读 `ctx.accountSession`。cordis 对服务访问是**运行时强制**的，
 * 于是每个请求都在 `principalOf()` 抛 `cannot get property "accountSession" without
 * inject`，而宿主 webServer 把处理器异常统一成一个**空正文 400**——从外面看像
 * "路由不存在"，实际是依赖没声明。教训：**凡是通过 `ctx.<name>` 取的服务，必须出现在
 * `inject` 里**。
 *
 * **坑二（症状：整个工作台启动失败）**：知道了坑一，把 `accountSession` 加进 `inject`，
 * 结果启动直接失败：`@deepseek-ai/dsh-host-model-gateway/plugin: pending (waiting for
 * service: accountSession)`。宿主在启动末尾执行 `assertEntriesActivated`——**每条插件
 * 条目都必须激活**，而声明一个必需依赖就等于把"这套部署里账号插件必须存在"变成硬约束。
 * cordis 的 `Inject` 两种形状（字符串数组、服务形状对象）**都表示必需**，没有"可选依赖"
 * 这一档。
 *
 * 所以这里的取舍是刻意的：**只声明 `connection`，把"账号服务在不在"当作运行期事实**。
 * 取不到就退化成"认不出身份 → 401 请先登录"，而不是让整个工作台起不来，也不是抛一个
 * 把原因藏起来的 400。代价是丢掉了"账号服务先就绪"这一顺序保证；对当前部署不重要，
 * 因为账号插件与网关在同一个 bundle 里，且这种探测是逐请求发生的。
 */
export const inject = ['connection']

/** 请求体上限：对话请求可能带很长的上下文，给 2 MiB；超出由上下文上限在网关侧拦住。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** 凭据服务的最小形状（`ctx.credentials` 由凭据插件提供）。 */
interface CredentialsLike {
  readonly resolve?: (ref: string) => Promise<{ readonly value?: string } | string | null | undefined>
}

/**
 * 账号会话服务的最小形状（`ctx.accountSession` 由账号插件提供）。
 *
 * 两个方法的分工必须分清，否则会重演 A-01：
 * - `account()`：**展示用**快照，冷启动时可能来自磁盘缓存，且只在会话处于
 *   `authenticated` 时返回。它不是授权依据。
 * - `verifiedAccount()`：**服务端权威**快照（在线 `/me`，带 TTL）。角色与管理员
 *   身份只能从它来。
 */
interface AccountSessionLike {
  /** 读当前已登录账号；未登录/已登出返回 `null`。 */
  readonly account?: () => Promise<AccountSnapshot | null>
  /**
   * 在线核验过的账号；核验不过返回 `null`。
   * @param options - 可选 TTL。
   */
  readonly verifiedAccount?: (options?: { readonly maxAgeMs?: number }) => Promise<AccountSnapshot | null>
  /** Server-held access token for the same Shanghai account verified above. */
  readonly ensureAccessToken?: () => Promise<string | null>
  /**
   * 最近一次核验失败的分类；`null` 表示上次核验成功。
   *
   * 网关用它把两种"认不出身份"分开：**上游明确拒绝**（会话没了 → 401 请重新登录）
   * 与**核验过程失败**（账号服务抖动 → 5xx 稍后再试）。混成 401 的后果实测过：
   * 适配器把 401 渲染成「API 密钥无效」，而订阅制用户根本没有密钥可填——
   * 报错文案把人引向一个不存在的输入框。
   */
  readonly lastVerifyFailure?: () => string | null
}

/** 核验过程的失败分类里，哪些算"等一下就好"（与 account-session 的判据保持一致）。 */
const TRANSIENT_VERIFY_FAILURES = new Set(['network', 'server-error', 'unparseable', 'rate-limited', 'aborted'])

/** 账号快照的最小形状（`Account` 的展示字段里我们只关心这两个）。 */
interface AccountSnapshot {
  readonly id?: number | string
  readonly role?: string
}

/** 插件配置。 */
export interface Config {
  /** Explicit Guangzhou node-channel deployment. Omission registers no node or dispatch HTTP routes. */
  readonly mediaNodes?: {
    readonly storePath: string
    readonly accountApiOrigin: string
    readonly heartbeatIntervalMs: number
    readonly heartbeatTimeoutMs: number
    readonly maxLongPollRequests: number
    /** Credential-service reference for Shanghai's internal metadata ingress; absent disables dispatch and directory reads. */
    readonly dispatchCredentialRef?: string
    /** Read-only research metadata identity; it cannot dispatch tasks. */
    readonly researchDirectoryCredentialRef?: string
    /** Independent non-billable research dispatcher identity. */
    readonly researchDispatchCredentialRef?: string
    /** Pinned independent Guangzhou Ed25519 verifier PEM public keys, keyed by purpose-specific key id. */
    readonly resultVerifierPublicKeys?: Readonly<Record<string, string>>
    /** Shanghai dispatch authorization has a separate signing purpose from result verification and viewer grants. */
    readonly orderAuthorizationPublicKeys?: Readonly<Record<string, string>>
    /** Fixed existing Guangzhou 8765 verifier origin and private credential-service reference. */
    readonly exchangeOrigin?: string
    readonly exchangeCredentialRef?: string
    /** Reviewed install/directory metadata can serve without opening the formal byte exchange. */
    readonly metadataOrigin?: string
    readonly metadataCredentialRef?: string
  }
  /**
   * 备用的 harness home（凭据可能放在这里）。
   *
   * 为什么不写死：这是**部署方决定的**东西。写进插件就等于把一个可变项固化成常量——
   * 换台机器、换个用户名、或用户改了自己的数据目录，都会静默失效，
   * 而症状只是"密钥没配"，极难排查。所以做成配置项，由部署层给值。
   */
  readonly fallbackHarnessHome?: string
  /** 上游 OpenAI 兼容根地址。默认 DeepSeek 官方。 */
  readonly baseUrl?: string
  /** 凭据作用域（`ctx.credentials` 的第一段）。 */
  readonly credentialScope?: string
  /** 凭据 id（第二段）。默认 `model-api`。 */
  readonly credentialId?: string
  /**
   * 凭据引用名（**裸引用**，即凭据文件 `refs:` 段的键名，例如 `DEEPSEEK_API_KEY`）。
   *
   * 为什么是裸引用而不是 `<scope>/<id>`：`refs` 段存的是**用户直接存进来的密钥**；
   * `<scope>/<id>` 那套是给"由某个插件拥有的凭据记录"用的。用错那一套会永远取不到值，
   * 而现象只是"密钥没配"——排查时极易误判。
   */
  readonly credentialRef?: string
  /** 兜底：直接从环境变量读密钥的名字。凭据服务取不到时用它。 */
  readonly envKeyName?: string
  /** 账本文件的显式路径；省略时放 `${DSH_HOME}/.qianshou-ledger.json`。 */
  readonly ledgerPath?: string
  /** 订阅文件的显式路径；省略时放 `${DSH_HOME}/.qianshou-subscriptions.json`。 */
  readonly subscriptionsPath?: string
  /** 测试用：注入 DSH home。 */
  readonly dshHome?: string
  /** 我们允许同时向上游打开多少条流（后端容量保护）。默认 64。 */
  readonly backendStreamCap?: number
  /** 整个进程的并发总闸；省略时不设总闸。 */
  readonly globalStreamCap?: number
  /**
   * 手机端静态产物目录（绝对路径）。给了就把手机页面挂到**同源**路径下。
   *
   * 为什么是一件产品功能而不是运维小事：手机端的**订阅通道只在同源时才启用**
   * （非同源带的是别人电脑的凭据，会把费用记到别人账号上）。而同源不能靠嘴说——
   * 手机页面必须真的由工作台自己提供。实测过缺口：工作台上的 `/mobile/` 曾是 404。
   * 不配置就不注册路由：没这个需求的部署不该凭空多一条路径。
   */
  readonly mobileStaticDir?: string
  /** 手机端页面的挂载前缀；默认 `/mobile`。 */
  readonly mobileStaticPrefix?: string
  /** 运营方审核后的插件目录 JSON 绝对路径；未配置时公开目录为空。 */
  readonly marketCatalogPath?: string
  /** 插件目录发布者的 Ed25519 公钥，按发布者 id 索引；只有验签成功的条目才公开。 */
  readonly marketPublisherKeys?: Readonly<Record<string, string>>
  /** Operator-approved, signed release metadata; empty until a real artifact registry is configured. */
  readonly marketReleaseRegistryPath?: string
  /** Directory of content-addressed `.qspkg` archives matched to the signed release registry. */
  readonly marketArtifactDir?: string
  /** Durable release-version pin; backup and restore with the registry. Defaults beside registry. */
  readonly marketReleaseLockPath?: string
  /** Isolated preview bearer for reviewed artifact retrieval. Unset disables download; not a purchase entitlement. */
  readonly marketArtifactAccessToken?: string
  /** Review operator's trusted Ed25519 public keys. Private keys never belong in runtime config. */
  readonly marketOperatorKeys?: Readonly<Record<string, string>>
  /** Owner-only durable free-license ledger; absent path disables claims. */
  readonly marketLicenseLedgerPath?: string
  /** Fixed Shanghai HTTPS account origin for request-bound Mac Bearer verification; absent disables Mac claims. */
  readonly marketLicenseAccountApiOrigin?: string
  /** Explicit review-controlled free release ids; no release is free by default. */
  readonly marketFreeReleaseIds?: readonly string[]
  /** Private 0700 directory for owner-bound, unapproved candidate archives. */
  readonly marketSubmissionStagingDir?: string
  /** Private ordinary SKILL.md submission/publication index; separate from adapter releases and funds. */
  readonly marketOrdinarySkillStorePath?: string
  /** Authority-maintained verified account ids for official ordinary skills; default is no official users. */
  readonly marketOfficialSkillAccounts?: readonly string[]
  /** Publisher signing id to verified account id, set by the operator after identity checks. */
  readonly marketPublisherAccounts?: Readonly<Record<string, string>>
  /** Review signing id to verified administrator account id. */
  readonly marketOperatorAccounts?: Readonly<Record<string, string>>
  /** Fixed Shanghai HTTPS origin for admin review; absent configuration disables the bridge. */
  readonly marketplaceAdminApiOrigin?: string
  /**
   * 本机模型适配器专用的 OpenAI 兼容路径前缀；默认 `/qianshou-ai`。
   *
   * 挂在 `/api` 之外是刻意的：`/api` 后面有一道要宿主签名 cookie 的信任门，
   * 本机适配器拿不到那枚 cookie。这条路径自己把门，**只认 loopback**。
   */
  readonly localOpenAiPrefix?: string
  /**
   * 按后端的**密钥引用名**覆盖端点；省略时用 `BACKENDS` 里声明的官方端点。
   *
   * 用于：走代理、私有化部署换域名、临时切灰度端点，以及测试里指向本地假上游。
   */
  readonly backendBaseUrls?: Readonly<Record<string, string>>
  /**
   * 哪些平台角色算管理员。默认**只有 `admin`**。
   *
   * 为什么默认里没有 `enterprise`（WP1 A-02）：`enterprise` 是客户身份，不是运营者身份。
   * 早先把两者等同，等于"买了企业版就拿到了全局模型路由的写权限与全站审计的读权限"。
   * 真有企业客户需要自助管理时，由部署方在这里显式列出。
   */
  readonly adminRoles?: readonly string[]
  /**
   * 账本完整性密钥（HMAC-SHA256）。给了才写/验 MAC；没给只做字段校验。
   *
   * 刻意**不**在本机自动生成一把再存成文件：那样密钥与账本同处一个目录、同一个
   * OS 用户可读，防的是同一个攻击者，收益接近零，却会让人以为账本已经"防篡改"。
   * 密钥该放哪是部署决定（凭据服务 / 环境变量），见工作包报告里的遗留项。
   */
  readonly ledgerHmacKey?: string
}

/** 账号角色 → 订阅档位的默认映射。
 *
 * 这是**默认值**，部署方可通过 `tierOf` 覆盖——"谁是什么档位"是商业决定，不该写死在网关里。 */
const DEFAULT_TIER_BY_ROLE: Readonly<Record<string, TierId>> = {
  personal: 'basic',
  pro: 'plus',
  enterprise: 'max',
  admin: 'max',
}

/**
 * 挂载模型网关。
 * @param ctx - 宿主作用域，提供已鉴权的 connection。
 * @param config - 端点与凭据位置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  let authorizeLicensedArtifact: NonNullable<Parameters<typeof createPluginReleasesRoute>[0]['authorizeLicensedArtifact']>
    = async () => false
  const marketRoute = createPluginMarketRoute({
    ...(config.marketCatalogPath === undefined ? {} : { catalogPath: config.marketCatalogPath }),
    ...(config.marketPublisherKeys === undefined ? {} : { publisherKeys: config.marketPublisherKeys }),
  })
  const releaseOptions = {
    ...(config.marketReleaseRegistryPath === undefined ? {} : { registryPath: config.marketReleaseRegistryPath }),
    ...(config.marketArtifactDir === undefined ? {} : { artifactDir: config.marketArtifactDir }),
    ...(config.marketReleaseLockPath === undefined ? {} : { lockPath: config.marketReleaseLockPath }),
    ...(config.marketArtifactAccessToken === undefined ? {} : { artifactAccessToken: config.marketArtifactAccessToken }),
    ...(config.marketPublisherKeys === undefined ? {} : { publisherKeys: config.marketPublisherKeys }),
    ...(config.marketOperatorKeys === undefined ? {} : { operatorKeys: config.marketOperatorKeys }),
  }
  const releaseRoute = createPluginReleasesRoute({ ...releaseOptions,
    authorizeLicensedArtifact: (token, release) => authorizeLicensedArtifact(token, release),
  })
  /**
   * 账本必须**落盘**。
   *
   * 纯内存账本会让"月度上限"形同虚设：工作台一重启，所有人的用量归零，
   * 用户只要等到重启就能无限重置自己的额度。所以这里把账本接到一个
   * 全量快照文件上（原子替换 + 0600），冷启动时读回来。
   */
  const ledgerPath = config.ledgerPath ?? join(resolveDshHome(config.dshHome), LEDGER_STORE_FILENAME)
  /** 账本实例；`restore` 在下面读回快照后调用。 */
  const ledger: CreditLedger = createCreditLedger({ onChange: () => { store.markDirty() } })
  /**
   * 完整性密钥：配置优先，其次环境变量 `QIANSHOU_LEDGER_KEY`。
   * 没配就只做字段校验（如实降级，不假装防篡改）。
   */
  const ledgerHmacKey = config.ledgerHmacKey ?? process.env['QIANSHOU_LEDGER_KEY'] ?? undefined
  const store = createLedgerStore({
    path: ledgerPath,
    snapshot: () => ledger.snapshotOf(),
    ...(ledgerHmacKey === undefined || ledgerHmacKey.length === 0 ? {} : { macKey: ledgerHmacKey }),
    // 文件在、却验不过：挪到旁支留证再当"没有账本"，而不是原地覆盖掉证据。
    quarantine: true,
  })

  /**
   * 订阅档位：**用户花钱买到的权益**，与上游账号角色分开记。
   * 落盘复用账本那套（全量快照 + 原子替换 + 0600）。
   */
  const subscriptionsPath = config.subscriptionsPath ?? join(resolveDshHome(config.dshHome), TIER_STORE_FILENAME)
  const tierStore: TierStore = createTierStore({ onChange: () => { tierStoreDirty = true; void saveTiers() } })
  let tierStoreDirty = false
  const saveTiers = async (): Promise<void> => {
    if (!tierStoreDirty) return
    tierStoreDirty = false
    try {
      const { mkdir, writeFile, rename } = await import('node:fs/promises')
      await mkdir(dirname(subscriptionsPath), { recursive: true })
      const temp = `${subscriptionsPath}.tmp`
      await writeFile(temp, `${JSON.stringify(tierStore.snapshotOf())}\n`, { mode: 0o600 })
      await rename(temp, subscriptionsPath)
    } catch {
      // 写盘失败不该让请求失败：内存里的订阅仍然有效，下一次变更会再试。
      tierStoreDirty = true
    }
  }
  void (async () => {
    try {
      const { readFile } = await import('node:fs/promises')
      const parsed: unknown = JSON.parse(await readFile(subscriptionsPath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') tierStore.restore(parsed as never)
    } catch {
      // 没有文件、或文件损坏：当作"没有任何订阅"，所有人按角色兜底。
    }
  })()

  /**
   * 读回历史账目。**同步读会被迫用 readFileSync 阻塞启动**，所以走异步——
   * 但异步就带来一个必须堵住的窗口：在快照读回来之前，账本是空的，于是"未授予"的
   * 账户会被按整月额度 grant 一次，**重启就等于重置月度上限与五小时刹车**（WP1 A-05）。
   *
   * 所以这里把这次恢复做成一个**完成信号 `ready`**，每个请求在取身份前先 `await` 它。
   * 只等一次、之后是已 resolve 的 Promise，代价接近零。
   */
  const ready: Promise<void> = store.load().then((snapshot) => {
    if (snapshot === null) return
    ledger.restore(snapshot)
    ctx.logger.info(`模型网关：从 ${ledgerPath} 恢复账本（${snapshot.records.length} 条记录）`)
  }).catch((error: unknown) => {
    // 坏文件不该让工作台起不来；但要说出来——静默的"账本为空"看起来和全新部署一样。
    ctx.logger.warn(`模型网关：账本恢复失败，按未授予处理：${String(error)}`)
  })

  const routing: RoutingConsole = createRoutingConsole()

  /**
   * 起一个 CJS 风格的默认目录：把 `tiers.ts` 里声明的名字登记进控制台，
   * 并给它们各绑一条「从零时刻起生效」的绑定。
   *
   * 为什么要在启动时登记：控制台是运行时可改的，但**空的控制台等于所有模型都不可用**。
   * 默认目录让"刚挂上就能用"，管理员随后可以用管理路由覆盖。
   */
  for (const [index, record] of [
    { publishedName: '千手·迅捷', label: '千手·迅捷', tiers: ['basic', 'plus', 'max'], maxOutputTokens: 4096, backends: ['flash'] },
    { publishedName: '千手·强力', label: '千手·强力', tiers: ['plus', 'max'], maxOutputTokens: 16384, backends: ['pro', 'flash'] },
  ].entries()) {
    routing.publish({
      publishedName: record.publishedName,
      label: record.label,
      tiers: record.tiers,
      maxOutputTokens: record.maxOutputTokens,
      order: index,
      upgradeRule: 'on-expiry',
      lifecycleStage: 'ga',
      shutdownDate: null,
      migrationTarget: null,
    })
    routing.bind({
      publishedName: record.publishedName,
      backendKeys: record.backends,
      effectiveFrom: 0,
      reason: '默认目录：插件启动时登记',
      operator: 'system',
      rolloutPercent: 100,
    })
  }
  ctx.provide('routingConsole', routing)
  ctx.provide('creditLedger', ledger)

  /**
   * 取密钥：优先凭据服务，其次环境变量。**值只在这里出现，不落盘不进日志**。
   *
   * 形态是"一次性异步解析 + 缓存 + 失败冷却重试"：
   * - **异步解析并 `await`**：早期版本同步返回环境变量兜底，导致第一次请求必然
   *   拿不到凭据服务里的密钥——用户第一次发消息就报"服务暂时不可用"。
   * - **失败要有冷却**：拿到 `null` 之后如果每次请求都重试，一次没配好的部署会
   *   变成每个请求都打一次凭据服务。所以失败后 30 秒内不再重试，
   *   但**不是永久记住失败**——用户配好密钥之后应当自己就恢复，不必重启。
   */
  const KEY_RETRY_MS = 30_000
  let keyCache: { readonly value: string | null; readonly at: number } | null = null
  let keyInFlight: Promise<string | null> | null = null

  /**
   * 凭据引用名。默认用市场上最通用的名字 `DEEPSEEK_API_KEY`——
   * 那是用户**已经存在凭据文件里的**那个键名，而不是我们自己另起一个，
   * 否则会出现"密钥明明配了、网关却说没有"。
   */
  const credentialRef = config.credentialRef ?? 'DEEPSEEK_API_KEY'

  /** 从环境变量兜底读；空白串当作没配。 */
  const fromEnv = (): string | null => {
    const name = config.envKeyName ?? process.env[credentialRef] !== undefined ? credentialRef : 'QIANSHOU_MODEL_API_KEY'
    const value = process.env[name]
    return value === undefined || value.trim().length === 0 ? null : value
  }

  /** 真的去解析一次：先凭据服务，再环境变量。 */
  /** 按引用名解析密钥；不同后端用各自的键。 */
  const resolveKeyFor = (ref: string): Promise<string | null> => {
    if (ref === credentialRef) return apiKey()
    // 其他引用名：走同一套顺序（服务 → 环境变量 → 文件），只是换个键。
    return resolveKeyByRef(ref)
  }

  const resolveKeyByRef = async (ref: string): Promise<string | null> => {
    const credentials = (() => {
      try {
        return (ctx as unknown as { credentials?: CredentialsLike }).credentials
      } catch {
        return undefined
      }
    })()
    try {
      const hit = await credentials?.resolve?.(ref)
      const value = typeof hit === 'string' ? hit : hit?.value
      if (value !== undefined && value.trim().length > 0) return value
    } catch { /* 继续往下 */ }
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.trim().length > 0) return ambient.trim()
    return keyFromCredentialsFile(ref)
  }

  const resolveKey = async (): Promise<string | null> => {
    /**
     * 读凭据服务。**整个读取都在 try 里**，因为 cordis 对服务访问是运行时强制的：
     * 部署方没挂凭据服务时，这一句会抛 `cannot get property "credentials" without inject`。
     * 这个坑在本插件里踩过一次（`accountSession`），这次不再重复——
     * 而且启动预热会让它发生在 **apply 期间**，直接变成"工作台起不来"。
     */
    let credentials: CredentialsLike | undefined
    try {
      credentials = (ctx as unknown as { credentials?: CredentialsLike }).credentials
    } catch {
      // 服务读不到时不直接放弃：下面还有**文件兜底**。
      // 这与身份那条路是同一个根因（服务在这个部署里对我不可见），同一套修法。
      credentials = undefined
    }
    /**
     * 依次尝试两个引用名：
     *   1. 配置指定的（默认 `DEEPSEEK_API_KEY`）；
     *   2. 既有的 `<scope>/<id>` 形式，兼容已经按那套配好的部署。
     *
     * 顺序不能反：凭据文件里 `refs:` 段存的才是用户直接存的密钥。
     *
     * 另：`resolve` 返回的是 `{ value, source }` 而**不是**字符串——
     * 早先按字符串解，取到的是 `undefined`，现象同样是"密钥没配"。
     */
    const refs = [
      credentialRef,
      `${config.credentialScope ?? 'qianshou'}/${config.credentialId ?? 'model-api'}`,
    ]
    for (const ref of refs) {
      try {
        const resolved = await credentials?.resolve?.(ref)
        const value = typeof resolved === 'string' ? resolved : resolved?.value
        if (value !== undefined && value.trim().length > 0) return value
      } catch {
        // 这个引用名取不到就试下一个；凭据服务整体不可用也不致命（还有兜底）。
      }
    }
    /**
     * 环境变量。
     *
     * 放在文件兜底之前：环境变量是部署方最直接的覆盖手段，优先级最高。
     */
    const fromEnvironment = fromEnv()
    if (fromEnvironment !== null) return fromEnvironment
    /**
     * **文件兜底**：直接读凭据文件的 `refs:` 段。
     *
     * 为什么需要：实测发现凭据服务在这个部署里对我的插件不可见
     * （`ctx.credentials` 抛错），于是**密钥明明都在、两个文件我都验过有效**，
     * 网关却报"服务暂时不可用"——而用户完全看不出是哪一环断了。
     * 这与身份那条路是同一个根因，用同一套修法：**服务优先、文件兜底**。
     *
     * 只认最简单的 `key: value` 形状，读不懂就放弃（不猜格式）。
     */
    return keyFromCredentialsFile(credentialRef)
  }

  /** 从凭据文件的 `refs:` 段里直接取一个键（兜底路径）。 */
  const keyFromCredentialsFile = (ref: string): string | null => {
    /**
     * **两个位置都找**。
     *
     * 实测发现这台机器上密钥分散在两处：DeepSeek 那把在 `$DSH_HOME/.credentials.yaml`，
     * 通义那把在另一个 harness home 下。网关原先只读前者，于是"通义明明配了、
     * 网关却说没配"——而症状与"真的没配密钥"完全一样，极难排查。
     *
     * 顺序：`$DSH_HOME` 优先（部署方显式配置的位置），答不上再找备用的 harness home。
     * 找到第一个非空值就用，不做任何跨文件合并——免得"哪份生效"变得含糊。
     */
    const paths = [
      join(resolveDshHome(config.dshHome), CREDENTIALS_FILENAME),
      ...(config.fallbackHarnessHome === undefined || config.fallbackHarnessHome.trim().length === 0
        ? []
        : [join(config.fallbackHarnessHome, CREDENTIALS_FILENAME)]),
    ]
    for (const path of paths) {
      const found = refFromFile(path, ref)
      if (found !== null) return found
    }
    return null
  }

  /** 从一个凭据文件里取某个键；读不到返回 `null`。 */
  const refFromFile = (path: string, ref: string): string | null => {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return null
    }
    const lines = text.split('\n')
    const start = lines.findIndex(line => line.startsWith('refs:'))
    if (start === -1) return null
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      // 顶格的非注释行 = 到了下一个顶层段，停。
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) break
      const match = new RegExp(`^\\s+${ref}:\\s*(\\S.*)$`).exec(line)
      const value = match?.[1]?.trim()
      if (value !== undefined && value.length > 0) return value
    }
    return null
  }

  /** 取密钥；转发层会 `await` 它。 */
  const apiKey = async (): Promise<string | null> => {
    const cached = keyCache
    if (cached !== null) {
      if (cached.value !== null) return cached.value
      // 上次拿到的是 null：短冷却内不再打凭据服务，过了冷却再试一次。
      if (nowMs() - cached.at < KEY_RETRY_MS) return null
    }
    keyInFlight ??= resolveKey().then((value) => {
      keyCache = { value, at: nowMs() }
      return value
    }).finally(() => { keyInFlight = null })
    return await keyInFlight
  }

  /** 单调时钟；只为冷却用。 */
  const nowMs = (): number => Date.now()

  /**
   * 启动后预热一次：让第一句对话不用等凭据解析。
   *
   * 用 `queueMicrotask` 而不是直接调：`apply()` 期间不应访问可选服务——
   * 那会把"没挂某个服务"升级成"工作台起不来"。延后一拍既保留预热效果，
   * 又把风险限制在"预热失败"这一层。
   */
  queueMicrotask(() => { void apiKey() })

  /**
   * 取某账号的档位：**订阅优先，角色兜底**。
   *
   * 顺序不能反。用户花钱买到的是订阅；角色是平台身份，不该决定他拿到多少额度。
   * 兜底存在的理由见 `tier-store.ts`：一次存储故障不该让所有付费用户都用不了——
   * 退化成角色对应的档位至少"能用"。
   *
   * 角色**必须由调用方显式传入**（WP1 A-04）：早先这里读一个进程级的
   * `lastRole`（"最近一次看到的角色"），并发或多账号时 A 会拿 B 的档位准入。
   * @param accountId - 账号。
   * @param role - 该账号由服务端给出的角色。
   */
  const tierOfAccount = (accountId: string, role: string): TierId =>
    tierStore.tierOf(accountId, Date.now()) ?? DEFAULT_TIER_BY_ROLE[role] ?? 'basic'

  const gateway = createGateway({
    ledger,
    routing,
    /**
     * 按后端取端点与密钥：不同后端常常是不同厂商，
     * 共用一份配置会把请求发给错误的厂商（上游只会说"模型不存在"）。
     */
    forwardConfigFor: backend => ({
      /**
       * 端点优先用部署方的覆盖值。
       *
       * `backendBaseUrls` 不只是给测试用的：真实部署里也常需要——走公司代理、
       * 私有化部署换域名、或者临时切到灰度端点。把它做成配置而不是写死，
       * 免得每次都要改代码。
       */
      baseUrl: config.backendBaseUrls?.[backend.credentialRef] ?? backend.baseUrl,
      apiKey: () => resolveKeyFor(backend.credentialRef),
    }),
    /**
     * 网关内部的兜底档位解析：只对**没带 `tier` 的调用**生效。
     * 所有 HTTP 路由都会把已认证主体算出的档位随调用传进来，所以正常路径不走这里。
     */
    tierOf: accountId => tierStore.tierOf(accountId, Date.now()) ?? 'basic',
    forwardConfig: {
      baseUrl: config.baseUrl ?? 'https://api.deepseek.com/v1',
      apiKey,
    },
    ...(config.backendStreamCap === undefined ? {} : { backendStreamCap: config.backendStreamCap }),
    ...(config.globalStreamCap === undefined ? {} : { globalStreamCap: config.globalStreamCap }),
  })
  /**
   * 配额授予：网关第一次看到某个账户（**在某账期、某档位下**）时授予本周期额度。
   *
   * 早先的幂等判据是 `remaining === 0 && usedInWindow === 0`——一个**启发式**，它在两种
   * 正常情形下都会判错（WP1 A-12）：
   * - 月初翻转时五小时窗口里还有用量：明明这个账期还没授予，却因为 `usedInWindow > 0`
   *   而不再授予，用户被 402 卡住最多 5 小时；
   * - 管理员升档：档位变了但"余额不为 0"，新档位的额度永远发不下来，直到旧额度耗尽。
   *
   * 现在判据是**账本自己的事实**：这个 (账号, 账期, 档位) 有没有授予记录。
   * 有就不再授予（幂等不靠猜），没有就授予——升档因此立刻生效。
   */
  const ensureGranted = (accountId: string, tier: TierId): void => {
    if (ledger.isGranted(accountId, tier)) return
    ledger.grant(accountId, tier, TIERS[tier].monthlySp)
  }

  /**
   * 账号会话服务。**通过 `ctx.inject` 拿到，不是靠 `ctx.accountSession` 直接读**。
   *
   * 这是一处真实故障的修法，值得写清楚：早先的写法是
   * "在 try 里读 `ctx.accountSession`，读不到就当未登录"。它有两个后果——
   * 1. cordis 对**未声明**的服务访问是运行时强制的，直接读会抛，于是**永远**读到
   *    "未登录"：用户明明登录了（实测账号 167、状态 `authenticated`），
   *    网关却一路回 401；
   * 2. 而 try/catch 把这件事**吞掉了**，外面只看到"请先登录"——与真的没登录
   *    完全一样，排查时无从下手。
   *
   * 正确的机制是 `ctx.inject(['accountSession'], ...)`：它在服务就绪时回调，
   * 没就绪就**不回调**。所以我们既能拿到服务，也不会把"这套部署没有账号服务"
   * 变成硬约束（那会让工作台起不来——`accountSession` 那次已经踩过）。
   */
  let session: AccountSessionLike | undefined
  /**
   * 上一次"认不出身份"是不是因为核验过程出了瞬时问题。
   *
   * 用变量而不是改 `principalOf` 的返回类型：`principalOf` 被九条路由当
   * "有身份/没身份"用，为了一个新的原因去改它的签名会波及所有调用点；
   * 而原因只在**回响应**那一处用得到，放在闭包变量里就够了。
   */
  let verifyFailureKind: string | null = null
  ctx.inject(['accountSession'], (sessionCtx) => {
    session = (sessionCtx as unknown as { accountSession?: AccountSessionLike }).accountSession
  })

  /**
   * 惰性取账号服务：**不依赖"我的 apply 与账号插件的 apply 谁先跑"**。
   *
   * `ctx.inject` 的回调已经覆盖了"服务晚于本插件就绪"的情形；这里再补一条
   * **不抛异常**的探测路径（`ctx.get` 与"读属性"不同：后者对未声明的服务会抛），
   * 于是同一进程里两个插件的注册顺序不影响结果。
   */
  const accountSessionOf = (): AccountSessionLike | undefined => {
    if (session !== undefined) return session
    // `ctx.get` 对未声明/未就绪的服务返回 `undefined`，且**不会抛**（这正是它和
    // "直接读属性"的区别）。
    const registry = ctx as unknown as { get?: (name: string) => AccountSessionLike | undefined }
    const found = registry.get?.('accountSession')
    if (found !== undefined) session = found
    return session
  }

  /** 哪些角色算管理员；默认只有 `admin`。 */
  const adminRoles = new Set<string>(config.adminRoles ?? ['admin'])

  /**
   * 在线核验的 TTL：60 秒。
   *
   * 选这个值的理由：管理操作（改全局路由、开订阅、读全站审计）之间通常只隔几秒，
   * 每个请求都打一次 `/me` 是浪费；而 TTL 同时是**撤权的最坏延迟**——一个刚被降权的
   * 管理员最多还能成功 60 秒。
   */
  const VERIFY_TTL_MS = 60_000

  /**
   * 取**已验证**的主体。**唯一**的身份入口。
   *
   * 为什么不看请求头：早先版本从 `x-qianshou-account` 读账户 id——那等于**任何同源调用者
   * 自己声明是谁就被采信**，与"手机不能自己授权自己"是同一类错误。身份只能来自宿主侧
   * 已经完成鉴权的账号会话，请求头最多用来判断"是不是同源"。
   *
   * 四条硬规则（WP1 A-01/A-02/A-04）：
   * 1. `role` **只**来自 `verifiedAccount()`——即一次真实 `/me` 响应的结果。
   *    磁盘缓存里的 `role` 不构成依据：那个文件与工作台同属一个 OS 用户，
   *    改一行 `"role":"admin"` 就是管理员。
   * 2. **删掉了"读账号文件兜底"**。它有两个问题：绕过鉴定（任何人改一行文件即成管理员），
   *    以及在服务本来就可达时把真正的失败原因藏起来。服务不可达时正确的表现是
   *    "认不出身份 → 401"，而不是"从磁盘上猜一个身份"。
   * 3. 没有 `verifiedAccount` 的服务（旧版账号插件）**一律不认身份**：fail-closed。
   *    宁可所有人都要重新登录，也不接受"没有权威来源时默认放行"。
   * @returns 已验证主体；认不出返回 `null`。
   */
  const principalOf = async (requireFreshOnline = false): Promise<Principal | null> => {
    const current = accountSessionOf()
    const verify = current?.verifiedAccount
    if (verify === undefined) return null
    // `?? null` 把"服务返回 undefined"（例如一份老实现）也收敛成同一条路径。
    const account = (await verify({ maxAgeMs: requireFreshOnline ? 0 : VERIFY_TTL_MS })) ?? null
    const lastFailure = current?.lastVerifyFailure?.() ?? null
    if (requireFreshOnline && lastFailure !== null) {
      verifyFailureKind = TRANSIENT_VERIFY_FAILURES.has(lastFailure) ? lastFailure : null
      return null
    }
    if (account === null || account.id === undefined) {
      // 认不出身份有两种原因，回响应时要分开报：核验过程抖动 → 5xx；
      // 上游明确拒绝（会话没了）→ 401 请重新登录。混成 401 的后果实测过：
      // 适配器把 401 渲染成「API 密钥无效」，而订阅制用户没有密钥可填。
      const kind = current?.lastVerifyFailure?.() ?? null
      verifyFailureKind = kind !== null && TRANSIENT_VERIFY_FAILURES.has(kind) ? kind : null
      return null
    }
    const role = typeof account.role === 'string' ? account.role : 'personal'
    verifyFailureKind = null
    return { accountId: String(account.id), role, isAdmin: adminRoles.has(role) }
  }

  /**
   * 预解析"这次实际会用哪个前台名"。
   *
   * 与网关内部解析用的是**同一份控制台数据**（`routing`）与**同一套降级规则**
   * （`resolveModel`），不是另算一遍——两处算法一旦漂移，就会出现
   * "响应头说 A、实际由 B 作答"这种最难查的不一致。
   */
  const resolvePublished = (publishedName: string, tier: TierId): string => {
    const resolved = resolveModel(publishedName, TIERS[tier])
    // 与网关内部同一条判别式：**有** `ok` 就是拒绝（见 `service.ts` 的说明）。
    if ('ok' in resolved) return publishedName
    return (resolved as { readonly model: PublishedModel }).model.publishedName
  }

  /**
   * 两个路由共用的身份入口。
   *
   * **`await ready` 放在这里**（WP1 A-05）：账本恢复是异步的，而"取身份"是每条路由的第一个
   * 同步决策点。在这里等一次，就堵住了"重启瞬间按空账本授予整月额度"的窗口——
   * 而且只需等一次，之后是已 resolve 的 Promise。
   *
   * 额度授予也收敛到这里：`/chat`、`/status`、`/chat/completions` 三条路**同一个**档位
   * 来源（`tierOfAccount`，订阅优先），不会出现"两条路由给同一账号授予不同档位、先到者说话"。
   */
  const authenticate = async (): Promise<Principal | null> => {
    await ready
    const principal = await principalOf()
    if (principal === null) return null
    ensureGranted(principal.accountId, tierOfAccount(principal.accountId, principal.role))
    return principal
  }

  const routes = createAiRoutes({
    gateway,
    ledger,
    resolvePublished,
    tierOf: (accountId, role) => tierOfAccount(accountId, role),
    // 状态接口也要落实额度：否则新用户打开面板看到"剩余 0"，会以为订阅没生效。
    // （授予本身在 `authenticate` 里已经做过一次，这里保留注入点给测试与将来扩展。）
    onGrant: (accountId, tierId) => { ensureGranted(accountId, tierId) },
    authenticate,
    verifyUnavailable: () => verifyFailureKind !== null,
  })

  // 电脑端主对话走这条：DSH 自己的模型适配器按 OpenAI 形状发请求，
  // 把 baseUrl 指向 /api/qianshou/ai 即可改走订阅链路，不需要为它写专门客户端。
  const completionsRoute = createAiCompletionsRoute({
    gateway,
    ledger,
    tierOf: (accountId, role) => tierOfAccount(accountId, role),
    resolvePublished,
    authenticate,
    verifyUnavailable: () => verifyFailureKind !== null,
  })

  const adminRoutes = createAiAdminRoutes({
    routing,
    authenticate: async () => principalOf(),
  })
  const marketplaceAdminRoute = config.marketplaceAdminApiOrigin === undefined
    ? async (): Promise<Response> => Response.json({ ok: false, message: '插件审核服务尚未配置。' }, { status: 503 })
    : createMarketplaceAdminRoute({
      apiOrigin: config.marketplaceAdminApiOrigin,
      authenticate: () => principalOf(),
      accessToken: async () => (await accountSessionOf()?.ensureAccessToken?.()) ?? null,
    })
  const verifyMacBearer = createPluginLicenseBearerVerifier({
    ...(config.marketLicenseAccountApiOrigin === undefined ? {} : { accountApiOrigin: config.marketLicenseAccountApiOrigin }),
  })
  const freeLicense = createPluginFreeLicenseService({
    ...(config.marketLicenseLedgerPath === undefined ? {} : { ledgerPath: config.marketLicenseLedgerPath }),
    releaseOptions,
    ...(config.marketFreeReleaseIds === undefined ? {} : { freeReleaseIds: config.marketFreeReleaseIds }),
    authenticate: request => new URL(request.url).pathname === PLUGIN_LICENSE_BEARER_PATH
      ? verifyMacBearer(request) : principalOf(true),
    verifyUnavailable: request => new URL(request.url).pathname !== PLUGIN_LICENSE_BEARER_PATH
      && verifyFailureKind !== null,
  })
  const macLicenseRoute = createPluginLicenseBearerRoute({ handle: freeLicense.handler })
  authorizeLicensedArtifact = freeLicense.authorizeArtifact
  const submissionOptions: PluginSubmissionOptions = {
    ...(config.marketSubmissionStagingDir === undefined ? {} : { stagingDir: config.marketSubmissionStagingDir }),
    releaseOptions,
    ...(config.marketPublisherAccounts === undefined ? {} : { publisherAccounts: config.marketPublisherAccounts }),
    ...(config.marketOperatorAccounts === undefined ? {} : { operatorAccounts: config.marketOperatorAccounts }),
    authenticate: request => new URL(request.url).pathname === PLUGIN_SUBMISSIONS_BEARER_PATH
      ? verifyMacBearer(request) : principalOf(),
  }
  const submissionRoute = createPluginSubmissionRoute(submissionOptions)
  const macSubmissionRoute = createPluginSubmissionBearerRoute({ handle: submissionRoute })
  const ordinarySkills = createOrdinarySkillPublication({
    ...(config.marketOrdinarySkillStorePath === undefined ? {} : { storePath: config.marketOrdinarySkillStorePath }),
    ...(config.marketOperatorKeys === undefined ? {} : { operatorKeys: config.marketOperatorKeys }),
    ...(config.marketOperatorAccounts === undefined ? {} : { operatorAccounts: config.marketOperatorAccounts }),
    ...(config.marketOfficialSkillAccounts === undefined ? {} : { officialAccounts: config.marketOfficialSkillAccounts }),
    authenticate: request => new URL(request.url).pathname === ORDINARY_SKILL_PATH ? verifyMacBearer(request) : principalOf(),
  })
  const ordinarySkillRoute = createOrdinarySkillBearerRoute({ handle: ordinarySkills.handler, path: ORDINARY_SKILL_PATH,
    actions: ['submit', 'mine', 'catalog'], publicRead: ordinarySkills.catalog })
  ctx.effect(() => () => ordinarySkills.close(), 'model-gateway: ordinary skill publication')
  const executionAccessRoute = createPluginExecutionAccessRoute({
    submissionOptions, authenticate: verifyMacBearer,
  })

  // 审计出口：账本里早就有逐调用记录，但没有出口就等于"记了没人能看"。
  const auditRoutes = createAiAuditRoutes({ ledger, authenticate: () => principalOf() })
  const adminAuditRoutes = createAiAdminAuditRoutes({ ledger, authenticate: () => principalOf() })

  // 订阅开通是产品闭环的一环：用户付完钱之后，一定有一个"给这个账号开通"的动作。
  // 刻意不做支付：支付回调由部署方接自己的系统，这里只负责"钱已收到，把权益给上"。
  const subscriptionRoutes = createSubscriptionAdminRoutes({ store: tierStore, authenticate: () => principalOf() })

  const register = (path: string, handler: (request: Request) => Promise<Response>, label: string): void => {
    ctx.effect(() => ctx.connection.fetch.register({
      path,
      methods: ['POST'],
      // **用 buffered 而不是 streaming**：我们的请求体是 JSON，不需要边收边处理；
      // 而 carrier 在 streaming 模式下会用 Node 流构造 Request，流式请求不能同时带
      // `content-length`，undici 会抛错 → 客户端拿到一个没有任何信息的 400（实测）。
      // 响应仍然是流式的：carrier 会转发我们返回的 `response.body`。
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        // 体积闸门放在最前面：超过上限的请求不进网关，也不占额度。
        const length = Number(request.headers.get('content-length') ?? '0')
        const maximum = path === PLUGIN_SUBMISSIONS_PATH || path === ORDINARY_SKILL_ADMIN_PATH ? PLUGIN_SUBMISSION_MAX_BODY_BYTES : MAX_BODY_BYTES
        if (Number.isFinite(length) && length > maximum) {
          return Response.json({ ok: false, message: '请求太大了。' }, { status: 413 })
        }
        return await handler(request)
      },
    }), `model-gateway: ${label}`)
  }

  register(AI_CHAT_PATH, routes.chat, `POST ${AI_CHAT_PATH}`)
  register(AI_STATUS_PATH, routes.status, `POST ${AI_STATUS_PATH}`)
  register(ADMIN_NAMES_PATH, adminRoutes.names, `POST ${ADMIN_NAMES_PATH}`)
  register(ADMIN_BIND_PATH, adminRoutes.bind, `POST ${ADMIN_BIND_PATH}`)
  register(ADMIN_MARKETPLACE_PATH, marketplaceAdminRoute, `POST ${ADMIN_MARKETPLACE_PATH}`)
  register(PLUGIN_LICENSE_PATH, freeLicense.handler, `POST ${PLUGIN_LICENSE_PATH}`)
  register(PLUGIN_SUBMISSIONS_PATH, submissionRoute, `POST ${PLUGIN_SUBMISSIONS_PATH}`)
  register(ORDINARY_SKILL_ADMIN_PATH, ordinarySkills.handler, `POST ${ORDINARY_SKILL_ADMIN_PATH}`)
  register(AI_COMPLETIONS_PATH, completionsRoute.completions, `POST ${AI_COMPLETIONS_PATH}`)
  register(AI_AUDIT_PATH, auditRoutes.audit, `POST ${AI_AUDIT_PATH}`)
  register(ADMIN_AUDIT_PATH, adminAuditRoutes.audit, `POST ${ADMIN_AUDIT_PATH}`)
  register(ADMIN_SUBSCRIPTION_PATH, subscriptionRoutes.grant, `POST ${ADMIN_SUBSCRIPTION_PATH}`)
  register(ADMIN_SUBSCRIPTIONS_PATH, subscriptionRoutes.list, `POST ${ADMIN_SUBSCRIPTIONS_PATH}`)

  // The Mac Host fetches without a browser cookie. This route serves only reviewed public
  // metadata, so it lives outside the cookie-protected `/api` carrier.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => (webCtx as unknown as { webServer: { register: (route: unknown) => () => void } }).webServer.register(ordinarySkillRoute),
      `model-gateway: ordinary skill ${ordinarySkillRoute.path}`)
    if (config.mediaNodes !== undefined) {
      const mediaConfig = config.mediaNodes
      const researchRefs = [mediaConfig.researchDirectoryCredentialRef, mediaConfig.researchDispatchCredentialRef].filter((ref): ref is string => ref !== undefined)
      if (researchRefs.some(ref => !/^[A-Z][A-Z0-9_]{2,127}$/u.test(ref)) || new Set(researchRefs).size !== researchRefs.length
        || researchRefs.some(ref => [mediaConfig.dispatchCredentialRef, mediaConfig.exchangeCredentialRef, mediaConfig.metadataCredentialRef].includes(ref))) throw new Error('RESEARCH_CREDENTIAL_REFERENCE_INVALID')
      const nodeStore = new MediaNodeStore({ path: mediaConfig.storePath,
        heartbeatIntervalMs: mediaConfig.heartbeatIntervalMs, heartbeatTimeoutMs: mediaConfig.heartbeatTimeoutMs,
        ...(mediaConfig.orderAuthorizationPublicKeys === undefined ? {} : { orderAuthorizationPublicKeys: mediaConfig.orderAuthorizationPublicKeys }) })
      const nodeRoutes = createMediaNodeRoutes({ store: nodeStore,
        verifyAccount: createPluginLicenseBearerVerifier({ accountApiOrigin: mediaConfig.accountApiOrigin }),
        maxLongPollRequests: mediaConfig.maxLongPollRequests,
        ...(mediaConfig.researchDirectoryCredentialRef === undefined ? {} : { researchDirectoryToken: async () => {
          const result = await (webCtx.get('credentials') as CredentialsLike | undefined)?.resolve?.(mediaConfig.researchDirectoryCredentialRef!)
          return typeof result === 'string' ? result : result?.value
        } }),
        ...(mediaConfig.researchDispatchCredentialRef === undefined ? {} : { researchDispatchToken: async () => {
          const result = await (webCtx.get('credentials') as CredentialsLike | undefined)?.resolve?.(mediaConfig.researchDispatchCredentialRef!)
          return typeof result === 'string' ? result : result?.value
        } }),
        ...(mediaConfig.exchangeOrigin === undefined ? {} : { mediaExchange: createMediaExchangeHttp(mediaConfig.exchangeOrigin, async () => {
          if (mediaConfig.exchangeCredentialRef === undefined) return undefined
          const result = await (webCtx.get('credentials') as CredentialsLike | undefined)?.resolve?.(mediaConfig.exchangeCredentialRef)
          return typeof result === 'string' ? result : result?.value
        }) }),
        ...(mediaConfig.metadataOrigin === undefined ? {} : { mediaMetadata: createMediaExchangeHttp(mediaConfig.metadataOrigin, async () => {
          if (mediaConfig.metadataCredentialRef === undefined) return undefined
          const result = await (webCtx.get('credentials') as CredentialsLike | undefined)?.resolve?.(mediaConfig.metadataCredentialRef)
          return typeof result === 'string' ? result : result?.value
        }) }),
        ...(mediaConfig.resultVerifierPublicKeys === undefined ? {} : { resultVerifierPublicKeys: mediaConfig.resultVerifierPublicKeys }),
        dispatchToken: async () => {
          if (mediaConfig.dispatchCredentialRef === undefined) return undefined
          const credentials = webCtx.get('credentials') as CredentialsLike | undefined
          const result = await credentials?.resolve?.(mediaConfig.dispatchCredentialRef)
          return typeof result === 'string' ? result : result?.value
        },
      })
      webCtx.effect(() => () => nodeRoutes.close(), 'model-gateway: durable media node channel')
      for (const nodeRoute of nodeRoutes.routes) {
        webCtx.effect(() => (webCtx as unknown as { webServer: { register: (route: unknown) => () => void } }).webServer.register(nodeRoute),
          `model-gateway: media node ${nodeRoute.path}`)
      }
    }
    webCtx.effect(
      () => (webCtx as unknown as { webServer: { register: (route: unknown) => () => void } }).webServer.register(marketRoute),
      `model-gateway: plugin market ${marketRoute.path}`,
    )
    webCtx.effect(
      () => (webCtx as unknown as { webServer: { register: (route: unknown) => () => void } }).webServer.register(releaseRoute),
      `model-gateway: plugin releases ${releaseRoute.path}`,
    )
    webCtx.effect(
      () => (webCtx as unknown as { webServer: { register: (route: unknown) => () => void } }).webServer.register(macLicenseRoute),
      `model-gateway: plugin Mac license ${macLicenseRoute.path}`,
    )
    webCtx.effect(
      () => (webCtx as unknown as { webServer: { register: (route: unknown) => () => void } }).webServer.register(macSubmissionRoute),
      `model-gateway: plugin Mac submissions ${macSubmissionRoute.path}`,
    )
    webCtx.effect(
      () => (webCtx as unknown as { webServer: { register: (route: unknown) => () => void } }).webServer.register(executionAccessRoute),
      `model-gateway: private execution access ${executionAccessRoute.path}`,
    )
  })

  /**
   * 手机端页面：挂在**同源**路径下，这样手机端才会启用订阅通道。
   *
   * 用 `ctx.inject` 而不是把 `webServer` 加进 `inject` 数组：后者会把
   * "这套部署必须有 web 服务器"变成硬约束，而宿主在启动末尾会执行
   * `assertEntriesActivated`——没有 web 服务器的部署会直接起不来。
   * 走回调查询就没这个问题：有就挂，没有就跳过，与 `accountSession` 那两处同样的道理。
   */
  /**
   * 本机模型适配器专用路径。
   *
   * 宿主的 `/api` 门禁要的是**宿主签名的 cookie**，本机适配器没有，
   * 所以它进不来（实测 401 纯文本）。这里另开一条挂在 `/api` 之外的路，
   * 由我们自己把门：**只认 loopback**（用 socket 远端地址判，不看可伪造的请求头）。
   * 这样 `/api` 那道门一个字都不用动。
   *
   * 处理器直接复用 `completionsRoute.completions`——准入、计费、审计与
   * 带会话那条路**完全同一份代码**，不会出现两条路行为不一致。
   */
  ctx.inject(['webServer'], (webCtx) => {
    const localRoute = createLocalOpenAiRoute({
      prefix: config.localOpenAiPrefix ?? LOCAL_OPENAI_PREFIX,
      handle: request => completionsRoute.completions(request),
      onRejected: (detail) => {
        // 越界本身就是异常事件，必须留痕——否则"谁在用"无从追查。
        ctx.logger.warn(`模型网关：拒绝了非本机对本机适配器路径的访问（${detail.remoteAddress} ${detail.url}）`)
      },
    })
    webCtx.effect(
      () => (webCtx as unknown as { webServer: { register: (r: unknown) => () => void } }).webServer.register(localRoute),
      `model-gateway: 本机适配器路径 ${localRoute.path}`,
    )
  })

  const mobileStaticDir = config.mobileStaticDir
  if (mobileStaticDir !== undefined && mobileStaticDir.trim().length > 0) {
    /**
     * 解析静态目录：支持 `~` 展开，相对路径相对**本包位置**而不是进程工作目录。
     *
     * 为什么不能依赖 `process.cwd()`：工作台由 launchd 托管，工作目录是部署方决定的，
     * 同一个配置换个启动方式就会指向不同的地方——那种"配了但找不到"最难查。
     * 本文件的位置是确定的，从它往外推仓库根是可靠的。
     */
    const raw = mobileStaticDir.trim()
    const expanded = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
    const resolved = isAbsolute(expanded)
      ? expanded
      : resolve(fileURLToPath(new URL('../../../../', import.meta.url)), expanded)
    ctx.inject(['webServer'], (webCtx) => {
      const route = createMobileStaticRoute({
        prefix: config.mobileStaticPrefix ?? '/mobile',
        root: resolved,
      })
      webCtx.effect(
        () => (webCtx as unknown as { webServer: { register: (r: unknown) => () => void } }).webServer.register(route),
        `model-gateway: 手机端页面 ${route.path}`,
      )
    })
  }
}
