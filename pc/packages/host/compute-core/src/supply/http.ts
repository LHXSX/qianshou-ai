/** Bounded JSON transport shared by local service discovery and authenticated platform reads. */
import { SupplyError } from './policy.ts'

/**
 * Machine-readable class of one **failed** HTTP answer.
 *
 * Why this exists as a type rather than as one folded code (工单 6): a `404` means "this
 * workload does not exist" — a terminal fact that no amount of retrying changes — while a
 * `5xx` means "the platform is broken right now", which is retryable. Folding both into
 * `SUPPLY_HTTP_FAILED` made a permanent absence indistinguishable from a transient fault,
 * so every downstream conclusion collapsed into the same "unknown".
 */
export type SupplyHttpFailureClass =
  /** The platform rejected this caller (401/403); a refreshed credential could still read it. */
  | 'auth-required'
  /** 404/410: the addressed resource does not exist. Terminal — re-requesting cannot change it. */
  | 'workload-absent'
  /** 429: the platform is asking for a slower rate; retryable. */
  | 'throttled'
  /** 5xx: the platform's own fault; retryable and never evidence about the missing resource. */
  | 'server-fault'
  /** Any other 4xx: this request is malformed, so repeating it verbatim cannot help. */
  | 'client-rejected'

/**
 * Stable public codes, one per failure class. `server-fault` and `client-rejected` keep the
 * long-standing `SUPPLY_HTTP_FAILED` code on purpose: the class is the new discriminator, and
 * rewriting that code would flip diagnostics pinned outside this module.
 */
const HTTP_FAILURE_CODES: Readonly<Record<SupplyHttpFailureClass, string>> = {
  'auth-required': 'SUPPLY_AUTH_REQUIRED',
  'workload-absent': 'SUPPLY_HTTP_NOT_FOUND',
  throttled: 'SUPPLY_HTTP_THROTTLED',
  'server-fault': 'SUPPLY_HTTP_FAILED',
  'client-rejected': 'SUPPLY_HTTP_FAILED',
}

/** Classify one non-2xx status. Total over failures: every failing status gets exactly one class.
 * @param status - HTTP status of a response that is already known not to be `ok`.
 * @returns The single machine-readable failure class of that status.
 */
function failureClassOf(status: number): SupplyHttpFailureClass {
  if (status === 401 || status === 403) return 'auth-required'
  if (status === 404 || status === 410) return 'workload-absent'
  if (status === 429) return 'throttled'
  if (status >= 500) return 'server-fault'
  return 'client-rejected'
}

/** Classify any HTTP status, so callers can ask the question without throwing.
 * @param status - Any HTTP status code.
 * @returns `null` for a 2xx answer, else the {@link SupplyHttpFailureClass} of that status.
 */
export function classifyHttpStatus(status: number): SupplyHttpFailureClass | null {
  return status >= 200 && status < 300 ? null : failureClassOf(status)
}

/** One non-2xx answer from a read side: the status and its class always travel together.
 *
 * Still a `SupplyError` (so existing `instanceof` handling and the stable `code` contract are
 * unchanged), but it can no longer be mistaken for a transport-level failure: the `status` and
 * `failureClass` are part of the error itself, and the upstream body is still never exposed.
 */
export class SupplyHttpError extends SupplyError {
  /** The class of {@link status}; `workload-absent` is the terminal "does not exist" answer. */
  readonly failureClass: SupplyHttpFailureClass
  /** Raw HTTP status, kept as evidence next to the class. */
  constructor(readonly status: number) {
    const failureClass = failureClassOf(status)
    super(HTTP_FAILURE_CODES[failureClass])
    this.failureClass = failureClass
    this.name = 'SupplyHttpError'
  }
}

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
      // The status decides the class here; a 404 stays a terminal absence and a 5xx a retryable
      // platform fault, instead of both collapsing into one "the read failed" code.
      throw new SupplyHttpError(response.status)
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
