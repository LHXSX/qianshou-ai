import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { ResearchImageHost } from '../src/research-image.ts'
import { ComputeError } from '../src/errors.ts'
import { QianshouCoreClient, type CoreAccountId } from '../src/core-client.ts'

const cleanups: Array<() => Promise<void>> = []
const limits = { maxRecords: 10, maxStoreBytes: 65536 }
const gatewayOrigin = 'https://gateway.example.test'
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function png(): Buffer {
  const crc32 = (bytes: Buffer): number => {
    let crc = 0xffffffff
    for (const byte of bytes) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (name: string, bytes: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), bytes])
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([size, body, crc])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(2048); header.writeUInt32BE(1152, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(1152 * (1 + 2048 * 3)))), chunk('IEND', Buffer.alloc(0))])
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'qianshou-research-image-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const request = { id: randomUUID(), sessionId: 'owner-session', prompt: '一只正在散步的小狗', size: 'landscape', steps: 8 }
  const taskId = randomUUID(), attemptId = randomUUID()
  const bytes = png()
  const now = new Date().toISOString()
  let owner = 167
  let stage = 'queued'
  const artifact = { assetId: attemptId, sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length,
    content_type: 'image/png', width: 2048, height: 1152, resultRevision: 'b'.repeat(64),
    download_path: `/v1/media/research/result?taskId=${taskId}&attemptId=${attemptId}` }
  const reply = () => ({ ok: true, schema: 'qianshou.research-media-task.v1', requestId: request.id, taskId, attemptId,
    mode: 'image', status: stage, dispatchState: stage === 'queued' ? 'waiting' : 'accepted', reason: null,
    createdAt: now, updatedAt: now, lastSyncedAt: null, non_billable: true, commercial: false,
    result: stage === 'succeeded' ? artifact : null, queue: { position: stage === 'queued' ? 1 : null, estimate: null } })
  const client = {
    getIdentity: vi.fn<QianshouCoreClient['getIdentity']>(async () => ({ accountId: owner as CoreAccountId, username: 'test', role: 'member', status: 'active' })),
    assertResearchOwner: vi.fn<QianshouCoreClient['assertResearchOwner']>(async (ownerId) => {
      if (owner !== ownerId) throw new ComputeError('IMAGE_TRIAL_ACCOUNT_CHANGED', 403)
    }),
    submitResearchImageTask: vi.fn<QianshouCoreClient['submitResearchImageTask']>(async () => reply()),
    readResearchImageTask: vi.fn<QianshouCoreClient['readResearchImageTask']>(async () => reply()),
    readResearchImageResult: vi.fn<QianshouCoreClient['readResearchImageResult']>(async () => bytes),
  }
  const host = new ResearchImageHost(client, { gatewayOrigin }, directory, limits)
  cleanups.push(async () => { await host.close() })
  const waitSubmission = async () => {
    await vi.waitFor(async () => {
      expect(client.submitResearchImageTask).toHaveBeenCalledTimes(1)
      const stored = JSON.parse(await readFile(join(directory, 'requests.json'), 'utf8')) as { rows: Array<{ receipt: unknown }> }
      expect(stored.rows[0]?.receipt).not.toBeNull()
    }, { interval: 10 })
  }
  return { directory, request, host, client, artifact, bytes, taskId, attemptId, reply, waitSubmission,
    setOwner: (value: number) => { owner = value }, setStage: (value: string) => { stage = value } }
}

it('persists an original intent, queues two requests without a local busy rejection, and submits each UUID only once', async () => {
  const test = await setup()
  const second = { ...test.request, id: randomUUID() }
  test.client.submitResearchImageTask.mockImplementation(async () => { throw new ComputeError('CORE_REQUEST_TIMEOUT', 504) })
  expect((await test.host.submit(test.request, () => true)).timing?.phase).toBe('queued')
  expect((await test.host.submit(second, () => true)).status).toBe('running')
  await vi.waitFor(() => { expect(test.client.submitResearchImageTask).toHaveBeenCalledTimes(2) })
  await test.host.submit(test.request, () => true)
  expect(test.client.submitResearchImageTask).toHaveBeenCalledTimes(2)
  expect(await test.host.updateState()).toBe('busy')
  const stored = await readFile(join(test.directory, 'requests.json'), 'utf8')
  expect(stored).not.toContain('Bearer')
  expect(JSON.parse(stored).rows).toHaveLength(2)
})

it('cold-recovers an unknown POST through its original request GET, then downloads the original PNG without another POST', async () => {
  const test = await setup()
  test.client.submitResearchImageTask.mockRejectedValueOnce(new ComputeError('CORE_UNAVAILABLE', 502))
  await test.host.submit(test.request, () => true)
  await vi.waitFor(() => { expect(test.client.submitResearchImageTask).toHaveBeenCalledTimes(1) })
  await test.host.close()
  const restored = new ResearchImageHost(test.client, { gatewayOrigin }, test.directory, limits)
  cleanups.push(async () => { await restored.close() })
  expect(await restored.owns(test.request.id)).toBe(true)
  test.setStage('running')
  expect((await restored.job(test.request.id, test.request.sessionId)).timing?.phase).toBe('generating')
  test.setStage('succeeded')
  const complete = await restored.job(test.request.id, test.request.sessionId)
  expect(complete.status).toBe('completed')
  expect(complete.result).toEqual({ bytes: test.bytes.length, sha256: test.artifact.sha256 })
  expect(await restored.image(test.request.id, test.request.sessionId)).toEqual(test.bytes)
  expect(test.client.submitResearchImageTask).toHaveBeenCalledTimes(1)
  expect(test.client.readResearchImageTask.mock.calls.map(call => call[0])).toEqual([test.request.id, test.request.id])
  expect(test.client.readResearchImageResult).toHaveBeenCalledWith(new URL(gatewayOrigin),
    expect.objectContaining({ taskId: test.taskId, attemptId: test.attemptId }), 167, expect.any(AbortSignal))
  expect(await restored.updateState()).toBe('idle')
})

it('does not create a replacement when the original unknown request returns 404 after restart', async () => {
  const test = await setup()
  test.client.submitResearchImageTask.mockRejectedValueOnce(new ComputeError('CORE_REQUEST_TIMEOUT', 504))
  await test.host.submit(test.request, () => true); await test.host.close()
  const restored = new ResearchImageHost(test.client, { gatewayOrigin }, test.directory, limits)
  cleanups.push(async () => { await restored.close() })
  test.client.readResearchImageTask.mockRejectedValue(new ComputeError('CORE_HTTP_404', 404))
  await expect(restored.job(test.request.id, test.request.sessionId)).rejects.toMatchObject({ code: 'CORE_HTTP_404' })
  await restored.submit(test.request, () => true)
  expect(test.client.submitResearchImageTask).toHaveBeenCalledTimes(1)
  expect(await restored.updateState()).toBe('busy')
})

it('refuses account or Session changes and cannot expose another owner image', async () => {
  const test = await setup()
  await test.host.submit(test.request, () => true); await test.waitSubmission()
  await expect(test.host.job(test.request.id, 'different-session')).rejects.toMatchObject({ status: 404 })
  test.setOwner(168)
  await expect(test.host.job(test.request.id, test.request.sessionId)).rejects.toMatchObject({ code: 'IMAGE_TRIAL_ACCOUNT_CHANGED' })
  expect(test.client.readResearchImageTask).not.toHaveBeenCalled()
  expect(test.client.readResearchImageResult).not.toHaveBeenCalled()
})

it('rejects a mutated original attempt or artifact path before requesting image bytes', async () => {
  const test = await setup()
  await test.host.submit(test.request, () => true); await test.waitSubmission()
  test.setStage('running')
  test.client.readResearchImageTask.mockResolvedValue({ ...test.reply(), attemptId: randomUUID() })
  await expect(test.host.job(test.request.id, test.request.sessionId)).rejects.toMatchObject({ code: 'IMAGE_TRIAL_RESULT_INVALID' })
  test.setStage('succeeded')
  test.client.readResearchImageTask.mockResolvedValue({ ...test.reply(), result: { ...test.artifact, download_path: 'https://untrusted.test/image' } })
  await expect(test.host.job(test.request.id, test.request.sessionId)).rejects.toMatchObject({ code: 'IMAGE_TRIAL_RESULT_INVALID' })
  expect(test.client.readResearchImageResult).not.toHaveBeenCalled()
  expect(test.client.submitResearchImageTask).toHaveBeenCalledTimes(1)
})

it('retries failed delivery with only the saved original Guangzhou GET and verifies the PNG digest', async () => {
  const test = await setup()
  await test.host.submit(test.request, () => true); await test.waitSubmission()
  test.setStage('succeeded')
  test.client.readResearchImageResult.mockRejectedValueOnce(new ComputeError('CORE_REQUEST_TIMEOUT', 504))
  await expect(test.host.job(test.request.id, test.request.sessionId)).rejects.toMatchObject({ code: 'CORE_REQUEST_TIMEOUT' })
  expect(await test.host.updateState()).toBe('idle')
  const count = test.client.readResearchImageTask.mock.calls.length
  expect((await test.host.job(test.request.id, test.request.sessionId)).status).toBe('completed')
  expect(test.client.readResearchImageTask).toHaveBeenCalledTimes(count)
  expect(test.client.submitResearchImageTask).toHaveBeenCalledTimes(1)
  expect(test.client.readResearchImageResult).toHaveBeenCalledTimes(2)
})

it('vetoes new requests while the updater is locked and never reduces a requested 12/20 step or portrait spec', async () => {
  const test = await setup()
  test.host.setUpdateLocked(true)
  await expect(test.host.submit(test.request, () => true)).rejects.toMatchObject({ code: 'IMAGE_TRIAL_UPDATE_IN_PROGRESS' })
  test.host.setUpdateLocked(false)
  for (const steps of [12, 20]) await expect(test.host.submit({ ...test.request, steps }, () => true))
    .rejects.toMatchObject({ code: 'IMAGE_TRIAL_SPEC_UNAVAILABLE' })
  await expect(test.host.submit({ ...test.request, size: 'portrait' }, () => true)).rejects.toMatchObject({ code: 'IMAGE_TRIAL_SPEC_UNAVAILABLE' })
  expect(test.client.submitResearchImageTask).not.toHaveBeenCalled()
})

it('keeps recovery bound to the original Guangzhou origin and refuses malformed durable records', async () => {
  const test = await setup()
  await test.host.submit(test.request, () => true); await test.waitSubmission(); await test.host.close()
  const moved = new ResearchImageHost(test.client, { gatewayOrigin: 'https://different.example.test' }, test.directory, limits)
  cleanups.push(async () => { await moved.close() })
  test.setStage('succeeded')
  await expect(moved.job(test.request.id, test.request.sessionId)).rejects.toMatchObject({ code: 'IMAGE_TRIAL_DELIVERY_UNAVAILABLE' })
  expect(test.client.readResearchImageResult).not.toHaveBeenCalled()
  await moved.close()
  const path = join(test.directory, 'requests.json')
  const saved = JSON.parse(await readFile(path, 'utf8'))
  saved.rows[0].receipt.result.download_path = '/v1/media/research/result?taskId=other'
  await writeFile(path, JSON.stringify(saved))
  const corrupted = new ResearchImageHost(test.client, { gatewayOrigin }, test.directory, limits)
  cleanups.push(async () => { await corrupted.close() })
  await expect(corrupted.owns(test.request.id)).rejects.toMatchObject({ code: 'IMAGE_TRIAL_STORE_INVALID' })
})

it('uses metadata-only Shanghai POST/GET and direct authenticated Guangzhou PNG GET, with redirects disabled', async () => {
  const test = await setup()
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const target = new URL(String(url))
    if (target.pathname === '/api/v8/auth/me') return Response.json({ ok: true, account: { id: 167 } })
    if (target.origin === gatewayOrigin) return new Response(new Uint8Array(test.bytes), { headers: {
      'Content-Type': 'image/png', 'Content-Length': String(test.bytes.length) } })
    return Response.json(test.reply())
  })
  const client = new QianshouCoreClient({ baseUrl: 'https://shanghai.example.test', timeoutMs: 500, maxResponseBytes: 65536 },
    () => 'private-owner-test', fetcher)
  cleanups.push(async () => { await client.close() })
  await client.submitResearchImageTask({ requestId: test.request.id, mode: 'image', input: { prompt: test.request.prompt } }, 167 as CoreAccountId)
  await client.readResearchImageTask(test.request.id, 167 as CoreAccountId)
  expect(await client.readResearchImageResult(new URL(gatewayOrigin), test, 167 as CoreAccountId,
    new AbortController().signal)).toEqual(test.bytes)
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([
    'https://shanghai.example.test', 'https://shanghai.example.test', 'https://shanghai.example.test',
    'https://shanghai.example.test', 'https://shanghai.example.test', gatewayOrigin,
  ])
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'GET', 'GET', 'GET', 'GET'])
  for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer private-owner-test' } })
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ requestId: test.request.id, mode: 'image', input: { prompt: test.request.prompt } }))
})

it('cannot submit an old owner request using the next account credential after an asynchronous identity check', async () => {
  let token = 'owner-a-private-test'
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(new URL(String(url)).pathname).toBe('/api/v8/auth/me')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer owner-a-private-test' })
    token = 'owner-b-private-test'
    return Response.json({ ok: true, account: { id: 167 } })
  })
  const client = new QianshouCoreClient({ baseUrl: 'https://shanghai.example.test', timeoutMs: 500, maxResponseBytes: 65536 },
    () => token, fetcher)
  cleanups.push(async () => { await client.close() })
  await expect(client.submitResearchImageTask({ requestId: randomUUID(), mode: 'image', input: { prompt: '测试' } },
    167 as CoreAccountId)).rejects.toMatchObject({ code: 'IMAGE_TRIAL_ACCOUNT_CHANGED' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET')
})

it('refuses to return completed image metadata after an account change while receiving original PNG bytes', async () => {
  const test = await setup()
  await test.host.submit(test.request, () => true); await test.waitSubmission(); test.setStage('succeeded')
  test.client.readResearchImageResult.mockImplementationOnce(async () => { test.setOwner(168); return test.bytes })
  await expect(test.host.image(test.request.id, test.request.sessionId)).rejects.toMatchObject({ code: 'IMAGE_TRIAL_ACCOUNT_CHANGED' })
  expect(test.client.submitResearchImageTask).toHaveBeenCalledOnce()
})

it('discards the final retained-owner identity reply after its credential changes while the GET is pending', async () => {
  let token = 'owner-a-private-test'
  let complete!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => { complete = resolve })
  const fetcher = vi.fn<typeof fetch>(async () => pending)
  const client = new QianshouCoreClient({ baseUrl: 'https://shanghai.example.test', timeoutMs: 1000, maxResponseBytes: 65536 },
    () => token, fetcher)
  cleanups.push(async () => { await client.close() })
  const check = client.assertResearchOwner(167 as CoreAccountId)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  token = 'owner-b-private-test'; complete(Response.json({ ok: true, account: { id: 167 } }))
  await expect(check).rejects.toMatchObject({ code: 'IMAGE_TRIAL_ACCOUNT_CHANGED' })
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET')
})
