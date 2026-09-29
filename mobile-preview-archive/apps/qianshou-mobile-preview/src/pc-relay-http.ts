/** Browser adapter for the account-authenticated PC relay.
 *
 * The mobile page never receives an owner cookie and never chooses a PC origin.
 * It sends the verified worker id plus the existing pc-window payload to the
 * bounded relay, which performs the worker/owner/origin checks on the server.
 */
import { PcWindowHttpPort, type PcWindowPort } from '@deepseek-ai/dsh-client-pc-window-bridge'

const RELAY_PREFIX = '/api/qianshou/mobile-pc/v1'
const ACTIONS = new Set(['bootstrap', 'access', 'transcript', 'sync', 'submit'])

export interface MobilePcRelayPortOptions {
  readonly workerId: string
  readonly accountId: string
  readonly access: (accountId: string, signal: AbortSignal) => Promise<string | null>
  readonly fetch: typeof globalThis.fetch
  readonly baseUrl?: string
  readonly timeoutMs?: number
}

/**
 * Adapt the shared pc-window connector to the account-scoped relay wire.
 *
 * `PcWindowHttpPort` still validates every binding, receipt, cursor and
 * transcript. This wrapper only changes the outer envelope and supplies the
 * verified Bearer token for each request; it never forwards browser cookies.
 */
export function createMobilePcRelayPort(options: MobilePcRelayPortOptions): PcWindowPort {
  if (!/^[a-zA-Z0-9_-]{1,160}$/u.test(options.workerId)) throw new Error('MOBILE_PC_RELAY_WORKER_INVALID')
  if (!options.accountId.trim()) throw new Error('MOBILE_PC_RELAY_ACCOUNT_INVALID')
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/u, '')
  const relayFetch: typeof globalThis.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, globalThis.location?.origin ?? 'http://127.0.0.1')
    const action = url.pathname.split('/').at(-1) ?? ''
    if (!url.pathname.startsWith('/api/qianshou/mobile/pc-window/') || !ACTIONS.has(action)) {
      throw new Error('MOBILE_PC_RELAY_PATH_INVALID')
    }
    const signal = init?.signal ?? new AbortController().signal
    const token = await options.access(options.accountId, signal)
    signal.throwIfAborted()
    if (!token) throw new Error('MOBILE_PC_RELAY_AUTH_REQUIRED')
    let payload: unknown = {}
    if (typeof init?.body === 'string' && init.body.length > 0) {
      try { payload = JSON.parse(init.body) } catch { throw new Error('MOBILE_PC_RELAY_REQUEST_INVALID') }
    }
    const headers = new Headers(init?.headers)
    headers.delete('cookie')
    headers.set('authorization', `Bearer ${token}`)
    headers.set('content-type', 'application/json')
    return options.fetch(`${baseUrl}${RELAY_PREFIX}/${action}`, {
      ...init,
      headers,
      credentials: 'omit',
      body: JSON.stringify({ workerId: options.workerId, payload }),
    })
  }
  return new PcWindowHttpPort({ baseUrl, fetch: relayFetch, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })
}
