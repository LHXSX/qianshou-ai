/** Strict read-only promotion/referral projection. It never invents rewards or balances. */
import { AccountFailure } from './failures.ts'
import type { AccountClient } from './auth.ts'

export interface PromotionSnapshot {
  readonly inviteUrl: string | null
  readonly invitedCount: number | null
  readonly pendingPoints: number | null
  readonly settledPoints: number | null
  readonly status: 'ready' | 'pending' | 'failed'
  readonly message: string | null
}

export interface PromotionReader {
  readonly summary: (signal: AbortSignal) => Promise<PromotionSnapshot>
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('PROMOTION_RESPONSE_INVALID')
  return value as Record<string, unknown>
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }
function count(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null }
function optionalCount(source: Record<string, unknown>, ...keys: string[]): number | null {
  const key = keys.find(name => source[name] !== undefined)
  if (key === undefined) return null
  const value = count(source[key]); if (value === null) throw new Error('PROMOTION_RESPONSE_INVALID'); return value
}

export function parsePromotionSnapshot(payload: unknown, accountId: string): PromotionSnapshot {
  const root = object(payload)
  if (root.ok !== true) throw new Error('PROMOTION_RESPONSE_INVALID')
  const owner = root.accountId ?? root.account_id
  if (owner !== undefined && String(owner) !== accountId) throw new Error('ACCOUNT_CHANGED')
  const data = root.promotion === undefined ? root : object(root.promotion)
  const status = data.status === 'ready' || data.status === 'pending' || data.status === 'failed' ? data.status : null
  if (status === null) throw new Error('PROMOTION_RESPONSE_INVALID')
  const inviteValue = data.inviteUrl ?? data.invite_url
  if (inviteValue !== undefined && text(inviteValue) === null) throw new Error('PROMOTION_RESPONSE_INVALID')
  return { inviteUrl: text(inviteValue), invitedCount: optionalCount(data, 'invitedCount', 'invited_count'), pendingPoints: optionalCount(data, 'pendingPoints', 'pending_points'), settledPoints: optionalCount(data, 'settledPoints', 'settled_points'), status, message: text(data.message) }
}

/**
 * The default route is deliberately opt-in: current production evidence has
 * no referral API, so a missing/404 route stays in a pending state.
 */
export function createPromotionReader(options: { readonly client: AccountClient; readonly accountId: () => string | null; readonly fetch: typeof fetch; readonly origin: string; readonly path?: string; readonly timeoutMs: number }): PromotionReader {
  const path = options.path ?? '/account-api/api/v8/promotion/summary'
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('PROMOTION_READ_TIMEOUT_INVALID')
  return { summary: async (external) => {
    const accountId = options.accountId(); if (accountId === null) throw new Error('ACCOUNT_REQUIRED')
    const signal = AbortSignal.any([external, AbortSignal.timeout(options.timeoutMs)])
    if (options.client.tokens.isAccessExpired()) await options.client.refresh()
    const token = options.client.tokens.readAccess(); if (!token) throw new AccountFailure('unauthorized', '', { status: 401 })
    const response = await options.fetch(new URL(path, options.origin), { method: 'GET', signal, credentials: 'omit', redirect: 'error', headers: { authorization: `Bearer ${token}` } })
    if (response.status === 404) return { inviteUrl: null, invitedCount: null, pendingPoints: null, settledPoints: null, status: 'pending', message: 'PROMOTION_ROUTE_UNAVAILABLE' }
    if (!response.ok) throw new AccountFailure(response.status === 401 ? 'unauthorized' : response.status === 429 ? 'rate-limited' : 'server-error', '', { status: response.status })
    return parsePromotionSnapshot(await response.json(), accountId)
  } }
}
