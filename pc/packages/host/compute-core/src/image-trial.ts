/** Host-owned, non-billable image trial using the explicitly configured private Guangzhou gateway. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { request as requestHttp } from 'node:http'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ComputeError } from './errors.ts'
import { inspectImageTrialPng } from './comfy-png.ts'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const SESSION = /^[A-Za-z0-9._:-]{1,128}$/u
const PNG_LIMIT = 16 * 1024 * 1024
const DIMENSIONS = { square: [1024, 1024], landscape: [2048, 1152], portrait: [1152, 2048] } as const
const BILLING = 'research-no-charge' as const
const MEDIA_PATH = /^\/img\/5080\/[A-Za-z0-9_-]{1,80}\.png$/u
const DELIVERY_RETRY_MS = 5000

// A model can need longer than fetch's independent five-minute header limit.
// This loopback POST uses the job's deadline, sends once, and never follows a redirect.
async function generateResponse(url: string, headers: Record<string, string>, body: string,
  signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = requestHttp(url, { method: 'POST', agent: false, signal, headers: {
      ...headers, 'Content-Length': Buffer.byteLength(body), 'Accept-Encoding': 'identity',
    } }, (response) => {
      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        response.destroy(); reject(failure('UPSTREAM_FAILED')); return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 16384) { response.destroy(); reject(failure('RESULT_INVALID')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => { resolve(Buffer.concat(chunks)) })
    })
    request.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ECONNREFUSED' ? failure('GATEWAY_UNAVAILABLE', 503) : error)
    })
    request.end(body)
  })
}

/** Deployment-owned loopback gateway and environment variable reference; contains no credential. */
export interface ImageTrialConfig {
  /** Operator-owned loopback endpoint forwarding requests to Guangzhou. */
  readonly gatewayOrigin: string
  /** Environment variable containing the private gateway credential. */
  readonly tokenEnv: string
  /** Waiting budget for an eight-step request; longer presets scale this budget. */
  readonly timeoutMs?: number
}

/** Three user-facing image aspect presets. */
export type ImageTrialSize = keyof typeof DIMENSIONS

/** Fixed Qwen Image 2.1 trial presets; increasing steps preserves the output dimensions. */
export type ImageTrialSteps = 8 | 12 | 20

/** Immutable UUID admitted from an owner request. */
export type ImageTrialId = Branded<'qianshou-image-trial-id'>

/** Private receipt shared with only the addressed owner Session. No upstream URL or token is included. */
export interface ImageTrialJob {
  readonly id: ImageTrialId
  readonly sessionId: SessionId
  readonly prompt: string
  readonly size: ImageTrialSize
  readonly status: 'running' | 'completed' | 'failed'
  readonly steps: ImageTrialSteps
  readonly width: number
  readonly height: number
  readonly billing: typeof BILLING
  /** Host acceptance time and last observed gateway stage; absent on older receipts. No sampling percentage is inferred. */
  readonly timing?: { readonly submittedAt: string; readonly phase: 'queued' | 'checking' | 'generating' | 'receiving' }
  readonly errorCode?: string
  readonly result?: { readonly bytes: number; readonly sha256: string }
}

type Input = Pick<ImageTrialJob, 'id' | 'sessionId' | 'prompt' | 'size' | 'steps'>
type ResolvedConfig = { readonly gatewayOrigin: string; readonly tokenEnv: string; readonly timeoutMs: number }
type DeliveryReference = { readonly path: string; readonly gatewaySha256: string }

function failure(code: string, status = 502): ComputeError { return new ComputeError(`IMAGE_TRIAL_${code}`, status) }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function gatewaySha256(config: ResolvedConfig): string { return createHash('sha256').update(config.gatewayOrigin).digest('hex') }
function credential(config: ResolvedConfig): string | undefined {
  const token = process.env[config.tokenEnv]?.trim()
  return token && token.length <= 4096 && !/[\r\n]/u.test(token) ? token : undefined
}
function input(value: unknown): Input {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id)
    || typeof value.sessionId !== 'string' || !SESSION.test(value.sessionId)
    || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 4000
    || (value.size !== 'square' && value.size !== 'landscape' && value.size !== 'portrait')
    || (value.steps !== undefined && value.steps !== 8 && value.steps !== 12 && value.steps !== 20)) throw failure('INVALID', 400)
  return { id: value.id as ImageTrialId, sessionId: value.sessionId as SessionId, prompt: value.prompt,
    size: value.size, steps: value.steps === undefined ? 8 : value.steps }
}
function configOf(config: ImageTrialConfig | undefined): ResolvedConfig | undefined {
  if (config === undefined) return undefined
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(config.gatewayOrigin)
    || Number(new URL(config.gatewayOrigin).port) > 65535
    || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(config.tokenEnv)
    || !Number.isSafeInteger(config.timeoutMs ?? 360000)
    || (config.timeoutMs ?? 360000) <= 300000 || (config.timeoutMs ?? 360000) > 900000) throw failure('CONFIG_INVALID', 503)
  return { ...config, timeoutMs: config.timeoutMs ?? 360000 }
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel()
    throw failure('RESPONSE_TOO_LARGE')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw failure('RESPONSE_INVALID')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw failure('RESPONSE_TOO_LARGE')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return Buffer.concat(chunks, bytes)
}

async function readPrivate(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw failure('STORE_INVALID', 503)
    const bytes = await file.readFile()
    if (bytes.length > maxBytes) throw failure('STORE_INVALID', 503)
    return bytes
  } finally { await file.close() }
}

/** One Host lifecycle owns one GPU request; interrupted outcomes are retained and never retried. */
export class ImageTrialHost {
  private updateLocked = false
  private readonly config: ResolvedConfig | undefined
  private readonly jobs = new Map<string, ImageTrialJob>()
  private readonly deliveries = new Map<string, DeliveryReference>()
  private readonly deliveryAttempts = new Map<string, number>()
  private readonly lifetime = new AbortController()
  private initializing?: Promise<void>
  private serial: Promise<unknown> = Promise.resolve()
  private active: Promise<void> | undefined

  constructor(config: ImageTrialConfig | undefined, private readonly directory: string,
    private readonly limits: { maxRecords: number; maxStoreBytes: number }) {
    this.config = configOf(config)
    if (!isAbsolute(directory)) throw failure('CONFIG_INVALID', 503)
  }

  /** Close only new generation admission; original GET delivery stays available. */
  setUpdateLocked(locked: boolean): void { this.updateLocked = locked }
  /** Observe original GPU work, excluding persisted GET-only delivery and old failed history. */
  async updateState(): Promise<'idle' | 'busy' | 'unknown'> {
    await this.initialize()
    await this.serial
    return [...this.jobs.values()].some(row => row.status === 'running' && !this.deliveries.has(row.id)) ? 'busy' : 'idle'
  }

  /** Configuration presence only; this does not claim gateway health, supply, quotation or settlement.
   * @returns Fixed research scope and supported presets.
   */
  status(): { enabled: boolean; sizes: ImageTrialSize[]; steps: 8; supportedSteps: ImageTrialSteps[]; billing: typeof BILLING } {
    return { enabled: this.config !== undefined, sizes: ['square', 'landscape', 'portrait'],
      steps: 8, supportedSteps: [8, 12, 20], billing: BILLING }
  }

  /** Keep an existing UUID on its original gateway even after enabling another backend.
   * @param id - Original request identifier.
   * @returns Whether this private ledger retains that request; no network or generation.
   */
  async owns(id: string): Promise<boolean> {
    await this.initialize(); await this.serial
    return this.jobs.has(id)
  }

  private async initialize(): Promise<void> {
    this.initializing ??= this.load()
    return this.initializing
  }

  private async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(this.directory)).isDirectory()) throw failure('STORE_INVALID', 503)
    await chmod(this.directory, 0o700)
    let raw: Buffer
    try { raw = await readPrivate(join(this.directory, 'jobs.json'), this.limits.maxStoreBytes) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw failure('STORE_INVALID', 503)
    }
    try {
      const saved: unknown = JSON.parse(raw.toString('utf8'))
      if (!object(saved) || saved.version !== 1 || !Array.isArray(saved.jobs)
        || saved.jobs.length > this.limits.maxRecords) throw failure('STORE_INVALID', 503)
      let interrupted = false
      for (const rawJob of saved.jobs) {
        if (!object(rawJob)) throw failure('STORE_INVALID', 503)
        const parsed = input(rawJob)
        const [width, height] = DIMENSIONS[parsed.size]
        if (this.jobs.has(parsed.id) || rawJob.width !== width || rawJob.height !== height
          || ![8, 12, 20].includes(Number(rawJob.steps)) || rawJob.billing !== BILLING
          || !['running', 'failed', 'completed'].includes(String(rawJob.status))) throw failure('STORE_INVALID', 503)
        let job: ImageTrialJob = { ...parsed, width, height, billing: BILLING, status: rawJob.status as ImageTrialJob['status'] }
        if (rawJob.timing !== undefined) {
          const timing = rawJob.timing
          if (!object(timing) || typeof timing.submittedAt !== 'string'
            || !Number.isFinite(Date.parse(timing.submittedAt)) || new Date(timing.submittedAt).toISOString() !== timing.submittedAt
            || (timing.phase !== 'generating' && timing.phase !== 'receiving')) throw failure('STORE_INVALID', 503)
          job = { ...job, timing: { submittedAt: timing.submittedAt, phase: timing.phase } }
        }
        if (rawJob.delivery !== undefined) {
          const delivery = rawJob.delivery
          if (!object(delivery) || Object.keys(delivery).sort().join(',') !== 'gatewaySha256,path'
            || typeof delivery.path !== 'string' || !MEDIA_PATH.test(delivery.path)
            || typeof delivery.gatewaySha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(delivery.gatewaySha256)
            || job.timing?.phase !== 'receiving') throw failure('STORE_INVALID', 503)
          this.deliveries.set(job.id, { path: delivery.path, gatewaySha256: delivery.gatewaySha256 })
        }
        if (job.status === 'completed') {
          const result = rawJob.result
          if (!object(result) || !Number.isSafeInteger(result.bytes) || Number(result.bytes) < 1 || Number(result.bytes) > PNG_LIMIT
            || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(result.sha256)) throw failure('STORE_INVALID', 503)
          job = { ...job, result: { bytes: Number(result.bytes), sha256: result.sha256 } }
        } else if (job.status === 'running') {
          job = { ...job, status: 'failed', errorCode: 'IMAGE_TRIAL_OUTCOME_UNKNOWN' }
          interrupted = true
        } else {
          if (typeof rawJob.errorCode !== 'string' || !/^IMAGE_TRIAL_[A-Z_]{1,80}$/u.test(rawJob.errorCode)) throw failure('STORE_INVALID', 503)
          job = { ...job, errorCode: rawJob.errorCode }
        }
        this.jobs.set(job.id, job)
      }
      if (interrupted) await this.save()
    } catch { throw failure('STORE_INVALID', 503) }
  }

  private async save(jobs: readonly ImageTrialJob[] = [...this.jobs.values()],
    deliveries: ReadonlyMap<string, DeliveryReference> = this.deliveries): Promise<void> {
    const contents = JSON.stringify({ version: 1, jobs: jobs.map((job) => {
      const delivery = deliveries.get(job.id)
      return { ...job, ...(delivery === undefined ? {} : { delivery }) }
    }) })
    if (Buffer.byteLength(contents) > this.limits.maxStoreBytes) throw failure('STORE_FULL', 503)
    await writeFileAtomic(join(this.directory, 'jobs.json'), contents, { mode: 0o600, dirMode: 0o700 })
  }

  private requireEnabled(): ResolvedConfig {
    if (this.config === undefined) throw failure('DISABLED', 503)
    if (this.lifetime.signal.aborted) throw failure('CLOSED', 503)
    return this.config
  }

  /** Reserve an immutable request before the sole upstream POST; duplicates return their existing receipt.
   * @param value - Owner-submitted JSON fields, without provider selection or credential.
   * @param sessionExists - Checks the live owner Session before accepting a new operation.
   * @returns Running or previously recorded job, without waiting for the model.
   */
  async submit(value: unknown, sessionExists: (id: string) => boolean): Promise<ImageTrialJob> {
    const config = this.requireEnabled()
    if (!object(value) || !['id,prompt,sessionId,size', 'id,prompt,sessionId,size,steps']
      .includes(Object.keys(value).sort().join(','))) throw failure('INVALID', 400)
    const request = input(value)
    const operation = this.serial.then(async () => {
      await this.initialize()
      this.requireEnabled()
      if (!sessionExists(request.sessionId)) throw failure('SESSION_UNAVAILABLE', 403)
      const existing = this.jobs.get(request.id)
      if (existing !== undefined) {
        if (existing.sessionId !== request.sessionId || existing.prompt !== request.prompt || existing.size !== request.size
          || existing.steps !== request.steps) throw failure('ID_CONFLICT', 409)
        return existing
      }
      if (this.updateLocked) throw failure('UPDATE_IN_PROGRESS', 503)
      if (this.active !== undefined) throw failure('BUSY', 409)
      if (this.jobs.size >= this.limits.maxRecords) throw failure('STORE_FULL', 503)
      const token = credential(config)
      if (token === undefined) throw failure('CREDENTIAL_UNAVAILABLE', 503)
      const [width, height] = DIMENSIONS[request.size]
      const job: ImageTrialJob = { ...request, status: 'running', width, height, billing: BILLING,
        timing: { submittedAt: new Date().toISOString(), phase: 'generating' } }
      await this.save([...this.jobs.values(), job])
      this.jobs.set(job.id, job)
      this.active = this.generate(job, config, token).finally(() => { this.active = undefined })
      return job
    })
    this.serial = operation.catch(() => undefined)
    return operation
  }

  /** Read a job only when its immutable Session identity matches the addressed owner Session.
   * @param id - Opaque UUID supplied by the original caller.
   * @param sessionId - Addressed live owner Session.
   * @returns A copied receipt without paths or credentials.
   */
  async job(id: string, sessionId: string): Promise<ImageTrialJob> {
    this.requireEnabled()
    if (!UUID.test(id) || !SESSION.test(sessionId)) throw failure('INVALID', 400)
    await this.initialize()
    let job = this.jobs.get(id)
    if (job === undefined || job.sessionId !== sessionId) throw failure('NOT_FOUND', 404)
    if (job.status === 'failed' && this.deliveries.has(id)) {
      const operation = this.serial.then(async () => {
        const current = this.jobs.get(id)
        const reference = this.deliveries.get(id)
        const config = this.requireEnabled()
        const token = credential(config)
        if (current === undefined || current.sessionId !== sessionId) throw failure('NOT_FOUND', 404)
        if (current.status !== 'failed' || reference === undefined || token === undefined || this.active !== undefined
          || reference.gatewaySha256 !== gatewaySha256(config)
          || !['IMAGE_TRIAL_OUTCOME_UNKNOWN', 'IMAGE_TRIAL_DELIVERY_UNAVAILABLE', 'IMAGE_TRIAL_STORE_FAILED'].includes(current.errorCode ?? '')
          || Date.now() - (this.deliveryAttempts.get(id) ?? 0) < DELIVERY_RETRY_MS) return current
        const restored: ImageTrialJob = { id: current.id, sessionId: current.sessionId, prompt: current.prompt,
          size: current.size, steps: current.steps, width: current.width, height: current.height,
          billing: BILLING, status: 'running', timing: { submittedAt: current.timing?.submittedAt ?? new Date().toISOString(), phase: 'receiving' } }
        await this.save([...this.jobs.values()].map(existing => existing.id === id ? restored : existing))
        this.deliveryAttempts.set(id, Date.now())
        this.jobs.set(id, restored)
        this.active = this.recoverDelivery(restored, reference, config, token).finally(() => { this.active = undefined })
        return restored
      })
      this.serial = operation.catch(() => undefined)
      job = await operation
    }
    return { ...job, ...(job.timing === undefined ? {} : { timing: { ...job.timing } }),
      ...(job.result === undefined ? {} : { result: { ...job.result } }) }
  }

  /** Rehash the private cached PNG before returning it to the owner connection.
   * @param id - Previously completed UUID.
   * @param sessionId - The job's addressed live owner Session.
   * @returns Validated image bytes.
   */
  async image(id: string, sessionId: string): Promise<Buffer> {
    const job = await this.job(id, sessionId)
    if (job.status !== 'completed' || job.result === undefined) throw failure('NOT_READY', 409)
    const bytes = await readPrivate(join(this.directory, `${id}.png`), PNG_LIMIT)
    if (bytes.length !== job.result.bytes || createHash('sha256').update(bytes).digest('hex') !== job.result.sha256) throw failure('STORE_INVALID', 503)
    return bytes
  }

  private async generate(job: ImageTrialJob, config: ResolvedConfig, token: string): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(Math.ceil(config.timeoutMs * job.steps / 8))])
    let current = job
    let completed: ImageTrialJob
    try {
      signal.throwIfAborted()
      if (this.updateLocked) throw failure('UPDATE_IN_PROGRESS', 503)
      const response = await generateResponse(`${config.gatewayOrigin}/image`,
        { 'Content-Type': 'application/json', 'X-API-Key': token, 'Idempotency-Key': job.id },
        JSON.stringify({ prompt: job.prompt, width: job.width, height: job.height,
          steps: job.steps, node: '5080', style: null, auto_enhance: false }), signal)
      const result: unknown = JSON.parse(response.toString('utf8'))
      if (!object(result) || typeof result.url !== 'string' || !MEDIA_PATH.test(result.url)) throw failure('RESULT_INVALID')
      current = { ...job, timing: { submittedAt: job.timing?.submittedAt ?? new Date().toISOString(), phase: 'receiving' } }
      const reference = { path: result.url, gatewaySha256: gatewaySha256(config) }
      const deliveries = new Map(this.deliveries).set(job.id, reference)
      await this.save([...this.jobs.values()].map(existing => existing.id === job.id ? current : existing), deliveries)
      this.deliveries.set(job.id, reference)
      this.jobs.set(job.id, current)
      completed = await this.download(current, reference, config, token, signal)
    } catch (error) {
      completed = { ...current, status: 'failed', errorCode: signal.aborted ? 'IMAGE_TRIAL_OUTCOME_UNKNOWN'
        : error instanceof ComputeError ? error.code : 'IMAGE_TRIAL_OUTCOME_UNKNOWN' }
    }
    await this.complete(current, completed)
  }

  private async download(job: ImageTrialJob, reference: DeliveryReference, config: ResolvedConfig,
    token: string, signal: AbortSignal): Promise<ImageTrialJob> {
    if (!MEDIA_PATH.test(reference.path) || reference.gatewaySha256 !== gatewaySha256(config)) throw failure('RESULT_INVALID')
    const imageResponse = await fetch(config.gatewayOrigin + reference.path, { headers: { 'X-API-Key': token }, redirect: 'error', signal })
    if (!imageResponse.ok) {
      await imageResponse.body?.cancel()
      throw failure('DELIVERY_UNAVAILABLE')
    }
    if (imageResponse.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'image/png') {
      await imageResponse.body?.cancel()
      throw failure('PNG_INVALID')
    }
    const bytes = await readBounded(imageResponse, PNG_LIMIT)
    let dimensions: { width: number; height: number }
    try { dimensions = inspectImageTrialPng(bytes) } catch { throw failure('PNG_INVALID') }
    if (dimensions.width !== job.width || dimensions.height !== job.height) throw failure('DIMENSION_MISMATCH')
    signal.throwIfAborted()
    const temp = join(this.directory, `${randomUUID()}.tmp`)
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
      await rename(temp, join(this.directory, `${job.id}.png`))
    } finally { await rm(temp, { force: true }) }
    return { ...job, status: 'completed', result: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
  }

  private async recoverDelivery(job: ImageTrialJob, reference: DeliveryReference, config: ResolvedConfig, token: string): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(config.timeoutMs)])
    let completed: ImageTrialJob
    try {
      completed = await this.download(job, reference, config, token, signal)
    } catch (error) {
      completed = { ...job, status: 'failed', errorCode: signal.aborted ? 'IMAGE_TRIAL_OUTCOME_UNKNOWN'
        : error instanceof ComputeError ? error.code : 'IMAGE_TRIAL_OUTCOME_UNKNOWN' }
    }
    await this.complete(job, completed)
  }

  private async complete(current: ImageTrialJob, completed: ImageTrialJob): Promise<void> {
    try {
      await this.save([...this.jobs.values()].map(existing => existing.id === current.id ? completed : existing))
      this.jobs.set(current.id, completed)
    } catch { this.jobs.set(current.id, { ...current, status: 'failed', errorCode: 'IMAGE_TRIAL_STORE_FAILED' }) }
  }

  /** Stop local waiting and settle the private receipt without cancelling unrelated model jobs. */
  async close(): Promise<void> {
    this.lifetime.abort()
    await this.serial
    await this.active
  }
}
