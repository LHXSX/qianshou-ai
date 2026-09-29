/**
 * Versioned, provider-neutral bridge between an autonomous agent and a
 * dispatch service. It owns control metadata only; a deployment supplies the
 * authenticated transport and any node-side media transfer adapter.
 */
import type { ComputeApiClient, ComputeApiRecord } from '@deepseek-ai/dsh-host-compute-api'
import type { NodeConnectRequest, NodeHeartbeatMessage, NodeTaskOfferMessage, NodeTaskProgressMessage, NodeTaskReturnMessage } from '@deepseek-ai/dsh-compute-core'

export const SCHEDULING_CONTROL_VERSION = 'qianshou.scheduler.control.v1' as const
export type SchedulingClientStatus = 'DISCONNECTED' | 'CONNECTING' | 'READY' | 'CLOSED'

export type SchedulingControlFrame =
  | { version: typeof SCHEDULING_CONTROL_VERSION; type: 'node.heartbeat'; message: NodeHeartbeatMessage }
  | { version: typeof SCHEDULING_CONTROL_VERSION; type: 'task.accept'; taskId: string; attempt: number; leaseId: string; idempotencyKey: string }
  | { version: typeof SCHEDULING_CONTROL_VERSION; type: 'task.reject'; taskId: string; attempt: number; leaseId: string; idempotencyKey: string; reason: string }
  | { version: typeof SCHEDULING_CONTROL_VERSION; type: 'task.progress'; message: NodeTaskProgressMessage }
  | { version: typeof SCHEDULING_CONTROL_VERSION; type: 'task.result'; message: NodeTaskReturnMessage }

export interface SchedulingRevokeNotice { version: typeof SCHEDULING_CONTROL_VERSION; type: 'task.revoke'; taskId: string; attempt: number; leaseId: string; reason: string }

export interface SchedulingSession {
  send(frame: SchedulingControlFrame): Promise<void>
  onOffer(handler: (offer: NodeTaskOfferMessage) => void | Promise<void>): () => void
  onRevoke(handler: (notice: SchedulingRevokeNotice) => void | Promise<void>): () => void
  close(reason?: string): Promise<void>
}

/** Deployment owns TLS, token exchange, endpoint allow-list and reconnect policy. */
export interface SchedulingTransport { connect(request: NodeConnectRequest, signal?: AbortSignal): Promise<SchedulingSession> }

export interface SchedulingClientOptions { transport: SchedulingTransport; api?: ComputeApiClient }

export class SchedulingClient {
  private readonly transport: SchedulingTransport
  private readonly api: ComputeApiClient | undefined
  private session: SchedulingSession | undefined
  private statusValue: SchedulingClientStatus = 'DISCONNECTED'
  private readonly decisions = new Map<string, string>()
  constructor(options: SchedulingClientOptions) {
    if (typeof options.transport.connect !== 'function') throw new Error('SCHEDULING_TRANSPORT_INVALID')
    this.transport = options.transport
    this.api = options.api
  }
  status(): SchedulingClientStatus { return this.statusValue }
  async connect(request: NodeConnectRequest, signal?: AbortSignal): Promise<void> {
    if (this.statusValue === 'CLOSED') throw new Error('SCHEDULING_CLIENT_CLOSED')
    if (this.session) throw new Error('SCHEDULING_CLIENT_ALREADY_CONNECTED')
    this.statusValue = 'CONNECTING'
    try { this.session = await this.transport.connect(request, signal); this.statusValue = 'READY' }
    catch (error) { this.statusValue = 'DISCONNECTED'; throw error }
  }
  onTaskOffer(handler: (offer: NodeTaskOfferMessage) => void | Promise<void>): () => void { return this.require().onOffer(handler) }
  onTaskRevoke(handler: (notice: SchedulingRevokeNotice) => void | Promise<void>): () => void { return this.require().onRevoke(handler) }
  async heartbeat(message: NodeHeartbeatMessage): Promise<void> { await this.send({ version: SCHEDULING_CONTROL_VERSION, type: 'node.heartbeat', message }) }
  async accept(taskId: string, attempt: number, leaseId: string, idempotencyKey: string): Promise<void> { await this.decide('task.accept', taskId, attempt, leaseId, idempotencyKey) }
  async reject(taskId: string, attempt: number, leaseId: string, idempotencyKey: string, reason: string): Promise<void> {
    if (reason.length < 1 || reason.length > 256) throw new Error('SCHEDULING_REASON_INVALID')
    await this.decide('task.reject', taskId, attempt, leaseId, idempotencyKey, reason)
  }
  async progress(message: NodeTaskProgressMessage): Promise<void> { await this.send({ version: SCHEDULING_CONTROL_VERSION, type: 'task.progress', message }) }
  async result(message: NodeTaskReturnMessage): Promise<void> { await this.send({ version: SCHEDULING_CONTROL_VERSION, type: 'task.result', message }) }
  async readCatalogue(): Promise<{ identity: ComputeApiRecord; taskTypes: ComputeApiRecord; workloads: readonly ComputeApiRecord[] }> {
    if (!this.api) throw new Error('SCHEDULING_API_UNAVAILABLE')
    const [identity, taskTypes, workloads] = await Promise.all([this.api.me(), this.api.taskTypes(), this.api.workloads()])
    return { identity, taskTypes, workloads }
  }
  async close(reason?: string): Promise<void> {
    if (this.statusValue === 'CLOSED') return
    const session = this.session; this.session = undefined
    try { if (session) await session.close(reason) } finally { this.statusValue = 'CLOSED' }
  }
  private async decide(type: 'task.accept' | 'task.reject', taskId: string, attempt: number, leaseId: string, idempotencyKey: string, reason?: string): Promise<void> {
    for (const value of [taskId, leaseId, idempotencyKey]) if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(value)) throw new Error('SCHEDULING_IDENTIFIER_INVALID')
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('SCHEDULING_ATTEMPT_INVALID')
    const key = `${taskId}\u0000${attempt}`
    const fingerprint = `${type}\u0000${leaseId}\u0000${idempotencyKey}\u0000${reason ?? ''}`
    const prior = this.decisions.get(key)
    if (prior !== undefined) { if (prior !== fingerprint) throw new Error('SCHEDULING_DECISION_CONFLICT'); return }
    this.decisions.set(key, fingerprint)
    try { await this.send(type === 'task.accept' ? { version: SCHEDULING_CONTROL_VERSION, type, taskId, attempt, leaseId, idempotencyKey } : { version: SCHEDULING_CONTROL_VERSION, type, taskId, attempt, leaseId, idempotencyKey, reason: reason ?? '' }) }
    catch (error) { this.decisions.delete(key); throw error }
  }
  private require(): SchedulingSession { if (this.statusValue !== 'READY' || !this.session) throw new Error('SCHEDULING_CLIENT_NOT_READY'); return this.session }
  private async send(frame: SchedulingControlFrame): Promise<void> { await this.require().send(frame) }
}
