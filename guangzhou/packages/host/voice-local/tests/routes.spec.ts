import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { MAX_AUDIO_BYTES } from '../src/wav.ts'

const engine = vi.hoisted(() => ({ available: vi.fn(), transcribe: vi.fn() }))
vi.mock('../src/engine.ts', () => ({ voiceAvailable: engine.available, transcribeVoice: engine.transcribe }))

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

function bench(uploadTimeoutMs = 1_000) {
  engine.available.mockResolvedValue(true)
  engine.transcribe.mockResolvedValue('actual speech')
  const ctx = new Context()
  contexts.push(ctx)
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  ctx.provide('connection', { fetch: { register: (route: {
    path: string; fetch: (request: Request) => Promise<Response>
  }) => {
    routes.set(route.path, route.fetch)
    return () => { routes.delete(route.path) }
  } } })
  apply(ctx, { uploadTimeoutMs, recognitionTimeoutMs: 500 })
  const recognize = routes.get('/api/forge/voice/transcribe')!
  return { ctx, recognize }
}

function request(body: ReadableStream<Uint8Array>, signal?: AbortSignal, length?: number): Request {
  return new Request('http://host/api/forge/voice/transcribe', {
    method: 'POST', body, duplex: 'half', signal,
    headers: { 'Content-Type': 'audio/wav', ...(length === undefined ? {} : { 'Content-Length': String(length) }) },
  } as RequestInit & { duplex: 'half' })
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

describe('voice request lifetime', () => {
  it('cancels a stalled upload on client abort and immediately frees the voice slot', async () => {
    const { recognize } = bench()
    const controller = new AbortController()
    const cancel = vi.fn()
    const pending = recognize(request(new ReadableStream({ cancel }), controller.signal))
    await vi.waitFor(() => { expect(engine.available).toHaveBeenCalled() })
    controller.abort()
    expect((await pending).status).toBe(499)
    expect(cancel).toHaveBeenCalled()
    const accepted = await recognize(request(bytes(pcm())))
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ text: 'actual speech' })
  })

  it('does not wait for a stuck carrier cancellation callback during plugin disposal', async () => {
    const { ctx, recognize } = bench()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const pending = recognize(request(new ReadableStream({ cancel })))
    await vi.waitFor(() => { expect(engine.available).toHaveBeenCalled() })
    await ctx.fiber.dispose()
    expect((await pending).status).toBe(499)
    expect(cancel).toHaveBeenCalled()
  })

  it('bounds upload duration independently of recognizer duration', async () => {
    const { recognize } = bench(20)
    const cancel = vi.fn()
    const result = await recognize(request(new ReadableStream({ cancel })))
    expect(result.status).toBe(504)
    expect(await result.json()).toEqual({ error: 'VOICE_TIMEOUT' })
    expect(cancel).toHaveBeenCalled()
  })

  it('enforces streamed bytes even when Content-Length is absent or false', async () => {
    const { recognize } = bench()
    for (const length of [undefined, 1]) {
      const result = await recognize(request(bytes(new Uint8Array(MAX_AUDIO_BYTES + 1)), undefined, length))
      expect(result.status).toBe(413)
    }
  })
})
