import { describe, expect, it } from 'vitest'
import { ComputeTaskId } from '../src/protocol.ts'
import { transitionTask, type ComputeTaskState } from '../src/task-state.ts'

const t0 = '2026-09-14T12:00:00.000Z'
const t1 = '2026-09-14T12:01:00.000Z'
const t2 = '2026-09-14T12:02:00.000Z'
const initial: ComputeTaskState = { taskId: ComputeTaskId('task-1'), attempt: 1, envelopeFingerprint: 'a'.repeat(64), idempotencyKey: 'idem-1', status: 'OFFERED', leaseExpiresAt: null, progress: 0, updatedAt: t0 }
const apply = (state: ComputeTaskState, event: Parameters<typeof transitionTask>[1], now = t0) => transitionTask(state, event, now)

describe('passive task lifecycle', () => {
  it('requires a lease before execution and reaches settlement only after return', () => {
    let state = apply(initial, { type: 'accept', leaseExpiresAt: t2 })
    state = apply(state, { type: 'start' })
    state = apply(state, { type: 'progress', progress: 0.5 })
    state = apply(state, { type: 'upload' })
    state = apply(state, { type: 'return' })
    state = apply(state, { type: 'settle' })
    expect(state).toMatchObject({ status: 'SETTLED', progress: 1, leaseExpiresAt: t2 })
  })

  it('rejects non-monotonic progress, stale leases, and illegal settlement shortcuts', () => {
    expect(() => apply(initial, { type: 'settle' })).toThrow('COMPUTE_TASK_TRANSITION_INVALID')
    let state = apply(initial, { type: 'accept', leaseExpiresAt: t1 })
    state = apply(state, { type: 'start' })
    expect(() => apply(state, { type: 'progress', progress: 0.8 })).not.toThrow()
    state = apply(state, { type: 'progress', progress: 0.8 })
    expect(() => apply(state, { type: 'progress', progress: 0.2 })).toThrow('COMPUTE_TASK_PROGRESS_INVALID')
    expect(() => apply(state, { type: 'upload' }, t2)).toThrow('COMPUTE_TASK_LEASE_EXPIRED')
  })

  it('allows pause and resume with a newly verified lease', () => {
    let state = apply(initial, { type: 'accept', leaseExpiresAt: t1 })
    state = apply(state, { type: 'start' })
    state = apply(state, { type: 'pause' })
    expect(state.status).toBe('PAUSED')
    state = apply(state, { type: 'resume', leaseExpiresAt: t2 }, t1)
    expect(state).toMatchObject({ status: 'EXECUTING', leaseExpiresAt: t2 })
  })
})
