/** Neural speech routes through real Loader, SessionStore and Connection registrations with a controlled worker. */
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import QianshouVoice from '../src/index.ts'
import { MAX_TTS_REQUEST_BYTES, TTS_STATUS_PATH, TTS_SYNTHESIZE_PATH } from '../src/tts-routes.ts'
import type { VoiceConfig } from '../src/types.ts'
import { ttsFixture, type TtsWorkerMode } from './support.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function boot(config: Partial<VoiceConfig> = {}, mode: TtsWorkerMode = 'normal', configured = true) {
  const f = await ttsFixture(mode)
  cleanups.push(() => rm(f.root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(f.root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['session', SessionStore], ['credentials', MemoryCredentials],
    ['connection', Connection], ['voice', QianshouVoice]])
  for (const [name, plugin] of modules) ctx.loader.builtins[name] = plugin
  const assets = configured ? { ttsPythonPath: f.assets.python, ttsWorkerPath: f.assets.worker, ttsModelPath: f.assets.model } : {}
  const rows = [...modules.keys()].map(name => ({ name: `cordis:${name}`, ...name === 'voice' ? {
    config: { ...assets, ttsRequestTimeoutMs: 10000, ...config },
  } : {} }))
  await writeFile(join(f.root, 'cordis.yml'), JSON.stringify(rows))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(f.root, 'cordis.yml')).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
  const fiber = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:voice')!.fiber!
  const session = ctx.sessions.prepare(SessionId('tts-test-session'), { meta: { cwd: f.root } })
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  cleanups.push(detach)
  const handler = ctx.connection.createSharedFetchHandler('/api')
  const guarded = (path: string): URL => {
    const url = new URL(`http://localhost${path}`)
    url.searchParams.set('sessionId', session.id); url.searchParams.set('workspaceRoot', f.root)
    return url
  }
  const statusUrl = guarded(TTS_STATUS_PATH), synthUrl = guarded(TTS_SYNTHESIZE_PATH)
  const status = async (target = statusUrl): Promise<Response> => handler.fetch(new Request(target, { method: 'GET' }))
  const synth = (body: unknown = { text: '你好' }, init: RequestInit = {}, target = synthUrl): Request => new Request(target, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...init,
  })
  async function started() {
    await vi.waitFor(async () => { expect((await f.events()).some(item => item.event === 'request')).toBe(true) }, { timeout: 5000 })
    return (await f.events())[0]!
  }
  return { ...f, ctx, fiber, session, detach, handler, statusUrl, synthUrl, status, synth, started }
}

describe.skipIf(process.platform === 'win32')('neural speech through real Loader and Connection registrations', () => {
  it('shares Connection authentication, reports whitelisted status and returns worker WAV without Session writes', async () => {
    const b = await boot({ ttsDefaultSpeaker: 'Serena' })
    expect(b.handler.requestBodyMode({ method: 'POST', url: b.synthUrl })).toBe('streaming')
    expect(b.handler.requestBodyMode({ method: 'GET', url: b.statusUrl })).toBe('buffered')
    expect(b.ctx.connection.requestRejection({ headers: { host: 'localhost' } })).toBe(401)
    expect(b.ctx.connection.requestRejection({ headers: { host: 'foreign.invalid' } })).toBe(403)
    const status = await b.status()
    expect(status.headers.get('cache-control')).toBe('private, no-store')
    expect(await status.json()).toEqual({ available: true, reason: 'ready', ready: false, busy: false, engine: 'qwen3-tts',
      speakers: ['Vivian', 'Serena'], defaultSpeaker: 'Serena', maxTextChars: 500, maxOutputBytes: 8388608, sampleRate: 24000 })
    const before = b.session.snapshotEvents()
    const response = await b.handler.fetch(b.synth({ text: ' 好呀，我在呢。 ' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/wav')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const wav = Buffer.from(await response.arrayBuffer())
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(response.headers.get('content-length')).toBe(String(wav.byteLength))
    expect(b.session.snapshotEvents()).toEqual(before)
    expect((await b.events()).filter(item => item.event === 'request').map(item => item.text)).toEqual(['好呀，我在呢。'])
    expect(await (await b.status()).json()).toMatchObject({ ready: true, busy: false })
    await b.fiber.dispose()
    expect((await b.status()).status).toBe(404)
    expect((await b.handler.fetch(b.synth())).status).toBe(404)
    expect(existsSync((await b.events())[0]!.root)).toBe(false)
  })
  it('declares not-configured honestly, keeps ASR status unchanged and starts no process', async () => {
    const b = await boot({}, 'normal', false)
    expect(await (await b.status()).json()).toMatchObject({ available: false, reason: 'not-configured', ready: false })
    expect(await (await b.handler.fetch(b.synth())).json()).toEqual({ error: 'TTS_UNAVAILABLE' })
    expect(await b.ctx.qianshouVoice.status()).toMatchObject({ available: false, reason: 'not-configured', backend: 'whisper.cpp' })
    expect(await b.events()).toEqual([])
  })
  it('reports resources-missing when a configured file disappears', async () => {
    const b = await boot()
    await rm(join(b.assets.model, 'speech_tokenizer/model.safetensors'))
    expect(await (await b.status()).json()).toMatchObject({ available: false, reason: 'resources-missing' })
    const response = await b.handler.fetch(b.synth())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'TTS_UNAVAILABLE' })
    expect(await b.events()).toEqual([])
  })
  it('rejects missing, ambiguous, stale and mismatched Session guards on both routes', async () => {
    const b = await boot()
    for (const field of ['sessionId', 'workspaceRoot']) {
      for (const [path, send] of [[b.statusUrl, (url: URL) => b.status(url)], [b.synthUrl, (url: URL) => b.handler.fetch(b.synth(undefined, {}, url))]] as const) {
        const missing = new URL(path); missing.searchParams.delete(field)
        expect((await send(missing)).status).toBe(409)
        const duplicate = new URL(path); duplicate.searchParams.append(field, 'second')
        expect((await send(duplicate)).status).toBe(409)
      }
    }
    const mismatch = new URL(b.synthUrl); mismatch.searchParams.set('workspaceRoot', '/other-project')
    expect(await (await b.handler.fetch(b.synth(undefined, {}, mismatch))).json()).toEqual({ error: 'SESSION_MISMATCH' })
    b.detach()
    expect(await (await b.status()).json()).toEqual({ error: 'SESSION_UNAVAILABLE' })
    expect(await (await b.handler.fetch(b.synth())).json()).toEqual({ error: 'SESSION_UNAVAILABLE' })
    expect(await b.events()).toEqual([])
  })
  it.each([
    ['empty text', { text: '   ' }, 400], ['too long', { text: 'x'.repeat(501) }, 400], ['unknown speaker', { text: '你好', speaker: 'clone' }, 400],
    ['extra field', { text: '你好', outputPath: '/tmp/x' }, 400], ['non-string text', { text: 12 }, 400], ['array body', ['你好'], 400],
    ['invalid json', '{', 400],
  ] as const)('rejects unsupported request content without starting a worker: %s', async (_, body, status) => {
    const b = await boot()
    const response = await b.handler.fetch(b.synth(body))
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: 'INVALID_TEXT' })
    expect(await b.events()).toEqual([])
  })
  it('enforces content type and bounds actual body bytes without trusting a smaller declared length', async () => {
    const b = await boot()
    expect((await b.handler.fetch(b.synth(undefined, { headers: { 'content-type': 'text/plain' } }))).status).toBe(415)
    const declared = await b.handler.fetch(b.synth(undefined, { headers: { 'content-type': 'application/json', 'content-length': String(MAX_TTS_REQUEST_BYTES + 1) } }))
    expect(declared.status).toBe(413)
    const oversized = await b.handler.fetch(b.synth(JSON.stringify({ text: 'x'.repeat(MAX_TTS_REQUEST_BYTES) }), { headers: { 'content-type': 'application/json', 'content-length': '1' } }))
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({ error: 'INVALID_TEXT' })
    expect(await b.events()).toEqual([])
  })
  it('refuses a concurrent synthesis as busy and cancels the active one with the request', async () => {
    const b = await boot()
    const controller = new AbortController()
    const result = b.handler.fetch(b.synth({ text: 'hang' }, { signal: controller.signal }))
    const child = await b.started()
    expect(b.ctx.get('voiceActivity')?.active()).toBe(true)
    const busy = await b.handler.fetch(b.synth())
    expect(busy.status).toBe(429)
    expect(await busy.json()).toEqual({ error: 'TTS_BUSY' })
    expect(b.ctx.get('voiceActivity')?.active()).toBe(true)
    expect(await (await b.status()).json()).toMatchObject({ busy: true })
    controller.abort()
    expect(await (await result).json()).toEqual({ error: 'REQUEST_ABORTED' })
    expect(() => process.kill(child.pid, 0)).toThrow()
    expect(existsSync(child.root)).toBe(false)
    expect(await (await b.status()).json()).toMatchObject({ busy: false })
    expect(b.ctx.get('voiceActivity')?.active()).toBe(false)
    expect((await b.handler.fetch(b.synth())).status).toBe(200)
  }, 15000)
  it('cancels old work on Session release even when an identical ID is immediately replaced', async () => {
    const b = await boot()
    const result = b.handler.fetch(b.synth({ text: 'hang' }))
    const child = await b.started()
    expect(b.ctx.get('voiceActivity')?.active()).toBe(true)
    b.detach()
    const replacement = b.ctx.sessions.create(b.session.id, { meta: { cwd: b.root } })
    expect(replacement).not.toBe(b.session)
    expect(await (await result).json()).toEqual({ error: 'SESSION_UNAVAILABLE' })
    expect(() => process.kill(child.pid, 0)).toThrow()
    expect(existsSync(child.root)).toBe(false)
    expect(b.ctx.get('voiceActivity')?.active()).toBe(false)
  }, 15000)
  it('disposal aborts active synthesis, waits for the worker and removes both routes', async () => {
    const b = await boot()
    const result = b.handler.fetch(b.synth({ text: 'hang' }))
    const child = await b.started()
    expect(b.ctx.get('voiceActivity')?.active()).toBe(true)
    await b.fiber.dispose()
    expect(await (await result).json()).toEqual({ error: 'REQUEST_ABORTED' })
    expect(() => process.kill(child.pid, 0)).toThrow()
    expect(existsSync(child.root)).toBe(false)
    expect(b.ctx.get('voiceActivity')).toBeUndefined()
    expect((await b.status()).status).toBe(404)
  }, 15000)
  it('classifies a worker deadline as a timeout and a malformed answer as synthesis failure', async () => {
    const timeout = await boot({ ttsRequestTimeoutMs: 1500 })
    const late = await timeout.handler.fetch(timeout.synth({ text: 'hang' }))
    expect(late.status).toBe(504)
    expect(await late.json()).toEqual({ error: 'TTS_TIMEOUT' })
    const malformed = await boot({}, 'error')
    const failed = await malformed.handler.fetch(malformed.synth())
    expect(failed.status).toBe(500)
    const body = await failed.text()
    expect(JSON.parse(body)).toEqual({ error: 'SYNTHESIS_FAILED' })
    expect(body).not.toContain('SECRET_DIAGNOSTIC')
  }, 15000)
})
