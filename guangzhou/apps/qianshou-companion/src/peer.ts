/** Native outgoing device channel, persistent duplicate suppression, and local approval queue. */
import WebSocket from 'ws'
import { isTerminal, MAX_FRAME_BYTES, parseJobRequest, record, textField, type DeviceHello, type DeviceId, type JobId, type RemoteJob } from '@deepseek-ai/dsh-host-remote-devices/protocol'
import { executeJob, type JobExecutor } from './executor.ts'

export interface PeerCredential { deviceId: DeviceId; token: string }
export interface PeerState { connected: boolean; connecting: boolean; error: string | null; jobs: RemoteJob[] }
export interface PeerOptions {
  endpoint: string
  code?: string
  credential?: PeerCredential
  hello: DeviceHello
  jobs?: RemoteJob[]
  saveCredential: (credential: PeerCredential) => Promise<void>
  saveJobs: (jobs: RemoteJob[]) => Promise<void>
  changed: (state: PeerState) => void
  executor?: JobExecutor
}

/** Require TLS away from loopback; the client never disables certificate validation. */
export function deviceEndpoint(input: string): string {
  const url = new URL(input)
  if (url.username || url.password || url.search || url.hash) throw new Error('INVALID_ENDPOINT')
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol === 'https:') url.protocol = 'wss:'
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'wss:' && !(loopback && url.protocol === 'ws:')) throw new Error('TLS_REQUIRED_FOR_REMOTE')
  url.pathname = '/qianshou-device'
  return url.href
}

export class CompanionPeer {
  private socket: WebSocket | undefined
  private retry: NodeJS.Timeout | undefined
  private pulse: NodeJS.Timeout | undefined
  private stopped = false
  private credential: PeerCredential | undefined
  private attempt = 0
  private readonly active = new Map<JobId, AbortController>()
  private readonly seq = new Map<JobId, number>()
  private readonly outbox = new Map<JobId, unknown>()
  private readonly outputTimers = new Map<JobId, NodeJS.Timeout>()
  private readonly executor: JobExecutor
  private readonly state: PeerState
  private pendingMessages = 0
  private pendingSaves = 0
  private updatePaused = false
  private reconnectAfterUpdate = false

  constructor(private readonly options: PeerOptions) {
    deviceEndpoint(options.endpoint)
    this.credential = options.credential
    this.executor = options.executor ?? executeJob
    this.state = { connected: false, connecting: false, error: null, jobs: structuredClone(options.jobs ?? []) }
    for (const job of this.state.jobs) if (!isTerminal(job.status)) {
      job.status = 'interrupted'; job.error = 'COMPANION_RESTARTED'; job.updatedAt = new Date().toISOString()
      this.queueEvent(job)
    }
  }

  /** Connect or reconnect using the credential scoped to this exact coordinator. */
  connect(): void {
    if (this.updatePaused) throw new Error('UPDATE_PREPARING')
    this.stopped = false
    this.open()
  }

  /** Snapshot excludes device credentials and internal transport frames. */
  snapshot(): PeerState { return structuredClone(this.state) }

  /** Explicit local approval is the only route that calls the executor. */
  async approve(id: string): Promise<void> {
    if (this.updatePaused) throw new Error('UPDATE_PREPARING')
    const job = this.state.jobs.find(item => item.id === id)
    if (!job || job.status !== 'awaiting-approval' || !this.state.connected) throw new Error('JOB_NOT_APPROVABLE')
    if (this.active.size > 0) throw new Error('ANOTHER_JOB_RUNNING')
    const workspace = this.options.hello.workspaces.find(item => item.id === job.workspaceId)
    if (!workspace) throw new Error('WORKSPACE_NOT_APPROVED')
    const controller = new AbortController()
    this.active.set(job.id, controller)
    job.status = 'running'
    try {
      // Persist approval before execution; a storage failure must never run the job.
      await this.commit(job)
      job.result = await this.executor(job, workspace, controller.signal, (output) => {
        job.output = output
        if (!this.outputTimers.has(job.id)) this.outputTimers.set(job.id, setTimeout(() => {
          this.outputTimers.delete(job.id)
          this.queueEvent(job); this.changed()
        }, 100))
      })
      if (Buffer.byteLength(JSON.stringify({ output: job.output, result: job.result })) > MAX_FRAME_BYTES - 8192) {
        delete job.result
        throw new Error('RESULT_TOO_LARGE')
      }
      job.status = controller.signal.aborted ? 'cancelled' : 'completed'
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed'
      job.error = error instanceof Error ? error.message : 'EXECUTION_FAILED'
    } finally {
      this.active.delete(job.id)
      clearTimeout(this.outputTimers.get(job.id)); this.outputTimers.delete(job.id)
      await this.commit(job)
    }
  }

  /** A local rejection produces a terminal receipt without running anything. */
  async reject(id: string): Promise<void> {
    const job = this.state.jobs.find(item => item.id === id)
    if (!job || job.status !== 'awaiting-approval') return
    job.status = 'rejected'
    await this.commit(job)
  }

  /** Cancel the owned process group or a still-unapproved request. */
  async cancel(id: string): Promise<void> {
    const job = this.state.jobs.find(item => item.id === id)
    if (!job || isTerminal(job.status)) return
    const running = this.active.get(job.id)
    if (running) { running.abort(); return }
    job.status = 'cancelled'
    await this.commit(job)
  }

  /** Disconnecting revokes ongoing remote execution and stops automatic retries. */
  stop(): void {
    this.stopped = true
    clearTimeout(this.retry); clearInterval(this.pulse)
    for (const controller of this.active.values()) controller.abort()
    this.socket?.close(1000, 'LOCAL_DISCONNECT')
    this.state.connected = false; this.state.connecting = false
    this.changed()
  }

  /** Include not-yet-persisted messages and receipts when deciding whether a restart is safe. */
  updateBusy(): boolean {
    return this.state.connecting || this.active.size > 0 || this.pendingMessages > 0 || this.pendingSaves > 0
      || this.state.jobs.some(job => !isTerminal(job.status))
  }

  /** Fence new approvals and transport messages before disconnecting an idle peer. */
  prepareUpdate(): void {
    if (this.updatePaused) throw new Error('UPDATE_PREPARING')
    if (this.updateBusy()) throw new Error('UPDATE_BUSY')
    this.updatePaused = true
    this.reconnectAfterUpdate = this.state.connected
    this.stop()
  }

  /** Restore ordinary connections when an update attempt fails or its bounded lease expires. */
  cancelUpdate(): void {
    if (!this.updatePaused) return
    this.updatePaused = false
    if (this.reconnectAfterUpdate) { this.reconnectAfterUpdate = false; this.connect() }
  }

  private open(): void {
    if (this.stopped) return
    this.state.connecting = true; this.state.error = null; this.changed()
    const socket = new WebSocket(deviceEndpoint(this.options.endpoint), { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: 7000 })
    this.socket = socket
    let chain = Promise.resolve()
    socket.on('open', () => {
      if (this.socket !== socket || this.stopped || this.updatePaused) return
      const message = this.credential ? { type: 'auth', ...this.credential, hello: this.options.hello }
        : { type: 'pair', code: this.options.code, hello: this.options.hello }
      socket.send(JSON.stringify(message))
    })
    socket.on('message', (raw) => {
      if (this.socket !== socket || this.stopped || this.updatePaused) return
      this.pendingMessages++
      chain = chain.then(() => {
        if (this.socket !== socket || this.stopped || this.updatePaused) return
        const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
        return this.message(record(JSON.parse(bytes.toString('utf8'))))
      }).catch((error: unknown) => {
        if (this.socket !== socket) return
        this.state.error = error instanceof Error ? error.message : 'INVALID_SERVER_MESSAGE'
        socket.close(4002, 'PROTOCOL_ERROR'); this.changed()
      }).finally(() => { this.pendingMessages-- })
    })
    socket.on('error', (error) => { if (this.socket === socket) { this.state.error = error.message; this.changed() } })
    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return
      clearInterval(this.pulse)
      this.state.connected = false; this.state.connecting = false
      for (const controller of this.active.values()) controller.abort()
      if (code === 4000 || code === 4001 || code === 4002 || code === 4003) {
        this.state.error = reason.toString() || 'AUTHENTICATION_FAILED'; this.stopped = true
      }
      this.changed()
      if (!this.stopped && this.credential) {
        const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempt++, 5))
        this.retry = setTimeout(() => { this.open() }, delay)
      }
    })
  }

  private async message(message: Record<string, unknown>): Promise<void> {
    if (message.type === 'paired') {
      const credential = { deviceId: textField(message.deviceId, 100) as DeviceId, token: textField(message.token, 100) }
      await this.options.saveCredential(credential)
      this.credential = credential
      this.ready()
    } else if (message.type === 'authenticated') this.ready()
    else if (message.type === 'job') {
      const raw = record(message.job)
      const input = parseJobRequest(raw)
      const id = textField(raw.id, 100) as JobId
      const prior = this.state.jobs.find(job => job.id === id)
      if (prior) {
        this.queueEvent(prior); return
      }
      if (input.deviceId !== this.credential?.deviceId || !this.options.hello.workspaces.some(workspace => workspace.id === input.workspaceId)) throw new Error('WORKSPACE_NOT_APPROVED')
      const timestamp = new Date().toISOString()
      const job: RemoteJob = { ...input, id, status: 'awaiting-approval', createdAt: timestamp, updatedAt: timestamp, output: '' }
      this.state.jobs.push(job)
      await this.commit(job)
    } else if (message.type === 'cancel') await this.cancel(textField(message.jobId, 100))
    else if (message.type === 'ack') {
      const id = textField(message.jobId, 100) as JobId
      if (message.seq === this.seq.get(id)) this.outbox.delete(id)
    } else if (message.type !== 'heartbeat') throw new Error('INVALID_SERVER_MESSAGE')
  }

  private ready(): void {
    this.state.connected = true; this.state.connecting = false; this.state.error = null; this.attempt = 0
    for (const value of this.outbox.values()) this.send(value)
    this.pulse = setInterval(() => { this.send({ type: 'heartbeat' }) }, 10_000)
    this.pulse.unref()
    this.changed()
  }

  private queueEvent(job: RemoteJob): void {
    const seq = (this.seq.get(job.id) ?? 0) + 1
    this.seq.set(job.id, seq)
    const event = { type: 'job-event', jobId: job.id, seq, status: job.status, output: job.output, result: job.result, error: job.error }
    this.outbox.set(job.id, event)
    this.send(event)
  }

  private async commit(job: RemoteJob): Promise<void> {
    job.updatedAt = new Date().toISOString()
    this.pendingSaves++
    try { await this.options.saveJobs(this.state.jobs) }
    finally { this.pendingSaves-- }
    this.queueEvent(job)
    this.changed()
  }
  private send(value: unknown): void {
    if (this.state.connected && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value))
  }
  private changed(): void { this.options.changed(this.snapshot()) }
}
