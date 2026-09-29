/** Bounded JSON transport shared by local service discovery and authenticated platform reads. */
import { SupplyError } from './policy.ts'

/** Explicit deployment limits apply to the entire streamed response. */
export interface JsonTransportOptions {
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly fetch?: typeof fetch
}

/** Validate deployment limits before network use.
 * @param options - Timeout and streamed-response byte limits.
 */
export function validateTransportOptions(options: JsonTransportOptions): void {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2147483647
    || !Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1) throw new SupplyError('SUPPLY_CONFIG_INVALID')
}

/** Read one bounded JSON response, forbidding redirects and suppressing external error text.
 * @param url - Validated endpoint URL.
 * @param init - Request method, headers and optional JSON body.
 * @param options - Trusted transport implementation and resource limits.
 * @param signal - Optional caller cancellation signal.
 * @returns Untrusted decoded JSON for endpoint-specific validation.
 */
export async function requestJson(url: URL, init: RequestInit, options: JsonTransportOptions, signal?: AbortSignal): Promise<unknown> {
  validateTransportOptions(options)
  const deadline = AbortSignal.timeout(options.timeoutMs)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    combined.throwIfAborted()
    const response = await (options.fetch ?? fetch)(url, { ...init, signal: combined, redirect: 'error', credentials: 'omit' })
    if (!response.ok) {
      try { await response.body?.cancel() } catch { /* Do not expose the upstream failure body. */ }
      throw new SupplyError(response.status === 401 || response.status === 403 ? 'SUPPLY_AUTH_REQUIRED' : 'SUPPLY_HTTP_FAILED')
    }
    if (!response.body) throw new SupplyError('SUPPLY_RESPONSE_INVALID')
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      combined.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > options.maxResponseBytes) throw new SupplyError('SUPPLY_RESPONSE_TOO_LARGE')
      chunks.push(next.value)
    }
    combined.throwIfAborted()
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new SupplyError('SUPPLY_RESPONSE_INVALID') }
  } catch (error) {
    if (signal?.aborted) throw new SupplyError('SUPPLY_ABORTED')
    if (deadline.aborted) throw new SupplyError('SUPPLY_TIMEOUT')
    if (error instanceof SupplyError) throw error
    throw new SupplyError('SUPPLY_HTTP_FAILED')
  } finally {
    if (reader) {
      try { await reader.cancel() } catch { /* Fetch may already have cancelled the reader on abort. */ }
      reader.releaseLock()
    }
  }
}

/** Require HTTPS externally and literal loopback HTTP for local test/service endpoints.
 * @param value - Origin supplied by trusted Host configuration.
 * @param loopbackOnly - Whether to require a literal loopback hostname.
 * @returns The validated origin URL.
 */
export function safeOrigin(value: string, loopbackOnly = false): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new SupplyError('SUPPLY_CONFIG_INVALID') }
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || (loopbackOnly && !local)) throw new SupplyError('SUPPLY_CONFIG_INVALID')
  return url
}
