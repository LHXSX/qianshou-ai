/**
 * Public WeChat OAuth hand-off for browser/mobile hosts.
 *
 * The adapter only prepares and validates the browser leg.  App secrets,
 * code-to-token exchange and account binding stay on the server.  A missing
 * public configuration is an explicit unavailable state; it never fabricates
 * a successful login.
 */

export type WeChatLoginStatus = 'unconfigured' | 'ready' | 'pending'

export interface WeChatLoginStorage {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
  readonly removeItem: (key: string) => void
}

/** Public runtime configuration. No AppSecret field is intentionally exposed. */
export interface WeChatLoginConfig {
  readonly enabled: boolean
  readonly appId?: string
  readonly authorizeEndpoint?: string
  readonly redirectUri?: string
  readonly scope?: string
  readonly timeoutMs?: number
  readonly storage?: WeChatLoginStorage
  readonly now?: () => number
  readonly randomToken?: () => string
}

export type WeChatLoginStart =
  | { readonly kind: 'unconfigured'; readonly reason: 'disabled' | 'missing-config' }
  | { readonly kind: 'started'; readonly url: string; readonly state: string }

export type WeChatLoginCallback =
  | { readonly kind: 'cancelled'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'timed-out'; readonly message: string }
  | { readonly kind: 'ready-for-server'; readonly code: string; readonly state: string; readonly nonce: string; readonly redirectUri: string }

export interface WeChatLoginAdapter {
  readonly status: () => WeChatLoginStatus
  readonly begin: () => WeChatLoginStart
  readonly consumeCallback: (input: URLSearchParams | Record<string, string | undefined>) => WeChatLoginCallback
  readonly clear: () => void
}

interface PendingState {
  readonly state: string
  readonly nonce: string
  readonly redirectUri: string
  readonly expiresAt: number
}

const STORAGE_KEY = 'qianshou.wechat-login.pending.v1'
const DEFAULT_TIMEOUT_MS = 5 * 60_000

function memoryStorage(): WeChatLoginStorage {
  let value: string | null = null
  return {
    getItem: (key) => key === STORAGE_KEY ? value : null,
    setItem: (key, next) => { if (key === STORAGE_KEY) value = next },
    removeItem: (key) => { if (key === STORAGE_KEY) value = null },
  }
}

function token(): string {
  const source = globalThis.crypto
  if (source?.getRandomValues) {
    const bytes = new Uint8Array(24)
    source.getRandomValues(bytes)
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  }
  throw new Error('WECHAT_RANDOM_UNAVAILABLE')
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readPending(storage: WeChatLoginStorage): PendingState | null {
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const state = text(parsed.state); const nonce = text(parsed.nonce); const redirectUri = text(parsed.redirectUri)
    const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : NaN
    return state && nonce && redirectUri && Number.isFinite(expiresAt) ? { state, nonce, redirectUri, expiresAt } : null
  } catch { return null }
}

function callbackValue(input: URLSearchParams | Record<string, string | undefined>, key: string): string | null {
  return input instanceof URLSearchParams ? text(input.get(key)) : text(input[key])
}

/** Create an honest browser-side hand-off; the server still owns authentication. */
export function createWeChatLoginAdapter(config: WeChatLoginConfig): WeChatLoginAdapter {
  const storage = config.storage ?? (typeof localStorage === 'undefined' ? memoryStorage() : localStorage)
  const now = config.now ?? (() => Date.now())
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const usable = (): { appId: string; authorizeEndpoint: string; redirectUri: string; scope: string } | null => {
    const appId = text(config.appId); const endpoint = text(config.authorizeEndpoint); const redirectUri = text(config.redirectUri)
    if (!config.enabled || !appId || !endpoint || !redirectUri || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return null
    try {
      const url = new URL(endpoint); const redirect = new URL(redirectUri)
      if (!['https:', 'http:'].includes(url.protocol) || !['https:', 'http:'].includes(redirect.protocol)) return null
    } catch { return null }
    return { appId, authorizeEndpoint: endpoint, redirectUri, scope: text(config.scope) ?? 'snsapi_login' }
  }
  return {
    status(): WeChatLoginStatus {
      if (usable() === null) return 'unconfigured'
      const pending = readPending(storage)
      return pending && pending.expiresAt > now() ? 'pending' : 'ready'
    },
    begin(): WeChatLoginStart {
      const setup = usable()
      if (setup === null) return { kind: 'unconfigured', reason: config.enabled ? 'missing-config' : 'disabled' }
      const state = (config.randomToken ?? token)(); const nonce = (config.randomToken ?? token)()
      const pending: PendingState = { state, nonce, redirectUri: setup.redirectUri, expiresAt: now() + timeoutMs }
      storage.setItem(STORAGE_KEY, JSON.stringify(pending))
      const url = new URL(setup.authorizeEndpoint)
      url.searchParams.set('appid', setup.appId); url.searchParams.set('redirect_uri', setup.redirectUri)
      url.searchParams.set('response_type', 'code'); url.searchParams.set('scope', setup.scope)
      url.searchParams.set('state', state); url.searchParams.set('nonce', nonce)
      return { kind: 'started', url: url.toString(), state }
    },
    consumeCallback(input: URLSearchParams | Record<string, string | undefined>): WeChatLoginCallback {
      const pending = readPending(storage)
      storage.removeItem(STORAGE_KEY)
      const error = callbackValue(input, 'error')
      if (error === 'access_denied' || error === 'cancelled') return { kind: 'cancelled', message: '微信登录已取消。' }
      if (error) return { kind: 'failed', message: '微信登录未完成，请稍后重试。' }
      if (!pending || pending.expiresAt <= now()) return { kind: 'timed-out', message: '微信登录已超时，请重新开始。' }
      const state = callbackValue(input, 'state')
      if (!state || state !== pending.state) return { kind: 'failed', message: '微信登录状态校验失败，请重新开始。' }
      const code = callbackValue(input, 'code')
      if (!code) return { kind: 'failed', message: '微信没有返回登录凭据，请重新开始。' }
      return { kind: 'ready-for-server', code, state, nonce: pending.nonce, redirectUri: pending.redirectUri }
    },
    clear(): void { storage.removeItem(STORAGE_KEY) },
  }
}

export const WECHAT_LOGIN_STORAGE_KEY = STORAGE_KEY
