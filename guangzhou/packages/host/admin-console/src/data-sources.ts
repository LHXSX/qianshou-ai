/**
 * 业务数据源（只读）。
 *
 * 这一层是"管理台"和"数据的属主服务"之间的接缝，形态是刻意的：
 *
 * - **只读**。管理台目前只读工作台的落盘快照（账本、订阅），因为**写**属于属主服务
 *   （模型网关的账本与订阅存储都在工作台进程里，它没有对外暴露管理写接口）。
 *   于是"异常扣费处理"这类操作在本版**如实返回依赖未就绪**，而不是我们偷偷去改
 *   别人的文件——那样做出来的"能改"是假的：工作台内存里的状态不会跟着变，
 *   下一次结算就会把我们改的值覆盖掉，而用户会以为钱已经退了。
 * - **路径可配**。默认读 `/srv/qianshou-home`（工作台的 `DSH_HOME`）。
 * - **读不懂就当没有**。快照文件坏了/版本不认识 → 返回空集合并给出原因，
 *   绝不猜一份出来。
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** 账本快照文件名（与 `packages/host/model-gateway/src/persistence.ts` 一致）。 */
export const LEDGER_STORE_FILENAME = '.qianshou-ledger.json'

/** 订阅快照文件名（与 `packages/host/model-gateway/src/tier-store.ts` 一致）。 */
export const TIER_STORE_FILENAME = '.qianshou-subscriptions.json'

/** 微 SP → SP（与模型网关同一个换算）。 */
export const MICRO_SP_PER_SP = 1_000_000

/** 一份数据源的可用性说明。 */
export interface SourceStatus {
  readonly path: string
  readonly available: boolean
  /** 读不到时的原因（可直接展示给管理员）。 */
  readonly detail: string
  /** 数据由谁产生（对账时要能追）。 */
  readonly owner: string
}

/** 账号维度的额度视图。 */
export interface AccountSummary {
  readonly accountId: string
  readonly tier: string
  readonly grantedSp: number
  readonly usedSp: number
  readonly reservedSp: number
  readonly remainingSp: number
  readonly callCount: number
  readonly lastCallAt: number | null
}

/** 一次调用的流水。 */
export interface LedgerCallView {
  readonly at: number
  readonly model: string
  readonly tier: string
  /** 上游后端键：内部字段，只给管理面（用户看到的是前台模型名）。 */
  readonly backendKey: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly sp: number
}

/** 账本读取器。 */
export interface LedgerReader {
  readonly status: () => Promise<SourceStatus>
  readonly accounts: () => Promise<readonly AccountSummary[]>
  readonly account: (accountId: string) => Promise<AccountSummary | null>
  readonly calls: (accountId: string, options?: { readonly limit?: number; readonly offset?: number }) => Promise<{
    readonly total: number
    readonly entries: readonly LedgerCallView[]
  }>
}

/** 订阅记录视图。 */
export interface SubscriptionView {
  readonly accountId: string
  readonly tier: string
  readonly from: number
  readonly to: number | null
  readonly grantedBy: string
  readonly reason: string
  readonly active: boolean
}

/** 订阅读取器。 */
export interface SubscriptionReader {
  readonly status: () => Promise<SourceStatus>
  readonly list: () => Promise<readonly SubscriptionView[]>
}

/** 从任意值里取对象。 */
function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** 取数组字段。 */
function arrayOf(source: Record<string, unknown>, key: string): readonly unknown[] {
  const value = source[key]
  return Array.isArray(value) ? value : []
}

/** 非负整数判定。 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 字符串判定。 */
function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * 把快照里的时间戳字段渲染成可读文本。
 *
 * 为什么需要它：`savedAt` 来自磁盘上的 JSON，类型是 `unknown`；直接塞进模板字符串
 * 在对象上会渲染成 `[object Object]`——一句看起来正常、实际毫无信息的说明。
 * @param value - 快照字段。
 * @returns 数字按毫秒时间渲染，其余如实说明"读不出来"。
 */
function describeStamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}（${new Date(value).toISOString()}）`
  return value === undefined ? '未写' : '不是时间戳'
}

/** 微 SP → SP（保留两位，展示用；金额不四舍五入成整数）。 */
export function toSp(microSp: number): number {
  return Math.round((microSp / MICRO_SP_PER_SP) * 100) / 100
}

/**
 * 建账本读取器。
 * @param options - `DSH_HOME` 路径。
 * @returns 读取器。
 */
export function createLedgerReader(options: { readonly dshHome: string }): LedgerReader {
  const path = `${options.dshHome.replace(/\/+$/, '')}/${LEDGER_STORE_FILENAME}`

  /** 读一次快照（每次调用都读盘：账本是工作台在写的活跃文件，缓存会展示过期余额）。 */
  const load = async (): Promise<{ snapshot: Record<string, unknown> | null; detail: string }> => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      const code = (error as { code?: string }).code
      return {
        snapshot: null,
        detail: code === 'ENOENT'
          ? '账本快照文件还不存在（工作台尚未落盘过账本：没有付费调用时它不会产生文件）。'
          : `账本快照读不到：${String(code ?? error)}`,
      }
    }
    try {
      const parsed = objectOf(JSON.parse(text) as unknown)
      if (parsed === null) return { snapshot: null, detail: '账本快照不是对象。' }
      return { snapshot: parsed, detail: '' }
    } catch {
      return { snapshot: null, detail: '账本快照不是合法 JSON（文件可能正在写入或被截断）。' }
    }
  }

  const summaryOf = (snapshot: Record<string, unknown> | null): readonly AccountSummary[] => {
    if (snapshot === null) return []
    const grants = new Map<string, { microSp: number; tier: string }>()
    for (const row of arrayOf(snapshot, 'grants')) {
      const entry = objectOf(row)
      if (entry === null) continue
      const accountId = entry['accountId']
      const tier = entry['tier']
      const microSp = entry['microSp']
      if (!isName(accountId) || !isCount(microSp)) continue
      const previous = grants.get(accountId)
      // 同一账号在同一账期只应有一条授予；多条时取最新（金额更大的那条不做猜测，
      // 直接累加会把"重复授予"当成"额度翻倍"）。
      grants.set(accountId, { microSp: previous === undefined ? microSp : Math.max(previous.microSp, microSp), tier: typeof tier === 'string' ? tier : 'unknown' })
    }

    const used = new Map<string, { microSp: number; calls: number; lastAt: number | null }>()
    for (const row of arrayOf(snapshot, 'records')) {
      const entry = objectOf(row)
      if (entry === null) continue
      const accountId = entry['accountId']
      const microSp = entry['microSp']
      const at = entry['at']
      if (!isName(accountId) || !isCount(microSp)) continue
      const previous = used.get(accountId) ?? { microSp: 0, calls: 0, lastAt: null }
      used.set(accountId, {
        microSp: previous.microSp + microSp,
        calls: previous.calls + 1,
        lastAt: previous.lastAt === null ? (isCount(at) ? at : null) : Math.max(previous.lastAt, isCount(at) ? at : 0),
      })
    }
    // 断线调用已经花的钱也要算进已用（工作台的账本里它是独立一段）。
    for (const row of arrayOf(snapshot, 'partialCharges')) {
      const entry = objectOf(row)
      if (entry === null) continue
      const accountId = entry['accountId']
      const microSp = entry['microSp']
      if (!isName(accountId) || !isCount(microSp)) continue
      const previous = used.get(accountId) ?? { microSp: 0, calls: 0, lastAt: null }
      used.set(accountId, { microSp: previous.microSp + microSp, calls: previous.calls, lastAt: previous.lastAt })
    }

    const reserved = new Map<string, number>()
    for (const row of arrayOf(snapshot, 'reservations')) {
      const entry = objectOf(row)
      if (entry === null) continue
      const accountId = entry['accountId']
      const microSp = entry['microSp']
      if (!isName(accountId) || !isCount(microSp)) continue
      reserved.set(accountId, (reserved.get(accountId) ?? 0) + microSp)
    }

    const ids = new Set([...grants.keys(), ...used.keys()])
    return [...ids].sort().map((accountId) => {
      const granted = grants.get(accountId)?.microSp ?? 0
      const consumed = used.get(accountId)?.microSp ?? 0
      const held = reserved.get(accountId) ?? 0
      return {
        accountId,
        tier: grants.get(accountId)?.tier ?? '未知',
        grantedSp: toSp(granted),
        usedSp: toSp(consumed),
        reservedSp: toSp(held),
        // 剩余额度按"授予 − 已用 − 预留"算，与网关的准入判定同一口径。
        remainingSp: toSp(Math.max(granted - consumed - held, 0)),
        callCount: used.get(accountId)?.calls ?? 0,
        lastCallAt: used.get(accountId)?.lastAt ?? null,
      }
    })
  }

  const callsOf = (snapshot: Record<string, unknown> | null, accountId: string): readonly LedgerCallView[] => {
    if (snapshot === null) return []
    const rows: LedgerCallView[] = []
    for (const row of arrayOf(snapshot, 'records')) {
      const entry = objectOf(row)
      if (entry === null) continue
      if (entry['accountId'] !== accountId) continue
      const at = entry['at']
      const microSp = entry['microSp']
      rows.push({
        at: isCount(at) ? at : 0,
        model: typeof entry['publishedName'] === 'string' ? entry['publishedName'] : '未知',
        tier: typeof entry['tier'] === 'string' ? entry['tier'] : '未知',
        backendKey: typeof entry['backendKey'] === 'string' ? entry['backendKey'] : '',
        inputTokens: isCount(entry['inputTokens']) ? entry['inputTokens'] : 0,
        outputTokens: isCount(entry['outputTokens']) ? entry['outputTokens'] : 0,
        sp: isCount(microSp) ? toSp(microSp) : 0,
      })
    }
    return rows.sort((left, right) => right.at - left.at)
  }

  return {
    status: async () => {
      const { snapshot, detail } = await load()
      return {
        path,
        available: snapshot !== null,
        detail: snapshot === null ? detail : `账本快照已读到（savedAt=${describeStamp(snapshot['savedAt'])}）。`,
        owner: '模型网关（工作台进程）',
      }
    },
    accounts: async () => summaryOf((await load()).snapshot),
    account: async accountId => summaryOf((await load()).snapshot).find(item => item.accountId === accountId) ?? null,
    calls: async (accountId, callOptions = {}) => {
      const rows = callsOf((await load()).snapshot, accountId)
      const limit = Math.min(Math.max(Math.floor(callOptions.limit ?? 50), 1), 500)
      const offset = Math.max(Math.floor(callOptions.offset ?? 0), 0)
      return { total: rows.length, entries: rows.slice(offset, offset + limit) }
    },
  }
}

/**
 * 建订阅读取器。
 * @param options - `DSH_HOME` 路径与时钟。
 * @returns 读取器。
 */
export function createSubscriptionReader(options: { readonly dshHome: string; readonly now?: () => number }): SubscriptionReader {
  const now = options.now ?? (() => Date.now())
  const path = `${options.dshHome.replace(/\/+$/, '')}/${TIER_STORE_FILENAME}`

  const load = async (): Promise<{ rows: readonly SubscriptionView[]; status: SourceStatus }> => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      const code = (error as { code?: string }).code
      return {
        rows: [],
        status: {
          path,
          available: false,
          detail: code === 'ENOENT'
            ? '订阅快照文件还不存在（还没有任何管理员开通或购买过订阅）。'
            : `订阅快照读不到：${String(code ?? error)}`,
          owner: '模型网关（工作台进程）',
        },
      }
    }
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = objectOf(JSON.parse(text) as unknown)
    } catch {
      parsed = null
    }
    if (parsed === null) {
      return { rows: [], status: { path, available: false, detail: '订阅快照不是合法 JSON。', owner: '模型网关（工作台进程）' } }
    }
    const at = now()
    const rows: SubscriptionView[] = []
    for (const row of arrayOf(parsed, 'subscriptions')) {
      const entry = objectOf(row)
      if (entry === null) continue
      const accountId = entry['accountId']
      const tier = entry['tier']
      const from = entry['from']
      if (!isName(accountId) || typeof tier !== 'string' || !isCount(from)) continue
      const to = isCount(entry['to']) ? entry['to'] : null
      rows.push({
        accountId,
        tier,
        from,
        to,
        grantedBy: typeof entry['grantedBy'] === 'string' ? entry['grantedBy'] : '',
        reason: typeof entry['reason'] === 'string' ? entry['reason'] : '',
        // 有效性口径与 `tier-store.ts` 一致：已生效且未过期。
        active: from <= at && (to === null || to > at),
      })
    }
    return {
      rows: rows.sort((left, right) => right.from - left.from),
      status: {
        path,
        available: true,
        detail: `订阅快照已读到（${rows.length} 条，savedAt=${describeStamp(parsed['savedAt'])}）。`,
        owner: '模型网关（工作台进程）',
      },
    }
  }

  return {
    status: async () => (await load()).status,
    list: async () => (await load()).rows,
  }
}

/** 档位目录里的一档（形状与 `model-gateway` 的 `TIERS` 对齐）。 */
export interface TierView {
  readonly id: string
  readonly label: string
  readonly monthlySp: number
  readonly monthlyYuan: number
  readonly contextLimitTokens: number
  readonly concurrency: number
  readonly windowFiveHourSp: number
}

/** 档位目录读取结果。 */
export interface TierCatalogResult {
  /** 读到来源（文件路径）时为 `true`。 */
  readonly available: boolean
  readonly source: string
  readonly detail: string
  readonly tiers: readonly TierView[]
}

/**
 * 动态读取**模型网关的档位目录**（`tiers.ts`）。
 *
 * 为什么不在这里抄一份档位表：档位价格与额度是**计费口径**，两处各存一份必然漂移，
 * 而漂移的后果是管理台显示的价格与实际扣费不一致——对账时最难解释的那种不一致。
 * 读不到就如实说读不到（`available: false`），不退化成本地默认值。
 * @param options - `tiers.ts` 的路径（部署时可配）。
 * @returns 目录结果。
 */
export async function readTierCatalog(options: { readonly tiersPath: string }): Promise<TierCatalogResult> {
  const source = options.tiersPath
  try {
    const module_ = await import(pathToFileURL(source).href) as { TIERS?: unknown }
    const tiers = objectOf(module_.TIERS)
    if (tiers === null) {
      return { available: false, source, detail: '档位目录文件里没有导出 TIERS。', tiers: [] }
    }
    const rows: TierView[] = []
    for (const [id, raw] of Object.entries(tiers)) {
      const entry = objectOf(raw)
      if (entry === null) continue
      rows.push({
        id,
        label: typeof entry['label'] === 'string' ? entry['label'] : id,
        monthlySp: isCount(entry['monthlySp']) ? entry['monthlySp'] : 0,
        monthlyYuan: isCount(entry['monthlyYuan']) ? entry['monthlyYuan'] : 0,
        contextLimitTokens: isCount(entry['contextLimitTokens']) ? entry['contextLimitTokens'] : 0,
        concurrency: isCount(entry['concurrency']) ? entry['concurrency'] : 0,
        windowFiveHourSp: isCount(entry['windowFiveHourSp']) ? entry['windowFiveHourSp'] : 0,
      })
    }
    return { available: true, source, detail: `档位目录来自 ${source}。`, tiers: rows }
  } catch (error) {
    return {
      available: false,
      source,
      detail: `读不到档位目录（${error instanceof Error ? error.message : String(error)}）。`,
      tiers: [],
    }
  }
}
