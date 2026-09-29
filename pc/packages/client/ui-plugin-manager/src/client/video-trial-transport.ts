/** Authenticated same-origin research video carrier. Provider URLs and credentials never enter the renderer. */
export const VIDEO_TRIAL_MAX_BYTES = 16 * 1024 * 1024
export const VIDEO_TRIAL_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
export interface VideoTrialReference {
  id: string
  sessionId: string
  prompt: string
  seconds: 5
  orientation: 'landscape'
  quality: 'fast'
  reuseJobId?: string
}
export interface VideoTrialFrame { mediaType: 'image/png' | 'image/jpeg'; data: string }
export interface VideoTrialRequest extends VideoTrialReference { firstFrame?: VideoTrialFrame }
export type VideoTrialPhase = 'preparing-first-frame' | 'submitting' | 'queued' | 'generating' | 'receiving'
export interface VideoTrialJob extends VideoTrialReference {
  status: 'running' | 'completed' | 'failed'
  steps: 4
  width: 1344
  height: 768
  billing: 'research-no-charge'
  timing: { submittedAt: string; phase: VideoTrialPhase }
  progress?: number
  errorCode?: string
  result?: { bytes: number; sha256: string }
}
export interface VideoTrialTransport {
  enabled(signal?: AbortSignal): Promise<boolean>
  start(request: VideoTrialRequest, signal: AbortSignal): Promise<VideoTrialJob>
  read(request: VideoTrialReference, signal: AbortSignal, retryDelivery?: boolean): Promise<VideoTrialJob>
  video(job: VideoTrialJob, signal: AbortSignal): Promise<Blob>
}
/** Only exact local pre-acceptance failures permit a new user submission. */
export class VideoTrialHostError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
  get rejectedBeforeAcceptance(): boolean {
    const statuses: Record<string, number> = { VIDEO_TRIAL_INVALID: 400, VIDEO_TRIAL_UNSUPPORTED: 400,
      VIDEO_TRIAL_INPUT_INVALID: 400, VIDEO_TRIAL_REUSE_INVALID: 409, VIDEO_TRIAL_SESSION_UNAVAILABLE: 403,
      VIDEO_TRIAL_BUSY: 409, VIDEO_TRIAL_IMAGE_UNAVAILABLE: 503, VIDEO_TRIAL_DISABLED: 503,
      VIDEO_TRIAL_CLOSED: 503, VIDEO_TRIAL_STORE_FULL: 503, VIDEO_TRIAL_JSON_REQUIRED: 415,
      VIDEO_TRIAL_REQUEST_TOO_LARGE: 413, VIDEO_TRIAL_GATEWAY_UNAVAILABLE: 503,
      VIDEO_TRIAL_PROFILE_UNAVAILABLE: 503, VIDEO_TRIAL_INPUT_UNAVAILABLE: 409 }
    return statuses[this.code] === this.status
  }
}
const invalid = (): Error => new Error('VIDEO_TRIAL_INVALID_RESPONSE')
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
/** Verify immutable identity, profile and result before displaying an owner receipt. */
export function videoTrialJob(value: unknown, expected: VideoTrialReference): VideoTrialJob {
  if (!object(value) || value.id !== expected.id || !VIDEO_TRIAL_UUID.test(value.id)
    || value.sessionId !== expected.sessionId || value.prompt !== expected.prompt
    || value.seconds !== 5 || value.orientation !== 'landscape' || value.quality !== 'fast'
    || value.steps !== 4 || value.width !== 1344 || value.height !== 768 || value.billing !== 'research-no-charge'
    || !['running', 'completed', 'failed'].includes(String(value.status))) throw invalid()
  if (!object(value.timing) || typeof value.timing.submittedAt !== 'string'
    || !Number.isFinite(Date.parse(value.timing.submittedAt))
    || new Date(value.timing.submittedAt).toISOString() !== value.timing.submittedAt
    || !['preparing-first-frame', 'submitting', 'queued', 'generating', 'receiving'].includes(String(value.timing.phase))) throw invalid()
  if (value.progress !== undefined && (typeof value.progress !== 'number' || !Number.isFinite(value.progress)
    || value.progress < 0 || value.progress > 100)) throw invalid()
  if (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || !/^VIDEO_TRIAL_[A-Z_]{1,80}$/u.test(value.errorCode))) throw invalid()
  if (value.status === 'failed' && value.errorCode === undefined) throw invalid()
  if (value.status === 'completed' && (!object(value.result) || !Number.isSafeInteger(value.result.bytes)
    || Number(value.result.bytes) < 12 || Number(value.result.bytes) > VIDEO_TRIAL_MAX_BYTES
    || typeof value.result.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.result.sha256))) throw invalid()
  return value as unknown as VideoTrialJob
}
/** Read the bounded payload, without trusting Content-Length as a byte limit. */
async function readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (response.body === null) throw invalid()
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) { await reader.cancel(); throw invalid() }
      parts.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
  return bytes
}
/** Bind starts and read-only restoration to the existing authenticated document origin. */
export function createVideoTrialTransport(baseUri: string,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)): VideoTrialTransport {
  const route = (name: string, ref?: VideoTrialReference): URL => {
    const url = new URL(`/api/qianshou/compute/video-trial/${name}`, baseUri)
    if (ref !== undefined) { url.searchParams.set('id', ref.id); url.searchParams.set('sessionId', ref.sessionId) }
    return url
  }
  const request = async (url: URL, signal: AbortSignal, body?: VideoTrialRequest): Promise<unknown> => {
    const response = await fetcher(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', signal, headers: { accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw invalid()
    const value: unknown = JSON.parse(new TextDecoder().decode(await readBytes(response, 32 * 1024, signal)))
    if (!response.ok) {
      if (object(value) && object(value.error) && typeof value.error.code === 'string'
        && /^VIDEO_TRIAL_[A-Z_]{1,80}$/u.test(value.error.code)) throw new VideoTrialHostError(value.error.code, response.status)
      throw invalid()
    }
    return value
  }
  return {
    async enabled(signal) {
      try {
        const timeout = AbortSignal.timeout(3000)
        const value = await request(route('status'), signal === undefined ? timeout : AbortSignal.any([signal, timeout]))
        return object(value) && value.enabled === true && value.billing === 'research-no-charge'
          && value.quality === 'fast' && value.steps === 4 && value.width === 1344 && value.height === 768
          && value.firstFrame === 'attachment-or-generated'
          && Array.isArray(value.seconds) && value.seconds.length === 1 && value.seconds[0] === 5
          && Array.isArray(value.orientations) && value.orientations.length === 1 && value.orientations[0] === 'landscape'
      } catch { return false }
    },
    async start(value, signal) { return videoTrialJob(await request(route('jobs'), signal, value), value) },
    async read(value, signal, retryDelivery = false) {
      const url = route('job', value)
      if (retryDelivery) url.searchParams.set('retryDelivery', '1')
      return videoTrialJob(await request(url, signal), value)
    },
    async video(value, signal) {
      const expected = value.result
      if (value.status !== 'completed' || expected === undefined || expected.bytes > VIDEO_TRIAL_MAX_BYTES) throw invalid()
      const response = await fetcher(route('video', value), { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal })
      if (response.status !== 200 || response.redirected
        || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'video/mp4') throw invalid()
      const bytes = await readBytes(response, expected.bytes, signal)
      if (bytes.length !== expected.bytes || bytes.length < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') throw invalid()
      const digest = await crypto.subtle.digest('SHA-256', bytes.buffer)
      const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      if (sha256 !== expected.sha256) throw invalid()
      return new Blob([bytes], { type: 'video/mp4' })
    },
  }
}
