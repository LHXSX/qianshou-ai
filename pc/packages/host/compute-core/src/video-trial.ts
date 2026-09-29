/** Explicit, unbilled H3 trials with durable inputs and one-shot upstream submission. */
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ImageTrialHost } from './image-trial.ts'
import { ComputeError } from './errors.ts'
import { inspectVideoTrialFirstFrame, inspectVideoTrialMp4 } from './video-trial-media.ts'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const SESSION = /^[A-Za-z0-9._:-]{1,128}$/u
const SHA = /^[a-f0-9]{64}$/u
const EXTERNAL_ID = /^[A-Za-z0-9_-]{1,128}$/u
const BYTES = 16 * 1024 * 1024
const BILLING = 'research-no-charge' as const
const PROFILE = { seconds: 5, orientation: 'landscape', quality: 'fast', steps: 4, width: 1344, height: 768 } as const
const PHASES = ['preparing-first-frame', 'submitting', 'queued', 'generating', 'receiving'] as const
type Phase = typeof PHASES[number]
type Mime = 'image/png' | 'image/jpeg'

/** Operator-owned SSH forward; absent configuration disables the trial. */
export interface VideoTrialConfig {
  /** Operator-owned loopback gateway serving the existing H3 research workflow. */
  readonly gatewayOrigin: string
  /** Bounded waiting budget for first-frame preparation and original H3 task polling. */
  readonly timeoutMs?: number
}
/** Checked owner receipt, without gateway addresses, raw media or credentials. */
export interface VideoTrialJob {
  readonly id: string
  readonly sessionId: string
  readonly prompt: string
  readonly seconds: 5
  readonly orientation: 'landscape'
  readonly quality: 'fast'
  readonly steps: 4
  readonly width: 1344
  readonly height: 768
  readonly billing: typeof BILLING
  readonly status: 'running' | 'completed' | 'failed'
  readonly timing: { readonly submittedAt: string; readonly phase: Phase }
  readonly progress?: number
  readonly errorCode?: string
  readonly result?: { readonly bytes: number; readonly sha256: string }
}
interface Frame { mediaType: Mime; bytes: number; sha256: string }
interface Expected { executionRecipeSha256: string; modelSha256: string }
interface Stored {
  job: VideoTrialJob
  fingerprint: string
  seed: number
  source: 'attachment' | 'generated' | 'reuse'
  parentId?: string
  imageJobId?: string
  frame?: Frame
  expected?: Expected
  attempted: boolean
  externalId?: string
}
interface RequestValue {
  id: string
  sessionId: string
  prompt: string
  fingerprint: string
  frame?: { mediaType: Mime; bytes: Buffer }
  reuseJobId?: string
}
type Images = Pick<ImageTrialHost, 'status' | 'submit' | 'job' | 'image'>
function fail(code: string, status = 502): ComputeError { return new ComputeError(`VIDEO_TRIAL_${code}`, status) }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function digest(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }
function frameInfo(bytes: Buffer, mediaType: Mime): Frame { return { mediaType, bytes: bytes.length, sha256: digest(bytes) } }
function validFrame(value: unknown): value is Frame {
  return object(value) && ['image/png', 'image/jpeg'].includes(String(value.mediaType))
    && Number.isSafeInteger(value.bytes) && Number(value.bytes) > 0 && Number(value.bytes) <= BYTES
    && typeof value.sha256 === 'string' && SHA.test(value.sha256)
}
function validExpected(value: unknown): value is Expected {
  return object(value) && Object.keys(value).sort().join(',') === 'executionRecipeSha256,modelSha256'
    && typeof value.executionRecipeSha256 === 'string' && SHA.test(value.executionRecipeSha256)
    && typeof value.modelSha256 === 'string' && SHA.test(value.modelSha256)
}
function parse(value: unknown): RequestValue {
  if (!object(value) || Object.keys(value).some(key => !['id', 'sessionId', 'prompt', 'seconds', 'orientation', 'quality', 'firstFrame', 'reuseJobId'].includes(key))
    || typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.sessionId !== 'string' || !SESSION.test(value.sessionId)
    || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 4000) throw fail('INVALID', 400)
  if (value.seconds !== 5 || value.orientation !== 'landscape' || value.quality !== 'fast') throw fail('UNSUPPORTED', 400)
  if (value.firstFrame !== undefined && value.reuseJobId !== undefined) throw fail('INVALID', 400)
  if (value.reuseJobId !== undefined && (typeof value.reuseJobId !== 'string' || !UUID.test(value.reuseJobId))) throw fail('REUSE_INVALID', 409)
  let frame: RequestValue['frame']
  if (value.firstFrame !== undefined) {
    const supplied = value.firstFrame
    if (!object(supplied) || Object.keys(supplied).sort().join(',') !== 'data,mediaType'
      || (supplied.mediaType !== 'image/png' && supplied.mediaType !== 'image/jpeg')
      || typeof supplied.data !== 'string' || supplied.data.length > Math.ceil(BYTES / 3) * 4) throw fail('INPUT_INVALID', 400)
    const bytes = Buffer.from(supplied.data, 'base64')
    if (!bytes.length || bytes.length > BYTES || bytes.toString('base64') !== supplied.data) throw fail('INPUT_INVALID', 400)
    try { inspectVideoTrialFirstFrame(bytes, supplied.mediaType) } catch { throw fail('INPUT_INVALID', 400) }
    frame = { mediaType: supplied.mediaType, bytes }
  }
  const fingerprint = digest(JSON.stringify({ sessionId: value.sessionId, prompt: value.prompt, ...PROFILE,
    source: frame === undefined ? value.reuseJobId === undefined ? 'generated' : { parent: value.reuseJobId }
      : frameInfo(frame.bytes, frame.mediaType) }))
  return { id: value.id, sessionId: value.sessionId, prompt: value.prompt, fingerprint,
    ...(frame === undefined ? {} : { frame }),
    ...(typeof value.reuseJobId === 'string' ? { reuseJobId: value.reuseJobId } : {}) }
}
function stored(value: unknown): Stored {
  if (!object(value) || !object(value.job)) throw fail('STORE_INVALID', 503)
  const job = value.job
  if (typeof job.id !== 'string' || !UUID.test(job.id) || typeof job.sessionId !== 'string' || !SESSION.test(job.sessionId)
    || typeof job.prompt !== 'string' || !job.prompt.trim() || job.prompt.length > 4000
    || Object.entries(PROFILE).some(([key, expected]) => job[key] !== expected) || job.billing !== BILLING
    || !['running', 'completed', 'failed'].includes(String(job.status)) || !object(job.timing)
    || typeof job.timing.submittedAt !== 'string' || !Number.isFinite(Date.parse(job.timing.submittedAt))
    || new Date(job.timing.submittedAt).toISOString() !== job.timing.submittedAt
    || !PHASES.includes(job.timing.phase as Phase)
    || (job.progress !== undefined && (typeof job.progress !== 'number' || !Number.isFinite(job.progress) || job.progress < 0 || job.progress > 100))
    || (job.errorCode !== undefined && (typeof job.errorCode !== 'string' || !/^VIDEO_TRIAL_[A-Z_]{1,80}$/u.test(job.errorCode)))
    || (job.status === 'completed' && (!object(job.result) || !Number.isSafeInteger(job.result.bytes)
      || Number(job.result.bytes) < 1 || Number(job.result.bytes) > BYTES || typeof job.result.sha256 !== 'string' || !SHA.test(job.result.sha256)))
    || typeof value.fingerprint !== 'string' || !SHA.test(value.fingerprint)
    || !Number.isSafeInteger(value.seed) || Number(value.seed) < 0 || Number(value.seed) > 2147483647
    || !['attachment', 'generated', 'reuse'].includes(String(value.source)) || typeof value.attempted !== 'boolean'
    || (value.parentId !== undefined && (typeof value.parentId !== 'string' || !UUID.test(value.parentId)))
    || (value.imageJobId !== undefined && (typeof value.imageJobId !== 'string' || !UUID.test(value.imageJobId)))
    || (value.frame !== undefined && !validFrame(value.frame))
    || (value.expected !== undefined && !validExpected(value.expected))
    || (value.externalId !== undefined && (typeof value.externalId !== 'string' || !EXTERNAL_ID.test(value.externalId)
      || !value.attempted || !validExpected(value.expected) || !validFrame(value.frame)))
    || (value.source === 'generated' && value.imageJobId === undefined)
    || (value.source === 'reuse' && value.parentId === undefined)) throw fail('STORE_INVALID', 503)
  return value as unknown as Stored
}
async function readPrivate(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const meta = await file.stat()
    if (!meta.isFile() || meta.size > maxBytes) throw fail('STORE_INVALID', 503)
    const bytes = await file.readFile()
    if (bytes.length > maxBytes) throw fail('STORE_INVALID', 503)
    return bytes
  } finally { await file.close() }
}
async function bounded(response: Response, maximum: number): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel(); throw fail('RESPONSE_INVALID')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw fail('RESPONSE_INVALID')
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maximum) throw fail('RESPONSE_INVALID')
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  if (declared !== null && size !== Number(declared)) throw fail('RESPONSE_INVALID')
  return Buffer.concat(chunks, size)
}

/** One owner lifecycle shares the image Host and never replays an uncertain H3 POST. */
export class VideoTrialHost {
  private updateLocked = false
  private readonly config: { gatewayOrigin: string; timeoutMs: number } | undefined
  private readonly jobs = new Map<string, Stored>()
  private readonly lifetime = new AbortController()
  private readonly active = new Map<string, Promise<void>>()
  private loading?: Promise<void>
  private serial: Promise<unknown> = Promise.resolve()
  constructor(config: VideoTrialConfig | undefined, private readonly directory: string,
    private readonly limits: { maxRecords: number; maxStoreBytes: number }, private readonly images: Images,
    private readonly pollMs = 1000) {
    if (!isAbsolute(directory)) throw fail('CONFIG_INVALID', 503)
    if (config !== undefined) {
      if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(config.gatewayOrigin)
        || Number(new URL(config.gatewayOrigin).port) > 65535
        || !Number.isSafeInteger(config.timeoutMs ?? 1800000) || (config.timeoutMs ?? 1800000) < 1000
        || (config.timeoutMs ?? 1800000) > 3600000) throw fail('CONFIG_INVALID', 503)
      this.config = { gatewayOrigin: config.gatewayOrigin, timeoutMs: config.timeoutMs ?? 1800000 }
    }
  }
  /** Close only new trial admission for an update; original job reads stay available. */
  setUpdateLocked(locked: boolean): void { this.updateLocked = locked }
  /** Observe live and durable unresolved trials without issuing a provider request. */
  async updateState(): Promise<'idle' | 'busy' | 'unknown'> {
    await this.initialize()
    if (this.active.size > 0 || [...this.jobs.values()].some(row => row.job.status === 'running')) return 'busy'
    return [...this.jobs.values()].some(row => row.job.errorCode === 'VIDEO_TRIAL_OUTCOME_UNKNOWN') ? 'unknown' : 'idle'
  }

  /** Describe the explicit research configuration, not live availability or official pricing.
   * @returns Supported trial parameters without provider addresses.
   */
  status() {
    return { enabled: this.config !== undefined, billing: BILLING, quality: 'fast' as const, steps: 4 as const,
      seconds: [5], orientations: ['landscape'], width: 1344, height: 768, firstFrame: 'attachment-or-generated' as const }
  }
  private enabled() {
    if (this.config === undefined) throw fail('DISABLED', 503)
    if (this.lifetime.signal.aborted) throw fail('CLOSED', 503)
    return this.config
  }
  private async initialize(): Promise<void> { this.loading ??= this.load(); return this.loading }
  private async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(this.directory)).isDirectory()) throw fail('STORE_INVALID', 503)
    await chmod(this.directory, 0o700)
    let bytes: Buffer
    try { bytes = await readPrivate(join(this.directory, 'jobs.json'), this.limits.maxStoreBytes) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw fail('STORE_INVALID', 503) }
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'))
      if (!object(parsed) || parsed.version !== 1 || !Array.isArray(parsed.jobs) || parsed.jobs.length > this.limits.maxRecords) throw fail('STORE_INVALID', 503)
      let changed = false
      for (const value of parsed.jobs) {
        let row = stored(value)
        if (this.jobs.has(row.job.id)) throw fail('STORE_INVALID', 503)
        if (row.job.status === 'running' && row.externalId === undefined) {
          row = { ...row, job: { ...row.job, status: 'failed', errorCode: 'VIDEO_TRIAL_OUTCOME_UNKNOWN' } }; changed = true
        }
        this.jobs.set(row.job.id, row)
      }
      if (changed) await this.save()
    } catch { throw fail('STORE_INVALID', 503) }
  }
  private async save(rows: readonly Stored[] = [...this.jobs.values()]): Promise<void> {
    const data = JSON.stringify({ version: 1, jobs: rows })
    if (Buffer.byteLength(data) > this.limits.maxStoreBytes) throw fail('STORE_FULL', 503)
    await writeFileAtomic(join(this.directory, 'jobs.json'), data, { mode: 0o600, dirMode: 0o700 })
  }
  private async replace(row: Stored): Promise<void> {
    await this.save([...this.jobs.values()].map(current => current.job.id === row.job.id ? row : current))
    this.jobs.set(row.job.id, row)
  }
  private async saveBytes(name: string, bytes: Buffer): Promise<void> {
    const temp = join(this.directory, `${randomUUID()}.tmp`)
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
      await rename(temp, join(this.directory, name))
    } finally { await rm(temp, { force: true }) }
  }
  private track(id: string, operation: () => Promise<void>): void {
    if (this.active.has(id)) return
    const run = Promise.resolve().then(operation).finally(() => { this.active.delete(id) })
    this.active.set(id, run)
  }
  private async json(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await fetch(this.enabled().gatewayOrigin + path, { method: body === undefined ? 'GET' : 'POST',
      redirect: 'error', signal, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) { await response.body?.cancel(); throw fail(body === undefined ? 'READ_UNAVAILABLE' : 'OUTCOME_UNKNOWN') }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel(); throw fail('RESPONSE_INVALID')
    }
    return JSON.parse((await bounded(response, 256 * 1024)).toString('utf8')) as unknown
  }
  private async checkGateway(): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10000)])
    try {
      const health = await this.json('/health', signal)
      if (!object(health) || health.ok !== true || health.comfy !== true || !object(health.queue)) throw fail('GATEWAY_UNAVAILABLE', 503)
      if (health.queue.running !== 0 || health.queue.pending !== 0) throw fail('BUSY', 409)
      const spec = await this.json('/v1/spec', signal)
      const profile = object(spec) && object(spec.modelProfiles) ? spec.modelProfiles.qs_new4 : undefined
      if (!object(profile) || profile.steps !== 4 || profile.width !== 1344 || profile.height !== 768
        || !Array.isArray(profile.supported_seconds) || !profile.supported_seconds.includes(5)
        || !Array.isArray(health.presets) || !health.presets.includes('landscape_C')) throw fail('PROFILE_UNAVAILABLE', 503)
    } catch (error) {
      if (error instanceof ComputeError && ['VIDEO_TRIAL_BUSY', 'VIDEO_TRIAL_PROFILE_UNAVAILABLE', 'VIDEO_TRIAL_CLOSED'].includes(error.code)) throw error
      throw fail('GATEWAY_UNAVAILABLE', 503)
    }
  }
  /** Persist immutable inputs before starting any external generation.
   * @param value - Exact owner JSON request with an optional embedded first frame or completed parent.
   * @param sessionExists - Current live Session authority for a new submission.
   * @returns The same receipt for duplicates, or the newly reserved running trial.
   */
  async submit(value: unknown, sessionExists: (id: string) => boolean): Promise<VideoTrialJob> {
    this.enabled()
    const input = parse(value)
    const operation = this.serial.then(async () => {
      await this.initialize(); this.enabled()
      if (this.updateLocked) throw fail('UPDATE_IN_PROGRESS', 503)
      if (!sessionExists(input.sessionId)) throw fail('SESSION_UNAVAILABLE', 403)
      const old = this.jobs.get(input.id)
      if (old !== undefined) {
        if (old.fingerprint !== input.fingerprint) throw fail('ID_CONFLICT', 409)
        return structuredClone(old.job)
      }
      if (this.active.size || [...this.jobs.values()].some(row => row.job.status === 'running')) throw fail('BUSY', 409)
      if (this.jobs.size >= this.limits.maxRecords) throw fail('STORE_FULL', 503)
      let frame = input.frame
      if (input.reuseJobId !== undefined) {
        const parent = this.jobs.get(input.reuseJobId)
        if (parent === undefined || parent.job.status !== 'completed' || parent.job.sessionId !== input.sessionId
          || parent.job.prompt !== input.prompt || parent.frame === undefined) throw fail('REUSE_INVALID', 409)
        try { frame = { mediaType: parent.frame.mediaType, bytes: await this.readFrame(parent) } }
        catch { throw fail('INPUT_UNAVAILABLE', 409) }
      }
      if (frame === undefined && !this.images.status().enabled) throw fail('IMAGE_UNAVAILABLE', 503)
      await this.checkGateway()
      if (this.updateLocked) throw fail('UPDATE_IN_PROGRESS', 503)
      const row: Stored = { fingerprint: input.fingerprint, seed: randomInt(0, 2147483648), attempted: false,
        source: input.reuseJobId !== undefined ? 'reuse' : frame === undefined ? 'generated' : 'attachment',
        ...(input.reuseJobId === undefined ? {} : { parentId: input.reuseJobId }),
        ...(frame === undefined ? { imageJobId: randomUUID() } : { frame: frameInfo(frame.bytes, frame.mediaType) }),
        job: { id: input.id, sessionId: input.sessionId, prompt: input.prompt, ...PROFILE, billing: BILLING, status: 'running',
          timing: { submittedAt: new Date().toISOString(), phase: frame === undefined ? 'preparing-first-frame' : 'submitting' } } }
      if (frame !== undefined) await this.saveBytes(`${input.id}.input`, frame.bytes)
      await this.save([...this.jobs.values(), row]); this.jobs.set(input.id, row)
      this.track(input.id, () => this.run(row, sessionExists))
      return structuredClone(row.job)
    })
    this.serial = operation.catch(() => undefined)
    return operation
  }
  private async readFrame(row: Stored): Promise<Buffer> {
    if (row.frame === undefined) throw fail('INPUT_UNAVAILABLE', 409)
    const bytes = await readPrivate(join(this.directory, `${row.job.id}.input`), BYTES)
    if (bytes.length !== row.frame.bytes || digest(bytes) !== row.frame.sha256) throw fail('INPUT_UNAVAILABLE', 409)
    inspectVideoTrialFirstFrame(bytes, row.frame.mediaType)
    return bytes
  }
  private async run(initial: Stored, sessionExists: (id: string) => boolean): Promise<void> {
    let row = initial
    try {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.enabled().timeoutMs)])
      signal.throwIfAborted()
      if (row.frame === undefined) {
        if (row.imageJobId === undefined) throw fail('STORE_INVALID', 503)
        await this.images.submit({ id: row.imageJobId, sessionId: row.job.sessionId, prompt: row.job.prompt, size: 'landscape' }, sessionExists)
        for (;;) {
          signal.throwIfAborted()
          const image = await this.images.job(row.imageJobId, row.job.sessionId)
          if (image.status === 'failed') throw fail(image.errorCode === 'IMAGE_TRIAL_OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'FIRST_FRAME_FAILED')
          if (image.status === 'completed') break
          await pause(this.pollMs, undefined, { signal })
        }
        const bytes = await this.images.image(row.imageJobId, row.job.sessionId)
        inspectVideoTrialFirstFrame(bytes, 'image/png')
        await this.saveBytes(`${row.job.id}.input`, bytes)
        row = { ...row, frame: frameInfo(bytes, 'image/png') }
        await this.replace(row)
      }
      const bytes = await this.readFrame(row)
      if (row.frame === undefined) throw fail('INPUT_UNAVAILABLE', 409)
      const mediaType = row.frame.mediaType
      const query = new URLSearchParams({ firstFrameSha256: digest(bytes), negativeSha256: digest('') })
      const identity = await this.json(`/v1/recipes/qs_new4/identity?${query.toString()}`, signal)
      if (!object(identity) || identity.workflow !== 'qs_new4' || identity.firstFrameSha256 !== digest(bytes)
        || identity.negativeSha256 !== digest('') || typeof identity.executionRecipeSha256 !== 'string'
        || !SHA.test(identity.executionRecipeSha256) || typeof identity.modelSha256 !== 'string' || !SHA.test(identity.modelSha256)) throw fail('IDENTITY_INVALID')
      const expected = { executionRecipeSha256: identity.executionRecipeSha256, modelSha256: identity.modelSha256 }
      if (this.updateLocked) throw fail('UPDATE_IN_PROGRESS', 503)
      row = { ...row, expected, attempted: true, job: { ...row.job, timing: { ...row.job.timing, phase: 'submitting' } } }
      await this.replace(row)
      signal.throwIfAborted()
      const response = await this.json('/v1/jobs', signal, { prompt: row.job.prompt, negative: '', workflow: 'qs_new4',
        preset: 'landscape_C', seconds: 5, steps: 4, seed: row.seed,
        ref_images: [{ role: 'first', url: `data:${mediaType};base64,${bytes.toString('base64')}` }], expected })
      const externalId = object(response) ? response.job_id ?? response.id : undefined
      if (typeof externalId !== 'string' || !EXTERNAL_ID.test(externalId)
        || (object(response) && response.id !== undefined && response.id !== externalId)) throw fail('OUTCOME_UNKNOWN')
      row = { ...row, externalId, job: { ...row.job, timing: { ...row.job.timing, phase: 'queued' } } }
      await this.replace(row)
      await this.reconcile(row, signal)
    } catch (error) { await this.recordFailure(row, error) }
  }
  private async recordFailure(row: Stored, error: unknown): Promise<void> {
    const current = this.jobs.get(row.job.id) ?? row
    const external = current.externalId !== undefined
    const errorCode = error instanceof ComputeError && error.code.startsWith('VIDEO_TRIAL_') ? error.code
      : error instanceof ComputeError && error.code === 'IMAGE_TRIAL_BUSY' ? 'VIDEO_TRIAL_BUSY'
        : current.attempted || this.lifetime.signal.aborted ? 'VIDEO_TRIAL_OUTCOME_UNKNOWN'
          : current.frame === undefined ? 'VIDEO_TRIAL_FIRST_FRAME_FAILED' : 'VIDEO_TRIAL_GATEWAY_UNAVAILABLE'
    const terminal = ['VIDEO_TRIAL_RECEIPT_INVALID', 'VIDEO_TRIAL_RESULT_INVALID', 'VIDEO_TRIAL_RESPONSE_INVALID'].includes(errorCode)
    const next: Stored = { ...current, job: { ...current.job, status: external && !terminal ? 'running' : 'failed', errorCode } }
    try { await this.replace(next) }
    catch { this.jobs.set(current.job.id, { ...current, job: { ...current.job, status: 'failed', errorCode: 'VIDEO_TRIAL_STORE_FAILED' } }) }
  }
  private async reconcile(initial: Stored, signal: AbortSignal): Promise<void> {
    let row = initial
    if (row.externalId === undefined || row.expected === undefined) throw fail('STORE_INVALID', 503)
    const expected = row.expected
    for (;;) {
      const value = await this.json(`/v1/jobs/${row.externalId}`, signal)
      if (!object(value) || (value.job_id ?? value.id) !== row.externalId || (value.id !== undefined && value.id !== row.externalId)
        || !object(value.fed) || value.fed.workflow !== 'qs_new4' || value.fed.steps !== 4 || value.fed.seconds !== 5
        || value.fed.width !== 1344 || value.fed.height !== 768 || value.fed.seed !== row.seed
        || !object(value.recipe_identity) || !object(value.recipe_identity.expected)
        || value.recipe_identity.expected.executionRecipeSha256 !== expected.executionRecipeSha256
        || value.recipe_identity.expected.modelSha256 !== expected.modelSha256) throw fail('RECEIPT_INVALID')
      if (['failed', 'error', 'cancelled'].includes(String(value.status))) {
        await this.replace({ ...row, job: { ...row.job, status: 'failed', errorCode: 'VIDEO_TRIAL_UPSTREAM_FAILED' } }); return
      }
      if (!['queued', 'running', 'done'].includes(String(value.status))) throw fail('RECEIPT_INVALID')
      const progress = object(value.progress) ? value.progress.percent : undefined
      const phase = value.status === 'done' ? 'receiving' : value.status === 'queued' ? 'queued' : 'generating'
      const { errorCode: _error, progress: _oldProgress, ...previous } = row.job
      row = { ...row, job: { ...previous, timing: { ...previous.timing, phase },
        ...(typeof progress === 'number' && Number.isFinite(progress) && progress >= 0 && progress <= 100 ? { progress } : {}) } }
      await this.replace(row)
      if (value.status === 'done') {
        const identity = value.recipe_identity
        if (identity.attested !== true || !object(identity.actual)
          || identity.actual.executionRecipeSha256 !== expected.executionRecipeSha256
          || identity.actual.modelSha256 !== expected.modelSha256) throw fail('RECEIPT_INVALID')
        const response = await fetch(`${this.enabled().gatewayOrigin}/v1/jobs/${row.externalId}/video`, { signal, redirect: 'error' })
        if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'video/mp4') {
          await response.body?.cancel(); throw fail('RESULT_UNAVAILABLE')
        }
        const bytes = await bounded(response, BYTES)
        let metadata: ReturnType<typeof inspectVideoTrialMp4>
        try { metadata = inspectVideoTrialMp4(bytes) } catch { throw fail('RESULT_INVALID') }
        if (metadata.width !== 1344 || metadata.height !== 768 || metadata.frameCount !== 120 || Math.abs(metadata.durationSeconds - 5) > 0.1) throw fail('RESULT_INVALID')
        await this.saveBytes(`${row.job.id}.mp4`, bytes)
        await this.replace({ ...row, job: { ...row.job, status: 'completed', result: { bytes: bytes.length, sha256: digest(bytes) } } }); return
      }
      await pause(this.pollMs, undefined, { signal })
    }
  }
  /** Read only the addressed Session's original receipt; known remote jobs may reconcile by GET.
   * @param id - Original local UUID.
   * @param sessionId - Authenticated addressed live or persisted Session.
   * @param retryDelivery - Explicitly recheck a previously rejected download; never resubmit generation.
   * @returns Detached public receipt without generating or resubmitting.
   */
  async job(id: string, sessionId: string, retryDelivery = false): Promise<VideoTrialJob> {
    this.enabled()
    if (!UUID.test(id) || !SESSION.test(sessionId)) throw fail('INVALID', 400)
    await this.initialize()
    let row = this.jobs.get(id)
    if (row === undefined || row.job.sessionId !== sessionId) throw fail('NOT_FOUND', 404)
    if (retryDelivery) {
      const recheck = this.serial.then(async () => {
        const current = this.jobs.get(id)
        if (current === undefined || current.job.sessionId !== sessionId) throw fail('NOT_FOUND', 404)
        if (current.externalId === undefined || current.job.status !== 'failed' || current.job.timing.phase !== 'receiving'
          || !['VIDEO_TRIAL_RESULT_INVALID', 'VIDEO_TRIAL_RESPONSE_INVALID'].includes(current.job.errorCode ?? '')) return
        if (this.active.has(id)) return
        if (this.active.size > 0) throw fail('BUSY', 409)
        const { errorCode: _error, ...previous } = current.job
        await this.replace({ ...current, job: { ...previous, status: 'running' } })
      })
      this.serial = recheck.catch(() => undefined)
      await recheck
      row = this.jobs.get(id)
      if (row === undefined) throw fail('NOT_FOUND', 404)
    }
    if (row.externalId !== undefined && row.job.status === 'running' && !this.active.has(id)) {
      this.track(id, async () => {
        try {
          const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.enabled().timeoutMs)])
          await this.reconcile(row, signal)
        } catch (error) { await this.recordFailure(row, error) }
      })
    }
    return structuredClone(row.job)
  }
  /** Rehash the checked cached MP4 without trusting an upstream URL or exposing a local path.
   * @param id - Completed local UUID.
   * @param sessionId - Addressed owner Session.
   * @returns Original verified media bytes.
   */
  async video(id: string, sessionId: string): Promise<Buffer> {
    const job = await this.job(id, sessionId)
    if (job.status !== 'completed' || job.result === undefined) throw fail('NOT_READY', 409)
    const bytes = await readPrivate(join(this.directory, `${id}.mp4`), BYTES)
    if (bytes.length !== job.result.bytes || digest(bytes) !== job.result.sha256) throw fail('STORE_INVALID', 503)
    return bytes
  }
  /** Stop local waiting; preserve remote jobs and never send a global cancellation. */
  async close(): Promise<void> {
    this.lifetime.abort()
    await this.serial
    await Promise.all(this.active.values())
  }
}
