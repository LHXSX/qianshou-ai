import { describe, expect, it, vi } from 'vitest'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from '../src/protocol.ts'
import { verifyTaskAssignment, type VerifiedComputeTaskAssignment } from '../src/envelope-security.ts'
import { ResidentTaskLoop, createResidentHeartbeat, type ResidentLoopEffects } from '../src/resident-loop.ts'

const now = '2026-09-15T12:00:00.000Z'
const policy = { mode: 'BACKGROUND_ONLY' as const, maxConcurrency: 2, maxCpuPercent: 80, maxGpuPercent: 80, maxTemperatureC: 85, minDiskFreeBytes: 1_000, allowWhileUserActive: false }
const snapshot = {
  userActive: false, voiceActive: false, cpuPercent: 10, gpuPercent: 10,
  temperatureC: 40, diskFreeBytes: 100_000, runningTasks: 0,
}

function envelope(taskId: string): ComputeTaskEnvelope {
  return { version: 'qianshou.task.v1', taskId: ComputeTaskId(taskId), capabilityId: ComputeCapabilityId('image'), capabilityVersion: '1.0.0', inputRefs: [], parameters: { prompt: 'x' }, deadlineAt: '2026-09-15T12:10:00.000Z', maxOutputBytes: 1000, idempotencyKey: `idem-${taskId}` }
}

async function offer(taskId: string): Promise<VerifiedComputeTaskAssignment> {
  return verifyTaskAssignment({ envelope: envelope(taskId), attempt: 1, leaseExpiresAt: '2026-09-15T12:05:00.000Z', receivedAt: now }, 'sig-' + 'a'.repeat(20), async () => true)
}

describe('resident task loop', () => {
  it('emits a redacted heartbeat before admitting offers in order', async () => {
    const events: string[] = []
    const effects: ResidentLoopEffects = {
      sendHeartbeat: async (heartbeat) => { events.push(`heartbeat:${heartbeat.status}`) },
      coordinate: async (input) => {
        events.push(`offer:${input.offer.envelope.taskId}`)
        return {
          decision: { admission: { accepted: true, reason: 'READY' }, actions: [] },
          action: {
            type: 'accept', taskId: input.offer.envelope.taskId, attempt: 1,
            leaseExpiresAt: '2026-09-15T12:05:00.000Z', envelopeFingerprint: input.offer.envelopeFingerprint,
            interactionPolicy: 'autonomous', priority: 'main-conversation-first',
          }, state: null,
        }
      },
    }
    const result = await new ResidentTaskLoop(effects).tick({ now, policy, snapshot, availableCapabilities: new Set(['image@1.0.0']), offers: [await offer('a'), await offer('b')] })
    expect(events).toEqual(['heartbeat:IDLE', 'offer:a', 'offer:b'])
    expect(result.heartbeat.availableCapabilities).toEqual(['image@1.0.0'])
    expect(result.outcomes).toHaveLength(2)
  })

  it('serializes overlapping ticks and rejects work after close', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const effects: ResidentLoopEffects = {
      sendHeartbeat: async (heartbeat) => { order.push(heartbeat.now); if (order.length === 1) await gate },
      coordinate: async () => ({ decision: { admission: { accepted: false, reason: 'POLICY_DENIED' }, actions: [] }, action: { type: 'refuse', taskId: null, attempt: null, reason: 'POLICY_DENIED' }, state: null }),
    }
    const loop = new ResidentTaskLoop(effects)
    const first = loop.tick({ now, policy, snapshot, availableCapabilities: new Set(), offers: [] })
    const second = loop.tick({ now: '2026-09-15T12:00:01.000Z', policy, snapshot, availableCapabilities: new Set(), offers: [] })
    await Promise.resolve()
    expect(order).toEqual([now])
    release?.()
    await Promise.all([first, second])
    expect(order).toEqual([now, '2026-09-15T12:00:01.000Z'])
    await loop.close()
    await expect(loop.tick({ now, policy, snapshot, availableCapabilities: new Set(), offers: [] })).rejects.toThrow('COMPUTE_CLOSED')
  })

  it('fails before transport effects on malformed timestamps', async () => {
    const sendHeartbeat = vi.fn(async () => undefined)
    const effects: ResidentLoopEffects = { sendHeartbeat, coordinate: vi.fn() }
    await expect(new ResidentTaskLoop(effects).tick({ now: 'bad', policy, snapshot, availableCapabilities: new Set(), offers: [] })).rejects.toThrow('COMPUTE_TASK_TIMESTAMP_INVALID')
    expect(sendHeartbeat).not.toHaveBeenCalled()
  })

  it('fails closed before a heartbeat on an impossible resource snapshot', async () => {
    const sendHeartbeat = vi.fn(async () => undefined)
    const effects: ResidentLoopEffects = { sendHeartbeat, coordinate: vi.fn() }
    await expect(new ResidentTaskLoop(effects).tick({ now, policy, snapshot: { ...snapshot, cpuPercent: 101 }, availableCapabilities: new Set(), offers: [] })).rejects.toThrow('COMPUTE_RESOURCE_SNAPSHOT_INVALID')
    expect(sendHeartbeat).not.toHaveBeenCalled()
  })

  it('creates paused-free status from the current snapshot only', () => {
    expect(createResidentHeartbeat({ now, snapshot: { ...snapshot, runningTasks: 1 }, availableCapabilities: new Set(['z@1', 'a@1']) })).toEqual({ now, status: 'BUSY', runningTasks: 1, availableCapabilities: ['a@1', 'z@1'] })
  })
})
