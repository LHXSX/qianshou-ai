/** Bounded JSON transport to the Shanghai core; every failure is a named outcome, never an empty body. */
import type { CapabilityFailureCode } from './types.ts'

/** Deployment-selected origin, deadline, retry policy and response bound. */
export interface CapabilityProtocolConfig {
  /** HTTPS origin of the Shanghai core (`/api/v8/...`); loopback HTTP only for owned test servers. */
  coreOrigin: string
  /** Deadline for one HTTP attempt in milliseconds. */
  timeoutMs: number
  /** Additional GET attempts after a `timeout`, `network` or `server-error` outcome; POST never retries. */
  maxRetries: number
  /** Pause between attempts in milliseconds. */
  retryDelayMs: number
  /** Largest accepted response body in bytes. */
  maxResponseBytes: number
}

/** A completed HTTP exchange; `payload` is undefined when the body is not JSON. */
export interface HttpAnswer {
  kind: 'answer'
  status: number
  payload: unknown
}

/** A transport-level failure; the request produced no usable HTTP answer. */
export interface TransportFailure {
  kind: 'failed'
  failure: Extract<CapabilityFailureCode, 'timeout' | 'network' | 'closed'>
}

/** Result of one request including retries. */
export type Outcome = HttpAnswer | TransportFailure

/**
 * Validate the configured origin without admitting credentials, paths, queries or fragments.
 * @param value - Configured `coreOrigin`.
 * @returns The origin (`scheme://host[:port]`).
 */
export function coreOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('qianshou-capability: coreOrigin must be an absolute URL') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('qianshou-capability: coreOrigin must be an HTTPS origin without path, credentials, query or fragment')
  }
  return url.origin
}

/**
 * Map an HTTP status that is not 2xx to the shared failure vocabulary.
 * @param status - HTTP status code.
 * @returns The failure code; 404 stays `not-in-catalog` because the capability routes use it for a missing name.
 */
export function failureForStatus(status: number): CapabilityFailureCode {
  if (status === 401 || status === 403) return 'auth-required'
  if (status === 404) return 'not-in-catalog'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'server-error'
  return 'invalid-response'
}

async function readBounded(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) return undefined
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maxBytes) return undefined
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { return undefined }
}

/** One request runner bound to a validated origin and a fetch implementation. */
export class CapabilityProtocol {
  /** The validated `scheme://host[:port]` every request is sent to; callers cite it as the source of a view. */
  readonly origin: string
  constructor(readonly config: CapabilityProtocolConfig, private readonly fetcher: typeof fetch = fetch) {
    this.origin = coreOrigin(config.coreOrigin)
  }

  /**
   * Send one authenticated JSON request; GET retries per config, POST runs exactly once.
   * @param path - Fixed `/api/v8/...` path; caller encodes any dynamic segment.
   * @param method - HTTP verb.
   * @param bearer - Host-only access token; never logged or returned.
   * @param body - Optional JSON body for POST.
   * @param signal - Plugin lifetime cancellation.
   * @returns The HTTP answer or a named transport failure.
   */
  async request(path: string, method: 'GET' | 'POST', bearer: string, body: unknown, signal: AbortSignal): Promise<Outcome> {
    const attempts = method === 'GET' ? 1 + this.config.maxRetries : 1
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) return { kind: 'failed', failure: 'closed' }
      const outcome = await this.once(path, method, bearer, body, signal)
      const retryable = outcome.kind === 'failed'
        ? outcome.failure === 'timeout' || outcome.failure === 'network'
        : outcome.status >= 500
      if (!retryable || attempt + 1 >= attempts) return outcome
      await new Promise<void>((resolve) => { setTimeout(resolve, this.config.retryDelayMs).unref() })
    }
  }

  private async once(path: string, method: 'GET' | 'POST', bearer: string, body: unknown, signal: AbortSignal): Promise<Outcome> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    let response: Response
    try {
      response = await this.fetcher(`${this.origin}${path}`, {
        method, redirect: 'error', credentials: 'omit',
        headers: { accept: 'application/json', authorization: `Bearer ${bearer}`,
          ...body === undefined ? {} : { 'content-type': 'application/json' } },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: AbortSignal.any([signal, timeout]),
      })
    } catch {
      if (signal.aborted) return { kind: 'failed', failure: 'closed' }
      return { kind: 'failed', failure: timeout.aborted ? 'timeout' : 'network' }
    }
    let payload: unknown
    try { payload = await readBounded(response, this.config.maxResponseBytes) } catch {
      if (signal.aborted) return { kind: 'failed', failure: 'closed' }
      return { kind: 'failed', failure: timeout.aborted ? 'timeout' : 'network' }
    }
    return { kind: 'answer', status: response.status, payload }
  }
}
