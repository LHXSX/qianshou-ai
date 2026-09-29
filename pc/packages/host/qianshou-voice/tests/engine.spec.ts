import { access, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcribeVoice, voiceAvailable } from '../src/engine.ts'
import { engineFixture, wav } from './support.ts'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(body?: string) { const f = await engineFixture(body); roots.push(f.root); return f }
async function started(marker: string): Promise<{ pid: number; input: string; secret: null }> {
  await vi.waitFor(async () => { await access(marker) }, { timeout: 5000 })
  return JSON.parse(await readFile(marker, 'utf8')) as { pid: number; input: string; secret: null }
}
async function gone(marker: string) {
  const evidence = await started(marker)
  expect(() => process.kill(evidence.pid, 0)).toThrow()
  await expect(access(dirname(evidence.input))).rejects.toMatchObject({ code: 'ENOENT' })
}
describe.skipIf(process.platform === 'win32')('native recognizer lifecycle', () => {
  it('returns real process text, omits ambient secrets and removes audio before returning', async () => {
    const f = await fixture(); vi.stubEnv('QIANSHOU_VOICE_TEST_SECRET', 'test-only-must-not-be-inherited')
    expect(await voiceAvailable(f.options)).toBe(true)
    expect(await transcribeVoice(wav(), f.options, new AbortController().signal)).toBe('千手语音测试')
    expect((await started(f.marker)).secret).toBeNull()
    await gone(f.marker)
  })
  it('kills cancellation-resistant work and waits for close and directory cleanup', async () => {
    const f = await fixture('process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);')
    const controller = new AbortController()
    const result = transcribeVoice(wav(), f.options, controller.signal)
    const settled = result.then(() => undefined, (error: unknown) => error)
    try { await started(f.marker) } finally { controller.abort() }
    expect(await settled).toMatchObject({ name: 'AbortError' })
    await gone(f.marker)
  }, 10000)
  it('classifies its own deadline separately from output overflow', async () => {
    const f = await fixture('setInterval(()=>{},1000);')
    const ownedTemporaryRoot = join(f.root, 'runtime-tmp')
    await mkdir(ownedTemporaryRoot)
    vi.stubEnv('TMPDIR', ownedTemporaryRoot)
    const timed = transcribeVoice(wav(), { ...f.options, timeoutMs: 3000 }, new AbortController().signal).catch((error: unknown) => error)
    expect(await timed).toMatchObject({ code: 'VOICE_TIMEOUT' })
    // A total deadline can expire before the child executes its first JS line.
    // Cleanup is required either way; an observed child must also be gone.
    expect(await readdir(ownedTemporaryRoot)).toEqual([])
    const observedStart = await access(f.marker).then(() => true, () => false)
    if (observedStart) await gone(f.marker)
    vi.unstubAllEnvs()
    const overflow = await fixture('process.stdout.write("x".repeat(100000)); setInterval(()=>{},1000);')
    await expect(transcribeVoice(wav(), overflow.options, new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' })
    await gone(overflow.marker)
  }, 10000)
  it('bounds UTF-8 JSON including escaping, metadata and a single oversized file', async () => {
    const f = await fixture('fs.writeFileSync(output + ".txt", "千手");')
    expect(await transcribeVoice(wav(), { ...f.options, maxResultBytes: 17 }, new AbortController().signal)).toBe('千手')
    await expect(transcribeVoice(wav(), { ...f.options, maxResultBytes: 16 }, new AbortController().signal)).rejects.toMatchObject({ code: 'RESULT_TOO_LARGE' })
    const big = await fixture('fs.writeFileSync(output + ".txt", "x".repeat(2048));')
    await expect(transcribeVoice(wav(), big.options, new AbortController().signal)).rejects.toMatchObject({ code: 'RESULT_TOO_LARGE' })
    await gone(big.marker)
  })
  it('handles absent resources, spawn failure, empty recognition and pre-cancel without a child', async () => {
    const f = await fixture('fs.writeFileSync(output + ".txt", "[BLANK_AUDIO]");')
    expect(await voiceAvailable({ ...f.options, model: f.options.model + '.missing' })).toBe(false)
    expect(await voiceAvailable({ ...f.options, model: f.root })).toBe(false)
    expect(await transcribeVoice(wav(), f.options, new AbortController().signal)).toBe('')
    await expect(transcribeVoice(wav(), { ...f.options, binary: f.options.binary + '.missing' }, new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' })
    const controller = new AbortController(); controller.abort()
    await expect(transcribeVoice(wav(), f.options, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
