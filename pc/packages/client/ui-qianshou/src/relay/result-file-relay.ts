/** Same-origin owner file delivery; no grant, storage address or preview reaches the renderer. */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

/** Exact local route registered behind the connection's browser trust gate. */
export const RESULT_FILE_PATH = '/api/qianshou/result-file'
const MAX_FILE_BYTES = 16_384
const MAX_GRANT_BYTES = 12_288
const TASK = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const ASSET = /^[a-f0-9]{64}$/u
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const B64URL = /^[A-Za-z0-9_-]{1,8192}$/u
const SHA = /^sha256:[a-f0-9]{64}$/u
const TASK_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/u
const VERSION = /^[A-Za-z0-9_.~+-]{1,200}$/u
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u
const PAYLOAD_FIELDS = ['account_id', 'asset_id', 'attempt', 'audience', 'bucket', 'content_type', 'contract_sha256',
  'expires_at', 'file_bytes_attested', 'file_schema_sha256', 'filename', 'issued_at', 'object_key', 'object_version_id',
  'policy_id', 'purpose', 'receipt_id', 'receipt_sha256', 'result_finalized', 'result_id', 'schema', 'sha256', 'shard_id',
  'size_bytes', 'task_id', 'task_type', 'worker_id', 'workload_id'].join(',')

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value)
}

function base64urlBytes(value: string): Uint8Array {
  const raw = Uint8Array.from(atob(value.replace(/-/gu, '+').replace(/_/gu, '/')), part => part.charCodeAt(0))
  if (btoa(String.fromCharCode(...raw)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '') !== value) {
    throw new Error('file grant encoding noncanonical')
  }
  return raw
}

/** Host account session; the token is never returned to the browser. */
export interface ResultFileAccountSession {
  /** Resolve the current authenticated account's control-plane access token. */
  ensureAccessToken(): Promise<string | null>
}

/** Explicit file-purpose configuration; absence keeps this route closed. */
export interface ResultFileRelayOptions {
  readonly enabled?: boolean
  readonly coreOrigin?: string
  readonly fileOrigin?: string
  /** Read the current signed-in account independently from the captured token. */
  readonly accountIdOf: () => Promise<number | null>
  readonly fetchImpl?: typeof fetch
}

function origin(value: string): URL {
  const parsed = new URL(value)
  const loopback = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  if (!(parsed.protocol === 'https:' || loopback) || !parsed.hostname || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('file result origin invalid')
  return parsed
}

function failure(status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: false, code }), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  } })
}

async function bounded(response: Response, limit: number, signal: AbortSignal,
  assertCurrent: () => Promise<void>): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('file response missing')
  const cancel = (): void => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const item = await reader.read()
      signal.throwIfAborted()
      await assertCurrent()
      if (item.done) break
      length += item.value.byteLength
      if (length > limit) throw new Error('file response exceeds bound')
      chunks.push(item.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function privateGrant(bytes: Uint8Array, accountId: number, taskId: string, assetId: string): { token: string; filename: string; length: number } {
  const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (body === null || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join(',') !== 'grant,ok'
    || (body as { ok?: unknown }).ok !== true) throw new Error('file grant response invalid')
  const token = (body as { grant?: unknown }).grant
  if (typeof token !== 'string' || !B64URL.test(token)) throw new Error('file grant encoding invalid')
  const raw = base64urlBytes(token)
  const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(',') !== 'key_id,payload,signature') throw new Error('file grant envelope invalid')
  const payload = (envelope as { payload?: unknown }).payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('file grant payload invalid')
  const e = envelope as Record<string, unknown>, p = payload as Record<string, unknown>
  if (Object.keys(p).sort().join(',') !== PAYLOAD_FIELDS
    || !matches(e.key_id, /^[A-Za-z0-9_.-]{1,64}$/u)
    || !matches(e.signature, /^[A-Za-z0-9_-]{86}$/u) || base64urlBytes(e.signature).length !== 64) {
    throw new Error('file grant fields invalid')
  }
  if (p.schema !== 'qianshou.file-download-grant.v1' || p.audience !== 'guangzhou-result-file'
    || p.purpose !== 'qianshou:file-result-download' || p.policy_id !== 'independent-file-bytes.v1'
    || p.account_id !== accountId || p.task_id !== taskId || p.workload_id !== taskId
    || !['shard_id', 'result_id', 'worker_id', 'receipt_id'].every(key => matches(p[key], TASK))
    || !matches(p.contract_sha256, SHA) || !matches(p.receipt_sha256, SHA) || !matches(p.file_schema_sha256, ASSET)
    || !matches(p.task_type, TASK_TYPE) || !Number.isSafeInteger(p.attempt) || (p.attempt as number) < 1 || (p.attempt as number) > 1_000_000
    || !matches(p.bucket, /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u)
    || !matches(p.content_type, MIME) || !matches(p.object_version_id, VERSION) || p.object_version_id === 'null'
    || p.object_key !== `v8/account-${accountId}/workload-${taskId}/shard-${String(p.shard_id)}/result/${String(p.result_id)}/${String(p.filename)}`
    || p.asset_id !== assetId || p.sha256 !== assetId || p.result_finalized !== true || p.file_bytes_attested !== true
    || typeof p.filename !== 'string' || !FILENAME.test(p.filename) || p.filename.includes('..')
    || typeof p.size_bytes !== 'number' || !Number.isSafeInteger(p.size_bytes) || p.size_bytes < 1 || p.size_bytes > MAX_FILE_BYTES
    || typeof p.issued_at !== 'number' || !Number.isSafeInteger(p.issued_at)
    || typeof p.expires_at !== 'number' || !Number.isSafeInteger(p.expires_at)
    || p.issued_at < Math.floor(Date.now() / 1000) - 65 || p.issued_at > Math.floor(Date.now() / 1000) + 5 || p.expires_at <= Math.floor(Date.now() / 1000)
    || p.expires_at - p.issued_at < 1 || p.expires_at - p.issued_at > 60) throw new Error('file grant binding invalid')
  const canonical = JSON.stringify({ key_id: e.key_id,
    payload: Object.fromEntries(Object.keys(p).sort().map(key => [key, p[key]])), signature: e.signature })
  if (canonical !== new TextDecoder('utf-8', { fatal: true }).decode(raw)) throw new Error('file grant JSON noncanonical')
  return { token, filename: p.filename, length: p.size_bytes }
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, 50)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

/** Register bounded attachment delivery with current-account and cancellation checks across every await.
 * @param account - Host account token port.
 * @param options - Explicit off-Shanghai origin and independently observed account identity.
 * @returns Exact local file route; missing enrollment leaves it closed.
 */
export function resultFileRoutes(account: ResultFileAccountSession, options: ResultFileRelayOptions): readonly ConnectionFetchRoute[] {
  const env = process.env as Record<string, string | undefined>
  const core = origin(options.coreOrigin ?? env.QIANSHOU_RESULT_FILE_CORE_BASE ?? 'https://qianshousuanli.com')
  let files: URL | null = null
  try {
    if (options.enabled ?? env.QIANSHOU_RESULT_FILE_ENABLED === '1') files = origin(options.fileOrigin ?? env.QIANSHOU_RESULT_FILE_BASE ?? '')
  } catch { /* Missing operator file enrollment keeps the route closed. */ }
  if (files?.hostname.replace(/^www\./u, '') === core.hostname.replace(/^www\./u, '')) files = null
  const fetcher = options.fetchImpl ?? fetch
  return [{ path: RESULT_FILE_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async incoming => {
    const url = new URL(incoming.url)
    const taskId = url.searchParams.get('task_id') ?? '', assetId = url.searchParams.get('asset_id') ?? ''
    if (url.searchParams.getAll('task_id').length !== 1 || url.searchParams.getAll('asset_id').length !== 1
      || [...url.searchParams.keys()].length !== 2 || !TASK.test(taskId) || !ASSET.test(assetId)
      || incoming.headers.has('range')) return failure(400, 'RESULT_FILE_REQUEST_INVALID')
    if (!files) return failure(503, 'RESULT_FILE_NOT_CONFIGURED')
    const lifetime = new AbortController()
    const deadline = AbortSignal.timeout(30_000)
    const signal = AbortSignal.any([incoming.signal, lifetime.signal, deadline])
    let expected: number | null = null
    let changed = false
    const assertCurrent = async (): Promise<void> => {
      signal.throwIfAborted()
      if (expected === null || await options.accountIdOf() !== expected) {
        changed = true; lifetime.abort(); throw new Error('file account changed')
      }
      signal.throwIfAborted()
    }
    let observation: Promise<void> | null = null
    const ownedResponses = new Set<Response>()
    let completed: { bytes: Uint8Array; disposition: string } | null = null
    try {
      signal.throwIfAborted()
      expected = await options.accountIdOf()
      if (expected === null || !Number.isSafeInteger(expected) || expected < 1) return failure(401, 'RESULT_FILE_ACCOUNT_REQUIRED')
      observation = (async () => {
        while (!signal.aborted) {
          await pause(signal)
          if (signal.aborted) break
          try { await assertCurrent() } catch { lifetime.abort(); break }
        }
      })()
      const token = await account.ensureAccessToken()
      await assertCurrent()
      if (!token) return failure(401, 'RESULT_FILE_ACCOUNT_REQUIRED')
      const grantUrl = new URL(`/api/v8/workloads/${taskId}/file-download-grant`, core)
      grantUrl.searchParams.set('asset_id', assetId)
      const control = await fetcher(grantUrl, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' } })
      ownedResponses.add(control)
      await assertCurrent()
      if ([401, 403].includes(control.status)) { await control.body?.cancel(); return failure(401, 'RESULT_FILE_ACCOUNT_REQUIRED') }
      if (control.status === 404) { await control.body?.cancel(); return failure(404, 'RESULT_FILE_NOT_FOUND') }
      if (control.status !== 200 || control.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
        await control.body?.cancel(); return failure(502, 'RESULT_FILE_GRANT_UNAVAILABLE')
      }
      const grant = privateGrant(await bounded(control, MAX_GRANT_BYTES, signal, assertCurrent), expected, taskId, assetId)
      await assertCurrent()
      const target = new URL('/file/result', files)
      target.searchParams.set('task_id', taskId); target.searchParams.set('asset_id', assetId)
      const upstream = await fetcher(target, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
        headers: { authorization: `Bearer ${grant.token}`, accept: 'application/octet-stream' } })
      ownedResponses.add(upstream)
      await assertCurrent()
      const disposition = `attachment; filename="${grant.filename}"`
      if (upstream.status !== 200 || upstream.headers.get('content-type') !== 'application/octet-stream'
        || upstream.headers.get('content-length') !== String(grant.length)
        || upstream.headers.get('content-disposition') !== disposition
        || upstream.headers.get('x-content-type-options') !== 'nosniff'
        || (upstream.headers.get('content-encoding') ?? 'identity') !== 'identity'
        || upstream.headers.get('x-qianshou-content-sha256') !== assetId) {
        await upstream.body?.cancel(); return failure(502, 'RESULT_FILE_UPSTREAM_INVALID')
      }
      const bytes = await bounded(upstream, MAX_FILE_BYTES, signal, assertCurrent)
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))
      await assertCurrent()
      if (bytes.length !== grant.length || [...digest].map(value => value.toString(16).padStart(2, '0')).join('') !== assetId) {
        return failure(502, 'RESULT_FILE_UPSTREAM_INVALID')
      }
      completed = { bytes, disposition }
    } catch {
      return failure(changed ? 401 : signal.aborted ? 499 : 502,
        changed ? 'RESULT_FILE_ACCOUNT_CHANGED' : signal.aborted ? 'RESULT_FILE_CANCELLED' : 'RESULT_FILE_UNAVAILABLE')
    } finally {
      lifetime.abort()
      await observation
      // Own a returned body immediately: identity checks may fail before a reader starts.
      await Promise.allSettled([...ownedResponses].map(response => response.body?.cancel()))
    }
    // Cleanup is asynchronous too; construct a successful reply only after its final account check.
    try {
      incoming.signal.throwIfAborted(); deadline.throwIfAborted()
      if (changed || expected === null || await options.accountIdOf() !== expected) {
        return failure(401, 'RESULT_FILE_ACCOUNT_CHANGED')
      }
      incoming.signal.throwIfAborted(); deadline.throwIfAborted()
      if (!completed) return failure(502, 'RESULT_FILE_UNAVAILABLE')
      return new Response(completed.bytes.slice(), { headers: { 'content-type': 'application/octet-stream',
        'content-length': String(completed.bytes.length), 'content-disposition': completed.disposition, 'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin', 'referrer-policy': 'no-referrer' } })
    } catch {
      return failure(incoming.signal.aborted || deadline.aborted ? 499 : 502,
        incoming.signal.aborted || deadline.aborted ? 'RESULT_FILE_CANCELLED' : 'RESULT_FILE_UNAVAILABLE')
    }
  } }]
}
