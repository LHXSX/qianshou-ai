/** Same-origin carrier for explicitly enabled, unbilled image research trials. */
export type ImageTrialSize = 'square' | 'landscape' | 'portrait'
/** Fixed image sampling presets; eight steps also describes older stored requests. */
export type ImageTrialSteps = 8 | 12 | 20
/** Read only explicit orientation words, preserving the user's prompt unchanged.
 * @param prompt - The submitted conversation description.
 * @returns One requested orientation, landscape by default, or null for conflicting words.
 */
export function imageTrialSize(prompt: string): ImageTrialSize | null {
  const choices = [['横屏', 'landscape'], ['竖屏', 'portrait'], ['方图', 'square']] as const
  const matched = choices.filter(([word]) => prompt.includes(word))
  return matched.length > 1 ? null : matched[0]?.[1] ?? 'landscape'
}
export interface ImageTrialRequest { id: string; sessionId: string; prompt: string; size: ImageTrialSize; steps?: ImageTrialSteps }
export interface ImageTrialJob extends ImageTrialRequest {
  status: 'running' | 'completed' | 'failed'
  steps: ImageTrialSteps
  width: number
  height: number
  billing: 'research-no-charge'
  /** Host-recorded acceptance time and last observable media stage; legacy receipts omit it. */
  timing?: { submittedAt: string; phase: 'queued' | 'checking' | 'generating' | 'receiving' }
  errorCode?: string
  result?: { bytes: number; sha256: string }
}
export interface ImageTrialTransport {
  enabled(signal?: AbortSignal): Promise<boolean>
  /** Read advertised presets only; absence preserves compatibility with older local Hosts. */
  supportedSteps?(signal: AbortSignal): Promise<readonly ImageTrialSteps[]>
  start(request: ImageTrialRequest, signal: AbortSignal): Promise<ImageTrialJob>
  read(request: ImageTrialRequest, signal: AbortSignal): Promise<ImageTrialJob>
  image(job: ImageTrialJob, signal: AbortSignal): Promise<Blob>
}
type ReadFailure = 'network' | 'content-type' | 'json' | 'http' | 'receipt-shape'
  | 'receipt-id' | 'receipt-session' | 'receipt-input' | 'receipt-profile' | 'receipt-result' | 'receipt-timing'
class ImageTrialResponseError extends Error {
  constructor(readonly diagnostic: ReadFailure) { super('IMAGE_TRIAL_INVALID_RESPONSE') }
}
/** Expose only a bounded diagnostic category, never response content, prompts or credentials.
 * @param failure - Rejected local read.
 * @returns A safe DOM diagnostic for native acceptance and support.
 */
export function imageTrialReadFailure(failure: unknown): string {
  if (failure instanceof ImageTrialResponseError) return failure.diagnostic
  if (failure instanceof ImageTrialHostError) return `host-${failure.status}`
  return 'unknown'
}
/** Structured failures returned by the authenticated local Host. */
export class ImageTrialHostError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
  /** True only for documented submit failures raised before a job is accepted. */
  get rejectedBeforeAcceptance(): boolean {
    const statuses: Record<string, number> = {
      IMAGE_TRIAL_BUSY: 409, IMAGE_TRIAL_CREDENTIAL_UNAVAILABLE: 503,
      IMAGE_TRIAL_DISABLED: 503, IMAGE_TRIAL_CLOSED: 503, IMAGE_TRIAL_STORE_FULL: 503,
      IMAGE_TRIAL_SESSION_UNAVAILABLE: 403, IMAGE_TRIAL_INVALID: 400,
      IMAGE_TRIAL_SPEC_UNAVAILABLE: 400,
      IMAGE_TRIAL_REQUEST_TOO_LARGE: 413, IMAGE_TRIAL_JSON_REQUIRED: 415,
    }
    return statuses[this.code] === this.status
  }
}
const dimensions = { square: [1024, 1024], landscape: [2048, 1152], portrait: [1152, 2048] } as const
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u

/** Validate a Host receipt against the exact submitted Session and request.
 * @param value - Untrusted response JSON.
 * @param expected - Captured request identity and image settings.
 * @returns The checked receipt.
 */
export function imageTrialJob(value: unknown, expected: ImageTrialRequest): ImageTrialJob {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ImageTrialResponseError('receipt-shape')
  const row = value as ImageTrialJob
  const raw = value as { billing?: unknown; result?: unknown; timing?: unknown }
  if (!uuid.test(row.id) || row.id !== expected.id) throw new ImageTrialResponseError('receipt-id')
  if (row.sessionId !== expected.sessionId) throw new ImageTrialResponseError('receipt-session')
  if (row.prompt !== expected.prompt || row.size !== expected.size) throw new ImageTrialResponseError('receipt-input')
  if (row.steps !== (expected.steps ?? 8) || raw.billing !== 'research-no-charge'
    || row.width !== dimensions[expected.size][0] || row.height !== dimensions[expected.size][1]
  ) throw new ImageTrialResponseError('receipt-profile')
  if (!['running', 'completed', 'failed'].includes(row.status)
    || (row.errorCode !== undefined && (typeof row.errorCode !== 'string' || row.errorCode.length > 128))) {
    throw new ImageTrialResponseError('receipt-shape')
  }
  if (row.status === 'completed') {
    if (raw.result === null || typeof raw.result !== 'object' || Array.isArray(raw.result)) throw new ImageTrialResponseError('receipt-result')
    const result = raw.result as { bytes?: unknown; sha256?: unknown }
    if (typeof result.bytes !== 'number' || !Number.isSafeInteger(result.bytes)
      || result.bytes < 1 || result.bytes > 16 * 1024 * 1024
      || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(result.sha256)) throw new ImageTrialResponseError('receipt-result')
  }
  if (row.timing !== undefined) {
    const timing = row.timing
    if (raw.timing === null || typeof raw.timing !== 'object' || Array.isArray(raw.timing)
      || typeof timing.submittedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(timing.submittedAt)
      || !Number.isFinite(Date.parse(timing.submittedAt))
      || !['queued', 'checking', 'generating', 'receiving'].includes(timing.phase)) throw new ImageTrialResponseError('receipt-timing')
  }
  return row
}

/** Bind research operations to the authenticated local Host, keeping credentials out of the renderer.
 * @param baseUri - The local document base URI.
 * @param fetcher - The renderer's existing same-origin fetch carrier.
 * @returns Explicit start, read-only reconciliation and bounded status methods.
 */
export function createImageTrialTransport(baseUri: string,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)): ImageTrialTransport {
  const route = (path: string, value?: Pick<ImageTrialRequest, 'id' | 'sessionId'>): URL => {
    const url = new URL(`/api/qianshou/compute/image-trial/${path}`, baseUri)
    if (value !== undefined) { url.searchParams.set('id', value.id); url.searchParams.set('sessionId', value.sessionId) }
    return url
  }
  const request = async (url: URL, signal: AbortSignal, body?: ImageTrialRequest): Promise<unknown> => {
    const response = await fetcher(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', signal, headers: { accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      .catch(() => { throw new ImageTrialResponseError('network') })
    if (response.redirected || !response.headers.get('content-type')?.startsWith('application/json')) {
      throw new ImageTrialResponseError('content-type')
    }
    const text = await response.text()
    if (text.length > 32 * 1024) throw new ImageTrialResponseError('json')
    let value: unknown
    try { value = JSON.parse(text) as unknown } catch { throw new ImageTrialResponseError('json') }
    if (!response.ok) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const error = (value as { error?: unknown }).error
        if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
          const code = (error as { code?: unknown }).code
          if (typeof code === 'string' && /^IMAGE_TRIAL_[A-Z_]{1,80}$/u.test(code)) {
            throw new ImageTrialHostError(code, response.status)
          }
        }
      }
      throw new ImageTrialResponseError('http')
    }
    return value
  }
  return {
    async supportedSteps(signal) {
      const value = await request(route('status'), signal)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
      const row = value as Record<string, unknown>
      if (row.enabled !== true || row.billing !== 'research-no-charge' || row.steps !== 8) return []
      if (row.supportedSteps === undefined) return [8]
      const steps = row.supportedSteps
      if (Array.isArray(steps) && steps.length === 1 && steps[0] === 8) return [8]
      return Array.isArray(steps) && steps.length === 3 && steps.every((step, index) => step === [8, 12, 20][index])
        ? [8, 12, 20] : []
    },
    async enabled(signal) {
      try {
        const timeout = AbortSignal.timeout(3000)
        const value = await request(route('status'), signal === undefined ? timeout : AbortSignal.any([signal, timeout]))
        if (value === null || typeof value !== 'object') return false
        const row = value as Record<string, unknown>
        return row.enabled === true && row.billing === 'research-no-charge' && row.steps === 8
          && Array.isArray(row.sizes) && row.sizes.length >= 1 && row.sizes.length <= 3
          && new Set(row.sizes).size === row.sizes.length
          && row.sizes.every(size => ['square', 'landscape', 'portrait'].includes(String(size)))
      } catch { return false }
    },
    async start(value, signal) { return imageTrialJob(await request(route('jobs'), signal, value), value) },
    async read(value, signal) { return imageTrialJob(await request(route('job', value), signal), value) },
    async image(value, signal) {
      const expected = value.result
      if (value.status !== 'completed' || expected === undefined) throw new Error('IMAGE_TRIAL_INVALID_RESPONSE')
      const response = await fetcher(route('image', value), { method: 'GET', credentials: 'same-origin',
        cache: 'no-store', redirect: 'error', signal })
      if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('image/png')
        || !response.body || Number(response.headers.get('content-length')) > expected.bytes) {
        throw new Error('IMAGE_TRIAL_IMAGE_UNAVAILABLE')
      }
      const reader = response.body.getReader()
      const bytes = new Uint8Array(expected.bytes)
      let length = 0
      try {
        for (;;) {
          signal.throwIfAborted()
          const part = await reader.read()
          if (part.done) break
          if (length + part.value.byteLength > bytes.length) {
            await reader.cancel(); throw new Error('IMAGE_TRIAL_IMAGE_INVALID')
          }
          bytes.set(part.value, length); length += part.value.byteLength
        }
      } finally { reader.releaseLock() }
      if (length !== bytes.length || bytes.length < 24
        || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
        || new DataView(bytes.buffer).getUint32(16) !== value.width
        || new DataView(bytes.buffer).getUint32(20) !== value.height) throw new Error('IMAGE_TRIAL_IMAGE_INVALID')
      const digest = await crypto.subtle.digest('SHA-256', bytes.buffer)
      const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      if (sha256 !== expected.sha256) throw new Error('IMAGE_TRIAL_IMAGE_INVALID')
      return new Blob([bytes], { type: 'image/png' })
    },
  }
}
