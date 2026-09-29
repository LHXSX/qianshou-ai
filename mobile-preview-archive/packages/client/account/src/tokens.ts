/**
 * 令牌模型：access token 与 refresh token **分开存放、分开决定要不要落盘**。
 *
 * 为什么必须分开：
 * - access token 是短期凭据。PC 与手机都只需要它在内存里活几分钟到两小时；它一旦落到
 *   明文存储，泄露窗口就是它的有效期，所以默认只放内存。
 * - refresh token 是长期凭据（上游 7 天）。它决定「明天还能不能免密打开」，所以它的
 *   存放位置是安全决策，不是实现细节；本包把它单独放在一个**注入的端口**后面，
 *   由调用方决定放哪儿（PC：`$DSH_HOME/.credentials.yaml`，明文，文档如实写；
 *   手机：优先交给 httpOnly cookie，拿不到才退到本地存储，并在界面上说明）。
 *
 * 刻意的一点：`describe()` 只输出状态，不输出任何令牌值。界面需要知道「登录态」与
 * 「还剩多久」，而日志里出现 token 值就是事故——因此读取令牌只能通过 `readAccess()` /
 * `readRefresh()`，且本包从不把它们写进日志、错误对象或诊断文本。
 */
import type { TokenPair } from './types.ts'

/**
 * 长期凭据的来源。
 *
 * - `'cookie'`：上游下发了 httpOnly cookie（`we_refresh_token`，path `/api/v8/auth`），
 *   JS 看不到也不需要看到它，刷新时靠浏览器自动带上。这是**首选**路径。
 * - `'body'`：cookie 不可用（非安全上下文、被浏览器策略拦住、Tauri 客户端等），
 *   退化为把 refresh token 放在刷新请求体里。此时它必须由调用方提供存储端口。
 */
export type RefreshTokenSource = 'cookie' | 'body'

/** refresh token 的持久化端口；不传表示调用方不提供持久化，只保留内存副本。 */
export interface RefreshTokenStore {
  /** 读回已保存的 refresh token；没有则返回 `null`。 */
  read: () => Promise<string | null>
  /** 覆盖保存 refresh token。 */
  write: (token: string) => Promise<void>
  /** 清除已保存的 refresh token（登出、被撤销、刷新失败都要调）。 */
  clear: () => Promise<void>
}

/** 令牌存储的注入配置。 */
export interface TokenStoreConfig {
  /**
   * 运行环境是否真的能收 httpOnly cookie。
   * 由调用方按「协议 + 是否同站」判断后传入：本包不读 `location`，因为它也要能在
   * 非浏览器宿主（本地联调、打包后的 PC 进程）里跑。
   */
  readonly cookiesAvailable: boolean
  /** 明确指定长期凭据走 cookie 还是 body；不传时按 `cookiesAvailable` 推导。 */
  readonly refreshSource?: RefreshTokenSource
  /** 可选的 refresh token 持久化端口。 */
  readonly refreshStore?: RefreshTokenStore
  /** 注入的时钟，便于测试到期逻辑。 */
  readonly now?: () => number
}

/** 可以被安全打印的令牌状态快照；**不含任何令牌值**。 */
export interface TokenState {
  readonly hasAccessToken: boolean
  readonly hasRefreshToken: boolean
  readonly refreshSource: RefreshTokenSource
  /** access token 的到期时间戳（毫秒）；未知时为 `null`。 */
  readonly accessExpiresAt: number | null
  /** 从上游收到的 access token 有效期秒数。 */
  readonly accessExpiresIn: number | null
}

/** 令牌存储。 */
export interface TokenStore {
  /** 读取当前 access token；无则 `null`。 */
  readAccess: () => string | null
  /** 读取当前 refresh token（内存副本）；无则 `null`。 */
  readRefresh: () => string | null
  /**
   * 写入一对令牌。
   *
   * 写盘规则：只有 body 模式才把 refresh token 交给持久化端口；**cookie 模式一律不写**，
   * 因为「JS 里已经不持有长期凭据」正是 httpOnly 的全部价值，再存一份就等于放弃它。
   * 这里不看「记住我」：`remember_me` 是发给上游的字段，它决定 cookie 是持久还是会话级，
   * 由上游处理；客户端持久化的是「本机能不能免密打开」，两者不是一回事。
   */
  write: (tokens: TokenPair) => Promise<void>
  /** 丢弃内存中的全部令牌，并清空持久化端口。 */
  clear: () => Promise<void>
  /** 判断 access token 是否已过期（含提前 30 秒的余量，避免边界上必然失败一次）。 */
  isAccessExpired: () => boolean
  /**
   * 冷启动：把持久化端口里已有的 refresh token 读进内存副本。
   *
   * 为什么必须显式调用：读存储是异步的，而存储本身的构造必须同步完成——否则调用方在
   * `await` 之前读到的状态是错的。不调用不会崩，但会表现为「重启后要求重新登录」，
   * 这正是 httpOnly cookie 之外那条路径最容易被写漏的一步。
   *
   * cookie 模式下**什么都不做**：那种情况长期凭据在浏览器手里，JS 里本来就不该有副本，
   * 主动去读一份反而等于给自己开了一条绕过 httpOnly 的口子。
   */
  readonly hydrate: () => Promise<void>
  /** 可安全打印的状态快照。 */
  describe: () => TokenState
  /** 当前长期凭据的来源。 */
  source: () => RefreshTokenSource
}

/** access token 到期的提前量：留 30 秒，避免请求在途中刚好过期。 */
export const ACCESS_EXPIRY_SKEW_MS = 30_000

/**
 * 创建一个令牌存储。
 *
 * 内存是底线而不是兜底分支：即使调用方没给持久化端口，access token 也必须能用；
 * refresh token 则在没有持久化端口时只活到页面关闭——这是如实的能力边界，不是缺陷。
 * @param config - 运行环境与持久化端口。
 * @returns 令牌存储。
 */
export function createTokenStore(config: TokenStoreConfig): TokenStore {
  const now = config.now ?? (() => Date.now())
  const source: RefreshTokenSource = config.refreshSource
    ?? (config.cookiesAvailable ? 'cookie' : 'body')
  /** 只放在内存里的短期凭据。 */
  let accessToken: string | null = null
  /** refresh token 的内存副本：cookie 模式下它只用于「能不能退化为 body」的判断。 */
  let refreshToken: string | null = null
  let accessExpiresIn: number | null = null
  let accessExpiresAt: number | null = null
  /** 记忆化的冷启动读取，见 `hydrate`。 */
  let hydrating: Promise<void> | null = null

  return {
    readAccess: () => accessToken,
    readRefresh: () => refreshToken,

    write: async (tokens) => {
      accessToken = tokens.access_token
      accessExpiresIn = tokens.expires_in
      accessExpiresAt = now() + tokens.expires_in * 1000
      // cookie 模式下上游仍会回一个 refresh_token 值，但真正的长期凭据在 httpOnly cookie 里。
      refreshToken = tokens.refresh_token
      if (source === 'cookie') {
        await config.refreshStore?.clear()
        return
      }
      if (tokens.refresh_token === null) {
        // 退化为 body 模式却拿不到 refresh token：清掉旧的，
        // 绝不留下上一个账号的长期凭据。
        await config.refreshStore?.clear()
        return
      }
      await config.refreshStore?.write(tokens.refresh_token)
    },

    clear: async () => {
      accessToken = null
      refreshToken = null
      accessExpiresIn = null
      accessExpiresAt = null
      await config.refreshStore?.clear()
    },

    isAccessExpired: () => {
      if (accessToken === null) return true
      // 没有到期时间时按「已过期」处理：宁可多刷一次，也不要拿一个不知道有效期的
      // 令牌去打注定 401 的请求。
      return accessExpiresAt === null || now() >= accessExpiresAt - ACCESS_EXPIRY_SKEW_MS
    },

    hydrate: () => {
      // 记忆化：多调用一次不该产生第二次读盘。存储只会在登录/刷新时被本包写入，
      // 所以「首次读到什么就是什么」，不需要每次请求都重读。
      hydrating ??= (async () => {
        if (source === 'cookie') return
        const persisted = await config.refreshStore?.read()
        if (typeof persisted === 'string' && persisted.length > 0) refreshToken = persisted
      })()
      return hydrating
    },

    describe: () => ({
      hasAccessToken: accessToken !== null,
      hasRefreshToken: refreshToken !== null,
      refreshSource: source,
      accessExpiresAt,
      accessExpiresIn,
    }),

    source: () => source,
  }
}
