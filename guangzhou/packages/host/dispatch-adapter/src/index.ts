/**
 * Small dispatch control-plane adapter for an autonomous contributing agent.
 *
 * This package composes the existing transport-neutral node session contract;
 * it does not open sockets, discover endpoints, fetch task inputs, upload
 * media, price work, or settle payments. A deployment supplies the connector
 * that owns authentication and the physical transport.
 */
import {
  ComputeError,
  transitionNodeConnection,
  type NodeConnectRequest,
  type NodeConnectionState,
  type NodeSession,
  type NodeSessionConnector,
  type NodeTaskOfferMessage,
  type NodeTaskProgressMessage,
  type NodeTaskReturnMessage,
  type NodeHeartbeatMessage,
} from '@deepseek-ai/dsh-compute-core'

/** Deployment-owned clock; values must be canonical UTC timestamps. */
export type DispatchClock = () => string

/** Dependencies for one control-plane adapter instance. */
export interface DispatchControlAdapterOptions {
  connector: NodeSessionConnector
  clock?: DispatchClock
}

/** Immutable state snapshot emitted by the adapter. */
export type DispatchControlState = NodeConnectionState

/**
 * Composes node authentication, control frames, and lifecycle state.
 * Credentials are passed to `NodeSessionConnector.connect` for one handshake
 * and are not retained by this class. Offers are already parsed by the
 * connector before reaching subscribers.
 */
export class DispatchControlAdapter {
  private readonly connector: NodeSessionConnector
  private readonly clock: DispatchClock
  private session: NodeSession | undefined
  private stateValue: NodeConnectionState

  constructor(options: DispatchControlAdapterOptions) {
    const value: unknown = options
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !('connector' in value) || !value.connector || typeof value.connector !== 'object'
      || !('connect' in value.connector) || typeof value.connector.connect !== 'function') {
      throw new ComputeError('COMPUTE_DISPATCH_CONNECTOR_INVALID')
    }
    this.connector = options.connector
    this.clock = options.clock ?? (() => new Date().toISOString())
    const now = this.now()
    this.stateValue = { status: 'DISCONNECTED', attempt: 0, nextRetryAt: null, lastError: null, updatedAt: now }
  }

  /** Return a durable-safe state projection without credentials or a session handle. */
  state(): DispatchControlState { return Object.freeze({ ...this.stateValue }) }

  /** Authenticate once through the injected transport connector. */
  async connect(request: NodeConnectRequest, signal?: AbortSignal): Promise<DispatchControlState> {
    if (this.stateValue.status === 'CLOSED') throw new ComputeError('COMPUTE_DISPATCH_CLOSED', 409)
    if (this.session) throw new ComputeError('COMPUTE_DISPATCH_ALREADY_CONNECTED', 409)
    this.apply({ type: 'connect' })
    this.apply({ type: 'auth' })
    try {
      const session = await this.connector.connect(request, signal)
      this.session = session
      this.apply({ type: 'ready' })
      return this.state()
    } catch (error) {
      this.session = undefined
      this.apply({ type: 'disconnect', error: safeError(error) })
      throw error
    }
  }

  /** Subscribe to authenticated task invitations; incoming values are parsed by the connector. */
  onTaskOffer(handler: (offer: NodeTaskOfferMessage) => void | Promise<void>): () => void {
    if (typeof handler !== 'function') throw new ComputeError('COMPUTE_DISPATCH_HANDLER_INVALID')
    const session = this.requireSession()
    return session.onOffer(handler)
  }

  /** Publish liveness and capability metadata; this frame contains no local paths or secrets. */
  async publishHeartbeat(message: NodeHeartbeatMessage): Promise<void> {
    await this.send('heartbeat', () => this.requireSession().sendHeartbeat(message))
  }

  /** Report bounded progress for a locally executing task. */
  async reportProgress(message: NodeTaskProgressMessage): Promise<void> {
    await this.send('progress', () => this.requireSession().sendProgress(message))
  }

  /** Report a result manifest; output bytes stay on the node-side transfer adapter. */
  async reportResult(message: NodeTaskReturnMessage): Promise<void> {
    await this.send('result', () => this.requireSession().sendReturn(message))
  }

  /** Close the session and make this adapter terminal. */
  async close(reason = 'dispatch adapter closed'): Promise<void> {
    if (this.stateValue.status === 'CLOSED') return
    const session = this.session
    this.session = undefined
    try { if (session) await session.close(reason) } finally { this.apply({ type: 'close' }) }
  }

  private async send(kind: 'heartbeat' | 'progress' | 'result', operation: () => Promise<void>): Promise<void> {
    if (this.stateValue.status !== 'READY') throw new ComputeError('COMPUTE_DISPATCH_NOT_READY', 409)
    try { await operation() } catch (error) {
      this.session = undefined
      this.apply({ type: 'disconnect', error: `${kind}:${safeError(error)}` })
      throw error
    }
  }

  private requireSession(): NodeSession {
    if (this.stateValue.status !== 'READY' || !this.session) throw new ComputeError('COMPUTE_DISPATCH_NOT_READY', 409)
    return this.session
  }

  private apply(event: Parameters<typeof transitionNodeConnection>[1]): void {
    this.stateValue = transitionNodeConnection(this.stateValue, event, this.now())
  }

  private now(): string {
    const value = this.clock()
    if (typeof value !== 'string') throw new ComputeError('COMPUTE_DISPATCH_CLOCK_INVALID')
    return value
  }
}

function safeError(error: unknown): string {
  if (error instanceof ComputeError) return error.code
  return error instanceof Error && error.message.length > 0 && error.message.length <= 128 ? error.message : 'COMPUTE_DISPATCH_TRANSPORT_FAILED'
}
