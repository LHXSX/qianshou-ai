/** Real HTTP fixtures exercise the private Host lifecycle without launching GPU work. */
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import * as Sessions from '@deepseek-ai/dsh-session'
import { load as loadYaml } from 'js-yaml'
import { afterEach, expect, it, vi } from 'vitest'
import * as ComputeCore from '../src/index.ts'
import { ImageTrialHost } from '../src/image-trial.ts'
import { registerVideoTrialRoutes } from '../src/video-trial-routes.ts'
import { VideoTrialHost, type VideoTrialConfig, type VideoTrialJob } from '../src/video-trial.ts'

const cleanups: Array<() => Promise<void>> = []
const limits = { maxRecords: 10, maxStoreBytes: 65536 }
const prefix = '/api/qianshou/compute/video-trial/'
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const expected = { executionRecipeSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64) }
const input = () => ({ id: randomUUID(), sessionId: 'owner-session', prompt: '友善外星人挥手', seconds: 5, orientation: 'landscape', quality: 'fast' })
const attachment = () => ({ mediaType: 'image/png', data: png().toString('base64') })
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs() })

function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8); header.writeUInt32BE(body.length + 8); header.write(type, 4)
  return Buffer.concat([header, body])
}
function words(...values: number[]): Buffer {
  const result = Buffer.alloc(values.length * 4)
  values.forEach((value, i) => result.writeUInt32BE(value, i * 4))
  return result
}
function mp4(options: { wide?: boolean; longTime?: boolean; audio?: boolean; frames?: 119 | 120 } = {}): Buffer {
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), words(512), Buffer.from('isomiso2')]))
  const frames = options.frames ?? 120
  const mdat = box('mdat', Buffer.alloc(frames * 2, 1))
  const tkhd = Buffer.alloc(options.longTime ? 96 : 84)
  tkhd[0] = options.longTime ? 1 : 0
  tkhd.writeUInt32BE(1344 * 65536, tkhd.length - 8); tkhd.writeUInt32BE(768 * 65536, tkhd.length - 4)
  const mdhd = Buffer.alloc(options.longTime ? 36 : 24)
  mdhd[0] = options.longTime ? 1 : 0
  mdhd.writeUInt32BE(600, options.longTime ? 20 : 12)
  if (options.longTime) mdhd.writeBigUInt64BE(3000n, 24)
  else mdhd.writeUInt32BE(3000, 16)
  const hdlr = Buffer.alloc(24); hdlr.write(options.audio ? 'soun' : 'vide', 8)
  const sample = Buffer.alloc(78)
  sample.writeUInt16BE(1, 6); sample.writeUInt16BE(1344, 24); sample.writeUInt16BE(768, 26)
  const offset = Buffer.alloc(options.wide ? 8 : 4)
  if (options.wide) offset.writeBigUInt64BE(BigInt(ftyp.length + 8))
  else offset.writeUInt32BE(ftyp.length + 8)
  const stbl = box('stbl', Buffer.concat([
    box('stsd', Buffer.concat([words(0, 1), box('avc1', sample)])),
    box('stsz', words(0, 2, frames)), box('stsc', words(0, 1, 1, frames, 1)),
    box('stts', frames === 119 ? words(0, 2, 118, 25, 1, 50) : words(0, 1, 120, 25)),
    box(options.wide ? 'co64' : 'stco', Buffer.concat([words(0, 1), offset])),
  ]))
  const mdia = box('mdia', Buffer.concat([box('mdhd', mdhd), box('hdlr', hdlr), box('minf', stbl)]))
  return Buffer.concat([ftyp, mdat, box('moov', box('trak', Buffer.concat([box('tkhd', tkhd), mdia])))])
}
function png(width = 1, height = 1): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const contents = Buffer.concat([Buffer.from(type), body])
    let crc = 0xffffffff
    for (const byte of contents) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    return Buffer.concat([words(body.length), contents, words((crc ^ 0xffffffff) >>> 0)])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3)))), chunk('IEND', Buffer.alloc(0))])
}

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-video-trial-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  return join(root, 'private')
}
async function upstream(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() =>{  resolve() })) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing port')
  return `http://127.0.0.1:${address.port}`
}
async function gateway() {
  const state = { posts: [] as Array<Record<string, unknown>>, gets: 0, videos: 0, imagePosts: 0, imageGet: 0,
    mode: 'done', busy: false, badProfile: false, badIdentity: false, badReceipt: false, badMedia: false,
    firstFrame: '', postLost: false, identityLost: false, readFailed: false, imageRelease: undefined as (() => void) | undefined,
    blockImage: false, bytes: mp4() }
  const origin = await upstream((req, res) => {
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
    const url = new URL(req.url ?? '/', 'http://test')
    if (url.pathname === '/health') { json({ ok: true, comfy: true, presets: ['landscape_C'], queue: { running: state.busy ? 1 : 0, pending: 0 } }); return }
    if (url.pathname === '/v1/spec') { json({ modelProfiles: { qs_new4: { steps: state.badProfile ? 8 : 4, width: 1344, height: 768, supported_seconds: [3, 5] } } }); return }
    if (url.pathname === '/v1/recipes/qs_new4/identity') {
      if (state.identityLost) { res.destroy(); return }
      state.firstFrame = url.searchParams.get('firstFrameSha256') ?? ''
      json({ workflow: 'qs_new4', ...expected, firstFrameSha256: state.badIdentity ? 'f'.repeat(64) : state.firstFrame,
        negativeSha256: url.searchParams.get('negativeSha256') }); return
    }
    if (url.pathname === '/v1/jobs' && req.method === 'POST') {
      const chunks: Buffer[] = []; req.on('data', (data: Buffer) => { chunks.push(data) }); req.on('end', () => {
        state.posts.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
        if (state.postLost) { res.destroy(); return }
        json({ job_id: `remote_${state.posts.length}`, id: `remote_${state.posts.length}` })
      }); return
    }
    if (/^\/v1\/jobs\/remote_\d+$/u.test(url.pathname)) {
      state.gets++
      if (state.readFailed) { res.writeHead(503).end(); return }
      const id = url.pathname.split('/').at(-1)!
      const submitted = state.posts[Number(id.split('_')[1]) - 1]!
      json({ id, job_id: id, status: state.mode, progress: { percent: state.mode === 'running' ? 37 : null }, percent: 0,
        fed: { workflow: 'qs_new4', steps: 4, seconds: 5, width: state.badReceipt ? 1 : 1344, height: 768, seed: submitted.seed },
        recipe_identity: { expected, actual: expected, attested: true }, video_url: 'https://untrusted.invalid/ignored' }); return
    }
    if (/^\/v1\/jobs\/remote_\d+\/video$/u.test(url.pathname)) {
      state.videos++; res.setHeader('Content-Type', 'video/mp4'); res.end(state.badMedia ? state.bytes.subarray(0, -1) : state.bytes); return
    }
    if (url.pathname === '/image') {
      state.imagePosts++
      const chunks: Buffer[] = []; req.on('data', (data: Buffer) => { chunks.push(data) }); req.on('end', () => {
        expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({ width: 2048, height: 1152, steps: 8 })
        const complete = () =>{  json({ url: '/img/5080/frame.png' }) }
        if (state.blockImage) state.imageRelease = complete
        else complete()
      }); return
    }
    if (url.pathname === '/img/5080/frame.png') { state.imageGet++; res.setHeader('Content-Type', 'image/png'); res.end(png(2048, 1152)); return }
    res.writeHead(404).end()
  })
  return { ...state, origin, state }
}
async function images(path: string, origin?: string) {
  vi.stubEnv('VIDEO_FIRST_FRAME_TEST_KEY', 'private-host-only')
  const host = new ImageTrialHost(origin === undefined ? undefined : { gatewayOrigin: origin, tokenEnv: 'VIDEO_FIRST_FRAME_TEST_KEY' }, path + '.image', limits)
  cleanups.push(() => host.close())
  return host
}
async function mount(config?: VideoTrialConfig, existing?: string, imageHost?: ImageTrialHost) {
  const path = existing ?? await directory()
  const image = imageHost ?? await images(path)
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const effects: Array<() => unknown> = []
  const sessions = new Set(['owner-session', 'other-session'])
  const persisted = new Map<string, string>()
  const readStored = vi.fn(async (id: string) => persisted.has(id) ? { header: { id: persisted.get(id) } } : undefined)
  const ctx = {
    root: {},
    get: (key: string) => key === 'agents' ? { get: (id: string) => sessions.has(id) ? { id } : undefined }
      : key === 'sessionPersistence' ? { stat: readStored } : undefined,
    connection: { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
      routes.set(route.path, route.fetch); return () => { routes.delete(route.path) }
    } } },
    effect: (activate: () => () => unknown) => { effects.push(activate()) },
  } as unknown as Context
  registerVideoTrialRoutes(ctx, config, path, limits, image)
  const close = async () => { for (const effect of effects.splice(0).reverse()) await effect() }
  cleanups.push(close)
  return { path, routes, sessions, persisted, readStored, close,
    call: async (route: string, body?: unknown) => {
      const endpoint = routes.get(new URL(prefix + route, 'http://localhost').pathname)
      if (endpoint === undefined) return new Response(null, { status: 404 })
      return endpoint(new Request('http://localhost' + prefix + route, body === undefined ? undefined : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }))
    },
  }
}
async function waitForJob(api: Awaited<ReturnType<typeof mount>>, id: string, status = 'completed') {
  let job: VideoTrialJob | undefined
  await vi.waitFor(async () => {
    const result = await api.call(`job?id=${id}&sessionId=owner-session`)
    expect(result.status).toBe(200); job = await result.json() as VideoTrialJob
    expect(job.status).toBe(status)
  }, { timeout: 4000, interval: 10 })
  return job!
}

it('boots the combined research overlay through the production Loader and preserves media after reopen', async () => {
  const remote = await gateway()
  const root = await directory()
  await mkdir(root, { recursive: true })
  vi.stubEnv('QIANSHOU_PRIVATE_IMAGE_TOKEN', 'private-host-only')
  const patches = loadYaml(await readFile(new URL('../../../../qianshou/video-trial.patch.yml', import.meta.url), 'utf8')) as Parameters<typeof applyEntryPatches>[1]
  const [entry] = applyEntryPatches([{ id: 'qianshou-compute-core', name: '@deepseek-ai/dsh-compute-core', config: {} }], patches,
    (message) => { throw new Error(message) })
  expect(entry!.config).toMatchObject({ baseUrl: 'https://qianshousuanli.com',
    imageTrial: { gatewayOrigin: 'http://127.0.0.1:18991', tokenEnv: 'QIANSHOU_PRIVATE_IMAGE_TOKEN' },
    videoTrial: { gatewayOrigin: 'http://127.0.0.1:18852' } })
  const overlayConfig = entry!.config as ComputeCore.Config
  const config: ComputeCore.Config = Object.assign({}, overlayConfig, { statePath: join(root, 'plans.json'), maxTaskRecords: limits.maxRecords,
    maxStoreBytes: limits.maxStoreBytes, imageTrial: { ...overlayConfig.imageTrial!, gatewayOrigin: remote.origin },
    videoTrial: { ...overlayConfig.videoTrial!, gatewayOrigin: remote.origin } })
  const openComposition = async () => {
    const routes = new Map<string, ConnectionFetchRoute>()
    const modules = new Map<string, unknown>([
      ['video-loader-carrier', { apply(ctx: Context) {
        ctx.provide('connection', { fetch: { register(route: ConnectionFetchRoute) {
          if (routes.has(route.path)) throw new Error('duplicate video Loader route')
          routes.set(route.path, route)
          return () => { routes.delete(route.path) }
        } } } as Context['connection'])
      } }],
      ['@deepseek-ai/dsh-session', Sessions], ['@deepseek-ai/dsh-compute-core', ComputeCore],
    ])
    const path = join(root, 'cordis.yml')
    await writeFile(path, `- name: video-loader-carrier\n- name: '@deepseek-ai/dsh-session'\n- name: '@deepseek-ai/dsh-compute-core'\n  config: ${JSON.stringify(config)}\n`)
    const ctx = await boot('video-loader-test', path, undefined, (preparing) => {
      const internal = preparing.loader.internal
      if (internal === undefined) throw new Error('video fixture requires the Node module Loader')
      preparing.loader.internal = Object.assign(Object.create(internal), {
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      }) as NonNullable<typeof preparing.loader.internal>
    })
    const session = ctx.sessions.prepare(Sessions.SessionId('owner-session'), { meta: { cwd: root } })
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    let live = true
    const close = async () => { if (!live) return; live = false; detach(); await ctx.fiber.dispose() }
    cleanups.push(close)
    return { close, routes, call: async (route: string, body?: unknown) => {
      const endpoint = routes.get(new URL(prefix + route, 'http://localhost').pathname)
      if (endpoint === undefined) return new Response(null, { status: 404 })
      return endpoint.fetch(new Request('http://localhost' + prefix + route, body === undefined ? undefined : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }))
    } }
  }
  const api = await openComposition()
  const request = input()
  expect(await (await api.call('status')).json()).toMatchObject({ enabled: true, billing: 'research-no-charge' })
  expect((await api.call('jobs', request)).status).toBe(202)
  await vi.waitFor(async () => {
    expect(await (await api.call(`job?id=${request.id}&sessionId=owner-session`)).json()).toMatchObject({ status: 'completed' })
  }, { timeout: 4000, interval: 10 })
  expect(remote.state.imagePosts).toBe(1)
  expect(remote.state.posts).toHaveLength(1)
  expect(Buffer.from(await (await api.call(`video?id=${request.id}&sessionId=owner-session`)).arrayBuffer())).toEqual(remote.state.bytes)
  await api.close()
  expect(api.routes.size).toBe(0)
  const restored = await openComposition()
  expect(await (await restored.call(`job?id=${request.id}&sessionId=owner-session`)).json()).toMatchObject({ status: 'completed' })
  expect(Buffer.from(await (await restored.call(`video?id=${request.id}&sessionId=owner-session`)).arrayBuffer())).toEqual(remote.state.bytes)
  expect(remote.state.imagePosts).toBe(1)
  expect(remote.state.posts).toHaveLength(1)
})

it('defaults off, exposes no upstream details, and disposes routes', async () => {
  const api = await mount()
  expect(await (await api.call('status')).json()).toEqual({ enabled: false, billing: 'research-no-charge',
    quality: 'fast', steps: 4, seconds: [5], orientations: ['landscape'], width: 1344, height: 768, firstFrame: 'attachment-or-generated' })
  expect((await api.call('jobs', input())).status).toBe(503)
  await api.close(); expect(api.routes.size).toBe(0)
})

it('persists first-frame identity, submits once, validates bytes, and regenerates from original inputs', async () => {
  const remote = await gateway(); remote.state.mode = 'running'
  const api = await mount({ gatewayOrigin: remote.origin }); const original = { ...input(), firstFrame: attachment() }
  const [a, b] = await Promise.all([api.call('jobs', original), api.call('jobs', original)])
  expect(a.status).toBe(202); expect(b.status).toBe(202)
  await vi.waitFor(() =>{  expect(remote.state.posts).toHaveLength(1) })
  expect(remote.state.firstFrame).toBe(digest(png()))
  const sent = remote.state.posts[0]!
  expect(sent).toMatchObject({ prompt: original.prompt, negative: '', steps: 4, seconds: 5, workflow: 'qs_new4',
    preset: 'landscape_C', expected, ref_images: [{ role: 'first', url: 'data:image/png;base64,' + original.firstFrame.data }] })
  expect(Number.isSafeInteger(sent.seed)).toBe(true)
  expect((await api.call('jobs', { ...original, prompt: 'different' })).status).toBe(409)
  expect((await api.call('jobs', { ...input(), firstFrame: attachment() })).status).toBe(409)
  expect((await api.call(`job?id=${original.id}&sessionId=other-session`)).status).toBe(404)
  expect((await api.call('jobs', { ...input(), sessionId: 'missing', firstFrame: attachment() })).status).toBe(403)
  await vi.waitFor(async () =>{  expect(await (await api.call(`job?id=${original.id}&sessionId=owner-session`)).json()).toMatchObject({ progress: 37 }) })
  remote.state.mode = 'done'
  const completed = await waitForJob(api, original.id)
  expect(completed).toMatchObject({ billing: 'research-no-charge', result: { bytes: remote.state.bytes.length, sha256: digest(remote.state.bytes) } })
  expect(completed.progress).toBeUndefined()
  const result = await api.call(`video?id=${original.id}&sessionId=owner-session`)
  expect(result.headers.get('content-type')).toBe('video/mp4')
  expect(Buffer.from(await result.arrayBuffer())).toEqual(remote.state.bytes)
  const receipt = await readFile(join(api.path, 'jobs.json'), 'utf8')
  expect(receipt).not.toContain(remote.origin); expect(receipt).not.toContain(original.firstFrame.data)
  expect(receipt).toContain('remote_1')
  expect((await api.call('jobs', { ...input(), prompt: 'changed parent', reuseJobId: original.id })).status).toBe(409)
  const repeat = { ...input(), reuseJobId: original.id }
  expect((await api.call('jobs', repeat)).status).toBe(202)
  await waitForJob(api, repeat.id)
  expect(remote.state.posts).toHaveLength(2)
  expect(remote.state.posts[1]?.ref_images).toEqual(sent.ref_images)
  expect((await api.call(`video?id=${original.id}&sessionId=owner-session`)).status).toBe(200)
  await api.close()
  const restored = await mount({ gatewayOrigin: remote.origin }, api.path)
  expect((await restored.call('jobs', original)).status).toBe(202)
  expect((await restored.call(`video?id=${original.id}&sessionId=owner-session`)).status).toBe(200)
  expect(remote.state.posts).toHaveLength(2)
})

it.each([
  { seconds: 3 }, { orientation: 'portrait' }, { quality: 'hd' }, { firstFrame: { mediaType: 'image/webp', data: 'AA==' } },
  { firstFrame: { mediaType: 'image/png', data: 'AA==' } }, { firstFrame: attachment(), reuseJobId: randomUUID() },
])('rejects unsupported input before every external call %j', async (invalid) => {
  const remote = await gateway(); const api = await mount({ gatewayOrigin: remote.origin })
  expect((await api.call('jobs', { ...input(), ...invalid })).status).toBe(400)
  expect(remote.state.posts).toHaveLength(0); expect(remote.state.gets).toBe(0)
})

it.each(['busy', 'badProfile'] as const)('refuses preflight %s without reserving a job', async (mode) => {
  const remote = await gateway(); remote.state[mode] = true
  const api = await mount({ gatewayOrigin: remote.origin }); const request = { ...input(), firstFrame: attachment() }
  expect((await api.call('jobs', request)).status).toBe(mode === 'busy' ? 409 : 503)
  expect((await api.call(`job?id=${request.id}&sessionId=owner-session`)).status).toBe(404)
  expect(remote.state.posts).toHaveLength(0)
})

it('retains a completed first frame when the video identity connection fails without posting H3', async () => {
  const remote = await gateway(); remote.state.identityLost = true
  const api = await mount({ gatewayOrigin: remote.origin }); const request = { ...input(), firstFrame: attachment() }
  expect((await api.call('jobs', request)).status).toBe(202)
  expect(await waitForJob(api, request.id, 'failed')).toMatchObject({
    status: 'failed', errorCode: 'VIDEO_TRIAL_GATEWAY_UNAVAILABLE' })
  expect(remote.state.posts).toHaveLength(0)
  const stored = JSON.parse(await readFile(join(api.path, 'jobs.json'), 'utf8')) as {
    jobs: { attempted: boolean; frame: { sha256: string } }[] }
  expect(stored.jobs[0]?.attempted).toBe(false)
  expect(stored.jobs[0]?.frame.sha256).toBe(digest(png()))
})

it('generates an optional first frame through the real shared image Host once', async () => {
  const remote = await gateway(); const path = await directory()
  const image = await images(path, remote.origin)
  const api = await mount({ gatewayOrigin: remote.origin }, path, image); const request = input()
  const accepted = await api.call('jobs', request)
  expect(accepted.status).toBe(202)
  expect(await accepted.json()).toMatchObject({ timing: { phase: 'preparing-first-frame' } })
  await waitForJob(api, request.id)
  expect(remote.state.imagePosts).toBe(1); expect(remote.state.imageGet).toBe(1); expect(remote.state.posts).toHaveLength(1)
  const journal = JSON.parse(await readFile(join(path, 'jobs.json'), 'utf8')) as { jobs: Array<{ imageJobId: string }> }
  const child = await image.job(journal.jobs[0]!.imageJobId, request.sessionId)
  expect(child).toMatchObject({ prompt: request.prompt, size: 'landscape', status: 'completed' })
  expect(remote.state.firstFrame).toBe(digest(png(2048, 1152)))
})

it('never steals the occupied shared image slot or cancels an existing image', async () => {
  const remote = await gateway(); remote.state.blockImage = true
  const path = await directory(); const image = await images(path, remote.origin)
  const original = { id: randomUUID(), sessionId: 'owner-session', prompt: '正在画的图', size: 'landscape' }
  await image.submit(original, () => true)
  await vi.waitFor(() =>{  expect(remote.state.imageRelease).toBeTypeOf('function') })
  const api = await mount({ gatewayOrigin: remote.origin }, path, image); const request = input()
  expect((await api.call('jobs', request)).status).toBe(202)
  expect(await waitForJob(api, request.id, 'failed')).toMatchObject({ errorCode: 'VIDEO_TRIAL_BUSY' })
  expect(remote.state.posts).toHaveLength(0); expect(remote.state.imagePosts).toBe(1)
  remote.state.imageRelease!()
  await vi.waitFor(async () =>{  expect(await image.job(original.id, original.sessionId)).toMatchObject({ status: 'completed' }) })
})

it('keeps an unknown H3 POST unknown across query, duplicate submit and restart', async () => {
  const remote = await gateway(); remote.state.postLost = true
  const api = await mount({ gatewayOrigin: remote.origin }); const request = { ...input(), firstFrame: attachment() }
  expect((await api.call('jobs', request)).status).toBe(202)
  expect(await waitForJob(api, request.id, 'failed')).toMatchObject({ errorCode: 'VIDEO_TRIAL_OUTCOME_UNKNOWN' })
  expect((await api.call('jobs', request)).status).toBe(202)
  await api.close()
  const restored = await mount({ gatewayOrigin: remote.origin }, api.path)
  expect(await waitForJob(restored, request.id, 'failed')).toMatchObject({ errorCode: 'VIDEO_TRIAL_OUTCOME_UNKNOWN' })
  expect((await restored.call('jobs', request)).status).toBe(202)
  expect(remote.state.posts).toHaveLength(1); expect(remote.state.gets).toBe(0)
})

it('reconciles a saved external id after restart using only GET and preserves Session ownership', async () => {
  const remote = await gateway(); remote.state.mode = 'running'
  const api = await mount({ gatewayOrigin: remote.origin }); const request = { ...input(), firstFrame: attachment() }
  await api.call('jobs', request)
  await vi.waitFor(() =>{  expect(remote.state.gets).toBeGreaterThan(0) })
  await api.close(); remote.state.mode = 'done'
  const restored = await mount({ gatewayOrigin: remote.origin }, api.path)
  restored.sessions.clear(); restored.persisted.set('owner-session', 'owner-session'); restored.persisted.set('other-session', 'other-session')
  await waitForJob(restored, request.id)
  expect((await restored.call(`video?id=${request.id}&sessionId=owner-session`)).status).toBe(200)
  expect((await restored.call(`job?id=${request.id}&sessionId=other-session`)).status).toBe(404)
  restored.persisted.set('missing-session', 'wrong-id')
  expect((await restored.call(`job?id=${request.id}&sessionId=missing-session`)).status).toBe(403)
  expect((await restored.call('jobs', request)).status).toBe(403)
  expect(remote.state.posts).toHaveLength(1)
})

it('never resumes a child image or H3 POST from an interrupted pre-submit checkpoint', async () => {
  const remote = await gateway(); remote.state.blockImage = true
  const path = await directory(); const image = await images(path, remote.origin)
  const api = await mount({ gatewayOrigin: remote.origin }, path, image); const request = input()
  await api.call('jobs', request)
  await vi.waitFor(() =>{  expect(remote.state.imageRelease).toBeTypeOf('function') })
  await api.close()
  const journal = JSON.parse(await readFile(join(path, 'jobs.json'), 'utf8')) as { jobs: Array<{ job: VideoTrialJob }> }
  journal.jobs[0]!.job = { ...journal.jobs[0]!.job, status: 'running' }
  await writeFile(join(path, 'jobs.json'), JSON.stringify({ version: 1, jobs: journal.jobs }))
  const restored = await mount({ gatewayOrigin: remote.origin }, path, image)
  expect(await waitForJob(restored, request.id, 'failed')).toMatchObject({ errorCode: 'VIDEO_TRIAL_OUTCOME_UNKNOWN' })
  expect(remote.state.imagePosts).toBe(1); expect(remote.state.posts).toHaveLength(0)
  remote.state.imageRelease!()
})

it.each(['badIdentity', 'badReceipt', 'badMedia'] as const)('rejects %s and never fabricates a completed result', async (mode) => {
  const remote = await gateway(); remote.state[mode] = true
  const api = await mount({ gatewayOrigin: remote.origin }); const request = { ...input(), firstFrame: attachment() }
  await api.call('jobs', request)
  const job = await waitForJob(api, request.id, 'failed')
  expect(job.result).toBeUndefined()
  expect((await api.call(`video?id=${request.id}&sessionId=owner-session`)).status).toBe(409)
  expect(remote.state.posts).toHaveLength(mode === 'badIdentity' ? 0 : 1)
})

it('rejects a valid five-second container with only 119 frames under the fixed 24fps contract', async () => {
  const remote = await gateway(); remote.state.bytes = mp4({ frames: 119 })
  const api = await mount({ gatewayOrigin: remote.origin }); const request = { ...input(), firstFrame: attachment() }
  await api.call('jobs', request)
  const job = await waitForJob(api, request.id, 'failed')
  expect(job.errorCode).toBe('VIDEO_TRIAL_RESULT_INVALID')
  expect(job.result).toBeUndefined()
  expect(remote.state.posts).toHaveLength(1)
  expect(remote.state.videos).toBe(1)
})

it('rechecks rejected delivery only on an explicit query of the original task and never posts a second generation', async () => {
  const remote = await gateway(); remote.state.badMedia = true
  const api = await mount({ gatewayOrigin: remote.origin }); const request = { ...input(), firstFrame: attachment() }
  await api.call('jobs', request)
  await waitForJob(api, request.id, 'failed')
  const downloads = remote.state.videos
  remote.state.badMedia = false
  await api.close()
  const restored = await mount({ gatewayOrigin: remote.origin }, api.path)
  expect((await (await restored.call(`job?id=${request.id}&sessionId=owner-session`)).json() as VideoTrialJob).status).toBe('failed')
  expect(remote.state.videos).toBe(downloads)
  const queries = await Promise.all(Array.from({ length: 3 }, () => restored.call(`job?id=${request.id}&sessionId=owner-session&retryDelivery=1`)))
  expect(queries.every(response => response.status === 200)).toBe(true)
  const completed = await waitForJob(restored, request.id)
  expect(completed.result?.sha256).toBe(digest(remote.state.bytes))
  expect(remote.state.videos).toBe(downloads + 1)
  expect(remote.state.posts).toHaveLength(1)
  expect(remote.state.imagePosts).toBe(0)
  expect((await restored.call(`video?id=${request.id}&sessionId=owner-session&retryDelivery=1`)).status).toBe(403)
})

it('contains connection refusal before acceptance and forbids non-loopback providers', async () => {
  const api = await mount({ gatewayOrigin: 'http://127.0.0.1:1' })
  const response = await api.call('jobs', { ...input(), firstFrame: attachment() })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: { code: 'VIDEO_TRIAL_GATEWAY_UNAVAILABLE', message: 'VIDEO_TRIAL_GATEWAY_UNAVAILABLE' } })
  expect(() => new VideoTrialHost({ gatewayOrigin: 'http://203.0.113.20:18802' }, api.path, limits, {} as ImageTrialHost)).toThrow('VIDEO_TRIAL_CONFIG_INVALID')
})
