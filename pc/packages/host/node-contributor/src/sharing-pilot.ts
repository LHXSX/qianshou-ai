/** Private built-in Comfy API lifecycle; no model download, subprocess or paid qualification. */
import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { localMediaOrigin } from './local-media-discovery.ts'
import type { SharingAPIObservation } from './sharing-types.ts'
import { SHARING_UUID, sharingFail, sharingObject } from './sharing-protocol.ts'
import { sharingDirectory, sharingRead, sharingWrite } from './sharing-store.ts'

/** Current-owner connection, new execution and original output recovery are distinct permissions. */
export type SharingPilotAction = 'connect' | 'execute' | 'recover'
/** Host-owned storage and validated deployment choices; addresses never reach the renderer. */
export interface SharingPilotOptions {
  readonly directory: string
  readonly comfyOrigin: string
  /** The previous configured source for journals created before source binding was persisted. */
  readonly legacyComfyOrigin?: string
  readonly timeoutMs: number
  readonly maximumResultBytes: number
  /** Adopt only an existing private journal; never create a listener or new submission right. */
  readonly recoveryOnly?: boolean
  readonly authorize: (action: SharingPilotAction) => Promise<boolean>
}
/** Immutable research input; it never accepts an arbitrary graph or paid parameters. */
export interface SharingPilotRequest {
  readonly requestId: string
  readonly workflowId: string
  readonly prompt: string
}
/** Mechanically validated bytes of the original fixed-workflow result. */
export interface SharingPilotResult {
  readonly sha256: string
  readonly sizeBytes: number
  readonly contentType: 'image/png'
  readonly width: 2048
  readonly height: 1152
}
/** Original execution receipt; unknown submissions stay bound to their original UUID. */
export interface SharingPilotJob {
  readonly schema: 'qianshou.comfy-pilot-job.v1'
  readonly requestId: string
  readonly workflowId: string
  readonly status: 'unknown' | 'running' | 'delivery_pending' | 'succeeded' | 'failed'
  readonly externalJobId: string
  readonly errorCode: string | null
  readonly commercial: false
  readonly result?: SharingPilotResult
}
interface PilotHandle {
  readonly health: () => Promise<unknown>
  readonly busy: () => boolean
  readonly submit: (request: SharingPilotRequest) => Promise<unknown>
  readonly get: (requestId: string) => Promise<unknown>
  readonly result: (requestId: string) => Promise<unknown>
  readonly close: () => Promise<void>
}
interface PilotLibrary {
  readonly createComfyPilot: (options: {
    directory: string
    comfyOrigin: string
    ownerScopeId: string
    token: string
    port: number
    timeoutMs: number
    maximumResultBytes: number
    recoveryOnly?: boolean
    authorize: (scope: string, action: SharingPilotAction) => Promise<boolean>
  }) => Promise<PilotHandle>
}
interface PilotIdentity { readonly ownerScopeId: string; readonly token: string }
const WORKFLOW_SHA = '154f7d6133fe0276e7cefc97a17ea2bde1febe397f3963bd0ea8be8c624ee7be'
const WORKFLOW_ID = 'comfy-pilot-image-' + WORKFLOW_SHA.slice(0, 16)
function job(value: unknown, requestId: string, maximumResultBytes: number): SharingPilotJob {
  const row = sharingObject(value)
  const required = ['commercial', 'errorCode', 'externalJobId', 'requestId', 'schema', 'status', 'workflowId']
  if (Object.keys(row).sort().join(',') !== [...required, ...('result' in row ? ['result'] : [])].sort().join(',')
    || row.schema !== 'qianshou.comfy-pilot-job.v1' || row.requestId !== requestId || row.workflowId !== WORKFLOW_ID
    || row.commercial !== false || typeof row.externalJobId !== 'string' || !SHARING_UUID.test(row.externalJobId)
    || typeof row.status !== 'string' || !['unknown', 'running', 'delivery_pending', 'succeeded', 'failed'].includes(row.status)
    || row.errorCode !== null && (typeof row.errorCode !== 'string' || !/^PILOT_[A-Z_]{1,64}$/u.test(row.errorCode))) sharingFail('RESPONSE_INVALID')
  let result: SharingPilotResult | undefined
  if ('result' in row) {
    const media = sharingObject(row.result)
    if (Object.keys(media).sort().join(',') !== 'contentType,height,sha256,sizeBytes,width'
      || typeof media.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(media.sha256)
      || typeof media.sizeBytes !== 'number' || !Number.isSafeInteger(media.sizeBytes) || media.sizeBytes < 1
      || media.sizeBytes > maximumResultBytes || media.contentType !== 'image/png' || media.width !== 2048
      || media.height !== 1152) sharingFail('RESPONSE_INVALID')
    result = { sha256: media.sha256, sizeBytes: media.sizeBytes, contentType: 'image/png', width: 2048, height: 1152 }
  }
  if (row.status === 'succeeded' && result === undefined) sharingFail('RESPONSE_INVALID')
  return { schema: 'qianshou.comfy-pilot-job.v1', requestId, workflowId: WORKFLOW_ID,
    status: row.status as SharingPilotJob['status'], externalJobId: row.externalJobId,
    errorCode: row.errorCode, commercial: false, ...(result === undefined ? {} : { result }) }
}
async function identity(directory: string, existingOnly = false): Promise<PilotIdentity> {
  const path = join(directory, 'identity.json')
  try {
    const value = sharingObject(JSON.parse((await sharingRead(path, 1024)).toString('utf8')) as unknown)
    if (Object.keys(value).sort().join(',') !== 'ownerScopeId,schema,token' || value.schema !== 'qianshou.comfy-pilot-owner.v1'
      || typeof value.ownerScopeId !== 'string' || !SHARING_UUID.test(value.ownerScopeId)
      || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.token)) sharingFail('STORE_INVALID')
    return { ownerScopeId: value.ownerScopeId, token: value.token }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (existingOnly) sharingFail('STORE_INVALID')
  }
  const value = { schema: 'qianshou.comfy-pilot-owner.v1', ownerScopeId: randomUUID(), token: randomBytes(32).toString('base64url') }
  let file: FileHandle
  try { file = await open(path, 'wx', 0o600) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return identity(directory) }
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() } finally { await file.close() }
  if (process.platform !== 'win32') {
    const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await parent.sync() } finally { await parent.close() }
  }
  return { ownerScopeId: value.ownerScopeId, token: value.token }
}
interface PilotOriginPlan { readonly origin: string; readonly persist: boolean; readonly legacyActive: boolean }
async function pendingOriginalJobs(directory: string): Promise<boolean> {
  const path = join(directory, 'pilot-jobs.sqlite')
  const stat = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (stat === null) return false
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) sharingFail('STORE_INVALID')
  if (stat.size === 0) return false
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get()
    if (table === undefined) return false
    const row = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status NOT IN ('succeeded','failed')").get()
    if (typeof row?.count !== 'number') sharingFail('STORE_INVALID')
    return row.count > 0
  } catch { sharingFail('STORE_INVALID') }
  finally { db?.close() }
}
async function boundOrigin(directory: string, selected: string, legacy: string,
  recoveryOnly: boolean): Promise<PilotOriginPlan> {
  const selectedOrigin = localMediaOrigin(selected), legacyOrigin = localMediaOrigin(legacy)
  const path = join(directory, 'source.json')
  const read = async (): Promise<string> => {
    const value = sharingObject(JSON.parse((await sharingRead(path, 1024)).toString('utf8')) as unknown)
    if (Object.keys(value).sort().join(',') !== 'comfyOrigin,schema' || value.schema !== 'qianshou.comfy-pilot-source.v1'
      || typeof value.comfyOrigin !== 'string') sharingFail('STORE_INVALID')
    return localMediaOrigin(value.comfyOrigin)
  }
  let saved: string | null
  try { saved = await read() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // An older journal has no source record. Keep its configured service for original GET-only recovery.
    saved = null
  }
  if (recoveryOnly) return { origin: saved ?? legacyOrigin, persist: false, legacyActive: false }
  const active = saved !== selectedOrigin && await pendingOriginalJobs(directory)
  if (active && (saved !== null || selectedOrigin !== legacyOrigin)) sharingFail('RUNTIME_UNAVAILABLE')
  return { origin: selectedOrigin, persist: saved !== selectedOrigin, legacyActive: active }
}
async function persistOrigin(directory: string, origin: string, legacyActive: boolean): Promise<void> {
  const path = join(directory, 'source.json')
  // Recheck after the graph was verified: a second process may have admitted an original job meanwhile.
  if (await pendingOriginalJobs(directory) && !legacyActive) {
    try {
      const value = sharingObject(JSON.parse((await sharingRead(path, 1024)).toString('utf8')) as unknown)
      if (value.comfyOrigin !== origin) sharingFail('RUNTIME_UNAVAILABLE')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      sharingFail('RUNTIME_UNAVAILABLE')
    }
  }
  await sharingWrite(path, Buffer.from(JSON.stringify({ schema: 'qianshou.comfy-pilot-source.v1',
    comfyOrigin: origin }) + '\n'))
}
/** Own one automatically created private Node API without changing existing Comfy or Qwen services. */
export class SharingPilot {
  private closed = false
  private constructor(private readonly handle: PilotHandle, private readonly authorize: SharingPilotOptions['authorize'],
    private readonly maximumResultBytes: number, readonly comfyOrigin: string) {}
  private unavailable(signal: AbortSignal): boolean { return this.closed || signal.aborted }
  private async guard(action: SharingPilotAction, signal: AbortSignal): Promise<void> {
    if (this.unavailable(signal) || !await this.authorize(action)) sharingFail('OWNER_CHANGED')
    if (this.unavailable(signal)) sharingFail('OWNER_CHANGED')
  }
  /** Match the fixed Qwen recipe through real GETs and persist one owner-private runtime identity.
   * @param options - Validated Host inputs and current-owner permission checks.
   * @returns The live private API after authorization is checked again; failures leave no listener.
   */
  static async open(options: SharingPilotOptions): Promise<SharingPilot> {
    const action = options.recoveryOnly ? 'recover' : 'connect'
    if (!await options.authorize(action)) sharingFail('OWNER_CHANGED')
    if (!options.recoveryOnly) await sharingDirectory(options.directory)
    const saved = await identity(options.directory, options.recoveryOnly)
    const plan = await boundOrigin(options.directory, options.comfyOrigin,
      options.legacyComfyOrigin ?? options.comfyOrigin, options.recoveryOnly ?? false)
    const imported: unknown = await import(new URL('../runtime/comfy-pilot/comfy-pilot.mjs', import.meta.url).href)
    if (typeof sharingObject(imported).createComfyPilot !== 'function') sharingFail('RUNTIME_UNAVAILABLE')
    const library = imported as PilotLibrary
    const handle = await library.createComfyPilot({ directory: options.directory, comfyOrigin: plan.origin,
      ownerScopeId: saved.ownerScopeId, token: saved.token, port: 0, timeoutMs: options.timeoutMs,
      maximumResultBytes: options.maximumResultBytes, recoveryOnly: options.recoveryOnly ?? false,
      authorize: async (scope, action) => scope === saved.ownerScopeId && await options.authorize(action) })
    try {
      if (!await options.authorize(action)) sharingFail('OWNER_CHANGED')
      if (plan.persist) await persistOrigin(options.directory, plan.origin, plan.legacyActive)
    }
    catch (error) { await handle.close(); throw error }
    return new SharingPilot(handle, options.authorize, options.maximumResultBytes, plan.origin)
  }
  /** Recheck the existing private API and its real Comfy dependencies without GPU or new authorization.
   * @param signal - Current-owner/lifecycle cancellation.
   * @returns Only safe actual model/workflow metadata; no token, local address or filename.
   */
  async observe(signal: AbortSignal): Promise<SharingAPIObservation> {
    await this.guard('connect', signal)
    const health = sharingObject(await this.handle.health())
    await this.guard('connect', signal)
    const descriptor = sharingObject(health.descriptor), model = sharingObject(descriptor.model)
    const workflow = sharingObject(descriptor.workflow)
    if (health.schema !== 'qianshou.comfy-pilot.v1' || health.status !== 'ok' || health.commercial !== false
      || descriptor.mode !== 'image' || descriptor.commercial !== false || model.id !== 'qwen-image-2.1-int8-convrot'
      || model.sha256 !== null || model.version !== '2.1' || workflow.id !== 'comfy-pilot-image-' + WORKFLOW_SHA.slice(0, 16)
      || workflow.sha256 !== WORKFLOW_SHA || workflow.version !== '1') sharingFail('RESPONSE_INVALID')
    return { mode: 'image', adapter: 'comfyui', status: 'ready',
      model: { id: 'qwen-image-2.1-int8-convrot', sha256: null, version: '2.1' },
      workflow: { id: 'comfy-pilot-image-' + WORKFLOW_SHA.slice(0, 16), sha256: WORKFLOW_SHA, version: '1' },
      observedAt: new Date().toISOString() }
  }
  /** Preserve the stable attempt UUID before the sole GPU POST; a repeated call only reads its saved receipt.
   * @param request - Original immutable request bound to the active research lease.
   * @param signal - Current-owner/lifecycle cancellation.
   * @returns Original task receipt; an unknown outcome never grants another submission.
   */
  async submit(request: SharingPilotRequest, signal: AbortSignal): Promise<SharingPilotJob> {
    await this.guard('connect', signal)
    const value = await this.handle.submit(request)
    await this.guard('connect', signal)
    return job(value, request.requestId, this.maximumResultBytes)
  }
  /** Recover only the saved original backend job through GET, including a delivery interruption.
   * @param requestId - The immutable original attempt UUID.
   * @param signal - Current-owner/lifecycle cancellation.
   * @returns Original task receipt without submitting another graph.
   */
  async get(requestId: string, signal: AbortSignal): Promise<SharingPilotJob> {
    await this.guard('recover', signal)
    const value = await this.handle.get(requestId)
    await this.guard('recover', signal)
    return job(value, requestId, this.maximumResultBytes)
  }
  /** Read verified original PNG bytes for the fixed Guangzhou research upload operation.
   * @param requestId - The immutable original attempt UUID.
   * @param signal - Current-owner/lifecycle cancellation.
   * @returns Private original bytes; no local path, origin or Bearer reaches the caller.
   */
  async result(requestId: string, signal: AbortSignal): Promise<Buffer> {
    await this.guard('recover', signal)
    const value = await this.handle.result(requestId)
    await this.guard('recover', signal)
    if (!Buffer.isBuffer(value) || value.length < 1 || value.length > this.maximumResultBytes) sharingFail('RESPONSE_INVALID')
    return value
  }
  /** Inspect original SQLite work only; no health request, graph submission or task mutation. */
  async updateBusy(signal: AbortSignal): Promise<boolean> {
    await this.guard('recover', signal)
    const busy = this.handle.busy()
    await this.guard('recover', signal)
    return busy
  }
  /** Stop only this private API and await requests; upstream Comfy and original work remain untouched.
   * @returns Completion when this library has no listener or database handle.
   */
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.handle.close() }
}
