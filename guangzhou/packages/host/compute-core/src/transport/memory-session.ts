/**
 * In-memory session and connector used to drive the resident loop without a socket.
 *
 * This is the seam's conformance double: it implements exactly
 * {@link ResidentSession} / {@link ResidentSessionConnector} and nothing more. It
 * opens no network connection, reads no credential and stores no token, so it can
 * only ever prove loop behavior — never transport or TLS behavior.
 */
import { ComputeError } from '../errors.ts'
import type { NodeHeartbeatMessage, NodeTaskOfferMessage, NodeTaskProgressMessage, NodeTaskReturnMessage } from '../node-protocol.ts'
import type { ResidentDecisionEvent, ResidentEarningsEventReference, ResidentSession, ResidentSessionConnector } from '../resident/types.ts'

/** One outbound frame the resident runtime delivered, in send order. */
export type MemoryOutboundFrame =
  | { type: 'heartbeat'; message: NodeHeartbeatMessage }
  | { type: 'task.progress'; message: NodeTaskProgressMessage }
  | { type: 'task.return'; message: NodeTaskReturnMessage }
  | { type: 'offer.decision'; event: ResidentDecisionEvent }
  | { type: 'offer.earnings'; event: ResidentEarningsEventReference }

/** Failure injections applied to one in-memory session. */
export interface MemorySessionOptions {
  /** Refuse `sendHeartbeat` with this code on every call. */
  failHeartbeatsWith?: string
  /** Refuse `sendReturn` with this code on every call. */
  failReturnsWith?: string
  /** Refuse `sendProgress` with this code on every call. */
  failProgressWith?: string
}

/**
 * One in-memory session. `push` simulates an authenticated inbound offer and
 * `disconnect` simulates a peer-side close.
 */
export class MemoryResidentSession implements ResidentSession {
  /** Every frame this session delivered to dispatch, in order. */
  readonly sent: MemoryOutboundFrame[] = []
  /** How many times `close` was called. */
  closed = 0
  private readonly offers = new Set<(offer: NodeTaskOfferMessage) => void | Promise<void>>()
  private readonly disconnects = new Set<(reason?: string) => void>()
  private options: MemorySessionOptions

  constructor(options: MemorySessionOptions = {}) {
    this.options = options
  }

  /** Replace the failure injections for the next sends. */
  configure(options: MemorySessionOptions): void { this.options = options }

  /** Deliver one authenticated inbound offer to every handler. */
  async push(offer: NodeTaskOfferMessage): Promise<void> {
    for (const handler of [...this.offers]) await handler(offer)
  }

  /** Simulate a peer-side disconnect. */
  disconnect(reason?: string): void {
    for (const handler of [...this.disconnects]) handler(reason)
  }

  async sendHeartbeat(message: NodeHeartbeatMessage): Promise<void> {
    if (this.closed > 0) throw new ComputeError('COMPUTE_NODE_SESSION_CLOSED', 409)
    if (this.options.failHeartbeatsWith !== undefined) throw new ComputeError(this.options.failHeartbeatsWith, 503)
    this.sent.push({ type: 'heartbeat', message })
  }

  async sendProgress(message: NodeTaskProgressMessage): Promise<void> {
    if (this.closed > 0) throw new ComputeError('COMPUTE_NODE_SESSION_CLOSED', 409)
    if (this.options.failProgressWith !== undefined) throw new ComputeError(this.options.failProgressWith, 503)
    this.sent.push({ type: 'task.progress', message })
  }

  async sendReturn(message: NodeTaskReturnMessage): Promise<void> {
    if (this.closed > 0) throw new ComputeError('COMPUTE_NODE_SESSION_CLOSED', 409)
    if (this.options.failReturnsWith !== undefined) throw new ComputeError(this.options.failReturnsWith, 503)
    this.sent.push({ type: 'task.return', message })
  }

  async sendDecision(event: ResidentDecisionEvent): Promise<void> {
    if (this.closed > 0) throw new ComputeError('COMPUTE_NODE_SESSION_CLOSED', 409)
    this.sent.push({ type: 'offer.decision', event })
  }

  async sendEarnings(event: ResidentEarningsEventReference): Promise<void> {
    if (this.closed > 0) throw new ComputeError('COMPUTE_NODE_SESSION_CLOSED', 409)
    this.sent.push({ type: 'offer.earnings', event })
  }

  onOffer(handler: (offer: NodeTaskOfferMessage) => void | Promise<void>): () => void {
    this.offers.add(handler)
    return () => this.offers.delete(handler)
  }

  onDisconnect(handler: (reason?: string) => void): () => void {
    this.disconnects.add(handler)
    return () => this.disconnects.delete(handler)
  }

  /** Record the close and detach every handler; repeated calls stay idempotent. */
  async close(): Promise<void> {
    this.closed += 1
    this.offers.clear()
    this.disconnects.clear()
  }

  /** Progress frames delivered to dispatch, in order. */
  progressFrames(): readonly NodeTaskProgressMessage[] {
    return this.sent.flatMap(frame => frame.type === 'task.progress' ? [frame.message] : [])
  }

  /** Return frames delivered to dispatch, in order. */
  returnFrames(): readonly NodeTaskReturnMessage[] {
    return this.sent.flatMap(frame => frame.type === 'task.return' ? [frame.message] : [])
  }

  /** Heartbeats delivered to dispatch, in order. */
  heartbeatFrames(): readonly NodeHeartbeatMessage[] {
    return this.sent.flatMap(frame => frame.type === 'heartbeat' ? [frame.message] : [])
  }

  /** Admission decisions delivered to dispatch, in order. */
  decisionEvents(): readonly ResidentDecisionEvent[] {
    return this.sent.flatMap(frame => frame.type === 'offer.decision' ? [frame.event] : [])
  }
}

/** Connector that hands out one in-memory session per `connect` call. */
export class MemoryResidentConnector implements ResidentSessionConnector {
  /** Sessions created so far, in connect order. */
  readonly sessions: MemoryResidentSession[] = []
  /** How many `connect` calls were made, including refused ones. */
  connectCalls = 0
  /** When set, `connect` rejects with this code instead of producing a session. */
  failWith: string | null = null
  private options: MemorySessionOptions

  constructor(options: MemorySessionOptions = {}) {
    this.options = options
  }

  /** Replace the failure injections applied to sessions created from now on. */
  configure(options: MemorySessionOptions): void { this.options = options }

  /** Latest session, or null before the first successful connect. */
  latest(): MemoryResidentSession | null { return this.sessions.at(-1) ?? null }

  async connect(signal: AbortSignal): Promise<ResidentSession> {
    this.connectCalls += 1
    if (signal.aborted) throw new ComputeError('COMPUTE_RESIDENT_CONNECT_ABORTED', 499)
    if (this.failWith !== null) throw new ComputeError(this.failWith, 503)
    const session = new MemoryResidentSession(this.options)
    this.sessions.push(session)
    return session
  }
}
