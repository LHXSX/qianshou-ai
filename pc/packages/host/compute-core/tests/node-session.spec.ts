import { describe, expect, it } from 'vitest'
import { transitionNodeConnection, type NodeConnectionState } from '../src/node-session.ts'

const now = '2026-09-14T12:00:00.000Z'
const initial: NodeConnectionState = { status: 'DISCONNECTED', attempt: 0, nextRetryAt: null, lastError: null, updatedAt: now }
describe('node session lifecycle seam', () => {
  it('keeps auth and retry state separate from credentials', () => {
    const connected = transitionNodeConnection(initial, { type: 'connect' }, now)
    const auth = transitionNodeConnection(connected, { type: 'auth' }, now)
    const ready = transitionNodeConnection(auth, { type: 'ready' }, now)
    expect(ready).toMatchObject({ status: 'READY', attempt: 1, lastError: null })
    const backoff = transitionNodeConnection(ready, { type: 'disconnect', error: 'NETWORK', retryAt: '2026-09-14T12:00:05.000Z' }, now)
    expect(backoff).toMatchObject({ status: 'BACKOFF', nextRetryAt: '2026-09-14T12:00:05.000Z', lastError: 'NETWORK' })
  })
  it('rejects illegal transitions and terminal reopen', () => {
    expect(() => transitionNodeConnection(initial, { type: 'ready' }, now)).toThrow('COMPUTE_NODE_CONNECTION_TRANSITION_INVALID')
    const closed = transitionNodeConnection(initial, { type: 'close' }, now)
    expect(() => transitionNodeConnection(closed, { type: 'connect' }, now)).toThrow('COMPUTE_NODE_CONNECTION_TRANSITION_INVALID')
    expect(() => transitionNodeConnection(initial, { type: 'connect' }, '2026-99-99T12:00:00.000Z')).toThrow('COMPUTE_NODE_TIMESTAMP_INVALID')
  })
})
