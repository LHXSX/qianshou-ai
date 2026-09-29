import { describe, expect, it, afterEach } from 'vitest'
import { ResidentNodeRuntime } from '@deepseek-ai/dsh-compute-core/resident'
import { TestResidentNode, settle, waitFor, waitForStatus } from './harness.ts'

const nodes: TestResidentNode[] = []

async function node(options: Parameters<typeof TestResidentNode.create>[0] = {}): Promise<TestResidentNode> {
  const created = await TestResidentNode.create(options)
  nodes.push(created)
  return created
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map(async created => { await created.dispose() }))
})

describe('resident runtime: local execution failures are never reported as results', () => {
  it('records FAILED when the capability rejects the task', async () => {
    const subject = await node()
    await subject.runtime.start()
    subject.failWorkspaceWith = 'capability exploded'
    await subject.pushOffer(subject.offer('task-exec-fail'))
    await subject.runtime.tickOnce()

    await waitForStatus(subject, 'task-exec-fail', 'FAILED')
    await waitFor(() => subject.runtime.inFlightCount() === 0, 'the failed attempt to be released')
    const session = subject.sessions()[0]
    expect(session?.returnFrames()).toHaveLength(0)
    expect(subject.runtime.activeAttempts()).toEqual([expect.objectContaining({ taskId: 'task-exec-fail', status: 'FAILED', failureCode: 'EXECUTION_FAILED' })])
  })

  it('records FAILED when the return frame cannot be delivered', async () => {
    const subject = await node()
    subject.connector.configure({ failReturnsWith: 'COMPUTE_NODE_WRITE_FAILED' })
    await subject.runtime.start()
    await subject.pushOffer(subject.offer('task-return-fail'))
    await subject.runtime.tickOnce()

    await waitForStatus(subject, 'task-return-fail', 'FAILED')
    expect(subject.sessions()[0]?.returnFrames()).toHaveLength(0)
    expect(subject.runs).toHaveLength(1)
  })

  it('records FAILED when a progress receipt cannot be delivered', async () => {
    const subject = await node()
    subject.connector.configure({ failProgressWith: 'COMPUTE_NODE_WRITE_FAILED' })
    await subject.runtime.start()
    await subject.pushOffer(subject.offer('task-progress-fail'))
    await subject.runtime.tickOnce()

    await waitForStatus(subject, 'task-progress-fail', 'FAILED')
    expect(subject.sessions()[0]?.returnFrames()).toHaveLength(0)
  })

  it('fails closed when the offered capability version is not installed locally', async () => {
    const subject = await node()
    await subject.runtime.start()
    await subject.pushOffer(subject.offer('task-version', { capabilityVersion: '9.9.9' }))
    const tick = await subject.runtime.tickOnce()
    expect(tick.outcomes[0]).toMatchObject({ accepted: false, reason: 'CANDIDATE_REJECTED', refusal: 'CAPABILITY_UNAVAILABLE' })
    expect(subject.runs).toHaveLength(0)
    // The capability gate refuses before any store write, so nothing is recorded.
    expect(await subject.state('task-version')).toBeNull()
    expect(subject.decisionEvents().at(-1)).toMatchObject({ decision: 'refused', reason: 'CAPABILITY_UNAVAILABLE' })
  })

  it('refuses an unverified or tampered offer without writing anything', async () => {
    const subject = await node()
    await subject.runtime.start()
    const offer = subject.offer('task-tampered')
    await subject.pushOffer({ ...offer, attempt: offer.attempt + 1 })
    const tick = await subject.runtime.tickOnce()
    expect(tick.outcomes).toEqual([])
    expect(subject.runs).toHaveLength(0)
    expect(await subject.state('task-tampered')).toBeNull()
  })
})

describe('resident runtime: lifecycle', () => {
  it('waits for an in-flight attempt to finish and records it before stopping', async () => {
    const subject = await node()
    await subject.runtime.start()
    let release: (() => void) | undefined
    subject.holdRun = { promise: new Promise<void>(resolve => { release = resolve }), release: () => release?.() }
    await subject.pushOffer(subject.offer('task-drain', { leaseMs: 600_000 }))
    await subject.runtime.tickOnce()
    await waitFor(() => subject.runs.length === 1, 'the held attempt to start executing')
    expect(subject.runs).toHaveLength(1)

    const stopping = subject.runtime.stop('graceful')
    await settle(2)
    // Still waiting: no cancellation and no fabricated terminal record.
    expect(await subject.state('task-drain')).toMatchObject({ status: 'EXECUTING' })
    expect(subject.sessions()[0]?.returnFrames()).toHaveLength(0)

    release?.()
    const receipt = await stopping
    expect(receipt.settled).toBe(true)
    expect(await subject.state('task-drain')).toMatchObject({ status: 'RETURNED' })
    expect(subject.sessions()[0]?.returnFrames()).toHaveLength(1)
    expect(subject.runtime.state()).toBe('STOPPED')
    expect(subject.sessions()[0]?.closed).toBe(1)
    await expect(subject.runtime.tickOnce()).rejects.toThrow('COMPUTE_RESIDENT_STOPPED')
    await expect(subject.runtime.start()).rejects.toThrow('COMPUTE_RESIDENT_STOPPED')
  }, 15_000)

  it('cancels only what is still running when the grace period expires, and never as a result', async () => {
    const subject = await node({ stopTimeoutMs: 200 })
    await subject.runtime.start()
    subject.holdRun = { promise: new Promise<void>(() => {}), release: () => {} }
    await subject.pushOffer(subject.offer('task-grace', { leaseMs: 600_000 }))
    await subject.runtime.tickOnce()
    await waitFor(() => subject.runs.length === 1, 'the held attempt to start executing')

    const receipt = await subject.runtime.stop('timeout')
    expect(receipt.settled).toBe(false)
    expect(receipt.attempts[0]).toMatchObject({ taskId: 'task-grace', status: 'FAILED', failureCode: 'CANCELLED' })
    expect(await subject.state('task-grace')).toMatchObject({ status: 'FAILED' })
    expect(subject.sessions()[0]?.returnFrames()).toHaveLength(0)
    expect(subject.runtime.state()).toBe('STOPPED')
  }, 15_000)

  it('drains parked offers with a stable reason on stop and closes the session once', async () => {
    const subject = await node()
    await subject.runtime.start()
    await subject.pushOffer(subject.offer('task-not-started'))
    // The verified offer is parked until the next tick; a stop must not lose it.
    expect(subject.runtime.pendingOfferCount()).toBe(1)

    const receipt = await subject.runtime.stop('shutdown')
    expect(receipt.settled).toBe(true)
    expect(receipt.attempts).toEqual([])
    expect(subject.runs).toHaveLength(0)
    expect(await subject.state('task-not-started')).toBeNull()
    expect(subject.sessions()[0]?.closed).toBe(1)
    await expect(subject.runtime.stop('again')).resolves.toMatchObject({ settled: true })
    expect(subject.sessions()[0]?.closed).toBe(1)
  })

  it('rejects an incomplete or unsafe platform seam at construction', async () => {
    const subject = await node()
    expect(subject.runtime.nodeId).toBe('node-resident-1')
    const base = {
      nodeId: 'node-x',
      agentVersion: 'agent-x',
      policy: subject.runtime.policy(),
      observer: { snapshot: async () => ({ snapshot: {}, heartbeat: {} }) },
      capabilities: { listCapabilities: () => [] },
      connector: { connect: async () => ({}) },
      port: { verifyOffer: async () => ({ accepted: false }) },
      workspace: { createWorkspace: async () => ({}) },
      resultConsumer: { consume: async () => ({ outputs: [] }) },
    }
    expect(() => new ResidentNodeRuntime({ ...base, nodeId: 'bad node id' } as never)).toThrow('COMPUTE_RESIDENT_NODE_ID_INVALID')
    expect(() => new ResidentNodeRuntime({ ...base, agentVersion: '' } as never)).toThrow('COMPUTE_RESIDENT_AGENT_VERSION_INVALID')
    expect(() => new ResidentNodeRuntime({ ...base, observer: undefined } as never)).toThrow('COMPUTE_RESIDENT_OBSERVER_INVALID')
    expect(() => new ResidentNodeRuntime({ ...base, connector: {} } as never)).toThrow('COMPUTE_RESIDENT_CONNECTOR_INVALID')
    expect(() => new ResidentNodeRuntime({ ...base, capabilities: {} } as never)).toThrow('COMPUTE_RESIDENT_CAPABILITIES_INVALID')
    expect(() => new ResidentNodeRuntime({ ...base, port: {} } as never)).toThrow('COMPUTE_RESIDENT_PORT_INVALID')
    expect(() => new ResidentNodeRuntime({ ...base, workspace: {} } as never)).toThrow('COMPUTE_RESIDENT_WORKSPACE_INVALID')
    expect(() => new ResidentNodeRuntime({ ...base, resultConsumer: {} } as never)).toThrow('COMPUTE_RESIDENT_CONSUMER_INVALID')
    expect(() => new ResidentNodeRuntime({ ...base, stopTimeoutMs: 0 } as never)).toThrow('COMPUTE_RESIDENT_LIMITS_INVALID')
    expect(() => new ResidentNodeRuntime({ ...base, maxPendingOffers: 1_000 } as never)).toThrow('COMPUTE_RESIDENT_LIMITS_INVALID')
  })

  it('applies an owner policy replacement on the next tick', async () => {
    const subject = await node()
    await subject.runtime.start()
    expect(subject.runtime.policy().mode).toBe('BACKGROUND_ONLY')
    subject.runtime.setPolicy({ ...subject.runtime.policy(), mode: 'OFF' })
    expect(subject.runtime.policy().mode).toBe('OFF')
    await subject.pushOffer(subject.offer('task-after-off'))
    const tick = await subject.runtime.tickOnce()
    expect(tick.outcomes[0]).toMatchObject({ accepted: false })
    expect(subject.runs).toHaveLength(0)
  })
})
