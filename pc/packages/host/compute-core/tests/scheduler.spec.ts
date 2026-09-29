import { describe, expect, it } from 'vitest'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from '../src/protocol.ts'
import { decideSchedulerCycle, type SchedulerCycleInput } from '../src/scheduler.ts'
import type { ContributorPolicy, ContributorSnapshot } from '../src/contributor-policy.ts'
import type { ComputeTaskState } from '../src/task-state.ts'

const now = '2026-09-14T12:00:00.000Z'
const policy: ContributorPolicy = { mode: 'BACKGROUND_ONLY', maxConcurrency: 2, maxCpuPercent: 80, maxGpuPercent: 80, maxTemperatureC: 85, minDiskFreeBytes: 1_000, allowWhileUserActive: false }
const snapshot: ContributorSnapshot = {
  userActive: false, voiceActive: false, cpuPercent: 10, gpuPercent: 10,
  temperatureC: 40, diskFreeBytes: 100_000, runningTasks: 0,
}
const envelope = (taskId = 'task-1'): ComputeTaskEnvelope => ({ version: 'qianshou.task.v1', taskId: ComputeTaskId(taskId), capabilityId: ComputeCapabilityId('image'), capabilityVersion: '1.0.0', inputRefs: [], parameters: { prompt: 'x' }, deadlineAt: '2026-09-14T12:10:00.000Z', maxOutputBytes: 1000, idempotencyKey: `idem-${taskId}` })
const base = (offers: SchedulerCycleInput['offers'] = [{ envelope: envelope(), attempt: 1, leaseExpiresAt: '2026-09-14T12:05:00.000Z', receivedAt: now }]): SchedulerCycleInput => ({ now, policy, snapshot, offers, activeTasks: [], availableCapabilities: new Set(['image@1.0.0']), maxOffers: 8 })

describe('autonomous employee scheduler', () => {
  it('accepts an exact local capability with autonomous main-conversation priority', () => {
    const result = decideSchedulerCycle(base())
    expect(result.actions[0]).toMatchObject({ type: 'accept', interactionPolicy: 'autonomous', priority: 'main-conversation-first' })
    expect((result.actions[0] as { envelopeFingerprint: string }).envelopeFingerprint).toHaveLength(64)
  })
  it('requires the advertised plugin digest when a node publishes digest-backed capabilities', () => {
    const digest = 'a'.repeat(64)
    const offer = { envelope: envelope('digest-ok'), capabilityPluginDigest: digest, attempt: 1, leaseExpiresAt: '2026-09-14T12:05:00.000Z', receivedAt: now }
    const availableCapabilities = new Set([`image@1.0.0@${digest}`])
    expect(decideSchedulerCycle({ ...base([offer]), availableCapabilities }).actions[0]).toMatchObject({ type: 'accept' })
    expect(decideSchedulerCycle({ ...base([{ ...offer, envelope: envelope('digest-bad'), capabilityPluginDigest: 'b'.repeat(64) }]), availableCapabilities }).actions[0]).toMatchObject({ type: 'refuse', reason: 'CAPABILITY_UNAVAILABLE' })
    const missingDigestOffer = { envelope: envelope('digest-missing'), attempt: 1, leaseExpiresAt: offer.leaseExpiresAt, receivedAt: offer.receivedAt }
    expect(decideSchedulerCycle({ ...base([missingDigestOffer]), availableCapabilities }).actions[0]).toMatchObject({ type: 'refuse', reason: 'CAPABILITY_UNAVAILABLE' })
  })
  it('refuses all offers when policy or voice activity blocks contribution', () => {
    const result = decideSchedulerCycle({ ...base(), snapshot: { ...snapshot, voiceActive: true } })
    expect(result.admission).toEqual({ accepted: false, reason: 'VOICE_ACTIVE' })
    expect(result.actions[0]).toMatchObject({ type: 'refuse', reason: 'VOICE_ACTIVE' })
  })
  it('fails closed for expired deadlines, invalid leases and unavailable versions', () => {
    const result = decideSchedulerCycle(base([
      { envelope: { ...envelope('expired'), deadlineAt: '2026-09-14T11:59:00.000Z' }, attempt: 1, leaseExpiresAt: '2026-09-14T11:58:00.000Z', receivedAt: now },
      { envelope: envelope('bad-lease'), attempt: 1, leaseExpiresAt: '2026-09-14T12:11:00.000Z', receivedAt: now },
      { envelope: { ...envelope('missing'), capabilityVersion: '9.0.0' }, attempt: 1, leaseExpiresAt: '2026-09-14T12:05:00.000Z', receivedAt: now },
    ]))
    expect(result.actions.map(a => a.type === 'refuse' ? a.reason : '')).toEqual(['DEADLINE_EXPIRED', 'LEASE_INVALID', 'CAPABILITY_UNAVAILABLE'])
  })
  it('refuses malformed runtime offers without throwing', () => {
    const result = decideSchedulerCycle({ ...base([null, [], {}] as unknown as SchedulerCycleInput['offers']) })
    expect(result.actions).toEqual([
      { type: 'refuse', taskId: null, attempt: null, reason: 'OFFER_INVALID' },
      { type: 'refuse', taskId: null, attempt: null, reason: 'OFFER_INVALID' },
      { type: 'refuse', taskId: null, attempt: null, reason: 'OFFER_INVALID' },
    ])
  })
  it('does not re-admit active attempts or duplicate offers', () => {
    const active: ComputeTaskState = { taskId: ComputeTaskId('task-1'), attempt: 1, envelopeFingerprint: 'a'.repeat(64), idempotencyKey: 'idem-task-1', status: 'EXECUTING', leaseExpiresAt: '2026-09-14T12:05:00.000Z', progress: 0, updatedAt: now }
    const result = decideSchedulerCycle({ ...base([base().offers[0]!, base().offers[0]!]), activeTasks: [active] })
    expect(result.actions.every(a => a.type === 'refuse' && a.reason === 'DUPLICATE')).toBe(true)
  })
  it('reserves concurrency slots across offers in one cycle', () => {
    const offers = ['a', 'b', 'c'].map((id, index) => ({ envelope: envelope(id), attempt: 1, leaseExpiresAt: `2026-09-14T12:0${5 + index}:00.000Z`, receivedAt: now }))
    const result = decideSchedulerCycle({ ...base(offers), maxOffers: 8 })
    expect(result.actions.filter(action => action.type === 'accept')).toHaveLength(2)
    expect(result.actions[2]).toMatchObject({ type: 'refuse', reason: 'CONCURRENCY_LIMIT' })
  })
})
