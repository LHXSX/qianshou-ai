import { describe, expect, it } from 'vitest'
import { decideContribution, type ContributorPolicy, type ContributorSnapshot } from '../src/contributor-policy.ts'

const policy: ContributorPolicy = { mode: 'BACKGROUND_ONLY', maxConcurrency: 2, maxCpuPercent: 70, maxGpuPercent: 70, maxTemperatureC: 80, minDiskFreeBytes: 1_000, allowWhileUserActive: false }
const snapshot: ContributorSnapshot = {
  userActive: false, voiceActive: false, cpuPercent: 20, gpuPercent: 40,
  temperatureC: 60, diskFreeBytes: 10_000, runningTasks: 0,
}

describe('employee contribution policy', () => {
  it('rejects malformed runtime policy and snapshot values with stable errors', () => {
    expect(() => decideContribution(null as unknown as ContributorPolicy, snapshot)).toThrow('COMPUTE_CONTRIBUTOR_POLICY_INVALID')
    expect(() => decideContribution(policy, [] as unknown as ContributorSnapshot)).toThrow('COMPUTE_CONTRIBUTOR_SNAPSHOT_INVALID')
  })
  it('accepts only when explicit user mode and resource limits allow a task', () => {
    expect(decideContribution(policy, snapshot)).toEqual({ accepted: true, reason: 'READY' })
  })

  it.each([
    ['mode', { ...policy, mode: 'OFF' }, snapshot, 'POLICY_DENIED'],
    ['user activity', policy, { ...snapshot, userActive: true }, 'USER_ACTIVE'],
    ['voice activity', policy, { ...snapshot, voiceActive: true }, 'VOICE_ACTIVE'],
    ['GPU limit', policy, { ...snapshot, gpuPercent: 71 }, 'GPU_LIMIT'],
    ['CPU limit', policy, { ...snapshot, cpuPercent: 71 }, 'CPU_LIMIT'],
    ['temperature', policy, { ...snapshot, temperatureC: 81 }, 'TEMPERATURE_LIMIT'],
    ['disk', policy, { ...snapshot, diskFreeBytes: 999 }, 'DISK_LOW'],
    ['concurrency', policy, { ...snapshot, runningTasks: 2 }, 'CONCURRENCY_LIMIT'],
  ] as const)('returns a deterministic refusal for %s', (_name, selectedPolicy, selectedSnapshot, reason) => {
    expect(decideContribution(selectedPolicy, selectedSnapshot)).toEqual({ accepted: false, reason })
  })

  it('rejects malformed policy and resource observations instead of inventing safe defaults', () => {
    expect(() => decideContribution({ ...policy, maxConcurrency: 0 }, snapshot)).toThrow('COMPUTE_CONTRIBUTOR_POLICY_INVALID')
    expect(() => decideContribution(policy, { ...snapshot, gpuPercent: Number.NaN })).toThrow('COMPUTE_CONTRIBUTOR_SNAPSHOT_INVALID')
  })
})
