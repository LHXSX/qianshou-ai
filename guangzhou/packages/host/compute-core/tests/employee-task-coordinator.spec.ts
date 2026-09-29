import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputeTaskId, ComputeCapabilityId, type ComputeTaskEnvelope } from '../src/protocol.ts'
import { verifyTaskAssignment } from '../src/envelope-security.ts'
import { ComputeTaskStore } from '../src/task-store.ts'
import { EmployeeTaskCoordinator, type EmployeeTaskCoordinateInput, type VerifiedEmployeeTaskOffer } from '../src/employee-task-coordinator.ts'

const now = '2026-09-14T12:00:00.000Z'
const lease = '2026-09-14T12:05:00.000Z'
const policy = { mode: 'BACKGROUND_ONLY' as const, maxConcurrency: 2, maxCpuPercent: 80, maxGpuPercent: 80, maxTemperatureC: 85, minDiskFreeBytes: 1_000, allowWhileUserActive: false }
const snapshot = {
  userActive: false, voiceActive: false, cpuPercent: 10, gpuPercent: 10,
  temperatureC: 40, diskFreeBytes: 100_000, runningTasks: 0,
}
const roots: string[] = []

function envelope(id = 'employee-1'): ComputeTaskEnvelope {
  return { version: 'qianshou.task.v1', taskId: ComputeTaskId(id), capabilityId: ComputeCapabilityId('image'), capabilityVersion: '1.0.0', inputRefs: [], parameters: { prompt: 'x' }, deadlineAt: '2026-09-14T12:10:00.000Z', maxOutputBytes: 1000, idempotencyKey: `idem-${id}` }
}

async function input(offerEnvelope = envelope()): Promise<EmployeeTaskCoordinateInput> {
  const offer = await verifyTaskAssignment({ envelope: offerEnvelope, attempt: 1, leaseExpiresAt: lease, receivedAt: now }, 'sig-' + 'a'.repeat(20), async () => true)
  return { offer: offer, now, policy, snapshot, availableCapabilities: new Set(['image@1.0.0']) }
}

async function setup(): Promise<{ store: ComputeTaskStore; coordinator: EmployeeTaskCoordinator }> {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-coordinator-')); roots.push(root)
  const store = new ComputeTaskStore({ path: join(root, 'tasks.json'), maxTasks: 8, maxBytes: 65536 })
  return { store, coordinator: new EmployeeTaskCoordinator(store) }
}

afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })) ) })

describe('employee task coordinator', () => {
  it('atomically stores and accepts a verified offer', async () => {
    const { store, coordinator } = await setup()
    const result = await coordinator.coordinate(await input())
    expect(result.action).toMatchObject({ type: 'accept', interactionPolicy: 'autonomous' })
    expect(result.state).toMatchObject({ taskId: 'employee-1', status: 'ACCEPTED', leaseExpiresAt: lease })
    await expect(store.list()).resolves.toHaveLength(1)
    await store.close(); await coordinator.close()
  })

  it('serializes replay offers and keeps one accepted attempt', async () => {
    const { store, coordinator } = await setup()
    const [firstInput, secondInput] = await Promise.all([input(), input()])
    const [first, second] = await Promise.all([coordinator.coordinate(firstInput), coordinator.coordinate(secondInput)])
    expect(first.action.type).toBe('accept')
    expect(second.action).toMatchObject({ type: 'refuse', reason: 'DUPLICATE' })
    await expect(store.list()).resolves.toHaveLength(1)
    await store.close(); await coordinator.close()
  })

  it('does not write refused offers and rejects an unverified envelope', async () => {
    const { store, coordinator } = await setup()
    const baseInput = await input()
    const refused = await coordinator.coordinate({ ...baseInput, snapshot: { ...snapshot, voiceActive: true } })
    expect(refused.action).toMatchObject({ type: 'refuse', reason: 'VOICE_ACTIVE' })
    await expect(store.list()).resolves.toEqual([])
    const unverifiedInput = await input()
    await expect(coordinator.coordinate({ ...unverifiedInput, offer: { ...unverifiedInput.offer, verified: false } as unknown as VerifiedEmployeeTaskOffer })).rejects.toThrow('COMPUTE_TASK_NOT_VERIFIED')
    await store.close(); await coordinator.close()
  })

  it('rejects a forged spread copy even when verified markers and fingerprints are retained', async () => {
    const { store, coordinator } = await setup()
    const original = (await input()).offer
    const admitted = await verifyTaskAssignment({
      envelope: original.envelope,
      attempt: original.attempt,
      leaseExpiresAt: original.leaseExpiresAt,
      receivedAt: original.receivedAt,
    }, 'signed-' + 'a'.repeat(20), async () => true)
    const forged = { ...admitted }

    expect(forged.verified).toBe(true)
    expect(forged.envelopeFingerprint).toBe(admitted.envelopeFingerprint)
    expect(forged.assignmentFingerprint).toBe(admitted.assignmentFingerprint)
    const forgedInput = await input()
    await expect(coordinator.coordinate({ ...forgedInput, offer: forged })).rejects.toThrow('COMPUTE_TASK_NOT_VERIFIED')
    await expect(store.list()).resolves.toEqual([])
    await store.close(); await coordinator.close()
  })

  it.each([
    ['attempt', { attempt: 2 }],
    ['lease expiry', { leaseExpiresAt: '2026-09-14T12:06:00.000Z' }],
  ])('rejects %s tampering on a copied assignment credential', async (_name, change) => {
    const { store, coordinator } = await setup()
    const original = (await input()).offer
    const forged = { ...original, ...change }
    const destination = await input()

    await expect(coordinator.coordinate({ ...destination, offer: forged })).rejects.toThrow('COMPUTE_TASK_NOT_VERIFIED')
    await expect(store.list()).resolves.toEqual([])
    await store.close(); await coordinator.close()
  })

  it('records terminal capability refusal atomically to prevent replay storms', async () => {
    const { store, coordinator } = await setup()
    const baseInput = await input()
    const refused = await coordinator.coordinate({ ...baseInput, availableCapabilities: new Set() })
    expect(refused.action).toMatchObject({ type: 'refuse', reason: 'CAPABILITY_UNAVAILABLE' })
    expect(refused.state).toMatchObject({ status: 'REFUSED', decisionReason: 'CAPABILITY_UNAVAILABLE' })
    const replay = await coordinator.coordinate({ ...baseInput, availableCapabilities: new Set(['image@1.0.0']) })
    expect(replay.action).toMatchObject({ type: 'refuse', reason: 'DUPLICATE' })
    await expect(store.list()).resolves.toHaveLength(1)
    await store.close(); await coordinator.close()
  })

  it('fails closed after close without touching the task store', async () => {
    const { store, coordinator } = await setup()
    await coordinator.close()
    await expect(coordinator.coordinate(await input())).rejects.toThrow('COMPUTE_CLOSED')
    await expect(store.list()).resolves.toEqual([])
    await store.close()
  })

  it('enforces concurrency again inside the shared store lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-coordinator-race-')); roots.push(root)
    const path = join(root, 'tasks.json')
    const firstStore = new ComputeTaskStore({ path, maxTasks: 8, maxBytes: 65536 })
    const secondStore = new ComputeTaskStore({ path, maxTasks: 8, maxBytes: 65536 })
    const first = new EmployeeTaskCoordinator(firstStore)
    const second = new EmployeeTaskCoordinator(secondStore)
    const [firstInput, secondInput] = await Promise.all([input(), input(envelope('employee-2'))])
    const result = await Promise.all([
      first.coordinate({ ...firstInput, policy: { ...policy, maxConcurrency: 1 } }),
      second.coordinate({ ...secondInput, policy: { ...policy, maxConcurrency: 1 } }),
    ])
    expect(result.filter(item => item.action.type === 'accept')).toHaveLength(1)
    expect(result.filter(item => item.action.type === 'refuse' && item.action.reason === 'CONCURRENCY_LIMIT')).toHaveLength(1)
    await first.close(); await second.close(); await firstStore.close(); await secondStore.close()
  })
})
