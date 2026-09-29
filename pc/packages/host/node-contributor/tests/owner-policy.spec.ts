import { describe, expect, it } from 'vitest'
import type { ContributorPolicy, SupplyPolicy } from '@deepseek-ai/dsh-compute-core'
import type { ResidentCapability } from '@deepseek-ai/dsh-compute-core/resident'
import { projectOwnerAdmission as project, type OwnerAdmissionFacts } from '../src/owner-policy.ts'

const deployment: ContributorPolicy = { mode: 'BACKGROUND_ONLY', maxConcurrency: 4, maxCpuPercent: 50,
  maxGpuPercent: 0, maxTemperatureC: 80, minDiskFreeBytes: 0, allowWhileUserActive: true }
const owner: SupplyPolicy = { mode: 'idle', maxConcurrency: 2, minIdleSeconds: 3600,
  minFreeMemoryBytes: 100, enabledServiceIds: ['node'], nodeRates: [] }
const facts: OwnerAdmissionFacts = { activity: { userActive: false, idleSeconds: 3600, unavailable: null },
  voiceActive: false, foregroundTaskActive: false, freeMemoryBytes: 100, runningTasks: 1 }
const capability: ResidentCapability = { capabilityId: 'text.transform',
  version: '1.0.0', pluginDigest: 'a'.repeat(64), dataScope: 'none', maxInputBytes: 0, maxOutputBytes: 1024, available: true }

function projectOwnerAdmission(
  deployment: ContributorPolicy, owner: SupplyPolicy | null, facts: OwnerAdmissionFacts,
  capabilities: readonly ResidentCapability[], taskTypes: readonly string[] = ['word_count'],
) {
  return project(deployment, owner, facts, capabilities, taskTypes)
}

describe('saved owner admission', () => {
  it('authorizes a verified native author alias through video.render without borrowing another task proof', () => {
    const video: ResidentCapability = { ...capability, capabilityId: 'video.render' }
    const alias = 'qianshou_h3_device_config_v1'
    expect(project(deployment, owner, facts, [video], [alias], [], [alias]).capabilities[0]?.available).toBe(true)
    expect(project(deployment, owner, facts, [video], [alias], [], ['video_generate']).capabilities[0]?.available).toBe(false)
    expect(project(deployment, { ...owner, enabledServiceIds: [] }, facts, [video], [alias], [], [alias])
      .capabilities[0]?.available).toBe(false)
  })
  it('authorizes native video through the same service only after the exact media task is locally verified', () => {
    const video: ResidentCapability = { ...capability, capabilityId: 'video.render' }
    expect(project(deployment, owner, facts, [video], ['video_generate'], [], ['video_generate'])
      .capabilities[0]?.available).toBe(true)
    expect(project(deployment, owner, facts, [video], ['video_generate'], [], ['bar_chart_svg_v1'])
      .reasons).toContain('NO_AUTHORIZED_SERVICE')
    expect(project(deployment, { ...owner, mode: 'off' }, facts, [video], ['video_generate'], [], ['video_generate'])
      .capabilities[0]?.available).toBe(false)
  })
  it('uses the stricter concurrency ceiling and keeps exact memory/idle thresholds eligible', () => {
    const result = projectOwnerAdmission(deployment, owner, facts, [capability])
    expect(result.reasons).toEqual([])
    expect(result.policy).toMatchObject({ mode: 'BACKGROUND_ONLY', maxConcurrency: 2 })
    expect(result.capabilities[0]?.available).toBe(true)
    expect(projectOwnerAdmission({ ...deployment, maxConcurrency: 1 }, owner,
      { ...facts, runningTasks: 0 }, [capability]).policy.maxConcurrency).toBe(1)
  })

  it.each([
    [{ ...facts, activity: { ...facts.activity, idleSeconds: 3599 } }, 'USER_ACTIVE'],
    [{ ...facts, activity: { userActive: null, idleSeconds: null, unavailable: 'IDLE_PROBE_FAILED' } }, 'IDLE_STATE_UNKNOWN'],
    [{ ...facts, freeMemoryBytes: 99 }, 'MEMORY_LIMIT'],
    [{ ...facts, freeMemoryBytes: null }, 'MEMORY_STATE_UNKNOWN'],
    [{ ...facts, freeMemoryBytes: Number.NaN }, 'MEMORY_STATE_UNKNOWN'],
    [{ ...facts, runningTasks: 2 }, 'CONCURRENCY_LIMIT'],
    [{ ...facts, voiceActive: null }, 'VOICE_ACTIVITY_UNKNOWN'],
    [{ ...facts, voiceActive: true }, 'VOICE_ACTIVE'],
    [{ ...facts, foregroundTaskActive: true }, 'FOREGROUND_PRIORITY'],
    [{ ...facts, foregroundTaskActive: null }, 'HOST_ACTIVITY_UNKNOWN'],
  ] as const)('withdraws admission and heartbeat capabilities for %j', (observation, reason) => {
    const result = projectOwnerAdmission(deployment, owner, observation, [capability])
    expect(result.reasons).toContain(reason)
    expect(result.policy.mode).toBe('OFF')
    expect(result.capabilities.every(item => !item.available)).toBe(true)
  })

  it('allows active use only under both saved allowed mode and deployment authorization', () => {
    const active = { ...facts, activity: { userActive: true, idleSeconds: 0, unavailable: null } }
    expect(projectOwnerAdmission(deployment, { ...owner, mode: 'allowed' }, active, [capability]).reasons).toEqual([])
    expect(projectOwnerAdmission({ ...deployment, allowWhileUserActive: false },
      { ...owner, mode: 'allowed' }, active, [capability]).reasons).toContain('USER_ACTIVE')
    expect(projectOwnerAdmission(deployment, owner, active, [capability]).reasons).toContain('USER_ACTIVE')
  })

  it('requires the actual runner service and never treats an unrelated selected tool as permission', () => {
    for (const enabledServiceIds of [[], ['ffmpeg'], ['text.transform']]) {
      const result = projectOwnerAdmission(deployment, { ...owner, enabledServiceIds }, facts, [capability])
      expect(result.reasons).toContain('NO_AUTHORIZED_SERVICE')
      expect(result.capabilities[0]?.available).toBe(false)
    }
    expect(projectOwnerAdmission(deployment, owner, facts, [capability],
      ['word_count', 'base64_decode']).reasons).toContain('NO_AUTHORIZED_SERVICE')
    expect(projectOwnerAdmission(deployment, owner, facts, [capability], ['base64_decode']).reasons).toContain('NO_AUTHORIZED_SERVICE')
    const unknownBinding = { ...capability, capabilityId: 'image.generate' }
    expect(projectOwnerAdmission(deployment, owner, facts, [unknownBinding]).reasons).toContain('NO_AUTHORIZED_SERVICE')
  })

  it('allows a receipt-backed purchased capability only while the owner enabled node supply', () => {
    const bought = { ...capability, capabilityId: 'legal.term_scan' }
    const enabled = project(deployment, owner, facts, [bought], [], [], [], ['legal.term_scan'])
    expect(enabled.reasons).toEqual([])
    expect(enabled.capabilities[0]?.available).toBe(true)
    const off = project(deployment, { ...owner, mode: 'off' }, facts,
      [bought], [], [], [], ['legal.term_scan'])
    expect(off.capabilities[0]?.available).toBe(false)
    const noGrant = project(deployment, { ...owner, enabledServiceIds: [] }, facts,
      [bought], [], [], [], ['legal.term_scan'])
    expect(noGrant.capabilities[0]?.available).toBe(false)
  })

  it('withdraws off or missing policy without mutating the deployment or capability source', () => {
    expect(projectOwnerAdmission(deployment, null, facts, [capability]).reasons).toContain('OWNER_POLICY_UNAVAILABLE')
    expect(projectOwnerAdmission(deployment, { ...owner, mode: 'off' }, facts, [capability]).reasons).toContain('OWNER_DISABLED')
    expect(projectOwnerAdmission({ ...deployment, mode: 'OFF' }, owner, facts, [capability]).reasons).toContain('DEPLOYMENT_DISABLED')
    expect(deployment.mode).toBe('BACKGROUND_ONLY')
    expect(capability.available).toBe(true)
  })
})
