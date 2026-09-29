/**
 * Shanghai worker presence for the phone directory.
 *
 * The phone lists this computer only when the same account has an online Mac or
 * Windows worker with a fresh heartbeat. This socket sends that heartbeat and
 * stays paused: a task assignment is refused, so the window does not become a
 * compute node. The acknowledged worker id is the phone's pcId.
 */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import type { RegistrationState } from './types.ts'

const PROTOCOL = 'edgecompute.v8'
const FRAME_VERSION = '8.0'
const WORKER_FILE_VERSION = 1
const MAX_FILE_BYTES = 4096
const WORKER_ID = /^[\w-]{1,256}$/u

/** Socket subset this presence uses. Node's WebSocket satisfies it. */
export interface PresenceSocket {
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void
}

/** Deployment facts and the signed-in account this presence reports. */
export interface WorkerPresenceOptions {
  readonly accountOrigin: string
  readonly windowOrigin: string
  readonly workerIdPath: string
  readonly token: () => Promise<string | undefined>
  readonly accountId: () => string | null
  readonly os?: string
  readonly arch?: string
  readonly openSocket?: (url: string, protocol: string) => PresenceSocket
  readonly now?: () => number
}

/** Non-secret presence facts for the existing status Remote. */
export interface WorkerPresenceStatus {
  readonly workerId: string
  readonly registration: RegistrationState
  readonly registeredAt: number | null
  readonly lastHeartbeatAt: number | null
  readonly lastFailure: string | null
}

interface StoredWorker {
  readonly version: typeof WORKER_FILE_VERSION
  readonly workerId: string
  readonly accountId: string
}

/**
 * Keep one paused worker session for the signed-in account.
 * A missing token waits and retries; it never opens a socket without one.
 */
export class WorkerPresence {
  private socket: PresenceSocket | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private retry: NodeJS.Timeout | undefined
  private stopped = true
  private generation = 0
  private intervalSeconds = 15
  private workerId = ''
  private accountForWorker = ''
  private registration: RegistrationState = 'stopped'
  private registeredAt: number | null = null
  private lastHeartbeatAt: number | null = null
  private lastFailure: string | null = null
  private readonly now: () => number
  private readonly openSocket: (url: string, protocol: string) => PresenceSocket
  constructor(private readonly options: WorkerPresenceOptions) {
    this.now = options.now ?? Date.now
    this.openSocket = options.openSocket ?? ((url, protocol) => new WebSocket(url, protocol))
  }
  /** Worker id Shanghai acknowledged for this account, or empty before that. */
  id(): string { return this.workerId }
  /**
   * Non-secret diagnostics. The worker id is empty until `auth_ok`.
   * @returns Registration, heartbeat time and the last refusal code.
   */
  status(): WorkerPresenceStatus {
    return {
      workerId: this.workerId, registration: this.registration, registeredAt: this.registeredAt,
      lastHeartbeatAt: this.lastHeartbeatAt, lastFailure: this.lastFailure,
    }
  }
  /** Open or replace the session for the account currently signed in. */
  start(): void {
    this.stopped = false
    this.generation += 1
    this.closeSocket()
    void this.connect(this.generation)
  }
  /**
   * Stop heartbeats so the phone's freshness window marks this computer offline.
   * @param reason - Diagnostic label stored on the status Remote.
   */
  async stop(reason: string): Promise<void> {
    this.stopped = true
    this.generation += 1
    this.registration = reason === 'signed-out' ? 'signed-out' : 'stopped'
    this.lastFailure = null
    this.closeSocket()
  }
  private closeSocket(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined }
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined }
    const socket = this.socket
    this.socket = undefined
    socket?.close()
  }
  private schedule(generation: number): void {
    if (this.stopped || generation !== this.generation) return
    const delay = this.registration === 'registered' ? 1000 : 3000
    this.retry = setTimeout(() => { void this.connect(generation) }, delay)
    this.retry.unref()
  }
  private async connect(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return
    this.registration = 'registering'
    let token: string | undefined
    try { token = await this.options.token() } catch { token = undefined }
    const accountId = this.options.accountId()
    if (this.stopped || generation !== this.generation) return
    if (token === undefined || token.length === 0 || accountId === null) {
      this.lastFailure = 'PC_WINDOW_CREDENTIAL_UNAVAILABLE'
      this.registration = 'disconnected'
      this.schedule(generation)
      return
    }
    if (this.accountForWorker !== accountId) {
      this.workerId = ''
      this.accountForWorker = accountId
      await this.readStored(accountId)
    }
    if (this.stopped || generation !== this.generation) return
    const url = new URL('/api/v8/ws/worker', this.options.accountOrigin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: PresenceSocket
    try { socket = this.openSocket(url.href, PROTOCOL) } catch {
      this.lastFailure = 'PC_WINDOW_RELAY_UNAVAILABLE'
      this.registration = 'disconnected'
      this.schedule(generation)
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      this.send(socket, 'hello', {
        client_version: '8.0.0',
        client_build: 'qianshou-pc',
        os: this.options.os ?? process.platform,
        arch: this.options.arch ?? process.arch,
        capabilities: {
          os: this.options.os ?? process.platform,
          arch: this.options.arch ?? process.arch,
          hostname: hostname().replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 128),
          window_origin: this.options.windowOrigin,
        },
        ...(this.workerId.length > 0 ? { worker_id: this.workerId } : {}),
      })
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return
      void this.receive(socket, event.data, token, accountId, generation)
    })
    socket.addEventListener('error', () => {
      if (this.socket !== socket) return
      this.fail(generation, 'PC_WINDOW_RELAY_UNAVAILABLE')
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.fail(generation, 'PC_WINDOW_RELAY_UNAVAILABLE')
    })
  }
  private fail(generation: number, code: string): void {
    if (this.stopped || generation !== this.generation) return
    this.lastFailure = code
    this.registration = 'disconnected'
    this.closeSocket()
    this.schedule(generation)
  }
  private async receive(socket: PresenceSocket, data: string, token: string, accountId: string, generation: number): Promise<void> {
    if (Buffer.byteLength(data) > 1_048_576) { this.fail(generation, 'PC_WINDOW_RELAY_INVALID_REPLY'); return }
    let frame: unknown
    try { frame = JSON.parse(data) } catch { this.fail(generation, 'PC_WINDOW_RELAY_INVALID_REPLY'); return }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) { this.fail(generation, 'PC_WINDOW_RELAY_INVALID_REPLY'); return }
    const row = frame as Record<string, unknown>
    if (row.v !== FRAME_VERSION || row.payload === null || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
      this.fail(generation, 'PC_WINDOW_RELAY_INVALID_REPLY'); return
    }
    const payload = row.payload as Record<string, unknown>
    if (row.type === 'err') { this.fail(generation, 'PC_WINDOW_RELAY_REJECTED'); return }
    if (row.type === 'welcome') {
      const interval = payload.hb_interval_s
      if (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 1 || interval > 3600) {
        this.fail(generation, 'PC_WINDOW_RELAY_INVALID_REPLY'); return
      }
      this.intervalSeconds = interval
      this.send(socket, 'auth', { access_token: token, name: hostname().slice(0, 128) })
      return
    }
    if (row.type === 'auth_ok') {
      const workerId = payload.worker_id
      if (typeof workerId !== 'string' || !WORKER_ID.test(workerId) || String(payload.owner_id) !== accountId) {
        this.stopped = true
        this.lastFailure = 'PC_WINDOW_OWNER_CHANGED'
        this.registration = 'disconnected'
        this.closeSocket()
        return
      }
      try { await this.writeStored(workerId, accountId) } catch {
        this.fail(generation, 'PC_WINDOW_STORAGE_FAILED'); return
      }
      if (this.stopped || generation !== this.generation || this.socket !== socket) return
      this.workerId = workerId
      this.accountForWorker = accountId
      this.registration = 'registered'
      this.registeredAt ??= this.now()
      this.lastFailure = null
      this.beat(socket)
      if (this.heartbeat) clearInterval(this.heartbeat)
      this.heartbeat = setInterval(() => { if (this.socket === socket) this.beat(socket) }, this.intervalSeconds * 1000)
      this.heartbeat.unref()
      return
    }
    if (row.type === 'hb_ack') { this.lastHeartbeatAt = this.now(); return }
    if (row.type === 'shard_assign') { this.refuse(socket, payload); return }
  }
  /** A paused window does not run assigned work. The refusal keeps the session up. */
  private refuse(socket: PresenceSocket, payload: Record<string, unknown>): void {
    const shardId = payload.shard_id
    const workloadId = payload.workload_id
    const attempt = payload.attempt
    const lease = payload.lease_token
    if (typeof shardId !== 'string' || typeof workloadId !== 'string' || typeof lease !== 'string'
      || typeof attempt !== 'number') return
    this.send(socket, 'shard_result', {
      shard_id: shardId, workload_id: workloadId, worker_id: this.workerId, attempt, lease_token: lease,
      ok: false, error: 'EDGE_SUPPLY_WITHDRAWN: local supply policy is paused', failure_class: 'EDGE_SUPPLY_WITHDRAWN',
    })
  }
  private beat(socket: PresenceSocket): void {
    this.send(socket, 'hb', { load: 0, active_shards: 0, mode: 'paused', throttle_pct: 0 })
    this.lastHeartbeatAt = this.now()
  }
  private send(socket: PresenceSocket, type: string, payload: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ v: FRAME_VERSION, type, payload }))
  }
  private async readStored(accountId: string): Promise<void> {
    let text: string
    try { text = await readFile(this.options.workerIdPath, 'utf8') } catch { return }
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) return
    let value: unknown
    try { value = JSON.parse(text) } catch { return }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    const row = value as Partial<StoredWorker>
    if (row.version !== WORKER_FILE_VERSION || row.accountId !== accountId || typeof row.workerId !== 'string' || !WORKER_ID.test(row.workerId)) return
    this.workerId = row.workerId
  }
  private async writeStored(workerId: string, accountId: string): Promise<void> {
    const path = this.options.workerIdPath
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
    const content = JSON.stringify({ version: WORKER_FILE_VERSION, workerId, accountId } satisfies StoredWorker)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
