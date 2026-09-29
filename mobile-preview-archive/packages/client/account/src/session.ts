/**
 * 会话层：把「有 bearer 的请求」与「长期凭据怎么续」这两件事收在一处。
 *
 * 为什么单独一层：`auth.ts` 里每个端点都要写「带 access token → 401 就刷新一次再重试」，
 * 重复十遍必然会有一处漏掉，而漏掉的那处就是用户看到的「莫名其妙被登出」。
 * 这里只写一遍：受保护请求统一走 `requestProtected()`。
 *
 * 刷新策略（也见 `tokens.ts` 的文件头）：
 * - cookie 可用时**只靠 httpOnly cookie**，刷新请求体里不放长期凭据；
 * - cookie 不可用（非安全上下文、Tauri 等）才退化为请求体里带 refresh token。
 *
 * 一次额外的自愈：cookie 模式登录成功后，服务端可能因为浏览器策略（第三方 cookie、
 * 非安全上下文、SameSite）没有真正种下 cookie。此时第一次刷新会 401；只要响应里
 * 顺带给了我们 refresh token 值，就**改走 body 模式再刷一次**——用户在登录时已经
 * 交出口令，不该因为 cookie 策略被莫名其妙登出。这条退化只在「确实拿得到明文令牌」
 * 时触发，拿不到就如实报「登录状态已过期」。
 */
import { ENDPOINTS, accountUrl } from './endpoints.ts'
import { AccountFailure, type AccountOperation, type UpstreamErrorPayload } from './failures.ts'
import { sendRequest, type FetchLike, type TransportConfig, type TransportRequest, type TransportResult } from './http.ts'
import type { TokenPair } from './types.ts'
import type { TokenStore } from './tokens.ts'

/**
 * 会话状态。
 *
 * `expired` 与 `signed-out` 分开：前者是「本来登录着，长期凭据失效了」，
 * 界面应当先说明原因再引导重新登录；后者是「本来就没登录」，直接展示登录页即可。
 */
export type AccountSessionState = 'signed-out' | 'authenticated' | 'expired'

/** 会话层构造参数。 */
export interface SessionConfig {
  /** 接口基址，例如 `https://qianshousuanli.com`；末尾斜杠会被忽略。 */
  readonly baseUrl: string
  /** 注入的 fetch。 */
  readonly fetch: FetchLike
  /** 令牌存储（access 内存 + 可选的 refresh 持久化端口）。 */
  readonly tokens: TokenStore
  /** 可选的前缀覆盖，默认 `/api/v8`；打桩服务器用它把整段前缀换掉。 */
  readonly prefix?: string
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs?: number
}

/** 会话层。 */
export interface AccountSession {
  /** 发一个需要登录的请求；遇 401 会先刷新再重试一次。 */
  readonly requestProtected: (input: ProtectedRequest) => Promise<TransportResult>
  /** 发一个匿名请求（注册、登录、2FA 补验、刷新）。 */
  readonly requestPublic: (input: ProtectedRequest) => Promise<TransportResult>
  /** 刷新一次长期凭据。并发调用共享同一次刷新。 */
  readonly refresh: (signal?: AbortSignal) => Promise<boolean>
  /** 清理令牌并把状态置为 `signed-out`。 */
  readonly signOut: () => Promise<void>
  /** 当前状态。 */
  readonly state: () => AccountSessionState
  /**
   * 标记「刚刚拿到令牌，会话已建立」。
   *
   * 为什么由调用方显式标记，而不是让令牌存储回调会话：状态机只能有一个驱动者。
   * 若令牌存储偷偷改状态，会话层与业务层就会各持一份互相矛盾的判断。
   */
  readonly markAuthenticated: () => void
  /** 冻结一个 `AccountFailure`：长期凭据失效，界面应回到登录页。 */
  readonly markExpired: () => void
  /** 订阅状态变化；返回取消订阅函数。 */
  readonly subscribe: (listener: (state: AccountSessionState) => void) => () => void
}

/** 一次请求描述（不含 URL：URL 由会话层按 baseUrl 拼）。 */
export interface ProtectedRequest {
  readonly path: string
  readonly operation: AccountOperation
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly body?: Readonly<Record<string, unknown>>
  readonly secrets?: readonly (string | null | undefined)[]
  readonly signal?: AbortSignal
}

/** 刷新时用什么方式带上长期凭据。 */
type RefreshMode = 'cookie' | 'body'

/** 会话层实现。 */
export function createSession(config: SessionConfig): AccountSession {
  const transport: TransportConfig = { fetch: config.fetch, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) }
  const prefix = config.prefix
  const url = (path: string): string => accountUrl(config.baseUrl, path, prefix)
  const listeners = new Set<(state: AccountSessionState) => void>()
  let hasSession = false
  let state: AccountSessionState = 'signed-out'
  /** 正在进行的刷新：并发请求共享它，避免一次操作打出十个刷新请求（也避免触发限流）。 */
  let refreshing: Promise<boolean> | null = null
  /** 运行期是否已确认 cookie 不可用（第一次刷新被拒后置位）。 */
  let cookieRejected = false
  /**
   * 最近一次刷新的**真实**失败原因；刷新成功或从未发生过时为 `null`。
   *
   * 为什么需要它（WP1 A-19）：`refresh()` 的对外契约是布尔的，于是"我们根本没问成"
   * （网络不通、超时、用户取消）与"服务端说凭据不行"在外面长得一模一样，
   * 都被报成 `unauthorized`。界面据此显示「登录状态已过期，请重新登录」，
   * 而用户真正需要的提示是「连不上，稍后再试」。这里把原因留下来给调用点用。
   */
  let lastRefreshFailure: AccountFailure | null = null
  /**
   * 登录代数：每次登出 +1。
   *
   * 为什么需要它（WP1 A-17）：刷新可以**跨过一次登出**——它先发出、登出先完成、响应后回来。
   * 旧实现在那种情况下仍然会写令牌并把状态改回 `authenticated`，于是界面在用户明明已经
   * 登出之后又变回"已登录"，而磁盘上还多了一枚新的长期凭据。发起刷新时记下代数，
   * 收尾前对一次：对不上就整个作废（不写令牌、不改状态）。
   */
  let generation = 0

  const setState = (next: AccountSessionState): void => {
    if (state === next) return
    state = next
    for (const listener of listeners) listener(next)
  }

  /**
   * 凭证彻底没了时的收尾：清令牌，并按「本来有没有登录过」决定状态。
   *
   * 这个区分是刻意的：冷启动时本来就没登录过，此时报 `expired`（「你的登录过期了」）
   * 会让界面显示一句与事实不符的提示，还会把用户引向「重新登录」而不是「去登录」。
   * 判据取当前状态而不是另设一个布尔量——两处状态机是这类代码最容易分叉的地方。
   */
  const loseSession = async (before: boolean): Promise<void> => {
    await config.tokens.clear()
    setState(before ? 'expired' : 'signed-out')
  }

  /**
   * 把一次业务请求翻成传输请求。
   *
   * 可选字段用 `?? null` 显式写出来，不做条件展开：展开写法在调用点看不出「到底发了什么」，
   * 而请求体是该层唯一需要被读清楚的输出。
   */
  const transportRequest = (request: ProtectedRequest, bearer: string | null): TransportRequest => ({
    url: url(request.path),
    operation: request.operation,
    method: request.method,
    bearer,
    body: request.body ?? null,
    secrets: request.secrets ?? null,
    signal: request.signal ?? null,
  })

  const call = (request: ProtectedRequest): Promise<TransportResult> =>
    sendRequest(transport, transportRequest(request, null))

  /**
   * 带一个 access token 发受保护请求。
   *
   * 令牌由调用方读出并传入，本函数不接受「没有令牌」：发出一次没有 bearer 的请求在服务端
   * 看来是匿名访问，会得到与登录态完全不同的响应，那比一次明确的失败更难查。
   * 所以「读不到令牌」必须由调用点在之前就处理掉（见 `requestProtected` 的两处判空）。
   */
  const callWithToken = (request: ProtectedRequest, token: string): Promise<TransportResult> =>
    sendRequest(transport, transportRequest(request, token))

  /** 决定这次刷新怎么带长期凭据。 */
  const resolveRefreshMode = (): RefreshMode => {
    if (config.tokens.source() === 'body') return 'body'
    if (cookieRejected) return 'body'
    return 'cookie'
  }

  /**
   * 真正发刷新请求。
   *
   * 注意这里**绝不**递归：刷新失败就是失败，不会再触发一次刷新。否则一个失效的
   * refresh token 会变成无限循环，而每轮循环都在给上游限流计数。
   */
  const performRefresh = async (signal?: AbortSignal): Promise<boolean> => {
    const startedAt = generation
    await config.tokens.hydrate()
    const mode = resolveRefreshMode()
    const refreshToken = config.tokens.readRefresh()
    /**
     * 「本来有没有可续期的凭据」必须在清空**之前**取样。
     *
     * 它决定最后报哪一句：文件里留着一个（已经被服务端拒掉的）refresh token，说明用户
     * 之前登录过，该说「登录状态已过期」；从来没有过，该说「请先登录」。
     * 清空之后再问，两个情形都会答「没有」，文案就再也分不出来了。
     */
    const hadCredential = hasSession || refreshToken !== null
    // body 模式必须真的有一个令牌；没有就说明从未拿到过长期凭据，直接失败。
    if (mode === 'body' && refreshToken === null) {
      // 这是"从来没有可续期的凭据"，不是网络问题。
      lastRefreshFailure = null
      await loseSession(hadCredential)
      return false
    }
    const body: Record<string, unknown> = mode === 'body' && refreshToken !== null ? { refresh_token: refreshToken } : {}
    const result = await sendRequest(transport, {
      url: url(ENDPOINTS.refresh),
      operation: 'refresh',
      method: 'POST',
      body,
      bearer: null,
      secrets: [refreshToken],
      signal: signal ?? null,
    })
    if (!result.ok) {
      // cookie 模式被拒且我们手里还有明文令牌：浏览器没种下 cookie，退化为 body 再试一次。
      // 这是唯一的「刷新里的刷新」，且只发生一次（cookieRejected 置位后不再回到 cookie 模式）。
      if (mode === 'cookie' && result.status === 401 && refreshToken !== null) {
        cookieRejected = true
        return performRefresh(signal)
      }
      /**
       * 「用户取消」和「网络断了」都不作废凭据。
       *
       * 它们的共同点是**我们并没有从服务端得到任何判断**：凭据可能还是好的，只是这次没问成。
       * 把这些情形也当成失效，用户会看到「你点了取消，于是被登出」——这在真实使用里
       * 发生过（契约测试覆盖了这条）。只有服务端明确说 4xx 时才清凭据。
       */
      if (result.failure.kind === 'aborted' || result.failure.kind === 'network') {
        /**
         * 把真实原因留住——但**只在我们手里确实有一枚长期凭据时**。
         *
         * 两种模式的可观测性不同：body 模式下凭据就在我们手里，这次换新没问成，
         * "连不上"是事实；cookie 模式下长期凭据在浏览器里、我们本来就看不见，
         * "问不到"既可能是没登录也可能是没网，按既有产品决定算作"未登录"。
         */
        lastRefreshFailure = mode === 'body' && refreshToken !== null ? result.failure : null
        return false
      }
      lastRefreshFailure = null
      await loseSession(hadCredential)
      return false
    }
    const tokens = tokensOf(result.payload)
    if (tokens === null) {
      // 服务端说 ok 却没给令牌：能走到这里说明刚发过一次续期请求，一定是「登录过」的情形，
      // 所以按 `expired` 收尾，而不是报「你还没登录」。
      lastRefreshFailure = null
      await loseSession(true)
      return false
    }
    // 这次刷新跨过了一次登出：结果是无效的，一个字节都不许落地。
    if (startedAt !== generation) return false
    lastRefreshFailure = null
    await config.tokens.write(tokens)
    hasSession = true
    setState('authenticated')
    return true
  }

  const refresh = (signal?: AbortSignal): Promise<boolean> => {
    refreshing ??= performRefresh(signal).finally(() => { refreshing = null })
    return refreshing
  }

  /**
   * 刷新失败之后该回什么。
   *
   * 两种性质完全不同的失败必须分开（WP1 A-19）：
   * - **没问成**（网络不通 / 超时 / 用户取消）：凭据可能还是好的，如实把原因带出去，
   *   界面才会说「稍后再试」而不是「请重新登录」；
   * - **服务端说凭据不行**：回本地的过期文案，界面该回登录页。
   * @param operation - 触发失败的操作。
   * @returns 传输结果。
   */
  const failureAfterRefresh = (operation: AccountOperation, fallback?: TransportResult): TransportResult => {
    const reason = lastRefreshFailure
    if (reason !== null && (reason.kind === 'network' || reason.kind === 'aborted')) {
      return { ok: false, status: reason.status ?? 0, failure: reason }
    }
    return fallback ?? { ok: false, status: 401, failure: expiredFailure(operation) }
  }

  const requestProtected = async (request: ProtectedRequest): Promise<TransportResult> => {
    // 冷启动第一次请求时把持久化的 refresh token 读进内存；之后是无副作用的空操作。
    await config.tokens.hydrate()
    const token = config.tokens.readAccess()
    if (token === null || config.tokens.isAccessExpired()) {
      /**
       * 已知过期就先刷新，省掉一次注定 401 的往返。
       *
       * 这里必须把调用方的取消信号一路带下去：否则用户按下「停止」之后，那个
       * 走不到头的刷新请求还会继续挂着（上限是请求超时），界面看起来像卡死。
       */
      const refreshed = await refresh(request.signal)
      if (!refreshed) return failureAfterRefresh(request.operation)
    }
    const current = config.tokens.readAccess()
    if (current === null) {
      return { ok: false, status: 401, failure: expiredFailure(request.operation) }
    }
    const first = await callWithToken(request, current)
    if (first.ok || first.status !== 401) return first
    // 401：可能是 access token 刚过期，或被服务端撤销了会话。刷新一次再重试。
    const refreshed = await refresh()
    if (!refreshed) {
      /**
       * 上游**已经答过一次**了，它给的业务原因（需要二次验证、账号被停用、会话被撤销…）
       * 是权威的，照它报。只有当它只给了一个笼统的 401、而续期又确实没问成时，
       * 才把"连不上"这个更接近真相的原因报上去（WP1 A-19）。
       */
      if (first.failure.kind !== 'unauthorized') return first
      return failureAfterRefresh(request.operation, first)
    }
    /**
     * 重放必须带**新**令牌：带着刚被拒掉的旧令牌再打一次只会再失败一次。
     *
     * `readAccess()` 的静态类型是 `string | null`，但这里已经由 `refresh() === true`
     * 保证了非空——`performRefresh` 只在「响应里拿到 access_token 且写进存储成功」之后
     * 才返回 true，而 `TokenStore.write` 只接受完整的令牌对。用断言而不是再写一个
     * 判空分支，是因为那个分支永远不会执行，留着只会让人以为这里真的能读到 null。
     */
    const second = await callWithToken(request, config.tokens.readAccess() as string)
    if (second.status === 401) {
      // 刷新成功了、带着**新**令牌仍然被拒：这不是过期，是服务端已经把这个会话撤销了
      // （用户可能在另一端点了「撤销会话」）。此时不标记过期就会留下一个
      // 「界面显示已登录、每个请求都失败」的状态——比直接回登录页更难查。
      setState('expired')
    }
    return second
  }

  return {
    requestProtected,
    requestPublic: call,
    refresh,
    signOut: async () => {
      // 先让代数进位：任何"登出前发出、登出后才回来"的刷新都作废。
      generation += 1
      await config.tokens.clear()
      hasSession = false
      setState('signed-out')
    },
    state: () => state,
    markAuthenticated: () => {
      hasSession = true
      setState('authenticated')
    },
    markExpired: () => { setState('expired') },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** 长期凭据失效的失败对象；与上游 401 同形，但文案走本地，且不带追踪 id。 */
function expiredFailure(operation: AccountOperation): AccountFailure {
  return new AccountFailure('unauthorized', '登录状态已过期，请重新登录。', { status: 401, operation })
}

/**
 * 从令牌响应里取出令牌对。
 *
 * 兼容三个位置：`tokens` 对象、顶层同名字段（上游登录响应把兼容字段平铺在顶层）。
 * `agent_token` **刻意不读**：它和 refresh token 是同一个值（上游 v8 已删除 v1 的一年期
 * agent token，也没有节点凭据接口），把它当第二类凭据会让客户端以为存在节点身份。
 * @param payload - 已解析的响应体。
 * @returns 令牌对；取不到必需的 access token 时返回 `null`。
 */
export function tokensOf(payload: unknown): TokenPair | null {
  if (payload === null || typeof payload !== 'object') return null
  const source = payload as UpstreamErrorPayload & {
    tokens?: Partial<TokenPair> | null
    access_token?: unknown
    refresh_token?: unknown
    token_type?: unknown
    expires_in?: unknown
  }
  const nested = source.tokens ?? {}
  const access = firstString(nested.access_token, source.access_token)
  if (access === null) return null
  const refresh = firstString(nested.refresh_token, source.refresh_token)
  const tokenType = firstString(nested.token_type, source.token_type) ?? 'Bearer'
  const expiresIn = firstNumber(nested.expires_in, source.expires_in) ?? 0
  return { access_token: access, refresh_token: refresh, token_type: tokenType, expires_in: expiresIn }
}

/** 取第一个非空字符串。 */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/** 取第一个有限数字。 */
function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}
