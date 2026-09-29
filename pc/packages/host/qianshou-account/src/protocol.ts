/** Shanghai account and Guangzhou catalog HTTP protocol, independent of UI and Cordis. */
import type { AccountFailureCode, AccountIdentity } from './types.ts'

/** An operation failed with a safe code; upstream payloads never become error messages. */
export class AccountFailure extends Error {
  constructor(readonly code: AccountFailureCode) { super(code); this.name = 'AccountFailure' }
}

/** Host-only token data returned by an authenticated exchange. */
export interface TokenPair {
  access: string
  refresh: string | null
  expiresIn: number
}

/** Connection settings; loopback HTTP is reserved for local integration tests. */
export interface AccountProtocolConfig {
  /** HTTPS base of the authoritative account API. */
  accountOrigin: string
  /** HTTPS base of the model gateway used to request its catalog. */
  gatewayBase: string
  /** Maximum duration in milliseconds for one protocol request. */
  timeoutMs: number
}

/**
 * Validate a configured server without admitting URL credentials, queries, or fragments.
 * @param value - Configured account origin or model gateway base.
 * @returns The validated server URL without trailing slashes.
 */
export function serverUrl(value: string): string {
  const parsed = new URL(value)
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) throw new AccountFailure('route-invalid')
  return value.replace(/\/+$/, '')
}

/** Read an untrusted JSON object without accepting arrays. */
function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

/**
 * Decode the two account token envelopes already used by the existing account client.
 * @param payload - Untrusted account or catalog JSON.
 * @returns Validated token data for Host memory and credential storage.
 */
export function tokensOf(payload: unknown): TokenPair {
  const top = object(payload)
  const nested = object(top.tokens)
  const access = nested.access_token ?? top.access_token
  const refresh = nested.refresh_token ?? top.refresh_token ?? null
  const expiresIn = nested.expires_in ?? top.expires_in
  if (typeof access !== 'string' || !/^[\x21-\x7e]+$/.test(access)
    || (refresh !== null && (typeof refresh !== 'string' || !/^[\x21-\x7e]+$/.test(refresh)))
    || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new AccountFailure('invalid-response')
  }
  return { access, refresh, expiresIn }
}

/**
 * Decode only the identity fields displayed by this PC.
 * @param payload - Untrusted account or catalog JSON.
 * @returns Only the id and bounded display username.
 */
export function accountOf(payload: unknown): AccountIdentity {
  const top = object(payload)
  const row = top.account === undefined ? top : object(top.account)
  const id = row.id
  const username = row.username
  if ((typeof id !== 'string' && typeof id !== 'number') || String(id).length === 0
    || typeof username !== 'string' || username.length === 0) throw new AccountFailure('invalid-response')
  return { id: String(id), username: username.slice(0, 128) }
}

/**
 * A private challenge is kept by the Host until its short-lived TOTP step completes.
 * @param payload - Untrusted account or catalog JSON.
 * @returns A Host-only challenge, or undefined when no TOTP step was requested.
 */
export function challengeOf(payload: unknown): { token: string; expiresIn: number } | undefined {
  const row = object(payload)
  if (row.two_factor_required !== true) return undefined
  if (typeof row.challenge_token !== 'string' || row.challenge_token.length === 0
    || typeof row.challenge_expires_in !== 'number' || row.challenge_expires_in <= 0) {
    throw new AccountFailure('invalid-response')
  }
  return { token: row.challenge_token, expiresIn: row.challenge_expires_in }
}

/**
 * Decode a catalog without inferring capability limits from a model name.
 * @param payload - Untrusted account or catalog JSON.
 * @returns Unique validated model identifiers.
 */
export function modelsOf(payload: unknown): string[] {
  const rows = object(payload).data
  if (!Array.isArray(rows)) throw new AccountFailure('invalid-response')
  const ids = rows.map(row => object(row).id)
  if (ids.length === 0 || ids.length > 256 || ids.some(id => typeof id !== 'string' || id.length === 0 || id.length > 128)) {
    throw new AccountFailure('invalid-response')
  }
  return [...new Set(ids as string[])]
}

/** Bounded JSON transport; neither server messages nor thrown fetch errors leave this module. */
export class AccountProtocol {
  /** Validated Shanghai account origin. */
  readonly accountOrigin: string
  /** Validated Guangzhou model API base. */
  readonly gatewayBase: string
  constructor(readonly config: AccountProtocolConfig, private readonly fetcher: typeof fetch = fetch) {
    this.accountOrigin = serverUrl(config.accountOrigin)
    this.gatewayBase = serverUrl(config.gatewayBase)
  }

  /**
   * Send one account or model-catalog operation without cookies or automatic redirects.
   * @param path - Fixed account or catalog endpoint path.
   * @param method - HTTP verb of the operation.
   * @param body - Optional JSON request payload, never logged.
   * @param bearer - Host-only access token, or null for an unauthenticated exchange.
   * @param signal - Account lifetime cancellation.
   * @param gateway - Whether to use the model gateway instead of the account authority.
   * @returns Parsed JSON; failures contain only an allowlisted safe code.
   */
  async request(path: string, method: 'GET' | 'POST', body: unknown,
    bearer: string | null, signal: AbortSignal, gateway = false): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetcher(`${gateway ? this.gatewayBase : `${this.accountOrigin}/api/v8`}${path}`, {
        method, redirect: 'error', credentials: 'omit',
        headers: { accept: 'application/json', 'content-type': 'application/json',
          ...bearer === null ? {} : { authorization: `Bearer ${bearer}` } },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]),
      })
    } catch {
      throw new AccountFailure(signal.aborted ? 'cancelled' : 'unavailable')
    }
    if (response.status === 401 || response.status === 403) throw new AccountFailure(path.startsWith('/auth/login') ? 'invalid-credentials' : 'auth-required')
    if (response.status === 429) throw new AccountFailure('rate-limited')
    if (response.status >= 500) throw new AccountFailure('unavailable')
    if (!response.ok) throw new AccountFailure('invalid-input')
    let payload: unknown
    try { payload = await response.json() } catch { throw new AccountFailure('invalid-response') }
    if (object(payload).ok === false) {
      const code = object(payload).code
      throw new AccountFailure(typeof code === 'string' && code.startsWith('AUTH_')
        ? (path.startsWith('/auth/login') ? 'invalid-credentials' : 'auth-required') : 'invalid-response')
    }
    return payload
  }

  /**
   * Read one JSON response, including a rejected purchase, without turning the body into a login failure.
   * @param path - Fixed account or gateway path.
   * @param method - HTTP verb of the operation.
   * @param body - Optional JSON payload.
   * @param bearer - Host-only access token.
   * @param signal - Account lifetime cancellation.
   * @param gateway - Whether to use the model gateway instead of the account authority.
   * @returns HTTP status and parsed JSON. Network loss stays an allowlisted failure.
   */
  async read(path: string, method: 'GET' | 'POST', body: unknown,
    bearer: string, signal: AbortSignal, gateway = false): Promise<{ status: number; payload: unknown }> {
    let response: Response
    try {
      response = await this.fetcher(`${gateway ? this.gatewayBase : `${this.accountOrigin}/api/v8`}${path}`, {
        method, redirect: 'error', credentials: 'omit',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]),
      })
    } catch {
      throw new AccountFailure(signal.aborted ? 'cancelled' : 'unavailable')
    }
    let payload: unknown
    try { payload = await response.json() } catch { throw new AccountFailure('invalid-response') }
    return { status: response.status, payload }
  }
}
