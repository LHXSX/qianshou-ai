/** The Host voice-activity projection must follow real local voice work; a guessed reading is a defect. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { VoiceActivityProjection } from '../src/activity.ts'
import { apply, type Config } from '../src/index.ts'
import { MAX_AUDIO_BYTES } from '../src/wav.ts'

const engine = vi.hoisted(() => ({ available: vi.fn(), transcribe: vi.fn() }))
vi.mock('../src/engine.ts', () => ({ voiceAvailable: engine.available, transcribeVoice: engine.transcribe }))

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

/** One authenticated Connection route as the fixture carrier hands it to the plugin. */
type Route = (request: Request) => Promise<Response>

/** Mount the real plugin on a Connection fixture and expose its routes. */
function bench(config: Config = { uploadTimeoutMs: 1_000, recognitionTimeoutMs: 500 }) {
  engine.available.mockResolvedValue(true)
  engine.transcribe.mockResolvedValue('actual speech')
  const ctx = new Context()
  contexts.push(ctx)
  const routes = new Map<string, Route>()
  ctx.provide('connection', { fetch: { register: (route: { path: string; fetch: Route }) => {
    routes.set(route.path, route.fetch)
    return () => { routes.delete(route.path) }
  } } } as unknown as Context['connection'])
  apply(ctx, config)
  return { ctx, routes, activity: () => ctx.get('voiceActivity')?.active() }
}

function audioRequest(body: ReadableStream<Uint8Array>, signal?: AbortSignal, length?: number): Request {
  return new Request('http://host/api/forge/voice/transcribe', {
    method: 'POST', body, duplex: 'half', signal,
    headers: { 'Content-Type': 'audio/wav', ...(length === undefined ? {} : { 'Content-Length': String(length) }) },
  } as RequestInit & { duplex: 'half' })
}

function speechRequest(body: ReadableStream<Uint8Array> | string, signal?: AbortSignal): Request {
  return new Request('http://host/api/forge/voice/synthesize', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    ...(typeof body === 'string' ? { body } : { body, duplex: 'half' }),
  } as RequestInit & { duplex?: 'half' })
}

function pcm(): Uint8Array {
  const bytes = Buffer.alloc(44 + 3200)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(3200, 40)
  return bytes
}

const bytes = (chunk: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(chunk); controller.close() } })
const stalled = (cancel: () => void = () => {}) => new ReadableStream<Uint8Array>({ cancel })

/** A local model directory and worker process that really runs; only the assets are fixtures. */
async function ttsAssets(): Promise<{ ttsPythonPath: string; ttsWorkerPath: string; ttsModelPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'voice-activity-'))
  roots.push(root)
  const python = join(root, 'fake-python.cjs')
  const worker = join(root, 'worker.py')
  const model = join(root, 'model')
  await mkdir(join(model, 'speech_tokenizer'), { recursive: true })
  await Promise.all(['config.json', 'model.safetensors', 'speech_tokenizer/model.safetensors'].map(file => writeFile(join(model, file), '{}')))
  await writeFile(worker, '# test worker')
  // The worker is local speech the test can hold open: it reports ready, then keeps the request alive forever.
  await writeFile(python, `#!${process.execPath}
const rl = require('node:readline');
const record = value => process.stdout.write(JSON.stringify(value) + '\\n');
record({ type: 'ready' });
rl.createInterface({ input: process.stdin }).on('line', () => { setInterval(() => {}, 100); });
`, { mode: 0o700 })
  return { ttsPythonPath: python, ttsWorkerPath: worker, ttsModelPath: model }
}

describe('projection contract', () => {
  it('is idle only when no real request holds a slot and returns to idle on release', () => {
    const projection = new VoiceActivityProjection()
    expect(projection.active()).toBe(false)
    expect(projection.inFlightCount()).toBe(0)
    const release = projection.hold()
    expect(projection.active()).toBe(true)
    expect(projection.inFlightCount()).toBe(1)
    release()
    expect(projection.active()).toBe(false)
    expect(projection.inFlightCount()).toBe(0)
  })

  it('keeps one slot per real request and ignores a repeated release', () => {
    const projection = new VoiceActivityProjection()
    const first = projection.hold()
    const second = projection.hold()
    expect(projection.inFlightCount()).toBe(2)
    first(); first()
    expect(projection.inFlightCount()).toBe(1)
    expect(projection.active()).toBe(true)
    second()
    expect(projection.active()).toBe(false)
  })
})

describe('real routes drive the projection', () => {
  it('reports activity while a transcription runs and clears it when the request finishes', async () => {
    const { routes, activity } = bench()
    const resolvers: Array<(text: string) => void> = []
    engine.transcribe.mockImplementation(() => new Promise<string>((resolve) => { resolvers.push(resolve) }))
    const pending = routes.get('/api/forge/voice/transcribe')!(audioRequest(bytes(pcm())))
    await vi.waitFor(() => { expect(resolvers).toHaveLength(1) })
    expect(activity()).toBe(true)
    resolvers[0]!('actual speech')
    expect(await (await pending).json()).toEqual({ text: 'actual speech' })
    expect(activity()).toBe(false)
  })

  it('reports activity for a stalled upload and clears it on client abort', async () => {
    const { routes, activity } = bench()
    const controller = new AbortController()
    const pending = routes.get('/api/forge/voice/transcribe')!(audioRequest(stalled(), controller.signal))
    await vi.waitFor(() => { expect(activity()).toBe(true) })
    controller.abort()
    expect((await pending).status).toBe(499)
    expect(activity()).toBe(false)
  })

  it.each([
    { name: 'wrong content type', request: () => new Request('http://host/api/forge/voice/transcribe', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } }), status: 415 },
    { name: 'declared oversize upload', request: () => audioRequest(bytes(new Uint8Array(MAX_AUDIO_BYTES + 1)), undefined, MAX_AUDIO_BYTES + 1), status: 413 },
  ])('never reports activity for a request refused before any voice work: $name', async ({ request, status }) => {
    const { routes, activity } = bench()
    expect((await routes.get('/api/forge/voice/transcribe')!(request())).status).toBe(status)
    expect(activity()).toBe(false)
    expect(engine.transcribe).not.toHaveBeenCalled()
  })

  it('never reports activity for a request refused while another recognition owns the slot', async () => {
    const { routes, activity } = bench()
    const resolvers: Array<(text: string) => void> = []
    engine.transcribe.mockImplementation(() => new Promise<string>((resolve) => { resolvers.push(resolve) }))
    const first = routes.get('/api/forge/voice/transcribe')!(audioRequest(bytes(pcm())))
    await vi.waitFor(() => { expect(resolvers).toHaveLength(1) })
    expect(activity()).toBe(true)
    const second = await routes.get('/api/forge/voice/transcribe')!(audioRequest(bytes(pcm())))
    expect(second.status).toBe(429)
    // The refused request never reached the recognizer and never opened a second slot.
    expect(resolvers).toHaveLength(1)
    resolvers[0]!('actual speech')
    await first
    // The refused request never held a slot: the projection is idle again although it was refused while busy.
    expect(activity()).toBe(false)
  })

  it('reports activity while a real synthesis process serves the request and clears it on abort', async () => {
    const assets = await ttsAssets()
    const { routes, activity } = bench({ uploadTimeoutMs: 1_000, ...assets })
    const controller = new AbortController()
    const pending = routes.get('/api/forge/voice/synthesize')!(speechRequest(JSON.stringify({ text: '你好' }), controller.signal))
    await vi.waitFor(() => { expect(activity()).toBe(true) }, { timeout: 10_000 })
    expect(activity()).toBe(true)
    controller.abort()
    expect((await pending).status).toBe(499)
    expect(activity()).toBe(false)
  }, 20_000)

  it('reports activity for a stalled synthesis upload and clears it on client abort', async () => {
    const { routes, activity } = bench()
    const controller = new AbortController()
    const pending = routes.get('/api/forge/voice/synthesize')!(speechRequest(stalled(), controller.signal))
    await vi.waitFor(() => { expect(activity()).toBe(true) })
    controller.abort()
    expect((await pending).status).toBe(499)
    expect(activity()).toBe(false)
  })

  it('removes the producer with its fiber so a consumer can no longer read voice activity', async () => {
    const { ctx, routes, activity } = bench()
    const pending = routes.get('/api/forge/voice/synthesize')!(speechRequest(stalled()))
    await vi.waitFor(() => { expect(activity()).toBe(true) })
    await ctx.fiber.dispose()
    expect((await pending).status).toBe(499)
    expect(routes.size).toBe(0)
    // No service and therefore no idle claim: a consumer must report the fact as unknown, not as inactivity.
    expect(ctx.get('voiceActivity')).toBeUndefined()
  })

  it('leaves no slot behind after the upload timeout expires', async () => {
    const { routes, activity } = bench({ uploadTimeoutMs: 20 })
    const result = await routes.get('/api/forge/voice/transcribe')!(audioRequest(stalled()))
    expect(result.status).toBe(504)
    expect(activity()).toBe(false)
  })
})

describe('plugin lifetime', () => {
  it('publishes exactly one projection and keeps it idle while nothing is served', () => {
    const { ctx } = bench()
    expect(ctx.get('voiceActivity')).toBeDefined()
    expect(ctx.get('voiceActivity')?.active()).toBe(false)
  })
})
