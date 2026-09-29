/**
 * 与**既有账号体系**的对接（上游 `https://qianshousuanli.com/api/v8`）。
 *
 * 用户的要求是"复用既有账号体系（不要造第二套账号）"。所以：
 * 管理员登录用的就是手机端/电脑端同一个账号、同一份口令、同一套 TOTP，
 * 换来的就是同一个 `accountId`——本服务不签发任何账号，也不存任何口令。
 *
 * 为什么这里不 `import` 仓库里的 `@deepseek-ai/dsh-client-account`：
 * 那个包是给**浏览器与宿主内插件**用的（带 cookie store、token store、落盘），
 * 而本服务是部署在服务器上的独立进程，只做三件事：转发登录、确认身份、登出。
 * 但**端点与形状必须与那个包一致**，所以路径常量在下面集中列出，
 * 并由 `tests/upstream-contract.spec.ts` 与那个包的导出逐字对照——
 * 上游改了路径，测试会红，而不是线上悄悄 404。
 *
 * 失败分类沿用仓库既有判据（`packages/client/account/src/failures.ts` 的结论）：
 * **只有上游明确拒绝才算"没登录"**（401/账号停用）；网络层问题一律 `unavailable`，
 * 由路由翻成 502。把网络抖动说成"请重新登录"，是这套系统已经踩过的坑。
 */
import type { UpstreamTokens } from './session.ts'

/** 生产基址。 */
export const ACCOUNT_API_ORIGIN = 'https://qianshousuanli.com'

/** v8 前缀。 */
export const ACCOUNT_API_PREFIX = '/api/v8'

/** 用到的上游路径（与 `@deepseek-ai/dsh-client-account` 的 `ENDPOINTS` 保持一致）。 */
export const UPSTREAM_PATHS = {
  login: '/auth/login',
  loginTotp: '/auth/login/totp',
  me: '/auth/me',
  logout: '/auth/logout',
} as const

/** 上游账号的精简视图（只留身份，不留余额等业务字段）。 */
export interface UpstreamAccount {
  readonly id: string
  readonly displayName: string
  /** 上游平台角色原文；本服务**不**用它做授权，只记录与展示。 */
  readonly role: string
}

/** 登录结果。 */
export type LoginOutcome =
  | { readonly kind: 'ok'; readonly account: UpstreamAccount; readonly tokens: UpstreamTokens }
  | { readonly kind: 'two-factor'; readonly challengeToken: string }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'rate-limited'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string }

/** 核验结果。 */
export type VerifyOutcome =
  | { readonly kind: 'ok'; readonly account: UpstreamAccount }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unavailable' }

/** 账号上游客户端。 */
export interface AccountUpstream {
  readonly login: (input: { readonly username: string; readonly password: string }) => Promise<LoginOutcome>
  readonly loginTotp: (input: {
    readonly challengeToken: string
    readonly code: string
    readonly trustDevice: boolean
  }) => Promise<LoginOutcome>
  /** 用持有令牌确认身份（定期核验；上游明确拒绝 → `unauthorized`）。 */
  readonly verify: (tokens: UpstreamTokens) => Promise<VerifyOutcome>
  /** 尽力登出上游（失败不影响本地登出）。 */
  readonly logout: (tokens: UpstreamTokens) => Promise<void>
}

/** 取对象。 */
function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** 取第一个非空字符串。 */
function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/** 从响应里挖出令牌对（上游可能包在 `data` 里）。 */
export function extractTokens(payload: unknown): UpstreamTokens | null {
  const root = objectOf(payload)
  if (root === null) return null
  const containers = [root, objectOf(root['data']), objectOf(root['tokens'])].filter(
    (item): item is Record<string, unknown> => item !== null,
  )
  for (const container of containers) {
    const nested = objectOf(container['tokens'])
    for (const candidate of [container, nested]) {
      if (candidate === null) continue
      const access = firstString(candidate, ['access_token', 'accessToken', 'access'])
      if (access === null) continue
      const refresh = firstString(candidate, ['refresh_token', 'refreshToken', 'refresh'])
      return { access, refresh }
    }
  }
  return null
}

/** 从响应里挖出账号（认不出 id 就算认不出）。 */
export function extractAccount(payload: unknown): UpstreamAccount | null {
  const root = objectOf(payload)
  if (root === null) return null
  const candidates = [
    objectOf(root['account']),
    objectOf(root['user']),
    objectOf(objectOf(root['data'])?.['account']),
    objectOf(objectOf(root['data'])?.['user']),
    root,
  ].filter((item): item is Record<string, unknown> => item !== null)
  for (const candidate of candidates) {
    const rawId = candidate['id'] ?? candidate['account_id'] ?? candidate['accountId'] ?? candidate['uid']
    const id = typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId) : null
    if (id === null || id.length === 0) continue
    const displayName = firstString(candidate, ['nickname', 'display_name', 'displayName', 'username', 'name', 'email']) ?? id
    const role = firstString(candidate, ['role', 'plan', 'tier']) ?? 'personal'
    return { id, displayName, role }
  }
  return null
}

/** 从响应里挖出两步验证的挑战令牌。 */
export function extractChallenge(payload: unknown): string | null {
  const root = objectOf(payload)
  if (root === null) return null
  const containers = [root, objectOf(root['data']), objectOf(root['two_factor']), objectOf(root['challenge'])]
    .filter((item): item is Record<string, unknown> => item !== null)
  for (const container of containers) {
    const token = firstString(container, ['challenge_token', 'challengeToken', 'token', 'id'])
    if (token !== null) return token
  }
  return null
}

/** 两步验证是否被要求。 */
export function requiresTwoFactor(payload: unknown): boolean {
  const root = objectOf(payload)
  if (root === null) return false
  for (const container of [root, objectOf(root['data'])]) {
    if (container === null) continue
    for (const key of ['two_factor_required', 'twoFactorRequired', 'requires_2fa', 'totp_required']) {
      if (container[key] === true) return true
    }
    if (objectOf(container['two_factor']) !== null || typeof container['challenge_token'] === 'string') return true
  }
  return false
}

/** 消息提取（只在已分类的失败上使用）。 */
function messageOf(payload: unknown, fallback: string): string {
  const root = objectOf(payload)
  const message = root === null ? null : firstString(root, ['message', 'detail', 'error_description'])
  return message ?? fallback
}

/**
 * 建上游客户端。
 * @param options - 基址、前缀、fetch（测试注入）与超时。
 * @returns 客户端。
 */
export function createAccountUpstream(options: {
  readonly baseUrl: string
  readonly prefix?: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}): AccountUpstream {
  const prefix = options.prefix ?? ACCOUNT_API_PREFIX
  const base = options.baseUrl.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000

  /** 发一次请求；网络层失败与超时都收敛成 `null`（调用方翻成 unavailable）。 */
  const send = async (
    path: string,
    init: { readonly method: string; readonly body?: unknown; readonly access?: string },
  ): Promise<{ readonly status: number; readonly payload: unknown } | null> => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (init.body !== undefined) headers['content-type'] = 'application/json'
      if (init.access !== undefined) headers['authorization'] = `Bearer ${init.access}`
      const response = await doFetch(`${base}${prefix}${path}`, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      })
      let payload: unknown = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      return { status: response.status, payload }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 把一次登录/补验响应分类。 */
  const classify = (result: { readonly status: number; readonly payload: unknown }): LoginOutcome => {
    if (result.status >= 200 && result.status < 300) {
      // 2xx 但没有令牌：这是"业务上成功、实际没法用"的状态，如实报错，
      // 绝不留一个"已登录但没有令牌"的半成品会话。
      if (requiresTwoFactor(result.payload)) {
        const challengeToken = extractChallenge(result.payload)
        if (challengeToken !== null) return { kind: 'two-factor', challengeToken }
        return { kind: 'unavailable', message: '账号服务要求两步验证，但没有给出挑战令牌。请稍后再试或联系管理员。' }
      }
      const tokens = extractTokens(result.payload)
      const account = extractAccount(result.payload)
      if (tokens !== null && account !== null) return { kind: 'ok', account, tokens }
      if (tokens !== null) {
        // 有令牌但认不出账号：用令牌再问一次 `/auth/me`（比猜字段可靠）。
        return { kind: 'unavailable', message: '账号服务返回了登录凭据，但没能读出账号身份。' }
      }
      return { kind: 'unavailable', message: '账号服务没有返回登录凭据。' }
    }
    if (result.status === 429) {
      return { kind: 'rate-limited', message: messageOf(result.payload, '登录尝试过于频繁，请稍后再试。') }
    }
    if (result.status === 401 || result.status === 403 || result.status === 422) {
      return { kind: 'invalid', message: messageOf(result.payload, '账号或密码不对。') }
    }
    return { kind: 'unavailable', message: '账号服务暂时不可用，请稍后再试。' }
  }

  return {
    login: async ({ username, password }) => {
      const result = await send(UPSTREAM_PATHS.login, { method: 'POST', body: { username, password } })
      if (result === null) return { kind: 'unavailable', message: '连不上账号服务，请稍后再试。' }
      const outcome = classify(result)
      if (outcome.kind !== 'ok') return outcome
      // 2xx 带令牌但账号身份要单独确认时，这里再核一次。
      const account = extractAccount(result.payload) ?? await (async () => {
        const verified = await sendVerdict(outcome.tokens)
        return verified === null ? null : verified
      })()
      if (account === null) {
        return { kind: 'unavailable', message: '登录成功但读不到账号身份，请稍后再试。' }
      }
      return { kind: 'ok', account, tokens: outcome.tokens }
    },

    loginTotp: async ({ challengeToken, code, trustDevice }) => {
      const result = await send(UPSTREAM_PATHS.loginTotp, {
        method: 'POST',
        body: { challenge_token: challengeToken, code, ...(trustDevice ? { trust_device: true } : {}) },
      })
      if (result === null) return { kind: 'unavailable', message: '连不上账号服务，请稍后再试。' }
      const outcome = classify(result)
      if (outcome.kind !== 'ok') return outcome
      const account = extractAccount(result.payload) ?? await (async () => {
        const verified = await sendVerdict(outcome.tokens)
        return verified === null ? null : verified
      })()
      if (account === null) {
        return { kind: 'unavailable', message: '登录成功但读不到账号身份，请稍后再试。' }
      }
      return { kind: 'ok', account, tokens: outcome.tokens }
    },

    verify: async (tokens) => {
      const result = await send(UPSTREAM_PATHS.me, { method: 'GET', access: tokens.access })
      if (result === null) return { kind: 'unavailable' }
      if (result.status === 401 || result.status === 403) return { kind: 'unauthorized' }
      if (result.status < 200 || result.status >= 300) return { kind: 'unavailable' }
      const account = extractAccount(result.payload)
      // 认证过了但读不出身份：不能当成"没登录"（那会让管理员莫名其妙被踢），
      // 也不能当成"有效"（那等于放弃核验）。按不可用处理，保持上一次的结论。
      if (account === null) return { kind: 'unavailable' }
      return { kind: 'ok', account }
    },

    logout: async (tokens) => {
      await send(UPSTREAM_PATHS.logout, { method: 'POST', access: tokens.access })
    },
  }

  /** 用令牌问一次 `/auth/me`，成功返回账号。 */
  async function sendVerdict(tokens: UpstreamTokens): Promise<UpstreamAccount | null> {
    const result = await send(UPSTREAM_PATHS.me, { method: 'GET', access: tokens.access })
    if (result === null || result.status < 200 || result.status >= 300) return null
    return extractAccount(result.payload)
  }
}
