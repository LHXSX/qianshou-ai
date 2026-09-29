import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComfyVideoAttemptLedger } from '../src/comfy-video-attempt-ledger.ts'
import { ComputeTaskId } from '../src/protocol.ts'
import type { ResidentAttempt } from '../src/resident/types.ts'
import { ComputeTaskStore } from '../src/task-store.ts'

const roots: string[] = []
const contractDigest = `sha256:${'a'.repeat(64)}`
const graphSha256 = 'b'.repeat(64)
const promptId = 'cfae9e4d-7443-4e8d-8d44-32f89ab478a2'
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(): Promise<{
  ledger: ComfyVideoAttemptLedger
  store: ComputeTaskStore
  binding: ResidentAttempt
  path: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'comfy-video-attempt-'))
  roots.push(root)
  const store = new ComputeTaskStore({ path: join(root, 'tasks.json'), maxTasks: 10, maxBytes: 32 * 1024 })
  const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString()
  const binding: ResidentAttempt = { taskId: 'video-task-1', attempt: 1, leaseId: 'lease-1',
    leaseExpiresAt, idempotencyKey: 'key-1', envelopeFingerprint: 'c'.repeat(64),
    capabilityId: 'video.render', capabilityVersion: 'v1', capabilityPluginDigest: 'd'.repeat(64) }
  const now = new Date().toISOString()
  await store.putIfAbsent({ taskId: ComputeTaskId(binding.taskId), attempt: binding.attempt,
    envelopeFingerprint: binding.envelopeFingerprint, idempotencyKey: binding.idempotencyKey,
    status: 'OFFERED', leaseExpiresAt: null, progress: 0, updatedAt: now })
  await store.transition(binding.taskId, binding.attempt, { type: 'accept', leaseExpiresAt }, now)
  const path = join(root, 'private', 'comfy-video-attempt.json')
  await mkdir(join(root, 'private'), { mode: 0o700 })
  return { ledger: new ComfyVideoAttemptLedger(path, store), store, binding, path }
}

describe.skipIf(process.platform === 'win32')('resident ComfyUI video submission ledger', () => {
  it('requires a started lease and persists exactly one /prompt reservation across instances', async () => {
    const { ledger, store, binding, path } = await fixture()
    await expect(ledger.reserve(binding, contractDigest, graphSha256))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
    await store.transition(binding.taskId, binding.attempt, { type: 'start' }, new Date().toISOString())
    const reserved = await ledger.reserve(binding, contractDigest, graphSha256)
    expect(reserved).toMatchObject({ state: 'reserved', promptId: null, resultSha256: null })
    await expect(new ComfyVideoAttemptLedger(path, store).reserve(binding, contractDigest, graphSha256))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
    await ledger.assertReserved(reserved)
    await ledger.beforePromptSubmit(reserved)
    expect(await ledger.latest()).toMatchObject({ state: 'submitting', promptId: null })
    await expect(ledger.beforePromptSubmit(reserved)).rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
    const submitted = await ledger.recordPromptId(reserved, promptId)
    expect(submitted).toMatchObject({ state: 'submitted', promptId })
    await expect(ledger.recordPromptId(reserved, promptId)).rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
    await ledger.assertReserved(reserved)
    const local = await ledger.recordLocalResult(reserved, 'e'.repeat(64))
    expect(local).toMatchObject({ state: 'local-verified', resultSha256: 'e'.repeat(64) })
    await expect(ledger.reserve(binding, contractDigest, graphSha256))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
    await expect(ledger.assertReserved(reserved)).rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
  })

  it('refuses a revoked lease before /prompt and retains the unresolved reservation', async () => {
    const { ledger, store, binding } = await fixture()
    await store.transition(binding.taskId, binding.attempt, { type: 'start' }, new Date().toISOString())
    const reserved = await ledger.reserve(binding, contractDigest, graphSha256)
    await store.transition(binding.taskId, binding.attempt, { type: 'revoke' }, new Date().toISOString())
    await expect(ledger.assertReserved(reserved)).rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
    expect(await ledger.latest()).toMatchObject({ state: 'reserved', attemptId: reserved.attemptId })
    await expect(ledger.reserve(binding, contractDigest, graphSha256))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
  })

  it('does not replace a verified output journal until the prior task is settled', async () => {
    const { ledger, store, binding } = await fixture()
    const now = () => new Date().toISOString()
    await store.transition(binding.taskId, binding.attempt, { type: 'start' }, now())
    const first = await ledger.reserve(binding, contractDigest, graphSha256)
    await ledger.beforePromptSubmit(first)
    await ledger.recordPromptId(first, promptId)
    await ledger.recordLocalResult(first, 'e'.repeat(64))
    const next: ResidentAttempt = { ...binding, taskId: 'video-task-2', idempotencyKey: 'key-2',
      envelopeFingerprint: 'f'.repeat(64) }
    await store.putIfAbsent({ taskId: ComputeTaskId(next.taskId), attempt: next.attempt,
      envelopeFingerprint: next.envelopeFingerprint, idempotencyKey: next.idempotencyKey,
      status: 'OFFERED', leaseExpiresAt: null, progress: 0, updatedAt: now() })
    await store.transition(next.taskId, next.attempt, { type: 'accept', leaseExpiresAt: next.leaseExpiresAt }, now())
    await store.transition(next.taskId, next.attempt, { type: 'start' }, now())
    await expect(ledger.reserve(next, contractDigest, graphSha256))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
    await store.transition(binding.taskId, binding.attempt, { type: 'upload' }, now())
    await store.transition(binding.taskId, binding.attempt, { type: 'return' }, now())
    await store.transition(binding.taskId, binding.attempt, { type: 'settle' }, now())
    const second = await ledger.reserve(next, contractDigest, graphSha256)
    expect(second.attemptId).not.toBe(first.attemptId)
  })

  it('allows one atomic POST gate and refuses release after the gate even if the response is lost', async () => {
    const { ledger, store, binding, path } = await fixture()
    await store.transition(binding.taskId, binding.attempt, { type: 'start' }, new Date().toISOString())
    const reserved = await ledger.reserve(binding, contractDigest, graphSha256)
    const contender = new ComfyVideoAttemptLedger(path, store)
    const results = await Promise.allSettled([
      ledger.beforePromptSubmit(reserved), contender.beforePromptSubmit(reserved),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await ledger.latest()).toMatchObject({ state: 'submitting', promptId: null })
    await store.transition(binding.taskId, binding.attempt, { type: 'fail' }, new Date().toISOString())
    await expect(ledger.releaseNeverSubmitted(reserved, async () => ({ taskId: binding.taskId,
      attempt: binding.attempt, status: 'FAILED', sha256: 'f'.repeat(64) })))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
  })

  it('requires authoritative terminal proof to reclaim only an unused reservation', async () => {
    const { ledger, store, binding } = await fixture()
    const now = () => new Date().toISOString()
    await store.transition(binding.taskId, binding.attempt, { type: 'start' }, now())
    const reserved = await ledger.reserve(binding, contractDigest, graphSha256)
    await expect(ledger.releaseNeverSubmitted(reserved, async () => ({ taskId: binding.taskId,
      attempt: binding.attempt, status: 'FAILED', sha256: 'f'.repeat(64) })))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
    await store.transition(binding.taskId, binding.attempt, { type: 'fail' }, now())
    await expect(ledger.releaseNeverSubmitted(reserved, async () => ({ taskId: 'another-task',
      attempt: binding.attempt, status: 'FAILED', sha256: 'f'.repeat(64) })))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
    await ledger.releaseNeverSubmitted(reserved, async () => ({ taskId: binding.taskId,
      attempt: binding.attempt, status: 'FAILED', sha256: 'f'.repeat(64) }))
    expect(await ledger.latest()).toMatchObject({ state: 'never-submitted', terminalEvidenceSha256: 'f'.repeat(64) })
    const next: ResidentAttempt = { ...binding, taskId: 'video-task-2', idempotencyKey: 'key-2',
      envelopeFingerprint: 'f'.repeat(64) }
    await store.putIfAbsent({ taskId: ComputeTaskId(next.taskId), attempt: next.attempt,
      envelopeFingerprint: next.envelopeFingerprint, idempotencyKey: next.idempotencyKey,
      status: 'OFFERED', leaseExpiresAt: null, progress: 0, updatedAt: now() })
    await store.transition(next.taskId, next.attempt, { type: 'accept', leaseExpiresAt: next.leaseExpiresAt }, now())
    await store.transition(next.taskId, next.attempt, { type: 'start' }, now())
    expect((await ledger.reserve(next, contractDigest, graphSha256)).taskId).toBe(next.taskId)
  })
})

it.skipIf(process.platform !== 'win32')('fails closed before reserving on Windows without a verified durable journal', async () => {
  const { ledger, store, binding } = await fixture()
  await store.transition(binding.taskId, binding.attempt, { type: 'start' }, new Date().toISOString())
  await expect(ledger.reserve(binding, contractDigest, graphSha256))
    .rejects.toThrow('COMPUTE_COMFY_VIDEO_DURABILITY_UNAVAILABLE')
  expect(await ledger.latest()).toBeNull()
})
