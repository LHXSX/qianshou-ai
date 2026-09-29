import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputeCapabilityId, ComputeTaskId } from '../src/protocol.ts'
import { prepareResultAssetManifest } from '../src/result-assets.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const signal = () => new AbortController().signal
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const task = { version: 'qianshou.task.v1' as const, taskId: ComputeTaskId('task-1'), capabilityId: ComputeCapabilityId('image.generate'), capabilityVersion: '1.0.0', inputRefs: [], parameters: {}, deadlineAt: '2026-09-16T00:00:00.000Z', maxOutputBytes: 5, idempotencyKey: 'attempt-1' }

async function setup() { const root = await mkdtemp(join(tmpdir(), 'result-assets-')); roots.push(root); await writeFile(join(root, 'image.png'), 'hello'); return root }

describe('result asset manifest', () => {
  it('returns immutable, deterministic upload references with evidence pointers', async () => {
    const root = await setup(); const output = { name: 'image', path: 'image.png', bytes: 5, sha256: digest('hello') }
    const descriptors = [{ name: 'image', mediaType: 'image/png', semanticEvidence: [{ kind: 'caption' as const, ref: 'evidence://caption/1', sha256: digest('caption') }] }]
    const first = await prepareResultAssetManifest(root, { outputs: [output] }, descriptors,
      { taskId: task.taskId, idempotencyKey: task.idempotencyKey, maxOutputBytes: 5 }, signal())
    const second = await prepareResultAssetManifest(root, { outputs: [output] }, descriptors,
      { taskId: task.taskId, idempotencyKey: task.idempotencyKey, maxOutputBytes: 5 }, signal())
    expect(first).toEqual(second); expect(first.assets[0]).toMatchObject({ name: 'image', bytes: 5, sha256: output.sha256, mediaType: 'image/png' }); expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.assets[0])).toBe(true); expect(Object.isFrozen(first.assets[0]!.semanticEvidence)).toBe(true)
  })
  it('requires one descriptor per output and rejects duplicate descriptors', async () => {
    const root = await setup(); const output = { name: 'image', path: 'image.png', bytes: 5, sha256: digest('hello') }
    await expect(prepareResultAssetManifest(root, { outputs: [output] }, [], { taskId: 'task-1', idempotencyKey: 'attempt-1', maxOutputBytes: 5 }, signal())).rejects.toThrow('COMPUTE_ASSET_DESCRIPTOR_MISMATCH')
    await expect(prepareResultAssetManifest(root, { outputs: [output] }, [{ name: 'image', mediaType: 'image/png' }, { name: 'image', mediaType: 'image/png' }], { taskId: 'task-1', idempotencyKey: 'attempt-1', maxOutputBytes: 5 }, signal())).rejects.toThrow('COMPUTE_ASSET_DESCRIPTOR_DUPLICATE')
  })
  it('enforces media policy and opaque evidence references', async () => {
    const root = await setup(); const output = { name: 'image', path: 'image.png', bytes: 5, sha256: digest('hello') }
    await expect(prepareResultAssetManifest(root, { outputs: [output] }, [{ name: 'image', mediaType: 'video/mp4' }], { taskId: 'task-1', idempotencyKey: 'attempt-1', maxOutputBytes: 5, allowedMediaTypes: { image: ['image/png'] } }, signal())).rejects.toThrow('COMPUTE_ASSET_MEDIA_TYPE_INVALID')
    await expect(prepareResultAssetManifest(root, { outputs: [output] }, [{ name: 'image', mediaType: 'image/png', semanticEvidence: [{ kind: 'caption', ref: '/tmp/secret' }] }], { taskId: 'task-1', idempotencyKey: 'attempt-1', maxOutputBytes: 5 }, signal())).rejects.toThrow('COMPUTE_ASSET_EVIDENCE_INVALID')
  })
  it('preserves task idempotency while changing attempt identity', async () => {
    const root = await setup(); const output = { name: 'image', path: 'image.png', bytes: 5, sha256: digest('hello') }; const descriptor = [{ name: 'image', mediaType: 'image/png' }]
    const a = await prepareResultAssetManifest(root, { outputs: [output] }, descriptor, { taskId: 'task-1', idempotencyKey: 'attempt-1', maxOutputBytes: 5 }, signal())
    const b = await prepareResultAssetManifest(root, { outputs: [output] }, descriptor, { taskId: 'task-1', idempotencyKey: 'attempt-2', maxOutputBytes: 5 }, signal())
    expect(a.assets[0]!.assetId).not.toBe(b.assets[0]!.assetId); expect(a.idempotencyKey).toBe('attempt-1')
  })
})
