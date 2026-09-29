/** Real Loader composition, Connection registration and Session ownership with a controlled native recognizer. */
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import QianshouVoice from '../src/index.ts'
import type { VoiceConfig } from '../src/types.ts'
import { MAX_AUDIO_BYTES } from '../src/wav.ts'
import { engineFixture, wav } from './support.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function boot(config: Partial<VoiceConfig> = {}, body?: string) {
  const f = await engineFixture(body)
  cleanups.push(() => rm(f.root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(f.root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['session', SessionStore], ['credentials', MemoryCredentials],
    ['connection', Connection], ['voice', QianshouVoice]])
  for (const [name, plugin] of modules) ctx.loader.builtins[name] = plugin
  const rows = [...modules.keys()].map(name => ({ name: `cordis:${name}`, ...name === 'voice' ? {
    config: { binaryPath: f.options.binary, modelPath: f.options.model, recognitionTimeoutMs: 10000, ...config },
  } : {} }))
  await writeFile(join(f.root, 'cordis.yml'), JSON.stringify(rows))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(f.root, 'cordis.yml')).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
  const fiber = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:voice')!.fiber!
  const session = ctx.sessions.prepare(SessionId('voice-test-session'), { meta: { cwd: f.root } })
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  cleanups.push(detach)
  const handler = ctx.connection.createSharedFetchHandler('/api')
  const url = new URL('http://localhost/api/qianshou/voice/transcribe')
  url.searchParams.set('sessionId', session.id); url.searchParams.set('workspaceRoot', f.root)
  function request(init: RequestInit = {}, target = url): Request {
    return new Request(target, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(wav()), ...init })
  }
  async function started() { await vi.waitFor(async () => { await access(f.marker) }, { timeout: 5000 }); return JSON.parse(await readFile(f.marker, 'utf8')) as { pid: number; input: string } }
  return { ...f, ctx, fiber, session, detach, handler, url, request, started }
}

describe.skipIf(process.platform === 'win32')('voice through real Loader and Connection registrations', () => {
  it('binds a real Session, returns text without logging it, and removes routes on disposal', async () => {
    const b = await boot()
    expect(b.ctx.get('voiceActivity')?.active()).toBe(false)
    expect(await b.ctx.qianshouVoice.status()).toMatchObject({ available: true, reason: 'ready', busy: false, maxAudioBytes: MAX_AUDIO_BYTES })
    expect(b.handler.requestBodyMode({ method: 'POST', url: b.url })).toBe('streaming')
    expect(b.ctx.connection.requestRejection({ headers: { host: 'localhost' } })).toBe(401)
    expect(b.ctx.connection.requestRejection({ headers: { host: 'foreign.invalid' } })).toBe(403)
    const before = b.session.snapshotEvents()
    expect(await (await b.handler.fetch(b.request())).json()).toEqual({ text: '千手语音测试' })
    expect(b.ctx.get('voiceActivity')?.active()).toBe(false)
    expect(b.session.snapshotEvents()).toEqual(before)
    await b.fiber.dispose()
    expect(b.ctx.get('voiceActivity')).toBeUndefined()
    expect((await b.handler.fetch(b.request())).status).toBe(404)
  })
  it('declares unconfigured assets honestly and rejects before starting a process', async () => {
    const b = await boot({ binaryPath: '', modelPath: '' })
    expect(await b.ctx.qianshouVoice.status()).toMatchObject({ available: false, reason: 'not-configured' })
    expect(await (await b.handler.fetch(b.request())).json()).toEqual({ error: 'VOICE_UNAVAILABLE' })
    expect(b.ctx.get('voiceActivity')?.active()).toBe(false)
    await expect(access(b.marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('returns no text for confirmed all-zero PCM without starting the recognizer', async () => {
    const b = await boot()
    const audio = wav(); audio.fill(0, 44)
    expect(await (await b.handler.fetch(b.request({ body: new Uint8Array(audio) }))).json()).toEqual({ text: '' })
    await expect(access(b.marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects missing, ambiguous, stale and mismatched Session guards', async () => {
    const b = await boot()
    for (const field of ['sessionId', 'workspaceRoot']) {
      const missing = new URL(b.url); missing.searchParams.delete(field)
      expect((await b.handler.fetch(b.request({}, missing))).status).toBe(409)
      const duplicate = new URL(b.url); duplicate.searchParams.append(field, 'second')
      expect((await b.handler.fetch(b.request({}, duplicate))).status).toBe(409)
    }
    const mismatch = new URL(b.url); mismatch.searchParams.set('workspaceRoot', '/other-project')
    expect(await (await b.handler.fetch(b.request({}, mismatch))).json()).toEqual({ error: 'SESSION_MISMATCH' })
    b.detach()
    expect(await (await b.handler.fetch(b.request())).json()).toEqual({ error: 'SESSION_UNAVAILABLE' })
    await expect(access(b.marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('cancels old work on Session release even when an identical ID is immediately replaced', async () => {
    const b = await boot({}, 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);')
    const result = b.handler.fetch(b.request())
    const child = await b.started()
    expect(b.ctx.get('voiceActivity')?.active()).toBe(true)
    b.detach()
    const replacement = b.ctx.sessions.create(b.session.id, { meta: { cwd: b.root } })
    expect(replacement).not.toBe(b.session)
    expect(await (await result).json()).toEqual({ error: 'SESSION_UNAVAILABLE' })
    expect(() => process.kill(child.pid, 0)).toThrow()
    await expect(access(dirname(child.input))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await b.ctx.qianshouVoice.status()).busy).toBe(false)
    expect(b.ctx.get('voiceActivity')?.active()).toBe(false)
  })
  it.each(['request', 'dispose'] as const)('%s cancellation waits for the native child and audio cleanup', async (kind) => {
    const b = await boot({}, 'setInterval(()=>{},1000);')
    const controller = new AbortController()
    const result = b.handler.fetch(b.request({ signal: controller.signal }))
    const child = await b.started()
    expect(b.ctx.get('voiceActivity')?.active()).toBe(true)
    expect(await (await b.handler.fetch(b.request())).json()).toEqual({ error: 'VOICE_BUSY' })
    expect(b.ctx.get('voiceActivity')?.active()).toBe(true)
    if (kind === 'request') controller.abort()
    else await b.fiber.dispose()
    expect(await (await result).json()).toEqual({ error: 'REQUEST_ABORTED' })
    expect(() => process.kill(child.pid, 0)).toThrow()
    await expect(access(dirname(child.input))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(b.ctx.get('voiceActivity')?.active() ?? false).toBe(false)
  })
  it('bounds actual upload bytes without trusting a smaller declared length', async () => {
    const b = await boot()
    const response = await b.handler.fetch(b.request({ headers: { 'content-type': 'audio/wav', 'content-length': '1' }, body: new Uint8Array(MAX_AUDIO_BYTES + 1) }))
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'INVALID_AUDIO' })
    expect((await b.handler.fetch(b.request({ body: new Uint8Array([0, 1]) }))).status).toBe(400)
    expect(await (await b.handler.fetch(b.request())).json()).toEqual({ text: '千手语音测试' })
  })
  it('releases a stalled upload after deadline even when the carrier cancellation callback never resolves', async () => {
    const b = await boot({ uploadTimeoutMs: 30 })
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise(() => {}) } })
    const init: RequestInit & { duplex: 'half' } = { body: stream, duplex: 'half' }
    expect(await (await b.handler.fetch(b.request(init))).json()).toEqual({ error: 'VOICE_TIMEOUT' })
    expect(cancelled).toBe(true)
    expect(await (await b.handler.fetch(b.request())).json()).toEqual({ text: '千手语音测试' })
  })
  it('disposes a stalled upload and removes admission without starting inference', async () => {
    const b = await boot()
    const stream = new ReadableStream<Uint8Array>({ cancel() { return new Promise(() => {}) } })
    const init: RequestInit & { duplex: 'half' } = { body: stream, duplex: 'half' }
    const response = b.handler.fetch(b.request(init))
    await vi.waitFor(async () => { expect((await b.ctx.qianshouVoice.status()).busy).toBe(true) })
    expect(b.ctx.get('voiceActivity')?.active()).toBe(true)
    await b.fiber.dispose()
    expect(await (await response).json()).toEqual({ error: 'REQUEST_ABORTED' })
    expect(b.ctx.get('voiceActivity')).toBeUndefined()
    expect((await b.handler.fetch(b.request())).status).toBe(404)
    await expect(access(b.marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
