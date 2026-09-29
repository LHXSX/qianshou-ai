/** Transport-neutral node session seam; concrete HTTP/WebSocket adapters live elsewhere. */
import type { NodeHeartbeatMessage, NodeTaskOfferMessage, NodeTaskProgressMessage, NodeTaskReturnMessage } from './node-protocol.ts'
import { ComputeError } from './errors.ts'

/** Authentication material is write-only input to a connector and never durable state. */
export interface NodeConnectRequest {
  endpoint: string
  accessToken: string
  heartbeat: NodeHeartbeatMessage
}

/** Minimal authenticated session owned by a transport adapter. */
export interface NodeSession {
  sendHeartbeat(message: NodeHeartbeatMessage): Promise<void>
  sendProgress(message: NodeTaskProgressMessage): Promise<void>
  sendReturn(message: NodeTaskReturnMessage): Promise<void>
  onOffer(handler: (offer: NodeTaskOfferMessage) => void | Promise<void>): () => void
  close(reason?: string): Promise<void>
}

/** Connector implemented by the bottom adapter; it owns token exchange, TLS and reconnect wiring. */
export interface NodeSessionConnector {
  connect(request: NodeConnectRequest, signal?: AbortSignal): Promise<NodeSession>
}

/** Durable local connection lifecycle, excluding tokens and socket instances. */
export type NodeConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'AUTHENTICATING' | 'READY' | 'BACKOFF' | 'CLOSED'
/** Durable node connection lifecycle state without credentials or sockets. */
export interface NodeConnectionState {
  status: NodeConnectionStatus
  attempt: number
  nextRetryAt: string | null
  lastError: string | null
  updatedAt: string
}

/** Lifecycle event applied to a node connection state. */
export type NodeConnectionEvent =
  | { type: 'connect' }
  | { type: 'auth' }
  | { type: 'ready' }
  | { type: 'disconnect'; error?: string; retryAt?: string }
  | { type: 'retry' }
  | { type: 'close' }

/** Apply one connection lifecycle event without touching a network or credential store.
 * @param state - Current durable connection state.
 * @param event - Lifecycle event to apply.
 * @param now - Canonical current UTC timestamp.
 * @returns Updated connection state.
 */
export function transitionNodeConnection(state: NodeConnectionState, event: NodeConnectionEvent, now: string): NodeConnectionState {
  timestamp(now)
  const allowed: Record<NodeConnectionStatus, readonly NodeConnectionEvent['type'][]> = {
    DISCONNECTED: ['connect', 'close'], CONNECTING: ['auth', 'disconnect', 'close'], AUTHENTICATING: ['ready', 'disconnect', 'close'], READY: ['disconnect', 'close'], BACKOFF: ['retry', 'close'], CLOSED: [],
  }
  if (!allowed[state.status].includes(event.type)) throw new ComputeError('COMPUTE_NODE_CONNECTION_TRANSITION_INVALID', 409)
  let next: NodeConnectionState = { ...state, updatedAt: now }
  if (event.type === 'connect') next = { ...next, status: 'CONNECTING', attempt: state.attempt + 1, lastError: null, nextRetryAt: null }
  if (event.type === 'auth') next = { ...next, status: 'AUTHENTICATING' }
  if (event.type === 'ready') next = { ...next, status: 'READY', nextRetryAt: null, lastError: null }
  if (event.type === 'disconnect') {
    if (event.retryAt !== undefined) { timestamp(event.retryAt); next = { ...next, status: 'BACKOFF', nextRetryAt: event.retryAt, lastError: event.error ?? 'COMPUTE_NODE_DISCONNECTED' } }
    else next = { ...next, status: 'DISCONNECTED', nextRetryAt: null, lastError: event.error ?? 'COMPUTE_NODE_DISCONNECTED' }
  }
  if (event.type === 'retry') next = { ...next, status: 'CONNECTING', nextRetryAt: null, attempt: state.attempt + 1 }
  if (event.type === 'close') next = { ...next, status: 'CLOSED', nextRetryAt: null }
  return next
}

function timestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new ComputeError('COMPUTE_NODE_TIMESTAMP_INVALID')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ComputeError('COMPUTE_NODE_TIMESTAMP_INVALID')
}
