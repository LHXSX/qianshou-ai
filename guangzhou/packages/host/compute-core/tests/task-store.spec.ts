import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputeTaskId } from '../src/protocol.ts'
import { ComputeTaskStore } from '../src/task-store.ts'
import type { ComputeTaskState } from '../src/task-state.ts'

const now = '2026-09-14T12:00:00.000Z'
const lease = '2026-09-14T12:05:00.000Z'
const state: ComputeTaskState = { taskId: ComputeTaskId('task-1'), attempt: 1, envelopeFingerprint: 'a'.repeat(64), idempotencyKey: 'idem-1', status: 'OFFERED', leaseExpiresAt: null, progress: 0, updatedAt: now }
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('task idempotency store', () => {
  it('does not overwrite a replayed task/attempt and survives a new store instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-task-')); roots.push(root)
    const config = { path: join(root, 'tasks.json'), maxTasks: 4, maxBytes: 65536 }
    const store = new ComputeTaskStore(config)
    await expect(store.putIfAbsent(state)).resolves.toBe(true)
    await expect(store.putIfAbsent({ ...state, status: 'ACCEPTED', updatedAt: lease })).resolves.toBe(false)
    await expect(store.putIfAbsent({ ...state, envelopeFingerprint: 'b'.repeat(64) })).rejects.toThrow('COMPUTE_TASK_REPLAY_CONFLICT')
    await expect(store.transition('task-1', 1, { type: 'accept', leaseExpiresAt: lease }, now)).resolves.toMatchObject({ status: 'ACCEPTED' })
    await store.close()
    const restarted = new ComputeTaskStore(config)
    await expect(restarted.get('task-1', 1)).resolves.toMatchObject({ status: 'ACCEPTED', leaseExpiresAt: lease })
    await restarted.close()
  })

  it('rejects transition of an unknown attempt without creating a record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-task-')); roots.push(root)
    const store = new ComputeTaskStore({ path: join(root, 'tasks.json'), maxTasks: 4, maxBytes: 65536 })
    await expect(store.transition('missing', 1, { type: 'start' }, now)).rejects.toThrow('COMPUTE_TASK_NOT_FOUND')
    await expect(store.list()).resolves.toEqual([])
    await store.close()
  })
})
