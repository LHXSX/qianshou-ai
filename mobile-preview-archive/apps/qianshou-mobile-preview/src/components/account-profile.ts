/** Read-only Shanghai profile/session projection preserves identity across delayed responses. */
import { AccountFailure, type AccountClient } from '@deepseek-ai/dsh-client-account'

/** Editable profile fields returned by Shanghai; absent fields are not invented defaults. */
export interface AccountProfile {
  readonly display_name: string | null
  readonly phone: string | null
  readonly language: string | null
  readonly country: string | null
}
/** Raw account sessions retain Shanghai's status and IP fields, omitted by the legacy normalizer. */
export interface LoginSession {
  readonly id: string
  readonly device: string | null
  readonly ip: string | null
  readonly lastSeen: string | null
  readonly current: boolean
  readonly status: 'active' | 'revoked' | 'expired' | null
}
/** Fixed read-only API methods; access credentials remain in the shared client. */
export interface AccountReader {
  readonly profile: (signal: AbortSignal) => Promise<AccountProfile>
  readonly sessions: (signal: AbortSignal) => Promise<readonly LoginSession[]>
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('ACCOUNT_RESPONSE_INVALID')
  return value as Record<string, unknown>
}
const optionalText = (value: unknown): string | null => typeof value === 'string' ? value : null
/**
 * @param options - Shared login client, current verified identity, same-origin fetch and bounded read timeout.
 * @returns A read adapter limited to the two actual Shanghai endpoints.
 */
export function createAccountReader(options: {
  readonly client: AccountClient
  readonly accountId: () => string | null
  readonly fetch: typeof fetch
  readonly origin: string
  readonly timeoutMs: number
}): AccountReader {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('ACCOUNT_READ_TIMEOUT_INVALID')
  const read = async (path: '/my/profile' | '/auth/sessions', external: AbortSignal): Promise<Record<string, unknown>> => {
    const identity = options.accountId()
    if (identity === null) throw new Error('ACCOUNT_REQUIRED')
    const signal = AbortSignal.any([external, AbortSignal.timeout(options.timeoutMs)])
    const current = (): void => { signal.throwIfAborted(); if (options.accountId() !== identity) throw new Error('ACCOUNT_CHANGED') }
    current()
    if (options.client.tokens.isAccessExpired()) { await options.client.refresh(); current() }
    const request = async (): Promise<Response> => {
      current()
      const token = options.client.tokens.readAccess()
      if (!token) throw new AccountFailure('unauthorized', '', { status: 401 })
      return options.fetch(new URL(`/account-api/api/v8${path}`, options.origin), { method: 'GET', signal, credentials: 'omit', redirect: 'error', headers: { authorization: `Bearer ${token}` } })
    }
    let response = await request(); current()
    if (response.status === 401) { await options.client.refresh(); current(); response = await request(); current() }
    if (!response.ok) throw new AccountFailure(response.status === 401 ? 'unauthorized' : response.status === 429 ? 'rate-limited' : 'server-error', '', { status: response.status })
    const payload = object(await response.json()); current()
    if (payload.ok !== true) throw new Error('ACCOUNT_RESPONSE_INVALID')
    if (path === '/my/profile') {
      const user = object(payload.user)
      if ((typeof user.id !== 'string' && typeof user.id !== 'number') || String(user.id) !== identity) throw new Error('ACCOUNT_CHANGED')
    }
    return payload
  }
  return {
    profile: async (signal) => {
      const profile = object(object((await read('/my/profile', signal)).user).profile)
      return {
        display_name: optionalText(profile.display_name), phone: optionalText(profile.phone),
        language: optionalText(profile.language), country: optionalText(profile.country),
      }
    },
    sessions: async (signal) => {
      const payload = await read('/auth/sessions', signal)
      const rows = payload.sessions
      if (!Array.isArray(rows)) throw new Error('ACCOUNT_RESPONSE_INVALID')
      return rows.map((raw: unknown) => {
        const row = object(raw)
        if (typeof row.session_id !== 'string' || !row.session_id || typeof row.is_current !== 'boolean') throw new Error('ACCOUNT_RESPONSE_INVALID')
        return { id: row.session_id, device: optionalText(row.device_name), ip: optionalText(row.client_ip), lastSeen: optionalText(row.last_seen_at), current: row.is_current, status: row.status === 'active' || row.status === 'revoked' || row.status === 'expired' ? row.status : null }
      })
    },
  }
}
