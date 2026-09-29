/** Neural speech settings and real worker-process lifetime with a controlled JSONL subprocess; no model or speaker. */
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveTtsOptions, type TtsOptions } from '../src/tts-config.ts'
import { TtsEngine, ttsAvailable } from '../src/tts-engine.ts'
import type { TtsConfig } from '../src/types.ts'
import { ttsFixture, type TtsWorkerMode } from './support.ts'

const defaults: TtsConfig = { ttsPythonPath: '', ttsWorkerPath: '', ttsModelPath: '', ttsDefaultSpeaker: 'Vivian', ttsMaxTextChars: 500,
  ttsRequestTimeoutMs: 180000, ttsMaxOutputBytes: 8388608, ttsIdleTimeoutMs: 300000 }
const roots: string[] = []
const engines: TtsEngine[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const engine of engines.splice(0)) await engine.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(mode: TtsWorkerMode = 'normal', overrides: Partial<TtsOptions> = {}) {
  const f = await ttsFixture(mode); roots.push(f.root)
  const engine = new TtsEngine({ ...resolveTtsOptions(defaults), assets: f.assets, ...overrides }); engines.push(engine)
  return { ...f, engine }
}
const signal = (): AbortSignal => new AbortController().signal

describe('neural speech settings', () => {
  it('disables synthesis without assets and keeps configured limits', () => {
    const options = resolveTtsOptions({ ...defaults, ttsMaxTextChars: 120, ttsDefaultSpeaker: 'Serena' })
    expect(options).toEqual({ assets: undefined, defaultSpeaker: 'Serena', maxTextChars: 120, requestTimeoutMs: 180000,
      maxOutputBytes: 8388608, idleTimeoutMs: 300000 })
  })
  it('rejects partial, relative and NUL-bearing asset paths instead of guessing', () => {
    expect(() => resolveTtsOptions({ ...defaults, ttsPythonPath: '/python' })).toThrow(/together/)
    expect(() => resolveTtsOptions({ ...defaults, ttsPythonPath: '/python', ttsWorkerPath: 'worker.py', ttsModelPath: '/model' })).toThrow(/absolute/)
    expect(() => resolveTtsOptions({ ...defaults, ttsPythonPath: '/python', ttsWorkerPath: '/w\0.py', ttsModelPath: '/model' })).toThrow(TypeError)
    expect(resolveTtsOptions({ ...defaults, ttsPythonPath: '/python', ttsWorkerPath: '/worker.py', ttsModelPath: '/model' }).assets)
      .toEqual({ python: '/python', worker: '/worker.py', model: '/model' })
  })
  it('reports not-configured and resources-missing separately and never starts a process', async () => {
    const unconfigured = new TtsEngine(resolveTtsOptions(defaults)); engines.push(unconfigured)
    expect(await unconfigured.status()).toMatchObject({ available: false, reason: 'not-configured', ready: false, busy: false, engine: 'qwen3-tts',
      speakers: ['Vivian', 'Serena'], defaultSpeaker: 'Vivian', maxTextChars: 500, maxOutputBytes: 8388608, sampleRate: 24000 })
    await expect(unconfigured.synthesize('你好', 'Vivian', signal())).rejects.toMatchObject({ code: 'TTS_UNAVAILABLE', status: 503 })
    const f = await fixture()
    expect(await ttsAvailable(f.assets)).toBe(true)
    expect(await ttsAvailable({ ...f.assets, model: f.assets.model + '.missing' })).toBe(false)
    expect(await ttsAvailable({ ...f.assets, worker: f.assets.model })).toBe(false)
    const missing = new TtsEngine({ ...f.engine.options, assets: { ...f.assets, python: f.assets.python + '.missing' } }); engines.push(missing)
    expect(await missing.status()).toMatchObject({ available: false, reason: 'resources-missing' })
    await expect(missing.synthesize('你好', 'Vivian', signal())).rejects.toMatchObject({ code: 'TTS_UNAVAILABLE', status: 503 })
    expect(await f.events()).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('neural speech real process lifetime', () => {
  it('reuses a ready worker, withholds ambient secrets, returns 24 kHz PCM and removes request files', async () => {
    vi.stubEnv('QIANSHOU_VOICE_TEST_SECRET', 'test-only-must-not-be-inherited')
    const f = await fixture()
    expect(await f.engine.status()).toMatchObject({ available: true, reason: 'ready', ready: false })
    for (const speaker of ['Vivian', 'Serena'] as const) {
      const wav = await f.engine.synthesize('你好，慢慢说。', speaker, signal())
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
      expect(wav.readUInt32LE(24)).toBe(24000)
    }
    expect(await f.engine.status()).toMatchObject({ ready: true, busy: false })
    const records = await f.events()
    expect(records.filter(item => item.event === 'start')).toHaveLength(1)
    expect(records[0]?.secret).toBeNull()
    for (const item of records.filter(item => item.output)) expect(existsSync(item.output!)).toBe(false)
    await f.engine.dispose()
    expect(existsSync(records[0]!.root)).toBe(false)
    expect(() => process.kill(records[0]!.pid, 0)).toThrow()
  })
  it('refuses a concurrent request as busy without queueing or killing the active worker', async () => {
    const f = await fixture()
    const first = f.engine.synthesize('slow', 'Vivian', signal())
    expect(f.engine.busy()).toBe(true)
    await expect(f.engine.synthesize('must-not-run', 'Serena', signal())).rejects.toMatchObject({ code: 'TTS_BUSY', status: 429 })
    expect((await first).toString('ascii', 8, 12)).toBe('WAVE')
    expect(f.engine.busy()).toBe(false)
    await f.engine.synthesize('next', 'Serena', signal())
    const records = await f.events()
    expect(records.filter(item => item.event === 'start')).toHaveLength(1)
    expect(records.filter(item => item.event === 'request').map(item => [item.text, item.overlap])).toEqual([['slow', 1], ['next', 1]])
  })
  it('kills cancelled inference before cleanup and starts a fresh worker for the next request', async () => {
    const f = await fixture()
    const controller = new AbortController()
    const pending = f.engine.synthesize('hang', 'Vivian', controller.signal).catch((error: unknown) => error)
    await vi.waitFor(async () => { expect((await f.events()).some(item => item.event === 'request')).toBe(true) }, { timeout: 5000 })
    const original = (await f.events())[0]!
    controller.abort()
    expect(await pending).toMatchObject({ code: 'REQUEST_ABORTED', status: 499 })
    expect(() => process.kill(original.pid, 0)).toThrow()
    expect(existsSync(original.root)).toBe(false)
    await f.engine.synthesize('recovered', 'Vivian', signal())
    expect((await f.events()).filter(item => item.event === 'start')).toHaveLength(2)
  }, 15000)
  it.each(['startup-hang', 'normal'] as const)('bounds cold load and inference with one request deadline: %s', async (mode) => {
    const f = await fixture(mode, { requestTimeoutMs: 2000 })
    const ownedTemporaryRoot = join(f.root, 'runtime-tmp')
    await mkdir(ownedTemporaryRoot)
    vi.stubEnv('TMPDIR', ownedTemporaryRoot)
    const pending = f.engine.synthesize('hang', 'Vivian', signal()).catch((error: unknown) => error)
    expect(await pending).toMatchObject({ code: 'TTS_TIMEOUT', status: 504 })
    expect(await readdir(ownedTemporaryRoot)).toEqual([])
    const original = (await f.events()).find(item => item.event === 'start')
    // The deadline includes cold startup. If it expires before the first worker
    // event, owned-directory cleanup still proves the request is quiescent.
    if (original) {
      expect(() => process.kill(original.pid, 0)).toThrow()
      expect(existsSync(original.root)).toBe(false)
    }
  }, 10000)
  it.each(['malformed', 'error', 'exit', 'noise', 'escape', 'oversize', 'invalid-wav', 'symlink'] as const)('rejects unsafe or malformed worker output without diagnostics: %s', async (mode) => {
    const f = await fixture(mode, { maxOutputBytes: 10000 })
    await expect(f.engine.synthesize('hello', 'Vivian', signal())).rejects.toMatchObject({ code: 'SYNTHESIS_FAILED', status: 500, message: 'SYNTHESIS_FAILED' })
    expect(existsSync((await f.events())[0]!.root)).toBe(false)
  })
  it('disposes active work and releases the owned process group', async () => {
    const f = await fixture()
    const first = f.engine.synthesize('hang', 'Vivian', signal()).catch((error: unknown) => error)
    await vi.waitFor(async () => { expect((await f.events()).some(item => item.event === 'request')).toBe(true) }, { timeout: 5000 })
    await f.engine.dispose()
    expect(await first).toMatchObject({ code: 'REQUEST_ABORTED' })
    const original = (await f.events())[0]!
    expect(() => process.kill(original.pid, 0)).toThrow()
    expect(existsSync(original.root)).toBe(false)
    await expect(f.engine.synthesize('after-dispose', 'Vivian', signal())).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
  }, 15000)
  it('releases an idle worker and loads it again on demand', async () => {
    const f = await fixture('normal', { idleTimeoutMs: 30 })
    await f.engine.synthesize('hello', 'Vivian', signal())
    const original = (await f.events())[0]!
    await vi.waitFor(() => { expect(existsSync(original.root)).toBe(false) })
    expect(await f.engine.status()).toMatchObject({ available: true, ready: false })
    await f.engine.synthesize('again', 'Serena', signal())
    expect((await f.events()).filter(item => item.event === 'start')).toHaveLength(2)
  })
})
