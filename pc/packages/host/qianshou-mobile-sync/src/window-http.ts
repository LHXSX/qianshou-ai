/**
 * Inbound routes the Guangzhou phone relay already calls.
 *
 * `adopt-browser` checks the phone token against Shanghai and this PC's signed-in
 * account, then mints the owner cookie. The five `pc-window` routes stay behind
 * that cookie. Device-only bootstrap asks this PC for its newest continuable
 * Session. Submit admits the phone text into that Session once.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { PcWindowAction, RelayReply, RelayRequest } from './types.ts'

const ACTIONS: readonly PcWindowAction[] = ['bootstrap', 'access', 'transcript', 'sync', 'submit']
const ADOPT_LIMIT = 10
const ADOPT_WINDOW_MS = 60_000
const MAX_TOKEN = 4096
const JSON_HEADERS = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }

/** What the inbound routes need from this PC. The relay's bearer never lands in a log. */
export interface PhoneWindowHttpOptions {
  readonly accountOrigin: string
  readonly currentAccount: () => string | null
  readonly handle: (request: RelayRequest) => Promise<RelayReply>
  readonly issueCookie: (host: string) => string | undefined
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

/**
 * Register adopt, account state and the five phone-window commands.
 * @param ctx - Host that already provides `connection`.
 * @param options - Account proof, cookie mint and the existing window service.
 */
export function registerPhoneWindowRoutes(ctx: Context, options: PhoneWindowHttpOptions): void {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const attempts: number[] = []
  const json = (body: unknown, status = 200, ownerId: string | null = null): Response => {
    const response = Response.json(body, { status, headers: JSON_HEADERS })
    if (ownerId !== null) {
      response.headers.set('x-qianshou-pc-owner-bound', 'v1')
      response.headers.set('x-qianshou-pc-owner-id', encodeURIComponent(ownerId))
    }
    return response
  }
  const limited = (): boolean => {
    const cutoff = now() - ADOPT_WINDOW_MS
    while (attempts.length > 0 && (attempts[0] ?? 0) <= cutoff) attempts.shift()
    if (attempts.length >= ADOPT_LIMIT) return true
    attempts.push(now())
    return false
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/account/adopt-browser', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      if (limited()) return json({ ok: false, code: 'RATE_LIMITED' }, 429)
      const hostAccount = options.currentAccount()
      if (hostAccount === null) return json({ ok: false, code: 'ACCOUNT_SESSION_REQUIRED' }, 401)
      let token = ''
      try {
        const payload: unknown = await request.json()
        const row = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
        token = typeof row.access_token === 'string' ? row.access_token.trim() : ''
      } catch { return json({ ok: false, code: 'AUTH_TOKEN_INVALID' }, 400) }
      if (token.length === 0 || token.length > MAX_TOKEN) return json({ ok: false, code: 'AUTH_TOKEN_INVALID' }, 400)
      const phoneId = await shanghaiAccountId(fetcher, options.accountOrigin, token)
      if (phoneId === null) return json({ ok: false, code: 'AUTH_TOKEN_INVALID' }, 401)
      if (phoneId !== hostAccount) return json({ ok: false, code: 'ACCOUNT_MISMATCH' }, 403)
      const host = request.headers.get('host') ?? new URL(request.url).host
      const cookie = host.length === 0 ? undefined : options.issueCookie(host)
      if (cookie === undefined) return json({ ok: false }, 500)
      return new Response(JSON.stringify({ ok: true, account: { id: hostAccount } }), {
        status: 200,
        headers: { ...JSON_HEADERS, 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie },
      })
    },
  }), 'qianshou-mobile-sync: POST /api/qianshou/account/adopt-browser')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/account/state', methods: ['POST'], requestBody: 'buffered',
    fetch: () => {
      const accountId = options.currentAccount()
      if (accountId === null) return Promise.resolve(json({ state: 'signed-out' }, 401))
      return Promise.resolve(json({ state: 'authenticated', account: { id: accountId } }))
    },
  }), 'qianshou-mobile-sync: POST /api/qianshou/account/state')

  for (const action of ACTIONS) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/qianshou/mobile/pc-window/${action}`, methods: ['POST'], requestBody: 'buffered',
      fetch: async (request) => {
        const accountId = options.currentAccount()
        if (accountId === null) return json({ error: { code: 'PC_WINDOW_NOT_SIGNED_IN', message: 'PC_WINDOW_NOT_SIGNED_IN' } }, 401)
        let payload: unknown
        try { payload = await request.json() } catch {
          return json({ error: { code: 'PC_WINDOW_BAD_REQUEST', message: 'PC_WINDOW_BAD_REQUEST' } }, 400)
        }
        const reply = await options.handle({ id: 'http', action, accountId, payload: objectOf(payload) })
        const body = action === 'bootstrap' && reply.status === 200 ? bootstrapBody(reply.body) : reply.body
        return json(body, reply.status, reply.ownerBound?.accountId ?? null)
      },
    }), `qianshou-mobile-sync: POST /api/qianshou/mobile/pc-window/${action}`)
  }
}

/** Bootstrap answer the relay keeps: the binding and access, not the session catalogue. */
function bootstrapBody(value: unknown): unknown {
  const row = objectOf(value)
  return { binding: row.binding, access: row.access }
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Account id Shanghai reports for this bearer.
 * @param fetcher - HTTP implementation; tests pass a stub.
 * @param origin - Account API origin, without a path.
 * @param token - Phone access token from the relay body. Not logged.
 * @returns The id, or `null` when Shanghai does not confirm one.
 */
async function shanghaiAccountId(fetcher: typeof fetch, origin: string, token: string): Promise<string | null> {
  let response: Response
  try {
    response = await fetcher(new URL('/api/v8/auth/me', origin), {
      method: 'GET', redirect: 'manual',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch { return null }
  if (!response.ok) { await response.body?.cancel(); return null }
  let payload: unknown
  try { payload = await response.json() } catch { return null }
  const source = objectOf(payload)
  const nested = source.account
  const row = nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : source
  const id = row.id
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id)
  if (typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(id)) return id
  return null
}
