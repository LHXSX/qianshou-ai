/**
 * 宿主侧账号会话：**电脑端登录的落点**。
 *
 * 为什么宿主侧要单独做一层，而不是让界面直接调账号包：
 *
 * 1. **持久化位置不同**。浏览器端只能把长期凭据交给 cookie 或 localStorage；宿主进程
 *    应当写在 `$DSH_HOME` 下，与其它凭据同处、按同样的权限保护，并且**重启仍在**。
 * 2. **节点进程要用同一个身份**。出算力的守护进程需要的令牌来自「这个账号」，
 *    而它没有浏览器环境。把会话放在宿主侧，界面与节点守护进程才能共用一份登录态。
 * 3. **不碰 CORS**。宿主进程直接发请求，不受浏览器同源策略约束。
 *
 * 权限取舍写在明处：文件是 `0600`，内容是**明文**——与 `credentials-local` 里现有的
 * API key 同级别。不声称它是钥匙串；要升级成系统钥匙串需要新增依赖，那是另一个决定。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  ACCOUNT_API_ORIGIN,
  AccountFailure,
  createAccountClient,
  createSession,
  createTokenStore,
  type Account,
  type AccountClient,
  type AccountSession,
  type AccountSessionState,
} from '@deepseek-ai/dsh-client-account'

/** 凭据文件名；放在 `$DSH_HOME` 下。 */
export const ACCOUNT_STORE_FILENAME = '.qianshou-account.json'

/** 磁盘上的形状；**只存令牌，不存口令**。 */
interface StoredAccount {
  readonly refreshToken?: string
  /** 非密缓存：冷启动先把上次的账号显示出来，再向 `/me` 校正。 */
  readonly account?: Account
}

/**
 * 一次 `/me` 的结果。
 *
 * 为什么不能只回 `Account | null`（这是一处真实缺陷的修法）：`null` 把两件性质完全
 * 不同的事混成了一件——「你没登录」与「服务器连不上」。前者界面该请用户登录，后者
 * 界面该说「稍后再试」；混在一起的结果是后端一抖，用户就看到「请先登录」并去重输口令。
 * 所以失败**必须带原因**，由调用方决定状态码。
 */
export interface LoadAccountOutcome {
  readonly ok: boolean
  /** 成功时的账号快照。 */
  readonly account: Account | null
  /** 失败原因；`ok === true` 时为 `null`。 */
  readonly failure: AccountFailure | null
}

/** 在线核验的默认有效期：60 秒。 */
export const DEFAULT_VERIFY_TTL_MS = 60_000

/**
 * 在线核验失败时，上一次核验结果还能顶多久。
 *
 * 这是被一个**真实的可用性故障**逼出来的：核验走的是上游 `/my/profile`，
 * 而它对瞬时失败零容忍——一次超时/限流/5xx 就 `verified = null`，
 * 网关随即回 401，而界面把它渲染成「API 密钥无效」。订阅制用户根本没有密钥，
 * 于是报错把他引向一个不存在的输入框，而真正发生的是"账号服务抖了一下"。
 *
 * 所以规则改成：**只有确定性拒绝才作废身份**（上游明确说 401/账号停用），
 * 瞬时失败在这个窗口内继续沿用上一次核验过的身份。窗口取值权衡：
 * 太短挡不住抖动，太长会推迟"会话被吊销"的发现——5 分钟是两者之间的折中，
 * 而且吊销还有另一条更快的路径：真正的 401 一到就立刻作废。
 */
export const VERIFY_GRACE_MS = 5 * 60_000

/**
 * 这个失败是不是"等一下就好"。
 *
 * 判据是**上游有没有做出明确决定**：`unauthorized` / `account-disabled` 是决定，
 * 其余（网络、5xx、读不懂、被中断）都是过程问题，不能当成"没登录"。
 * @param kind - 账号失败分类。
 * @returns 是瞬时失败时返回 `true`。
 */
export function isTransientVerifyFailure(kind: string): boolean {
  return kind === 'network' || kind === 'server-error' || kind === 'unparseable' || kind === 'rate-limited' || kind === 'aborted'
}

/** 打开会话时的可注入项。 */
export interface AccountSessionOptions {
  /** `$DSH_HOME`；省略时读 `DSH_HOME` 环境变量，再退到 `~/.dsh`。 */
  readonly dshHome?: string
  /** 接口基址，默认生产域。 */
  readonly baseUrl?: string
  /** 注入的 fetch；测试用。 */
  readonly fetch?: typeof fetch
  /** 凭据文件路径覆盖；测试用。 */
  readonly storePath?: string
}

/** 宿主侧账号会话。 */
export interface HostAccountSession {
  readonly client: AccountClient
  readonly session: AccountSession
  readonly state: () => AccountSessionState
  /** 当前账号（可能来自磁盘缓存）；未登录为 `null`。 */
  readonly account: () => Account | null
  /**
   * 拉一次 `/me`；**失败时把原因一并带出**（供路由决定 401 还是 5xx）。
   * @param signal - 可选取消信号。
   * @returns 结果；成功时 `account` 非空，失败时 `failure` 非空。
   */
  readonly loadAccount: (signal?: AbortSignal) => Promise<LoadAccountOutcome>
  /**
   * **服务端权威**的账号快照。
   *
   * `maxAgeMs`（默认 {@link DEFAULT_VERIFY_TTL_MS}）内复用上一次在线核验的结果，过期就
   * 重取一次 `/me`；失败返回 `null`（**不缓存失败**——一次网络抖动不该变成一分钟不可用）。
   * 角色只信这里的值：它来自服务端响应，而磁盘缓存不构成依据。
   * @param options - 可选 TTL 覆盖。
   * @returns 在线核验过的账号；核验不通过返回 `null`。
   */
  readonly verifiedAccount: (options?: { readonly maxAgeMs?: number }) => Promise<Account | null>
  /**
   * 最近一次在线核验失败的分类；`null` 表示上次核验成功。
   *
   * 给"回响应"的调用方用：它要区分「上游明确拒绝（会话没了）」与
   * 「核验过程抖动（账号服务暂时不可用）」，因为用户对这两种要做的事完全不同。
   */
  readonly lastVerifyFailure: () => string | null
  /**
   * 取一个**当前可用**的 access token，供调用上游接口。
   *
   * 冷启动时内存里没有 access token（它刻意不落盘，短期凭据写在磁盘上只会多一个泄露面），
   * 所以这里会先把磁盘上的 refresh token 读回内存（`hydrate`），必要时换一次新的。
   * 不复用 `readAccess()` 直接返回，是因为那样调用方会在每次重启后拿到 `null`，
   * 表现为「重启就要重新登录」——而这正是最容易被写漏的一步。
   * @returns 可用的 access token；没有登录或刷新失败时返回 `null`。
   */
  readonly ensureAccessToken: () => Promise<string | null>
  /** 登出：通知服务端撤销会话，并清本机凭据。 */
  readonly signOut: () => Promise<void>
  /** 凭据文件路径（供界面展示与排障）。 */
  readonly storePath: string
}

/** 解析 `$DSH_HOME`，与仓库其它凭据的落点规则保持一致。 */
function resolveHome(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit
  const fromEnv = process.env['DSH_HOME']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const home = process.env['HOME']
  return home === undefined ? process.cwd() : join(home, '.dsh')
}

/**
 * 打开（或新建）宿主侧账号会话。
 *
 * 冷启动时会读回磁盘上的账号缓存，所以界面不必等一次网络往返就知道「上次是谁」；
 * 令牌是否仍有效由第一次受保护请求决定。
 * @param options - 可注入的 HOME、基址、fetch 与文件路径。
 * @returns 宿主侧账号会话。
 */
export async function openHostAccount(options: AccountSessionOptions = {}): Promise<HostAccountSession> {
  const storePath = options.storePath ?? join(resolveHome(options.dshHome), ACCOUNT_STORE_FILENAME)
  const stored = await readStore(storePath)
  const baseUrl = options.baseUrl ?? ACCOUNT_API_ORIGIN
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)

  /**
   * 允许把长期凭据写进磁盘吗。
   *
   * 为什么必须有这个闸门（WP1 A-17）：`/me` 触发的刷新与「用户点登出」可以**同时在路上**。
   * 刷新先发出、登出先完成时，刷新的响应回来还会把新的长期凭据写回磁盘——用户看到已登出，
   * 磁盘上却留着一枚仍然有效的长期凭据。下一个访问这台机器的人（或任何同用户进程）拿它就能
   * 继续用这个账号。
   *
   * 闸门是**一次登出就关上、只有一次新的登录才重新打开**：关掉之后到达的写入一律丢弃。
   * 不按"此刻的会话状态"判断，是因为冷启动时的刷新发生在状态还是 `signed-out` 的时候，
   * 那种合法的写入必须被允许。
   */
  let writesAllowed = true
  /** 最近一次落盘；登出要等它落定，才能保证"最后一刀"确实在后（A-17）。 */
  let inFlightWrite: Promise<void> = Promise.resolve()

  const tokens = createTokenStore({
    // 宿主不是浏览器：没有 httpOnly cookie 这回事，长期凭据只能自己保管。
    cookiesAvailable: false,
    refreshStore: {
      read: async () => (await readStore(storePath)).refreshToken ?? null,
      write: async (token: string) => {
        // 闸门关着（已登出）时到达的刷新结果不再落盘。
        if (!writesAllowed) return
        inFlightWrite = updateStore(storePath, current => ({ ...current, refreshToken: token }))
        await inFlightWrite
      },
      clear: async () => {
        await updateStore(storePath, ({ refreshToken: _dropped, ...rest }) => rest)
      },
    },
  })

  const session = createSession({ baseUrl, fetch: fetchImpl, tokens })
  const rawClient = createAccountClient({ baseUrl, fetch: fetchImpl, tokens })
  /**
   * 登录会**重新打开**写入闸门：一次新的登录意味着新的登录态，它的令牌必须能落盘。
   * 在调用**之前**打开——令牌是在登录请求的过程中写进去的，事后打开就晚了。
   */
  const client = {
    ...rawClient,
    login: async (input: Parameters<typeof rawClient.login>[0]) => {
      writesAllowed = true
      return await rawClient.login(input)
    },
    loginTotp: async (input: Parameters<typeof rawClient.loginTotp>[0]) => {
      writesAllowed = true
      return await rawClient.loginTotp(input)
    },
  }
  let account: Account | null = stored.account ?? null
  /** 最近一次**在线核验**的结果与时刻；见 `verifiedAccount`。 */
  let verified: { readonly account: Account; readonly at: number } | null = null
  /** 最近一次核验失败的分类；`null` 表示没失败过。用来把"服务抖动"与"没登录"分开报。 */
  let lastVerifyFailure: string | null = null

  /** 真的去拉一次 `/me`，并把结果记进缓存。失败**不进缓存**。 */
  const loadAccount = async (signal?: AbortSignal): Promise<LoadAccountOutcome> => {
    const result = await session.requestProtected({
      path: '/my/profile',
      operation: 'me',
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!result.ok) {
      lastVerifyFailure = result.failure.kind
      // **只有确定性拒绝才作废身份。** 瞬时失败把 `verified` 留着，
      // 由 `verifiedAccount` 按宽限期决定还能不能继续用（见 `VERIFY_GRACE_MS`）。
      if (!isTransientVerifyFailure(result.failure.kind)) verified = null
      return { ok: false, account: null, failure: result.failure }
    }
    lastVerifyFailure = null
    const parsed = pickAccount(result.payload)
    if (parsed === null) {
      // 上游说 ok 却给不出可识别的账号：这是契约对不上，不是"没登录"。
      verified = null
      return {
        ok: false,
        account: null,
        failure: new AccountFailure('unparseable', '账号信息读不出来，请稍后再试。', {
          status: result.status,
          operation: 'me',
        }),
      }
    }
    account = parsed
    session.markAuthenticated()
    verified = { account: parsed, at: Date.now() }
    lastVerifyFailure = null
    await updateStore(storePath, current => ({ ...current, account: parsed }))
    return { ok: true, account: parsed, failure: null }
  }

  return {
    client,
    session,
    storePath,
    state: () => session.state(),
    account: () => account,
    loadAccount,
    verifiedAccount: async (verifyOptions) => {
      const maxAgeMs = verifyOptions?.maxAgeMs ?? DEFAULT_VERIFY_TTL_MS
      if (verified !== null && Date.now() - verified.at < maxAgeMs) return verified.account
      const outcome = await loadAccount()
      if (outcome.account !== null) return outcome.account
      // 核验没成功：只有在"失败是瞬时的"且"上一次核验还在宽限期内"时才继续认人。
      // 两个条件缺一不可——少了前者会把会话吊销拖到宽限期结束，
      // 少了后者会让一次抖动在任意久之后仍然被信任。
      if (
        verified !== null
        && lastVerifyFailure !== null
        && isTransientVerifyFailure(lastVerifyFailure)
        && Date.now() - verified.at < maxAgeMs + VERIFY_GRACE_MS
      ) {
        return verified.account
      }
      return null
    },
    /** 最近一次核验失败的分类；`null` 表示上次核验是成功的。 */
    lastVerifyFailure: () => lastVerifyFailure,
    ensureAccessToken: async () => {
      await tokens.hydrate()
      const current = tokens.readAccess()
      if (current !== null && !tokens.isAccessExpired()) return current
      // 过期或没有：拿长期凭据换一次。失败就是没登录/已被撤销。
      const refreshed = await session.refresh()
      return refreshed ? tokens.readAccess() : null
    },
    signOut: async () => {
      // 先关闸门：此后到达的在途刷新结果一律不落盘（下一次登录会重新打开）。
      writesAllowed = false
      try {
        await session.requestProtected({ path: '/auth/logout', operation: 'logout', method: 'POST' })
      } catch {
        // 服务端撤销失败不该把用户卡在登录态：本机凭据照清。
      }
      // 等已在路上的写入落定，再清——顺序反了就会留下"登出后磁盘还有长期凭据"。
      await inFlightWrite.catch(() => { /* 写盘失败不影响登出 */ })
      await session.signOut()
      // 最后一刀：会话层清过之后仍可能有迟到的写入，这里再确认一次。
      await updateStore(storePath, ({ refreshToken: _dropped, account: _alsoDropped, ...rest }) => rest)
      account = null
      verified = null
    },
  }
}

/** 读凭据文件；不存在或损坏一律当空，不抛。 */
async function readStore(path: string): Promise<StoredAccount> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return {}
    return parsed
  } catch {
    return {}
  }
}

/**
 * 同一路径的写入链。
 *
 * 为什么必须是**每条路径一条链**而不是一个全局锁：不同 DSH home 之间没有共享状态，
 * 没必要互相等；而同一条路径上的重叠写入才是真问题——三处调用点（登录写令牌、
 * `/me` 写账号、登出清凭据）都是"读—改—写"，交错执行时后写的会把先写的**整体覆盖**，
 * 表现为"明明登录了，重启后却没有令牌"（WP1 A-17）。
 */
const writeChains = new Map<string, Promise<void>>()

/**
 * 读—改—写同一个凭据文件，**按路径串行**。
 * @param path - 凭据文件。
 * @param mutate - 由当前内容算出新内容；返回值整体覆盖写盘。
 */
async function updateStore(path: string, mutate: (current: StoredAccount) => StoredAccount): Promise<void> {
  const previous = writeChains.get(path) ?? Promise.resolve()
  // 前一次失败不该让这条链永远失败：吞掉它的结果，只保证顺序。
  const next = previous.catch(() => { /* 只关心顺序，不关心上一次的成败 */ }).then(async () => {
    await writeStore(path, mutate(await readStore(path)))
  })
  writeChains.set(path, next.catch(() => { /* 链尾只用于排他，不承载结果 */ }))
  await next
}

/** 原子写凭据文件，并收紧到 `0600`。 */
async function writeStore(path: string, value: StoredAccount): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  // 先写临时文件再改名：半个文件写坏会让下次冷启动拿到无法解析的凭据。
  await rename(temp, path)
}

/** 从响应体里取账号；上游可能包一层，也可能直接铺在顶层。 */
function pickAccount(payload: unknown): Account | null {
  if (payload === null || typeof payload !== 'object') return null
  const source = payload as Record<string, unknown>
  const nested = [source['account'], source['user'], source['profile']].find(v => v !== null && typeof v === 'object')
  const fields = (nested ?? source) as Record<string, unknown>
  const id = fields['id']
  if (typeof id !== 'number' && typeof id !== 'string') return null
  const balance = fields['balance']
  return {
    id,
    username: typeof fields['username'] === 'string' ? fields['username'] : '',
    email: typeof fields['email'] === 'string' ? fields['email'] : '',
    role: typeof fields['role'] === 'string' ? fields['role'] : 'personal',
    status: typeof fields['status'] === 'string' ? fields['status'] : 'active',
    balance: typeof balance === 'string' || typeof balance === 'number' ? balance : null,
    created_at: typeof fields['created_at'] === 'string' ? fields['created_at'] : null,
    last_login_at: typeof fields['last_login_at'] === 'string' ? fields['last_login_at'] : null,
  }
}

// ── 宿主插件面 ────────────────────────────────────────────────────────────────
// 库入口只导出会话本身；插件面（`apply` / 路由）单独在 `plugin.ts`。
// 这里把插件面一并导出，是为了让 profiles 与测试可以用同一个说明符拿到两者，
// 而不必记住两个导入路径。
export { apply, inject, name, type Config } from './plugin.ts'
