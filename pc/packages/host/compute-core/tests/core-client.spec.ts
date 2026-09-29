import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { QianshouCoreClient, type CoreClientConfig } from '../src/core-client.ts'
import { ComputeError } from '../src/errors.ts'
import { ComputeService } from '../src/service.ts'
import { COMFY_VIDEO_RUNNER_ABI, comfyVideoPublicContractDigest } from '../src/comfy-video-public-contract.ts'
import type { ComputeDraftStore } from '../src/store.ts'

const config: CoreClientConfig = {
  baseUrl: 'https://core.example.test',
  timeoutMs: 500,
  maxResponseBytes: 32_000,
}

function json(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  new Headers(init?.headers).forEach((value, key) => { headers.set(key, value) })
  return new Response(JSON.stringify(value), {
    ...init,
    headers,
  })
}

const identity = {
  ok: true,
  account: { id: 41, username: 'member', role: 'enterprise', status: 'active', email: 'ignored', password_hash: 'discard' },
}

describe('reviewed video first-frame upload', () => {
  const bucket = 'video-proof-1234567890'
  const key = `v8/account-41/reviewed-video/input/${'a'.repeat(32)}/frame.png`
  const host = `${bucket}.cos.ap-shanghai.myqcloud.com`
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
  const digest = createHash('sha256').update(bytes).digest('hex')
  const md5 = createHash('md5').update(bytes).digest('base64')
  const signed = { object_key: key, bucket, filename: 'frame.png', method: 'PUT',
    upload_hostname: host, upload_url: `https://${host}/${key}?X-Amz-Signature=abc`,
    upload_intent: { key_id: 'review-key', payload: {}, signature: 'signed' },
    headers: { 'Content-Type': 'image/png', 'Content-MD5': md5,
      'x-amz-checksum-sha256': createHash('sha256').update(bytes).digest('base64'),
      'x-amz-object-lock-mode': 'COMPLIANCE',
      'x-amz-object-lock-retain-until-date': '2026-10-01T00:00:00Z',
      'x-amz-meta-sha256': digest } }

  it('uses the evidence bucket, passes a precise object version to complete, and returns a canonical receipt', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname
      if (path === '/api/v8/auth/me') return json(identity)
      if (path === '/api/v8/developer/video-input/upload-url') return json(signed)
      if (path === '/' + key) return new Response(null, { status: 200,
        headers: { 'x-cos-version-id': 'version-1' } })
      if (path === '/api/v8/developer/video-input/complete') return json({ completed: true,
        bucket, object_key: key, object_version_id: 'version-1', filename: 'frame.png',
        size_bytes: bytes.length, sha256: digest, content_type: 'image/png' })
      throw new Error('unexpected route')
    })
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    const result = await client.uploadInputFile({ filename: '用户首帧.png', contentType: 'image/png', bytes },
      undefined, 'reviewed-video-first-frame')
    expect(result).toEqual({ objectKey: key, filename: 'frame.png', bytes: bytes.length,
      sha256: digest, contentType: 'image/png', objectVersionId: 'version-1' })
    const calls = fetcher.mock.calls
    expect(calls.map(([url]) => new URL(String(url)).pathname)).toContain('/api/v8/developer/video-input/upload-url')
    expect(calls.map(([url]) => new URL(String(url)).pathname)).not.toContain('/api/v8/developer/files/upload-url')
    const put = calls.find(([url]) => new URL(String(url)).hostname === host)
    expect(put?.[1]).toMatchObject({ method: 'PUT', credentials: 'omit', redirect: 'error' })
    expect(JSON.parse(String(calls.find(([url]) => new URL(String(url)).pathname.endsWith('/video-input/complete'))?.[1]?.body)))
      .toEqual({ upload_intent: signed.upload_intent, object_version_id: 'version-1' })
    await client.close()
  })

  it('rejects an untrusted upload destination before sending image bytes', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname
      if (path === '/api/v8/auth/me') return json(identity)
      if (path === '/api/v8/developer/video-input/upload-url') return json({ ...signed,
        upload_hostname: '127.0.0.1', upload_url: `https://127.0.0.1/${key}?X-Amz-Signature=abc` })
      throw new Error('unexpected upload')
    })
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await expect(client.uploadInputFile({ filename: 'first.png', contentType: 'image/png', bytes },
      undefined, 'reviewed-video-first-frame')).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
    expect(fetcher.mock.calls).toHaveLength(2)
    await client.close()
  })
})

function clientFor(body: unknown, overrides: Partial<CoreClientConfig> = {}) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body))
  const client = new QianshouCoreClient({ ...config, ...overrides }, () => 'test-access', fetcher)
  return { client, fetcher }
}

describe('core API reads', () => {
  it('keeps buyer acceptance on the owner-authenticated Shanghai path and does not infer settlement', async () => {
    const pending = { workload_id: 'workload_123', status: 'pending_buyer', workload_status: 'QUARANTINED',
      currency: 'CNY', held_amount: '0.4875', inline_output: { summary: '请验收' },
      content_sha256: 'a'.repeat(64), output_kind: 'inline_json', shard_id: 'shard_123' }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(pending))
      .mockResolvedValueOnce(json({ ...pending, status: 'accepted' }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    expect((await client.getBuyerAcceptance('workload_123'))?.status).toBe('pending_buyer')
    const decided = await client.decideBuyerAcceptance('workload_123', 'accept',
      'f8e42af1-e7a0-4c60-a53d-aa8d04def69b')
    expect(decided.status).toBe('accepted')
    expect(decided.workloadStatus).toBe('QUARANTINED')
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v8/workloads/workload_123/acceptance', '/api/v8/workloads/workload_123/acceptance',
    ])
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer test-access' } })
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      decision: 'accept', idempotency_key: 'f8e42af1-e7a0-4c60-a53d-aa8d04def69b',
    })
    await client.close()
  })
  it('does not offer confirmation when Shanghai has no buyer acceptance record', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ detail: 'not available' }, { status: 404 }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    expect(await client.getBuyerAcceptance('workload_123')).toBeNull()
    await client.close()
  })
  it('uses a verified auth path, disallows redirects, and projects only identity display fields', async () => {
    const { client, fetcher } = clientFor(identity)
    expect(await client.getIdentity()).toEqual({ accountId: 41, username: 'member', role: 'enterprise', status: 'active' })
    expect(client.originHref()).toBe('https://core.example.test')
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/auth/me'))
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer test-access' },
    })
    await client.close()
  })

  it('copies a decimal-string /me balance and treats a number as missing', async () => {
    const withText = clientFor({
      ok: true,
      account: { ...identity.account, balance: '1.2500' },
    })
    expect(await withText.client.getAccountView()).toEqual({
      identity: { accountId: 41, username: 'member', role: 'enterprise', status: 'active' },
      balance: '1.2500',
    })
    await withText.client.close()
    const asNumber = clientFor({
      ok: true,
      account: { ...identity.account, balance: 1.25 },
    })
    expect(await asNumber.client.getAccountView()).toEqual({
      identity: { accountId: 41, username: 'member', role: 'enterprise', status: 'active' },
      balance: null,
    })
    await asNumber.client.close()
    const missing = clientFor(identity)
    expect((await missing.client.getAccountView()).balance).toBeNull()
    await missing.client.close()
  })

  it('marks catalogue entries as requestable without inventing node counts, prices, or versions', async () => {
    const { client, fetcher } = clientFor({
      ok: true, items: [{ task_type: 'video_compress', description: 'Transcode video', api_key: 'discard', requires_gpu: false }], total: 1,
    })
    expect(await client.getCapabilities()).toEqual([
      { id: 'media.transcode', name: 'media.transcode', description: 'Transcode video', delivery: 'remote', available: true },
    ])
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/developer/task-types'))
    await client.close()
  })

  it('keeps new catalogue task types visible and collapses known aliases', async () => {
    const { client } = clientFor({
      ok: true,
      items: [
        { task_type: 'ocr_image', description: 'not a registry name' },
        { task_type: 'video_compress', description: 'first landing' },
        { task_type: 'video_repurpose', description: 'same capability' },
      ],
    })
    expect(await client.getCapabilities()).toEqual([
      { id: 'ocr_image', name: 'ocr_image', description: 'not a registry name', delivery: 'remote', available: true },
      { id: 'media.transcode', name: 'media.transcode', description: 'first landing', delivery: 'remote', available: true },
    ])
    await client.close()
  })

  it('reads declared ads and available-now separately and does not treat empty provides as missing', async () => {
    const { client, fetcher } = clientFor({
      found: true,
      capability: 'media.transcode',
      registry_version: '1.0.0',
      declared: { count: 3, by_impl: { ffmpeg: 3 } },
      available_now: { count: 0, by_impl: {}, online_ttl_seconds: 90 },
      provides: [],
    })
    expect(await client.getCapabilityWorkers('media.transcode')).toEqual({
      lookup: 'found',
      capability: 'media.transcode',
      registryVersion: '1.0.0',
      declared: { count: 3, byImpl: { ffmpeg: 3 } },
      availableNow: { count: 0, byImpl: {}, onlineTtlSeconds: 90 },
      provides: [],
      note: '这是登记与在线声明，不是派单承诺。',
    })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/capabilities/media.transcode/workers'))
    await client.close()
  })

  it('treats a 404 workers answer as not-in-registry, not an empty pool', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({
      found: false, capability: 'invented.capability', reason: 'not_in_registry',
    }, { status: 404 }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    expect(await client.getCapabilityWorkers('invented.capability')).toEqual({
      lookup: 'not_in_registry',
      capability: 'invented.capability',
      registryVersion: null,
      declared: null,
      availableNow: null,
      provides: [],
      note: '目录里没有这个能力名；不是池子里没人。',
    })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/capabilities/invented.capability/workers'))
    await client.close()
  })

  it('asks Shanghai about a new plugin capability absent from this PC build', async () => {
    const { client, fetcher } = clientFor({
      found: true, capability: 'custom.star-chart', registry_version: '2.0.0',
      declared: { count: 1, by_impl: { advertised: 1 } },
      available_now: { count: 1, by_impl: { advertised: 1 }, online_ttl_seconds: 60 },
      provides: [{ worker_id: 'worker-123', impl: 'advertised', available_now: true, status: 'ONLINE' }],
    })
    expect(await client.getCapabilityWorkers('custom.star-chart')).toMatchObject({
      lookup: 'found', capability: 'custom.star-chart',
      declared: { count: 1 }, availableNow: { count: 1 },
    })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/capabilities/custom.star-chart/workers'))
    await client.close()
  })

  it('keeps an unreachable plugin pool unknown and rejects invalid capability paths locally', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ detail: 'unavailable' }, { status: 503 }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await expect(client.getCapabilityWorkers('custom.star-chart')).rejects.toMatchObject({ code: 'CORE_HTTP_503' })
    await expect(client.getCapabilityWorkers('../workers')).rejects.toMatchObject({ code: 'CORE_INVALID_CAPABILITY_ID' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('resolves a legacy task_type onto the semantic workers path', async () => {
    const { client, fetcher } = clientFor({
      found: true,
      capability: 'media.transcode',
      registry_version: '1.0.0',
      declared: { count: 1, by_impl: { ffmpeg: 1 } },
      available_now: { count: 0, by_impl: {}, online_ttl_seconds: 90 },
      provides: [],
    })
    expect(await client.getCapabilityWorkers('video_compress')).toMatchObject({
      lookup: 'found',
      capability: 'media.transcode',
    })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/capabilities/media.transcode/workers'))
    await client.close()
  })

  it('does not invent an empty pool when the workers route is unauthorized', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ detail: 'private' }, { status: 401 }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await expect(client.getCapabilityWorkers('media.transcode')).rejects.toMatchObject({ code: 'CORE_HTTP_401', status: 401 })
    await client.close()
  })

  it('reports catalog membership without inventing a missing name as none', async () => {
    const body = {
      registry_version: '2.0.0',
      capabilities: [{ capability: 'media.transcode', implementations: ['ffmpeg'], legacy_task_types: ['video_compress'] },
        { capability: 'custom.star-chart', implementations: [], legacy_task_types: [] }],
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json(body)))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    expect(await client.registryContains('media.transcode')).toBe(true)
    expect(await client.registryContains('video_compress')).toBe(true)
    expect(await client.registryContains('custom.star-chart')).toBe(true)
    expect(await client.registryContains('invented.capability')).toBe(false)
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/capabilities'))
    expect(fetcher).toHaveBeenCalledTimes(4)
    await expect(client.registryContains('../workers')).rejects.toMatchObject({ code: 'CORE_INVALID_CAPABILITY_ID' })
    expect(fetcher).toHaveBeenCalledTimes(4)
    await client.close()
  })

  it('discovers live registry names beyond the bundled task-type map without claiming availability', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      capability: `custom.owner-skill-${index}`, implementations: [`runtime-${index}`], legacy_task_types: [],
    }))
    const { client, fetcher } = clientFor({ registry_version: '2.0', capabilities: rows, private_token: 'discard' })
    const result = await client.getCapabilityRegistry()
    expect(result).toEqual({
      registryVersion: '2.0',
      capabilities: rows.map(row => ({ capability: row.capability, implementations: row.implementations, legacyTaskTypes: [] })),
    })
    expect(JSON.stringify(result)).not.toContain('private_token')
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/capabilities'))
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' })
    await client.close()
  })

  it('rejects malformed or unbounded live registry fields instead of fabricating an empty list', async () => {
    const bodies = [
      { registry_version: '2.0', capabilities: [{ capability: 'custom.x', implementations: 'runtime', legacy_task_types: [] }] },
      { registry_version: '2.0', capabilities: [{ capability: 'custom.x', implementations: [], legacy_task_types: ['../unsafe'] }] },
      { registry_version: '2.0', capabilities: [{ capability: 'custom.x', implementations: [], legacy_task_types: [] }, { capability: 'custom.x', implementations: [], legacy_task_types: [] }] },
      { registry_version: '2.0', capabilities: Array.from({ length: 5_001 }, (_, index) => ({ capability: `custom.${index}`, implementations: [], legacy_task_types: [] })) },
    ]
    for (const body of bodies) {
      const { client } = clientFor(body, { maxResponseBytes: 1_000_000 })
      await expect(client.getCapabilityRegistry()).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
      await client.close()
    }
  })

  it('treats a malformed or unavailable registry list as unknown, not absent', async () => {
    const malformed = clientFor({ registry_version: '2.0.0', capabilities: [{ id: 'custom.star-chart' }] })
    expect(await malformed.client.registryContains('custom.star-chart')).toBeNull()
    await malformed.client.close()
    const unavailable = new QianshouCoreClient(config, () => 'test-access',
      vi.fn<typeof fetch>().mockResolvedValue(json({ detail: 'unavailable' }, { status: 503 })))
    expect(await unavailable.registryContains('custom.star-chart')).toBeNull()
    await unavailable.close()
  })

  it.each([
    ['RUNNING', null, false],
    ['DONE', { output_ref: 'private-result', token: 'discard' }, true],
    ['DONE', null, false],
    ['QUARANTINED', { output_ref: 'private-result' }, false],
    ['WAITING_FOR_WORKERS', null, false],
  ])('keeps %s progress without exposing task inputs or result contents', async (status, result, resultAvailable) => {
    const { client, fetcher } = clientFor({
      id: 'workload-1', status, progress: 0.5, result, spec: { inline_input: 'private input' },
    })
    expect(await client.getWorkload('workload-1')).toEqual({ id: 'workload-1', status, progress: 0.5, resultAvailable })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/workloads/workload-1'))
    await client.close()
  })

  it.each([
    ['2026-09-26T14:06:26.597510+00:00', '2026-09-26T14:06:26.597Z'],
    ['2026-09-26T14:06:26.597510', '2026-09-26T14:06:26.597Z'],
    ['2026-09-26T22:06:26.597+08:00', '2026-09-26T14:06:26.597Z'],
  ])('retains the central creation instant without browser-local timezone interpretation %s', async (created_at, createdAt) => {
    const { client } = clientFor({ id: 'workload-1', status: 'WAITING_FOR_WORKERS', progress: null, result: null, created_at })
    expect(await client.getWorkload('workload-1')).toEqual({ id: 'workload-1', status: 'WAITING_FOR_WORKERS',
      progress: null, resultAvailable: false, createdAt })
    await client.close()
  })

  it.each(['not-a-date', null, 123])('rejects malformed creation times without inventing elapsed time %s', async (created_at) => {
    const { client } = clientFor({ id: 'workload-1', status: 'DONE', progress: 1, result: null, created_at })
    await expect(client.getWorkload('workload-1')).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
    await client.close()
  })

  it.each([
    [[{ status: 'PENDING', started_at: null }], 'waiting'],
    [[{ status: 'DISPATCHED', started_at: null }], 'waiting'],
    [[{ status: 'RUNNING', started_at: '2026-09-26T13:00:00Z', progress_at: '2026-09-26T13:00:01Z' }], 'executing'],
    [[{ status: 'RUNNING', started_at: '2026-09-26T13:00:00Z', progress_at: null }], undefined],
    [[{ status: 'RUNNING', started_at: null }], undefined],
    [[{ status: 'DONE', started_at: '2026-09-26T13:00:00Z' }], 'checking'],
  ])('uses actual same-task shard startup receipts for execution progress %#', async (shards, stage) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: 'workload-1', status: 'RUNNING', progress: 0, result: null }))
      .mockResolvedValueOnce(json({ workload_id: 'workload-1', workload_status: 'RUNNING', shards }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    expect((await client.getWorkload('workload-1')).executionStage).toBe(stage)
    expect(fetcher.mock.calls[1]?.[0]).toEqual(new URL('https://core.example.test/api/v8/workloads/workload-1/shards'))
    await client.close()
  })

  it.each([
    { workload_id: 'another-workload', workload_status: 'RUNNING', shards: [{ status: 'RUNNING', started_at: '2026-09-26T13:00:00Z' }] },
    { workload_id: 'workload-1', workload_status: 'RUNNING', shards: [null] },
  ])('does not infer running execution from an invalid or mismatched supplementary receipt %#', async (shards) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: 'workload-1', status: 'RUNNING', progress: 0, result: null }))
      .mockResolvedValueOnce(json(shards))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    expect(await client.getWorkload('workload-1')).toEqual({ id: 'workload-1', status: 'RUNNING', progress: 0, resultAvailable: false })
    await client.close()
  })

  it('reads developer-task inline results and never GETs download or workload result twins', async () => {
    const { client, fetcher } = clientFor({
      ok: true, id: 'workload-1', status: 'DONE', result: { inline_output: '3 words' },
    })
    expect(await client.getWorkloadResult('workload-1')).toEqual({
      id: 'workload-1', status: 'DONE', inlineOutput: '3 words', artifactRef: null,
    })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/developer/tasks/workload-1/result'))
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' })
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('/download')
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('/api/v8/workloads/')
    await client.close()
  })

  it('reads an ordinary workload media result after a definite developer-task 404', async () => {
    const manifest = { schema: 'artifact.v1', workload_id: 'workload-1', account_id: 167,
      object_key: 'v8/account-167/workload-workload-1/shard-shard-1/result/result-1/image.png', object_version_id: 'version-1', result_id: 'result-1',
      shard_id: 'shard-1', filename: 'image.png', content_type: 'image/png',
      size_bytes: 100, sha256: 'a'.repeat(64) }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ detail: 'not a developer task' }, { status: 404 }))
      .mockResolvedValueOnce(json({ id: 'workload-1', owner_id: 167, status: 'DONE',
        result: { output_ref: JSON.stringify(manifest), inline_output: null } }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    expect(await client.getWorkloadResult('workload-1')).toEqual({ id: 'workload-1', status: 'DONE',
      inlineOutput: null, artifactRef: `qianshou-media://task/workload-1/${'a'.repeat(64)}.png` })
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v8/developer/tasks/workload-1/result', '/api/v8/workloads/workload-1',
    ])
    await client.close()
  })

  const videoId = '12345678-1234-4234-8234-123456789abc'
  const videoAsset = 'a'.repeat(64)
  const videoPublication = '11111111-2222-4333-8444-555555555555'
  const firstFrameKey = `v8/account-41/reviewed-video/input/${'e'.repeat(32)}/frame.png`
  const videoManifest = (contentType: string, extension: string) => ({ schema: 'artifact.v1',
    workload_id: videoId, account_id: 41,
    object_key: `v8/account-41/workload-${videoId}/shard-shard-1/result/result-1/result.${extension}`,
    object_version_id: 'version-1', result_id: 'result-1', shard_id: 'shard-1',
    filename: `result.${extension}`, content_type: contentType, size_bytes: 100, sha256: videoAsset })
  const videoDetail = (extension: string, contentType: string, reviewed: boolean) => ({
    id: videoId, owner_id: 41, status: 'DONE',
    spec: { task_type: reviewed ? 'owner_video_v1' : 'video_compress',
      verification_policy: reviewed ? 'semantic' : 'artifact', input_kind: reviewed ? 'multi_file' : 'inline',
      input_refs: reviewed ? [firstFrameKey] : [],
      requirements: reviewed ? {
        _reviewed_task_contract: { schema: 'qianshou.reviewed-workload-contract.v1',
          publication_id: videoPublication, artifact_digest: `sha256:${'b'.repeat(64)}`,
          package_digest: `sha256:${'c'.repeat(64)}`, contract_sha256: `sha256:${'d'.repeat(64)}`,
          result_strategy: 'external-media.v1', output_kind: 'artifact_ref' },
        reviewed_publication: { schema: 'qianshou.reviewed-publication-selection.v1',
          publication_id: videoPublication, artifact_digest: `sha256:${'b'.repeat(64)}`,
          contract_sha256: `sha256:${'d'.repeat(64)}` },
        _reviewed_video_input_binding: { schema: 'qianshou.reviewed-video-input-binding.v1',
          account_id: 41, task_type: 'owner_video_v1', file_sha256: `sha256:${'e'.repeat(64)}`,
          file: { objectKey: firstFrameKey, objectVersionId: 'version-1',
            sha256: 'f'.repeat(64), contentType: 'image/png' } },
      } : {} },
    result: { output_ref: JSON.stringify(videoManifest(contentType, extension)), inline_output: null },
  })
  const videoRef = (extension: string) => `qianshou-media://task/${videoId}/${videoAsset}.${extension}`

  it.each([['webm', 'video/webm'], ['mov', 'video/quicktime']])(
    'keeps an ordinary %s video result after owner detail confirms no reviewed order', async (extension, contentType) => {
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        const path = new URL(String(url)).pathname
        if (path.endsWith('/result')) return json({ ok: true, id: videoId, status: 'DONE', output_ref: videoRef(extension) })
        if (path === `/api/v8/workloads/${videoId}`) return json(videoDetail(extension, contentType, false))
        if (path === '/api/v8/auth/me') return json(identity)
        throw new Error('unexpected route')
      })
      const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
      expect(await client.getWorkloadResult(videoId)).toEqual({ id: videoId, status: 'DONE',
        inlineOutput: null, artifactRef: videoRef(extension) })
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        `/api/v8/developer/tasks/${videoId}/result`, `/api/v8/workloads/${videoId}`, '/api/v8/auth/me',
      ])
      await client.close()
    },
  )

  it.each([['webm', 'video/webm'], ['mov', 'video/quicktime']])(
    'does not return a reviewed %s artifact reference to the model', async (extension, contentType) => {
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        const path = new URL(String(url)).pathname
        if (path.endsWith('/result')) return json({ ok: true, id: videoId, status: 'DONE', output_ref: videoRef(extension) })
        if (path === `/api/v8/workloads/${videoId}`) return json(videoDetail(extension, contentType, true))
        if (path === '/api/v8/auth/me') return json(identity)
        throw new Error('unexpected route')
      })
      const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
      await expect(client.getWorkloadResult(videoId)).rejects.toMatchObject({ code: 'CORE_REVIEWED_VIDEO_RESULT_INVALID' })
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain(
        `/api/v8/developer/tasks/${videoId}/download`)
      await client.close()
    },
  )

  it('admits one reviewed MP4 only when the owner detail resolves the same asset', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/result')) return json({ ok: true, id: videoId, status: 'DONE', output_ref: videoRef('mp4') })
      if (path === `/api/v8/workloads/${videoId}`) return json(videoDetail('mp4', 'video/mp4', true))
      if (path === '/api/v8/auth/me') return json(identity)
      throw new Error('unexpected route')
    })
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    expect(await client.getWorkloadResult(videoId)).toEqual({ id: videoId, status: 'DONE',
      inlineOutput: null, artifactRef: videoRef('mp4') })
    await client.close()
  })

  it('rejects a reviewed MP4 whose developer reference differs from the owner result', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/result')) return json({ ok: true, id: videoId, status: 'DONE', output_ref: videoRef('mp4') })
      if (path === `/api/v8/workloads/${videoId}`) {
        const detail = videoDetail('mp4', 'video/mp4', true)
        return json({ ...detail, result: { output_ref: JSON.stringify({
          ...videoManifest('video/mp4', 'mp4'), sha256: 'f'.repeat(64),
        }) } })
      }
      if (path === '/api/v8/auth/me') return json(identity)
      throw new Error('unexpected route')
    })
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await expect(client.getWorkloadResult(videoId)).rejects.toMatchObject({ code: 'CORE_REVIEWED_VIDEO_RESULT_INVALID' })
    await client.close()
  })

  it('keeps an ordinary MOV manifest on the owner-detail fallback without another detail request', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/result')) return json({ detail: 'not a developer task' }, { status: 404 })
      if (path === `/api/v8/workloads/${videoId}`) return json(videoDetail('mov', 'video/quicktime', false))
      if (path === '/api/v8/auth/me') return json(identity)
      throw new Error('unexpected route')
    })
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    expect(await client.getWorkloadResult(videoId)).toMatchObject({ artifactRef: videoRef('mov') })
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/api/v8/developer/tasks/${videoId}/result`, `/api/v8/workloads/${videoId}`, '/api/v8/auth/me',
    ])
    await client.close()
  })

  it('fails closed for an unknown owner detail or missing reviewed markers', async () => {
    for (const owner of [null, { ...videoDetail('webm', 'video/webm', true), spec: {
      ...videoDetail('webm', 'video/webm', true).spec,
      requirements: { reviewed_publication: videoDetail('webm', 'video/webm', true).spec.requirements.reviewed_publication },
    } }, { ...videoDetail('webm', 'video/webm', true), spec: {
      ...videoDetail('webm', 'video/webm', true).spec, requirements: {}, input_refs: [],
    } }]) {
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        const path = new URL(String(url)).pathname
        if (path.endsWith('/result')) return json({ ok: true, id: videoId, status: 'DONE', output_ref: videoRef('webm') })
        if (path === `/api/v8/workloads/${videoId}`) return owner === null
          ? json({ detail: 'missing' }, { status: 404 }) : json(owner)
        if (path === '/api/v8/auth/me') return json(identity)
        throw new Error('unexpected route')
      })
      const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
      await expect(client.getWorkloadResult(videoId)).rejects.toMatchObject({ code: 'CORE_VIDEO_RESULT_UNVERIFIED' })
      await client.close()
    }
  })

  it('does not turn hostile identifiers into developer-task result paths', async () => {
    const { client, fetcher } = clientFor({})
    for (const id of ['../auth/me', '..', 'x?token=value', '/auth/me', 'x%2fy', 'x\nnext']) {
      await expect(client.getWorkloadResult(id)).rejects.toMatchObject({ code: 'CORE_INVALID_WORKLOAD_ID' })
    }
    expect(fetcher).not.toHaveBeenCalled()
    await client.close()
  })

  it('rejects mismatched workload identity and malformed progress rather than forging a receipt', async () => {
    for (const body of [
      { id: 'other-task', status: 'DONE', progress: 1, result: {} },
      { id: 'workload-1', status: 'RUNNING', progress: 120, result: null },
      { id: 'workload-1', status: 'DONE', progress: 1, result: 'raw result' },
    ]) {
      const { client } = clientFor(body)
      await expect(client.getWorkload('workload-1')).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
      await client.close()
    }
  })

  it('does not turn hostile task identifiers into paths or query parameters', async () => {
    const { client, fetcher } = clientFor({})
    for (const id of ['../auth/me', '..', 'x?token=value', '/auth/me', 'x%2fy', 'x\nnext']) {
      await expect(client.getWorkload(id)).rejects.toMatchObject({ code: 'CORE_INVALID_WORKLOAD_ID' })
    }
    expect(fetcher).not.toHaveBeenCalled()
    await client.close()
  })

  it('posts the observed developer-task route and never posts /api/v8/workloads', async () => {
    const created = {
      ok: true, id: 'workload-1', task_id: 'workload-1', workload_id: 'workload-1',
      status: 'CREATED', progress: 0, reused: false,
    }
    const { client, fetcher } = clientFor(created)
    const body = {
      task_type: 'video_compress', input_kind: 'inline' as const, input_ref: '' as const, input_refs: [] as [],
      inline_input: 'goal', params: {} as Record<string, never>, name: '' as const, budget: '0.50', quote_token: null,
      timeout_s: 300 as const, max_shards: 1, auto_shard: false, idempotency_key: 'a'.repeat(64),
      callback_url: '' as const, callback_secret: '' as const,
    }
    expect(await client.createDeveloperTask(body)).toEqual({
      id: 'workload-1', status: 'CREATED', progress: 0, resultAvailable: false,
    })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/developer/tasks'))
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer test-access', Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('/api/v8/workloads')
    await client.close()
  })

  it('posts the exact final-task preview and keeps its ticket on the Host client return only', async () => {
    const body = {
      task_type: 'video_compress', input_kind: 'inline' as const, input_ref: '' as const, input_refs: [] as [],
      inline_input: 'private goal', params: {} as Record<string, never>, name: '' as const, budget: '0.50', quote_token: null,
      timeout_s: 300 as const, max_shards: 2, auto_shard: true, idempotency_key: 'b'.repeat(64),
      callback_url: '' as const, callback_secret: '' as const,
    }
    const estimate = {
      ok: true, task_type: body.task_type, input_kind: body.input_kind,
      currency: 'CNY', estimated_total: '0.75', recommended_budget: '0.75', requested_budget: '0.50',
      quote_token: 'host-only-ticket', quote_expires_at: 1_800_000_000,
      balance_enough: true, price_basis: 'server-rule', settings_version: 9,
      billing_mode: 'server_price',
    }
    const { client, fetcher } = clientFor(estimate)
    expect(await client.estimateDeveloperTask(body)).toMatchObject({
      recommendedBudget: '0.75', quoteToken: 'host-only-ticket', expiresAt: 1_800_000_000,
    })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/developer/tasks/estimate'))
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(body) })
    await client.close()

    const neverCalled = vi.fn<typeof fetch>()
    const signedOut = new QianshouCoreClient(config, () => undefined, neverCalled)
    await expect(signedOut.estimateDeveloperTask(body)).rejects.toMatchObject({ code: 'CORE_CREDENTIALS_MISSING' })
    expect(neverCalled).not.toHaveBeenCalled()
    await signedOut.close()

    for (const changed of [
      { ...estimate, task_type: 'other-task' },
      { ...estimate, requested_budget: '0.51' },
      { ...estimate, estimated_total: '0.76' },
      { ...estimate, quote_token: '' },
      { ...estimate, recommended_budget: '-1.00' },
      { ...estimate, balance_enough: 'yes' },
    ]) {
      const attempt = clientFor(changed)
      await expect(attempt.client.estimateDeveloperTask(body)).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
      await attempt.client.close()
    }
  })

  it('requires a Shanghai echo of the exact product on estimate and create', async () => {
    const selected = { product_id: '11111111-2222-4333-8444-555555555555',
      publication_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', owner_id: 167, version: '1.2' }
    const body = { task_type: 'seller_product_v1', input_kind: 'inline' as const,
      input_ref: '' as const, input_refs: [] as [], inline_input: 'goal', params: {} as Record<string, never>,
      name: '' as const, budget: '0.00', quote_token: null, timeout_s: 300 as const,
      max_shards: 1, auto_shard: false, idempotency_key: 'a'.repeat(64),
      callback_url: '' as const, callback_secret: '' as const, selected_product: selected }
    const estimate = { ok: true, task_type: body.task_type, input_kind: body.input_kind,
      currency: 'CNY', estimated_total: '0.50', recommended_budget: '0.50', requested_budget: '0.00',
      quote_token: 'selected-ticket', quote_expires_at: 1_800_000_000, balance_enough: true,
      price_basis: 'server-rule', settings_version: 9, billing_mode: 'server_price' }
    const created = { ok: true, id: 'workload-product', task_id: 'workload-product',
      workload_id: 'workload-product', status: 'CREATED', progress: 0 }
    const listing = { id: selected.product_id, publication_id: selected.publication_id,
      owner_id: selected.owner_id, version: selected.version,
      task_type: body.task_type, status: 'published' }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(listing))
      .mockResolvedValueOnce(json({ ...estimate, selected_product: selected }))
      .mockResolvedValueOnce(json({ ...created, selected_product: selected }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await client.assertSelectedProduct({ productId: selected.product_id,
      publicationId: selected.publication_id, ownerId: selected.owner_id,
      version: selected.version }, body.task_type)
    expect((await client.estimateDeveloperTask(body)).recommendedBudget).toBe('0.50')
    expect((await client.createDeveloperTask(body)).id).toBe('workload-product')
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/api/v8/order-adapter-products/${selected.product_id}`,
      '/api/v8/developer/tasks/estimate', '/api/v8/developer/tasks',
    ])
    await client.close()

    const old = clientFor(estimate)
    await expect(old.client.estimateDeveloperTask(body))
      .rejects.toMatchObject({ code: 'COMPUTE_PRODUCT_SELECTION_UNSUPPORTED' })
    await old.client.close()
    const missingCreate = clientFor(created)
    await expect(missingCreate.client.createDeveloperTask(body))
      .rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
    await missingCreate.client.close()
  })

  it('rejects a changed exact product before asking Shanghai for a quote', async () => {
    const selection = { productId: '11111111-2222-4333-8444-555555555555',
      publicationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ownerId: 167, version: '1.2' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({
      id: selection.productId, publication_id: selection.publicationId,
      owner_id: 168, version: selection.version,
      task_type: 'seller_product_v1', status: 'published',
    }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await expect(client.assertSelectedProduct(selection, 'seller_product_v1'))
      .rejects.toMatchObject({ code: 'COMPUTE_PRODUCT_SELECTION_CHANGED' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('reads accepted input kinds without inventing file uploads', async () => {
    const { client, fetcher } = clientFor({
      ok: true,
      items: [{ task_type: 'ocr_image', description: 'OCR', accepted_input_kinds: ['inline'], default_input_kind: 'inline' }],
      total: 1,
    })
    expect(await client.getDeveloperTaskTypes()).toEqual([
      { taskType: 'ocr_image', acceptedInputKinds: ['inline'], defaultInputKind: 'inline', runtimes: [], description: 'OCR', category: '', requiredParams: null,
        formSchemaVersion: null, formReady: false, inputSchema: null, paramsSchema: null },
    ])
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/developer/task-types'))
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' })
    await client.close()
  })

  it('adds a semantic capability id on registry landings and omits it for unknown task types', async () => {
    const { client } = clientFor({
      ok: true,
      items: [
        { task_type: 'video_compress', description: 'Transcode', accepted_input_kinds: ['inline'], default_input_kind: 'inline' },
        { task_type: 'ocr_image', description: 'OCR', accepted_input_kinds: ['inline'], default_input_kind: 'inline' },
      ],
    })
    expect(await client.getDeveloperTaskTypes()).toEqual([
      { taskType: 'video_compress', acceptedInputKinds: ['inline'], defaultInputKind: 'inline', runtimes: [], description: 'Transcode', category: '', requiredParams: null, capabilityId: 'media.transcode',
        formSchemaVersion: null, formReady: false, inputSchema: null, paramsSchema: null },
      { taskType: 'ocr_image', acceptedInputKinds: ['inline'], defaultInputKind: 'inline', runtimes: [], description: 'OCR', category: '', requiredParams: null,
        formSchemaVersion: null, formReady: false, inputSchema: null, paramsSchema: null },
    ])
    await client.close()
  })

  it('uses an explicit platform capability id for new video task names and rejects identity conflicts', async () => {
    const row = { task_type: 'owner_video_v1', capability_id: 'video.render',
      accepted_input_kinds: ['multi_file'], default_input_kind: 'multi_file' }
    const { client } = clientFor({ ok: true, items: [row] })
    expect((await client.getDeveloperTaskTypes())[0]).toMatchObject({
      taskType: 'owner_video_v1', capabilityId: 'video.render',
    })
    await client.close()
    for (const changed of [
      { ...row, capability_id: 'media.transcode', task_type: 'video_generate' },
      { ...row, capability_id: 'video.render/other' },
      { ...row, capability_id: '' },
    ]) {
      const attempt = clientFor({ ok: true, items: [changed] })
      await expect(attempt.client.getDeveloperTaskTypes()).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
      await attempt.client.close()
    }
  })

  it('accepts only a reviewed public video declaration with an explicit first-frame slot', async () => {
    const contract = { schema: 'qianshou.comfy-video-public-contract.v1',
      taskType: 'owner_video_v1', capabilityId: 'video.render',
      graph: { format: 'comfyui-api', sha256: 'a'.repeat(64), nodeCount: 3 },
      inputSlots: [
        { name: 'prompt', kind: 'text', nodeId: '2', field: 'prompt', maxUtf8Bytes: 4096 },
        { name: 'first_frame', kind: 'artifact_ref', nodeId: '100', field: 'image',
          mimeType: 'image/png', maxBytes: 16 * 1024 * 1024 },
      ],
      outputs: [{ nodeId: '27', classType: 'VHS_VideoCombine', kind: 'artifact_ref', mimeType: 'video/mp4' }],
      runner: { abi: COMFY_VIDEO_RUNNER_ABI, sourceSha256: 'b'.repeat(64) },
      dependencyManifestSha256: 'c'.repeat(64),
      limits: { maxDurationSeconds: 5, maxFrames: 120, maxWidth: 1344, maxHeight: 768,
        maxVramMiB: 16384, maxInputBytes: 17 * 1024 * 1024, maxOutputBytes: 64 * 1024 * 1024,
        timeoutSeconds: 600 },
    }
    const review = { schema: 'qianshou.reviewed-video-task-input.v1', status: 'approved',
      publication_id: '11111111-2222-4333-8444-555555555555',
      approved_contract_digest: comfyVideoPublicContractDigest(contract),
      public_contract: contract, first_frame_slot: 'first_frame', prompt_slot: 'prompt',
      first_frame_source: { kind: 'uploaded_input_manifest', parameter: 'input_manifest', index: 0 },
      prompt_param: 'prompt' }
    const publication = { schema: 'qianshou.reviewed-publication-selection.v1',
      publication_id: review.publication_id, artifact_digest: `sha256:${'d'.repeat(64)}`,
      contract_sha256: `sha256:${'e'.repeat(64)}` }
    const row = { task_type: 'owner_video_v1', capability_id: 'video.render',
      accepted_input_kinds: ['multi_file'], default_input_kind: 'multi_file',
      reviewed_video_input: review, reviewed_publication: publication }
    const { client } = clientFor({ ok: true, items: [row] })
    const [type] = await client.getDeveloperTaskTypes()
    expect(type?.reviewedVideoInput).toMatchObject({ firstFrameSlot: 'first_frame',
      promptSlot: 'prompt', mimeType: 'image/png', approvedContractDigest: review.approved_contract_digest })
    expect(type?.reviewedPublication).toEqual(publication)
    const projectedClient = { getDeveloperTaskTypes: async () => type === undefined ? [] : [type] }
    const [visible] = await new ComputeService(projectedClient as unknown as QianshouCoreClient,
      {} as ComputeDraftStore, () => true).taskTypes()
    expect(visible?.reviewedVideoInput).toMatchObject({
      publicationId: review.publication_id,
      approvedContractDigest: review.approved_contract_digest,
      firstFrameSlot: 'first_frame', promptSlot: 'prompt',
      firstFrameManifestParam: 'input_manifest', firstFrameManifestIndex: 0, promptParam: 'prompt',
    })
    expect(visible?.reviewedPublication).toEqual({ schema: publication.schema,
      publicationId: publication.publication_id, artifactDigest: publication.artifact_digest,
      contractSha256: publication.contract_sha256 })
    await client.close()
    for (const bad of [
      { ...review, status: 'pending' },
      { ...review, first_frame_slot: 'reference_image' },
      { ...review, first_frame_source: { ...review.first_frame_source, index: 1 } },
      { ...review, prompt_param: 'description' },
      { ...review, approved_contract_digest: `sha256:${'0'.repeat(64)}` },
    ]) {
      const attempt = clientFor({ ok: true, items: [{ ...row, reviewed_video_input: bad }] })
      await expect(attempt.client.getDeveloperTaskTypes()).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
      await attempt.client.close()
    }
    for (const bad of [
      { ...publication, publication_id: '22222222-2222-4222-8222-222222222222' },
      { ...publication, artifact_digest: 'not-a-digest' },
      { ...publication, unexpected: 'x' },
    ]) {
      const attempt = clientFor({ ok: true, items: [{ ...row, reviewed_publication: bad }] })
      await expect(attempt.client.getDeveloperTaskTypes()).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
      await attempt.client.close()
    }
  })

  it('rejects duplicated or unbounded requestable task-type rows', async () => {
    const row = { task_type: 'custom.task', accepted_input_kinds: ['inline'], default_input_kind: 'inline' }
    const duplicate = clientFor({ ok: true, items: [row, row] })
    await expect(duplicate.client.getDeveloperTaskTypes()).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
    await duplicate.client.close()
    const oversized = clientFor({ ok: true, items: Array.from({ length: 5_001 }, (_, index) => ({ ...row, task_type: `custom.${index}` })) }, { maxResponseBytes: 1_000_000 })
    await expect(oversized.client.getDeveloperTaskTypes()).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
    await oversized.client.close()
  })

  it('uses the optional reverse lookup on catalogue, pool, and type reads', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/core-client.ts', import.meta.url)), 'utf8')
    expect(source).toContain('capabilityIdIfRegistered')
    expect(source).not.toContain('capabilityIdForTaskType')
  })

  it('keeps 409 and 422 status codes so the ledger can distinguish in-flight from validation', async () => {
    for (const status of [409, 422]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ detail: 'private' }, { status }))
      const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
      await expect(client.createDeveloperTask({
        task_type: 'video_compress', input_kind: 'inline', input_ref: '', input_refs: [], inline_input: 'g',
        params: {}, name: '', budget: '0.50', quote_token: null, timeout_s: 300, max_shards: 1, auto_shard: false,
        idempotency_key: 'k', callback_url: '', callback_secret: '',
      })).rejects.toMatchObject({ code: `CORE_HTTP_${status}`, status })
      await client.close()
    }
  })

  it('requires credentials before transport and suppresses credential-provider errors', async () => {
    const fetcher = vi.fn<typeof fetch>()
    for (const provider of [
      () => undefined,
      () => 'test-access\nsecret',
      () => { throw new Error('credential provider private value') },
      async () => undefined,
    ]) {
      const client = new QianshouCoreClient(config, provider, fetcher)
      await expect(client.getIdentity()).rejects.toThrow(/^CORE_CREDENTIALS_/u)
      await client.close()
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('sends the token returned by an async credential provider', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(identity))
    const client = new QianshouCoreClient(config, async () => 'async-access', fetcher)
    await client.getIdentity()
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer async-access' },
    })
    await client.close()
  })

  it('preserves HTTP status diagnostics without publishing upstream response bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ detail: 'private upstream secret' }, { status: 401 }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await expect(client.getIdentity()).rejects.toMatchObject({ code: 'CORE_HTTP_401', message: 'CORE_HTTP_401', status: 401 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('sanitizes network failures and never retries a failed read implicitly', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('https://private/?token=private'))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await expect(client.getIdentity()).rejects.toMatchObject({ code: 'CORE_UNAVAILABLE', message: 'CORE_UNAVAILABLE' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('checks UTF-8 bytes at the exact complete-response limit', async () => {
    const body = { ...identity, account: { ...identity.account, username: '用户' } }
    const size = new TextEncoder().encode(JSON.stringify(body)).byteLength
    const exact = clientFor(body, { maxResponseBytes: size })
    await expect(exact.client.getIdentity()).resolves.toMatchObject({ username: '用户' })
    await exact.client.close()
    const short = clientFor(body, { maxResponseBytes: size - 1 })
    await expect(short.client.getIdentity()).rejects.toMatchObject({ code: 'CORE_RESPONSE_TOO_LARGE' })
    await short.client.close()
  })

  it('rejects an oversized declared body before parsing it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(identity, { headers: { 'content-length': '100000' } }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await expect(client.getIdentity()).rejects.toMatchObject({ code: 'CORE_RESPONSE_TOO_LARGE' })
    await client.close()
  })

  it('rejects malformed response JSON and catalogue wrappers without copying them into errors', async () => {
    for (const response of [new Response('private malformed JSON'), json({ ok: true, items: 'private' }), json({ ok: false })]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
      const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
      await expect(client.getCapabilities()).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE', message: 'CORE_INVALID_RESPONSE' })
      await client.close()
    }
  })
})

describe('core transport ownership', () => {
  function waitingClient(timeoutMs = 500) {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => {
          const reason: unknown = signal?.reason
          reject(reason instanceof Error ? reason : new Error('aborted'))
        }
        if (signal?.aborted) rejectAbort()
        else signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    })
    return { client: new QianshouCoreClient({ ...config, timeoutMs }, () => 'test-access', fetcher), fetcher }
  }

  it('cancels an in-flight read when the caller aborts, without forwarding the caller reason', async () => {
    const { client, fetcher } = waitingClient()
    const controller = new AbortController()
    const pending = client.getIdentity(controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CORE_REQUEST_ABORTED', message: 'CORE_REQUEST_ABORTED' })
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(1)
    controller.abort('private caller reason')
    await rejected
    await client.close()
  })

  it('does not start transport when the caller aborts while the credential provider is still pending', async () => {
    let settle: ((value: string) => void) | undefined
    const fetcher = vi.fn<typeof fetch>()
    const client = new QianshouCoreClient(config, () => new Promise<string>((resolve) => { settle = resolve }), fetcher)
    const controller = new AbortController()
    const pending = client.getIdentity(controller.signal)
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    controller.abort('private caller reason')
    await expect(pending).rejects.toMatchObject({ code: 'CORE_REQUEST_ABORTED', message: 'CORE_REQUEST_ABORTED' })
    settle?.('late-access')
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    await client.close()
  })

  it('does not start transport for an already aborted caller', async () => {
    const { client, fetcher } = waitingClient()
    const controller = new AbortController()
    controller.abort()
    await expect(client.getIdentity(controller.signal)).rejects.toMatchObject({ code: 'CORE_REQUEST_ABORTED' })
    expect(fetcher).not.toHaveBeenCalled()
    await client.close()
  })

  it('close aborts all active requests, awaits cleanup, and refuses later reads', async () => {
    const { client } = waitingClient()
    const first = expect(client.getIdentity()).rejects.toMatchObject({ code: 'CORE_CLIENT_CLOSED' })
    const second = expect(client.getCapabilities()).rejects.toMatchObject({ code: 'CORE_CLIENT_CLOSED' })
    await Promise.resolve()
    await client.close()
    await Promise.all([first, second])
    await expect(client.getIdentity()).rejects.toMatchObject({ code: 'CORE_CLIENT_CLOSED' })
    await client.close()
  })

  it('reports a bounded timeout', async () => {
    const { client } = waitingClient(5)
    await expect(client.getIdentity()).rejects.toMatchObject({ code: 'CORE_REQUEST_TIMEOUT', status: 504 })
    await client.close()
  })

  it.each([
    'http://core.example.test', 'https://user:pass@core.example.test',
    'https://core.example.test/api/v8', 'https://core.example.test?token=value',
    'https://core.example.test#fragment', 'file:///tmp/core', 'invalid',
  ])('rejects unsafe or ambiguous origins: %s', (baseUrl) => {
    expect(() => new QianshouCoreClient({ ...config, baseUrl }, () => 'test-access')).toThrow('CORE_INVALID_ORIGIN')
  })

  it.each(['http://127.0.0.1:8000', 'http://localhost:8000', 'http://[::1]:8000'])(
    'supports explicit loopback fixtures: %s',
    async (baseUrl) => {
      const { client } = clientFor(identity, { baseUrl })
      await expect(client.getIdentity()).resolves.toMatchObject({ accountId: 41 })
      await client.close()
    },
  )
})

/**
 * 取消与账本是 W-23 新开的两个线调用。判据钉在**动词与形状**上：
 * DELETE（不是"带 body 就 POST"）、不带请求体、账本按原样解析且不重算金额。
 */
describe('core cancellation and ledger reads', () => {
  it('cancels with DELETE and no body, and returns the scheduler status verbatim', async () => {
    const { client, fetcher } = clientFor({ id: 'workload-1', status: 'CANCELLED', error: '已取消 (user_cancel)' })
    await expect(client.cancelWorkload('workload-1')).resolves.toEqual({ id: 'workload-1', status: 'CANCELLED' })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/workloads/workload-1'))
    const init = fetcher.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-access' })
    await client.close()
  })

  it('surfaces a rejected cancellation as an explicit HTTP failure instead of a fake success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ ok: false, code: 'VALIDATION_ERROR', message: '任务已 DONE · 无法取消' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await expect(client.cancelWorkload('workload-done')).rejects.toMatchObject({ code: 'CORE_HTTP_400' })
    await client.close()
  })

  it('never turns a hostile workload identity into a path or query', async () => {
    const { client, fetcher } = clientFor({})
    for (const id of ['../auth/me', '..', 'x?token=value', '/auth/me', 'x%2fy', 'x\nnext']) {
      await expect(client.cancelWorkload(id)).rejects.toMatchObject({ code: 'CORE_INVALID_WORKLOAD_ID' })
    }
    expect(fetcher).not.toHaveBeenCalled()
    await client.close()
  })

  it('reads ledger rows as reported, with no computed balance', async () => {
    const { client, fetcher } = clientFor({ ok: true, items: [
      { id: 'row-1', type: 'REFUND', amount: '0.0100', currency: 'CNY', workload_id: 'workload-1', shard_id: null,
        note: '任务退款', created_at: '2026-09-17T06:00:00+00:00' },
      { id: 'row-2', type: 'ESCROW_HOLD', amount: '-0.0100', workload_id: null, note: '', created_at: '' },
    ] })
    await expect(client.getLedger()).resolves.toEqual([
      { id: 'row-1', type: 'REFUND', amount: '0.0100', workloadId: 'workload-1', note: '任务退款', createdAt: '2026-09-17T06:00:00+00:00' },
      { id: 'row-2', type: 'ESCROW_HOLD', amount: '-0.0100', workloadId: null, note: '', createdAt: '' },
    ])
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/economy/ledger?limit=50'))
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).method).toBe('GET')
    await client.close()
  })

  it('rejects a ledger body that is not the documented envelope', async () => {
    const { client } = clientFor({ ok: true, items: 'not-a-list' })
    await expect(client.getLedger()).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
    await client.close()
  })
})

describe('owner node dashboard read', () => {
  const workerId = 'worker-mac-001'
  const body = {
    schema: 'qianshou.node-dashboard.v1', worker_id: workerId,
    history_scope: 'current_shard_assignment',
    counts: { executions: 1, orders: 1, succeeded: 1, failed: 0, cancelled: 0,
      pending_resolution: 0, avg_success_elapsed_ms: 4929 },
    earnings: { currency: 'CNY', settled_node_compute: '0.4875' },
    plugin_calls: null, plugin_calls_note: '插件执行尚无可核实的订单事件，暂不计次。',
    total: 1, limit: 20, offset: 0,
    items: [{ shard_id: 'shard-1', workload_id: 'order-1', task_type: 'word_count',
      status: 'done', attempts: 1, dispatched_at: '2026-09-23T03:21:14+00:00',
      started_at: null, completed_at: null, elapsed_ms: 4929, settled_node_compute_cny: '0.4875',
      output_ref: 'private answer', input_ref: 'private prompt' }],
    account_balance: 'private account balance',
  }

  it('reads owner-scoped exact money and strips task content', async () => {
    const { client, fetcher } = clientFor(body)
    const result = await client.getNodeDashboard(workerId)
    expect(result.earnings.settled_node_compute).toBe('0.4875')
    expect(result.items[0]?.settled_node_compute_cny).toBe('0.4875')
    expect(JSON.stringify(result)).not.toContain('private')
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL(
      'https://core.example.test/api/v8/workers/worker-mac-001/dashboard?limit=20&offset=0'))
    await client.close()
  })

  it('rejects another worker, a float income, or an unbounded offset', async () => {
    const wrong = clientFor({ ...body, worker_id: 'another-worker' })
    await expect(wrong.client.getNodeDashboard(workerId)).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
    await wrong.client.close()
    const amount = clientFor({ ...body, earnings: { currency: 'CNY', settled_node_compute: 0.4875 } })
    await expect(amount.client.getNodeDashboard(workerId)).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
    await expect(amount.client.getNodeDashboard(workerId, 100_001)).rejects.toMatchObject({ code: 'CORE_INVALID_DASHBOARD_OFFSET' })
    await amount.client.close()
  })
})

describe('capability pool service mapping', () => {
  function serviceFor(client: Pick<QianshouCoreClient, 'getCapabilityWorkers' | 'registryContains'> | null, hasCredential = true) {
    return new ComputeService(client as QianshouCoreClient | null, {} as ComputeDraftStore, () => hasCredential)
  }

  it('does not turn a 401 workers answer into declared or available zero', async () => {
    const client = {
      getCapabilityWorkers: vi.fn().mockRejectedValue(new ComputeError('CORE_HTTP_401', 401)),
      registryContains: vi.fn().mockResolvedValue(true),
    }
    const snapshot = await serviceFor(client).pool('media.transcode')
    expect(snapshot).toMatchObject({
      lookup: 'unreachable',
      capability: 'media.transcode',
      declared: null,
      availableNow: null,
      note: '目录里有这个能力，但我现在查不到池子里有没有节点能接',
    })
    expect(snapshot.declared).not.toBe(0)
    expect(snapshot.availableNow).not.toBe(0)
  })

  it('does not claim the catalog is empty when the core is not configured', async () => {
    const snapshot = await serviceFor(null, false).pool('media.transcode')
    expect(snapshot.lookup).toBe('unreachable')
    expect(snapshot.declared).toBeNull()
    expect(snapshot.availableNow).toBeNull()
    expect(snapshot.note).toContain('查不到池子')
    expect(snapshot.note).not.toContain('目录里有这个能力')
  })
})

describe('live capability discovery service', () => {
  const registry = { registryVersion: '2.0', capabilities: [{ capability: 'custom.star-chart', implementations: ['trusted-runtime'], legacyTaskTypes: [] }] }
  const taskTypes = [{ taskType: 'word_count', acceptedInputKinds: ['inline'], defaultInputKind: 'inline', capabilityId: 'text.transform' }]

  it('keeps live registry and requestable task types independent, with no pool or quote claim', async () => {
    const client = {
      getCapabilityRegistry: vi.fn().mockResolvedValue(registry),
      getDeveloperTaskTypes: vi.fn().mockResolvedValue(taskTypes),
    }
    const service = new ComputeService(client as unknown as QianshouCoreClient,
      {} as ComputeDraftStore, () => true)
    const result = await service.capabilityDiscovery()
    expect(result.registry).toMatchObject({ status: 'observed', reason: null, registryVersion: '2.0', capabilities: registry.capabilities })
    expect(result.requestableTaskTypes).toMatchObject({
      status: 'observed', reason: null,
      items: [{ taskType: 'word_count', acceptedInputKinds: ['inline'], defaultInputKind: 'inline' }],
    })
    expect(result.registry.observedAt).toMatch(/^\d{4}-/u)
    expect(result.requestableTaskTypes.observedAt).toMatch(/^\d{4}-/u)
    expect(JSON.stringify(result)).not.toContain('capabilityId')
    expect(JSON.stringify(result)).not.toContain('availableNow')
    expect(JSON.stringify(result)).not.toContain('quote')
  })

  it('marks one failed read unknown without erasing the other and preserves cancellation', async () => {
    const client = {
      getCapabilityRegistry: vi.fn().mockRejectedValue(new ComputeError('CORE_HTTP_401', 401)),
      getDeveloperTaskTypes: vi.fn().mockResolvedValue(taskTypes),
    }
    const service = new ComputeService(client as unknown as QianshouCoreClient, {} as ComputeDraftStore, () => true)
    const result = await service.capabilityDiscovery()
    expect(result.registry).toEqual({ status: 'unreachable', observedAt: null, reason: 'auth_required', registryVersion: null, capabilities: null })
    expect(result.requestableTaskTypes.status).toBe('observed')
    client.getCapabilityRegistry.mockRejectedValue(new ComputeError('CORE_REQUEST_ABORTED', 499))
    await expect(service.capabilityDiscovery()).rejects.toMatchObject({ code: 'CORE_REQUEST_ABORTED' })
  })

  it('does not turn an unconfigured source into an empty registry or task list', async () => {
    const result = await new ComputeService(null, {} as ComputeDraftStore, () => false).capabilityDiscovery()
    expect(result.registry).toEqual({ status: 'unreachable', observedAt: null, reason: 'not_configured', registryVersion: null, capabilities: null })
    expect(result.requestableTaskTypes).toEqual({ status: 'unreachable', observedAt: null, reason: 'not_configured', items: null })
  })
})

describe('account service mapping', () => {
  it('does not invent a zero when /me has no balance and does not treat CREDIT negatives as withdrawals', async () => {
    const client = {
      getAccountView: vi.fn().mockResolvedValue({
        identity: { accountId: 41, username: 'member', role: 'enterprise', status: 'active' },
        balance: null,
      }),
      getLedger: vi.fn().mockResolvedValue([
        { id: 'c1', type: 'CREDIT', amount: '-3.0000', workloadId: 'wl_1', note: '', createdAt: '' },
        { id: 'w1', type: 'WITHDRAW', amount: '-10.0000', workloadId: null, note: '', createdAt: '' },
      ]),
    }
    const snapshot = await new ComputeService(client as unknown as QianshouCoreClient, {} as ComputeDraftStore, () => true).account()
    expect(snapshot.balance).toBeNull()
    expect(snapshot.balanceNote).toBe('上游没返回这一项')
    expect(snapshot.rewards).toBeNull()
    expect(snapshot.withdrawn.total).toBeNull()
    expect(snapshot.withdrawn.rows.map(row => row.id)).toEqual(['w1'])
    expect(snapshot.balance).not.toBe(0)
    expect(snapshot.rewards).not.toBe(0)
    expect(snapshot.withdrawn.total).not.toBe(0)
  })

  it('does not display 0 when the core is not configured', async () => {
    const snapshot = await new ComputeService(null, {} as ComputeDraftStore, () => false).account()
    expect(snapshot.balance).toBeNull()
    expect(snapshot.rewards).toBeNull()
    expect(snapshot.ledger).toBeNull()
    expect(snapshot.balanceNote).toBe('上游没返回这一项')
    expect(snapshot.balance).not.toBe(0)
  })
})
