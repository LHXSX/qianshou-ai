/** Read-only HTTP adapter for the documented edge-compute control-plane API. */

/** JSON object returned by the API; endpoint-specific fields remain owned by the platform. */
export type ComputeApiRecord = Readonly<Record<string, unknown>>

/** Safe adapter failures; upstream response bodies are never included. */
export class ComputeApiError extends Error {
  /** Construct an error with a stable code and optional HTTP status. */
  constructor(readonly code: string, readonly status?: number) { super(code) }
}

/** Fetch implementation supplied by the deployment or a test. */
export type ComputeApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Options for endpoint, authentication and response bounds. */
export interface ComputeApiClientOptions {
  /** API origin, such as `https://compute.example`; path must not contain `/api/v8`. */
  baseUrl: string
  /** Short-lived access credential resolved by the host credential provider. */
  accessToken: string
  /** Maximum response bytes retained by a control-plane query. */
  maxResponseBytes: number
  /** Optional fetch implementation; global fetch is used by default. */
  fetch?: ComputeApiFetch
}

/** Read-only methods proven by the current platform_v8 source inventory. */
export interface ComputeApiClient {
  me(signal?: AbortSignal): Promise<ComputeApiRecord>
  taskTypes(signal?: AbortSignal): Promise<ComputeApiRecord>
  /**
   * Read the platform's unwrapped workload list; reject non-object entries.
   * @param signal Optional request cancellation signal.
   * @returns A frozen array of shallow-frozen platform records.
   */
  workloads(signal?: AbortSignal): Promise<readonly ComputeApiRecord[]>
  workload(workloadId: string, signal?: AbortSignal): Promise<ComputeApiRecord>
  shards(workloadId: string, signal?: AbortSignal): Promise<ComputeApiRecord>
  result(workloadId: string, signal?: AbortSignal): Promise<ComputeApiRecord>
}

const API_PREFIX = '/api/v8'

/** Create a client that only calls documented control-plane GET routes. */
export function createComputeApiClient(options: ComputeApiClientOptions): ComputeApiClient {
  validateOptions(options)
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const base = new URL(options.baseUrl)
  return {
    me: async signal => get('/auth/me', 'record', signal),
    taskTypes: async signal => get('/developer/task-types', 'record', signal),
    workloads: async signal => get('/workloads', 'records', signal),
    workload: async (id, signal) => get(`/workloads/${encodeId(id)}`, 'record', signal),
    shards: async (id, signal) => get(`/workloads/${encodeId(id)}/shards`, 'record', signal),
    result: async (id, signal) => get(`/workloads/${encodeId(id)}/result`, 'record', signal),
  }

  async function get(path: string, kind: 'record', signal?: AbortSignal): Promise<ComputeApiRecord>
  async function get(path: string, kind: 'records', signal?: AbortSignal): Promise<readonly ComputeApiRecord[]>
  async function get(path: string, kind: 'record' | 'records', signal?: AbortSignal): Promise<ComputeApiRecord | readonly ComputeApiRecord[]> {
    const url = new URL(`${API_PREFIX}${path}`, base)
    let response: Response
    try {
      const init: RequestInit = {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${options.accessToken}` },
      }
      if (signal !== undefined) init.signal = signal
      response = await fetcher(url, init)
    } catch {
      throw new ComputeApiError('COMPUTE_API_NETWORK_FAILED')
    }
    let body: string
    try { body = await readBounded(response, options.maxResponseBytes) }
    catch (error) {
      if (error instanceof ComputeApiError) throw error
      throw new ComputeApiError('COMPUTE_API_RESPONSE_READ_FAILED', response.status)
    }
    if (!response.ok) throw new ComputeApiError(`COMPUTE_API_HTTP_${response.status}`, response.status)
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { throw new ComputeApiError('COMPUTE_API_JSON_INVALID', response.status) }
    if (kind === 'records') {
      if (!Array.isArray(parsed) || !parsed.every(isRecord)) throw new ComputeApiError('COMPUTE_API_RESPONSE_INVALID', response.status)
      return Object.freeze(parsed.map(record => Object.freeze(record)))
    }
    if (!isRecord(parsed)) throw new ComputeApiError('COMPUTE_API_RESPONSE_INVALID', response.status)
    return Object.freeze(parsed)
  }
}

function isRecord(value: unknown): value is ComputeApiRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateOptions(options: ComputeApiClientOptions): void {
  const value: unknown = options
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeApiError('COMPUTE_API_OPTIONS_INVALID')
  if (typeof options.baseUrl !== 'string' || options.baseUrl.length === 0 || options.baseUrl.length > 2048) throw new ComputeApiError('COMPUTE_API_OPTIONS_INVALID')
  let base: URL
  try { base = new URL(options.baseUrl) } catch { throw new ComputeApiError('COMPUTE_API_OPTIONS_INVALID') }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new ComputeApiError('COMPUTE_API_OPTIONS_INVALID')
  if (base.pathname.endsWith('/api/v8') || base.pathname.includes('/api/v8/')) throw new ComputeApiError('COMPUTE_API_OPTIONS_INVALID')
  if (typeof options.accessToken !== 'string' || options.accessToken.length < 1 || options.accessToken.length > 8192
    || !Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1 || options.maxResponseBytes > 16 * 1024 * 1024) throw new ComputeApiError('COMPUTE_API_OPTIONS_INVALID')
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new ComputeApiError('COMPUTE_API_OPTIONS_INVALID')
}

function encodeId(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || value.includes('/')) throw new ComputeApiError('COMPUTE_API_ID_INVALID')
  return encodeURIComponent(value)
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBytes)) throw new ComputeApiError('COMPUTE_API_RESPONSE_TOO_LARGE', response.status)
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ComputeApiError('COMPUTE_API_RESPONSE_TOO_LARGE', response.status)
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) throw new ComputeApiError('COMPUTE_API_RESPONSE_TOO_LARGE', response.status)
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}
