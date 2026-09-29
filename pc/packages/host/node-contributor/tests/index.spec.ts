import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputeCapabilityId, ComputeTaskId, EmployeeTaskCoordinator, verifyTaskAssignment, type ComputeTaskEnvelope, type ContributorPolicy } from '@deepseek-ai/dsh-compute-core'
import { ComputeNodeId } from '@deepseek-ai/dsh-compute-core/node-protocol'
import { ComputeTaskStore } from '@deepseek-ai/dsh-compute-core/task-store'
import { ContributionController, type ContributionCapability } from '../src/index.ts'

const now = '2026-09-15T12:00:00.000Z'
const expires = '2026-09-15T12:05:00.000Z'
const policy = { mode: 'BACKGROUND_ONLY' as const, maxConcurrency: 1, maxCpuPercent: 80, maxGpuPercent: 80, maxTemperatureC: 85, minDiskFreeBytes: 1_000, allowWhileUserActive: false }
const snapshot = {
  userActive: false, voiceActive: false, cpuPercent: 10, gpuPercent: 10,
  temperatureC: 40, diskFreeBytes: 100_000, runningTasks: 0,
}
const capability: ContributionCapability = { capabilityId: 'image.generate', version: '1.0.0', pluginDigest: 'a'.repeat(64), dataScope: 'task-inputs', maxInputBytes: 10_000, maxOutputBytes: 100_000, available: true }
const roots: string[] = []

function envelope(id = 'task-1', inputRefs: readonly { name: string; bytes: number; sha256: string }[] = []): ComputeTaskEnvelope {
  return { version: 'qianshou.task.v1', taskId: ComputeTaskId(id), capabilityId: ComputeCapabilityId('image.generate'), capabilityVersion: '1.0.0', inputRefs, parameters: { prompt: 'local' }, deadlineAt: '2026-09-15T12:10:00.000Z', maxOutputBytes: 10_000, idempotencyKey: `idem-${id}` }
}

async function setup(id = 'task-1', inputRefs: readonly { name: string; bytes: number; sha256: string }[] = [], configuredPolicy: ContributorPolicy = policy) {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-contributor-')); roots.push(root)
  const store = new ComputeTaskStore({ path: join(root, 'tasks.json'), maxTasks: 8, maxBytes: 65_536 })
  const coordinator = new EmployeeTaskCoordinator(store)
  const reportDecision = vi.fn(async () => {})
  const reportEarnings = vi.fn(async () => {})
  const publishHeartbeat = vi.fn(async () => {})
  const controller = new ContributionController({ nodeId: 'node-a', agentVersion: 'agent-1', policy: configuredPolicy, capabilitySource: { listCapabilities: () => [capability] }, coordinator, transport: { publishHeartbeat, reportDecision, reportEarnings } })
  const offer = await verifyTaskAssignment({ envelope: envelope(id, inputRefs), attempt: 1, leaseExpiresAt: expires, receivedAt: now }, `sig-${'a'.repeat(20)}`, async () => true)
  const lease = { version: 'qianshou.node.lease.v1' as const, leaseId: `lease-${id}`, taskId: id, attempt: 1, ownerNodeId: ComputeNodeId('node-a'), issuedAt: now, expiresAt: expires, idempotencyKey: `idem-${id}` }
  return { store, coordinator, controller, offer, lease, publishHeartbeat, reportDecision, reportEarnings }
}

afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })) ) })

describe('node contributor controller', () => {
  it('redacts inventory and publishes a heartbeat without local data', async () => {
    const { controller } = await setup()
    const value = controller.inventory(now)
    expect(value.advertisement.privacy).toEqual({ includesUserFiles: false, includesCredentials: false, includesMediaBytes: false })
    expect(JSON.stringify(value.heartbeat)).not.toMatch(/path|secret|prompt|media|token/iu)
    await controller.advertise(now)
    expect(controller.status()).toBe('ADVERTISED')
  })

  it('autonomously admits only a verified, exactly bound lease', async () => {
    const { controller, offer, lease, store } = await setup()
    const result = await controller.acceptOffer({ offer, lease, now, policy, snapshot })
    expect(result.coordination.action).toMatchObject({ type: 'accept', interactionPolicy: 'autonomous' })
    expect(result.lease).toMatchObject({ state: 'ACCEPTED', ownerNodeId: 'node-a' })
    await expect(store.list()).resolves.toHaveLength(1)
  })

  it('refuses capability scope and lease binding violations before admission', async () => {
    const { controller, offer, lease, store } = await setup()
    await expect(controller.acceptOffer({ offer, lease: { ...lease, ownerNodeId: ComputeNodeId('node-b') }, now, policy, snapshot })).rejects.toThrow('COMPUTE_CONTRIBUTOR_LEASE_BINDING_INVALID')
    const blocked = await setup('task-2', [{ name: 'input', bytes: 4, sha256: 'b'.repeat(64) }])
    const restricted = new ContributionController({ nodeId: 'node-a', agentVersion: 'agent-1', policy, capabilitySource: { listCapabilities: () => [{ ...capability, dataScope: 'none' }] }, coordinator: blocked.coordinator, transport: { publishHeartbeat: vi.fn(async () => {}) } })
    await expect(restricted.acceptOffer({ offer: blocked.offer, lease: blocked.lease, now, policy, snapshot })).resolves.toMatchObject({ coordination: { action: { type: 'refuse', reason: 'CAPABILITY_UNAVAILABLE' } } })
    await expect(store.list()).resolves.toEqual([])
  })

  it('pauses and dispatch-revokes through the shared task store', async () => {
    const { controller, offer, lease } = await setup()
    await controller.acceptOffer({ offer, lease, now, policy, snapshot })
    const paused = await controller.pause(offer.envelope.taskId, 1, '2026-09-15T12:01:00.000Z')
    expect(paused.status).toBe('PAUSED')
    const revoked = await controller.revoke(offer.envelope.taskId, 1, lease.leaseId, 'dispatch cancellation', '2026-09-15T12:02:00.000Z')
    expect(revoked.status).toBe('REVOKED')
  })

  it('references a pending billing ledger event only after lease completion', async () => {
    const { controller, offer, lease, reportEarnings } = await setup()
    await controller.acceptOffer({ offer, lease, now, policy, snapshot })
    await expect(controller.reportCompleted({} as never)).rejects.toThrow('COMPUTE_CONTRIBUTOR_EARNINGS_REFERENCE_INVALID')
    controller.completeLease(lease.leaseId, '2026-09-15T12:03:00.000Z')
    await controller.reportCompleted({ version: 'qianshou.node-contributor.v1', eventId: 'earn-1', nodeId: 'node-a', taskId: offer.envelope.taskId, attempt: 1, leaseId: lease.leaseId, acceptanceEvidenceRef: 'acceptance-1', occurredAt: '2026-09-15T12:04:00.000Z', ledgerEntry: { version: 'qianshou.node-earnings.v1', entryId: 'entry-1', nodeId: 'node-a', taskId: offer.envelope.taskId, kind: 'task_earnings', status: 'pending', amountMinor: 40, currency: 'CNY', idempotencyKey: 'ledger-1', occurredAt: '2026-09-15T12:04:00.000Z', reversesEntryId: null } })
    expect(reportEarnings).toHaveBeenCalledOnce()
  })

  it('withdraws advertised capabilities while the owner has sharing off', async () => {
    const { controller, offer, lease, store, publishHeartbeat } = await setup('off', [], { ...policy, mode: 'OFF' })
    expect(controller.inventory(now).heartbeat.capabilities).toEqual([])
    await controller.advertise(now)
    expect(publishHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ capabilities: [] }))
    expect(controller.status()).toBe('DISABLED')
    const result = await controller.acceptOffer({ offer, lease, now, policy, snapshot })
    expect(result.coordination.action).toMatchObject({ type: 'refuse', reason: 'POLICY_DENIED' })
    expect(await store.list()).toEqual([])
  })

  it('honors a newly disabled per-offer policy without broadening owner authorization', async () => {
    const { controller, offer, lease, store } = await setup()
    const result = await controller.acceptOffer({ offer, lease, now, policy: { ...policy, mode: 'OFF' }, snapshot })
    expect(result.coordination.action).toMatchObject({ type: 'refuse', reason: 'POLICY_DENIED' })
    expect(await store.list()).toEqual([])
    const denied = await controller.acceptOffer({
      offer, lease, now, policy: { ...policy, allowWhileUserActive: true }, snapshot: { ...snapshot, userActive: true },
    })
    expect(denied.coordination.action).toMatchObject({ type: 'refuse', reason: 'USER_ACTIVE' })
  })

  it.each([
    { active: { userActive: true }, reason: 'USER_ACTIVE' },
    { active: { voiceActive: true }, reason: 'VOICE_ACTIVE' },
  ])('keeps $reason offers retryable until the foreground is idle', async ({ active, reason }) => {
    const { controller, offer, lease, store } = await setup()
    const refused = await controller.acceptOffer({ offer, lease, now, policy, snapshot: { ...snapshot, ...active } })
    expect(refused.coordination.action).toMatchObject({ type: 'refuse', reason })
    expect(await store.list()).toEqual([])
    const accepted = await controller.acceptOffer({ offer, lease, now, policy, snapshot })
    expect(accepted.coordination.action.type).toBe('accept')
    expect(await store.list()).toHaveLength(1)
  })

  it('preserves the visible status when persisting a pause fails', async () => {
    const { controller } = await setup()
    const before = controller.status()
    await expect(controller.pause('missing', 1, now)).rejects.toThrow()
    expect(controller.status()).toBe(before)
  })

  it('applies stricter current resource limits and rejects unavailable facts', async () => {
    const { controller, offer, lease, store } = await setup()
    const result = await controller.acceptOffer({ offer, lease, now, policy: { ...policy, maxCpuPercent: 5 }, snapshot })
    expect(result.coordination.action).toMatchObject({ type: 'refuse', reason: 'CPU_LIMIT' })
    await expect(controller.acceptOffer({ offer, lease, now, policy, snapshot: { ...snapshot, cpuPercent: Number.NaN } })).rejects.toThrow('COMPUTE_CONTRIBUTOR_SNAPSHOT_INVALID')
    expect(await store.list()).toEqual([])
  })

  it('retains the owner authorization independently of caller object mutation', async () => {
    const configuredPolicy: ContributorPolicy = { ...policy, mode: 'OFF' }
    const { controller, offer, lease, store } = await setup('owner-off', [], configuredPolicy)
    configuredPolicy.mode = 'BACKGROUND_ONLY'
    const result = await controller.acceptOffer({ offer, lease, now, policy, snapshot })
    expect(result.coordination.action).toMatchObject({ type: 'refuse', reason: 'POLICY_DENIED' })
    expect(controller.inventory(now).heartbeat.capabilities).toEqual([])
    expect(await store.list()).toEqual([])
  })

  it('reports failed heartbeat publication without leaving a checking state', async () => {
    const { controller, publishHeartbeat } = await setup()
    publishHeartbeat.mockRejectedValueOnce(new Error('disconnected'))
    await expect(controller.advertise(now)).rejects.toThrow('disconnected')
    expect(controller.status()).toBe('OFFLINE')
  })

  it('preserves the lease when the shared task store rejects revocation', async () => {
    const { controller, coordinator, offer, lease } = await setup()
    await controller.acceptOffer({ offer, lease, now, policy, snapshot })
    await coordinator.transition(offer.envelope.taskId, 1, { type: 'start' }, now)
    await coordinator.transition(offer.envelope.taskId, 1, { type: 'upload' }, now)
    await coordinator.transition(offer.envelope.taskId, 1, { type: 'return' }, now)
    await expect(controller.revoke(offer.envelope.taskId, 1, lease.leaseId, 'too late', now)).rejects.toThrow('COMPUTE_TASK_TRANSITION_INVALID')
    expect(controller.completeLease(lease.leaseId, now).state).toBe('COMPLETED')
  })

  it('drains an in-flight heartbeat and never reopens its closed state', async () => {
    const { controller, publishHeartbeat } = await setup()
    const heartbeat = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    publishHeartbeat.mockImplementation(async () => { entered.resolve(undefined); await heartbeat.promise })
    const advertising = controller.advertise(now)
    const observed = advertising.then(() => 'published', () => 'closed')
    await entered.promise
    let drained = false
    const closing = controller.close().then(() => { drained = true })
    await setImmediate()
    expect(drained).toBe(false)
    heartbeat.resolve(undefined)
    await observed
    await closing
    expect(controller.status()).toBe('CLOSED')
    await expect(controller.advertise(now)).rejects.toThrow('COMPUTE_CLOSED')
  })

  it('drains an accepted report on close and preserves the durable attempt for reconciliation', async () => {
    const { controller, reportDecision, offer, lease, store } = await setup()
    const report = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    reportDecision.mockImplementation(async () => { entered.resolve(undefined); await report.promise })
    const admission = controller.acceptOffer({ offer, lease, now, policy, snapshot })
    const observed = admission.then(() => 'accepted', () => 'closed')
    await entered.promise
    let drained = false
    const closing = controller.close().then(() => { drained = true })
    await setImmediate()
    expect(drained).toBe(false)
    report.resolve(undefined)
    expect(await observed).toBe('closed')
    await closing
    expect(controller.status()).toBe('CLOSED')
    expect(await store.get(offer.envelope.taskId, 1)).toMatchObject({ status: 'ACCEPTED' })
    expect(reportDecision).toHaveBeenCalledOnce()
  })
})
