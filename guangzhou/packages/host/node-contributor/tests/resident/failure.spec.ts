import { describe, expect, it, afterEach } from 'vitest'
import { TestResidentNode, waitFor } from './harness.ts'

const nodes: TestResidentNode[] = []

async function node(options: Parameters<typeof TestResidentNode.create>[0] = {}): Promise<TestResidentNode> {
  const created = await TestResidentNode.create(options)
  nodes.push(created)
  return created
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map(async created => { await created.dispose() }))
})

describe('resident runtime: lease expiry', () => {
  it('refuses and never executes an attempt whose lease died while queued', async () => {
    const subject = await node()
    await subject.runtime.start()
    await subject.pushOffer(subject.offer('task-expired', { leaseMs: 1_000 }))
    subject.clock.advance(2_000)

    const tick = await subject.runtime.tickOnce()
    expect(tick.outcomes[0]).toMatchObject({ accepted: false, reason: 'LEASE_EXPIRED_BEFORE_START', refusal: 'LEASE_INVALID' })
    expect(tick.outcomes[0]?.state).toBeNull()
    expect(subject.runs).toHaveLength(0)
    const session = subject.sessions()[0]
    expect(session?.returnFrames()).toHaveLength(0)
    expect(session?.progressFrames()).toHaveLength(0)
    // Nothing was persisted: the lease never permitted a local record.
    expect(await subject.state('task-expired')).toBeNull()
  })

  it('parks the expired attempt as a durable terminal refusal when retention is requested', async () => {
    const subject = await node({ keepExpiredQueuedAttempts: true })
    await subject.runtime.start()
    await subject.pushOffer(subject.offer('task-parked', { leaseMs: 1_000 }))
    subject.clock.advance(2_000)

    const tick = await subject.runtime.tickOnce()
    expect(tick.outcomes[0]).toMatchObject({ accepted: false, reason: 'LEASE_EXPIRED_BEFORE_START', refusal: 'LEASE_INVALID' })
    expect(tick.outcomes[0]?.state).toMatchObject({ status: 'REFUSED' })
    expect(subject.runs).toHaveLength(0)
    // The parked record is durable, so a replay cannot start local work later.
    expect(await subject.state('task-parked')).toMatchObject({ status: 'REFUSED' })
    await subject.pushOffer(subject.offer('task-parked', { leaseMs: 600_000 }))
    const replay = await subject.runtime.tickOnce()
    expect(replay.outcomes[0]).toMatchObject({ accepted: false, reason: 'CANDIDATE_REJECTED', refusal: 'DUPLICATE' })
    expect(subject.runs).toHaveLength(0)
  })

  it('records EXPIRED when the lease dies mid-execution and reports no result', async () => {
    const subject = await node()
    await subject.runtime.start()
    let release: (() => void) | undefined
    subject.holdRun = { promise: new Promise<void>(resolve => { release = resolve }), release: () => release?.() }

    await subject.pushOffer(subject.offer('task-mid-lease', { leaseMs: 60_000 }))
    await subject.runtime.tickOnce()
    await waitFor(() => subject.runs.length === 1, 'the held attempt to start executing')
    expect(subject.runs).toHaveLength(1)
    expect(subject.sessions()[0]?.progressFrames()).toHaveLength(1)

    subject.clock.advance(120_000)
    release?.()
    await waitFor(async () => (await subject.state('task-mid-lease'))?.status === 'EXPIRED', 'mid-lease attempt to expire')
    await waitFor(() => subject.runtime.inFlightCount() === 0, 'the expired attempt to be released')

    expect(await subject.state('task-mid-lease')).toMatchObject({ status: 'EXPIRED' })
    const session = subject.sessions()[0]
    expect(session?.returnFrames()).toHaveLength(0)
    expect(session?.progressFrames()).toHaveLength(1)
    expect(subject.runtime.activeAttempts()).toEqual([expect.objectContaining({ taskId: 'task-mid-lease', status: 'EXPIRED', failureCode: 'LEASE_EXPIRED' })])
  })
})

describe('resident runtime: transport loss', () => {
  it('records OFFLINE and cancels the local attempt when the session drops', async () => {
    const subject = await node()
    await subject.runtime.start()
    subject.holdRun = { promise: new Promise<void>(() => {}), release: () => {} }
    await subject.pushOffer(subject.offer('task-drop', { leaseMs: 600_000 }))
    await subject.runtime.tickOnce()
    await waitFor(() => subject.runs.length === 1, 'the held attempt to start executing')
    expect(subject.runs).toHaveLength(1)

    subject.sessions()[0]?.disconnect('socket closed')
    await waitFor(async () => (await subject.state('task-drop'))?.status === 'OFFLINE', 'dropped attempt to be recorded OFFLINE')
    await waitFor(() => subject.runtime.inFlightCount() === 0, 'the dropped attempt to be released')

    expect(await subject.state('task-drop')).toMatchObject({ status: 'OFFLINE' })
    expect(subject.sessions()[0]?.returnFrames()).toHaveLength(0)
    expect(subject.runtime.activeAttempts()).toEqual([expect.objectContaining({ taskId: 'task-drop', status: 'OFFLINE', failureCode: 'TRANSPORT_LOST' })])
  })

  it('does not auto-reconnect or accept work until a new session exists', async () => {
    const subject = await node()
    await subject.runtime.start()
    subject.sessions()[0]?.disconnect('network down')
    await waitFor(() => subject.runtime.state() === 'RUNNING', 'the runtime to keep running with no session')

    expect(subject.sessions()).toHaveLength(1)
    await expect(subject.runtime.tickOnce()).rejects.toThrow('COMPUTE_RESIDENT_NOT_CONNECTED')
    await expect(subject.runtime.settle('task-after-drop', 1)).rejects.toThrow('COMPUTE_TASK_NOT_FOUND')

    subject.runtime.pause()
    await subject.runtime.resume()
    expect(subject.sessions()).toHaveLength(2)
    await subject.pushOffer(subject.offer('task-reconnect'))
    await subject.runtime.tickOnce()
    await waitFor(async () => (await subject.state('task-reconnect'))?.status === 'RETURNED', 'reconnected session to complete the offer')
    expect(await subject.state('task-reconnect')).toMatchObject({ status: 'RETURNED' })
  })
})
