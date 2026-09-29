/**
 * 账号客户端：PC 与手机共用的同一套账号 API。
 *
 * 这个包存在的唯一理由就是用户那句话——「同一个账号体系，PC 可以登录注册，手机端口也
 * 可以的，他们两个是贯通的」。所以这里**不做任何 UI、不做任何平台判断**：它是一个
 * 纯客户端库，PC 的 `AuthorizationFlow` 和手机的 `MobileAuthPort` 各自把它当底座，
 * 拿到的是同一份账号、同一份余额、同一份会话列表。
 *
 * 两个贯穿全实现的决定：
 *
 * 1. **失败一律抛 `AccountFailure`，不返回「错误字符串」。**
 *    调用方（两端各自的界面）只需要 `err.message` 就能给用户一句中文原因，
 *    需要区分处置时再看 `err.kind`（例如 `unauthorized` 要回登录页，
 *    `invalid-credentials` 只需重填口令）。
 *
 * 2. **登录不只有一种成功形状。**
 *    开了 2FA 的账号在不可信设备上登录，上游返回的是挑战而不是令牌，必须再走
 *    `login/totp`。这个分支被建模成 `LoginResult` 的联合类型，调用方**无法忘记处理它**——
 *    忘了就是一个类型错误，而不是线上「登录后什么也没发生」。
 *
 * 关于 `agent_token`：响应里有这个字段，但它**就是 refresh token 的同一个值**
 * （上游 `auth.py:178-179`），v8 已删除 v1 的一年期 agent token，也不存在节点/agent
 * token 接口。所以本包**不读它、不为它建抽象**，更不会把它当节点凭据用。
 * 节点身份在上游是由 `owner_id` 决定的，与登录凭据无关。
 *
 * 已核实的事实来源：上游 OpenAPI + 2026-09-16 只读实测（`GET /api/v8/health` → 200，
 * 无凭据的鉴权端点 → 401 业务包）。**注册与登录本轮从未真的调用过**，
 * 契约测试全部打桩。
 */
import { ENDPOINTS, sessionPath, sessionTrustPath } from './endpoints.ts'
import { AccountFailure, FAILURE_COPY } from './failures.ts'
import type { TransportResult } from './http.ts'
import {
  asTwoFactorChallenge,
  normalizeAccount,
  normalizeSecurityLogs,
  normalizeSessions,
  normalizeTotpStatus,
  normalizeWorkers,
} from './normalize.ts'
import { createSession, tokensOf, type AccountSession, type AccountSessionState, type ProtectedRequest } from './session.ts'
import { createTokenStore, type RefreshTokenStore, type TokenStore, type TokenState } from './tokens.ts'
import type {
  Account,
  AccountSession as AccountSessionInfo,
  AccountWorker,
  ChangePasswordRequest,
  LoginRequest,
  LoginResult,
  LoginTotpRequest,
  SmsSendRequest,
  SmsSendResult,
  PhoneLoginRequest,
  PhoneRegisterRequest,
  ProfileUpdate,
  RegisterRequest,
  SecurityLogEntry,
  TokenPair,
  TotpStatus,
  TrustDeviceRequest,
} from './types.ts'
import type { FetchLike } from './http.ts'

export type { FetchLike, TransportResult } from './http.ts'
export type { AccountSessionState } from './session.ts'
export type { RefreshTokenStore, TokenState } from './tokens.ts'

/** 客户端注入配置。 */
export interface AccountClientConfig {
  readonly baseUrl: string
  readonly fetch: FetchLike
  /** 令牌存储。不传则按 `cookiesAvailable` 现场建一个（默认 `cookiesAvailable: true`）。 */
  readonly tokens?: TokenStore
  /**
   * 宿主是否真的能收 httpOnly cookie。
   *
   * 传 `false` 的典型场景：手机端预览走 `http://`（非安全上下文），浏览器不会给
   * 非安全来源种 cookie；或者宿主是 Tauri。此时刷新会退化为请求体携带 refresh token，
   * **并且要求提供持久化端口**，否则 refresh token 只活到页面关闭。
   */
  readonly cookiesAvailable?: boolean
  /** 可选的 refresh token 持久化端口（`cookiesAvailable: false` 时必须给）。 */
  readonly refreshStore?: RefreshTokenStore
  /** 前缀覆盖，默认 `/api/v8`。 */
  readonly prefix?: string
  readonly timeoutMs?: number
}

/** 账号客户端。 */
export interface AccountClient {
  /** 注册。**不自动登录**：上游的注册响应是否带令牌未核实，混淆两者会让调用方以为已登录。 */
  readonly register: (input: RegisterRequest) => Promise<Account | null>
  /** 登录：拿到令牌，或拿到 2FA 挑战。 */
  readonly login: (input: LoginRequest) => Promise<LoginResult>
  /** 2FA 补验：用挑战换令牌。 */
  readonly loginTotp: (input: LoginTotpRequest) => Promise<Account | null>
  /** Send a code only after Shanghai confirms the SMS provider accepted it. */
  readonly sendSms: (input: SmsSendRequest) => Promise<SmsSendResult>
  /** SMS login stores the returned tokens in the same session as password login. */
  readonly loginPhone: (input: PhoneLoginRequest) => Promise<LoginResult>
  /** SMS registration creates an account and signs into that verified identity. */
  readonly registerPhone: (input: PhoneRegisterRequest) => Promise<Account | null>
  /** 当前账号资料（`GET /auth/me`）。 */
  readonly me: (signal?: AbortSignal) => Promise<Account | null>
  /** 改密码；上游两个字段都可选。 */
  readonly changePassword: (input: ChangePasswordRequest) => Promise<void>
  /** 登出：先通知服务器撤销当前会话，再清本地令牌；服务器失败也照样清本地。 */
  readonly logout: () => Promise<void>
  /** 列出全部会话。 */
  readonly listSessions: () => Promise<readonly AccountSessionInfo[]>
  /**
   * 列出当前账号名下的算力节点（`GET /api/v8/workers`）。
   *
   * 上游按登录账号过滤 `owner_id`，客户端不再自己筛一遍归属。
   */
  readonly listWorkers: () => Promise<readonly AccountWorker[]>
  /** 撤销单个会话。 */
  readonly revokeSession: (sessionId: string) => Promise<void>
  /** 撤销**其它**会话，保留当前这条。 */
  readonly revokeOtherSessions: () => Promise<void>
  /** 信任设备（2FA 免验）。 */
  readonly trustDevice: (sessionId: string, input: TrustDeviceRequest) => Promise<void>
  /** TOTP 状态；认不出结构时返回 `null`（界面必须按「未知」处理，不能当未开启）。 */
  readonly totpStatus: () => Promise<TotpStatus | null>
  /**
   * 开始绑定 TOTP。
   *
   * 返回值是**上游原始响应体**：绑定流程需要 `secret` 与 `otpauth_url` 来画二维码，
   * 而这两个字段本轮未核实，写死形状会让上游改字段时静默拿到 `undefined`。
   * 调用方按上游文档读取即可。
   */
  readonly totpSetup: (currentPassword: string) => Promise<unknown>
  /** 确认绑定；`setupToken` 取自 `totpSetup` 的响应。 */
  readonly totpConfirm: (setupToken: string, code: string) => Promise<unknown>
  /** 关闭 2FA。**危险操作**：关掉之后账号只剩口令一道防线。 */
  readonly totpDisable: (input: { readonly code: string; readonly current_password: string }) => Promise<void>
  /** 安全日志。 */
  readonly securityLogs: () => Promise<readonly SecurityLogEntry[]>
  /** 更新资料（`PUT /my/profile`）。 */
  readonly setProfile: (input: ProfileUpdate) => Promise<unknown>
  /** 刷新访问令牌；通常不需要手动调，受保护请求遇 401 会自动刷。 */
  readonly refresh: () => Promise<boolean>
  /** 当前会话状态。 */
  readonly state: () => AccountSessionState
  /** 订阅会话状态变化。 */
  readonly subscribe: (listener: (state: AccountSessionState) => void) => () => void
  /** 可安全打印的令牌状态（**不含任何令牌值**）。 */
  readonly tokenState: () => TokenState
  /** 当前令牌存储。界面需要它读取 access token 去接别的服务（例如算力接口）。 */
  readonly tokens: TokenStore
}

/** 把一个失败结果变成异常；调用方只处理成功路径。 */
function requireOk(result: TransportResult): unknown {
  if (result.ok) return result.payload
  throw result.failure
}

/** 从响应体里取 `account`；没有就返回 `null`（不编造账号对象）。 */
function accountOf(payload: unknown): Account | null {
  if (payload === null || typeof payload !== 'object') return null
  return normalizeAccount((payload as { account?: unknown }).account)
}

/**
 * 创建账号客户端。
 * @param config - 基址、注入的 fetch 与令牌策略。
 * @returns 账号客户端。
 */
export function createAccountClient(config: AccountClientConfig): AccountClient {
  const tokens = config.tokens ?? createTokenStore({
    cookiesAvailable: config.cookiesAvailable ?? true,
    ...(config.refreshStore === undefined ? {} : { refreshStore: config.refreshStore }),
  })
  const session: AccountSession = createSession({
    baseUrl: config.baseUrl,
    fetch: config.fetch,
    tokens,
    ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  })

  /** 发一个受保护请求并把失败抛成异常。 */
  const protectedCall = async (request: ProtectedRequest): Promise<unknown> =>
    requireOk(await session.requestProtected(request))

  /** 发一个匿名请求并把失败抛成异常。 */
  const publicCall = async (request: ProtectedRequest): Promise<unknown> =>
    requireOk(await session.requestPublic(request))

  /** 把令牌写进存储并返回令牌对；登录与补验共用。 */
  const storeTokens = async (payload: unknown): Promise<TokenPair> => {
    const pair = tokensOf(payload)
    if (pair === null) {
      // 2xx 但没有令牌：这是「业务上成功了、实际上没法用」的状态。如实报错，
      // 不要留一个「已登录但没有 access token」的半成品会话。
      throw new AccountFailure('unparseable', FAILURE_COPY.unparseable, { operation: 'login' })
    }
    // 登录响应覆盖了当前账号的凭据，之前那个账号留下的长期凭据必须先作废。
    // 少了这一步，切换账号时会短暂地持有「新 access + 旧 refresh」这种混合状态，
    // 刷新一次就会把用户刷回上一个账号。
    await tokens.clear()
    await tokens.write(pair)
    // 拿到令牌才算会话成立。漏掉这一步的后果是「登录成功了，界面还显示未登录」——
    // 契约测试抓到过一次，所以这里保持显式。
    session.markAuthenticated()
    return pair
  }

  return {
    register: async (input) => {
      const payload = await publicCall({
        path: ENDPOINTS.register,
        operation: 'register',
        method: 'POST',
        body: { ...input },
        secrets: [input.password],
      })
      // 上游注册响应是否含 `account` 未核实；取不到就返回 `null`，**绝不**把
      // 「注册成功」说成「已登录」。
      return accountOf(payload)
    },

    login: async (input) => {
      const payload = await publicCall({
        path: ENDPOINTS.login,
        operation: 'login',
        method: 'POST',
        body: { ...input },
        // 口令必须进 `secrets`：上游的校验错误会回显请求体，遮盖是最后一道防线。
        secrets: [input.password],
      })
      const challenge = asTwoFactorChallenge(payload)
      if (challenge !== null) return { kind: 'two-factor', challenge }
      const pair = await storeTokens(payload)
      return { kind: 'tokens', tokens: pair, account: accountOf(payload) }
    },

    loginTotp: async (input) => {
      const payload = await publicCall({
        path: ENDPOINTS.loginTotp,
        operation: 'login-totp',
        method: 'POST',
        body: { ...input },
        secrets: [input.code, input.challenge_token],
      })
      await storeTokens(payload)
      return accountOf(payload)
    },

    sendSms: async (input) => {
      const payload = await publicCall({
        path: ENDPOINTS.smsSend,
        operation: 'sms-send',
        method: 'POST',
        body: { ...input },
      })
      const row = payload as { ok?: unknown; phone?: unknown; purpose?: unknown; expires_in?: unknown; resend_after?: unknown } | null
      if (row?.ok !== true || typeof row.phone !== 'string' || row.purpose !== input.purpose
        || !Number.isSafeInteger(row.expires_in) || !Number.isSafeInteger(row.resend_after)
        || (row.expires_in as number) <= 0 || (row.resend_after as number) < 0) {
        throw new AccountFailure('unparseable', FAILURE_COPY.unparseable, { operation: 'sms-send' })
      }
      return { phone: row.phone, purpose: input.purpose, expiresIn: row.expires_in as number, resendAfter: row.resend_after as number }
    },

    loginPhone: async (input) => {
      const payload = await publicCall({
        path: ENDPOINTS.loginPhone,
        operation: 'login-phone',
        method: 'POST',
        body: { ...input },
        secrets: [input.code],
      })
      const challenge = asTwoFactorChallenge(payload)
      if (challenge !== null) return { kind: 'two-factor', challenge }
      const pair = await storeTokens(payload)
      return { kind: 'tokens', tokens: pair, account: accountOf(payload) }
    },

    registerPhone: async (input) => {
      const payload = await publicCall({
        path: ENDPOINTS.registerPhone,
        operation: 'register-phone',
        method: 'POST',
        body: { ...input },
        secrets: [input.code],
      })
      await storeTokens(payload)
      return accountOf(payload)
    },

    me: async (signal) => {
      const payload = await protectedCall({
        path: ENDPOINTS.me,
        operation: 'me',
        method: 'GET',
        ...(signal === undefined ? {} : { signal }),
      })
      return accountOf(payload)
    },

    changePassword: async (input) => {
      await protectedCall({
        path: ENDPOINTS.me,
        operation: 'me',
        method: 'PUT',
        body: { ...input },
        secrets: [input.password, input.old_password],
      })
    },

    logout: async () => {
      const result = await session.requestProtected({ path: ENDPOINTS.logout, operation: 'logout', method: 'POST' })
      // 服务器撤销失败（网络断了、会话已经没了）不阻止本地登出：
      // 用户按了「登出」就必须登出，否则他以为已经退出、实际还在。
      void result
      await session.signOut()
    },

    listSessions: async () => {
      const payload = await protectedCall({ path: ENDPOINTS.sessions, operation: 'sessions', method: 'GET' })
      return normalizeSessions(payload)
    },

    listWorkers: async () => {
      const payload = await protectedCall({ path: ENDPOINTS.workers, operation: 'workers', method: 'GET' })
      return normalizeWorkers(payload)
    },

    revokeSession: async (sessionId) => {
      await protectedCall({ path: sessionPath(sessionId), operation: 'sessions', method: 'DELETE' })
    },

    revokeOtherSessions: async () => {
      // 上游语义是「保留当前会话」，所以这里不传任何 id。
      await protectedCall({ path: ENDPOINTS.sessions, operation: 'sessions', method: 'DELETE' })
    },

    trustDevice: async (sessionId, input) => {
      await protectedCall({
        path: sessionTrustPath(sessionId),
        operation: 'sessions',
        method: 'PUT',
        body: { ...input },
        secrets: [input.code, input.current_password],
      })
    },

    totpStatus: async () => {
      const payload = await protectedCall({ path: ENDPOINTS.totpStatus, operation: 'totp', method: 'GET' })
      return normalizeTotpStatus(payload)
    },

    totpSetup: async (currentPassword) => {
      const payload = await protectedCall({
        path: ENDPOINTS.totpSetup,
        operation: 'totp',
        method: 'POST',
        body: { current_password: currentPassword },
        secrets: [currentPassword],
      })
      // 原样返回：`secret` / `otpauth_url` 的字段名未核实，不在这一层替调用方猜。
      return payload
    },

    totpConfirm: async (setupToken, code) => {
      const payload = await protectedCall({
        path: ENDPOINTS.totpConfirm,
        operation: 'totp',
        method: 'POST',
        body: { setup_token: setupToken, code },
        secrets: [setupToken, code],
      })
      return payload
    },

    totpDisable: async (input) => {
      await protectedCall({
        path: ENDPOINTS.totpDisable,
        operation: 'totp',
        method: 'POST',
        body: { ...input },
        secrets: [input.code, input.current_password],
      })
    },

    securityLogs: async () => {
      const payload = await protectedCall({ path: ENDPOINTS.securityLogs, operation: 'security-logs', method: 'GET' })
      return normalizeSecurityLogs(payload)
    },

    setProfile: async (input) => {
      // 这里没有密钥，但资料里可能有手机号；不过它不是凭据，遮盖与否由宿主的日志策略决定。
      const payload = await protectedCall({
        path: ENDPOINTS.profile,
        operation: 'profile',
        method: 'PUT',
        body: { ...input },
      })
      return payload
    },

    refresh: () => session.refresh(),
    state: () => session.state(),
    subscribe: listener => session.subscribe(listener),
    tokenState: () => tokens.describe(),
    tokens,
  }
}
