/** Account-authenticated forum proxy on the existing browser-authenticated `/api` channel. */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { COMMUNITY_PATH } from '../client/community/paths.ts'

const ACTIONS = [
  'categories', 'topics', 'topic', 'topic/create', 'reply/create', 'topic/solve', 'report',
] as const
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export interface CommunityAccountSession {
  ensureAccessToken(): Promise<string | null>
}

export interface CommunityRelayOptions {
  readonly origin?: string
  readonly fetchImpl?: typeof fetch
}

/** Reject an arbitrary external proxy destination during Host activation. */
export function communityOrigin(input: string): URL {
  const url = new URL(input)
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!(url.protocol === 'https:' || loopback) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('QIANSHOU_FORUM_API_BASE must be an HTTPS origin or loopback HTTP origin')
  }
  return url
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function boundedBody(request: { readonly body: ReadableStream<Uint8Array> | null }, limit: number): Promise<string | null> {
  if (request.body === null) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > limit) { await reader.cancel(); return null }
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** Build exact routes so the Connection carrier applies its cookie, Host and Origin checks first. */
export function communityRoutes(account: CommunityAccountSession, options: CommunityRelayOptions = {}): readonly ConnectionFetchRoute[] {
  const origin = communityOrigin(options.origin ?? (process.env as Record<string, string | undefined>).QIANSHOU_FORUM_API_BASE ?? 'https://admin.qianshousuanli.com')
  const request = options.fetchImpl ?? fetch
  return ACTIONS.map(action => ({
    path: `${COMMUNITY_PATH}/${action}`,
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: async (incoming: Request): Promise<Response> => {
      if (incoming.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return json(415, { ok: false, code: 'FORUM_CONTENT_TYPE' })
      }
      let body: string | null
      try { body = await boundedBody(incoming, MAX_REQUEST_BYTES) }
      catch { return json(400, { ok: false, code: 'FORUM_BODY_INVALID' }) }
      if (body === null) return json(413, { ok: false, code: 'FORUM_BODY_TOO_LARGE' })
      let payload: unknown
      try { payload = JSON.parse(body) }
      catch { return json(400, { ok: false, code: 'FORUM_BODY_INVALID' }) }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return json(400, { ok: false, code: 'FORUM_BODY_INVALID' })
      }
      const token = await account.ensureAccessToken()
      if (!token) return json(401, { ok: false, code: 'FORUM_ACCOUNT_REQUIRED' })
      const target = new URL(`${COMMUNITY_PATH}/${action}`, origin)
      let result: Response
      try {
        result = await request(target, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          body,
          redirect: 'error',
          signal: AbortSignal.any([incoming.signal, AbortSignal.timeout(10_000)]),
        })
      } catch {
        return json(502, { ok: false, code: 'FORUM_UPSTREAM_UNAVAILABLE' })
      }
      if (result.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/html') {
        return json(503, { ok: false, code: 'FORUM_NOT_LIVE' })
      }
      let answer: string | null
      try { answer = await boundedBody(result, MAX_RESPONSE_BYTES) }
      catch { answer = null }
      if (answer === null) return json(502, { ok: false, code: 'FORUM_UPSTREAM_INVALID' })
      let decoded: unknown
      try { decoded = JSON.parse(answer) }
      catch { return json(502, { ok: false, code: 'FORUM_UPSTREAM_INVALID' }) }
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)
        || typeof (decoded as { ok?: unknown }).ok !== 'boolean') {
        return json(502, { ok: false, code: 'FORUM_UPSTREAM_INVALID' })
      }
      if ([204, 205, 304].includes(result.status)) return json(502, { ok: false, code: 'FORUM_UPSTREAM_INVALID' })
      return json(result.status, decoded)
    },
  }))
}
