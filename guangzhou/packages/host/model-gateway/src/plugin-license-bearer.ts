/** Request-bound Shanghai account verification for Mac plugin free claims. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Principal } from './admin-routes.ts'

/** Outside the browser-cookie carrier; reverse proxies must explicitly forward this path. */
export const PLUGIN_LICENSE_BEARER_PATH = '/qianshou-market/license'
const MAX_REQUEST_BYTES = 4096
const MAX_IDENTITY_BYTES = 32 * 1024
const BEARER = /^Bearer ([\x21-\x7e]{16,4096})$/u

export interface PluginLicenseBearerOptions {
  /** Fixed Shanghai account API origin. Missing configuration fails closed. */
  readonly accountApiOrigin?: string
  readonly fetcher?: typeof fetch
}

function fixedOrigin(raw: string): string {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('PLUGIN_LICENSE_ACCOUNT_ORIGIN_INVALID')
  }
  return url.origin
}

async function boundedJson(response: Response): Promise<unknown> {
  const announced = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(announced) && announced > MAX_IDENTITY_BYTES) throw new Error('ACCOUNT_VERIFICATION_UNAVAILABLE')
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('ACCOUNT_VERIFICATION_UNAVAILABLE')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_IDENTITY_BYTES) throw new Error('ACCOUNT_VERIFICATION_UNAVAILABLE')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => undefined) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new Error('ACCOUNT_VERIFICATION_UNAVAILABLE') }
}

/** A token identifies exactly its own account; the process's browser session is never consulted. */
export function createPluginLicenseBearerVerifier(options: PluginLicenseBearerOptions):
  (request: Request) => Promise<(Principal & { username: string | null }) | null> {
  const origin = options.accountApiOrigin === undefined ? null : fixedOrigin(options.accountApiOrigin)
  const fetcher = options.fetcher ?? fetch
  return async request => {
    if (origin === null) throw new Error('ACCOUNT_VERIFICATION_UNAVAILABLE')
    const matched = BEARER.exec(request.headers.get('authorization') ?? '')
    if (matched === null) return null
    let response: Response
    try {
      response = await fetcher(`${origin}/api/v8/auth/me`, {
        method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { authorization: `Bearer ${matched[1]}`, accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      })
    } catch { throw new Error('ACCOUNT_VERIFICATION_UNAVAILABLE') }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('ACCOUNT_VERIFICATION_UNAVAILABLE')
    }
    const payload = await boundedJson(response)
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('ACCOUNT_VERIFICATION_UNAVAILABLE')
    const top = payload as Record<string, unknown>
    const account = top['account']
    if (top['ok'] !== true || account === null || typeof account !== 'object' || Array.isArray(account)) {
      throw new Error('ACCOUNT_VERIFICATION_UNAVAILABLE')
    }
    const row = account as Record<string, unknown>
    const id = row['id']
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new Error('ACCOUNT_VERIFICATION_UNAVAILABLE')
    const role = typeof row['role'] === 'string' && row['role'].length <= 64 ? row['role'] : 'personal'
    const username = typeof row['username'] === 'string' && row['username'].trim().length > 0
      && Buffer.byteLength(row['username']) <= 512 && !/[\u0000-\u001f\u007f]/u.test(row['username']) ? row['username'] : null
    return { accountId: String(id), role, isAdmin: false, username }
  }
}

/** Bridge Node's public webServer route to the existing free-license service without forwarding cookies. */
export function createPluginLicenseBearerRoute(options: {
  readonly handle: (request: Request) => Promise<Response>
}): { readonly kind: 'exact'; readonly path: string;
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> } {
  return {
    kind: 'exact', path: PLUGIN_LICENSE_BEARER_PATH,
    handler: async (incoming, outgoing) => {
      const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' }
      const reject = (status: number, code: string, allow?: string): void => {
        outgoing.writeHead(status, { ...headers, ...(allow === undefined ? {} : { allow }) })
        outgoing.end(JSON.stringify({ ok: false, code }))
      }
      if (incoming.method !== 'POST') return reject(405, 'METHOD_NOT_ALLOWED', 'POST')
      if (incoming.url !== PLUGIN_LICENSE_BEARER_PATH) return reject(400, 'BAD_REQUEST')
      if (incoming.headers.origin !== undefined || incoming.headers['sec-fetch-site'] === 'cross-site') {
        return reject(403, 'CROSS_ORIGIN_FORBIDDEN')
      }
      const authHeaders = incoming.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization')
      if (authHeaders.length !== 1 || typeof incoming.headers.authorization !== 'string'
        || BEARER.exec(incoming.headers.authorization) === null) return reject(401, 'LOGIN_REQUIRED')
      const announced = Number(incoming.headers['content-length'] ?? '0')
      if (!Number.isSafeInteger(announced) || announced < 0 || announced > MAX_REQUEST_BYTES
        || incoming.headers['content-encoding'] !== undefined) return reject(400, 'BAD_REQUEST')
      const chunks: Buffer[] = []
      let size = 0
      try {
        for await (const chunk of incoming) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
          size += bytes.length
          if (size > MAX_REQUEST_BYTES) return reject(400, 'BAD_REQUEST')
          chunks.push(bytes)
        }
        const request = new Request(`https://qianshou.local${PLUGIN_LICENSE_BEARER_PATH}`, {
          method: 'POST', headers: { authorization: incoming.headers.authorization, 'content-type': 'application/json' },
          body: Buffer.concat(chunks).toString('utf8'),
        })
        const response = await options.handle(request)
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      } catch {
        if (outgoing.headersSent) outgoing.destroy()
        else reject(503, 'PLUGIN_LICENSE_UNAVAILABLE')
      }
    },
  }
}
