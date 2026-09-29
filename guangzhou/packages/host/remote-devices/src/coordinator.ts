/** Device authentication, durable job receipts, and peer ownership are independent of browser sessions. */
import { WorkAdmission } from '@deepseek-ai/dsh-agent'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { isTerminal, MAX_FRAME_BYTES, MAX_OUTPUT_CHARS, parseHello, parseJobRequest, record, textField, type DeviceId, type DeviceInfo, type JobId, type JobStatus, type RemoteJob } from './protocol.ts'
import { CoordinatorStorage, type CoordinatorState } from './storage.ts'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const now = (): string => new Date().toISOString()
const statuses = new Set<JobStatus>(['awaiting-approval', 'running', 'completed', 'failed', 'rejected', 'cancelled', 'interrupted'])

/** Own paired identities, live authenticated peers and durable finite-task receipts. */
export class DeviceCoordinator {
  /** Reservations held until a new remote task is durably queued. */
  readonly admission: WorkAdmission = new WorkAdmission()

  /** Pending approvals and running tasks across all paired devices. */
  get activeCount(): number { return this.state.jobs.filter(job => !isTerminal(job.status)).length }

  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  private readonly peers = new Map<DeviceId, WebSocket>()
  private readonly pairings = new Map<string, number>()
  private readonly eventSeq = new Map<JobId, number>()
  private readonly authAttempts = new Map<string, { count: number; until: number }>()
  private readonly live = new WeakSet<WebSocket>()
  private readonly processing = new Set<Promise<void>>()
  private closing = false
  private heartbeat: NodeJS.Timeout | undefined
  private constructor(private readonly storage: CoordinatorStorage, private readonly state: CoordinatorState) {}

  /**
   * Load device identities and receipts before accepting network work.
   * @param path - Host-owned private state file.
   * @returns An initialized coordinator with no connected peers until authentication.
   * @throws If retained state cannot be read or validated.
   */
  static async open(path: string): Promise<DeviceCoordinator> {
    const storage = new CoordinatorStorage(path)
    return new DeviceCoordinator(storage, await storage.load())
  }

  /**
   * Return public metadata only; neither pairing codes nor credential digests are exposed.
   * @returns A deep clone of current devices and retained task receipts.
   */
  snapshot(): { devices: DeviceInfo[]; jobs: RemoteJob[] } {
    return structuredClone({ devices: this.state.devices.map(device => device.info), jobs: this.state.jobs })
  }

  /**
   * Mint a single-use, five-minute code for the authenticated controller UI.
   * @returns The code, expiry and native peer route; the code itself is not persisted.
   * @throws If ten unexpired pairing codes are already outstanding.
   */
  pairing(): { code: string; expiresAt: string; wsPath: string } {
    for (const [key, expiry] of this.pairings) if (expiry < Date.now()) this.pairings.delete(key)
    if (this.pairings.size >= 10) throw new Error('TOO_MANY_PAIRINGS')
    const code = randomBytes(9).toString('base64url')
    const expiry = Date.now() + 5 * 60_000
    this.pairings.set(digest(code), expiry)
    return { code, expiresAt: new Date(expiry).toISOString(), wsPath: '/qianshou-device' }
  }

  /**
   * Persist a bounded task before sending it to an online peer for local approval.
   * @param value - Untrusted finite-task request.
   * @returns The actual awaiting-approval task; acceptance does not prove execution.
   * @throws On invalid input, unavailable peer, unapproved workspace, capacity or persistence failure.
   */
  async submit(value: unknown): Promise<RemoteJob> {
    const release = this.admission.acquire()
    try { return await this.submitReserved(value) }
    finally { release() }
  }

  private async submitReserved(value: unknown): Promise<RemoteJob> {
    const request = parseJobRequest(value)
    const device = this.state.devices.find(row => row.info.id === request.deviceId)
    const peer = this.peers.get(request.deviceId)
    if (!device || !peer || peer.readyState !== WebSocket.OPEN) throw new Error('DEVICE_OFFLINE')
    if (!device.info.workspaces.some(workspace => workspace.id === request.workspaceId)) throw new Error('WORKSPACE_NOT_APPROVED')
    if (this.state.jobs.filter(job => !isTerminal(job.status)).length >= 100) throw new Error('TOO_MANY_JOBS')
    const job: RemoteJob = { ...request, id: randomUUID() as JobId, status: 'awaiting-approval', createdAt: now(), updatedAt: now(), output: '' }
    this.state.jobs.push(job)
    await this.persist()
    this.send(peer, { type: 'job', job })
    return structuredClone(job)
  }

  /**
   * Request cancellation without claiming a confirmed terminal result.
   * @param id - Existing task identity.
   * @returns Acceptance after the request is persisted, or immediately for an already terminal task.
   * @throws If the task is unknown or persistence fails.
   */
  async cancel(id: string): Promise<{ accepted: true }> {
    const job = this.state.jobs.find(row => row.id === id)
    if (!job) throw new Error('JOB_NOT_FOUND')
    if (!isTerminal(job.status)) {
      job.cancelRequested = true
      job.updatedAt = now()
      await this.persist()
      const peer = this.peers.get(job.deviceId)
      if (peer) this.send(peer, { type: 'cancel', jobId: job.id })
    }
    return { accepted: true }
  }

  /**
   * Revoke identity and interrupt unfinished receipts before closing its socket.
   * @param id - Device identity to revoke; an absent identity is harmless.
   * @returns Acceptance after the revoked state is persisted.
   * @throws If persistence fails.
   */
  async revoke(id: string): Promise<{ accepted: true }> {
    this.state.devices = this.state.devices.filter(row => row.info.id !== id)
    for (const job of this.state.jobs) if (job.deviceId === id && !isTerminal(job.status)) {
      job.status = 'interrupted'; job.error = 'DEVICE_REVOKED'; job.updatedAt = now()
    }
    await this.persist()
    this.peers.get(id as DeviceId)?.close(4003, 'DEVICE_REVOKED')
    return { accepted: true }
  }

  /**
   * Accept native peer upgrades and require authentication in the first bounded frame.
   * @param request - Incoming upgrade whose Origin and address determine eligibility.
   * @param socket - Carrier socket; rejected upgrades receive 403 and close.
   * @param head - Initial upgrade bytes supplied by the HTTP server.
   */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const address = request.socket.remoteAddress ?? 'unknown'
    const entry = this.authAttempts.get(address)
    const attempts = entry && entry.until > Date.now() ? entry : { count: 0, until: Date.now() + 60_000 }
    attempts.count++
    this.authAttempts.set(address, attempts)
    if (request.headers.origin || attempts.count > 30) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    this.server.handleUpgrade(request, socket, head, peer => { this.accept(peer) })
  }

  /** Stop transport ownership and flush the last durable metadata snapshot. */
  async close(): Promise<void> {
    this.closing = true
    clearInterval(this.heartbeat)
    for (const peer of this.server.clients) peer.terminate()
    await Promise.all(this.processing)
    await new Promise<void>(resolve => { this.server.close(() => resolve()) })
    for (const device of this.state.devices) device.info.connected = false
    await this.persist()
  }

  private accept(peer: WebSocket): void {
    let deviceId: DeviceId | undefined
    let chain = Promise.resolve()
    const deadline = setTimeout(() => { if (!deviceId) peer.close(4001, 'AUTH_REQUIRED') }, 5000)
    peer.on('error', () => { peer.terminate() })
    peer.on('pong', () => { this.live.add(peer) })
    peer.on('message', raw => {
      chain = chain.then(async () => {
        if (this.closing) return
        const message = record(JSON.parse(raw.toString()))
        if (!deviceId) {
          deviceId = await this.authenticate(peer, message)
          clearTimeout(deadline)
          this.live.add(peer)
          this.startHeartbeat()
          return
        }
        if (this.peers.get(deviceId) !== peer || !this.state.devices.some(row => row.info.id === deviceId)) throw new Error('DEVICE_REVOKED')
        if (message.type === 'heartbeat') {
          const device = this.state.devices.find(row => row.info.id === deviceId)
          if (device) device.info.lastSeen = now()
          this.send(peer, { type: 'heartbeat', at: now() })
        } else if (message.type === 'job-event') {
          await this.event(peer, deviceId, message)
        } else throw new Error('INVALID_MESSAGE')
      }).catch(() => { peer.close(4002, 'INVALID_OR_UNAUTHORIZED_MESSAGE') })
      const pending = chain
      this.processing.add(pending)
      void pending.finally(() => this.processing.delete(pending))
    })
    peer.on('close', () => {
      clearTimeout(deadline)
      if (deviceId && this.peers.get(deviceId) === peer) {
        this.peers.delete(deviceId)
        const device = this.state.devices.find(row => row.info.id === deviceId)
        if (device) { device.info.connected = false; device.info.lastSeen = now() }
        if (!this.closing) void this.persist().catch(() => { /* The next state mutation retries the private state write. */ })
      }
    })
  }

  private async authenticate(peer: WebSocket, message: Record<string, unknown>): Promise<DeviceId> {
    const hello = parseHello(message.hello)
    if (message.type === 'pair') {
      const hash = digest(textField(message.code, 100))
      const expires = this.pairings.get(hash)
      if (!expires || expires < Date.now()) throw new Error('PAIRING_EXPIRED')
      this.pairings.delete(hash)
      const token = randomBytes(32).toString('base64url')
      const id = randomUUID() as DeviceId
      const info: DeviceInfo = { ...hello, id, connected: true, lastSeen: now(), pairedAt: now() }
      this.state.devices.push({ info, tokenHash: digest(token) })
      await this.persist()
      this.peers.set(id, peer)
      this.send(peer, { type: 'paired', deviceId: id, token })
      return id
    }
    if (message.type !== 'auth') throw new Error('AUTH_REQUIRED')
    const id = textField(message.deviceId, 100) as DeviceId
    const supplied = Buffer.from(digest(textField(message.token, 100)))
    const device = this.state.devices.find(row => row.info.id === id)
    if (!device || !timingSafeEqual(Buffer.from(device.tokenHash), supplied)) throw new Error('AUTH_FAILED')
    this.peers.get(id)?.close(4000, 'CONNECTION_REPLACED')
    Object.assign(device.info, hello, { connected: true, lastSeen: now() })
    this.peers.set(id, peer)
    await this.persist()
    this.send(peer, { type: 'authenticated', deviceId: id })
    for (const job of this.state.jobs) if (job.deviceId === id && !isTerminal(job.status)) {
      // Sequence numbers belong to a connection; full snapshots make a restarted peer safe.
      this.eventSeq.delete(job.id)
      this.send(peer, { type: 'job', job })
      if (job.cancelRequested) this.send(peer, { type: 'cancel', jobId: job.id })
    }
    return id
  }

  private async event(peer: WebSocket, deviceId: DeviceId, message: Record<string, unknown>): Promise<void> {
    const job = this.state.jobs.find(row => row.id === message.jobId && row.deviceId === deviceId)
    if (!job) throw new Error('JOB_NOT_FOUND')
    const seq = message.seq
    if (!Number.isSafeInteger(seq) || (seq as number) < 1) throw new Error('INVALID_SEQUENCE')
    if ((seq as number) <= (this.eventSeq.get(job.id) ?? 0) || isTerminal(job.status)) {
      this.send(peer, { type: 'ack', jobId: job.id, seq }); return
    }
    const status = message.status as JobStatus
    if (!statuses.has(status)) throw new Error('INVALID_STATUS')
    // A cancelled/rejected request cannot become running again. Terminal receipts remain immutable.
    if (job.status === 'running' && status === 'awaiting-approval') throw new Error('INVALID_TRANSITION')
    job.status = status
    job.updatedAt = now()
    if (typeof message.output === 'string') job.output = message.output.slice(-MAX_OUTPUT_CHARS)
    if (typeof message.error === 'string') job.error = message.error.slice(0, 2000)
    if (message.result !== undefined) job.result = message.result
    this.eventSeq.set(job.id, seq as number)
    await this.persist()
    this.send(peer, { type: 'ack', jobId: job.id, seq })
  }

  private send(peer: WebSocket, message: unknown): void {
    if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(message))
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      for (const peer of this.peers.values()) {
        if (!this.live.has(peer)) { peer.terminate(); continue }
        this.live.delete(peer); peer.ping()
      }
      for (const [key, attempts] of this.authAttempts) if (attempts.until < Date.now()) this.authAttempts.delete(key)
    }, 15_000)
    this.heartbeat.unref()
  }

  private persist(): Promise<void> {
    const ended = this.state.jobs.filter(job => isTerminal(job.status))
    if (ended.length > 200) {
      const remove = new Set(ended.slice(0, ended.length - 200).map(job => job.id))
      this.state.jobs = this.state.jobs.filter(job => !remove.has(job.id))
    }
    return this.storage.save(this.state)
  }
}
