/** Separate R6 cursor and durable original execution. No formal profile, price or automatic POST replay. */
import { createHash } from 'node:crypto'
import { canonical, exact, failure, integer, parseTask, type ResearchLease, type ResearchTask } from './research-contract.ts'
import { ResearchStore, type ResearchEvent, type ResearchLocalRecord } from './research-store.ts'
/** Receipt from the private fixed-workflow API, never a caller-selected graph. */
export interface ResearchPilotJob {
  readonly requestId: string
  readonly workflowId: string
  readonly status: 'unknown' | 'running' | 'delivery_pending' | 'succeeded' | 'failed'
  readonly externalJobId: string
  readonly result?: { readonly sha256: string; readonly sizeBytes: number; readonly contentType: 'image/png'; readonly width: number; readonly height: number }
}
/** Host-private original execution and GET-only result operations. */
export interface ResearchPilot {
  submit(request: { requestId: string; workflowId: string; prompt: string }, signal: AbortSignal): Promise<ResearchPilotJob>
  get(requestId: string, signal: AbortSignal): Promise<ResearchPilotJob>
  result(requestId: string, signal: AbortSignal): Promise<Buffer>
}
/** Current device operations keep the channel bearer inside the transport owner. */
export interface ResearchSession {
  readonly accountId: number
  readonly deviceId: string
  readonly connectionEpoch: number
  post(path: 'research/channel' | 'research/claim' | 'research/events' | 'research/task-status', body: unknown, signal: AbortSignal): Promise<unknown>
  upload(tuple: { taskId: string; attemptId: string; leaseEpoch: 1 }, sha256: string, bytes: Buffer, signal: AbortSignal): Promise<unknown>
}
/** Validated storage limits and current-owner admission hooks. */
export interface ResearchConsumerOptions {
  readonly directory: string
  readonly waitMs: number
  readonly maximumRecords: number
  readonly session: () => Promise<ResearchSession | null>
  /** The current real wrapper and metadata identity; execute rechecks idle/voice/resources/Comfy queue. */
  readonly pilot: (lease: ResearchLease, action: 'execute' | 'recover') => Promise<ResearchPilot | null>
  /** Serialize the new submission with local formal/trial occupancy; authorize only this original attempt. */
  readonly admission: <T>(lease: ResearchLease, operation: () => Promise<T>) => Promise<T>
  readonly occupancyChanged: () => void
}
const terminal = (task: ResearchTask): boolean => ['completed', 'failed', 'cancelled'].includes(task.stage)
/** Own one journal and serialize irreversible claim, generation and upload sends. */
export class ResearchConsumer {
  private active: Promise<void> | undefined
  private closed = false
  private constructor(private readonly options: ResearchConsumerOptions, private readonly store: ResearchStore) {}
  /** Restore durable originals before accepting a new research inbox cycle. */
  static async open(options: ResearchConsumerOptions): Promise<ResearchConsumer> {
    if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 0 || options.waitMs > 25000) failure('RESEARCH_CONFIG_INVALID')
    return new ResearchConsumer(options, await ResearchStore.open(options.directory, options.maximumRecords))
  }
  /** Protect real original execution, optionally excluding the attempt inside its sole admission transaction. */
  busy(exceptAttempt?: string): boolean { return this.store.busy(exceptAttempt) }
  /** Current-owner originals retain GET/delivery rights after intake is paused or revoked. */
  draining(accountId: number, deviceId?: string): boolean { return this.store.active().some(row => row.submitIssued
    && row.lease.accountId === accountId && (deviceId === undefined || row.lease.deviceId === deviceId)) }
  private async current(captured: ResearchSession, lease?: ResearchLease): Promise<void> {
    const now = await this.options.session()
    if (this.closed || now === null || now.accountId !== captured.accountId || now.deviceId !== captured.deviceId
      || now.connectionEpoch !== captured.connectionEpoch || lease !== undefined && (lease.accountId !== now.accountId || lease.deviceId !== now.deviceId)) failure('RESEARCH_SCOPE_CHANGED')
  }
  private tuple(lease: ResearchLease): { taskId: string; attemptId: string; leaseEpoch: 1 } {
    return { taskId: lease.taskId, attemptId: lease.attemptId, leaseEpoch: 1 }
  }
  private original(attemptId: string): ResearchLocalRecord {
    const row = this.store.get(attemptId)
    if (row === undefined) failure('RESEARCH_STORE_INVALID')
    return row
  }
  private same(task: ResearchTask, lease: ResearchLease): ResearchTask {
    if (canonical(task.lease) !== canonical(lease)) failure('RESEARCH_ORIGINAL_CONFLICT')
    return task
  }
  private async status(session: ResearchSession, lease: ResearchLease, signal: AbortSignal): Promise<ResearchTask> {
    await this.current(session, lease)
    const reply = exact(await session.post('research/task-status', this.tuple(lease), signal), ['ok', 'task'])
    if (reply.ok !== true) failure('RESEARCH_RESPONSE_INVALID')
    await this.current(session, lease)
    return this.same(parseTask(reply.task), lease)
  }
  private apply(task: ResearchTask): ResearchLocalRecord {
    let local = this.store.get(task.lease.attemptId); if (local === undefined) failure('RESEARCH_STORE_INVALID')
    if (local.backendJobId !== null && task.backendJobId !== null && local.backendJobId !== task.backendJobId) failure('RESEARCH_ORIGINAL_CONFLICT')
    const patch: { -readonly [Key in keyof Omit<ResearchLocalRecord, 'lease'>]?: ResearchLocalRecord[Key] } = { eventCounter: Math.max(local.eventCounter, task.eventSequence) }
    if (task.backendJobId !== null) patch.backendJobId = task.backendJobId
    if (local.event !== null && task.eventSequence >= local.event.sequence) {
      if (task.eventSequence === local.event.sequence && (task.stage !== local.event.stage || task.backendJobId !== local.event.backendJobId)) failure('RESEARCH_ORIGINAL_CONFLICT')
      patch.event = null
    }
    if (task.stage === 'completed') {
      if (task.artifact === null || local.result !== null
        && (task.artifact.sha256 !== local.result.sha256 || task.artifact.size_bytes !== local.result.sizeBytes)) failure('RESEARCH_ORIGINAL_CONFLICT')
      patch.result = { sha256: task.artifact.sha256, sizeBytes: task.artifact.size_bytes }
      patch.state = 'completed'; patch.event = null
    } else if (task.stage === 'failed' || task.stage === 'cancelled') { patch.state = task.stage; patch.event = null }
    local = this.store.update(task.lease.attemptId, patch); this.options.occupancyChanged(); return local
  }
  private async pending(session: ResearchSession, lease: ResearchLease, signal: AbortSignal): Promise<boolean> {
    const event = this.store.get(lease.attemptId)?.event
    if (event === null || event === undefined) return true
    try {
      await this.current(session, lease)
      const reply = exact(await session.post('research/events', { ...this.tuple(lease), ...event }, signal),
        ['ok', 'taskId', 'attemptId', 'sequence', 'duplicate'])
      if (reply.ok !== true || reply.taskId !== lease.taskId || reply.attemptId !== lease.attemptId || reply.sequence !== event.sequence
        || typeof reply.duplicate !== 'boolean') failure('RESEARCH_RESPONSE_INVALID')
      await this.current(session, lease); this.store.update(lease.attemptId, { event: null }); return true
    } catch { this.store.update(lease.attemptId, { state: 'unknown' }); return false }
  }
  private async event(session: ResearchSession, lease: ResearchLease, stage: ResearchEvent['stage'], backendJobId: string | null,
    signal: AbortSignal): Promise<boolean> {
    if (!await this.pending(session, lease, signal)) return false
    const local = this.store.get(lease.attemptId); if (local === undefined) failure('RESEARCH_STORE_INVALID')
    const event = { sequence: local.eventCounter + 1, stage, backendJobId }
    this.store.update(lease.attemptId, { event, eventCounter: event.sequence })
    return this.pending(session, lease, signal)
  }
  private async consume(session: ResearchSession, task: ResearchTask, signal: AbortSignal): Promise<void> {
    const lease = task.lease; await this.current(session, lease)
    let local = this.store.accept(lease); this.options.occupancyChanged()
    if (terminal(task)) { this.apply(task); return }
    if (local.claimIssued || task.submission === 'claimed') {
      try { task = await this.status(session, lease, signal); local = this.apply(task) } catch { return }
      if (terminal(task)) return
    }
    if (!local.claimIssued && task.submission === 'not_claimed') {
      if (task.expired || Date.parse(lease.leaseExpiresAt) <= Date.now() || lease.connectionEpoch !== session.connectionEpoch) {
        await this.event(session, lease, 'cancelled', null, signal); return
      }
      if (this.store.active().some(other => other.lease.attemptId !== lease.attemptId && (other.submitIssued
        || other.lease.accountId === session.accountId && other.lease.deviceId === session.deviceId))) return
      const pilot = await this.options.pilot(lease, 'execute'); if (pilot === null) return
      await this.current(session, lease)
      // No next turn/process may issue another claim, even when this ACK is unknown.
      this.store.update(lease.attemptId, { claimIssued: true })
      try {
        const reply = exact(await session.post('research/claim', this.tuple(lease), signal), ['ok', 'duplicate', 'task'])
        if (reply.ok !== true || typeof reply.duplicate !== 'boolean') failure('RESEARCH_RESPONSE_INVALID')
        task = this.same(parseTask(reply.task), lease)
        if (task.submission !== 'claimed') failure('RESEARCH_RESPONSE_INVALID')
        await this.current(session, lease)
        local = this.store.update(lease.attemptId, { claimGranted: !reply.duplicate, state: reply.duplicate ? 'unknown' : 'active' })
      } catch { this.store.update(lease.attemptId, { state: 'unknown' }); return }
    }
    local = this.original(lease.attemptId)
    if (local.claimGranted && !local.submitIssued && Date.parse(lease.leaseExpiresAt) <= Date.now()) {
      await this.event(session, lease, 'failed', null, signal); this.apply(await this.status(session, lease, signal)); return
    }
    if (local.claimGranted && !local.submitIssued && lease.connectionEpoch === session.connectionEpoch
      && Date.parse(lease.leaseExpiresAt) > Date.now()) {
      await this.options.admission(lease, async () => {
        const pilot = await this.options.pilot(lease, 'execute'); if (pilot === null) return
        await this.current(session, lease)
        const row = this.original(lease.attemptId); if (row.submitIssued) return
        // A crash at any point below permits only the original runtime GET, never another submit.
        this.store.update(lease.attemptId, { submitIssued: true }); this.options.occupancyChanged()
        try {
          const job = await pilot.submit({ requestId: lease.attemptId, workflowId: lease.workflowId, prompt: lease.input.prompt }, signal)
          await this.current(session, lease)
          if (job.requestId !== lease.attemptId || job.workflowId !== lease.workflowId) failure('RESEARCH_ORIGINAL_CONFLICT')
          this.store.update(lease.attemptId, { backendJobId: job.externalJobId })
        } catch { this.store.update(lease.attemptId, { state: 'unknown' }) }
      })
    }
    local = this.original(lease.attemptId)
    if (!local.submitIssued) return // A duplicate/unknown claim is never a fresh GPU permission.
    if (local.uploadIssued) {
      try { this.apply(await this.status(session, lease, signal)) } catch { /* Unknown upload remains query-only. */ }
      return
    }
    const pilot = await this.options.pilot(lease, 'recover'); if (pilot === null) return
    let job: ResearchPilotJob
    try { job = await pilot.get(lease.attemptId, signal); await this.current(session, lease) } catch { return }
    if (job.requestId !== lease.attemptId || job.workflowId !== lease.workflowId
      || local.backendJobId !== null && local.backendJobId !== job.externalJobId) failure('RESEARCH_ORIGINAL_CONFLICT')
    this.store.update(lease.attemptId, { backendJobId: job.externalJobId })
    if (job.status === 'unknown' || job.status === 'running') {
      await this.event(session, lease, job.status === 'unknown' ? 'outcome_unknown' : 'running', job.externalJobId, signal); return
    }
    if (job.status === 'failed') { await this.event(session, lease, 'failed', job.externalJobId, signal); return }
    if (job.status !== 'succeeded') return
    const bytes = await pilot.result(lease.attemptId, signal); await this.current(session, lease)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (job.result === undefined || bytes.length < 1 || bytes.length > 67108864 || sha256 !== job.result.sha256
      || bytes.length !== job.result.sizeBytes
      || job.result.width !== 2048 || job.result.height !== 1152) failure('RESEARCH_ORIGINAL_CONFLICT')
    this.store.update(lease.attemptId, { result: { sha256, sizeBytes: bytes.length } })
    const eventApplied = await this.event(session, lease, 'uploading', job.externalJobId, signal)
    if (!eventApplied) {
      try { task = await this.status(session, lease, signal); this.apply(task) } catch { return }
      if (task.stage !== 'uploading' || task.backendJobId !== job.externalJobId) return
    }
    await this.current(session, lease)
    this.store.update(lease.attemptId, { uploadIssued: true })
    try {
      const reply = exact(await session.upload(this.tuple(lease), sha256, bytes, signal), ['ok', 'duplicate', 'task'])
      if (reply.ok !== true || typeof reply.duplicate !== 'boolean') failure('RESEARCH_RESPONSE_INVALID')
      await this.current(session, lease); this.apply(this.same(parseTask(reply.task), lease))
    } catch { this.store.update(lease.attemptId, { state: 'unknown' }) }
  }
  /** Consume one independent inbox cycle; concurrent triggers join the same original work. */
  tick(signal: AbortSignal): Promise<void> {
    if (this.active !== undefined) return this.active
    const work = (async () => {
      if (this.closed || signal.aborted) return
      const session = await this.options.session(); if (session === null) return
      await this.current(session)
      const reply = exact(await session.post('research/channel', { afterSequence: this.store.cursor(session.deviceId), waitMs: this.options.waitMs }, signal),
        ['ok', 'deviceId', 'connectionEpoch', 'sequence', 'hasMore', 'tasks'])
      await this.current(session)
      if (reply.ok !== true || reply.deviceId !== session.deviceId || reply.connectionEpoch !== session.connectionEpoch
        || typeof reply.hasMore !== 'boolean' || !Array.isArray(reply.tasks) || reply.tasks.length > 17) failure('RESEARCH_RESPONSE_INVALID')
      const tasks = reply.tasks.map(parseTask)
      const sequence = integer(reply.sequence)
      if (sequence < this.store.cursor(session.deviceId) || tasks.some(task => task.sequence > sequence)
        || new Set(tasks.map(task => task.lease.attemptId)).size !== tasks.length) failure('RESEARCH_RESPONSE_INVALID')
      // Completed tasks leave the inbox; a lost upload ACK must still reconcile the original journal.
      for (const local of this.store.active()) {
        if (local.lease.accountId !== session.accountId || local.lease.deviceId !== session.deviceId
          || tasks.some(task => task.lease.attemptId === local.lease.attemptId)) continue
        let original: ResearchTask
        try { original = await this.status(session, local.lease, signal) } catch { continue }
        await this.consume(session, original, signal)
      }
      for (const task of tasks) { await this.consume(session, task, signal); signal.throwIfAborted() }
      this.store.advance(session.deviceId, sequence)
    })()
    this.active = work
    void work.finally(() => { if (this.active === work) this.active = undefined }).catch(() => undefined)
    return work
  }
  /** Stop inbox work and await it before closing the original-attempt journal. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true; await this.active?.catch(() => undefined); this.store.close()
  }
}
