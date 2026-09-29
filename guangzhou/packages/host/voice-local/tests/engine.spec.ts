import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transcribeVoice, voiceAvailable } from '../src/engine.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function recognizer(hang = false) {
  const root = await mkdtemp(join(tmpdir(), 'voice-engine-test-'))
  roots.push(root)
  const binary = join(root, 'recognizer.cjs')
  const model = join(root, 'model')
  const marker = join(root, 'process.json')
  await writeFile(model, '')
  await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');\nconst output = process.argv[process.argv.indexOf('-of') + 1];\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,output}));\n${hang ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 100);" : "fs.writeFileSync(output + '.txt', 'recognised words');"}\n`, { mode: 0o700 })
  return { options: { binary, model, timeoutMs: 10_000 }, marker }
}

// Executable test fixtures use a shebang; native Windows launches require an .exe.
describe.skipIf(process.platform === 'win32')('local recognizer process lifetime', () => {
  it('returns the actual transcript and removes private files after process close', async () => {
    const { options, marker } = await recognizer()
    expect(await voiceAvailable(options)).toBe(true)
    expect(await transcribeVoice(Uint8Array.of(1), options, new AbortController().signal)).toBe('recognised words')
    const processInfo = JSON.parse(await readFile(marker, 'utf8')) as { output: string }
    expect(existsSync(processInfo.output + '.txt')).toBe(false)
    expect(existsSync(join(processInfo.output, '..'))).toBe(false)
  })

  it('force-stops a recognizer that ignores SIGTERM before releasing private files', async () => {
    const { options, marker } = await recognizer(true)
    const controller = new AbortController()
    const settled = transcribeVoice(Uint8Array.of(1), options, controller.signal).catch(error => error)
    await vi.waitFor(() => { expect(existsSync(marker)).toBe(true) }, { timeout: 5_000 })
    const processInfo = JSON.parse(await readFile(marker, 'utf8')) as { pid: number; output: string }
    controller.abort()
    expect(await settled).toBeInstanceOf(Error)
    expect(() => process.kill(processInfo.pid, 0)).toThrow()
    expect(existsSync(join(processInfo.output, '..'))).toBe(false)
  }, 10_000)

  it('terminates a hung recognizer at its configured timeout', async () => {
    const { options, marker } = await recognizer(true)
    await expect(transcribeVoice(Uint8Array.of(1), { ...options, timeoutMs: 2_000 }, new AbortController().signal)).rejects.toMatchObject({ killed: true })
    const processInfo = JSON.parse(await readFile(marker, 'utf8')) as { pid: number; output: string }
    expect(() => process.kill(processInfo.pid, 0)).toThrow()
    expect(existsSync(join(processInfo.output, '..'))).toBe(false)
  })
})
