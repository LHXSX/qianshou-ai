import { describe, expect, it, afterEach } from 'vitest'
import type { ContributorPolicy } from '@deepseek-ai/dsh-compute-core'
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

/** Policy helper so each case states only the field under test. */
function policy(overrides: Partial<ContributorPolicy>): Partial<ContributorPolicy> { return overrides }

describe('resident runtime: one full accepted offer', () => {
  it('runs offer -> accept -> execute -> progress -> upload -> return -> settle', async () => {
    const subject = await node()
    await subject.runtime.start()
    await subject.pushOffer(subject.offer('task-a'))

    const tick = await subject.runtime.tickOnce()
    // The accepted attempt is already running when the tick returns.
    expect(tick).toMatchObject({ sentHeartbeat: true, runningTasks: 1 })
    expect(tick.outcomes).toHaveLength(1)
    expect(tick.outcomes[0]).toMatchObject({ accepted: true, reason: 'ACCEPTED' })
    expect(tick.outcomes[0]?.attempt).toMatchObject({ taskId: 'task-a', attempt: 1, leaseId: 'lease-task-a-1' })

    await waitForStatus(subject, 'task-a', 'RETURNED')
    await waitFor(() => subject.runtime.inFlightCount() === 0, 'the returned attempt to be released')
    const session = subject.sessions()[0]
    expect(session).toBeDefined()

    // The local record reaches RETURNED and stops there: settlement is a
    // dispatch decision, never something the result send may claim on its own.
    expect(await subject.state('task-a')).toMatchObject({ status: 'RETURNED' })
    // The attempt keeps a projection but is no longer owned as in-flight work.
    expect(subject.runtime.activeAttempts().every(record => record.status === 'RETURNED')).toBe(true)

    // Progress and the result manifest crossed the transport seam in order.
    const progress = session?.progressFrames() ?? []
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ taskId: 'task-a', attempt: 1, sequence: 1, progress: 0.5, phase: 'executing' })
    const returns = session?.returnFrames() ?? []
    expect(returns).toHaveLength(1)
    expect(returns[0]?.outputs).toHaveLength(1)
    expect(returns[0]?.outputs[0]).toMatchObject({ name: 'out.txt' })

    // The capability ran inside a private per-attempt directory that was removed.
    expect(subject.runs).toHaveLength(1)
    const workspace = subject.workspaceOf('task-a')
    expect(workspace).toBeDefined()
    expect(subject.closedWorkspaces).toHaveLength(1)
    expect(await subject.workspaceExists(workspace as string)).toBe(false)

    // Dispatch-confirmed acceptance is the only path to a settled record.
    const settled = await subject.runtime.settle('task-a', 1)
    expect(settled.status).toBe('SETTLED')
    expect(await subject.state('task-a')).toMatchObject({ status: 'SETTLED', progress: 1 })
  })

  it('never claims a settled record without an explicit settlement confirmation', async () => {
    const subject = await node()
    await subject.runtime.start()
    await subject.pushOffer(subject.offer('task-b'))
    await subject.runtime.tickOnce()
    await waitForStatus(subject, 'task-b', 'RETURNED')
    expect(subject.runtime.activeAttempts().every(record => record.status !== 'SETTLED')).toBe(true)
  })
})

describe('resident runtime: promotion and refusal reasons', () => {
  it('stops accepting new invitations while the user is active', async () => {
    const subject = await node()
    await subject.runtime.start()
    subject.snapshot = { ...subject.snapshot, userActive: true }

    await subject.pushOffer(subject.offer('task-user-active'))
    const busy = await subject.runtime.tickOnce()
    expect(busy.outcomes[0]).toMatchObject({ accepted: false, reason: 'CANDIDATE_REJECTED', refusal: 'USER_ACTIVE' })
    // A busy-resource refusal is transient: nothing is written, so an idle retry
    // of the same still-valid lease can still be admitted.
    expect(busy.outcomes[0]?.state).toBeNull()
    await settle(2)
    expect(subject.runs).toHaveLength(0)
    expect(subject.decisionEvents().at(-1)).toMatchObject({ decision: 'refused', reason: 'USER_ACTIVE' })
    expect(await subject.state('task-user-active')).toBeNull()
    expect(subject.sessions()[0]?.returnFrames()).toHaveLength(0)

    // The machine goes idle and the same live lease is admitted.
    subject.snapshot = { ...subject.snapshot, userActive: false }
    await subject.pushOffer(subject.offer('task-user-active'))
    const idle = await subject.runtime.tickOnce()
    expect(idle.outcomes[0]).toMatchObject({ accepted: true, reason: 'ACCEPTED' })
    await waitForStatus(subject, 'task-user-active', 'RETURNED')
  })

  it('refuses every offer with a stable reason while contribution is OFF', async () => {
    const subject = await node({ policy: policy({ mode: 'OFF' }) })
    await subject.runtime.start()
    await subject.pushOffer(subject.offer('task-off'))

    const tick = await subject.runtime.tickOnce()
    expect(tick.outcomes[0]).toMatchObject({ accepted: false, reason: 'CANDIDATE_REJECTED', refusal: 'CAPABILITY_UNAVAILABLE' })
    expect(subject.runs).toHaveLength(0)
    expect(subject.decisionEvents().at(-1)).toMatchObject({ decision: 'refused', reason: 'CAPABILITY_UNAVAILABLE', taskId: 'task-off' })
    // OFF advertises no capability at all.
    expect(subject.sessions()[0]?.heartbeatFrames().every(heartbeat => heartbeat.capabilities.length === 0)).toBe(true)
  })

  it('refuses new offers while paused, keeps in-flight work and resumes', async () => {
    const subject = await node()
    await subject.runtime.start()
    subject.runtime.pause()
    expect(subject.runtime.state()).toBe('PAUSED')

    await subject.pushOffer(subject.offer('task-paused'))
    const paused = await subject.runtime.tickOnce()
    expect(paused.outcomes[0]).toMatchObject({ accepted: false, reason: 'LIFECYCLE_PAUSED' })
    expect(subject.runs).toHaveLength(0)
    expect(subject.sessions()[0]?.heartbeatFrames().at(-1)?.capabilities).toEqual([])

    await subject.runtime.resume()
    await subject.pushOffer(subject.offer('task-paused'))
    const resumed = await subject.runtime.tickOnce()
    expect(resumed.outcomes[0]).toMatchObject({ accepted: true, reason: 'ACCEPTED' })
    await waitForStatus(subject, 'task-paused', 'RETURNED')
  })

  it('treats a repeated invitation for the same attempt as idempotent', async () => {
    const subject = await node()
    await subject.runtime.start()
    const offer = subject.offer('task-repeat')
    await subject.pushOffer(offer)
    await subject.runtime.tickOnce()
    await waitForStatus(subject, 'task-repeat', 'RETURNED')
    await waitFor(() => subject.runtime.inFlightCount() === 0, 'the first attempt to be released')

    await subject.pushOffer(offer)
    const replay = await subject.runtime.tickOnce()
    // The replay is refused with the scheduler's concrete duplicate code.
    expect(replay.outcomes[0]).toMatchObject({ accepted: false, reason: 'CANDIDATE_REJECTED', refusal: 'DUPLICATE' })
    await settle(2)
    expect(subject.runs).toHaveLength(1)
    expect(await subject.state('task-repeat')).toMatchObject({ status: 'RETURNED' })
    expect(subject.sessions()[0]?.returnFrames()).toHaveLength(1)
    // One durable record for the attempt, no second execution.
    expect((await subject.states()).filter(record => record.taskId === 'task-repeat')).toHaveLength(1)
  })
})
