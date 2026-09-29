/**
 * Transport-neutral worker lease boundary.
 *
 * A lease is control-plane metadata only. It never contains input/output bytes,
 * local paths, prices, credentials or upload URLs. A transport adapter may carry
 * these records over an authenticated channel, while the node-side transfer
 * adapter owns media bytes.
 */
import { ComputeError } from './errors.ts'
import type { ComputeNodeId } from './node-protocol.ts'

export const COMPUTE_NODE_LEASE_VERSION = 'qianshou.node.lease.v1' as const
export type NodeLeaseState = 'OFFERED' | 'ACCEPTED' | 'COMPLETED' | 'REVOKED' | 'EXPIRED'

/** Dispatch-issued ownership record for one task attempt. */
export interface NodeTaskLease {
  version: typeof COMPUTE_NODE_LEASE_VERSION
  leaseId: string
  taskId: string
  attempt: number
  ownerNodeId: ComputeNodeId
  issuedAt: string
  expiresAt: string
  /** Acceptance must echo this exact key; it is safe to persist as dedupe state. */
  idempotencyKey: string
}

export interface NodeTaskLeaseState extends NodeTaskLease {
  state: NodeLeaseState
  acceptedAt: string | null
  completedAt: string | null
  revokedAt: string | null
  lastEventKey: string | null
}

export type NodeTaskLeaseEvent =
  | { type: 'accept'; nodeId: ComputeNodeId; idempotencyKey: string; at: string }
  | { type: 'complete'; nodeId: ComputeNodeId; at: string }
  | { type: 'revoke'; actor: string; at: string; reason: string }
  | { type: 'expire'; at: string }

/** Parse untrusted lease metadata before it reaches a scheduler or worker. */
export function parseNodeTaskLease(value: unknown): NodeTaskLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_NODE_LEASE_INVALID')
  const item = value as Record<string, unknown>
  const attempt = item.attempt as number
  if (item.version !== COMPUTE_NODE_LEASE_VERSION || !token(item.leaseId) || !token(item.taskId)
    || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1_000_000
    || !token(item.ownerNodeId) || typeof item.issuedAt !== 'string' || typeof item.expiresAt !== 'string'
    || !token(item.idempotencyKey)) throw new ComputeError('COMPUTE_NODE_LEASE_INVALID')
  timestamp(item.issuedAt)
  timestamp(item.expiresAt)
  if (Date.parse(item.expiresAt) <= Date.parse(item.issuedAt)) throw new ComputeError('COMPUTE_NODE_LEASE_INVALID')
  return Object.freeze({
    version: COMPUTE_NODE_LEASE_VERSION,
    leaseId: item.leaseId,
    taskId: item.taskId,
    attempt,
    ownerNodeId: item.ownerNodeId as ComputeNodeId,
    issuedAt: item.issuedAt,
    expiresAt: item.expiresAt,
    idempotencyKey: item.idempotencyKey,
  })
}

/** Create the initial immutable offered state from a validated lease. */
export function createNodeTaskLeaseState(lease: NodeTaskLease): NodeTaskLeaseState {
  const parsed = parseNodeTaskLease(lease)
  return freezeState({ ...parsed, state: 'OFFERED', acceptedAt: null, completedAt: null, revokedAt: null, lastEventKey: null })
}

/** Apply one lease event without transport or persistence side effects. */
export function transitionNodeTaskLease(current: NodeTaskLeaseState, event: NodeTaskLeaseEvent): NodeTaskLeaseState {
  const state = normalizeState(current)
  timestamp(event.at)
  const now = Date.parse(event.at)
  const expires = Date.parse(state.expiresAt)
  if ((state.state === 'OFFERED' || state.state === 'ACCEPTED') && now >= expires && event.type !== 'expire') throw new ComputeError('COMPUTE_NODE_LEASE_EXPIRED', 409)
  if (event.type === 'expire') {
    if (state.state === 'EXPIRED') return state
    if (state.state !== 'OFFERED' && state.state !== 'ACCEPTED') throw new ComputeError('COMPUTE_NODE_LEASE_TRANSITION_INVALID', 409)
    if (now < expires) throw new ComputeError('COMPUTE_NODE_LEASE_NOT_EXPIRED', 409)
    return freezeState({ ...state, state: 'EXPIRED', lastEventKey: 'expire' })
  }
  if (event.type === 'accept') {
    if (state.state === 'ACCEPTED' && event.nodeId === state.ownerNodeId && event.idempotencyKey === state.idempotencyKey) return state
    if (state.state !== 'OFFERED') throw new ComputeError('COMPUTE_NODE_LEASE_TRANSITION_INVALID', 409)
    if (event.nodeId !== state.ownerNodeId) throw new ComputeError('COMPUTE_NODE_LEASE_OWNER_MISMATCH', 403)
    if (event.idempotencyKey !== state.idempotencyKey) throw new ComputeError('COMPUTE_NODE_LEASE_IDEMPOTENCY_MISMATCH', 409)
    return freezeState({ ...state, state: 'ACCEPTED', acceptedAt: event.at, lastEventKey: event.idempotencyKey })
  }
  if (event.type === 'complete') {
    if (state.state !== 'ACCEPTED') throw new ComputeError('COMPUTE_NODE_LEASE_TRANSITION_INVALID', 409)
    if (event.nodeId !== state.ownerNodeId) throw new ComputeError('COMPUTE_NODE_LEASE_OWNER_MISMATCH', 403)
    return freezeState({ ...state, state: 'COMPLETED', completedAt: event.at, lastEventKey: `complete:${event.at}` })
  }
  if (state.state !== 'OFFERED' && state.state !== 'ACCEPTED') throw new ComputeError('COMPUTE_NODE_LEASE_TRANSITION_INVALID', 409)
  if (event.actor !== 'dispatch') throw new ComputeError('COMPUTE_NODE_LEASE_REVOKER_UNAUTHORIZED', 403)
  if (event.reason.length < 1 || event.reason.length > 256) throw new ComputeError('COMPUTE_NODE_LEASE_REASON_INVALID')
  return freezeState({ ...state, state: 'REVOKED', revokedAt: event.at, lastEventKey: `revoke:${event.at}` })
}

function normalizeState(value: unknown): NodeTaskLeaseState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_NODE_LEASE_STATE_INVALID')
  const item = value as NodeTaskLeaseState
  const lease = parseNodeTaskLease(item)
  if (!['OFFERED', 'ACCEPTED', 'COMPLETED', 'REVOKED', 'EXPIRED'].includes(item.state)) throw new ComputeError('COMPUTE_NODE_LEASE_STATE_INVALID')
  if (item.acceptedAt !== null) timestamp(item.acceptedAt)
  if (item.completedAt !== null) timestamp(item.completedAt)
  if (item.revokedAt !== null) timestamp(item.revokedAt)
  if (item.lastEventKey !== null && !token(item.lastEventKey)) throw new ComputeError('COMPUTE_NODE_LEASE_STATE_INVALID')
  return freezeState({
    ...lease,
    state: item.state,
    acceptedAt: item.acceptedAt,
    completedAt: item.completedAt,
    revokedAt: item.revokedAt,
    lastEventKey: item.lastEventKey,
  })
}
function freezeState(state: NodeTaskLeaseState): NodeTaskLeaseState { return Object.freeze({ ...state }) }
function token(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/u.test(value) }
function timestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new ComputeError('COMPUTE_NODE_TIMESTAMP_INVALID')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new ComputeError('COMPUTE_NODE_TIMESTAMP_INVALID')
}
