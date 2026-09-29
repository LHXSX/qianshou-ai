/** Real Edge WebSocket protocol for an explicitly isolated loopback/SSH test environment. */
import { record, SupplyError } from '../supply/policy.ts'
import { safeOrigin } from '../supply/http.ts'
import type { EdgeInlineResult, EdgeResultSent, EdgeTaskIdentity, EdgeTaskOffer, EdgeWorkerEvent, EdgeWorkerPort } from './types.ts'

/** Composition supplies measured capabilities and explicit task scope; no cloud settings are inferred. */
export interface EdgeWorkerOptions {
  readonly origin: string
  readonly tokenProvider: () => string | undefined
  readonly expectedOwnerId: number
  /** Previously acknowledged worker identity, if the Host is reconnecting its own registered node. */
  readonly workerId?: string
  readonly name: string
  readonly clientBuild: string
  readonly os: string
  readonly arch: string
  readonly capabilities: Readonly<Record<string, unknown>>
  readonly allowedTaskTypes: readonly string[]
  readonly handshakeTimeoutMs: number
  readonly maxFrameBytes: number
  readonly maxOutputBytes: number
  readonly readLoad: () => number
  readonly onOffer: (offer: EdgeTaskOffer, signal: AbortSignal) => Promise<void>
  readonly onEvent: (event: EdgeWorkerEvent) => void
}

/** No script download/execution or local lease minting occurs in this transport. */
export class EdgeWorkerConnection implements EdgeWorkerPort {
  #leases = new Map<string, { identity: EdgeTaskIdentity; token: string }>()
  #seen = new Set<string>()
  private readonly origin: URL
  private readonly lifetime = new AbortController()
  private socket: WebSocket | undefined
  private stage: 'new' | 'welcome' | 'auth' | 'ready' | 'closed' = 'new'
  private workerId = ''
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private deadline: ReturnType<typeof setTimeout> | undefined
  private mode: 'running' | 'paused' = 'paused'
  private intervalSeconds = 0
  private resolveConnect: (() => void) | undefined
  private rejectConnect: ((error: Error) => void) | undefined
  private callbacks = new Set<Promise<void>>()
  private closeReason = 'EDGE_CLOSED'

  /** Bind only literal loopback origins; the tunnel and isolated server identity remain deployment-owned.
   * @param options - Trusted isolated endpoint, measured hardware and Host execution callbacks.
   */
  constructor(private readonly options: EdgeWorkerOptions) {
    this.origin = safeOrigin(options.origin, true)
    if (!Number.isSafeInteger(options.handshakeTimeoutMs) || options.handshakeTimeoutMs < 1
      || !Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 1
      || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1
      || !Number.isSafeInteger(options.expectedOwnerId) || options.expectedOwnerId < 1
      || !options.allowedTaskTypes.length) throw new SupplyError('EDGE_WORKER_CONFIG_INVALID')
  }

  /** Establish hello/auth using the real protocol; initial heartbeat is paused.
   * @param signal - Abort the connection and all task callbacks when cancelled.
   * @returns Completion after owner authentication and the initial heartbeat send.
   */
  connect(signal?: AbortSignal): Promise<void> {
    if (this.stage !== 'new') return Promise.reject(new SupplyError('EDGE_CONNECTION_ALREADY_USED'))
    if (signal?.aborted) return Promise.reject(new SupplyError('EDGE_ABORTED'))
    let token: string | undefined
    try { token = this.options.tokenProvider() } catch { /* Provider error details stay private. */ }
    if (!token) return Promise.reject(new SupplyError('EDGE_AUTH_REQUIRED'))
    const socketUrl = new URL('/api/v8/ws/worker', this.origin)
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    this.stage = 'welcome'
    const promise = new Promise<void>((resolve, reject) => { this.resolveConnect = resolve; this.rejectConnect = reject })
    this.deadline = setTimeout(() => this.fail('EDGE_HANDSHAKE_TIMEOUT'), this.options.handshakeTimeoutMs)
    signal?.addEventListener('abort', () => this.fail('EDGE_ABORTED'), { once: true, signal: this.lifetime.signal })
    this.socket = new WebSocket(socketUrl, 'edgecompute.v8')
    this.socket.addEventListener('open', () => {
      if (this.lifetime.signal.aborted) return
      this.send('hello', { client_version: '8.0.0', client_build: this.options.clientBuild,
        os: this.options.os, arch: this.options.arch, capabilities: this.options.capabilities,
        ...(this.options.workerId ? { worker_id: this.options.workerId } : {}) })
    })
    this.socket.addEventListener('message', event => {
      try { this.receive(event.data, token!) }
      catch { this.fail('EDGE_PROTOCOL_INVALID') }
    })
    this.socket.addEventListener('error', () => this.fail('EDGE_CONNECTION_FAILED'))
    this.socket.addEventListener('close', () => this.fail('EDGE_CONNECTION_CLOSED'))
    return promise
  }

  /** Change the real heartbeat mode after Host policy grants or withdraws future supply.
   * @param mode - Whether future task assignment is locally allowed or paused.
   */
  updateMode(mode: 'running' | 'paused'): void { this.assertReady(); this.mode = mode; this.sendHeartbeat() }

  /** Send bounded progress with the exact stored server lease and authenticated identity tuple.
   * @param identity - Exact identity tuple received in the task offer.
   * @param fraction - Finite task progress between zero and one.
   */
  reportProgress(identity: EdgeTaskIdentity, fraction: number): void {
    const lease = this.lease(identity)
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new SupplyError('EDGE_PROGRESS_INVALID')
    this.send('shard_progress', { shard_id: identity.shardId, attempt: identity.attempt, lease_token: lease.token, pct: fraction })
  }

  /** Submit the existing raw inline result form; query the core separately for actual acceptance.
   * @param identity - Exact identity tuple received in the task offer.
   * @param result - Raw UTF-8 text result and measured execution duration.
   * @returns A local send receipt that does not establish server acceptance.
   */
  complete(identity: EdgeTaskIdentity, result: EdgeInlineResult): EdgeResultSent {
    const lease = this.lease(identity)
    if (typeof result.inlineOutputUtf8 !== 'string' || Buffer.byteLength(result.inlineOutputUtf8) > this.options.maxOutputBytes
      || !Number.isSafeInteger(result.elapsedMs) || result.elapsedMs < 0) throw new SupplyError('EDGE_RESULT_INVALID')
    this.send('shard_result', { shard_id: identity.shardId, workload_id: identity.workloadId, worker_id: identity.workerId,
      attempt: identity.attempt, lease_token: lease.token, ok: true, inline_output: result.inlineOutputUtf8, elapsed_ms: result.elapsedMs })
    this.#leases.delete(key(identity))
    return { state: 'sent-awaiting-verification' }
  }

  /** Stop networking and abort/drain Host callbacks that honor their connection AbortSignal.
   * @returns Completion after all active Host callbacks settle.
   */
  async close(): Promise<void> {
    this.fail('EDGE_CLOSED')
    await Promise.allSettled([...this.callbacks])
  }

  private receive(data: unknown, token: string): void {
    if (typeof data !== 'string' || Buffer.byteLength(data) > this.options.maxFrameBytes) throw new Error('invalid frame size')
    const frame: unknown = JSON.parse(data)
    if (!record(frame) || frame.v !== '8.0' || !record(frame.payload)) throw new Error('invalid frame')
    const payload = frame.payload
    if (frame.type === 'err') { this.fail('EDGE_SERVER_REJECTED'); return }
    if (this.stage === 'welcome') {
      if (frame.type !== 'welcome' || !integer(payload.hb_interval_s, 1) || payload.hb_interval_s > 3600) throw new Error('invalid welcome')
      this.intervalSeconds = payload.hb_interval_s; this.stage = 'auth'
      this.send('auth', { access_token: token, name: this.options.name }); return
    }
    if (this.stage === 'auth') {
      if (frame.type !== 'auth_ok' || !identifier(payload.worker_id) || payload.owner_id !== this.options.expectedOwnerId) throw new Error('identity mismatch')
      this.workerId = payload.worker_id; this.stage = 'ready'; clearTimeout(this.deadline)
      this.options.onEvent({ type: 'authenticated', workerId: this.workerId, ownerId: this.options.expectedOwnerId })
      this.sendHeartbeat()
      if (this.lifetime.signal.aborted) return
      this.heartbeat = setInterval(() => this.sendHeartbeat(), this.intervalSeconds * 1000)
      this.resolveConnect?.(); return
    }
    if (this.stage !== 'ready') return
    if (frame.type === 'hb_ack') { this.options.onEvent({ type: 'heartbeat-acknowledged' }); return }
    if (frame.type === 'shard_cancel') { this.fail('EDGE_CANCEL_RECONCILIATION_REQUIRED'); return }
    if (frame.type !== 'shard_assign') throw new Error('unsupported frame')
    const offer = parseOffer(payload, this.workerId)
    if (!this.options.allowedTaskTypes.includes(offer.taskType)) { this.fail('EDGE_TASK_SCOPE_DENIED'); return }
    if (this.mode !== 'running') { this.fail('EDGE_SUPPLY_WITHDRAWN'); return }
    const leaseKey = key(offer)
    if (this.#seen.has(leaseKey)) {
      const active = this.#leases.get(leaseKey)
      if (active) active.token = payload.lease_token as string
      return // One callback per delivered tuple, including after a result was sent.
    }
    for (const lease of this.#leases.values()) {
      if (lease.identity.shardId === offer.shardId) { this.fail('EDGE_ATTEMPT_RECONCILIATION_REQUIRED'); return }
    }
    this.#seen.add(leaseKey); this.#leases.set(leaseKey, { identity: offer, token: payload.lease_token as string })
    const callback = Promise.resolve().then(() => {
      this.lifetime.signal.throwIfAborted()
      return this.options.onOffer(offer, this.lifetime.signal)
    })
      .catch(() => this.fail('EDGE_EXECUTION_CALLBACK_FAILED'))
    this.callbacks.add(callback); void callback.finally(() => this.callbacks.delete(callback))
  }

  private sendHeartbeat(): void {
    if (this.stage !== 'ready') return
    try { this.send('hb', { load: this.options.readLoad(), active_shards: this.#leases.size, mode: this.mode,
      throttle_pct: this.mode === 'running' ? 100 : 0 }) }
    catch { this.fail('EDGE_HEARTBEAT_FAILED') }
  }
  private send(type: string, payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new SupplyError('EDGE_NOT_CONNECTED')
    this.socket.send(JSON.stringify({ v: '8.0', type, payload }))
  }
  private lease(identity: EdgeTaskIdentity) {
    this.assertReady()
    const lease = this.#leases.get(key(identity))
    if (!lease) throw new SupplyError('EDGE_LEASE_NOT_ACTIVE')
    return lease
  }
  private assertReady(): void { if (this.stage !== 'ready') throw new SupplyError(this.closeReason) }
  private fail(reason: string): void {
    if (this.stage === 'closed') return
    this.stage = 'closed'; this.closeReason = reason; clearTimeout(this.deadline); clearInterval(this.heartbeat)
    this.lifetime.abort(); this.#leases.clear(); this.#seen.clear(); this.socket?.close()
    this.rejectConnect?.(new SupplyError(reason)); this.options.onEvent({ type: 'closed', reason })
  }
}

function parseOffer(value: Record<string, unknown>, workerId: string): EdgeTaskOffer {
  if (!identifier(value.workload_id) || !identifier(value.shard_id) || !integer(value.attempt, 0)
    || !text(value.task_type) || !text(value.runtime) || !text(value.input_kind)
    || !(value.inline_input === null || typeof value.inline_input === 'string') || typeof value.input_ref !== 'string'
    || !Array.isArray(value.input_refs) || !value.input_refs.every(item => typeof item === 'string')
    || typeof value.code_url !== 'string' || typeof value.code_sha256 !== 'string' || !integer(value.timeout_s, 1)
    || !['semantic', 'artifact', 'quarantine'].includes(String(value.verification_policy))
    || typeof value.execution_model !== 'string' || typeof value.capability !== 'string' || typeof value.capability_version !== 'string'
    || !text(value.lease_token)) throw new Error('invalid assignment')
  return Object.freeze({ workerId, workloadId: value.workload_id, shardId: value.shard_id, attempt: value.attempt,
    taskType: value.task_type, runtime: value.runtime, inputKind: value.input_kind, inlineInput: value.inline_input,
    inputRef: value.input_ref, inputRefs: Object.freeze([...value.input_refs]), codeUrl: value.code_url, codeSha256: value.code_sha256,
    timeoutSeconds: value.timeout_s, verificationPolicy: value.verification_policy as EdgeTaskOffer['verificationPolicy'],
    executionModel: value.execution_model, capability: value.capability, capabilityVersion: value.capability_version })
}
function key(value: EdgeTaskIdentity): string { return JSON.stringify([value.workerId, value.workloadId, value.shardId, value.attempt]) }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[\w-]{1,256}$/.test(value) }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function integer(value: unknown, minimum: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum }
