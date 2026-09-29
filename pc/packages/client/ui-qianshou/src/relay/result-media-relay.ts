/** Same-origin, account-authenticated media viewing without a browser-visible grant. */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { ownedResultVideoKind } from './result-media-review.ts'

export const RESULT_MEDIA_PATH = '/api/qianshou/result-media'
/** Operator-owned Guangzhou result service; overrides remain origin-validated. */
export const DEFAULT_RESULT_MEDIA_ORIGIN = 'https://app.qianshousuanli.com'
const MAX_MEDIA_BYTES = 64 * 1024 * 1024
const MAX_GRANT_BYTES = 12 * 1024
const MAX_OWNER_DETAIL_BYTES = 512 * 1024
const MAX_IDENTITY_BYTES = 12 * 1024
const TASK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const ASSET = /^[0-9a-f]{64}$/u
const GRANT = /^[A-Za-z0-9_-]{1,8192}$/u
const RANGE = /^bytes=(\d{0,16})-(\d{0,16})$/u
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/u
const UNSATISFIABLE = /^bytes \*\/(\d+)$/u
const MEDIA_TYPES_BY_EXTENSION = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'], ['gif', 'image/gif'], ['mp4', 'video/mp4'],
  ['webm', 'video/webm'], ['mov', 'video/quicktime'],
])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov'])

export interface ResultMediaAccountSession {
  ensureAccessToken(): Promise<string | null>
}

export interface ResultMediaRelayOptions {
  /** Shanghai control plane; only issues a short viewer grant, never sends media bytes. */
  readonly coreOrigin?: string
  /** Guangzhou media endpoint. Defaults to the pinned official result service. */
  readonly mediaOrigin?: string
  readonly fetchImpl?: typeof fetch
}

export function resultMediaOrigin(input: string): URL {
  const url = new URL(input)
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!(url.protocol === 'https:' || loopback) || !url.hostname || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('result media origin must be HTTPS or loopback HTTP')
  }
  return url
}

function error(status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: false, code }), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  } })
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.byteLength
      if (length > limit) { await reader.cancel(); return null }
      chunks.push(item.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

async function controlJson(response: Response, limit: number): Promise<unknown | null> {
  if (response.status !== 200
    || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return null
  const bytes = await boundedBytes(response, limit).catch(() => null)
  if (bytes === null) return null
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
  catch { return null }
}

function validRange(value: string | null): string | null | false {
  if (value === null) return null
  const match = RANGE.exec(value)
  if (!match || (!match[1] && !match[2])) return false
  const first = match[1] ?? ''
  const last = match[2] ?? ''
  if ((first && (!Number.isSafeInteger(Number(first)) || Number(first) > MAX_MEDIA_BYTES))
    || (last && (!Number.isSafeInteger(Number(last)) || Number(last) > MAX_MEDIA_BYTES))
    || (!first && Number(last) < 1)
    || (first && last && Number(last) < Number(first))) return false
  return value
}

function validMediaLength(response: Response, range: string | null, expectedType: string): number | null {
  if (![200, 206].includes(response.status)
    || (response.headers.get('content-encoding') ?? 'identity') !== 'identity'
    || response.headers.get('content-type')?.trim().toLowerCase() !== expectedType) return null
  const declared = response.headers.get('content-length')
  if (!declared || !/^[1-9][0-9]*$/u.test(declared)) return null
  const length = Number(declared)
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_MEDIA_BYTES) return null
  if (range === null) return response.status === 200 ? length : null
  if (response.status !== 206) return null
  const match = CONTENT_RANGE.exec(response.headers.get('content-range') ?? '')
  if (!match) return null
  const start = Number(match[1]); const end = Number(match[2]); const total = Number(match[3])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)
    || total < 1 || total > MAX_MEDIA_BYTES || start < 0 || end < start || end >= total
    || end - start + 1 !== length) return null
  const asked = RANGE.exec(range)
  if (asked === null) return null
  if (asked[1]) {
    if (start !== Number(asked[1]) || (asked[2] && end > Number(asked[2]))) return null
  } else if (end !== total - 1 || length > Number(asked[2])) return null
  return length
}

/** Connection applies its local browser trust/cookie gate before this exact route. */
export function resultMediaRoutes(account: ResultMediaAccountSession,
  options: ResultMediaRelayOptions = {}): readonly ConnectionFetchRoute[] {
  const core = resultMediaOrigin(options.coreOrigin
    ?? (process.env as Record<string, string | undefined>).QIANSHOU_RESULT_MEDIA_CORE_BASE
    ?? 'https://qianshousuanli.com')
  const configured = options.mediaOrigin
    ?? (process.env as Record<string, string | undefined>).QIANSHOU_RESULT_MEDIA_BASE
    ?? DEFAULT_RESULT_MEDIA_ORIGIN
  let media: URL | null = null
  try { if (configured) media = resultMediaOrigin(configured) } catch { /* Fail closed without disabling the app. */ }
  // Operator configuration cannot turn the control plane into a byte relay.
  if (media?.hostname === core.hostname) media = null
  const request = options.fetchImpl ?? fetch
  return [{ path: RESULT_MEDIA_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: async (incoming) => {
      const url = new URL(incoming.url)
      if (url.searchParams.getAll('task_id').length !== 1
        || url.searchParams.getAll('asset_id').length !== 1
        || url.searchParams.getAll('type').length !== 1
        || [...url.searchParams.keys()].length !== 3) return error(400, 'RESULT_MEDIA_REQUEST_INVALID')
      const taskId = url.searchParams.get('task_id') ?? ''
      const assetId = url.searchParams.get('asset_id') ?? ''
      const mediaType = url.searchParams.get('type') ?? ''
      const expectedType = MEDIA_TYPES_BY_EXTENSION.get(mediaType)
      if (!TASK.test(taskId) || !ASSET.test(assetId) || expectedType === undefined) {
        return error(400, 'RESULT_MEDIA_REQUEST_INVALID')
      }
      const range = validRange(incoming.headers.get('range'))
      if (range === false) return error(416, 'RESULT_MEDIA_RANGE_INVALID')
      if (!media) return error(503, 'RESULT_MEDIA_NOT_CONFIGURED')
      const token = await account.ensureAccessToken().catch(() => null)
      if (!token) return error(401, 'RESULT_MEDIA_ACCOUNT_REQUIRED')
      const grantRequest = { method: 'GET', headers: {
        authorization: `Bearer ${token}`, accept: 'application/json',
      }, credentials: 'omit' as const, cache: 'no-store' as const, redirect: 'error' as const,
      signal: AbortSignal.any([incoming.signal, AbortSignal.timeout(10_000)]) }
      let reviewed = false
      if (VIDEO_EXTENSIONS.has(mediaType)) {
        let detail: Response
        let identity: Response
        try {
          detail = await request(new URL(`/api/v8/workloads/${taskId}`, core), grantRequest)
          if (detail.status === 401 || detail.status === 403) return error(401, 'RESULT_MEDIA_ACCOUNT_REQUIRED')
          const detailBody = await controlJson(detail, MAX_OWNER_DETAIL_BYTES)
          if (detailBody === null) return error(502, 'RESULT_MEDIA_OWNER_UNVERIFIED')
          identity = await request(new URL('/api/v8/auth/me', core), grantRequest)
          if (identity.status === 401 || identity.status === 403) return error(401, 'RESULT_MEDIA_ACCOUNT_REQUIRED')
          const identityBody = await controlJson(identity, MAX_IDENTITY_BYTES)
          const kind = ownedResultVideoKind(taskId, assetId, mediaType, detailBody, identityBody)
          if (kind === null) return error(502, 'RESULT_MEDIA_OWNER_UNVERIFIED')
          reviewed = kind === 'reviewed'
        } catch { return error(502, 'RESULT_MEDIA_OWNER_UNVERIFIED') }
      }
      const grantUrl = new URL(`/api/v8/workloads/${taskId}/media-view-grant`, core)
      grantUrl.searchParams.set('asset_id', assetId)
      let granted: Response
      try {
        granted = await request(grantUrl, grantRequest)
        if (granted.status === 404 && !reviewed) {
          // Older developer-task media has a distinct route. Only a definite
          // workload-route miss may fall back; auth and upstream failures do not.
          const developerGrant = new URL(`/api/v8/developer/tasks/${taskId}/media-view-grant`, core)
          developerGrant.searchParams.set('asset_id', assetId)
          granted = await request(developerGrant, grantRequest)
        }
      } catch { return error(502, 'RESULT_MEDIA_GRANT_UNAVAILABLE') }
      if (granted.status === 401 || granted.status === 403) return error(401, 'RESULT_MEDIA_ACCOUNT_REQUIRED')
      if (granted.status === 404) return error(404, 'RESULT_MEDIA_NOT_FOUND')
      if (granted.status !== 200
        || granted.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return error(502, 'RESULT_MEDIA_GRANT_UNAVAILABLE')
      }
      const grantBytes = await boundedBytes(granted, MAX_GRANT_BYTES).catch(() => null)
      let grant: unknown
      try { grant = grantBytes && JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(grantBytes)) }
      catch { return error(502, 'RESULT_MEDIA_GRANT_INVALID') }
      if (!grant || typeof grant !== 'object' || Array.isArray(grant)
        || (grant as Record<string, unknown>).ok !== true
        || typeof (grant as Record<string, unknown>).grant !== 'string'
        || !GRANT.test((grant as { grant: string }).grant)) return error(502, 'RESULT_MEDIA_GRANT_INVALID')
      const mediaUrl = new URL('/media/result', media)
      mediaUrl.searchParams.set('task_id', taskId)
      mediaUrl.searchParams.set('asset_id', assetId)
      let upstream: Response
      try {
        upstream = await request(mediaUrl, { method: 'GET', headers: {
          authorization: `Bearer ${(grant as { grant: string }).grant}`,
          accept: expectedType, ...(range ? { range } : {}),
        }, credentials: 'omit', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([incoming.signal, AbortSignal.timeout(30_000)]) })
      } catch { return error(502, 'RESULT_MEDIA_UPSTREAM_UNAVAILABLE') }
      if (upstream.status === 404) return error(404, 'RESULT_MEDIA_NOT_FOUND')
      if (upstream.status === 416 && range !== null) {
        const match = UNSATISFIABLE.exec(upstream.headers.get('content-range') ?? '')
        const total = Number(match?.[1])
        if (!match || !Number.isSafeInteger(total) || total < 1 || total > MAX_MEDIA_BYTES) {
          return error(502, 'RESULT_MEDIA_UPSTREAM_INVALID')
        }
        return new Response(null, { status: 416, headers: {
          'content-range': `bytes */${total}`, 'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        } })
      }
      const length = validMediaLength(upstream, range, expectedType)
      if (length === null) return error(502, 'RESULT_MEDIA_UPSTREAM_INVALID')
      const bytes = await boundedBytes(upstream, MAX_MEDIA_BYTES).catch(() => null)
      if (bytes === null || bytes.byteLength !== length) return error(502, 'RESULT_MEDIA_UPSTREAM_INVALID')
      const contentRange = range === null ? null : upstream.headers.get('content-range')
      if (range !== null && contentRange === null) return error(502, 'RESULT_MEDIA_UPSTREAM_INVALID')
      const headers: Record<string, string> = {
        'content-type': expectedType, 'content-length': String(length),
        'accept-ranges': 'bytes', 'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'no-referrer',
      }
      if (contentRange !== null) headers['content-range'] = contentRange
      return new Response(bytes.slice(), { status: upstream.status, headers })
    },
  }]
}
