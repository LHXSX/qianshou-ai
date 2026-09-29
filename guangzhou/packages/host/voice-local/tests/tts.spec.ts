import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TtsEngine } from '../src/tts-engine.ts'
import { resolveTtsOptions, type TtsOptions } from '../src/tts-config.ts'
import { VoiceActivityProjection } from '../src/activity.ts'
import { registerTtsRoutes } from '../src/tts-routes.ts'

const roots: string[] = []
const engines: TtsEngine[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const engine of engines.splice(0)) await engine.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

interface Marker { event: string; pid: number; root: string; text?: string; output?: string; secret?: string; overlap?: number }

async function fixture(mode = 'canonical', overrides: Partial<TtsOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tts-test-'))
  roots.push(root)
  const python = join(root, 'fake-python.cjs')
  const worker = join(root, 'worker.py')
  const model = join(root, 'model')
  const marker = join(root, 'events.jsonl')
  await mkdir(join(model, 'speech_tokenizer'), { recursive: true })
  await Promise.all(['config.json', 'model.safetensors', 'speech_tokenizer/model.safetensors'].map(file => writeFile(join(model, file), '{}')))
  await writeFile(worker, '# test worker')
  await writeFile(python, `#!${process.execPath}
const fs = require('node:fs');
const rl = require('node:readline');
const root = process.argv[process.argv.indexOf('--output-dir') + 1];
const mode = ${JSON.stringify(mode)};
const record = value => fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,root,...value})+'\\n');
record({event:'start',secret:process.env.TEST_TTS_SECRET});
let active=0;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
if(mode!=='startup-hang') emit({type:'ready'});
rl.createInterface({input:process.stdin}).on('line', async line=>{
 const m=JSON.parse(line); active++;
 record({event:'request',text:m.text,output:m.outputPath,overlap:active});
 if(m.text==='hang') { setInterval(()=>{},100); return; }
 if(m.text==='slow') await new Promise(r=>setTimeout(r,150));
 if(mode==='malformed') {process.stdout.write('bad json\\n'); return;}
 if(mode==='exit') {process.exit(1);}
 if(mode==='error') {emit({id:m.id,ok:false,error:'SECRET_DIAGNOSTIC'});return;}
 if(mode==='noise') {process.stdout.write('x'.repeat(17000));return;}
 const bytes=Buffer.alloc(mode==='oversize'?20000:4844);
 bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
 bytes.writeUInt32LE(mode==='invalid-wav'?16000:24000,24);bytes.writeUInt32LE(48000,28);
 bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);
 if(mode==='symlink') fs.symlinkSync(${JSON.stringify(worker)},m.outputPath);
 else fs.writeFileSync(m.outputPath,bytes,{mode:0o600});
 active--;emit({id:m.id,ok:true,path:mode==='escape'?'/tmp/unowned.wav':mode==='canonical'?fs.realpathSync(m.outputPath):m.outputPath});
});
`, { mode: 0o700 })
  const options: TtsOptions = { ...resolveTtsOptions({ ttsPythonPath: python, ttsWorkerPath: worker, ttsModelPath: model }), ...overrides }
  const engine = new TtsEngine(options)
  engines.push(engine)
  const events = async (): Promise<Marker[]> => existsSync(marker) ? (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Marker) : []
  return { engine, options, events }
}

const signal = () => new AbortController().signal

describe('neural speech deployment settings', () => {
  it('reports explicitly unavailable without configured assets', async () => {
    const engine = new TtsEngine(resolveTtsOptions({}))
    engines.push(engine)
    expect(await engine.status()).toEqual({ available: false, ready: false, engine: 'qwen3-tts', speakers: ['Vivian', 'Serena'], defaultSpeaker: 'Vivian' })
    await expect(engine.synthesize('你好', 'Vivian', signal())).rejects.toMatchObject({ code: 'TTS_UNAVAILABLE' })
  })

  it('rejects partial and relative executable settings', () => {
    expect(() => resolveTtsOptions({ ttsPythonPath: '/python' })).toThrow('together')
    expect(() => resolveTtsOptions({ ttsPythonPath: '/python', ttsWorkerPath: 'worker.py', ttsModelPath: '/model' })).toThrow('absolute')
  })
})

describe.skipIf(process.platform === 'win32')('neural speech real process lifetime', () => {
  it('reuses a ready process, scrubs secrets, returns PCM and removes request files', async () => {
    vi.stubEnv('TEST_TTS_SECRET', 'synthetic-secret')
    const { engine, events } = await fixture()
    expect(await engine.status()).toMatchObject({ available: true, ready: false })
    for (const speaker of ['Vivian', 'Serena'] as const) {
      const wav = await engine.synthesize('你好，慢慢说。', speaker, signal())
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
      expect(wav.readUInt32LE(24)).toBe(24000)
    }
    expect(await engine.status()).toMatchObject({ ready: true })
    const records = await events()
    expect(records.filter(item => item.event === 'start')).toHaveLength(1)
    expect(records[0]?.secret).toBeUndefined()
    for (const item of records.filter(item => item.output)) expect(existsSync(item.output!)).toBe(false)
    await engine.dispose()
    expect(existsSync(records[0]!.root)).toBe(false)
    expect(() => process.kill(records[0]!.pid, 0)).toThrow()
  })

  it('serializes requests, rejects excess admission and cancels queued work without killing the active worker', async () => {
    const { engine, events } = await fixture('normal', { maxQueuedRequests: 1 })
    const first = engine.synthesize('slow', 'Vivian', signal())
    const cancelled = new AbortController()
    const second = engine.synthesize('must-not-run', 'Serena', cancelled.signal).catch((error: unknown) => error)
    await expect(engine.synthesize('excess', 'Vivian', signal())).rejects.toMatchObject({ code: 'TTS_BUSY' })
    cancelled.abort()
    expect(await second).toMatchObject({ code: 'REQUEST_ABORTED' })
    await first
    await engine.synthesize('next', 'Serena', signal())
    const records = await events()
    expect(records.filter(item => item.event === 'start')).toHaveLength(1)
    expect(records.filter(item => item.event === 'request').map(item => [item.text, item.overlap])).toEqual([['slow', 1], ['next', 1]])
  })

  it('kills cancelled inference before cleanup and starts a fresh worker for the next request', async () => {
    const { engine, events } = await fixture()
    const controller = new AbortController()
    const pending = engine.synthesize('hang', 'Vivian', controller.signal).catch((error: unknown) => error)
    await vi.waitFor(async () => { expect((await events()).some(item => item.event === 'request')).toBe(true) }, { timeout: 5_000 })
    const original = (await events())[0]!
    controller.abort()
    expect(await pending).toMatchObject({ code: 'REQUEST_ABORTED' })
    expect(() => process.kill(original.pid, 0)).toThrow()
    expect(existsSync(original.root)).toBe(false)
    await engine.synthesize('recovered', 'Vivian', signal())
    expect((await events()).filter(item => item.event === 'start')).toHaveLength(2)
  }, 15_000)

  it.each(['startup-hang', 'normal'])('bounds cold load and inference with one request deadline: %s', async (mode) => {
    const { engine, events } = await fixture(mode, { requestTimeoutMs: 3_000 })
    await expect(engine.synthesize('hang', 'Vivian', signal())).rejects.toMatchObject({ code: 'TTS_TIMEOUT' })
    const original = (await events())[0]!
    expect(() => process.kill(original.pid, 0)).toThrow()
    expect(existsSync(original.root)).toBe(false)
  })

  it.each(['malformed', 'error', 'exit', 'noise', 'escape', 'oversize', 'invalid-wav', 'symlink'])('rejects unsafe or malformed worker output: %s', async (mode) => {
    const { engine, events } = await fixture(mode, { maxOutputBytes: 10_000 })
    await expect(engine.synthesize('hello', 'Vivian', signal())).rejects.toMatchObject({ code: 'SYNTHESIS_FAILED', message: 'SYNTHESIS_FAILED' })
    expect(existsSync((await events())[0]!.root)).toBe(false)
  })

  it('disposes active and queued work and releases all owned processes', async () => {
    const { engine, events } = await fixture()
    const first = engine.synthesize('hang', 'Vivian', signal()).catch((error: unknown) => error)
    const second = engine.synthesize('queued', 'Vivian', signal()).catch((error: unknown) => error)
    await vi.waitFor(async () => { expect((await events()).some(item => item.event === 'request')).toBe(true) }, { timeout: 5_000 })
    await engine.dispose()
    expect(await first).toMatchObject({ code: 'REQUEST_ABORTED' })
    expect(await second).toMatchObject({ code: 'REQUEST_ABORTED' })
    const original = (await events())[0]!
    expect(() => process.kill(original.pid, 0)).toThrow()
    expect(existsSync(original.root)).toBe(false)
  }, 15_000)

  it('releases an idle model and loads it again on demand', async () => {
    const { engine, events } = await fixture('normal', { idleTimeoutMs: 30 })
    await engine.synthesize('hello', 'Vivian', signal())
    const original = (await events())[0]!
    await vi.waitFor(() => { expect(existsSync(original.root)).toBe(false) })
    await engine.synthesize('again', 'Serena', signal())
    expect((await events()).filter(item => item.event === 'start')).toHaveLength(2)
  })
})

function routeFixture(options = resolveTtsOptions({}), timeout = 500) {
  const ctx = new Context()
  contexts.push(ctx)
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  ctx.provide('connection', { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
    routes.set(route.path, route.fetch)
    return () => routes.delete(route.path)
  } } })
  registerTtsRoutes(ctx, options, timeout, new VoiceActivityProjection())
  const post = (body: unknown, abort?: AbortSignal) => routes.get('/api/forge/voice/synthesize')!(new Request('http://host/api/forge/voice/synthesize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(abort ? { signal: abort } : {}),
  }))
  return { ctx, routes, post }
}

describe('neural speech request parsing', () => {
  it.each([{ text: '' }, { text: 'x'.repeat(501) }, { text: '你好', speaker: 'clone' }, { text: 'hello', outputPath: '/tmp/x' }, { text: 'hello', instruct: 'anything' }, { text: 12 }])('rejects unsupported request fields and text: %j', async (body) => {
    expect((await routeFixture().post(body)).status).toBe(400)
  })

  it('reports unconfigured neural speech independently and removes routes on disposal', async () => {
    const { ctx, routes, post } = routeFixture()
    const status = await routes.get('/api/forge/voice/tts/status')!(new Request('http://host'))
    expect(await status.json()).toMatchObject({ available: false, defaultSpeaker: 'Vivian' })
    expect((await post({ text: '你好' })).status).toBe(503)
    await ctx.fiber.dispose()
    expect(routes.size).toBe(0)
  })

  it('cancels a stalled JSON upload without awaiting carrier cleanup', async () => {
    const { ctx, routes } = routeFixture()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const body = new ReadableStream<Uint8Array>({ cancel })
    const pending = routes.get('/api/forge/voice/synthesize')!(new Request('http://host', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half',
    } as RequestInit & { duplex: 'half' }))
    await ctx.fiber.dispose()
    expect((await pending).status).toBe(499)
    expect(cancel).toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('returns real worker WAV through the route with the configured default speaker', async () => {
    const { options } = await fixture('normal', { defaultSpeaker: 'Serena' })
    const { post } = routeFixture(options)
    const response = await post({ text: '好呀，我在呢。' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/wav')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(Buffer.from(await response.arrayBuffer()).toString('ascii', 8, 12)).toBe('WAVE')
  })
})
