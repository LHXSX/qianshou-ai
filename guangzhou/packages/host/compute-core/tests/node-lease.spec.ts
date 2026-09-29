import { describe, expect, it } from 'vitest'
import { ComputeNodeId } from '../src/node-protocol.ts'
import { createNodeTaskLeaseState, parseNodeTaskLease, transitionNodeTaskLease, type NodeTaskLease } from '../src/node-lease.ts'

const lease = (overrides: Partial<NodeTaskLease> = {}): NodeTaskLease => ({
  version: 'qianshou.node.lease.v1', leaseId: 'lease-1', taskId: 'task-1', attempt: 1,
  ownerNodeId: ComputeNodeId('node-a'), issuedAt: '2026-09-15T10:00:00.000Z', expiresAt: '2026-09-15T10:05:00.000Z', idempotencyKey: 'accept-1', ...overrides,
})

describe('node lease boundary', () => {
  it('parses metadata and creates an offered state without media fields', () => {
    const parsed = parseNodeTaskLease(lease())
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(parsed).not.toHaveProperty('bytes')
    expect(createNodeTaskLeaseState(parsed).state).toBe('OFFERED')
  })
  it('accepts only the owner and exact idempotency key, and repeats safely', () => {
    const offered = createNodeTaskLeaseState(lease())
    expect(() => transitionNodeTaskLease(offered, { type: 'accept', nodeId: ComputeNodeId('node-b'), idempotencyKey: 'accept-1', at: '2026-09-15T10:01:00.000Z' })).toThrow('COMPUTE_NODE_LEASE_OWNER_MISMATCH')
    expect(() => transitionNodeTaskLease(offered, { type: 'accept', nodeId: ComputeNodeId('node-a'), idempotencyKey: 'wrong', at: '2026-09-15T10:01:00.000Z' })).toThrow('COMPUTE_NODE_LEASE_IDEMPOTENCY_MISMATCH')
    const accepted = transitionNodeTaskLease(offered, { type: 'accept', nodeId: ComputeNodeId('node-a'), idempotencyKey: 'accept-1', at: '2026-09-15T10:01:00.000Z' })
    expect(transitionNodeTaskLease(accepted, { type: 'accept', nodeId: ComputeNodeId('node-a'), idempotencyKey: 'accept-1', at: '2026-09-15T10:02:00.000Z' })).toStrictEqual(accepted)
  })
  it('expires at the deadline and rejects late completion', () => {
    const offered = createNodeTaskLeaseState(lease())
    const expired = transitionNodeTaskLease(offered, { type: 'expire', at: '2026-09-15T10:05:00.000Z' })
    expect(expired.state).toBe('EXPIRED')
    expect(() => transitionNodeTaskLease(expired, { type: 'accept', nodeId: ComputeNodeId('node-a'), idempotencyKey: 'accept-1', at: '2026-09-15T10:05:00.001Z' })).toThrow('COMPUTE_NODE_LEASE_TRANSITION_INVALID')
  })
  it('allows dispatch revoke and rejects a forged actor', () => {
    const offered = createNodeTaskLeaseState(lease())
    expect(() => transitionNodeTaskLease(offered, { type: 'revoke', actor: 'node', at: '2026-09-15T10:01:00.000Z', reason: 'tampered' })).toThrow('COMPUTE_NODE_LEASE_REVOKER_UNAUTHORIZED')
    const revoked = transitionNodeTaskLease(offered, { type: 'revoke', actor: 'dispatch', at: '2026-09-15T10:01:00.000Z', reason: 'capacity changed' })
    expect(revoked.state).toBe('REVOKED')
    expect(() => transitionNodeTaskLease(revoked, { type: 'revoke', actor: 'dispatch', at: '2026-09-15T10:02:00.000Z', reason: 'again' })).toThrow('COMPUTE_NODE_LEASE_TRANSITION_INVALID')
  })
})
