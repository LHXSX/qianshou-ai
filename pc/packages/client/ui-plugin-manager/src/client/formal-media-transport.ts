/** Same-origin formal media controls; the renderer receives no Shanghai or Guangzhou credentials. */
export interface FormalMediaProfile {
  profile_id: string
  profile_version: number
  capability: 'image' | 'video'
  mode: 'text_to_image' | 'image_to_image' | 'image_edit' | 'text_to_video' | 'image_to_video' | 'first_last_frame'
  quality: 'fast' | 'standard' | 'clear' | 'hd'
  orientation: 'square' | 'landscape' | 'portrait'
  width: number
  height: number
  steps: number
  fps: number | null
  allowed_seconds: number[]
  input_roles: Array<'reference' | 'first_frame' | 'last_frame'>
  max_assets: number
  enabled: boolean
}
export interface FormalMediaInput {
  capability: FormalMediaProfile['capability']
  mode: FormalMediaProfile['mode']
  prompt: string
  negative_prompt: string
  quality: FormalMediaProfile['quality']
  orientation: FormalMediaProfile['orientation']
  seconds: number | null
  assets: Array<{ asset_id: string
    sha256: string
    role: FormalMediaProfile['input_roles'][number] }>
  profile_id: string
  profile_version: number
}
export interface FormalMediaReference { requestId: string
  sessionId: string }
export interface FormalMediaAssetIntent {
  assetId: string
  sessionId: string
  sha256: string
  role: FormalMediaProfile['input_roles'][number]
  mediaType: 'image/png' | 'image/jpeg'
}
export interface FormalMediaAssetStatus {
  assetId: string
  status: 'registered' | 'uncertain'
  asset: FormalMediaInput['assets'][number] | null
}
export interface FormalMediaQuote extends FormalMediaReference {
  quoteId: string
  amountYuan: string
  currency: 'CNY'
  balanceEnough: boolean
  expiresAt: string
  input: FormalMediaInput
}
export interface FormalMediaState extends FormalMediaReference {
  taskId: string
  attemptId: string | null
  leaseEpoch: number | null
  status: string
  phase: string
  progress: number | null
  elapsedSeconds: number
  pollIntervalMs: number
  deliveryAvailable: boolean
  resultMetadata: null | { assetId: string
    sha256: string
    capability: 'image' | 'video'
    sizeBytes: number
    contentType: 'image/png' | 'image/jpeg' | 'video/mp4'
    width: number
    height: number
    resultRevision: string
    fpsNum: number | null
    fpsDen: number | null
    secondsMs: number | null }
  settlement: null | { settled: true
    billableResultRevision: string
    ledgerReceiptId: string }
}
export interface FormalMediaTransport {
  directory(signal: AbortSignal): Promise<{ billing_status: 'ready' | 'unavailable'
    profiles: FormalMediaProfile[] }>
  quote(reference: FormalMediaReference, input: FormalMediaInput, signal: AbortSignal): Promise<FormalMediaQuote>
  confirm(quote: FormalMediaQuote, signal: AbortSignal): Promise<{ taskId: string
    requestId: string }>
  state(reference: FormalMediaReference, signal: AbortSignal): Promise<FormalMediaState>
  media(state: FormalMediaState, signal: AbortSignal): Promise<Blob>
  uploadAsset(intent: FormalMediaAssetIntent, data: string, signal: AbortSignal): Promise<FormalMediaAssetStatus>
  assetStatus(intent: FormalMediaAssetIntent, signal: AbortSignal): Promise<FormalMediaAssetStatus>
}
export const FORMAL_MEDIA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const sha = /^[a-f0-9]{64}$/u
/** A Host-confirmed pre-submission refusal can receive a fresh quote; unknown submissions cannot. */
export class FormalMediaHostError extends Error {
  readonly rejectedBeforeSubmission: boolean
  constructor(code: string, confirming: boolean) {
    super(code)
    this.rejectedBeforeSubmission = confirming && ['COMPUTE_QUOTE_CONFIRMATION_INVALID', 'COMPUTE_QUOTE_EXPIRED',
      'COMPUTE_QUOTE_BALANCE_INSUFFICIENT', 'COMPUTE_MEDIA_CONFIRM_NOT_STARTED'].includes(code)
  }
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('FORMAL_MEDIA_INVALID_RESPONSE')
  return value as Record<string, unknown>
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
/** Validate saved or wire media intent before it is used to display or request a quote. */
export function isFormalMediaInput(value: unknown): value is FormalMediaInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const valid = Object.keys(v).sort().join(',') === 'assets,capability,mode,negative_prompt,orientation,profile_id,profile_version,prompt,quality,seconds'
    && ['image', 'video'].includes(String(v.capability))
    && ['text_to_image', 'image_to_image', 'image_edit', 'text_to_video', 'image_to_video', 'first_last_frame'].includes(String(v.mode))
    && ['fast', 'standard', 'clear', 'hd'].includes(String(v.quality)) && ['square', 'landscape', 'portrait'].includes(String(v.orientation))
    && typeof v.prompt === 'string' && v.prompt.trim().length > 0 && new TextEncoder().encode(v.prompt).byteLength <= 8192
    && typeof v.negative_prompt === 'string' && new TextEncoder().encode(v.negative_prompt).byteLength <= 8192
    && typeof v.profile_id === 'string' && /^[a-z][a-z0-9_.-]{2,99}$/u.test(v.profile_id) && integer(v.profile_version, 1, Number.MAX_SAFE_INTEGER)
    && (v.capability === 'video' ? integer(v.seconds, 1, 120) : v.seconds === null)
    && Array.isArray(v.assets) && v.assets.length <= 8 && v.assets.every((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const a = value as Record<string, unknown>
    return Object.keys(a).sort().join(',') === 'asset_id,role,sha256' && typeof a.asset_id === 'string' && id.test(a.asset_id)
        && typeof a.sha256 === 'string' && sha.test(a.sha256) && ['reference', 'first_frame', 'last_frame'].includes(String(a.role))
  })
  if (!valid || !Array.isArray(v.assets)) return false
  const assets = v.assets as FormalMediaInput['assets']
  if ((v.capability === 'video') !== (String(v.mode).includes('video') || v.mode === 'first_last_frame')
    || new Set(assets.map(a => a.asset_id)).size !== assets.length) return false
  if (v.mode === 'text_to_image' || v.mode === 'text_to_video') return assets.length === 0
  if (v.mode === 'image_to_video') return assets.length === 1 && assets[0]?.role === 'first_frame'
  if (v.mode === 'first_last_frame') return assets.length === 2 && assets[0]?.role === 'first_frame' && assets[1]?.role === 'last_frame'
  return assets.length > 0 && assets.every(a => a.role === 'reference')
}
/** Compare the ten admitted values independently of JSON object key order.
 * @param a - First validated intent.
 * @param b - Second validated intent.
 * @returns Whether both describe exactly the same frozen input.
 */
export function sameFormalMediaInput(a: FormalMediaInput, b: FormalMediaInput): boolean {
  return a.capability === b.capability && a.mode === b.mode && a.prompt === b.prompt && a.negative_prompt === b.negative_prompt
    && a.quality === b.quality && a.orientation === b.orientation && a.seconds === b.seconds
    && a.profile_id === b.profile_id && a.profile_version === b.profile_version && a.assets.length === b.assets.length
    && a.assets.every((asset, index) => {
      const other = b.assets[index]
      return other !== undefined && asset.asset_id === other.asset_id && asset.sha256 === other.sha256 && asset.role === other.role
    })
}
/** Parse owner-bound, token-free official quote metadata. */
export function formalMediaQuote(value: unknown, reference: FormalMediaReference): FormalMediaQuote {
  const row = object(value)
  if (Object.keys(row).sort().join(',') !== 'amountYuan,balanceEnough,currency,expiresAt,input,quoteId,requestId,sessionId'
    || row.requestId !== reference.requestId || row.sessionId !== reference.sessionId
    || typeof row.quoteId !== 'string' || !FORMAL_MEDIA_UUID.test(row.quoteId)
    || typeof row.amountYuan !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/u.test(row.amountYuan)
    || !/[1-9]/u.test(row.amountYuan) || row.currency !== 'CNY' || typeof row.balanceEnough !== 'boolean'
    || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt)) || !isFormalMediaInput(row.input)) {
    throw new Error('FORMAL_MEDIA_INVALID_RESPONSE')
  }
  return { ...reference, quoteId: row.quoteId, amountYuan: row.amountYuan, currency: 'CNY', balanceEnough: row.balanceEnough,
    expiresAt: row.expiresAt, input: row.input }
}
/** Query through the local Host only; a confirmed POST outcome is retained until read-only reconciliation. */
export function createFormalMediaTransport(baseUri = typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI,
  fetchImpl: typeof fetch = fetch): FormalMediaTransport {
  const submissions = new Map<string, Promise<{ taskId: string; requestId: string }>>()
  const assetResult = (value: unknown, intent: FormalMediaAssetIntent): FormalMediaAssetStatus => {
    const row = object(value)
    if (row.assetId !== intent.assetId || !['registered', 'uncertain'].includes(String(row.status))) throw new Error('FORMAL_MEDIA_INVALID_RESPONSE')
    if (row.status === 'uncertain' && row.asset === null) return { assetId: intent.assetId, status: 'uncertain', asset: null }
    const asset = object(row.asset)
    if (asset.asset_id !== intent.assetId || asset.sha256 !== intent.sha256 || asset.role !== intent.role) throw new Error('FORMAL_MEDIA_INVALID_RESPONSE')
    return { assetId: intent.assetId, status: 'registered', asset: { asset_id: intent.assetId, sha256: intent.sha256, role: intent.role } }
  }
  const request = async (path: string, signal: AbortSignal, body?: unknown): Promise<unknown> => {
    const response = await fetchImpl(new URL('/api/qianshou/compute/media/' + path, baseUri), {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const raw = await response.text()
    if (new TextEncoder().encode(raw).byteLength > 1024 * 1024) throw new Error('FORMAL_MEDIA_INVALID_RESPONSE')
    const value: unknown = JSON.parse(raw)
    if (!response.ok) {
      const failure = object(object(value).error).code
      throw new FormalMediaHostError(typeof failure === 'string' && /^[A-Z][A-Z0-9_]{2,100}$/u.test(failure)
        ? failure : 'FORMAL_MEDIA_UNAVAILABLE', path === 'confirm')
    }
    return value
  }
  return {
    async directory(signal) {
      const row = object(await request('profiles', signal))
      if (!['ready', 'unavailable'].includes(String(row.billing_status)) || !Array.isArray(row.profiles) || row.profiles.length > 500) throw new Error('FORMAL_MEDIA_INVALID_RESPONSE')
      const profiles = row.profiles.map((value) => {
        const p = object(value)
        const probe = { capability: p.capability, mode: p.capability === 'video' ? 'text_to_video' : 'text_to_image',
          quality: p.quality, orientation: p.orientation,
          prompt: 'directory', negative_prompt: '', seconds: p.capability === 'video' ? 1 : null, assets: [],
          profile_id: p.profile_id, profile_version: p.profile_version }
        if (!isFormalMediaInput(probe)
          || !['text_to_image', 'image_to_image', 'image_edit', 'text_to_video', 'image_to_video', 'first_last_frame'].includes(String(p.mode))
          || (p.capability === 'video') !== (String(p.mode).includes('video') || p.mode === 'first_last_frame')
          || !integer(p.width, 64, 4096) || !integer(p.height, 64, 4096) || !integer(p.steps, 1, 200)
          || (p.capability === 'video' ? !integer(p.fps, 1, 120) : p.fps !== null)
          || !Array.isArray(p.allowed_seconds) || p.allowed_seconds.length > 120 || p.allowed_seconds.some(s => !integer(s, 1, 120))
          || !Array.isArray(p.input_roles) || p.input_roles.length > 8 || p.input_roles.some(r => !['reference', 'first_frame', 'last_frame'].includes(String(r)))
          || !integer(p.max_assets, 0, 8) || typeof p.enabled !== 'boolean') throw new Error('FORMAL_MEDIA_INVALID_RESPONSE')
        return { profile_id: p.profile_id, profile_version: p.profile_version, capability: p.capability, mode: p.mode,
          quality: p.quality, orientation: p.orientation, width: p.width, height: p.height, steps: p.steps, fps: p.fps,
          allowed_seconds: [...p.allowed_seconds as number[]], input_roles: [...p.input_roles as FormalMediaProfile['input_roles']],
          max_assets: p.max_assets, enabled: p.enabled } as FormalMediaProfile
      })
      return { billing_status: row.billing_status as 'ready' | 'unavailable', profiles }
    },
    async quote(reference, input, signal) {
      const result = formalMediaQuote(await request('quote', signal, { ...reference, input }), reference)
      if (!sameFormalMediaInput(result.input, input)) throw new Error('FORMAL_MEDIA_INVALID_RESPONSE')
      return result
    },
    confirm(quote, signal) {
      const key = `${quote.sessionId}:${quote.requestId}:${quote.quoteId}`
      const prior = submissions.get(key)
      if (prior !== undefined) return prior
      if (Date.parse(quote.expiresAt) <= Date.now()) return Promise.reject(new Error('COMPUTE_QUOTE_EXPIRED'))
      const operation = request('confirm', signal, { requestId: quote.requestId, sessionId: quote.sessionId,
        quoteId: quote.quoteId, amountYuan: quote.amountYuan }).then((value) => {
        const row = object(value)
        if (row.requestId !== quote.requestId || typeof row.taskId !== 'string' || !id.test(row.taskId)) throw new Error('FORMAL_MEDIA_INVALID_RESPONSE')
        return { taskId: row.taskId, requestId: quote.requestId }
      })
      submissions.set(key, operation)
      return operation
    },
    async state(reference, signal) {
      const row = object(await request(`state?requestId=${encodeURIComponent(reference.requestId)}&sessionId=${encodeURIComponent(reference.sessionId)}`, signal))
      if (row.requestId !== reference.requestId || row.sessionId !== reference.sessionId || typeof row.taskId !== 'string' || !id.test(row.taskId)
        || !['CREATED', 'WAITING_FOR_WORKERS', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'].includes(String(row.status))
        || !['waiting', 'running', 'awaiting_settlement', 'settled', 'delivery_pending', 'failed', 'cancelled'].includes(String(row.phase))
        || (row.progress !== null && (typeof row.progress !== 'number' || !Number.isFinite(row.progress) || row.progress < 0 || row.progress > 1))
        || !integer(row.elapsedSeconds, 0, Number.MAX_SAFE_INTEGER) || !integer(row.pollIntervalMs, 500, 60000)
        || (row.attemptId !== null && (typeof row.attemptId !== 'string' || !id.test(row.attemptId)))
        || (row.leaseEpoch !== null && !integer(row.leaseEpoch, 1, Number.MAX_SAFE_INTEGER))
        || typeof row.deliveryAvailable !== 'boolean') throw new Error('FORMAL_MEDIA_INVALID_RESPONSE')
      let resultMetadata: FormalMediaState['resultMetadata'] = null
      if (row.resultMetadata !== null) {
        const r = object(row.resultMetadata)
        if (typeof r.assetId !== 'string' || !id.test(r.assetId) || typeof r.sha256 !== 'string' || !sha.test(r.sha256)
          || !integer(r.sizeBytes, 1, 64 * 1024 * 1024) || !integer(r.width, 1, 4096) || !integer(r.height, 1, 4096)
          || typeof r.resultRevision !== 'string' || !sha.test(r.resultRevision) || !['image', 'video'].includes(String(r.capability))
          || (r.capability === 'image' ? !['image/png', 'image/jpeg'].includes(String(r.contentType))
            || r.fpsNum !== null || r.fpsDen !== null || r.secondsMs !== null
            : r.contentType !== 'video/mp4' || !integer(r.fpsNum, 1, 120000) || !integer(r.fpsDen, 1, 120000)
            || !integer(r.secondsMs, 1, 120000))) throw new Error('FORMAL_MEDIA_INVALID_RESPONSE')
        resultMetadata = { assetId: r.assetId, sha256: r.sha256, sizeBytes: r.sizeBytes, width: r.width, height: r.height,
          contentType: r.contentType as NonNullable<FormalMediaState['resultMetadata']>['contentType'],
          capability: r.capability as 'image' | 'video', resultRevision: r.resultRevision,
          fpsNum: r.fpsNum as number | null, fpsDen: r.fpsDen as number | null, secondsMs: r.secondsMs as number | null }
      }
      let settlement: FormalMediaState['settlement'] = null
      if (row.settlement !== null) {
        const s = object(row.settlement); const r = object(row.resultMetadata)
        if (s.settled !== true || s.billableResultRevision !== r.resultRevision || typeof s.ledgerReceiptId !== 'string' || !id.test(s.ledgerReceiptId)) throw new Error('FORMAL_MEDIA_INVALID_RESPONSE')
        settlement = { settled: true, billableResultRevision: s.billableResultRevision as string, ledgerReceiptId: s.ledgerReceiptId }
      }
      // The Host projects these fields explicitly and strips viewerReceipt before the response.
      return { ...reference, taskId: row.taskId, attemptId: row.attemptId, leaseEpoch: row.leaseEpoch,
        status: row.status as string, phase: row.phase as string, progress: row.progress,
        elapsedSeconds: row.elapsedSeconds, pollIntervalMs: row.pollIntervalMs, deliveryAvailable: row.deliveryAvailable,
        resultMetadata, settlement }
    },
    async media(state, signal) {
      const expected = state.resultMetadata
      if (!state.deliveryAvailable || expected === null || state.settlement?.billableResultRevision !== expected.resultRevision) throw new Error('FORMAL_MEDIA_DELIVERY_UNAVAILABLE')
      const url = new URL('/api/qianshou/compute/media/result', baseUri)
      url.searchParams.set('requestId', state.requestId); url.searchParams.set('sessionId', state.sessionId)
      const response = await fetchImpl(url, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal })
      if (!response.ok || response.headers.get('content-type') !== expected.contentType
        || response.headers.get('x-qianshou-sha256') !== expected.sha256) throw new Error('FORMAL_MEDIA_DELIVERY_INVALID')
      const length = response.headers.get('content-length')
      if (length !== null && Number(length) !== expected.sizeBytes) throw new Error('FORMAL_MEDIA_DELIVERY_INVALID')
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error('FORMAL_MEDIA_DELIVERY_INVALID')
      const bytes = new Uint8Array(expected.sizeBytes); let size = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          if (size + part.value.byteLength > bytes.byteLength) throw new Error('FORMAL_MEDIA_DELIVERY_INVALID')
          bytes.set(part.value, size); size += part.value.byteLength
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      if (size !== expected.sizeBytes) throw new Error('FORMAL_MEDIA_DELIVERY_INVALID')
      const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
      if (actual !== expected.sha256) throw new Error('FORMAL_MEDIA_DELIVERY_INVALID')
      return new Blob([bytes], { type: expected.contentType })
    },
    async uploadAsset(intent, data, signal) {
      return assetResult(await request('asset-upload', signal, { ...intent, data }), intent)
    },
    async assetStatus(intent, signal) {
      return assetResult(await request('asset-status', signal, { assetId: intent.assetId, sessionId: intent.sessionId }), intent)
    },
  }
}
