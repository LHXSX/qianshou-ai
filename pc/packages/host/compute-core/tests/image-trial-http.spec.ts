import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import { updateWorkOf } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { registerImageTrialRoutes } from '../src/image-trial-routes.ts'
import { ImageTrialHost, type ImageTrialConfig, type ImageTrialJob } from '../src/image-trial.ts'
import { inspectPrivateComfyPng } from '../src/comfy-png.ts'

const prefix = '/api/qianshou/compute/image-trial/'
const cleanups: Array<() => Promise<void>> = []
const limits = { maxRecords: 10, maxStoreBytes: 65536 }
const request = (size = 'square') => ({ id: randomUUID(), sessionId: 'owner-session', prompt: '友善的外星人', size })
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs() })

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function png(width = 1024, height = 1024): Buffer {
  const chunk = (name: string, bytes: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), bytes])
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([size, body, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3)))), chunk('IEND', Buffer.alloc(0))])
}

async function upstream(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing test port')
  return `http://127.0.0.1:${address.port}`
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-image-trial-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  return join(root, 'private')
}
async function mount(config?: ImageTrialConfig, existingDir?: string) {
  const path = existingDir ?? await directory()
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const effects: Array<() => unknown> = []
  const root = {}
  const sessions = new Set(['owner-session', 'other-session'])
  const persistedSessions = new Map<string, string>()
  const readStoredSession = vi.fn(async (id: string) => {
    const storedId = persistedSessions.get(id)
    return storedId === undefined ? undefined : { header: { id: storedId } }
  })
  const ctx = {
    root,
    get: (key: string) => key === 'agents' ? { get: (id: string) => sessions.has(id) ? { id } : undefined }
      : key === 'sessionPersistence' ? { stat: readStoredSession } : undefined,
    connection: { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
      routes.set(route.path, route.fetch); return () => { routes.delete(route.path) }
    } } },
    effect: (activate: () => () => unknown) => { effects.push(activate()) },
  } as unknown as Context
  registerImageTrialRoutes(ctx, config, path, limits)
  const close = async () => { for (const effect of effects.splice(0).reverse()) await effect() }
  cleanups.push(close)
  return { path, root, routes, sessions, persistedSessions, readStoredSession, close,
    call: async (route: string, body?: unknown) => {
      const endpoint = routes.get(prefix + route.split('?')[0])
      if (!endpoint) return new Response(null, { status: 404 })
      return endpoint(new Request('http://localhost' + prefix + route, body === undefined ? undefined : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }))
    },
  }
}
async function waitForJob(api: Awaited<ReturnType<typeof mount>>, id: string) {
  let job: ImageTrialJob | undefined
  await vi.waitFor(async () => {
    const response = await api.call(`job?id=${id}&sessionId=owner-session`)
    expect(response.status).toBe(200)
    job = await response.json() as ImageTrialJob
    expect(job.status).not.toBe('running')
  }, { timeout: 3000, interval: 10 })
  return job!
}
function config(gatewayOrigin: string): ImageTrialConfig { return { gatewayOrigin, tokenEnv: 'QIANSHOU_IMAGE_TEST_KEY' } }

it('is disabled without configuration and removes all owner routes on disposal', async () => {
  const api = await mount()
  expect(await (await api.call('status')).json()).toEqual({ enabled: false, sizes: ['square', 'landscape', 'portrait'], steps: 8, supportedSteps: [8, 12, 20], billing: 'research-no-charge' })
  expect((await api.call('jobs', request())).status).toBe(503)
  await api.close()
  expect(api.routes.size).toBe(0)
})

it('refuses new image submissions during update maintenance while keeping original job and image GET available', async () => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  const bytes = png()
  let posts = 0
  const origin = await upstream((req, res) => {
    if (req.url === '/image') { posts++; res.end(JSON.stringify({ url: '/img/5080/original.png' })); return }
    res.setHeader('Content-Type', 'image/png'); res.end(bytes)
  })
  const api = await mount(config(origin))
  const input = request()
  expect((await api.call('jobs', input)).status).toBe(202)
  const completed = await waitForJob(api, input.id)
  const registry = updateWorkOf(api.root)
  try {
    expect(await registry.control('lock')).toBe(false)
    const refused = await api.call('jobs', request())
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ error: { code: 'IMAGE_TRIAL_UPDATE_IN_PROGRESS' } })
    expect(await (await api.call(`job?id=${input.id}&sessionId=owner-session`)).json()).toEqual(completed)
    expect(Buffer.from(await (await api.call(`image?id=${input.id}&sessionId=owner-session`)).arrayBuffer())).toEqual(bytes)
    expect(posts).toBe(1)
  } finally { await registry.control('unlock') }
})

it.each([12, 20] as const)('forwards %i steps once, retains dimensions and restores the original receipt without generation', async (steps) => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  const bytes = png()
  const payloads: unknown[] = []
  const deadlines = vi.spyOn(AbortSignal, 'timeout')
  const origin = await upstream((req, res) => {
    if (req.url === '/image') {
      const chunks: Buffer[] = []
      req.on('data', data => chunks.push(data)); req.on('end', () => {
        payloads.push(JSON.parse(Buffer.concat(chunks).toString()))
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: '/img/5080/result.png' }))
      })
    } else { res.setHeader('Content-Type', 'image/png'); res.end(bytes) }
  })
  const api = await mount(config(origin))
  const input = { ...request(), steps }
  expect((await api.call('jobs', input)).status).toBe(202)
  const completed = await waitForJob(api, input.id)
  expect(completed).toMatchObject({ status: 'completed', steps, width: 1024, height: 1024, billing: 'research-no-charge' })
  expect(payloads).toHaveLength(1)
  expect(payloads[0]).toMatchObject({ steps, width: 1024, height: 1024, auto_enhance: false })
  expect(deadlines).toHaveBeenCalledWith(360000 * steps / 8)
  expect((await api.call('jobs', { ...input, steps: steps === 12 ? 20 : 12 })).status).toBe(409)
  expect((await api.call('jobs', input)).status).toBe(202)
  await api.close()
  const restored = await mount(config(origin), api.path)
  expect(await (await restored.call(`job?id=${input.id}&sessionId=owner-session`)).json()).toEqual(completed)
  expect(Buffer.from(await (await restored.call(`image?id=${input.id}&sessionId=owner-session`)).arrayBuffer())).toEqual(bytes)
  expect(payloads).toHaveLength(1)
  deadlines.mockRestore()
})

it.each([0, 10, 50, '12', null])('rejects unsupported sampling steps %s before reserving a request', async (steps) => {
  const api = await mount(config('http://127.0.0.1:18991'))
  expect((await api.call('jobs', { ...request(), steps })).status).toBe(400)
})

it.each([12, 20] as const)('recovers a transient %i-step PNG delivery by the original private path without another generation', async (steps) => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  const bytes = png()
  let posts = 0
  const reads: string[] = []
  const origin = await upstream((req, res) => {
    if (req.url === '/image') {
      posts++; res.end(JSON.stringify({ url: '/img/5080/original.png' })); return
    }
    reads.push(req.url ?? '')
    expect(req.headers['x-api-key']).toBe('test-host-only-value')
    if (reads.length === 1) { res.writeHead(503); res.end(); return }
    res.setHeader('Content-Type', 'image/png'); res.end(bytes)
  })
  const api = await mount(config(origin))
  const input = { ...request(), steps }
  expect((await api.call('jobs', input)).status).toBe(202)
  const completed = await waitForJob(api, input.id)
  expect(completed).toMatchObject({ status: 'completed', steps, timing: { phase: 'receiving' } })
  expect(posts).toBe(1)
  expect(reads).toEqual(['/img/5080/original.png', '/img/5080/original.png'])
  const stored = JSON.parse(await readFile(join(api.path, 'jobs.json'), 'utf8')) as {
    jobs: Array<{ delivery: { path: string; gatewaySha256: string } }>
  }
  expect(stored.jobs[0]?.delivery).toEqual({ path: '/img/5080/original.png',
    gatewaySha256: createHash('sha256').update(origin).digest('hex') })
  expect(JSON.stringify(completed)).not.toContain('/img/')
  expect(JSON.stringify(completed)).not.toContain(origin)
  expect(JSON.stringify(stored)).not.toContain('test-host-only-value')
  expect(Buffer.from(await (await api.call(`image?id=${input.id}&sessionId=owner-session`)).arrayBuffer())).toEqual(bytes)
  expect((await api.call('jobs', input)).status).toBe(202)
  expect(posts).toBe(1)
})

it('persists the original delivery reference before GET and resumes it after Host close without a new GPU POST', async () => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  const bytes = png()
  let posts = 0
  let reads = 0
  let resumed = false
  const origin = await upstream((req, res) => {
    if (req.url === '/image') { posts++; res.end(JSON.stringify({ url: '/img/5080/original.png' })); return }
    reads++
    expect(req.url).toBe('/img/5080/original.png')
    if (resumed) { res.setHeader('Content-Type', 'image/png'); res.end(bytes) }
  })
  const api = await mount(config(origin))
  const input = { ...request(), steps: 20 as const }
  await api.call('jobs', input)
  await vi.waitFor(() => { expect(reads).toBe(1) })
  const before = JSON.parse(await readFile(join(api.path, 'jobs.json'), 'utf8')) as {
    jobs: Array<ImageTrialJob & { delivery: { path: string; gatewaySha256: string } }>
  }
  expect(before.jobs[0]).toMatchObject({ id: input.id, status: 'running', steps: 20,
    timing: { phase: 'receiving' }, delivery: { path: '/img/5080/original.png' } })
  await api.close()
  resumed = true
  const restored = await mount(config(origin), api.path)
  const completed = await waitForJob(restored, input.id)
  expect(completed).toMatchObject({ status: 'completed', steps: 20, timing: before.jobs[0]?.timing })
  expect(posts).toBe(1)
  expect(reads).toBe(2)
  expect(JSON.stringify(completed)).not.toContain('delivery')
  expect(Buffer.from(await (await restored.call(`image?id=${input.id}&sessionId=owner-session`)).arrayBuffer())).toEqual(bytes)
})

it.each(['/img/5080/../secret.png', '/img/5080/original.png?token=secret', '//attacker.invalid/image.png',
  'https://attacker.invalid/image.png'])('rejects a stored unsafe delivery reference %s without any upstream request', async (path) => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  let calls = 0
  const origin = await upstream((_req, res) => { calls++; res.end() })
  const api = await mount(config(origin))
  const input = request()
  await mkdir(api.path, { mode: 0o700 })
  await writeFile(join(api.path, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ ...input, steps: 8,
    status: 'failed', errorCode: 'IMAGE_TRIAL_OUTCOME_UNKNOWN', width: 1024, height: 1024, billing: 'research-no-charge',
    timing: { submittedAt: '2026-09-29T00:00:00.000Z', phase: 'receiving' },
    delivery: { path, gatewaySha256: createHash('sha256').update(origin).digest('hex') } }] }))
  expect((await api.call(`job?id=${input.id}&sessionId=owner-session`)).status).toBe(503)
  expect(calls).toBe(0)
})

it('retains a known delivery reference after a gateway origin change without fetching from the replacement origin', async () => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  let calls = 0
  const origin = await upstream((_req, res) => { calls++; res.end() })
  const api = await mount(config(origin))
  const input = request()
  await mkdir(api.path, { mode: 0o700 })
  await writeFile(join(api.path, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ ...input, steps: 8,
    status: 'failed', errorCode: 'IMAGE_TRIAL_OUTCOME_UNKNOWN', width: 1024, height: 1024, billing: 'research-no-charge',
    timing: { submittedAt: '2026-09-29T00:00:00.000Z', phase: 'receiving' },
    delivery: { path: '/img/5080/original.png', gatewaySha256: createHash('sha256').update('http://127.0.0.1:1').digest('hex') } }] }))
  expect(await (await api.call(`job?id=${input.id}&sessionId=owner-session`)).json()).toMatchObject({
    status: 'failed', errorCode: 'IMAGE_TRIAL_OUTCOME_UNKNOWN',
  })
  expect(calls).toBe(0)
})

it('does not resolve an interrupted POST without a saved media reference by another upstream request', async () => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  let calls = 0
  const origin = await upstream((_req, res) => { calls++; res.end() })
  const api = await mount(config(origin))
  const input = request()
  await mkdir(api.path, { mode: 0o700 })
  await writeFile(join(api.path, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ ...input, steps: 8,
    status: 'running', width: 1024, height: 1024, billing: 'research-no-charge' }] }))
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await (await api.call(`job?id=${input.id}&sessionId=owner-session`)).json()).toMatchObject({
      status: 'failed', errorCode: 'IMAGE_TRIAL_OUTCOME_UNKNOWN',
    })
  }
  expect(calls).toBe(0)
})

it('uses the configured Host credential once, persists the PNG, and binds duplicate requests to the Session', async () => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  const bytes = png()
  let posts = 0
  const keys: (string | string[] | undefined)[] = []
  let release: (() => void) | undefined
  let releaseImage: (() => void) | undefined
  const origin = await upstream((req, res) => {
    expect(req.headers['x-api-key']).toBe('test-host-only-value')
    expect(req.headers.origin).toBeUndefined()
    if (req.url === '/image') {
      posts++
      keys.push(req.headers['idempotency-key'])
      const chunks: Buffer[] = []; req.on('data', data => chunks.push(data)); req.on('end', () => {
        expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({ width: 1024, height: 1024, steps: 8, node: '5080', style: null })
        release = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: '/img/5080/result.png' })) }
      })
    } else { releaseImage = () => { res.setHeader('Content-Type', 'image/png'); res.end(bytes) } }
  })
  const api = await mount(config(origin))
  const input = request()
  const started = await api.call('jobs', input)
  expect(started.status).toBe(202)
  const accepted = await started.json() as ImageTrialJob
  expect(accepted).toMatchObject({ ...input, status: 'running', billing: 'research-no-charge', timing: { phase: 'generating' } })
  expect(new Date(accepted.timing!.submittedAt).toISOString()).toBe(accepted.timing!.submittedAt)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const persisted = JSON.parse(await readFile(join(api.path, 'jobs.json'), 'utf8')) as { jobs: ImageTrialJob[] }
  expect(persisted.jobs[0]?.timing).toEqual(accepted.timing)
  const duplicate = await api.call('jobs', input)
  expect(duplicate.status).toBe(202)
  expect((await duplicate.json() as ImageTrialJob).timing).toEqual(accepted.timing)
  expect((await api.call('jobs', { ...input, prompt: 'different' })).status).toBe(409)
  expect((await api.call('jobs', request())).status).toBe(409)
  expect((await api.call('jobs', { ...request(), sessionId: 'missing-session' })).status).toBe(403)
  expect((await api.call(`job?id=${input.id}&sessionId=other-session`)).status).toBe(404)
  release!()
  await vi.waitFor(() => expect(releaseImage).toBeTypeOf('function'))
  const receiving = await (await api.call(`job?id=${input.id}&sessionId=owner-session`)).json() as ImageTrialJob
  expect(receiving).toMatchObject({ status: 'running', timing: { submittedAt: accepted.timing!.submittedAt, phase: 'receiving' } })
  const receivingReceipt = JSON.parse(await readFile(join(api.path, 'jobs.json'), 'utf8')) as { jobs: ImageTrialJob[] }
  expect(receivingReceipt.jobs[0]?.timing).toEqual(receiving.timing)
  releaseImage!()
  const completed = await waitForJob(api, input.id)
  expect(completed).toMatchObject({ status: 'completed', result: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })
  expect(completed.timing).toEqual(receiving.timing)
  const result = await api.call(`image?id=${input.id}&sessionId=owner-session`)
  expect(result.status).toBe(200); expect(result.headers.get('content-type')).toBe('image/png')
  expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes)
  expect(posts).toBe(1)
  expect(keys).toEqual([input.id])
  const receipt = await readFile(join(api.path, 'jobs.json'), 'utf8')
  expect(receipt).not.toContain('test-host-only-value'); expect(receipt).not.toContain(origin)
  if (process.platform !== 'win32') expect((await stat(join(api.path, `${input.id}.png`))).mode & 0o777).toBe(0o600)
  await api.close()
  const restored = await mount(config(origin), api.path)
  expect((await restored.call('jobs', input)).status).toBe(202)
  expect((await (await restored.call(`job?id=${input.id}&sessionId=owner-session`)).json() as ImageTrialJob).timing).toEqual(completed.timing)
  expect((await restored.call(`image?id=${input.id}&sessionId=owner-session`)).status).toBe(200)
  expect(posts).toBe(1)
  expect(keys).toEqual([input.id])
})

it('reads a completed image after its persisted Session leaves memory without admitting another submission', async () => {
  const api = await mount(config('http://127.0.0.1:1'))
  const input = request()
  const bytes = png()
  await mkdir(api.path, { mode: 0o700 })
  await writeFile(join(api.path, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ ...input,
    status: 'completed', steps: 8, width: 1024, height: 1024, billing: 'research-no-charge',
    result: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }] }))
  await writeFile(join(api.path, `${input.id}.png`), bytes)
  api.sessions.clear()
  api.persistedSessions.set('owner-session', 'owner-session')
  api.persistedSessions.set('other-session', 'other-session')
  const result = await api.call(`job?id=${input.id}&sessionId=owner-session`)
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ ...input, status: 'completed' })
  const image = await api.call(`image?id=${input.id}&sessionId=owner-session`)
  expect(image.status).toBe(200)
  expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes)
  expect(api.readStoredSession).toHaveBeenCalledWith('owner-session', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  for (const route of ['job', 'image']) {
    expect((await api.call(`${route}?id=${input.id}&sessionId=other-session`)).status).toBe(404)
    expect((await api.call(`${route}?id=${input.id}&sessionId=missing-session`)).status).toBe(403)
  }
  expect((await api.call('jobs', input)).status).toBe(403)
  expect((await api.call('jobs', request())).status).toBe(403)
})

it('refuses missing or mismatched stored Session identity and contains storage errors', async () => {
  const api = await mount(config('http://127.0.0.1:1'))
  api.sessions.clear()
  api.persistedSessions.set('owner-session', 'different-session')
  const id = randomUUID()
  for (const route of ['job', 'image']) {
    expect((await api.call(`${route}?id=${id}&sessionId=owner-session`)).status).toBe(403)
    expect((await api.call(`${route}?id=${id}&sessionId=missing-session`)).status).toBe(403)
  }
  const reads = api.readStoredSession.mock.calls.length
  expect((await api.call(`job?id=${id}&sessionId=..%2Fprivate`)).status).toBe(403)
  expect(api.readStoredSession).toHaveBeenCalledTimes(reads)
  api.readStoredSession.mockRejectedValue(new Error('private storage detail'))
  const unavailable = await api.call(`job?id=${id}&sessionId=owner-session`)
  expect(unavailable.status).toBe(502)
  expect(await unavailable.json()).toEqual({ error: {
    code: 'IMAGE_TRIAL_REQUEST_FAILED', message: 'IMAGE_TRIAL_REQUEST_FAILED',
  } })
})

it.each(['https://attacker.invalid/image.png', '//attacker.invalid/image.png', '/img/5080/../secret.png', '/img/5080/file.png?token=secret'])('rejects unsafe returned media path %s without fetching it', async (returnedPath) => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  let calls = 0
  const origin = await upstream((_req, res) => { calls++; res.end(JSON.stringify({ url: returnedPath })) })
  const api = await mount(config(origin)); const input = request()
  await api.call('jobs', input)
  expect(await waitForJob(api, input.id)).toMatchObject({ status: 'failed', errorCode: 'IMAGE_TRIAL_RESULT_INVALID' })
  expect(calls).toBe(1)
})

it.each(['invalid', 'oversized', 'wrong-dimensions', 'redirect'])('rejects %s media and exposes only a stable error code', async (mode) => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  const origin = await upstream((req, res) => {
    if (req.url === '/image') { res.end(JSON.stringify({ url: '/img/5080/result.png' })); return }
    if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/private' }); res.end(); return }
    res.setHeader('Content-Type', 'image/png')
    if (mode === 'oversized') res.setHeader('Content-Length', 16 * 1024 * 1024 + 1)
    res.end(mode === 'wrong-dimensions' ? png(512, 512) : Buffer.from('private upstream text with credentials'))
  })
  const api = await mount(config(origin)); const input = request()
  await api.call('jobs', input)
  const finished = await waitForJob(api, input.id)
  expect(finished.status).toBe('failed')
  expect(finished.errorCode).toMatch(/^IMAGE_TRIAL_/u)
  expect(JSON.stringify(finished)).not.toContain('credentials')
  expect((await api.call(`image?id=${input.id}&sessionId=owner-session`)).status).toBe(409)
})

it('retains a crash-interrupted request as unknown and never repeats its POST', async () => {
  const path = await directory()
  const api = await mount(config('http://127.0.0.1:1'), path)
  const input = request()
  await mkdir(path, { mode: 0o700 })
  await writeFile(join(path, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ ...input,
    status: 'running', steps: 8, width: 1024, height: 1024, billing: 'research-no-charge' }] }))
  const repeated = await api.call('jobs', input)
  expect(repeated.status).toBe(202)
  const restored = await repeated.json() as ImageTrialJob
  expect(restored).toMatchObject({ status: 'failed', errorCode: 'IMAGE_TRIAL_OUTCOME_UNKNOWN' })
  expect(restored.timing).toBeUndefined()
})

it('reports a refused gateway connection without inferring an unknown model outcome or retrying the UUID', async () => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  const listener = createServer()
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const address = listener.address()
  if (address === null || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>(resolve => listener.close(() => resolve()))
  const api = await mount(config(`http://127.0.0.1:${address.port}`))
  const input = request()
  await api.call('jobs', input)
  const failed = await waitForJob(api, input.id)
  expect(failed).toMatchObject({ status: 'failed', errorCode: 'IMAGE_TRIAL_GATEWAY_UNAVAILABLE', timing: { phase: 'generating' } })
  expect(await (await api.call('jobs', input)).json()).toEqual(failed)
})

it('keeps a disconnected accepted request unknown instead of claiming the gateway refused it', async () => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  let posts = 0
  let key: string | string[] | undefined
  const origin = await upstream((req) => { posts++; key = req.headers['idempotency-key']; req.socket.destroy() })
  const api = await mount(config(origin)); const input = request()
  await api.call('jobs', input)
  expect(await waitForJob(api, input.id)).toMatchObject({ status: 'failed', errorCode: 'IMAGE_TRIAL_OUTCOME_UNKNOWN' })
  expect(posts).toBe(1)
  expect(key).toBe(input.id)
  expect((await api.call('jobs', input)).status).toBe(202)
  expect(posts).toBe(1)
})

it.each([
  { submittedAt: 'not-a-date', phase: 'generating' },
  { submittedAt: '2026-02-31T00:00:00.000Z', phase: 'generating' },
  { submittedAt: '2026-09-29T00:00:00.000Z', phase: 'sampling' },
])('rejects invalid persisted gateway timing %j', async (timing) => {
  const path = await directory()
  const api = await mount(config('http://127.0.0.1:1'), path)
  const input = request()
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path, { mode: 0o700 })
  await writeFile(join(path, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ ...input,
    status: 'running', steps: 8, width: 1024, height: 1024, billing: 'research-no-charge', timing }] }))
  expect((await api.call(`job?id=${input.id}&sessionId=owner-session`)).status).toBe(503)
})

it('supports both large aspect presets while preserving the old private Comfy PNG limit', async () => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  let generated = png()
  const origin = await upstream((req, res) => {
    if (req.url === '/image') {
      const chunks: Buffer[] = []; req.on('data', data => chunks.push(data)); req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { width: number; height: number }
        generated = png(body.width, body.height)
        res.end(JSON.stringify({ url: '/img/5080/result.png' }))
      })
    } else { res.setHeader('Content-Type', 'image/png'); res.end(generated) }
  })
  const api = await mount(config(origin))
  for (const size of ['landscape', 'portrait']) {
    const input = request(size); await api.call('jobs', input)
    expect((await waitForJob(api, input.id)).status).toBe('completed')
  }
  expect(() => inspectPrivateComfyPng(generated)).toThrow('COMPUTE_COMFY_PNG_INVALID')
})

it('disposal aborts local waiting without sending an upstream cancellation or a retry', async () => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  let calls = 0
  const origin = await upstream(() => { calls++ })
  const api = await mount(config(origin)); const input = request()
  await api.call('jobs', input)
  await vi.waitFor(() => expect(calls).toBe(1))
  await api.close()
  const saved = JSON.parse(await readFile(join(api.path, 'jobs.json'), 'utf8')) as { jobs: ImageTrialJob[] }
  expect(saved.jobs[0]).toMatchObject({ status: 'failed', errorCode: 'IMAGE_TRIAL_OUTCOME_UNKNOWN' })
  expect(calls).toBe(1)
})

it.each(['https://127.0.0.1:18991', 'http://localhost:18991', 'http://127.0.0.1:18991/path', 'http://example.com:18991'])('fails unsafe deployment origin %s before any request', async (gatewayOrigin) => {
  expect(() => new ImageTrialHost(config(gatewayOrigin), '/tmp/private-test', limits)).toThrow('IMAGE_TRIAL_CONFIG_INVALID')
})


it('waits for generation headers on the job deadline rather than built-in fetch headers timeout', async () => {
  vi.stubEnv('QIANSHOU_IMAGE_TEST_KEY', 'test-host-only-value')
  const bytes = png()
  let posts = 0
  let releaseHeaders: (() => void) | undefined
  const origin = await upstream((req, res) => {
    if (req.url === '/image') {
      posts++
      req.resume()
      releaseHeaders = () => res.end(JSON.stringify({ url: '/img/5080/delayed.png' }))
    } else { res.setHeader('Content-Type', 'image/png'); res.end(bytes) }
  })
  const realFetch = globalThis.fetch
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) === origin + '/image') throw new TypeError('headers timeout', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })
    return realFetch(input, init)
  })
  try {
    const api = await mount(config(origin))
    const input = { ...request(), steps: 20 }
    expect((await api.call('jobs', input)).status).toBe(202)
    await vi.waitFor(() => expect(releaseHeaders).toBeTypeOf('function'))
    releaseHeaders?.()
    expect(await waitForJob(api, input.id)).toMatchObject({ status: 'completed', steps: 20 })
    expect(posts).toBe(1)
    expect(fetch.mock.calls).toHaveLength(1)
    expect(String(fetch.mock.calls[0]?.[0])).toBe(origin + '/img/5080/delayed.png')
  } finally { fetch.mockRestore() }
})
