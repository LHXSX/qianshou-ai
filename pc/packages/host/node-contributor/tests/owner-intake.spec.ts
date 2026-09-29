import { expect, it } from 'vitest'
import { TestResidentNode, waitFor, waitForStatus } from './resident/harness.ts'

it('an intake-only policy withdrawal keeps the existing attempt, heartbeat and result delivery alive', async () => {
  const node = await TestResidentNode.create()
  let release!: () => void
  node.holdRun = { promise: new Promise<void>((resolve) => { release = resolve }), release: () => { release() } }
  try {
    await node.runtime.start()
    await node.pushOffer(node.offer('owner-running', { leaseMs: 600_000 }))
    await node.runtime.tickOnce()
    await waitFor(() => node.runs.length === 1, 'the authorized attempt to start')
    const session = node.sessions()[0]!
    const heartbeats = session.heartbeatFrames().length
    node.runtime.setPolicy({ ...node.runtime.policy(), mode: 'OFF', allowWhileUserActive: false })
    await node.pushOffer(node.offer('owner-new', { leaseMs: 600_000 }))
    const tick = await node.runtime.tickOnce()
    expect(tick.outcomes).toEqual([expect.objectContaining({ accepted: false })])
    expect(await node.state('owner-running')).toMatchObject({ status: 'EXECUTING' })
    expect(await node.state('owner-new')).toBeNull()
    expect(node.runtime.inFlightCount()).toBe(1)
    expect(session.heartbeatFrames().length).toBeGreaterThan(heartbeats)
    expect(session.closed).toBe(0)
    release()
    await waitForStatus(node, 'owner-running', 'RETURNED')
    expect(session.returnFrames()).toHaveLength(1)
    expect(session.closed).toBe(0)
  } finally { release(); await node.dispose() }
})
