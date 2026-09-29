/** Durable owner requests for Shanghai's free image scheduler; Guangzhou alone returns PNG bytes. */
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CoreAccountId, QianshouCoreClient } from './core-client.ts'
import type { ImageTrialId, ImageTrialJob } from './image-trial.ts'
import { inspectImageTrialPng } from './comfy-png.ts'
import { ComputeError } from './errors.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SESSION = /^[A-Za-z0-9._:-]{1,128}$/u
const SHA = /^[0-9a-f]{64}$/u
const PNG_LIMIT = 16 * 1024 * 1024
const SCHEMA = 'qianshou.research-media-task.v1'
const BILLING = 'research-no-charge' as const

/** Deployment-owned opt-in; neither users nor the renderer supply an address or secret. */
export interface ResearchImageConfig {
  /** Exact Guangzhou HTTPS origin receiving and delivering the free research tasks. */
  readonly gatewayOrigin: string
}
type Client = Pick<QianshouCoreClient, 'getIdentity' | 'assertResearchOwner' | 'submitResearchImageTask' | 'readResearchImageTask' | 'readResearchImageResult'>
type Input = Pick<ImageTrialJob, 'id' | 'sessionId' | 'prompt' | 'size' | 'steps'>
type Artifact = {
  assetId: string
  sha256: string
  size_bytes: number
  content_type: 'image/png'
  width: 2048
  height: 1152
  resultRevision: string
  download_path: string
}
type Receipt = {
  taskId: string
  attemptId: string
  status: 'queued' | 'running' | 'unknown' | 'delivery_pending' | 'succeeded' | 'failed' | 'cancelled'
  createdAt: string
  result: Artifact | null
}
type RetainedJob = ImageTrialJob & { timing: NonNullable<ImageTrialJob['timing']> }
type RecordRow = { job: RetainedJob; ownerId: CoreAccountId; gatewayOrigin: string; receipt: Receipt | null }

function fail(code: string, status = 502): ComputeError { return new ComputeError(`IMAGE_TRIAL_${code}`, status) }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!object(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw fail('RESULT_INVALID')
  return value
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }
function sha(value: unknown): value is string { return typeof value === 'string' && SHA.test(value) }
function origin(value: string): URL {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw fail('CONFIG_INVALID', 503) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/'
    || parsed.search || parsed.hash || parsed.origin !== value) throw fail('CONFIG_INVALID', 503)
  return parsed
}
function input(value: unknown): Input {
  if (!object(value) || !['id,prompt,sessionId,size', 'id,prompt,sessionId,size,steps'].includes(Object.keys(value).sort().join(','))
    || !uuid(value.id) || typeof value.sessionId !== 'string' || !SESSION.test(value.sessionId)
    || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 4000
    || Buffer.byteLength(value.prompt) > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value.prompt)
    || value.size !== 'landscape' || (value.steps !== undefined && value.steps !== 8)) throw fail('SPEC_UNAVAILABLE', 400)
  return { id: value.id as ImageTrialId, sessionId: value.sessionId as SessionId, prompt: value.prompt, size: 'landscape', steps: 8 }
}
function parseArtifact(value: unknown, taskId: string, attemptId: string): Artifact {
  const row = exact(value, ['assetId', 'sha256', 'size_bytes', 'content_type', 'width', 'height', 'resultRevision', 'download_path'])
  if (row.assetId !== attemptId || !sha(row.sha256) || !Number.isSafeInteger(row.size_bytes)
    || Number(row.size_bytes) < 1 || Number(row.size_bytes) > 64 * 1024 * 1024
    || row.content_type !== 'image/png' || row.width !== 2048 || row.height !== 1152 || !sha(row.resultRevision)
    || row.download_path !== `/v1/media/research/result?taskId=${taskId}&attemptId=${attemptId}`) throw fail('RESULT_INVALID')
  return { assetId: attemptId, sha256: row.sha256, size_bytes: Number(row.size_bytes), content_type: 'image/png',
    width: 2048, height: 1152, resultRevision: row.resultRevision, download_path: row.download_path as string }
}
function parseSavedReceipt(value: unknown): Receipt {
  const row = exact(value, ['taskId', 'attemptId', 'status', 'createdAt', 'result'])
  if (!uuid(row.taskId) || !uuid(row.attemptId) || !timestamp(row.createdAt)
    || !['queued', 'running', 'unknown', 'delivery_pending', 'succeeded', 'failed', 'cancelled'].includes(String(row.status))) throw fail('RESULT_INVALID')
  const result = row.result === null ? null : parseArtifact(row.result, row.taskId, row.attemptId)
  if ((row.status === 'succeeded') !== (result !== null)) throw fail('RESULT_INVALID')
  return { taskId: row.taskId, attemptId: row.attemptId, status: row.status as Receipt['status'], createdAt: row.createdAt, result }
}
function parseReceipt(value: unknown, requestId: string): Receipt {
  const row = exact(value, ['ok', 'schema', 'requestId', 'taskId', 'attemptId', 'mode', 'status', 'dispatchState', 'reason',
    'createdAt', 'updatedAt', 'lastSyncedAt', 'non_billable', 'commercial', 'result', 'queue'])
  if (row.ok !== true || row.schema !== SCHEMA || row.requestId !== requestId || row.mode !== 'image'
    || row.non_billable !== true || row.commercial !== false || !timestamp(row.updatedAt)
    || (row.lastSyncedAt !== null && !timestamp(row.lastSyncedAt))
    || (row.reason !== null && (typeof row.reason !== 'string' || !/^[A-Za-z0-9_]{1,96}$/u.test(row.reason)))
    || !['waiting', 'pending', 'sending', 'unknown', 'accepted', 'rejected'].includes(String(row.dispatchState))) throw fail('RESULT_INVALID')
  const queue = exact(row.queue, ['position', 'estimate'])
  if (queue.position !== null && (!Number.isSafeInteger(queue.position) || Number(queue.position) < 1)) throw fail('RESULT_INVALID')
  if (queue.estimate !== null) {
    const estimate = exact(queue.estimate, ['source', 'sampleCount', 'queueSeconds', 'modelLoadSeconds', 'executionSeconds', 'returnSeconds', 'totalSeconds'])
    if (!['conservative', 'observed_control'].includes(String(estimate.source))
      || ['sampleCount', 'queueSeconds', 'modelLoadSeconds', 'executionSeconds', 'returnSeconds', 'totalSeconds']
        .some(key => !Number.isSafeInteger(estimate[key]) || Number(estimate[key]) < 0)) throw fail('RESULT_INVALID')
  }
  return parseSavedReceipt({ taskId: row.taskId, attemptId: row.attemptId, status: row.status,
    createdAt: row.createdAt, result: row.result })
}
async function readPrivate(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit) throw fail('STORE_INVALID', 503)
    const bytes = await handle.readFile()
    if (bytes.length > limit) throw fail('STORE_INVALID', 503)
    return bytes
  } finally { await handle.close() }
}

/** One persisted owner request consumes at most one Shanghai POST, including cold recovery. */
export class ResearchImageHost {
  private readonly rows = new Map<string, RecordRow>()
  private readonly lifetime = new AbortController()
  private readonly active = new Map<string, Promise<void>>()
  private serial: Promise<unknown> = Promise.resolve()
  private initializing?: Promise<void>
  private updateLocked = false
  private readonly gateway: URL | undefined

  /** Construct an optional requester without initiating a remote request.
   * @param client - Host credential owner, or null while the service is unavailable.
   * @param config - Deployment-owned fixed Guangzhou origin, or undefined to disable admission.
   * @param directory - Absolute private ledger and retained-image directory.
   * @param limits - Bounded original-request count and JSON store size.
   */
  constructor(private readonly client: Client | null, config: ResearchImageConfig | undefined,
    private readonly directory: string, private readonly limits: { maxRecords: number; maxStoreBytes: number }) {
    this.gateway = config === undefined ? undefined : origin(config.gatewayOrigin)
    if (!isAbsolute(directory)) throw fail('CONFIG_INVALID', 503)
  }

  /** Close new admission while preserving original task reads and image delivery.
   * @param locked - Whether updater maintenance has acquired admission ownership.
   */
  setUpdateLocked(locked: boolean): void { this.updateLocked = locked }
  /** Whether the deployment enabled the fixed free research path.
   * @returns Configuration availability, independent of online supply.
   */
  enabled(): boolean { return this.client !== null && this.gateway !== undefined }
  /** Select a retained request's original backend before considering current configuration.
   * @param id - Original request UUID.
   * @returns Whether this private ledger owns the original request.
   */
  async owns(id: string): Promise<boolean> { await this.initialize(); await this.serial; return this.rows.has(id) }
  /** Unresolved remote execution continues to veto an updater restart.
   * @returns Busy for unresolved generation, idle for retained-result delivery or no requests.
   */
  async updateState(): Promise<'idle' | 'busy' | 'unknown'> {
    await this.initialize(); await this.serial
    return [...this.rows.values()].some(row => row.job.status === 'running' && row.receipt?.status !== 'succeeded') ? 'busy' : 'idle'
  }
  private initialize(): Promise<void> { this.initializing ??= this.load(); return this.initializing }
  private async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(this.directory)).isDirectory()) throw fail('STORE_INVALID', 503)
    await chmod(this.directory, 0o700)
    let raw: Buffer
    try { raw = await readPrivate(join(this.directory, 'requests.json'), this.limits.maxStoreBytes) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw fail('STORE_INVALID', 503)
    }
    try {
      const saved = exact(JSON.parse(raw.toString('utf8')) as unknown, ['version', 'rows'])
      if (saved.version !== 1 || !Array.isArray(saved.rows) || saved.rows.length > this.limits.maxRecords) throw fail('STORE_INVALID', 503)
      for (const value of saved.rows) {
        const row = exact(value, ['job', 'ownerId', 'gatewayOrigin', 'receipt'])
        if (!object(row.job) || !Number.isSafeInteger(row.ownerId) || Number(row.ownerId) < 1 || typeof row.gatewayOrigin !== 'string') throw fail('STORE_INVALID', 503)
        origin(row.gatewayOrigin)
        const job = row.job
        const request = input({ id: job.id, sessionId: job.sessionId, prompt: job.prompt, size: job.size, steps: job.steps })
        if (this.rows.has(request.id) || job.width !== 2048 || job.height !== 1152 || job.billing !== BILLING
          || !['running', 'failed', 'completed'].includes(String(job.status)) || !object(job.timing)
          || !timestamp(job.timing.submittedAt) || !['queued', 'checking', 'generating', 'receiving'].includes(String(job.timing.phase))) throw fail('STORE_INVALID', 503)
        const receipt = row.receipt === null ? null : parseSavedReceipt(row.receipt)
        const parsed: RetainedJob = { ...request, width: 2048, height: 1152, billing: BILLING,
          status: job.status as ImageTrialJob['status'], timing: { submittedAt: job.timing.submittedAt, phase: job.timing.phase as NonNullable<ImageTrialJob['timing']>['phase'] },
          ...(typeof job.errorCode === 'string' && /^IMAGE_TRIAL_[A-Z_]{1,80}$/u.test(job.errorCode) ? { errorCode: job.errorCode } : {}) }
        if (job.status === 'completed') {
          if (receipt?.result === null || receipt?.result === undefined || !object(job.result)
            || job.result.bytes !== receipt.result.size_bytes || job.result.sha256 !== receipt.result.sha256) throw fail('STORE_INVALID', 503)
          this.rows.set(request.id, { job: { ...parsed, result: { bytes: receipt.result.size_bytes, sha256: receipt.result.sha256 } },
            ownerId: Number(row.ownerId) as CoreAccountId, gatewayOrigin: row.gatewayOrigin, receipt })
        } else this.rows.set(request.id, { job: parsed, ownerId: Number(row.ownerId) as CoreAccountId,
          gatewayOrigin: row.gatewayOrigin, receipt })
      }
    } catch { throw fail('STORE_INVALID', 503) }
  }
  private async save(next: RecordRow): Promise<void> {
    const rows = [...this.rows.values()].filter(row => row.job.id !== next.job.id).concat(next)
    const contents = JSON.stringify({ version: 1, rows })
    if (Buffer.byteLength(contents) > this.limits.maxStoreBytes) throw fail('STORE_FULL', 503)
    await writeFileAtomic(join(this.directory, 'requests.json'), contents, { mode: 0o600, dirMode: 0o700 })
    this.rows.set(next.job.id, next)
  }
  private liveClient(): Client {
    if (this.lifetime.signal.aborted) throw fail('CLOSED', 503)
    if (this.client === null) throw fail('DISABLED', 503)
    return this.client
  }
  private retained(id: string): RecordRow {
    const row = this.rows.get(id)
    if (row === undefined) throw fail('NOT_FOUND', 404)
    return row
  }
  private async sameOwner(row: RecordRow): Promise<void> {
    await this.liveClient().assertResearchOwner(row.ownerId, this.lifetime.signal)
  }

  /** Persist the original intent before the sole Shanghai create request.
   * @param value - Original conversational request, fixed landscape and eight steps.
   * @param sessionExists - Existing live owner Session admission check.
   * @returns A queued owner card immediately; generation continues through the original task.
   */
  async submit(value: unknown, sessionExists: (id: string) => boolean): Promise<ImageTrialJob> {
    const request = input(value)
    const operation = this.serial.then(async () => {
      await this.initialize()
      if (!this.enabled()) throw fail('DISABLED', 503)
      if (!sessionExists(request.sessionId)) throw fail('SESSION_UNAVAILABLE', 403)
      const existing = this.rows.get(request.id)
      if (existing !== undefined) {
        await this.sameOwner(existing)
        if (existing.job.sessionId !== request.sessionId || existing.job.prompt !== request.prompt) throw fail('ID_CONFLICT', 409)
        return existing.job
      }
      if (this.updateLocked) throw fail('UPDATE_IN_PROGRESS', 503)
      if (this.rows.size >= this.limits.maxRecords) throw fail('STORE_FULL', 503)
      const owner = await this.liveClient().getIdentity(this.lifetime.signal)
      const gateway = this.gateway
      if (gateway === undefined) throw fail('DISABLED', 503)
      const job: RetainedJob = { ...request, status: 'running', width: 2048, height: 1152, billing: BILLING,
        timing: { submittedAt: new Date().toISOString(), phase: 'queued' } }
      const row: RecordRow = { job, ownerId: owner.accountId, gatewayOrigin: gateway.origin, receipt: null }
      // The persisted row consumes the only POST right. Recovery never infers a right from a missing response.
      await this.save(row)
      const work = this.create(row).finally(() => { this.active.delete(request.id) })
      this.active.set(request.id, work)
      return job
    })
    this.serial = operation.catch(() => undefined)
    return operation
  }
  private async create(row: RecordRow): Promise<void> {
    try {
      await this.sameOwner(row)
      const receipt = parseReceipt(await this.liveClient().submitResearchImageTask({ requestId: row.job.id,
        mode: 'image', input: { prompt: row.job.prompt } }, row.ownerId, this.lifetime.signal), row.job.id)
      await this.sameOwner(row)
      await this.accept(row.job.id, receipt)
    } catch {
      // A timeout, malformed response or owner change is unresolved; read only the persisted original UUID.
      const operation = this.serial.then(async () => {
        const current = this.rows.get(row.job.id)
        if (current?.job.status === 'running' && current.receipt === null) await this.save({ ...current,
          job: { ...current.job, timing: { submittedAt: current.job.timing.submittedAt, phase: 'checking' } } })
      })
      this.serial = operation.catch(() => undefined)
      await operation.catch(() => undefined)
    }
  }
  private accept(id: string, receipt: Receipt): Promise<void> {
    const operation = this.serial.then(async () => {
      const row = this.rows.get(id)
      if (row === undefined) throw fail('NOT_FOUND', 404)
      if (row.receipt !== null && (row.receipt.taskId !== receipt.taskId || row.receipt.attemptId !== receipt.attemptId)) throw fail('RESULT_INVALID')
      if (row.job.status === 'completed' || row.job.status === 'failed') return
      const status = receipt.status === 'failed' || receipt.status === 'cancelled' ? 'failed' : 'running'
      const phase = receipt.status === 'queued' ? 'queued' : receipt.status === 'unknown' ? 'checking'
        : receipt.status === 'succeeded' || receipt.status === 'delivery_pending' ? 'receiving' : 'generating'
      await this.save({ ...row, receipt, job: { ...row.job, status,
        timing: { submittedAt: row.job.timing.submittedAt, phase },
        ...(status === 'failed' ? { errorCode: 'IMAGE_TRIAL_UPSTREAM_FAILED' } : {}) } })
    })
    this.serial = operation.catch(() => undefined)
    return operation
  }

  /** Query the original request and deliver only the PNG already recorded for its immutable attempt.
   * @param id - Original request UUID.
   * @param sessionId - Original Session identity.
   * @returns A credential-free card; no caller can cause a new POST through this method.
   */
  async job(id: string, sessionId: string): Promise<ImageTrialJob> {
    await this.initialize(); await this.serial
    const row = this.rows.get(id)
    if (row === undefined || row.job.sessionId !== sessionId) throw fail('NOT_FOUND', 404)
    await this.sameOwner(row)
    if (row.job.status !== 'running') return row.job
    const active = this.active.get(id)
    if (active !== undefined) return row.job
    const work = this.reconcile(row).finally(() => { this.active.delete(id) })
    this.active.set(id, work)
    await work
    await this.sameOwner(row)
    return this.retained(id).job
  }
  private async reconcile(row: RecordRow): Promise<void> {
    const receipt = row.receipt?.status === 'succeeded' ? row.receipt
      : parseReceipt(await this.liveClient().readResearchImageTask(row.job.id, row.ownerId, this.lifetime.signal), row.job.id)
    await this.sameOwner(row)
    await this.accept(row.job.id, receipt)
    const artifact = receipt.result
    if (artifact === null) return
    if (this.gateway?.origin !== row.gatewayOrigin) throw fail('DELIVERY_UNAVAILABLE', 503)
    const bytes = await this.liveClient().readResearchImageResult(this.gateway, receipt, row.ownerId, this.lifetime.signal)
    await this.sameOwner(row)
    const dimensions = inspectImageTrialPng(bytes)
    if (bytes.length !== artifact.size_bytes || dimensions.width !== 2048 || dimensions.height !== 1152
      || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw fail('RESULT_INVALID')
    const handle = await open(join(this.directory, `${row.job.id}.png`), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    const operation = this.serial.then(async () => {
      const latest = this.retained(row.job.id)
      await this.save({ ...latest, job: { ...latest.job, status: 'completed',
        result: { bytes: bytes.length, sha256: artifact.sha256 } } })
    })
    this.serial = operation.catch(() => undefined)
    await operation
  }

  /** Read a verified retained image from the local Host, without exposing the Guangzhou token or URL.
   * @param id - Original request UUID.
   * @param sessionId - Original Session identity.
   * @returns Exact original PNG bytes after current owner and retained digest checks.
   */
  async image(id: string, sessionId: string): Promise<Buffer> {
    const job = await this.job(id, sessionId)
    if (job.status !== 'completed' || job.result === undefined) throw fail('RESULT_UNAVAILABLE', 409)
    const result = job.result
    const read = async (): Promise<Buffer> => {
      const bytes = await readPrivate(join(this.directory, `${job.id}.png`), PNG_LIMIT)
      const dimensions = inspectImageTrialPng(bytes)
      if (bytes.length !== result.bytes || dimensions.width !== job.width || dimensions.height !== job.height
        || createHash('sha256').update(bytes).digest('hex') !== result.sha256) throw fail('RESULT_INVALID')
      return bytes
    }
    let bytes: Buffer
    try { bytes = await read() }
    catch {
      // A missing/corrupt local copy permits only delivery of the saved, already completed original attempt.
      const row = this.retained(id)
      await this.sameOwner(row)
      const previous = this.active.get(id)
      if (previous !== undefined) await previous
      else {
        const work = this.reconcile(row).finally(() => { this.active.delete(id) })
        this.active.set(id, work)
        await work
      }
      bytes = await read()
    }
    await this.sameOwner(this.retained(id))
    return bytes
  }
  /** Stop owned HTTP reads and drain in-flight writes without cancelling or recreating the remote attempt. */
  async close(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.active.values()])
    await this.serial
  }
}
