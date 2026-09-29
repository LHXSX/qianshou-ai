import { describe, expect, it, vi } from 'vitest'
import {
  assignmentFingerprint,
  isVerifiedTaskAssignment,
  taskFingerprint,
  verifyTaskAssignment,
  verifyTaskEnvelope,
  type ComputeTaskAssignment,
} from '../src/envelope-security.ts'

const task = {
  version: 'qianshou.task.v1' as const, taskId: 'task-1', capabilityId: 'image.batch', capabilityVersion: '1.0.0', inputRefs: [],
  parameters: { z: 1, a: ['x'] }, deadlineAt: '2026-09-14T12:00:00.000Z', maxOutputBytes: 1024, idempotencyKey: 'idem-1',
}

const assignment: ComputeTaskAssignment = {
  envelope: task as never,
  attempt: 1,
  leaseExpiresAt: '2026-09-14T12:05:00.000Z',
  receivedAt: '2026-09-14T12:00:00.000Z',
}

describe('task envelope security', () => {
  it('produces the same fingerprint regardless of JSON object key order', () => {
    expect(taskFingerprint(task as never)).toBe(taskFingerprint({ ...task, parameters: { a: ['x'], z: 1 } } as never))
  })

  it('verifies a signature before returning an immutable envelope', async () => {
    const verify = vi.fn(async (fingerprint: string, signature: string) => signature === `sig-${fingerprint}`)
    const fingerprint = taskFingerprint(task as never)
    const admitted = await verifyTaskEnvelope(task, `sig-${fingerprint}`, verify)
    expect(admitted.taskId).toBe('task-1')
    expect(Object.isFrozen(admitted.parameters)).toBe(true)
    expect(verify).toHaveBeenCalledWith(fingerprint, `sig-${fingerprint}`)
  })

  it('rejects bad or forged signatures before a verifier can authorize them', async () => {
    const verify = vi.fn(async () => true)
    await expect(verifyTaskEnvelope(task, 'short', verify)).rejects.toThrow('COMPUTE_TASK_SIGNATURE_INVALID')
    expect(verify).not.toHaveBeenCalled()
    await expect(verifyTaskEnvelope(task, 'x'.repeat(16), async () => false)).rejects.toThrow('COMPUTE_TASK_SIGNATURE_INVALID')
  })

  it.each([
    ['attempt', { attempt: 2 }],
    ['lease expiry', { leaseExpiresAt: '2026-09-14T12:06:00.000Z' }],
    ['issuer timestamp', { receivedAt: '2026-09-14T12:00:01.000Z' }],
  ])('covers assignment %s in the signed fingerprint', (_name, change) => {
    expect(assignmentFingerprint({ ...assignment, ...change })).not.toBe(assignmentFingerprint(assignment))
  })

  it.each([
    ['attempt', { attempt: 2 }],
    ['lease expiry', { leaseExpiresAt: '2026-09-14T12:06:00.000Z' }],
  ])('rejects signed assignment replay after changing %s', async (_name, change) => {
    const original = assignmentFingerprint(assignment)
    const verify = vi.fn(async (fingerprint: string) => fingerprint === original)
    await expect(verifyTaskAssignment({ ...assignment, ...change }, `sig-${'a'.repeat(20)}`, verify)).rejects.toThrow('COMPUTE_TASK_SIGNATURE_INVALID')
  })

  it('mints a process-local credential only after verifying the assignment fingerprint', async () => {
    const verify = vi.fn(async (fingerprint: string, signature: string) => signature === `sig-${fingerprint}`)
    const fingerprint = assignmentFingerprint(assignment)
    const admitted = await verifyTaskAssignment(assignment, `sig-${fingerprint}`, verify)

    expect(admitted).toMatchObject({
      attempt: 1, leaseExpiresAt: assignment.leaseExpiresAt, receivedAt: assignment.receivedAt, verified: true,
    })
    expect(admitted.envelopeFingerprint).toBe(taskFingerprint(task as never))
    expect(admitted.assignmentFingerprint).toBe(fingerprint)
    expect(isVerifiedTaskAssignment(admitted)).toBe(true)
    expect(isVerifiedTaskAssignment({ ...admitted })).toBe(false)
    expect(Object.isFrozen(admitted)).toBe(true)
    expect(() => Object.assign(admitted, { attempt: 2, leaseExpiresAt: '2026-09-14T12:06:00.000Z' })).toThrow()
    expect(admitted.attempt).toBe(1)
    expect(admitted.leaseExpiresAt).toBe(assignment.leaseExpiresAt)
    expect(verify).toHaveBeenCalledWith(fingerprint, `sig-${fingerprint}`)
  })
})
