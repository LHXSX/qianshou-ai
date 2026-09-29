import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ComputeTaskId, ComputeCapabilityId } from '../../src/protocol.ts'
import { createFileOrderConsumer } from '../../src/resident/file-order-consumer.ts'
import { uploadEdgeArtifact } from '../../src/edge-worker/artifact-upload.ts'
import { readPinnedFileAttachment } from '../../src/edge-worker/artifact-read.ts'
import { canonicalFileMetadata } from '../../src/edge-worker/file-task-contract.ts'
import type { ComputeResidentAttemptExecution } from '../../src/resident/types.ts'

const unsigned = { schema: 'qianshou.file-attachment-bindings.v1' as const, account_id: 42, task_type: 'bounded_file_v1',
  contract_sha256: 'sha256:' + 'a'.repeat(64), file_schema_sha256: 'b'.repeat(64), attachments: {} }
const fileContract = { ...unsigned, bindings_sha256: 'sha256:' + createHash('sha256').update(canonicalFileMetadata(unsigned)).digest('hex') }
const artifact = { schema: 'artifact.v1' as const, account_id: 42, workload_id: 'e8740459-1286-47d2-819d-b47072986d84',
  shard_id: '5ad0eacb-ced3-4f15-9f34-397d18b119a1', result_id: '17480120-e7d7-4c6b-9f72-f7b714bf29ec',
  filename: 'output.bin', content_type: 'application/octet-stream', size_bytes: 4, sha256: 'c'.repeat(64),
  object_version_id: 'locked-v1', object_key: 'v8/account-42/workload-e8740459-1286-47d2-819d-b47072986d84/shard-5ad0eacb-ced3-4f15-9f34-397d18b119a1/result/17480120-e7d7-4c6b-9f72-f7b714bf29ec/output.bin' }
const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(parameters: unknown = { taskType: unsigned.task_type, inlineInput: '{"text":"emit"}', fileContract },
  signal = new AbortController().signal) {
  const path = await mkdtemp(join(tmpdir(), 'file-consumer-')); roots.push(path)
  const execution: ComputeResidentAttemptExecution = { task: { version: 'qianshou.task.v1', taskId: ComputeTaskId('file.task'),
    capabilityId: ComputeCapabilityId('files.emit'), capabilityVersion: '1.0.0', inputRefs: [], parameters: parameters as never,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), maxOutputBytes: 16384, idempotencyKey: 'd'.repeat(64) },
    attempt: { taskId: 'file.task', attempt: 2, leaseId: 'local-lease', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: 'd'.repeat(64), envelopeFingerprint: 'e'.repeat(64), capabilityId: 'files.emit', capabilityVersion: '1.0.0', capabilityPluginDigest: 'f'.repeat(64) },
    signal, reportProgress: vi.fn(async () => undefined), source: { open: async () => new ReadableStream() }, dataSource: {} }
  return { execution, signal: new AbortController().signal, workspace: { path, outputs: [], close: async () => undefined } }
}
it('runs inside resident attempt lifecycle and persists only the uploaded manifest', async () => {
  const f = await fixture()
  const remember = vi.fn()
  const read = vi.fn(); const upload = vi.fn()
  const run = vi.fn(async input => { expect(input.fileContract).toEqual(fileContract); expect(input.ports.read).toBe(read); return artifact })
  const consumer = createFileOrderConsumer({ run, ports: (taskId, attempt) => {
    expect(taskId).toBe('file.task'); expect(attempt).toBe(2); return { read, upload }
  }, remember })
  const result = await consumer.consume(f)
  const text = await readFile(join(f.workspace.path, 'result.json'), 'utf8')
  expect(JSON.parse(text)).toEqual(artifact)
  expect(await readdir(f.workspace.path)).toEqual(['result.json'])
  expect(result.outputs).toEqual([{ name: 'result.json', bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }])
  expect(remember).toHaveBeenCalledWith('file.task', artifact, expect.any(Number))
  expect(f.execution.reportProgress).toHaveBeenNthCalledWith(1, 0, 'started')
  expect(f.execution.reportProgress).toHaveBeenLastCalledWith(1, 'done')
})
it.each([null, [], {}, { taskType: unsigned.task_type, inlineInput: '' },
  { taskType: unsigned.task_type, inlineInput: '{}', fileContract, taskParams: { path: '/etc/passwd' } },
  { taskType: unsigned.task_type, inlineInput: '{}', fileContract: { ...fileContract, account_id: 6 } }])(
  'rejects missing contracts and undeclared parameters before invoking the runtime %j', async fields => {
    const run = vi.fn()
    const consumer = createFileOrderConsumer({ run, ports: vi.fn(), remember: vi.fn() })
    await expect(consumer.consume(await fixture(fields))).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
it('rejects attempt cancellation before execution and after an awaited upload, without remembering a result', async () => {
  const abort = new AbortController(); abort.abort()
  const run = vi.fn(async () => artifact); const remember = vi.fn()
  const consumer = createFileOrderConsumer({ run, ports: () => ({ read: vi.fn(), upload: vi.fn() }), remember })
  await expect(consumer.consume(await fixture(undefined, abort.signal))).rejects.toThrow()
  expect(run).not.toHaveBeenCalled()
  const live = new AbortController()
  run.mockImplementation(async () => { live.abort(); return artifact })
  await expect(consumer.consume(await fixture(undefined, live.signal))).rejects.toThrow()
  expect(remember).not.toHaveBeenCalled()
})
it.each(['read', 'upload'] as const)('external consumer cancellation aborts an in-flight direct %s port', async action => {
  const outer = new AbortController()
  const f = { ...await fixture(), signal: outer.signal }
  const body = Buffer.from('four')
  const sha256 = createHash('sha256').update(body).digest('hex')
  const observed = vi.fn()
  const send = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(url).includes('shanghai.example')) {
      const request = JSON.parse(String(init?.body))
      return Response.json({ schema_version: 'artifact.v1', method: 'PUT',
        object_key: `v8/account-42/workload-${artifact.workload_id}/shard-${artifact.shard_id}/result/${request.result_id}/output.bin`,
        upload_url: 'https://storage.example/put', expires_at: Math.floor(Date.now() / 1000) + 60,
        headers: { 'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64') } })
    }
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(init?.signal?.aborted).toBe(false)
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { observed(); reject(init!.signal!.reason) }, { once: true })
      queueMicrotask(() => outer.abort(new Error('consumer-closed')))
    })
  }) as typeof fetch
  const remember = vi.fn()
  const consumer = createFileOrderConsumer({ remember, ports: () => ({
    read: async (_input, signal) => readPinnedFileAttachment({ coreOrigin: new URL('https://shanghai.example'),
      trustedStorageHostname: 'storage.example', pinned: { objectKey: artifact.object_key, objectVersionId: 'locked-v1',
        sha256, sizeBytes: body.length, contentType: 'application/octet-stream' }, maxBytes: 32,
      contentTypes: ['application/octet-stream'], authorize: async () => ({ objectKey: artifact.object_key,
        objectVersionId: 'locked-v1', sha256, sizeBytes: body.length, contentType: 'application/octet-stream',
        url: `https://storage.example/${artifact.object_key}?versionId=locked-v1`, expiresAt: Math.floor(Date.now() / 1000) + 60 }),
      signal, fetch: send }),
    upload: async (_input, signal) => uploadEdgeArtifact({ origin: new URL('https://shanghai.example'),
      token: 'fixture-account', leaseToken: 'fixture-lease', identity: { workerId: 'fixture-worker', workloadId: artifact.workload_id,
        shardId: artifact.shard_id, attempt: 1 }, filename: 'output.bin', contentType: 'application/octet-stream', bytes: body,
      signal, fetch: send }),
  }), run: async input => {
    const fields = { slot: 'source', maxBytes: 32, contentTypes: ['application/octet-stream'],
      contractSha256: fileContract.contract_sha256, fileSchemaSha256: fileContract.file_schema_sha256, trustedStorageHostname: 'storage.example' }
    if (action === 'read') await input.ports.read(fields, input.signal)
    else await input.ports.upload({ ...fields, filename: 'output.bin', contentType: 'application/octet-stream', bytes: body }, input.signal)
    return artifact
  } })
  await expect(consumer.consume(f)).rejects.toThrow()
  expect(observed).toHaveBeenCalledOnce()
  expect(f.execution.signal.aborted).toBe(false)
  expect(remember).not.toHaveBeenCalled()
  expect(await readdir(f.workspace.path)).toEqual([])
})
