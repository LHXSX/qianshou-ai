/** Durable outbound Guangzhou node session. It owns no executor, price or ledger. */
import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { UUID, HASH } from './research-contract.ts'
import type { SharingAPIProbe, SharingNodeSession } from './sharing-types.ts'
import { parseSharingAPIProbe } from './sharing-api-observations.ts'
import { NodeContributorError } from './errors.ts'

/** Independently verified workflow reference; discovery alone cannot populate this list. */
export interface MediaNodeCapability {
  readonly profile_id: string
  readonly profile_version: number
  readonly model_sha256: string
  readonly workflow_sha256: string
  readonly validation_receipt_sha256: string
}
/** Resource facts from current owner policy and measurements; zero slots pauses future dispatch. */
export interface MediaNodeHeartbeat {
  readonly freeSlots: number
  readonly runningAttemptIds: readonly string[]
  readonly freeVramMb: number
  readonly availableSeconds: number
}
/** One received task is still untrusted until its existing executor validates the Shanghai lease. */
export interface MediaNodeDelivery {
  readonly sequence: number
  readonly taskId: string
  readonly attemptId: string
  readonly leaseEpoch: number
  readonly leaseExpiresAt: string
  readonly quoteId: string
  readonly authorizationId: string
  readonly expired: boolean
  readonly envelope: Readonly<Record<string, unknown>>
}
/** Browser-safe session projection excludes private credentials and task inputs. */
export interface MediaNodeChannelStatus {
  readonly state: 'idle' | 'connecting' | 'connected' | 'offline' | 'closed'
  readonly deviceId: string | null
  readonly connectionEpoch: number
  readonly sequence: number
  readonly errorCode: string | null
  /** True only for a live authenticated epoch, never inferred from the saved identity. */
  readonly authorized: boolean
  /** Local milliseconds after Guangzhou accepts this epoch's heartbeat; null before that response. */
  readonly heartbeatAt: number | null
  /** Null before withdrawal, true only after Guangzhou confirms offline, false after an unconfirmed attempt. */
  readonly withdrawalConfirmed: boolean | null
}
/** Host-owned identity, policy and durable admission callbacks. */
export interface MediaNodeChannelOptions {
  readonly origin: string
  readonly directory: string
  readonly ownerId: string
  readonly adapterVersion: string
  readonly capabilityRevision: string
  readonly capabilities: readonly MediaNodeCapability[]
  readonly maxConcurrency: number
  readonly requestTimeoutMs: number
  readonly waitMs: number
  readonly maxResponseBytes: number
  readonly readAccessToken: () => Promise<string | undefined>
  readonly assertOwner: () => Promise<void>
  readonly readHeartbeat: () => Promise<MediaNodeHeartbeat>
  /** Commit admission to the existing durable attempt store before returning; rejection leaves cursor unchanged. */
  readonly onTask: (delivery: MediaNodeDelivery, signal: AbortSignal, session: SharingNodeSession) => Promise<void>
  /** Read-only local metadata challenge; it is not a leased GPU task. */
  readonly onApiProbe?: (probe: SharingAPIProbe, signal: AbortSignal, session: SharingNodeSession) => Promise<void>
}
interface Saved {
  schema: 'qianshou.media-node-session.v1'
  origin: string
  ownerId: string
  deviceId: string
  deviceToken: string
  capabilityRevision: string
  connectionEpoch: number
  sequence: number
}
function fail(code: string): never { throw new NodeContributorError(`MEDIA_NODE_${code}`) }
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('RESPONSE_INVALID')
  return value as Record<string, unknown>
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('RESPONSE_INVALID')
  return value
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) fail('RESPONSE_INVALID')
  return value
}

/** Validate the configured TLS endpoint or an explicit local integration server.
 * @param value - Operator-controlled origin without path, credential or query.
 * @returns Normalized HTTP origin; external cleartext is refused.
 */
export function mediaNodeOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { fail('ORIGIN_INVALID') }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.pathname !== '/' || url.username || url.password || url.search || url.hash) fail('ORIGIN_INVALID')
  return url.origin
}

async function savePrivate(path: string, saved: Saved): Promise<void> {
  const temp = path + '.' + randomUUID() + '.tmp'
  const file = await open(temp, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(saved) + '\n'); await file.sync() }
  finally { await file.close() }
  try {
    await rename(temp, path)
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), constants.O_RDONLY)
      try { await directory.sync() } finally { await directory.close() }
    }
  }
  catch (error) { await rm(temp, { force: true }); throw error }
}

/** A single outbound session with a persisted credential before the first registration POST. */
export class MediaNodeChannel {
  private readonly origin: string
  private saved: Saved | undefined
  private controller: AbortController | undefined
  private active: Promise<void> | undefined
  private heartbeatIntervalMs = 0
  private nextHeartbeatAt = 0
  private withdrawnEpoch = 0
  private joinedEpoch = 0
  private identityEpoch = 0
  private last: MediaNodeChannelStatus = { state: 'idle', deviceId: null, connectionEpoch: 0, sequence: 0,
    errorCode: null, withdrawalConfirmed: null, authorized: false, heartbeatAt: null }

  constructor(private readonly options: MediaNodeChannelOptions) {
    this.origin = mediaNodeOrigin(options.origin)
    if (!isAbsolute(options.directory) || !/^[1-9][0-9]*$/u.test(options.ownerId)
      || !Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > 64
      || !Number.isSafeInteger(options.waitMs) || options.waitMs < 1 || options.waitMs > 25000
      || !Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < options.waitMs + 1000
      || options.requestTimeoutMs > 60000) fail('CONFIG_INVALID')
    if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 262144
      || options.maxResponseBytes > 17 * 1024 * 1024) fail('CONFIG_INVALID')
  }

  /** Read only the redacted session state.
   * @returns Current connection observation; it is not workflow readiness.
   */
  status(): MediaNodeChannelStatus { return { ...this.last } }

  /** Persist a stable private device identity without enrollment or advertising capacity.
   * @returns Current redacted identity, used for purpose-bound installation challenges.
   */
  async prepare(): Promise<MediaNodeChannelStatus> {
    await this.options.assertOwner(); await this.load(); this.project(this.last.state); return this.status()
  }

  /** Keep the device bearer private while exposing only fixed original-attempt operations.
   * @returns Host-only operation capability; it does not permit registration or arbitrary routes.
   */
  session(): SharingNodeSession {
    const saved = this.saved
    if (saved === undefined) fail('OWNER_UNAVAILABLE')
    return { deviceId: saved.deviceId, connectionEpoch: saved.connectionEpoch,
      post: async (path, body, signal) => {
        await this.options.assertOwner()
        const current = this.saved
        if (current === undefined || current.connectionEpoch < 1 || current.deviceId !== saved.deviceId) fail('EPOCH_STALE')
        if (!['events', 'media/result-ticket', 'media/result-status', 'media/input-ticket',
          'media/order-current', 'media/task-status', 'api-observations', 'api-probe-result',
          'research/channel', 'research/claim', 'research/events', 'research/task-status', 'research/execution', 'device-info'].includes(path)) fail('REQUEST_INVALID')
        if ((path === 'api-observations' || path === 'api-probe-result' || path === 'device-info'
          || path.startsWith('research/')) && current.connectionEpoch !== saved.connectionEpoch) fail('EPOCH_STALE')
        const response = await this.post(path, current.deviceToken,
          { ...body, deviceId: current.deviceId, connectionEpoch: current.connectionEpoch }, signal)
        await this.options.assertOwner()
        if ((path.startsWith('research/') || path === 'device-info') && this.saved?.connectionEpoch !== saved.connectionEpoch) fail('EPOCH_STALE')
        return response
      },
      uploadResearch: async (tuple, sha256, bytes, signal) => {
        await this.options.assertOwner()
        const current = this.saved
        if (current === undefined || current.deviceId !== saved.deviceId || current.connectionEpoch !== saved.connectionEpoch
          || current.connectionEpoch < 1) fail('EPOCH_STALE')
        if (!UUID.test(tuple.taskId) || !UUID.test(tuple.attemptId) || !HASH.test(sha256)
          || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 67108864) fail('REQUEST_INVALID')
        const response = await fetch(this.origin + '/v1/nodes/research/results/upload', { method: 'POST', redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
          headers: { Authorization: 'Bearer ' + current.deviceToken, 'Content-Type': 'image/png', 'Content-Length': String(bytes.length),
            'x-qianshou-device-id': current.deviceId, 'x-qianshou-connection-epoch': String(current.connectionEpoch),
            'x-qianshou-task-id': tuple.taskId, 'x-qianshou-attempt-id': tuple.attemptId, 'x-qianshou-lease-epoch': '1',
            'x-qianshou-sha256': sha256 }, body: new Uint8Array(bytes) })
        const result = await this.readResponse(response)
        await this.options.assertOwner()
        if (this.saved?.connectionEpoch !== saved.connectionEpoch) fail('EPOCH_STALE')
        return result
      },
    }
  }

  private project(state: MediaNodeChannelStatus['state'], errorCode: string | null = null): void {
    this.last = { state, errorCode, withdrawalConfirmed: this.last.withdrawalConfirmed, deviceId: this.saved?.deviceId ?? null,
      connectionEpoch: this.saved?.connectionEpoch ?? 0, sequence: this.saved?.sequence ?? 0,
      authorized: state === 'connected' && this.last.authorized,
      heartbeatAt: state === 'connected' ? this.last.heartbeatAt : null }
  }

  private async load(): Promise<void> {
    if (this.saved !== undefined) return
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.options.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STORE_INVALID')
    await chmod(this.options.directory, 0o700)
    const path = join(this.options.directory, 'session.json')
    let file
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('STORE_INVALID') }
    if (file !== undefined) {
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 8192) fail('STORE_INVALID')
        const value = row(JSON.parse((await file.readFile()).toString('utf8')) as unknown)
        if (value.schema !== 'qianshou.media-node-session.v1' || value.ownerId !== this.options.ownerId
          || value.origin !== this.origin || typeof value.deviceToken !== 'string' || !/^[a-f0-9]{64}$/u.test(value.deviceToken)
          || typeof value.capabilityRevision !== 'string') fail('STORE_INVALID')
        this.saved = { schema: 'qianshou.media-node-session.v1', origin: this.origin, ownerId: this.options.ownerId,
          deviceId: token(value.deviceId), deviceToken: value.deviceToken, capabilityRevision: value.capabilityRevision,
          connectionEpoch: integer(value.connectionEpoch), sequence: integer(value.sequence) }
      } catch { fail('STORE_INVALID') }
      finally { await file.close() }
    } else {
      const saved: Saved = { schema: 'qianshou.media-node-session.v1', origin: this.origin, ownerId: this.options.ownerId,
        deviceId: randomUUID(), deviceToken: randomBytes(32).toString('hex'),
        capabilityRevision: this.options.capabilityRevision, connectionEpoch: 0, sequence: 0 }
      await savePrivate(path, saved)
      this.saved = saved
    }
  }

  private async post(path: string, credential: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetch(this.origin + '/v1/nodes/' + path, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
      headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return this.readResponse(response)
  }

  private async readResponse(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok) { await response.body?.cancel(); fail(response.status === 401 || response.status === 403 ? 'AUTH_REJECTED' : 'REQUEST_FAILED') }
    const reader = response.body?.getReader()
    if (reader === undefined) fail('RESPONSE_INVALID')
    let length = 0
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.length
        if (length > this.options.maxResponseBytes) fail('RESPONSE_TOO_LARGE')
        chunks.push(next.value)
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    try { return row(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) }
    catch { fail('RESPONSE_INVALID') }
  }

  private async persist(next: Saved): Promise<void> {
    await savePrivate(join(this.options.directory, 'session.json'), next)
    this.saved = next
  }

  private async withdraw(): Promise<void> {
    const saved = this.saved
    if (saved === undefined || saved.connectionEpoch === 0 || saved.connectionEpoch !== this.joinedEpoch
      || saved.connectionEpoch === this.withdrawnEpoch) return
    try {
      const reply = await this.post('disconnect', saved.deviceToken,
        { deviceId: saved.deviceId, connectionEpoch: saved.connectionEpoch }, AbortSignal.timeout(5000))
      if (reply.ok !== true || reply.online !== false) fail('RESPONSE_INVALID')
      this.withdrawnEpoch = saved.connectionEpoch
      this.last = { ...this.last, withdrawalConfirmed: true }
    } catch {
      // Losing the device credential or network cannot justify a local claim that remote supply was withdrawn.
      this.last = { ...this.last, withdrawalConfirmed: false,
        errorCode: this.last.errorCode ?? 'MEDIA_NODE_WITHDRAWAL_UNCONFIRMED' }
    }
  }

  private async handshake(signal: AbortSignal): Promise<void> {
    await this.options.assertOwner(); await this.load()
    const saved = this.saved as Saved
    const changed = saved.capabilityRevision !== this.options.capabilityRevision
    const register = saved.connectionEpoch === 0 || changed
    const credential = register ? await this.options.readAccessToken() : saved.deviceToken
    if (credential === undefined || credential === '') fail('OWNER_UNAVAILABLE')
    await this.options.assertOwner()
    const reply = await this.post(register ? 'register' : 'reconnect', credential,
      register ? { deviceId: saved.deviceId, deviceToken: saved.deviceToken, adapterVersion: this.options.adapterVersion,
        capabilityRevision: this.options.capabilityRevision, capabilities: this.options.capabilities,
        maxConcurrency: this.options.maxConcurrency }
        : { deviceId: saved.deviceId, capabilityRevision: saved.capabilityRevision }, signal)
    await this.options.assertOwner()
    if (reply.deviceId !== saved.deviceId || register && reply.deviceToken !== saved.deviceToken
      || integer(reply.connectionEpoch) < 1 || !register && Number(reply.connectionEpoch) <= saved.connectionEpoch) fail('RESPONSE_INVALID')
    token(reply.connectionId)
    const interval = integer(reply.heartbeatIntervalMs)
    if (interval < 100 || interval > 60000 || integer(reply.heartbeatTimeoutMs) <= interval) fail('RESPONSE_INVALID')
    await this.persist({ ...saved, capabilityRevision: this.options.capabilityRevision, connectionEpoch: Number(reply.connectionEpoch) })
    this.joinedEpoch = Number(reply.connectionEpoch)
    this.last = { ...this.last, authorized: true, heartbeatAt: null }
    if (reply.connectionEpoch !== saved.connectionEpoch) this.last = { ...this.last, withdrawalConfirmed: null }
    this.heartbeatIntervalMs = interval; this.nextHeartbeatAt = 0
    // A reconnect reads the retained inbox before advertising any free slot.
    await this.poll(signal, 0, true)
    this.project('connected')
  }

  private async refreshAccountIdentity(captured: Saved, signal: AbortSignal): Promise<void> {
    await this.options.assertOwner()
    const credential = await this.options.readAccessToken()
    await this.options.assertOwner()
    if (!credential || this.saved?.connectionEpoch !== captured.connectionEpoch) return
    const reply = await this.post('account-identity', credential, { deviceId: captured.deviceId }, signal)
    await this.options.assertOwner()
    if (reply.ok !== true || reply.deviceId !== captured.deviceId || this.saved.connectionEpoch !== captured.connectionEpoch) fail('RESPONSE_INVALID')
  }

  private async heartbeat(signal: AbortSignal): Promise<void> {
    const saved = this.saved as Saved
    await this.options.assertOwner()
    const facts = await this.options.readHeartbeat()
    await this.options.assertOwner()
    if (!Number.isSafeInteger(facts.freeSlots) || facts.freeSlots < 0 || facts.freeSlots > this.options.maxConcurrency
      || !Number.isSafeInteger(facts.freeVramMb) || facts.freeVramMb < 0
      || !Number.isSafeInteger(facts.availableSeconds) || facts.availableSeconds < 0
      || facts.runningAttemptIds.length > this.options.maxConcurrency) fail('HEARTBEAT_INVALID')
    const reply = await this.post('heartbeat', saved.deviceToken, { deviceId: saved.deviceId,
      connectionEpoch: saved.connectionEpoch, capabilityRevision: saved.capabilityRevision, ...facts }, signal)
    await this.options.assertOwner()
    if (reply.connectionEpoch !== saved.connectionEpoch) fail('EPOCH_STALE')
    this.last = { ...this.last, heartbeatAt: Date.now() }
    this.nextHeartbeatAt = Date.now() + this.heartbeatIntervalMs
    if (this.identityEpoch !== saved.connectionEpoch) {
      this.identityEpoch = saved.connectionEpoch
      // Optional trusted-name projection cannot precede or block the original accepted heartbeat.
      void this.refreshAccountIdentity(saved, signal).catch(() => undefined)
    }
  }

  private async poll(signal: AbortSignal, waitMs: number, recovering = false): Promise<void> {
    const saved = this.saved as Saved
    await this.options.assertOwner()
    const reply = await this.post('channel', saved.deviceToken, { deviceId: saved.deviceId,
      connectionEpoch: saved.connectionEpoch, afterSequence: saved.sequence, waitMs }, signal)
    await this.options.assertOwner()
    if (reply.connectionEpoch !== saved.connectionEpoch || !Array.isArray(reply.tasks) || reply.tasks.length > 128) fail('RESPONSE_INVALID')
    let previous = 0
    for (const value of reply.tasks) {
      const task = row(value)
      if (task.deviceId !== saved.deviceId || typeof task.leaseExpiresAt !== 'string'
        || !Number.isFinite(Date.parse(task.leaseExpiresAt)) || typeof task.expired !== 'boolean') fail('RESPONSE_INVALID')
      const delivery: MediaNodeDelivery = { sequence: integer(task.sequence), taskId: token(task.taskId),
        attemptId: token(task.attemptId), leaseEpoch: integer(task.leaseEpoch), leaseExpiresAt: task.leaseExpiresAt,
        quoteId: token(task.quoteId), authorizationId: token(task.authorizationId), expired: task.expired, envelope: row(task.envelope) }
      if ((!recovering && delivery.sequence <= (this.saved as Saved).sequence)
        || delivery.sequence <= previous || delivery.leaseEpoch < 1) fail('RESPONSE_INVALID')
      previous = delivery.sequence
      await this.options.assertOwner()
      await this.options.onTask(delivery, signal, this.session())
      await this.options.assertOwner()
      if (delivery.sequence > (this.saved as Saved).sequence) await this.persist({ ...(this.saved as Saved), sequence: delivery.sequence })
    }
    if (reply.apiProbes !== undefined) {
      if (!Array.isArray(reply.apiProbes) || reply.apiProbes.length > 2) fail('RESPONSE_INVALID')
      for (const value of reply.apiProbes) {
        const probe = parseSharingAPIProbe(value, saved.connectionEpoch)
        if (Date.parse(probe.expiresAt) <= Date.now()) continue
        await this.options.assertOwner(); await this.options.onApiProbe?.(probe, signal, this.session()); await this.options.assertOwner()
      }
    }
    this.project('connected')
  }

  /** Open one configured session; callers own reconnect backoff after rejection.
   * @returns Completion when the session closes or fails, with status retained for diagnosis.
   */
  run(): Promise<void> {
    if (this.last.state === 'closed') return Promise.reject(new NodeContributorError('MEDIA_NODE_CLOSED'))
    if (this.active !== undefined) return this.active
    const controller = new AbortController(); this.controller = controller
    this.project('connecting')
    this.active = (async () => {
      try {
        await this.handshake(controller.signal)
        while (!controller.signal.aborted) {
          if (Date.now() >= this.nextHeartbeatAt) await this.heartbeat(controller.signal)
          const waitMs = Math.min(this.options.waitMs, Math.max(0, this.nextHeartbeatAt - Date.now()))
          await this.poll(controller.signal, waitMs)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.project('offline', error instanceof NodeContributorError ? error.code : 'MEDIA_NODE_UNAVAILABLE')
          throw error
        }
      } finally { await this.withdraw(); this.active = undefined; this.controller = undefined }
    })()
    return this.active
  }

  /** Stop polling and await the in-flight callback; no remote task is declared cancelled.
   * @returns Completion once callbacks have drained.
   */
  async close(): Promise<void> {
    this.controller?.abort()
    await this.active?.catch(() => undefined)
    await this.withdraw()
    this.project('closed', this.last.errorCode)
  }
}
